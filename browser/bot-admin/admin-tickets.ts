declare function applyDefaultPeriod(...args: any[]): any;
declare function loadSavedFilters(...args: any[]): any;
declare function applySavedFiltersToForm(...args: any[]): any;
declare function syncDuplicateIntervalVisibility(...args: any[]): any;
declare function loadUsers(...args: any[]): any;
declare function loadChannels(...args: any[]): any;
declare function showError(...args: any[]): any;
declare function readFiltersFromForm(...args: any[]): any;
declare function loadTickets(...args: any[]): any;
declare function connectTicketEvents(...args: any[]): any;
declare function persistSelectableFilters(...args: any[]): any;
declare function disconnectTicketEvents(...args: any[]): any;
declare function openCreateTicketModal(...args: any[]): any;
declare function closeCreateTicketModal(...args: any[]): any;
declare function searchTicketClients(...args: any[]): any;
declare function showCreateTicketError(...args: any[]): any;
declare function setCreateTicketBusy(...args: any[]): any;
declare function closeRecordingModal(...args: any[]): any;
declare function closeClientEditModal(...args: any[]): any;
declare function searchClientFirms(...args: any[]): any;
declare function showClientEditError(...args: any[]): any;
declare function setClientEditBusy(...args: any[]): any;
declare function fillClientEditForm(...args: any[]): any;
declare function renderLinkedClientFirms(...args: any[]): any;
declare function applyClientToTickets(...args: any[]): any;
declare function closeFirmDetailModal(...args: any[]): any;
declare function closeCreateOrderModal(...args: any[]): any;
declare function triggerOrderFirmSearchNow(...args: any[]): any;
declare function showCreateOrderError(...args: any[]): any;
declare function showSuccess(...args: any[]): any;
declare function setCreateOrderBusy(...args: any[]): any;
var STATUS_LABELS: Record<string, string> = {
  Open: 'Открыт',
  Closed: 'Закрыт',
  WaitingClient: 'Ожидание клиента',
  WaitingStaff: 'Ожидание сотрудника',
};

var DIRECTION_LABELS: Record<string, string> = {
  Inbound: 'Входящий',
  Outbound: 'Исходящий',
};

var FIRM_TYPE_LABELS: Record<string, string> = {
  partner: 'Partner',
  vcr1_partner: 'VCR',
  vcr1_license: 'VCR лицензия',
  license: 'Лицензия',
  rpos_client: 'RPOS клиент',
  rpos_account: 'RPOS аккаунт',
};

var FILTERS_STORAGE_KEY = 'bot-admin.tickets.filters';
var ALLOWED_STATUS_FILTERS = new Set(['', 'Open', 'Closed', 'WaitingClient', 'WaitingStaff']);

var tickets: any[] = [];
var userNames: any = {};
var channelNames: any = {};
var ticketUsers: any[] = [];
var ticketChannels: any[] = [];
var selectedTicketClient: any = null;
var createTicketBusy = false;
var canEditClients = false;
var canLinkClientFirms = false;
var editingClientId: any = null;
var linkedClientFirms: any[] = [];
var clientEditBusy = false;
var clientEditTrigger: any = null;
var searchQuery = '';
var statusFilter = '';
var userFilter = '';
var channelFilter = '';
var dateFrom = '';
var dateTo = '';
var withoutDuplicates = false;
var duplicateIntervalMinutes = 10;
var minimumCallDuration = '';
var currentPage = 1;
var pageLimit = 25;
var totalTickets = 0;
var summary = { count: 0, slaBreached: 0, rated: 0 };
var sessionRegosUserId: any = null;
var activeTicket: any = null;
var activeTicketUserId: any = null;
var ticketEvents: any = null;
var ticketEventsReconnectTimer: any = null;
var ticketEventsReconnectAttempt = 0;
var ticketEventsPaused = false;
var ticketEventsReady = false;
var realtimeTicketsRefreshTimer: any = null;
var realtimeTicketsRefreshInFlight = false;
var realtimeTicketsRefreshPending = false;
var durationLoadGeneration = 0;
var summaryCalculationGeneration = 0;
var summaryCalculating = false;
var recordingDurationCache = new Map();
var recordingDurationPromises = new Map();
var recordingModalTrigger: any = null;
var orderSelectedFirm: any = null;
var orderLinkedClientFirms: any[] = [];
var orderTicketDefaultPhone = '';
var createOrderBusy = false;
var orderFirmSearchRequestId = 0;

