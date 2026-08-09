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

const FIRM_TYPE_LABELS = {
  partner: 'Partner',
  vcr1_partner: 'VCR1',
  vcr1_license: 'VCR1 лицензия',
  license: 'Лицензия',
  rpos_client: 'RPOS клиент',
  rpos_account: 'RPOS аккаунт',
};

const FILTERS_STORAGE_KEY = 'bot-admin.tickets.filters';
const ALLOWED_STATUS_FILTERS = new Set(['', 'Open', 'Closed', 'WaitingClient', 'WaitingStaff']);

let tickets = [];
let userNames = {};
let channelNames = {};
let ticketUsers = [];
let ticketChannels = [];
let selectedTicketClient = null;
let createTicketBusy = false;
let canEditClients = false;
let canLinkClientFirms = false;
let editingClientId = null;
let linkedClientFirms = [];
let clientEditBusy = false;
let clientEditTrigger = null;
let searchQuery = '';
let statusFilter = '';
let userFilter = '';
let channelFilter = '';
let dateFrom = '';
let dateTo = '';
let withoutDuplicates = false;
let duplicateIntervalMinutes = 10;
let minimumCallDuration = '';
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
let summaryCalculationGeneration = 0;
let summaryCalculating = false;
const recordingDurationCache = new Map();
const recordingDurationPromises = new Map();
let recordingModalTrigger = null;

const searchInput = document.getElementById('ticket-search');
const searchClearBtn = document.getElementById('search-clear');
const searchBox = document.getElementById('search-box');
const statusSelect = document.getElementById('status-filter');
const userSelect = document.getElementById('user-filter');
const channelSelect = document.getElementById('channel-filter');
const dateFromInput = document.getElementById('date-from');
const dateToInput = document.getElementById('date-to');
const minimumCallDurationInput = document.getElementById('minimum-call-duration');
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
const createTicketToggle = document.getElementById('create-ticket-toggle');
const createTicketModal = document.getElementById('create-ticket-modal');
const createTicketForm = document.getElementById('create-ticket-form');
const createTicketClose = document.getElementById('create-ticket-close');
const createTicketCancel = document.getElementById('create-ticket-cancel');
const createTicketSubmit = document.getElementById('create-ticket-submit');
const createTicketError = document.getElementById('create-ticket-error');
const ticketClientSearch = document.getElementById('ticket-client-search');
const ticketClientSearchBtn = document.getElementById('ticket-client-search-btn');
const ticketClientSearchStatus = document.getElementById('ticket-client-search-status');
const ticketClientSearchResults = document.getElementById('ticket-client-search-results');
const ticketClientSelected = document.getElementById('ticket-client-selected');
const ticketCreateChannel = document.getElementById('ticket-create-channel');
const ticketCreateResponsible = document.getElementById('ticket-create-responsible');
const ticketCreateDirection = document.getElementById('ticket-create-direction');
const ticketCreateSubject = document.getElementById('ticket-create-subject');
const ticketCreateDescription = document.getElementById('ticket-create-description');
const clientEditModal = document.getElementById('client-edit-modal');
const clientEditForm = document.getElementById('client-edit-form');
const clientEditClose = document.getElementById('client-edit-close');
const clientEditCancel = document.getElementById('client-edit-cancel');
const clientEditSubmit = document.getElementById('client-edit-submit');
const clientEditError = document.getElementById('client-edit-error');
const clientEditLoading = document.getElementById('client-edit-loading');
const clientEditProfile = document.getElementById('client-edit-profile');
const clientEditFirms = document.getElementById('client-edit-firms');
const clientEditName = document.getElementById('client-edit-name');
const clientEditPhone = document.getElementById('client-edit-phone');
const clientEditEmail = document.getElementById('client-edit-email');
const clientEditExternalId = document.getElementById('client-edit-external-id');
const clientEditDescription = document.getElementById('client-edit-description');
const clientLinkedFirms = document.getElementById('client-linked-firms');
const clientLinkedFirmsEmpty = document.getElementById('client-linked-firms-empty');
const clientFirmSearch = document.getElementById('client-firm-search');
const clientFirmSearchBtn = document.getElementById('client-firm-search-btn');
const clientFirmSearchStatus = document.getElementById('client-firm-search-status');
const clientFirmSearchResults = document.getElementById('client-firm-search-results');
const firmDetailModal = document.getElementById('firm-detail-modal');
const firmDetailClose = document.getElementById('firm-detail-close');
const firmDetailCancel = document.getElementById('firm-detail-cancel');
const firmDetailError = document.getElementById('firm-detail-error');
const firmDetailLoading = document.getElementById('firm-detail-loading');
const firmDetailMessage = document.getElementById('firm-detail-message');
const firmDetailTitle = document.getElementById('firm-detail-title');
let firmDetailTrigger = null;

