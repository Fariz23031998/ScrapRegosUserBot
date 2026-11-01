declare var userNames: any, channelNames: any, canEditClients: any, canLinkClientFirms: any;
declare function firmTypeLabel(...args: any[]): any;
declare var firmDetailError: any, firmDetailTrigger: any, firmDetailMessage: any, firmDetailTitle: any, firmDetailLoading: any, firmDetailModal: any, clientEditModal: any, createTicketModal: any, recordingModal: any, dateFromInput: any, dateToInput: any, dateFrom: any, dateTo: any, duplicateIntervalWrap: any, withoutDuplicatesInput: any, FILTERS_STORAGE_KEY: any, statusFilter: any, userFilter: any, channelFilter: any, ALLOWED_STATUS_FILTERS: any, statusSelect: any, withoutDuplicates: any, minimumCallDurationInput: any, minimumCallDuration: any, userSelect: any, channelSelect: any, searchQuery: any, searchInput: any, duplicateIntervalMinutes: any, duplicateIntervalSelect: any;
function formatUnix(seconds: any) {
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

function userLabel(userId: any) {
  if (userId == null) return '—';
  return userNames[userId] || `Пользователь #${userId}`;
}

function channelLabel(channelId: any) {
  if (channelId == null || channelId === '') return '—';
  return channelNames[channelId] || `Канал #${channelId}`;
}

function getTicketClientId(ticket: any) {
  const id = Number(ticket?.client_id ?? ticket?.client?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function renderClientCell(ticket: any, index: any) {
  const name = ticket.client?.name || '—';
  const clientId = getTicketClientId(ticket);
  if (!clientId || (!canEditClients && !canLinkClientFirms)) {
    return escapeHtml(name);
  }
  return `<button type="button" class="ticket-client-open" data-client-index="${index}" data-client-id="${escapeHtml(
    clientId
  )}" aria-label="Открыть клиента ${escapeHtml(name)}">${escapeHtml(name)}</button>`;
}

function formatMoneyAmount(amount: any) {
  const value = Number(amount) || 0;
  return value.toLocaleString('ru-RU');
}

function formatShortDate(iso: any) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function collectUnpaidClientPhones(ticket: any) {
  const phones: any[] = [];
  const seen = new Set();

  function pushPhone(value: any) {
    const phone = String(value || '').trim();
    if (!phone) return;
    const key = phone.replace(/\D/g, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    phones.push(phone);
  }

  pushPhone(ticket.client?.phone);
  for (const firm of ticket.local?.firms || []) {
    pushPhone(firm.firm_phone);
  }
  if (!phones.length) {
    for (const order of ticket.local?.unpaid_orders?.orders || []) {
      pushPhone(order.client_phone);
    }
  }
  return phones;
}

function renderUnpaidOrdersCell(ticket: any) {
  const unpaid = ticket.local?.unpaid_orders;
  const firmPhones = (ticket.local?.firms || []).map((firm: any) => firm.firm_phone).filter(Boolean);
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

function renderTechnicalSupportCell(ticket: any) {
  const ts = ticket.local?.technical_support;
  const firmPhones = (ticket.local?.firms || []).map((firm: any) => firm.firm_phone).filter(Boolean);
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

function renderFirmsCell(ticket: any, index: any) {
  const firms = ticket.local?.firms || [];
  if (!firms.length) return '—';
  return `<div class="ticket-firms-cell">${firms
    .map((firm: any, firmIndex: any) => {
      const label = firm.firm_name || `${firmTypeLabel(firm.firm_type)} #${firm.firm_record_id}`;
      return `<button type="button" class="ticket-firm-open" data-ticket-index="${index}" data-firm-index="${firmIndex}" data-firm-type="${escapeHtml(
        firm.firm_type
      )}" data-firm-record-id="${escapeHtml(firm.firm_record_id)}" title="${escapeHtml(
        label
      )}">${escapeHtml(label)}</button>`;
    })
    .join('')}</div>`;
}

function showFirmDetailError(message: any) {
  firmDetailError.hidden = !message;
  firmDetailError.textContent = message || '';
}

async function openFirmDetailModal(firmType: any, recordId: any, trigger: any, title: any) {
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
  } catch (error: any) {
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

function pad2(n: any) {
  return String(n).padStart(2, '0');
}

function toDatetimeLocalValue(date: any) {
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

function datetimeLocalToUnix(value: any) {
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

function applySavedFiltersToForm(saved: any) {
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
