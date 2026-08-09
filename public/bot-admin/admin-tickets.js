const STATUS_LABELS = {
  Open: 'Открыт',
  Closed: 'Закрыт',
  WaitingClient: 'Ожидание клиента',
  WaitingStaff: 'Ожидание сотрудника',
};

const DIRECTION_LABELS = {
  Inbound: 'Входящий',
  Outbound: 'Исходящий',
};

const FILTERS_STORAGE_KEY = 'bot-admin.tickets.filters';
const ALLOWED_STATUS_FILTERS = new Set(['', 'Open', 'Closed', 'WaitingClient', 'WaitingStaff']);

let tickets = [];
let userNames = {};
let channelNames = {};
let searchQuery = '';
let statusFilter = '';
let userFilter = '';
let channelFilter = '';
let dateFrom = '';
let dateTo = '';
let withoutDuplicates = false;
let duplicateIntervalMinutes = 10;
let currentPage = 1;
let pageLimit = 25;
let totalTickets = 0;
let summary = { count: 0, slaBreached: 0, rated: 0 };
let sessionRegosUserId = null;
let activeTicket = null;
let activeTicketUserId = null;
let ticketEvents = null;
let ticketEventsReconnectTimer = null;
let ticketEventsReconnectAttempt = 0;
let ticketEventsPaused = false;
let ticketEventsReady = false;
let realtimeTicketsRefreshTimer = null;
let realtimeTicketsRefreshInFlight = false;
let realtimeTicketsRefreshPending = false;
let durationLoadGeneration = 0;
const recordingDurationCache = new Map();
let recordingModalTrigger = null;

const searchInput = document.getElementById('ticket-search');
const searchClearBtn = document.getElementById('search-clear');
const searchBox = document.getElementById('search-box');
const statusSelect = document.getElementById('status-filter');
const userSelect = document.getElementById('user-filter');
const channelSelect = document.getElementById('channel-filter');
const dateFromInput = document.getElementById('date-from');
const dateToInput = document.getElementById('date-to');
const withoutDuplicatesInput = document.getElementById('without-duplicates');
const duplicateIntervalWrap = document.getElementById('duplicate-interval-wrap');
const duplicateIntervalSelect = document.getElementById('duplicate-interval');
const ticketsWrap = document.getElementById('tickets-wrap');
const ticketsPaginationEl = document.getElementById('tickets-pagination');
const ticketsSummaryEl = document.getElementById('tickets-summary');
const activeTicketEl = document.getElementById('active-ticket');
const ticketsErrorEl = document.getElementById('tickets-error');
const filtersForm = document.getElementById('ticket-filters');
const recordingModal = document.getElementById('ticket-recording-modal');
const recordingModalClose = document.getElementById('ticket-recording-close');
const recordingModalTicket = document.getElementById('ticket-recording-ticket');
const recordingPlayer = document.getElementById('ticket-recording-player');

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

function directionLabel(direction) {
  return DIRECTION_LABELS[direction] || direction || '—';
}

function getRecordingUrl(ticket) {
  const fields = Array.isArray(ticket?.fields) ? ticket.fields : [];
  const recordingField = fields.find((field) => {
    const key = String(field?.key || '').trim().toLowerCase();
    const name = String(field?.name || '').trim().toLowerCase();
    return key === 'field_recording_link' || name === 'ссылка на запись';
  });
  const value = String(recordingField?.value || '').trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

function formatCallDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds)));
  if (!Number.isFinite(seconds)) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(remainder)}`
    : `${minutes}:${pad2(remainder)}`;
}

function setDurationCell(index, duration) {
  const cell = ticketsWrap.querySelector(`[data-call-duration-index="${index}"]`);
  if (cell) cell.textContent = formatCallDuration(duration);
}

function loadVisibleCallDurations() {
  const generation = ++durationLoadGeneration;
  tickets.forEach((ticket, index) => {
    const url = getRecordingUrl(ticket);
    if (!url) return;

    if (recordingDurationCache.has(url)) {
      setDurationCell(index, recordingDurationCache.get(url));
      return;
    }

    const audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (!Number.isFinite(audio.duration)) return;
        recordingDurationCache.set(url, audio.duration);
        if (generation === durationLoadGeneration) setDurationCell(index, audio.duration);
        audio.removeAttribute('src');
        audio.load();
      },
      { once: true }
    );
    audio.src = url;
  });
}

function openRecordingModal(ticket, trigger) {
  const url = getRecordingUrl(ticket);
  if (!url) return;
  recordingModalTrigger = trigger || null;
  recordingModalTicket.textContent = `Тикет #${ticket.id} — ${ticket.subject || 'Без темы'}`;
  recordingPlayer.src = url;
  recordingModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  recordingModalClose.focus();
}