function showCreateTicketError(message) {
  createTicketError.hidden = !message;
  createTicketError.textContent = message || '';
}

function setCreateTicketBusy(busy) {
  createTicketBusy = Boolean(busy);
  createTicketForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
    control.disabled = createTicketBusy;
  });
  createTicketSubmit.textContent = createTicketBusy ? 'Создание…' : 'Создать';
}

function renderSelectedTicketClient() {
  if (!selectedTicketClient) {
    ticketClientSelected.hidden = true;
    ticketClientSelected.innerHTML = '';
    return;
  }
  const meta = [selectedTicketClient.phone, selectedTicketClient.email].filter(Boolean).join(' · ');
  ticketClientSelected.hidden = false;
  ticketClientSelected.innerHTML = `
    <div class="firm-selected__body">
      <strong>${escapeHtml(selectedTicketClient.name || `Клиент #${selectedTicketClient.id}`)}</strong>
      <span>${escapeHtml(meta || `ID ${selectedTicketClient.id}`)}</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" id="ticket-client-clear">Изменить</button>
  `;
  document.getElementById('ticket-client-clear').addEventListener('click', () => {
    selectedTicketClient = null;
    renderSelectedTicketClient();
    ticketClientSearch.focus();
  });
}

async function searchTicketClients() {
  const query = ticketClientSearch.value.trim();
  if (query.length < 2) {
    ticketClientSearchStatus.hidden = false;
    ticketClientSearchStatus.textContent = 'Введите минимум 2 символа.';
    ticketClientSearchResults.hidden = true;
    return;
  }
  ticketClientSearchStatus.hidden = false;
  ticketClientSearchStatus.textContent = 'Поиск…';
  const data = await api(`/bot-admin/api/tickets/clients?q=${encodeURIComponent(query)}`);
  const clients = data.clients || [];
  ticketClientSearchStatus.textContent = clients.length ? '' : 'Клиенты не найдены.';
  ticketClientSearchStatus.hidden = clients.length > 0;
  ticketClientSearchResults.hidden = clients.length === 0;
  ticketClientSearchResults.innerHTML = clients
    .map((client, index) => {
      const meta = [client.phone, client.email, client.external_id].filter(Boolean).join(' · ');
      return `<button type="button" class="firm-search-result" data-client-index="${index}">
        <strong>${escapeHtml(client.name || `Клиент #${client.id}`)}</strong>
        <span class="firm-search-result__meta">${escapeHtml(meta || `ID ${client.id}`)}</span>
      </button>`;
    })
    .join('');
  ticketClientSearchResults.querySelectorAll('[data-client-index]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedTicketClient = clients[Number(button.dataset.clientIndex)];
      ticketClientSearchResults.hidden = true;
      ticketClientSearchStatus.hidden = true;
      renderSelectedTicketClient();
    });
  });
}

function openCreateTicketModal() {
  showCreateTicketError('');
  createTicketModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  ticketClientSearch.focus();
}

function closeCreateTicketModal() {
  if (createTicketBusy) return;
  createTicketModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  createTicketToggle.focus();
}

function firmTypeLabel(type) {
  return FIRM_TYPE_LABELS[type] || type || '—';
}

function showClientEditError(message) {
  clientEditError.hidden = !message;
  clientEditError.textContent = message || '';
}

function setClientEditBusy(busy) {
  clientEditBusy = Boolean(busy);
  clientEditForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
    if (control === clientEditClose || control === clientEditCancel) return;
    control.disabled = clientEditBusy;
  });
  clientEditSubmit.textContent = clientEditBusy ? 'Сохранение…' : 'Сохранить';
}

function resetClientFirmSearch() {
  clientFirmSearch.value = '';
  clientFirmSearchStatus.hidden = true;
  clientFirmSearchStatus.textContent = '';
  clientFirmSearchResults.hidden = true;
  clientFirmSearchResults.innerHTML = '';
}

function renderLinkedClientFirms() {
  if (!linkedClientFirms.length) {
    clientLinkedFirms.innerHTML = '';
    clientLinkedFirmsEmpty.hidden = false;
    return;
  }
  clientLinkedFirmsEmpty.hidden = true;
  clientLinkedFirms.innerHTML = linkedClientFirms
    .map((firm) => {
      const meta = [firmTypeLabel(firm.firm_type), firm.firm_phone].filter(Boolean).join(' · ');
      return `<div class="client-linked-firm" data-link-id="${escapeHtml(firm.id)}">
        <div class="client-linked-firm__body">
          <strong>${escapeHtml(firm.firm_name || `Запись #${firm.firm_record_id}`)}</strong>
          <span class="client-linked-firm__meta">${escapeHtml(meta)}</span>
          ${
            firm.firm_message
              ? `<span class="client-linked-firm__meta">${escapeHtml(firm.firm_message)}</span>`
              : ''
          }
        </div>
        <button type="button" class="btn btn-secondary btn-sm client-firm-unlink" data-link-id="${escapeHtml(
          firm.id
        )}">Отвязать</button>
      </div>`;
    })
    .join('');

  clientLinkedFirms.querySelectorAll('.client-firm-unlink').forEach((button) => {
    button.addEventListener('click', () => {
      unlinkClientFirm(Number(button.dataset.linkId)).catch((error) => {
        showClientEditError(error.message);
      });
    });
  });
}

function fillClientEditForm(client) {
  clientEditName.value = client?.name || '';
  clientEditPhone.value = client?.phone || '';
  clientEditEmail.value = client?.email || '';
  clientEditExternalId.value = client?.external_id || '';
  clientEditDescription.value = client?.description || '';
}

function applyClientToTickets(client) {
  if (!client?.id) return;
  let changed = false;
  tickets = tickets.map((ticket) => {
    const ticketClientId = Number(ticket.client_id ?? ticket.client?.id);
    if (ticketClientId !== Number(client.id)) return ticket;
    changed = true;
    return {
      ...ticket,
      client_id: client.id,
      client: {
        ...(ticket.client || {}),
        id: client.id,
        name: client.name,
        phone: client.phone,
        email: client.email,
      },
    };
  });
  if (changed) {
    renderTicketsTable();
    renderActiveTicket();
  }
}

async function openClientEditModal(clientId, trigger) {
  if (!canEditClients && !canLinkClientFirms) return;
  editingClientId = Number(clientId);
  if (!Number.isInteger(editingClientId) || editingClientId <= 0) return;

  clientEditTrigger = trigger || null;
  showClientEditError('');
  resetClientFirmSearch();
  linkedClientFirms = [];
  fillClientEditForm(null);
  clientEditProfile.hidden = !canEditClients;
  clientEditFirms.hidden = !canLinkClientFirms;
  clientEditSubmit.hidden = !canEditClients;
  clientEditLoading.hidden = false;
  clientEditModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');

  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(editingClientId)}`);
    fillClientEditForm(data.client);
    linkedClientFirms = data.firms || [];
    renderLinkedClientFirms();
    clientEditLoading.hidden = true;
    if (canEditClients) clientEditName.focus();
    else if (canLinkClientFirms) clientFirmSearch.focus();
  } catch (error) {
    clientEditLoading.hidden = true;
    showClientEditError(error.message);
  }
}

