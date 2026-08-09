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

let ticket = null;
let userNames = {};
let selectedFirm = null;
let ticketDefaultPhone = '';
let createOrderBusy = false;
let chatMessages = [];
let chatOffset = 0;
let chatTotal = 0;
let chatHasOlder = false;
let chatPollTimer = null;
let chatRequestId = 0;
let currentTicketId = null;

const CHAT_PAGE_LIMIT = 50;
const CHAT_POLL_MS = 18000;

const ticketTitleEl = document.getElementById('ticket-title');
const ticketSubtitleEl = document.getElementById('ticket-subtitle');
const ticketErrorEl = document.getElementById('ticket-error');
const ticketSuccessEl = document.getElementById('ticket-success');
const ticketWorkspace = document.getElementById('ticket-workspace');
const ticketViewTabs = document.getElementById('ticket-view-tabs');
const ticketDetailCard = document.getElementById('ticket-detail-card');
const ticketDetailBody = document.getElementById('ticket-detail-body');
const ticketChatCard = document.getElementById('ticket-chat-card');
const ticketChatMessagesEl = document.getElementById('ticket-chat-messages');
const ticketChatStatusEl = document.getElementById('ticket-chat-status');
const ticketChatRefreshBtn = document.getElementById('ticket-chat-refresh');
const ticketChatLoadOlderWrap = document.getElementById('ticket-chat-load-older-wrap');
const ticketChatLoadOlderBtn = document.getElementById('ticket-chat-load-older');
const ticketChatCompose = document.getElementById('ticket-chat-compose');
const ticketChatInput = document.getElementById('ticket-chat-input');
const ticketChatSendBtn = document.getElementById('ticket-chat-send');
const createOrderModal = document.getElementById('create-order-modal');
const createOrderForm = document.getElementById('create-order-form');
const createOrderToggle = document.getElementById('create-order-toggle');
const createOrderCancel = document.getElementById('create-order-cancel');
const createOrderClose = document.getElementById('create-order-close');
const createOrderErrorEl = document.getElementById('create-order-error');
const orderAmountInput = document.getElementById('order-amount');
const orderClientPhoneInput = document.getElementById('order-client-phone');
const orderAdditionalPhoneInput = document.getElementById('order-additional-phone');
const createOrderSubmit = document.getElementById('create-order-submit');
const createOrderProgress = document.getElementById('create-order-progress');
const firmSearchInput = document.getElementById('firm-search-input');
const firmSearchBtn = document.getElementById('firm-search-btn');
const firmSearchStatus = document.getElementById('firm-search-status');
const firmSearchResults = document.getElementById('firm-search-results');
const firmSelectedEl = document.getElementById('firm-selected');