var searchInput = (document.getElementById('ticket-search') as any);
var searchClearBtn = (document.getElementById('search-clear') as any);
var searchBox = (document.getElementById('search-box') as any);
var statusSelect = (document.getElementById('status-filter') as any);
var userSelect = (document.getElementById('user-filter') as any);
var channelSelect = (document.getElementById('channel-filter') as any);
var dateFromInput = (document.getElementById('date-from') as any);
var dateToInput = (document.getElementById('date-to') as any);
var minimumCallDurationInput = (document.getElementById('minimum-call-duration') as any);
var withoutDuplicatesInput = (document.getElementById('without-duplicates') as any);
var duplicateIntervalWrap = (document.getElementById('duplicate-interval-wrap') as any);
var duplicateIntervalSelect = (document.getElementById('duplicate-interval') as any);
var ticketsWrap = (document.getElementById('tickets-wrap') as any);
var ticketsPaginationEl = (document.getElementById('tickets-pagination') as any);
var ticketsSummaryEl = (document.getElementById('tickets-summary') as any);
var activeTicketEl = (document.getElementById('active-ticket') as any);
var ticketsErrorEl = (document.getElementById('tickets-error') as any);
var ticketsSuccessEl = (document.getElementById('tickets-success') as any);
var filtersForm = (document.getElementById('ticket-filters') as any);
var recordingModal = (document.getElementById('ticket-recording-modal') as any);
var recordingModalClose = (document.getElementById('ticket-recording-close') as any);
var recordingModalTicket = (document.getElementById('ticket-recording-ticket') as any);
var recordingPlayer = (document.getElementById('ticket-recording-player') as any);
var createOrderModal = (document.getElementById('create-order-modal') as any);
var createOrderForm = (document.getElementById('create-order-form') as any);
var createOrderCancel = (document.getElementById('create-order-cancel') as any);
var createOrderClose = (document.getElementById('create-order-close') as any);
var createOrderErrorEl = (document.getElementById('create-order-error') as any);
var orderAmountInput = (document.getElementById('order-amount') as any);
var orderClientPhoneInput = (document.getElementById('order-client-phone') as any);
var orderAdditionalPhoneInput = (document.getElementById('order-additional-phone') as any);
var createOrderSubmit = (document.getElementById('create-order-submit') as any);
var createOrderProgress = (document.getElementById('create-order-progress') as any);
var firmSearchInput = (document.getElementById('firm-search-input') as any);
var firmSearchBtn = (document.getElementById('firm-search-btn') as any);
var firmSearchStatus = (document.getElementById('firm-search-status') as any);
var firmSearchResults = (document.getElementById('firm-search-results') as any);
var firmSelectedEl = (document.getElementById('firm-selected') as any);
var createTicketToggle = (document.getElementById('create-ticket-toggle') as any);
var createTicketModal = (document.getElementById('create-ticket-modal') as any);
var createTicketForm = (document.getElementById('create-ticket-form') as any);
var createTicketClose = (document.getElementById('create-ticket-close') as any);
var createTicketCancel = (document.getElementById('create-ticket-cancel') as any);
var createTicketSubmit = (document.getElementById('create-ticket-submit') as any);
var createTicketError = (document.getElementById('create-ticket-error') as any);
var ticketClientSearch = (document.getElementById('ticket-client-search') as any);
var ticketClientSearchBtn = (document.getElementById('ticket-client-search-btn') as any);
var ticketClientSearchStatus = (document.getElementById('ticket-client-search-status') as any);
var ticketClientSearchResults = (document.getElementById('ticket-client-search-results') as any);
var ticketClientSelected = (document.getElementById('ticket-client-selected') as any);
var ticketCreateChannel = (document.getElementById('ticket-create-channel') as any);
var ticketCreateResponsible = (document.getElementById('ticket-create-responsible') as any);
var ticketCreateDirection = (document.getElementById('ticket-create-direction') as any);
var ticketCreateSubject = (document.getElementById('ticket-create-subject') as any);
var ticketCreateDescription = (document.getElementById('ticket-create-description') as any);
var clientEditModal = (document.getElementById('client-edit-modal') as any);
var clientEditForm = (document.getElementById('client-edit-form') as any);
var clientEditClose = (document.getElementById('client-edit-close') as any);
var clientEditCancel = (document.getElementById('client-edit-cancel') as any);
var clientEditSubmit = (document.getElementById('client-edit-submit') as any);
var clientEditError = (document.getElementById('client-edit-error') as any);
var clientEditLoading = (document.getElementById('client-edit-loading') as any);
var clientEditProfile = (document.getElementById('client-edit-profile') as any);
var clientEditFirms = (document.getElementById('client-edit-firms') as any);
var clientEditName = (document.getElementById('client-edit-name') as any);
var clientEditPhone = (document.getElementById('client-edit-phone') as any);
var clientEditEmail = (document.getElementById('client-edit-email') as any);
var clientEditExternalId = (document.getElementById('client-edit-external-id') as any);
var clientEditDescription = (document.getElementById('client-edit-description') as any);
var clientLinkedFirms = (document.getElementById('client-linked-firms') as any);
var clientLinkedFirmsEmpty = (document.getElementById('client-linked-firms-empty') as any);
var clientFirmSearch = (document.getElementById('client-firm-search') as any);
var clientFirmSearchBtn = (document.getElementById('client-firm-search-btn') as any);
var clientFirmSearchStatus = (document.getElementById('client-firm-search-status') as any);
var clientFirmSearchResults = (document.getElementById('client-firm-search-results') as any);
var firmDetailModal = (document.getElementById('firm-detail-modal') as any);
var firmDetailClose = (document.getElementById('firm-detail-close') as any);
var firmDetailCancel = (document.getElementById('firm-detail-cancel') as any);
var firmDetailError = (document.getElementById('firm-detail-error') as any);
var firmDetailLoading = (document.getElementById('firm-detail-loading') as any);
var firmDetailMessage = (document.getElementById('firm-detail-message') as any);
var firmDetailTitle = (document.getElementById('firm-detail-title') as any);
var firmDetailTrigger: any = null;






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
  } catch (error: any) {
    showError(error.message);
  }
  readFiltersFromForm();
  await loadTickets();
  ticketEventsReady = true;
  connectTicketEvents();
}