function closeClientEditModal() {
  if (clientEditBusy) return;
  clientEditModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  editingClientId = null;
  linkedClientFirms = [];
  resetClientFirmSearch();
  showClientEditError('');
  if (clientEditTrigger?.focus) clientEditTrigger.focus();
  clientEditTrigger = null;
}

async function searchClientFirms() {
  const query = clientFirmSearch.value.trim();
  if (!query) {
    clientFirmSearchStatus.hidden = false;
    clientFirmSearchStatus.textContent = 'Введите запрос для поиска.';
    clientFirmSearchResults.hidden = true;
    return;
  }
  clientFirmSearchStatus.hidden = false;
  clientFirmSearchStatus.textContent = 'Поиск…';
  const data = await api(`/bot-admin/api/firm-search?q=${encodeURIComponent(query)}`);
  const results = data.results || [];
  clientFirmSearchStatus.textContent = results.length ? '' : 'Фирмы не найдены.';
  clientFirmSearchStatus.hidden = results.length > 0;
  clientFirmSearchResults.hidden = results.length === 0;
  clientFirmSearchResults.innerHTML = results
    .map((firm, index) => {
      const meta = [firmTypeLabel(firm.type), firm.phone].filter(Boolean).join(' · ');
      return `<button type="button" class="firm-search-result" data-firm-index="${index}">
        <strong>${escapeHtml(firm.clientName || 'Без названия')}</strong>
        <span class="firm-search-result__meta">${escapeHtml(meta || firm.type || '—')}</span>
        ${
          firm.message
            ? `<span class="firm-search-result__preview">${escapeHtml(firm.message)}</span>`
            : ''
        }
      </button>`;
    })
    .join('');

  clientFirmSearchResults.querySelectorAll('[data-firm-index]').forEach((button) => {
    button.addEventListener('click', () => {
      const firm = results[Number(button.dataset.firmIndex)];
      if (!firm) return;
      linkClientFirm(firm).catch((error) => showClientEditError(error.message));
    });
  });
}