function closeRecordingModal() {
  if (recordingModal.hidden) return;
  recordingPlayer.pause();
  recordingPlayer.removeAttribute('src');
  recordingPlayer.load();
  recordingModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  recordingModalTrigger?.focus();
  recordingModalTrigger = null;
}

function formatUnix(seconds) {
  if (seconds == null || seconds === 0) return '—';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function userLabel(userId) {
  if (userId == null) return '—';
  return userNames[userId] || `Пользователь #${userId}`;
}

function channelLabel(channelId) {
  if (channelId == null || channelId === '') return '—';
  return channelNames[channelId] || `Канал #${channelId}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDatetimeLocalValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Today 00:00 – 23:59 in local time for datetime-local inputs. */
function getTodayPeriodDefaults() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
  return {
    from: toDatetimeLocalValue(from),
    to: toDatetimeLocalValue(to),
  };
}

function applyDefaultPeriod() {
  const { from, to } = getTodayPeriodDefaults();
  dateFromInput.value = from;
  dateToInput.value = to;
  dateFrom = from;
  dateTo = to;
}

function datetimeLocalToUnix(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

function syncDuplicateIntervalVisibility() {
  duplicateIntervalWrap.hidden = !withoutDuplicatesInput.checked;
}

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      status: typeof parsed.status === 'string' ? parsed.status : '',
      responsibleUserId:
        parsed.responsibleUserId != null && parsed.responsibleUserId !== ''
          ? String(parsed.responsibleUserId)
          : '',
      channelId:
        parsed.channelId != null && parsed.channelId !== '' ? String(parsed.channelId) : '',
      withoutDuplicates: Boolean(parsed.withoutDuplicates),
    };
  } catch {
    return null;
  }
}

function saveFiltersToStorage() {
  try {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({
        status: statusFilter,
        responsibleUserId: userFilter,
        channelId: channelFilter,
        withoutDuplicates,
      })
    );
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function applySavedFiltersToForm(saved) {
  if (!saved) return;

  if (ALLOWED_STATUS_FILTERS.has(saved.status)) {
    statusSelect.value = saved.status;
    statusFilter = saved.status;
  }

  userFilter = saved.responsibleUserId;
  channelFilter = saved.channelId;

  withoutDuplicatesInput.checked = saved.withoutDuplicates;
  withoutDuplicates = saved.withoutDuplicates;
  syncDuplicateIntervalVisibility();
}

function persistSelectableFilters() {
  statusFilter = statusSelect.value;
  userFilter = userSelect.value;
  channelFilter = channelSelect.value;
  withoutDuplicates = withoutDuplicatesInput.checked;
  saveFiltersToStorage();
}

function readFiltersFromForm() {
  searchQuery = searchInput.value.trim();
  statusFilter = statusSelect.value;
  userFilter = userSelect.value;
  channelFilter = channelSelect.value;
  dateFrom = dateFromInput.value;
  dateTo = dateToInput.value;
  withoutDuplicates = withoutDuplicatesInput.checked;
  duplicateIntervalMinutes = Number(duplicateIntervalSelect.value) || 10;
  saveFiltersToStorage();
}

function showError(message) {
  if (!message) {
    ticketsErrorEl.hidden = true;
    ticketsErrorEl.textContent = '';
    return;
  }
  ticketsErrorEl.hidden = false;
  ticketsErrorEl.textContent = message;
}

function renderSummary() {
  if (!summary || summary.count == null) {
    ticketsSummaryEl.hidden = true;
    return;
  }
  ticketsSummaryEl.hidden = false;
  ticketsSummaryEl.innerHTML = `
    <span><strong>${escapeHtml(summary.count)}</strong> тикетов</span>
    <span>SLA нарушен: <strong>${escapeHtml(summary.slaBreached)}</strong></span>
    <span>С оценкой: <strong>${escapeHtml(summary.rated)}</strong></span>
  `;
}

function effectiveActiveTicketUserId() {
  if (userFilter) return Number(userFilter);
  if (sessionRegosUserId != null) return Number(sessionRegosUserId);
  return null;
}

function openTicketPage(ticketId) {
  if (ticketId == null) return;
  window.location.href = `/bot-admin/tickets/${ticketId}`;
}

function renderActiveTicket() {
  const scopeUserId = activeTicketUserId ?? effectiveActiveTicketUserId();
  if (scopeUserId == null) {
    activeTicketEl.hidden = true;
    activeTicketEl.innerHTML = '';
    return;
  }

  activeTicketEl.hidden = false;
  if (!activeTicket) {
    activeTicketEl.innerHTML = `
      <span class="active-ticket__label">Текущий активный тикет:</span>
      <span class="active-ticket__empty">Нет активного тикета</span>
    `;
    return;
  }

  const clientParts = [activeTicket.client?.name, activeTicket.client?.phone].filter(Boolean);
  const clientText = clientParts.length ? clientParts.join(' · ') : '—';
  const created = formatUnix(activeTicket.created_date);
  const title = `#${activeTicket.id} — ${activeTicket.subject || 'Без темы'}`;

  activeTicketEl.innerHTML = `
    <button type="button" class="active-ticket__open" id="active-ticket-open" title="Открыть карточку тикета">
      <span class="active-ticket__label">Текущий активный тикет:</span>
      <span class="active-ticket__title">${escapeHtml(title)}</span>
      <span class="active-ticket__meta">${escapeHtml(clientText)} · ${escapeHtml(created)}</span>
    </button>
  `;

  const openBtn = document.getElementById('active-ticket-open');
  if (openBtn) {
    openBtn.addEventListener('click', () => openTicketPage(activeTicket.id));
  }
}

function statusBadgeClass(status) {
  switch (status) {
    case 'Open':
      return 'ticket-status ticket-status--open';
    case 'Closed':
      return 'ticket-status ticket-status--closed';
    case 'WaitingClient':
      return 'ticket-status ticket-status--waiting-client';
    case 'WaitingStaff':
      return 'ticket-status ticket-status--waiting-staff';
    default:
      return 'ticket-status';
  }
}

function renderTicketsTable() {
  if (!tickets.length) {
    const emptyMessage = searchQuery || statusFilter || userFilter || channelFilter || dateFrom || dateTo
      ? 'Ничего не найдено. Измените фильтры.'
      : 'Тикетов пока нет.';
    ticketsWrap.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  ticketsWrap.innerHTML = `
    <div class="table-scroll">
    <table class="data-table tickets-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Тема</th>
          <th>Клиент</th>
          <th>Телефон</th>
          <th>Канал</th>
          <th>Статус</th>
          <th>Направление</th>
          <th>Ответственный</th>
          <th>Создан</th>
          <th>Ссылка на запись</th>
          <th>Длительность звонка</th>
          <th>SLA нарушен</th>
          <th>Оценка</th>
        </tr>
      </thead>
      <tbody>
        ${tickets
          .map(
            (ticket, index) => `
          <tr class="tickets-table__row" data-ticket-id="${escapeHtml(ticket.id)}" tabindex="0">
            <td class="cell-mono" data-label="ID">${escapeHtml(ticket.id)}</td>
            <td data-label="Тема">${escapeHtml(ticket.subject || '—')}</td>
            <td data-label="Клиент">${escapeHtml(ticket.client?.name || '—')}</td>
            <td class="cell-phone" data-label="Телефон">${escapeHtml(ticket.client?.phone || '—')}</td>
            <td data-label="Канал">${escapeHtml(channelLabel(ticket.channel_id))}</td>
            <td data-label="Статус">
              <span class="${statusBadgeClass(ticket.status)}">${escapeHtml(statusLabel(ticket.status))}</span>
            </td>
            <td data-label="Направление">${escapeHtml(directionLabel(ticket.direction))}</td>
            <td data-label="Ответственный">${escapeHtml(userLabel(ticket.responsible_user_id))}</td>
            <td class="cell-nowrap" data-label="Создан">${escapeHtml(formatUnix(ticket.created_date))}</td>
            <td data-label="Ссылка на запись">${
              getRecordingUrl(ticket)
                ? `<button type="button" class="ticket-recording-open" data-recording-index="${index}" aria-label="Воспроизвести запись тикета №${escapeHtml(ticket.id)}">Воспроизвести</button>`
                : '—'
            }</td>
            <td class="cell-mono cell-nowrap" data-label="Длительность звонка" data-call-duration-index="${index}">—</td>
            <td data-label="SLA нарушен">${
              ticket.sla_breached
                ? '<span class="badge badge--warn">Да</span>'
                : '<span class="badge badge--muted">Нет</span>'
            }</td>
            <td class="cell-num" data-label="Оценка">${escapeHtml(ticket.rating != null ? ticket.rating : '—')}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;

  ticketsWrap.querySelectorAll('.tickets-table__row').forEach((row) => {
    const open = (event) => {
      if (event?.target.closest('button, a, input, select, textarea')) return;
      const id = Number(row.getAttribute('data-ticket-id'));
      openTicketPage(id);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.target.closest('button, a, input, select, textarea')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(event);
      }
    });
  });

  ticketsWrap.querySelectorAll('.ticket-recording-open').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const index = Number(button.getAttribute('data-recording-index'));
      const ticket = tickets[index];
      if (ticket) openRecordingModal(ticket, button);
    });
  });

  loadVisibleCallDurations();
}