filtersForm.addEventListener('submit', (event: any) => {
  event.preventDefault();
  readFiltersFromForm();
  currentPage = 1;
  loadTickets().catch((error: any) => showError(error.message));
});

(document.getElementById('refresh-tickets-btn') as any).addEventListener('click', () => {
  readFiltersFromForm();
  loadTickets().catch((error: any) => showError(error.message));
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
  onSearch: (query: any) => {
    searchQuery = query;
    currentPage = 1;
    loadTickets().catch((error: any) => showError(error.message));
  },
});

createTicketToggle.addEventListener('click', openCreateTicketModal);
createTicketCancel.addEventListener('click', closeCreateTicketModal);
createTicketClose.addEventListener('click', closeCreateTicketModal);
ticketClientSearchBtn.addEventListener('click', () => {
  searchTicketClients().catch((error: any) => showCreateTicketError(error.message));
});
ticketClientSearch.addEventListener('keydown', (event: any) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  searchTicketClients().catch((error: any) => showCreateTicketError(error.message));
});
createTicketForm.addEventListener('submit', async (event: any) => {
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
  } catch (error: any) {
    showCreateTicketError(error.message);
    setCreateTicketBusy(false);
  }
});

recordingModalClose.addEventListener('click', closeRecordingModal);
recordingModal.addEventListener('click', (event: any) => {
  if (event.target === recordingModal) closeRecordingModal();
});