async function linkClientFirm(firm) {
  if (!editingClientId || clientEditBusy) return;
  showClientEditError('');
  setClientEditBusy(true);
  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(editingClientId)}/firms`, {
      method: 'POST',
      body: JSON.stringify({
        type: firm.type,
        recordId: firm.recordId,
        clientName: firm.clientName,
        phone: firm.phone,
        message: firm.message,
      }),
    });
    linkedClientFirms = [data.firm, ...linkedClientFirms.filter((row) => row.id !== data.firm.id)];
    renderLinkedClientFirms();
    resetClientFirmSearch();
  } finally {
    setClientEditBusy(false);
  }
}

async function unlinkClientFirm(linkId) {
  if (!editingClientId || clientEditBusy) return;
  showClientEditError('');
  setClientEditBusy(true);
  try {
    await api(
      `/bot-admin/api/clients/${encodeURIComponent(editingClientId)}/firms/${encodeURIComponent(linkId)}`,
      { method: 'DELETE' }
    );
    linkedClientFirms = linkedClientFirms.filter((firm) => Number(firm.id) !== Number(linkId));
    renderLinkedClientFirms();
  } finally {
    setClientEditBusy(false);
  }
}

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

function getRecordingMediaUrl(ticket) {
  return `/bot-admin/api/tickets/${encodeURIComponent(ticket.id)}/recording`;
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

function loadRecordingDuration(ticketId) {
  const key = String(ticketId);
  if (recordingDurationCache.has(key)) {
    return Promise.resolve(recordingDurationCache.get(key));
  }
  if (recordingDurationPromises.has(key)) {
    return recordingDurationPromises.get(key);
  }

  const promise = new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    const timeout = setTimeout(() => finish(null), 15_000);

    function finish(duration) {
      clearTimeout(timeout);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      audio.removeAttribute('src');
      audio.load();
      if (Number.isFinite(duration)) {
        recordingDurationCache.set(key, duration);
        resolve(duration);
      } else {
        resolve(null);
      }
    }

    function onLoaded() {
      finish(Number.isFinite(audio.duration) ? audio.duration : null);
    }

    function onError() {
      finish(null);
    }

    audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.src = `/bot-admin/api/tickets/${encodeURIComponent(ticketId)}/recording`;
  }).finally(() => recordingDurationPromises.delete(key));

  recordingDurationPromises.set(key, promise);
  return promise;
}

function loadVisibleCallDurations() {
  const generation = ++durationLoadGeneration;
  tickets.forEach((ticket, index) => {
    const recordingUrl = getRecordingUrl(ticket);
    if (!recordingUrl) return;
    loadRecordingDuration(ticket.id).then((duration) => {
      if (generation === durationLoadGeneration && Number.isFinite(duration)) {
        setDurationCell(index, duration);
      }
    });
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
}

async function calculateDurationAwareSummary(durationSummary, threshold, generation) {
  const durationsByTicketId = {};
  const calls = Array.isArray(durationSummary?.calls)
    ? durationSummary.calls.filter((call) => call.hasRecording)
    : [];

  await mapWithConcurrency(calls, 4, async (call) => {
    const duration = await loadRecordingDuration(call.id);
    if (Number.isFinite(duration)) {
      durationsByTicketId[String(call.id)] = duration;
    }
  });

  if (generation !== summaryCalculationGeneration) return;
  summary = TicketSummary.summarizeByDuration(
    durationSummary,
    durationsByTicketId,
    threshold
  );
  summaryCalculating = false;
  renderSummary();
}

function openRecordingModal(ticket, trigger) {
  if (!getRecordingUrl(ticket)) return;
  recordingModalTrigger = trigger || null;
  recordingModalTicket.textContent = `Тикет #${ticket.id} — ${ticket.subject || 'Без темы'}`;
  recordingPlayer.src = getRecordingMediaUrl(ticket);
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