function renderTicketsPagination() {
  renderPagination(
    ticketsPaginationEl,
    { page: currentPage, limit: pageLimit, total: totalTickets },
    {
      onPageChange: (page) => {
        currentPage = page;
        loadTickets().catch((error) => showError(error.message));
      },
      onLimitChange: (limit) => {
        pageLimit = limit;
        currentPage = 1;
        loadTickets().catch((error) => showError(error.message));
      },
    }
  );
}

async function loadUsers({ preferredUserId = undefined } = {}) {
  const data = await api('/bot-admin/api/tickets/users');
  const users = data.users || [];
  userNames = {};
  for (const user of users) {
    userNames[user.id] = user.full_name || user.login || `Пользователь #${user.id}`;
  }

  const previous = userSelect.value || userFilter;
  userSelect.innerHTML =
    '<option value="">Все</option>' +
    users
      .map(
        (user) =>
          `<option value="${escapeHtml(user.id)}">${escapeHtml(
            user.full_name || user.login || `Пользователь #${user.id}`
          )}</option>`
      )
      .join('');

  let next = previous;
  if (next && !userNames[next]) {
    next = '';
  }
  if (!next && preferredUserId !== undefined) {
    const id = preferredUserId == null ? '' : String(preferredUserId);
    next = id && userNames[id] ? id : '';
  }

  userSelect.value = next;
  userFilter = next;
}

async function loadChannels({ preferredChannelId = undefined } = {}) {
  try {
    const data = await api('/bot-admin/api/tickets/channels');
    const channels = data.channels || [];
    channelNames = {};
    for (const channel of channels) {
      channelNames[channel.id] = channel.name || `Канал #${channel.id}`;
    }

    const previous = channelSelect.value || channelFilter;
    channelSelect.innerHTML =
      '<option value="">Все каналы</option>' +
      channels
        .map(
          (channel) =>
            `<option value="${escapeHtml(channel.id)}">${escapeHtml(
              channel.name || `Канал #${channel.id}`
            )}</option>`
        )
        .join('');

    let next = previous;
    if (!next && preferredChannelId !== undefined) {
      const id = preferredChannelId == null ? '' : String(preferredChannelId);
      next = id && channelNames[id] ? id : '';
    } else if (next && !channelNames[next]) {
      next = '';
    }

    channelSelect.value = next;
    channelFilter = next;
  } catch {
    channelNames = {};
  }
}

async function loadTickets() {
  showError('');
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: String(pageLimit),
  });
  if (searchQuery) params.set('q', searchQuery);
  if (statusFilter) params.set('status', statusFilter);
  if (userFilter) params.set('responsible_user_id', userFilter);
  if (channelFilter) params.set('channel_id', channelFilter);

  const fromUnix = datetimeLocalToUnix(dateFrom);
  const toUnix = datetimeLocalToUnix(dateTo);
  if (fromUnix != null) params.set('from_date', String(fromUnix));
  if (toUnix != null) params.set('to_date', String(toUnix));

  if (withoutDuplicates) {
    params.set('without_duplicates', '1');
    params.set('duplicate_interval_minutes', String(duplicateIntervalMinutes));
  }

  const data = await api(`/bot-admin/api/tickets?${params.toString()}`);
  tickets = data.tickets || [];
  totalTickets = data.total ?? tickets.length;
  currentPage = data.page ?? currentPage;
  pageLimit = data.limit ?? pageLimit;
  summary = data.summary || { count: totalTickets, slaBreached: 0, rated: 0 };
  activeTicket = data.active_ticket || null;
  activeTicketUserId =
    data.active_ticket_user_id != null ? Number(data.active_ticket_user_id) : null;

  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderSummary();
  renderActiveTicket();
  renderTicketsTable();
  renderTicketsPagination();
}

async function runRealtimeTicketsRefresh() {
  if (realtimeTicketsRefreshInFlight || !realtimeTicketsRefreshPending) return;
  realtimeTicketsRefreshPending = false;
  realtimeTicketsRefreshInFlight = true;
  try {
    await loadTickets();
  } catch (error) {
    console.warn('Не удалось обновить тикеты в реальном времени:', error.message);
  } finally {
    realtimeTicketsRefreshInFlight = false;
    if (realtimeTicketsRefreshPending) {
      scheduleRealtimeTicketsRefresh();
    }
  }
}

function scheduleRealtimeTicketsRefresh() {
  realtimeTicketsRefreshPending = true;
  clearTimeout(realtimeTicketsRefreshTimer);
  realtimeTicketsRefreshTimer = setTimeout(runRealtimeTicketsRefresh, 150);
}

function handleTicketEvent(event) {
  if (event?.type !== 'ticket_changed') return;
  scheduleRealtimeTicketsRefresh();
}

function scheduleTicketEventsReconnect() {
  if (ticketEventsPaused || ticketEventsReconnectTimer) return;
  const delay = Math.min(1000 * 2 ** ticketEventsReconnectAttempt, 30_000);
  ticketEventsReconnectAttempt += 1;
  ticketEventsReconnectTimer = setTimeout(() => {
    ticketEventsReconnectTimer = null;
    connectTicketEvents();
  }, delay);
}

function disconnectTicketEvents() {
  if (ticketEvents) {
    ticketEvents.close();
    ticketEvents = null;
  }
  clearTimeout(ticketEventsReconnectTimer);
  ticketEventsReconnectTimer = null;
}

function connectTicketEvents() {
  if (
    !ticketEventsReady ||
    ticketEventsPaused ||
    ticketEvents ||
    document.visibilityState !== 'visible'
  ) return;
  const source = new EventSource('/bot-admin/api/tickets/events');
  ticketEvents = source;
  source.onopen = () => {
    ticketEventsReconnectAttempt = 0;
  };
  source.onmessage = (message) => {
    try {
      handleTicketEvent(JSON.parse(message.data));
    } catch {
      // Ignore malformed or non-JSON frames.
    }
  };
  source.onerror = () => {
    if (ticketEvents === source) {
      source.close();
      ticketEvents = null;
    }
    scheduleTicketEventsReconnect();
  };
}

async function init() {
  const session = await ensureSession({ requiredPermission: 'tickets_read' });
  applyDefaultPeriod();
  const savedFilters = loadSavedFilters();
  applySavedFiltersToForm(savedFilters);
  syncDuplicateIntervalVisibility();
  sessionRegosUserId = session?.actor?.regosUserId ?? null;
  const preferredUserId = savedFilters
    ? savedFilters.responsibleUserId
    : sessionRegosUserId != null
      ? String(sessionRegosUserId)
      : undefined;
  try {
    await Promise.all([
      loadUsers({ preferredUserId }),
      loadChannels({
        preferredChannelId: savedFilters ? savedFilters.channelId : undefined,
      }),
    ]);
  } catch (error) {
    showError(error.message);
  }
  readFiltersFromForm();
  await loadTickets();
  ticketEventsReady = true;
  connectTicketEvents();
}

filtersForm.addEventListener('submit', (event) => {
  event.preventDefault();
  readFiltersFromForm();
  currentPage = 1;
  loadTickets().catch((error) => showError(error.message));
});

document.getElementById('refresh-tickets-btn').addEventListener('click', () => {
  readFiltersFromForm();
  loadTickets().catch((error) => showError(error.message));
});

statusSelect.addEventListener('change', persistSelectableFilters);
userSelect.addEventListener('change', persistSelectableFilters);
channelSelect.addEventListener('change', persistSelectableFilters);
withoutDuplicatesInput.addEventListener('change', () => {
  syncDuplicateIntervalVisibility();
  persistSelectableFilters();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    connectTicketEvents();
  }
});

window.addEventListener('pagehide', () => {
  ticketEventsPaused = true;
  disconnectTicketEvents();
  clearTimeout(realtimeTicketsRefreshTimer);
  realtimeTicketsRefreshPending = false;
});

window.addEventListener('pageshow', () => {
  ticketEventsPaused = false;
  connectTicketEvents();
});

bindSearchBox({
  input: searchInput,
  clearBtn: searchClearBtn,
  box: searchBox,
  onSearch: (query) => {
    searchQuery = query;
    currentPage = 1;
    loadTickets().catch((error) => showError(error.message));
  },
});

recordingModalClose.addEventListener('click', closeRecordingModal);
recordingModal.addEventListener('click', (event) => {
  if (event.target === recordingModal) closeRecordingModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !recordingModal.hidden) closeRecordingModal();
});

setupLogout();
init().catch((error) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