function setTicketView(view) {
  const nextView = view === 'detail' ? 'detail' : 'chat';
  ticketWorkspace.dataset.activeView = nextView;
  ticketViewTabs.querySelectorAll('.role-tab').forEach((tab) => {
    const isActive = tab.dataset.view === nextView;
    tab.classList.toggle('role-tab--active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

function showTicketWorkspace() {
  ticketWorkspace.hidden = false;
  ticketViewTabs.hidden = false;
  ticketDetailCard.hidden = false;
  ticketChatCard.hidden = false;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

function directionLabel(direction) {
  return DIRECTION_LABELS[direction] || direction || '—';
}

function firmTypeLabel(type) {
  return FIRM_TYPE_LABELS[type] || type || '—';
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

function showError(message) {
  ticketSuccessEl.hidden = true;
  if (!message) {
    ticketErrorEl.hidden = true;
    ticketErrorEl.textContent = '';
    return;
  }
  ticketErrorEl.hidden = false;
  ticketErrorEl.textContent = message;
}

function showSuccess(message) {
  ticketErrorEl.hidden = true;
  if (!message) {
    ticketSuccessEl.hidden = true;
    ticketSuccessEl.textContent = '';
    return;
  }
  ticketSuccessEl.hidden = false;
  ticketSuccessEl.textContent = message;
}

function showModalError(message) {
  if (!message) {
    createOrderErrorEl.hidden = true;
    createOrderErrorEl.textContent = '';
    return;
  }
  createOrderErrorEl.hidden = false;
  createOrderErrorEl.textContent = message;
}

function detailRow(label, value) {
  return `
    <div class="ticket-detail__row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${value}</dd>
    </div>
  `;
}

function detailText(value) {
  if (value == null || value === '') return '—';
  return escapeHtml(String(value));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isAudioUrl(value) {
  const text = String(value || '').trim();
  if (!isHttpUrl(text)) return false;
  if (/\.(wav|mp3|ogg|oga|m4a|aac|webm)(?:\?|#|$)/i.test(text)) return true;
  if (/\/recordings\//i.test(text)) return true;
  return false;
}

function isRecordingField(field) {
  const key = String(field?.key || '').toLowerCase();
  const name = String(field?.name || '').toLowerCase();
  return (
    key.includes('recording') ||
    name.includes('запись') ||
    name.includes('recording')
  );
}

function formatAudioPlayer(url, ticketId) {
  const safeUrl = escapeHtml(url);
  const mediaUrl = `/bot-admin/api/tickets/${encodeURIComponent(ticketId)}/recording`;
  return `
    <div class="ticket-audio">
      <audio class="ticket-audio__player" controls preload="metadata" src="${mediaUrl}">
        Ваш браузер не поддерживает воспроизведение аудио.
      </audio>
      <a class="ticket-audio__link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>
    </div>
  `;
}

function formatFieldValue(value, field = null, ticketId = null) {
  if (value == null || value === '') return '—';
  const text = String(value).trim();
  if (ticketId != null && (isAudioUrl(text) || (isHttpUrl(text) && isRecordingField(field)))) {
    return formatAudioPlayer(text, ticketId);
  }
  if (isHttpUrl(text)) {
    return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

function renderAdditionalFields(fields, ticketId) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return detailRow('Нет данных', '—');
  }
  return fields
    .map((field) =>
      detailRow(field.name || field.key || 'Поле', formatFieldValue(field.value, field, ticketId))
    )
    .join('');
}

function parseTicketIdFromPath() {
  const match = window.location.pathname.match(/\/bot-admin\/tickets\/(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}

function renderTicket(detail) {
  ticket = detail;
  ticketTitleEl.textContent = `Тикет #${detail.id}`;
  ticketSubtitleEl.textContent = detail.subject || '';
  ticketDefaultPhone = detail.client?.phone || '';

  const participantIds = Array.isArray(detail.participant_user_ids)
    ? detail.participant_user_ids
    : [];
  const participants =
    participantIds.length > 0
      ? participantIds.map((id) => escapeHtml(userLabel(id))).join(', ')
      : '—';

  const descriptionHtml = detail.description
    ? `<div class="ticket-detail__description">${escapeHtml(detail.description)}</div>`
    : '—';

  ticketDetailBody.innerHTML = `
    <section class="ticket-detail__section">
      <h4>Основное</h4>
      <dl class="ticket-detail">
        ${detailRow('Тема', detailText(detail.subject))}
        ${detailRow('Статус', `<span class="${statusBadgeClass(detail.status)}">${escapeHtml(statusLabel(detail.status))}</span>`)}
        ${detailRow('Направление', detailText(directionLabel(detail.direction)))}
        ${detailRow('Создан', detailText(formatUnix(detail.created_date)))}
        ${detailRow('Обновлён', detailText(formatUnix(detail.last_update)))}
        ${detailRow('Описание', descriptionHtml)}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Клиент</h4>
      <dl class="ticket-detail">
        ${detailRow('Имя', detailText(detail.client?.name))}
        ${detailRow('Телефон', detailText(detail.client?.phone))}
        ${detailRow('Email', detailText(detail.client?.email))}
        ${detailRow('ID клиента', detailText(detail.client_id))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Ответственные</h4>
      <dl class="ticket-detail">
        ${detailRow('Ответственный', detailText(userLabel(detail.responsible_user_id)))}
        ${detailRow('Участники', participants)}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>SLA</h4>
      <dl class="ticket-detail">
        ${detailRow('Нарушен', detail.sla_breached ? 'Да' : 'Нет')}
        ${detailRow('Дата нарушения', detailText(formatUnix(detail.sla_breached_date)))}
        ${detailRow('Первый ответ', detailText(formatUnix(detail.first_response_date)))}
        ${detailRow('Срок первого ответа', detailText(formatUnix(detail.first_response_due_date)))}
        ${detailRow('Срок решения', detailText(formatUnix(detail.resolve_due_date)))}
        ${detailRow('Решён', detailText(formatUnix(detail.resolved_date)))}
        ${detailRow('Пропущен', detail.missed ? 'Да' : 'Нет')}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Оценка</h4>
      <dl class="ticket-detail">
        ${detailRow('Оценка', detailText(detail.rating))}
        ${detailRow('Комментарий', detailText(detail.rating_comment))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Настроение клиента</h4>
      <dl class="ticket-detail">
        ${detailRow('Оценка', detailText(detail.client_sentiment_score))}
        ${detailRow('Комментарий', detailText(detail.client_sentiment_comment))}
        ${detailRow('Кто оценил', detailText(userLabel(detail.client_sentiment_user_id)))}
        ${detailRow('Дата', detailText(formatUnix(detail.client_sentiment_date)))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Проверка супервайзера</h4>
      <dl class="ticket-detail">
        ${detailRow('Оценка', detailText(detail.supervisor_review_score))}
        ${detailRow('Комментарий', detailText(detail.supervisor_review_comment))}
        ${detailRow('Кто проверил', detailText(userLabel(detail.supervisor_review_user_id)))}
        ${detailRow('Дата', detailText(formatUnix(detail.supervisor_review_date)))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Ссылки</h4>
      <dl class="ticket-detail">
        ${detailRow('chat_id', detailText(detail.chat_id))}
        ${detailRow('external_dialog_id', detailText(detail.external_dialog_id))}
        ${detailRow('audio_recording_file_id', detailText(detail.audio_recording_file_id))}
      </dl>
    </section>

    <section class="ticket-detail__section">
      <h4>Дополнительные поля</h4>
      <dl class="ticket-detail">
        ${renderAdditionalFields(detail.fields, detail.id)}
      </dl>
    </section>
  `;

  showTicketWorkspace();
}

function clearFirmSearchUi() {
  firmSearchInput.value = '';
  firmSearchStatus.hidden = true;
  firmSearchStatus.textContent = '';
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
}

function renderSelectedFirm() {
  if (!selectedFirm) {
    firmSelectedEl.hidden = true;
    firmSelectedEl.innerHTML = '';
    return;
  }

  firmSelectedEl.hidden = false;
  firmSelectedEl.innerHTML = `
    <div class="firm-selected__body">
      <strong>${escapeHtml(selectedFirm.clientName || 'Без названия')}</strong>
      <span>${escapeHtml(firmTypeLabel(selectedFirm.type))}${
        selectedFirm.phone ? ` · ${escapeHtml(selectedFirm.phone)}` : ''
      }</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" id="firm-clear-btn">Сбросить</button>
  `;
  document.getElementById('firm-clear-btn')?.addEventListener('click', clearSelectedFirm);
}

function clearSelectedFirm() {
  selectedFirm = null;
  renderSelectedFirm();
  orderClientPhoneInput.value = ticketDefaultPhone;
}

function selectFirm(firm) {
  selectedFirm = firm;
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
  firmSearchStatus.hidden = true;
  renderSelectedFirm();
  if (firm.phone) {
    orderClientPhoneInput.value = firm.phone;
  } else if (!orderClientPhoneInput.value.trim()) {
    orderClientPhoneInput.value = ticketDefaultPhone;
  }
}

function renderFirmResults(results) {
  if (!results.length) {
    firmSearchResults.hidden = true;
    firmSearchResults.innerHTML = '';
    firmSearchStatus.hidden = false;
    firmSearchStatus.textContent = 'Ничего не найдено.';
    return;
  }

  firmSearchStatus.hidden = true;
  firmSearchResults.hidden = false;
  firmSearchResults.innerHTML = results
    .map((firm, index) => {
      const preview = String(firm.message || '')
        .split('\n')
        .slice(0, 2)
        .join(' · ');
      return `
        <button type="button" class="firm-search-result" data-firm-index="${index}">
          <strong>${escapeHtml(firm.clientName || 'Без названия')}</strong>
          <span class="firm-search-result__meta">${escapeHtml(firmTypeLabel(firm.type))}${
            firm.phone ? ` · ${escapeHtml(firm.phone)}` : ''
          }</span>
          <span class="firm-search-result__preview">${escapeHtml(preview || '—')}</span>
        </button>
      `;
    })
    .join('');

  firmSearchResults.querySelectorAll('.firm-search-result').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.getAttribute('data-firm-index'));
      const firm = results[index];
      if (firm) selectFirm(firm);
    });
  });
}

const FIRM_SEARCH_DEBOUNCE_MS = 300;
let firmSearchTimer = null;
let firmSearchRequestId = 0;

function clearFirmSearchResults() {
  firmSearchStatus.hidden = true;
  firmSearchStatus.textContent = '';
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
}

function cancelFirmSearchDebounce() {
  if (firmSearchTimer != null) {
    clearTimeout(firmSearchTimer);
    firmSearchTimer = null;
  }
}

async function runFirmSearch() {
  const q = firmSearchInput.value.trim();
  if (!q) {
    clearFirmSearchResults();
    return;
  }
  const requestId = ++firmSearchRequestId;
  firmSearchBtn.disabled = true;
  firmSearchStatus.hidden = false;
  firmSearchStatus.textContent = 'Поиск…';
  try {
    const data = await api(`/bot-admin/api/firm-search?q=${encodeURIComponent(q)}`);
    if (requestId !== firmSearchRequestId) return;
    renderFirmResults(data.results || []);
  } catch (error) {
    if (requestId !== firmSearchRequestId) return;
    firmSearchResults.hidden = true;
    firmSearchStatus.hidden = false;
    firmSearchStatus.textContent = error.message;
  } finally {
    if (requestId === firmSearchRequestId) {
      firmSearchBtn.disabled = false;
    }
  }
}

function scheduleFirmSearch() {
  cancelFirmSearchDebounce();
  const q = firmSearchInput.value.trim();
  if (!q) {
    firmSearchRequestId += 1;
    clearFirmSearchResults();
    return;
  }
  firmSearchTimer = setTimeout(() => {
    firmSearchTimer = null;
    runFirmSearch().catch((error) => {
      firmSearchStatus.hidden = false;
      firmSearchStatus.textContent = error.message;
    });
  }, FIRM_SEARCH_DEBOUNCE_MS);
}

function triggerFirmSearchNow() {
  cancelFirmSearchDebounce();
  runFirmSearch().catch((error) => {
    firmSearchStatus.hidden = false;
    firmSearchStatus.textContent = error.message;
  });
}

function resetCreateOrderForm() {
  cancelFirmSearchDebounce();
  firmSearchRequestId += 1;
  createOrderForm.reset();
  selectedFirm = null;
  clearFirmSearchUi();
  renderSelectedFirm();
  orderClientPhoneInput.value = ticketDefaultPhone;
  showModalError('');
}

function lockPageScroll() {
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
}

function unlockPageScroll() {
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
}

function openCreateOrderModal() {
  resetCreateOrderForm();
  showError('');
  setCreateOrderBusy(false);
  createOrderModal.hidden = false;
  lockPageScroll();
  orderAmountInput.focus();
}

function closeCreateOrderModal({ force = false } = {}) {
  if (createOrderBusy && !force) return;
  setCreateOrderBusy(false);
  createOrderModal.hidden = true;
  unlockPageScroll();
  resetCreateOrderForm();
}

function setCreateOrderBusy(busy) {
  createOrderBusy = Boolean(busy);
  createOrderProgress.hidden = !createOrderBusy;
  createOrderForm.setAttribute('aria-busy', createOrderBusy ? 'true' : 'false');
  createOrderSubmit.disabled = createOrderBusy;
  createOrderCancel.disabled = createOrderBusy;
  createOrderClose.disabled = createOrderBusy;
  createOrderSubmit.classList.toggle('is-loading', createOrderBusy);
  createOrderForm.querySelectorAll('input, button').forEach((el) => {
    if (el === createOrderSubmit || el === createOrderCancel || el === createOrderClose) return;
    el.disabled = createOrderBusy;
  });
}

async function loadUsers() {
  try {
    const data = await api('/bot-admin/api/tickets/users');
    userNames = {};
    for (const user of data.users || []) {
      userNames[user.id] = user.full_name || user.login || `Пользователь #${user.id}`;
    }
  } catch {
    userNames = {};
  }
}

function setChatStatus(message, { isError = false } = {}) {
  if (!message) {
    ticketChatStatusEl.hidden = true;
    ticketChatStatusEl.textContent = '';
    ticketChatStatusEl.classList.remove('ticket-chat__status--error');
    return;
  }
  ticketChatStatusEl.hidden = false;
  ticketChatStatusEl.textContent = message;
  ticketChatStatusEl.classList.toggle('ticket-chat__status--error', Boolean(isError));
}

function setChatComposerEnabled(enabled) {
  const canSend = Boolean(enabled);
  ticketChatCompose.hidden = !canSend;
  ticketChatInput.disabled = !canSend;
  ticketChatSendBtn.disabled = !canSend;
  if (!canSend) {
    ticketChatInput.value = '';
  }
}

function chatAuthorBadge(message) {
  const messageType = String(message.message_type || '');
  if (messageType === 'System') {
    return { label: 'Система', className: 'ticket-chat__badge ticket-chat__badge--system' };
  }
  if (messageType === 'Private') {
    return { label: 'Приват', className: 'ticket-chat__badge ticket-chat__badge--private' };
  }
  const entityType = String(message.author_entity_type || '');
  const role = String(message.author_role || '');
  if (entityType === 'Client' || role === 'Member') {
    return { label: 'Клиент', className: 'ticket-chat__badge ticket-chat__badge--client' };
  }
  if (entityType === 'ChatBot' || role === 'Bot') {
    return { label: 'Бот', className: 'ticket-chat__badge ticket-chat__badge--bot' };
  }
  if (entityType === 'User' || role === 'Staff') {
    return { label: 'Сотрудник', className: 'ticket-chat__badge ticket-chat__badge--staff' };
  }
  return { label: entityType || role || 'Сообщение', className: 'ticket-chat__badge' };
}

function chatMessageClass(message) {
  const messageType = String(message.message_type || '');
  if (messageType === 'System') return 'ticket-chat__msg ticket-chat__msg--system';
  if (messageType === 'Private') return 'ticket-chat__msg ticket-chat__msg--private';
  const entityType = String(message.author_entity_type || '');
  const role = String(message.author_role || '');
  if (entityType === 'Client' || role === 'Member') {
    return 'ticket-chat__msg ticket-chat__msg--client';
  }
  if (entityType === 'ChatBot' || role === 'Bot') {
    return 'ticket-chat__msg ticket-chat__msg--bot';
  }
  if (entityType === 'User' || role === 'Staff') {
    return 'ticket-chat__msg ticket-chat__msg--staff';
  }
  return 'ticket-chat__msg';
}

function renderChatMessage(message) {
  const badge = chatAuthorBadge(message);
  const author =
    message.author_entity_name ||
    (message.author_entity_id != null ? `ID ${message.author_entity_id}` : 'Неизвестный');
  const replyHtml =
    message.replay_text || message.reply_id
      ? `<div class="ticket-chat__reply">${escapeHtml(
          message.replay_text || `Ответ на ${message.reply_id}`
        )}</div>`
      : '';
  const text = message.text
    ? `<p class="ticket-chat__text">${escapeHtml(message.text)}</p>`
    : `<p class="ticket-chat__text ticket-chat__text--empty">—</p>`;
  const fileIds = Array.isArray(message.file_ids) ? message.file_ids.filter((id) => id != null) : [];
  const filesHtml =
    fileIds.length > 0
      ? `<p class="ticket-chat__files">Файлы: ${escapeHtml(fileIds.join(', '))}</p>`
      : '';

  return `
    <article class="${chatMessageClass(message)}" data-message-id="${escapeHtml(String(message.id || ''))}">
      <div class="ticket-chat__meta">
        <span class="ticket-chat__author">${escapeHtml(author)}</span>
        <span class="${badge.className}">${escapeHtml(badge.label)}</span>
        <time datetime="${escapeHtml(String(message.created_date || ''))}">${escapeHtml(
          formatUnix(message.created_date)
        )}</time>
      </div>
      ${replyHtml}
      ${text}
      ${filesHtml}
    </article>
  `;
}

function updateLoadOlderVisibility() {
  ticketChatLoadOlderWrap.hidden = !chatHasOlder;
}

function renderChatMessages({ stickToBottom = false } = {}) {
  const wasNearBottom =
    ticketChatMessagesEl.scrollHeight - ticketChatMessagesEl.scrollTop - ticketChatMessagesEl.clientHeight <
    80;
  const previousHeight = ticketChatMessagesEl.scrollHeight;
  const previousTop = ticketChatMessagesEl.scrollTop;

  if (!chatMessages.length) {
    ticketChatMessagesEl.innerHTML = `<p class="ticket-chat__empty">Сообщений пока нет.</p>`;
  } else {
    ticketChatMessagesEl.innerHTML = chatMessages.map(renderChatMessage).join('');
  }

  updateLoadOlderVisibility();

  if (stickToBottom || wasNearBottom) {
    ticketChatMessagesEl.scrollTop = ticketChatMessagesEl.scrollHeight;
  } else if (previousHeight > 0) {
    ticketChatMessagesEl.scrollTop =
      ticketChatMessagesEl.scrollHeight - previousHeight + previousTop;
  }
}

function mergeMessages(existing, incoming, { prepend = false } = {}) {
  const byId = new Map();
  const ordered = prepend ? [...incoming, ...existing] : [...existing, ...incoming];
  for (const message of ordered) {
    if (!message?.id) continue;
    byId.set(String(message.id), message);
  }
  return [...byId.values()].sort((a, b) => {
    const dateA = Number(a.created_date) || 0;
    const dateB = Number(b.created_date) || 0;
    if (dateA !== dateB) return dateA - dateB;
    return String(a.id).localeCompare(String(b.id));
  });
}

function stopChatPolling() {
  if (chatPollTimer != null) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

function startChatPolling(ticketId) {
  stopChatPolling();
  chatPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshChatTail(ticketId).catch(() => {});
  }, CHAT_POLL_MS);
}

async function fetchChatPage(ticketId, { limit = CHAT_PAGE_LIMIT, offset, fromEnd = false } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (fromEnd) {
    params.set('from_end', '1');
  } else if (offset != null) {
    params.set('offset', String(offset));
  }
  return api(`/bot-admin/api/tickets/${ticketId}/messages?${params.toString()}`);
}

async function loadChatMessages(ticketId, { silent = false } = {}) {
  const requestId = ++chatRequestId;
  if (!silent) {
    setChatStatus('Загрузка сообщений…');
  }
  showTicketWorkspace();
  ticketChatRefreshBtn.disabled = true;
  ticketChatLoadOlderBtn.disabled = true;

  try {
    const data = await fetchChatPage(ticketId, { fromEnd: true, limit: CHAT_PAGE_LIMIT });
    if (requestId !== chatRequestId) return;

    if (!data.chat_id) {
      chatMessages = [];
      chatOffset = 0;
      chatTotal = 0;
      chatHasOlder = false;
      ticketChatMessagesEl.innerHTML =
        '<p class="ticket-chat__empty">Чат не привязан к этому тикету.</p>';
      updateLoadOlderVisibility();
      setChatComposerEnabled(false);
      setChatStatus('');
      stopChatPolling();
      return;
    }

    chatMessages = data.messages || [];
    chatOffset = data.offset || 0;
    chatTotal = data.total || chatMessages.length;
    chatHasOlder = Boolean(data.has_older);
    setChatComposerEnabled(true);
    renderChatMessages({ stickToBottom: true });
    setChatStatus(
      chatTotal > 0 ? `Сообщений: ${chatMessages.length} из ${chatTotal}` : ''
    );
    startChatPolling(ticketId);
  } catch (error) {
    if (requestId !== chatRequestId) return;
    setChatStatus(error.message || 'Не удалось загрузить сообщения.', { isError: true });
    if (!chatMessages.length) {
      setChatComposerEnabled(false);
      ticketChatMessagesEl.innerHTML =
        '<p class="ticket-chat__empty">Не удалось загрузить сообщения.</p>';
    }
  } finally {
    if (requestId === chatRequestId) {
      ticketChatRefreshBtn.disabled = false;
      ticketChatLoadOlderBtn.disabled = false;
    }
  }
}

async function loadOlderChatMessages(ticketId) {
  if (!chatHasOlder || chatOffset <= 0) return;
  const requestId = ++chatRequestId;
  const prevScrollHeight = ticketChatMessagesEl.scrollHeight;
  const prevScrollTop = ticketChatMessagesEl.scrollTop;
  ticketChatLoadOlderBtn.disabled = true;
  setChatStatus('Загрузка предыдущих сообщений…');

  try {
    const nextOffset = Math.max(0, chatOffset - CHAT_PAGE_LIMIT);
    const limit = chatOffset - nextOffset;
    const data = await fetchChatPage(ticketId, { limit, offset: nextOffset });
    if (requestId !== chatRequestId) return;

    chatMessages = mergeMessages(chatMessages, data.messages || [], { prepend: true });
    chatOffset = data.offset ?? nextOffset;
    chatTotal = data.total ?? chatTotal;
    chatHasOlder = Boolean(data.has_older);
    renderChatMessages();
    ticketChatMessagesEl.scrollTop =
      ticketChatMessagesEl.scrollHeight - prevScrollHeight + prevScrollTop;
    setChatStatus(`Сообщений: ${chatMessages.length} из ${chatTotal}`);
  } catch (error) {
    if (requestId !== chatRequestId) return;
    setChatStatus(error.message || 'Не удалось загрузить сообщения.', { isError: true });
  } finally {
    if (requestId === chatRequestId) {
      ticketChatLoadOlderBtn.disabled = false;
    }
  }
}

async function refreshChatTail(ticketId) {
  if (!ticket?.chat_id) return;
  const data = await fetchChatPage(ticketId, { fromEnd: true, limit: CHAT_PAGE_LIMIT });
  if (!data.chat_id) return;

  const incoming = data.messages || [];
  const knownIds = new Set(chatMessages.map((m) => String(m.id)));
  const hasNew = incoming.some((m) => m?.id && !knownIds.has(String(m.id)));
  if (!hasNew && incoming.length <= chatMessages.length) {
    chatTotal = data.total ?? chatTotal;
    return;
  }

  // Keep older messages that were already loaded; merge the latest page.
  chatMessages = mergeMessages(chatMessages, incoming);
  chatTotal = data.total ?? chatTotal;
  if (typeof data.offset === 'number' && data.offset < chatOffset) {
    chatOffset = data.offset;
    chatHasOlder = Boolean(data.has_older);
  }
  renderChatMessages({ stickToBottom: true });
  setChatStatus(chatTotal > 0 ? `Сообщений: ${chatMessages.length} из ${chatTotal}` : '');
}

async function sendChatMessage(ticketId) {
  const text = ticketChatInput.value.trim();
  if (!text) {
    setChatStatus('Введите текст сообщения.', { isError: true });
    ticketChatInput.focus();
    return;
  }
  if (!ticket?.chat_id) {
    setChatStatus('Чат не привязан к этому тикету.', { isError: true });
    setChatComposerEnabled(false);
    return;
  }

  ticketChatSendBtn.disabled = true;
  ticketChatInput.disabled = true;
  setChatStatus('Отправка…');

  try {
    await api(`/bot-admin/api/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    ticketChatInput.value = '';
    await refreshChatTail(ticketId);
    setChatStatus(chatTotal > 0 ? `Сообщений: ${chatMessages.length} из ${chatTotal}` : '');
  } catch (error) {
    setChatStatus(error.message || 'Не удалось отправить сообщение.', { isError: true });
  } finally {
    const canSend = Boolean(ticket?.chat_id);
    ticketChatInput.disabled = !canSend;
    ticketChatSendBtn.disabled = !canSend;
    if (canSend) {
      ticketChatInput.focus();
    }
  }
}

async function loadTicket(ticketId) {
  currentTicketId = ticketId;
  const data = await api(`/bot-admin/api/tickets/${ticketId}`);
  renderTicket(data.ticket);
  await loadChatMessages(ticketId);
}

createOrderToggle.addEventListener('click', openCreateOrderModal);
createOrderCancel.addEventListener('click', closeCreateOrderModal);
createOrderClose.addEventListener('click', closeCreateOrderModal);
ticketViewTabs.querySelectorAll('.role-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    setTicketView(tab.dataset.view);
  });
});
ticketChatRefreshBtn.addEventListener('click', () => {
  if (currentTicketId == null) return;
  loadChatMessages(currentTicketId).catch((error) => {
    setChatStatus(error.message || 'Не удалось обновить чат.', { isError: true });
  });
});
ticketChatLoadOlderBtn.addEventListener('click', () => {
  if (currentTicketId == null) return;
  loadOlderChatMessages(currentTicketId).catch((error) => {
    setChatStatus(error.message || 'Не удалось загрузить сообщения.', { isError: true });
  });
});
ticketChatCompose.addEventListener('submit', (event) => {
  event.preventDefault();
  if (currentTicketId == null || ticketChatSendBtn.disabled) return;
  sendChatMessage(currentTicketId).catch((error) => {
    setChatStatus(error.message || 'Не удалось отправить сообщение.', { isError: true });
  });
});
ticketChatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (currentTicketId == null || ticketChatSendBtn.disabled) return;
  ticketChatCompose.requestSubmit();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTicketId != null && ticket?.chat_id) {
    refreshChatTail(currentTicketId).catch(() => {});
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !createOrderModal.hidden) {
    closeCreateOrderModal();
  }
});

firmSearchBtn.addEventListener('click', () => {
  triggerFirmSearchNow();
});
firmSearchInput.addEventListener('input', () => {
  scheduleFirmSearch();
});
firmSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    triggerFirmSearchNow();
  }
});

createOrderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (createOrderBusy) return;
  showModalError('');
  showSuccess('');
  setCreateOrderBusy(true);
  try {
    const payload = {
      amount: orderAmountInput.value,
      client_phone: orderClientPhoneInput.value.trim(),
      additional_phone: orderAdditionalPhoneInput.value.trim() || undefined,
      ticket_id: ticket?.id,
    };

    if (selectedFirm) {
      payload.client_name = selectedFirm.clientName || undefined;
      payload.client_type = selectedFirm.type || undefined;
      payload.record_id = selectedFirm.recordId ?? undefined;
      payload.firm_message = selectedFirm.message || undefined;
    } else {
      payload.client_name = ticket?.client?.name || undefined;
    }

    const data = await api('/bot-admin/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const payUrl = data.payment_page_url;
    showSuccess(
      payUrl
        ? `Заказ ${data.order.id} создан. Страница оплаты: ${payUrl}`
        : `Заказ ${data.order.id} создан.`
    );
    closeCreateOrderModal({ force: true });
  } catch (error) {
    showModalError(error.message);
    setCreateOrderBusy(false);
  }
});

async function init() {
  await ensureSession({ requiredPermission: 'tickets_read' });
  const ticketId = parseTicketIdFromPath();
  if (!ticketId) {
    showError('Некорректный идентификатор тикета.');
    return;
  }
  await loadUsers();
  await loadTicket(ticketId);
}

setupLogout();
init().catch((error) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