clientEditClose.addEventListener('click', closeClientEditModal);
clientEditCancel.addEventListener('click', closeClientEditModal);
clientEditModal.addEventListener('click', (event: any) => {
  if (event.target === clientEditModal) closeClientEditModal();
});
clientFirmSearchBtn.addEventListener('click', () => {
  searchClientFirms().catch((error: any) => showClientEditError(error.message));
});
clientFirmSearch.addEventListener('keydown', (event: any) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  searchClientFirms().catch((error: any) => showClientEditError(error.message));
});
clientEditForm.addEventListener('submit', async (event: any) => {
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
  } catch (error: any) {
    showClientEditError(error.message);
  } finally {
    setClientEditBusy(false);
  }
});

firmDetailClose.addEventListener('click', closeFirmDetailModal);
firmDetailCancel.addEventListener('click', closeFirmDetailModal);
firmDetailModal.addEventListener('click', (event: any) => {
  if (event.target === firmDetailModal) closeFirmDetailModal();
});

document.addEventListener('keydown', (event: any) => {
  if (event.key !== 'Escape') return;
  if (!firmDetailModal.hidden) closeFirmDetailModal();
  else if (!createOrderModal.hidden) closeCreateOrderModal();
  else if (!clientEditModal.hidden) closeClientEditModal();
  else if (!createTicketModal.hidden) closeCreateTicketModal();
  else if (!recordingModal.hidden) closeRecordingModal();
});

createOrderCancel.addEventListener('click', () => closeCreateOrderModal());
createOrderClose.addEventListener('click', () => closeCreateOrderModal());
createOrderModal.addEventListener('click', (event: any) => {
  if (event.target === createOrderModal) closeCreateOrderModal();
});
firmSearchBtn.addEventListener('click', () => {
  triggerOrderFirmSearchNow();
});
firmSearchInput.addEventListener('keydown', (event: any) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    triggerOrderFirmSearchNow();
  }
});
createOrderForm.addEventListener('submit', async (event: any) => {
  event.preventDefault();
  if (!activeTicket || createOrderBusy) return;
  showCreateOrderError('');
  showSuccess('');
  setCreateOrderBusy(true);
  try {
    const payload: any = {
      amount: orderAmountInput.value,
      client_phone: orderClientPhoneInput.value.trim(),
      additional_phone: orderAdditionalPhoneInput.value.trim() || undefined,
      ticket_id: activeTicket.id,
      client_id: activeTicket.client_id ?? activeTicket.client?.id,
    };

    if (orderSelectedFirm) {
      payload.client_name = orderSelectedFirm.clientName || undefined;
      payload.client_type = orderSelectedFirm.type || undefined;
      payload.record_id = orderSelectedFirm.recordId ?? undefined;
      payload.firm_message = orderSelectedFirm.message || undefined;
      payload.firm_phone = orderSelectedFirm.phone || undefined;
    } else {
      payload.client_name = activeTicket.client?.name || undefined;
    }

    const data = await api('/bot-admin/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const payUrl = data.payment_page_url;
    closeCreateOrderModal({ force: true });
    showSuccess(
      payUrl
        ? `Заказ ${data.order.id} создан. Страница оплаты: ${payUrl}`
        : `Заказ ${data.order.id} создан.`
    );
    await loadTickets().catch((error: any) => showError(error.message));
  } catch (error: any) {
    showCreateOrderError(error.message);
    setCreateOrderBusy(false);
  }
});

setupLogout();
init().catch((error: any) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