function getTicketClientId(ticket) {
  const id = Number(ticket?.client_id ?? ticket?.client?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function renderClientCell(ticket, index) {
  const name = ticket.client?.name || '—';
  const clientId = getTicketClientId(ticket);
  if (!clientId || (!canEditClients && !canLinkClientFirms)) {
    return escapeHtml(name);
  }
  return `<button type="button" class="ticket-client-open" data-client-index="${index}" data-client-id="${escapeHtml(
    clientId
  )}" aria-label="Открыть клиента ${escapeHtml(name)}">${escapeHtml(name)}</button>`;
}

function formatMoneyAmount(amount) {
  const value = Number(amount) || 0;
  return value.toLocaleString('ru-RU');
}

function formatShortDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function collectUnpaidClientPhones(ticket) {
  const unpaid = ticket.local?.unpaid_orders;
  const phones = [];
  const seen = new Set();

  function pushPhone(value) {
    const phone = String(value || '').trim();
    if (!phone) return;
    const key = phone.replace(/\D/g, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    phones.push(phone);
  }

  for (const order of unpaid?.orders || []) {
    pushPhone(order.client_phone);
  }
  if (!phones.length) {
    pushPhone(ticket.client?.phone);
    for (const firm of ticket.local?.firms || []) {
      pushPhone(firm.firm_phone);
    }
  }
  return phones;
}

function renderUnpaidOrdersCell(ticket) {
  const unpaid = ticket.local?.unpaid_orders;
  const firmPhones = (ticket.local?.firms || []).map((firm) => firm.firm_phone).filter(Boolean);
  const hasLookupPhone = Boolean(ticket.client?.phone || firmPhones.length);
  if (!unpaid || unpaid.count === 0) {
    return hasLookupPhone ? '<span class="badge badge--muted">Нет</span>' : '—';
  }
  const label = `${unpaid.count} · ${formatMoneyAmount(unpaid.total_amount)}`;
  const clientPhones = collectUnpaidClientPhones(ticket);
  const params = new URLSearchParams({ status: 'pending' });
  if (clientPhones.length) {
    params.set('client', clientPhones.join(','));
  }
  const href = `/bot-admin/orders?${params.toString()}`;
  return `<a class="ticket-unpaid-link" href="${escapeHtml(href)}" title="Открыть неоплаченные заказы">${escapeHtml(
    label
  )}</a>`;
}

function renderTechnicalSupportCell(ticket) {
  const ts = ticket.local?.technical_support;
  const firmPhones = (ticket.local?.firms || []).map((firm) => firm.firm_phone).filter(Boolean);
  const hasLookupPhone = Boolean(ticket.client?.phone || firmPhones.length);
  if (!hasLookupPhone) return '—';
  if (!ts || ts.status === 'none') {
    return '<span class="badge badge--muted">Нет</span>';
  }
  const dateLabel = formatShortDate(ts.ends_at);
  if (ts.status === 'active') {
    return `<span class="badge badge--ok" title="Действует до ${escapeHtml(dateLabel)}">До ${escapeHtml(
      dateLabel
    )}</span>`;
  }
  return `<span class="badge badge--warn" title="Истекла ${escapeHtml(dateLabel)}">Истекла ${escapeHtml(
    dateLabel
  )}</span>`;
}

function renderFirmsCell(ticket, index) {
  const firms = ticket.local?.firms || [];
  if (!firms.length) return '—';
  return `<div class="ticket-firms-cell">${firms
    .map((firm, firmIndex) => {
      const label = firm.firm_name || `${firmTypeLabel(firm.firm_type)} #${firm.firm_record_id}`;
      return `<button type="button" class="ticket-firm-open" data-ticket-index="${index}" data-firm-index="${firmIndex}" data-firm-type="${escapeHtml(
        firm.firm_type
      )}" data-firm-record-id="${escapeHtml(firm.firm_record_id)}" title="${escapeHtml(
        label
      )}">${escapeHtml(label)}</button>`;
    })
    .join('')}</div>`;
}

function showFirmDetailError(message) {
  firmDetailError.hidden = !message;
  firmDetailError.textContent = message || '';
}

async function openFirmDetailModal(firmType, recordId, trigger, title) {
  firmDetailTrigger = trigger || null;
  showFirmDetailError('');
  firmDetailMessage.hidden = true;
  firmDetailMessage.textContent = '';
  firmDetailTitle.textContent = title || 'Фирма';
  firmDetailLoading.hidden = false;
  firmDetailModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');

  try {
    const data = await api(
      `/bot-admin/api/firms/${encodeURIComponent(firmType)}/${encodeURIComponent(recordId)}`
    );
    firmDetailLoading.hidden = true;
    firmDetailTitle.textContent = data.firm?.clientName || title || 'Фирма';
    firmDetailMessage.textContent = data.firm?.message || 'Нет данных.';
    firmDetailMessage.hidden = false;
  } catch (error) {
    firmDetailLoading.hidden = true;
    showFirmDetailError(error.message);
  }
}

function closeFirmDetailModal() {
  firmDetailModal.hidden = true;
  if (clientEditModal.hidden && createTicketModal.hidden && recordingModal.hidden) {
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
  }
  showFirmDetailError('');
  firmDetailMessage.hidden = true;
  firmDetailMessage.textContent = '';
  firmDetailLoading.hidden = true;
  if (firmDetailTrigger?.focus) firmDetailTrigger.focus();
  firmDetailTrigger = null;
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
      minimumCallDuration:
        parsed.minimumCallDuration != null &&
        parsed.minimumCallDuration !== '' &&
        Number.isFinite(Number(parsed.minimumCallDuration)) &&
        Number(parsed.minimumCallDuration) >= 0
          ? String(parsed.minimumCallDuration)
          : '',
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
        minimumCallDuration,
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
  minimumCallDurationInput.value = saved.minimumCallDuration;
  minimumCallDuration = saved.minimumCallDuration;
  syncDuplicateIntervalVisibility();
}

function persistSelectableFilters() {
  statusFilter = statusSelect.value;
  userFilter = userSelect.value;
  channelFilter = channelSelect.value;
  withoutDuplicates = withoutDuplicatesInput.checked;
  minimumCallDuration = minimumCallDurationInput.value.trim();
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
  minimumCallDuration = minimumCallDurationInput.value.trim();
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
  if (summaryCalculating) {
    ticketsSummaryEl.hidden = false;
    ticketsSummaryEl.innerHTML =
      '<span class="tickets-summary__calculating">Расчёт итогов по длительности звонков…</span>';
    return;
  }
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
          <th>Неоплаченные</th>
          <th>ТП</th>
          <th>Фирмы</th>
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
            <td data-label="Клиент">${renderClientCell(ticket, index)}</td>
            <td class="cell-phone" data-label="Телефон">${escapeHtml(ticket.client?.phone || '—')}</td>
            <td data-label="Неоплаченные">${renderUnpaidOrdersCell(ticket)}</td>
            <td data-label="ТП">${renderTechnicalSupportCell(ticket)}</td>
            <td data-label="Фирмы">${renderFirmsCell(ticket, index)}</td>
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

  ticketsWrap.querySelectorAll('.ticket-client-open').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const clientId = Number(button.getAttribute('data-client-id'));
      openClientEditModal(clientId, button).catch((error) => {
        showError(error.message);
      });
    });
  });

  ticketsWrap.querySelectorAll('.ticket-firm-open').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const firmType = button.getAttribute('data-firm-type');
      const recordId = button.getAttribute('data-firm-record-id');
      const title = button.getAttribute('title') || 'Фирма';
      openFirmDetailModal(firmType, recordId, button, title).catch((error) => {
        showError(error.message);
      });
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
  ticketUsers = users;
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
  ticketCreateResponsible.innerHTML =
    '<option value="">Автоматически</option>' +
    ticketUsers
      .map(
        (user) =>
          `<option value="${escapeHtml(user.id)}">${escapeHtml(
            user.full_name || user.login || `Пользователь #${user.id}`
          )}</option>`
      )
      .join('');
}

async function loadChannels({ preferredChannelId = undefined } = {}) {
  try {
    const data = await api('/bot-admin/api/tickets/channels');
    const channels = data.channels || [];
    ticketChannels = channels;
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
    ticketCreateChannel.innerHTML =
      '<option value="">Выберите канал</option>' +
      ticketChannels
        .map(
          (channel) =>
            `<option value="${escapeHtml(channel.id)}">${escapeHtml(
              channel.name || `Канал #${channel.id}`
            )}</option>`
        )
        .join('');
  } catch {
    channelNames = {};
    ticketChannels = [];
  }
}

async function loadTickets() {
  showError('');
  const summaryGeneration = ++summaryCalculationGeneration;
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: String(pageLimit),
  });
  if (searchQuery) params.set('q', searchQuery);
  if (statusFilter) params.set('status', statusFilter);
  if (userFilter) params.set('responsible_user_id', userFilter);
  if (channelFilter) params.set('channel_id', channelFilter);
  if (minimumCallDuration !== '') {
    params.set('minimum_call_duration_seconds', minimumCallDuration);
  }

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
  summaryCalculating = Boolean(data.duration_summary);
  activeTicket = data.active_ticket || null;
  activeTicketUserId =
    data.active_ticket_user_id != null ? Number(data.active_ticket_user_id) : null;

  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderSummary();
  renderActiveTicket();
  renderTicketsTable();
  renderTicketsPagination();

  if (data.duration_summary) {
    const threshold = Number(minimumCallDuration);
    calculateDurationAwareSummary(data.duration_summary, threshold, summaryGeneration).catch(
      (error) => {
        if (summaryGeneration !== summaryCalculationGeneration) return;
        console.warn('Не удалось рассчитать итоги по длительности звонков:', error);
        summaryCalculating = false;
        renderSummary();
      }
    );
  }
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
  createTicketToggle.hidden = !hasPermission(session, 'tickets_create');
  canEditClients = hasPermission(session, 'clients_edit');
  canLinkClientFirms = hasPermission(session, 'clients_link_firm');
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
minimumCallDurationInput.addEventListener('change', persistSelectableFilters);
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

createTicketToggle.addEventListener('click', openCreateTicketModal);
createTicketCancel.addEventListener('click', closeCreateTicketModal);
createTicketClose.addEventListener('click', closeCreateTicketModal);
ticketClientSearchBtn.addEventListener('click', () => {
  searchTicketClients().catch((error) => showCreateTicketError(error.message));
});
ticketClientSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  searchTicketClients().catch((error) => showCreateTicketError(error.message));
});
createTicketForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showCreateTicketError('');
  if (!selectedTicketClient) {
    showCreateTicketError('Выберите клиента REGOS.');
    return;
  }
  if (!ticketCreateChannel.value) {
    showCreateTicketError('Выберите канал.');
    return;
  }
  setCreateTicketBusy(true);
  try {
    const data = await api('/bot-admin/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        client_id: Number(selectedTicketClient.id),
        channel_id: Number(ticketCreateChannel.value),
        responsible_user_id: ticketCreateResponsible.value
          ? Number(ticketCreateResponsible.value)
          : undefined,
        direction: ticketCreateDirection.value,
        subject: ticketCreateSubject.value.trim(),
        description: ticketCreateDescription.value.trim(),
      }),
    });
    window.location.href = `/bot-admin/tickets/${encodeURIComponent(data.ticket.id)}`;
  } catch (error) {
    showCreateTicketError(error.message);
    setCreateTicketBusy(false);
  }
});

recordingModalClose.addEventListener('click', closeRecordingModal);
recordingModal.addEventListener('click', (event) => {
  if (event.target === recordingModal) closeRecordingModal();
});

clientEditClose.addEventListener('click', closeClientEditModal);
clientEditCancel.addEventListener('click', closeClientEditModal);
clientEditModal.addEventListener('click', (event) => {
  if (event.target === clientEditModal) closeClientEditModal();
});
clientFirmSearchBtn.addEventListener('click', () => {
  searchClientFirms().catch((error) => showClientEditError(error.message));
});
clientFirmSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  searchClientFirms().catch((error) => showClientEditError(error.message));
});
clientEditForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEditClients || !editingClientId || clientEditBusy) return;
  showClientEditError('');
  setClientEditBusy(true);
  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(editingClientId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: clientEditName.value.trim(),
        phone: clientEditPhone.value.trim(),
        email: clientEditEmail.value.trim(),
        external_id: clientEditExternalId.value.trim(),
        description: clientEditDescription.value.trim(),
      }),
    });
    fillClientEditForm(data.client);
    linkedClientFirms = data.firms || linkedClientFirms;
    renderLinkedClientFirms();
    applyClientToTickets(data.client);
  } catch (error) {
    showClientEditError(error.message);
  } finally {
    setClientEditBusy(false);
  }
});

firmDetailClose.addEventListener('click', closeFirmDetailModal);
firmDetailCancel.addEventListener('click', closeFirmDetailModal);
firmDetailModal.addEventListener('click', (event) => {
  if (event.target === firmDetailModal) closeFirmDetailModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!firmDetailModal.hidden) closeFirmDetailModal();
  else if (!clientEditModal.hidden) closeClientEditModal();
  else if (!createTicketModal.hidden) closeCreateTicketModal();
  else if (!recordingModal.hidden) closeRecordingModal();
});

setupLogout();
init().catch((error) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
