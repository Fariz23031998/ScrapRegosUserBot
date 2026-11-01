"use strict";
var STATUS_LABELS = {
    Open: 'Открыт',
    Closed: 'Закрыт',
    WaitingClient: 'Ожидание клиента',
    WaitingStaff: 'Ожидание сотрудника',
};
var DIRECTION_LABELS = {
    Inbound: 'Входящий',
    Outbound: 'Исходящий',
};
var FIRM_TYPE_LABELS = {
    partner: 'Partner',
    vcr1_partner: 'VCR',
    vcr1_license: 'VCR лицензия',
    license: 'Лицензия',
    rpos_client: 'RPOS клиент',
    rpos_account: 'RPOS аккаунт',
};
var FILTERS_STORAGE_KEY = 'bot-admin.tickets.filters';
var ALLOWED_STATUS_FILTERS = new Set(['', 'Open', 'Closed', 'WaitingClient', 'WaitingStaff']);
var tickets = [];
var userNames = {};
var channelNames = {};
var ticketUsers = [];
var ticketChannels = [];
var selectedTicketClient = null;
var createTicketBusy = false;
var canEditClients = false;
var canLinkClientFirms = false;
var editingClientId = null;
var linkedClientFirms = [];
var clientEditBusy = false;
var clientEditTrigger = null;
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
var sessionRegosUserId = null;
var activeTicket = null;
var activeTicketUserId = null;
var ticketEvents = null;
var ticketEventsReconnectTimer = null;
var ticketEventsReconnectAttempt = 0;
var ticketEventsPaused = false;
var ticketEventsReady = false;
var realtimeTicketsRefreshTimer = null;
var realtimeTicketsRefreshInFlight = false;
var realtimeTicketsRefreshPending = false;
var durationLoadGeneration = 0;
var summaryCalculationGeneration = 0;
var summaryCalculating = false;
var recordingDurationCache = new Map();
var recordingDurationPromises = new Map();
var recordingModalTrigger = null;
var orderSelectedFirm = null;
var orderLinkedClientFirms = [];
var orderTicketDefaultPhone = '';
var createOrderBusy = false;
var orderFirmSearchRequestId = 0;
var searchInput = document.getElementById('ticket-search');
var searchClearBtn = document.getElementById('search-clear');
var searchBox = document.getElementById('search-box');
var statusSelect = document.getElementById('status-filter');
var userSelect = document.getElementById('user-filter');
var channelSelect = document.getElementById('channel-filter');
var dateFromInput = document.getElementById('date-from');
var dateToInput = document.getElementById('date-to');
var minimumCallDurationInput = document.getElementById('minimum-call-duration');
var withoutDuplicatesInput = document.getElementById('without-duplicates');
var duplicateIntervalWrap = document.getElementById('duplicate-interval-wrap');
var duplicateIntervalSelect = document.getElementById('duplicate-interval');
var ticketsWrap = document.getElementById('tickets-wrap');
var ticketsPaginationEl = document.getElementById('tickets-pagination');
var ticketsSummaryEl = document.getElementById('tickets-summary');
var activeTicketEl = document.getElementById('active-ticket');
var ticketsErrorEl = document.getElementById('tickets-error');
var ticketsSuccessEl = document.getElementById('tickets-success');
var filtersForm = document.getElementById('ticket-filters');
var recordingModal = document.getElementById('ticket-recording-modal');
var recordingModalClose = document.getElementById('ticket-recording-close');
var recordingModalTicket = document.getElementById('ticket-recording-ticket');
var recordingPlayer = document.getElementById('ticket-recording-player');
var createOrderModal = document.getElementById('create-order-modal');
var createOrderForm = document.getElementById('create-order-form');
var createOrderCancel = document.getElementById('create-order-cancel');
var createOrderClose = document.getElementById('create-order-close');
var createOrderErrorEl = document.getElementById('create-order-error');
var orderAmountInput = document.getElementById('order-amount');
var orderClientPhoneInput = document.getElementById('order-client-phone');
var orderAdditionalPhoneInput = document.getElementById('order-additional-phone');
var createOrderSubmit = document.getElementById('create-order-submit');
var createOrderProgress = document.getElementById('create-order-progress');
var firmSearchInput = document.getElementById('firm-search-input');
var firmSearchBtn = document.getElementById('firm-search-btn');
var firmSearchStatus = document.getElementById('firm-search-status');
var firmSearchResults = document.getElementById('firm-search-results');
var firmSelectedEl = document.getElementById('firm-selected');
var createTicketToggle = document.getElementById('create-ticket-toggle');
var createTicketModal = document.getElementById('create-ticket-modal');
var createTicketForm = document.getElementById('create-ticket-form');
var createTicketClose = document.getElementById('create-ticket-close');
var createTicketCancel = document.getElementById('create-ticket-cancel');
var createTicketSubmit = document.getElementById('create-ticket-submit');
var createTicketError = document.getElementById('create-ticket-error');
var ticketClientSearch = document.getElementById('ticket-client-search');
var ticketClientSearchBtn = document.getElementById('ticket-client-search-btn');
var ticketClientSearchStatus = document.getElementById('ticket-client-search-status');
var ticketClientSearchResults = document.getElementById('ticket-client-search-results');
var ticketClientSelected = document.getElementById('ticket-client-selected');
var ticketCreateChannel = document.getElementById('ticket-create-channel');
var ticketCreateResponsible = document.getElementById('ticket-create-responsible');
var ticketCreateDirection = document.getElementById('ticket-create-direction');
var ticketCreateSubject = document.getElementById('ticket-create-subject');
var ticketCreateDescription = document.getElementById('ticket-create-description');
var clientEditModal = document.getElementById('client-edit-modal');
var clientEditForm = document.getElementById('client-edit-form');
var clientEditClose = document.getElementById('client-edit-close');
var clientEditCancel = document.getElementById('client-edit-cancel');
var clientEditSubmit = document.getElementById('client-edit-submit');
var clientEditError = document.getElementById('client-edit-error');
var clientEditLoading = document.getElementById('client-edit-loading');
var clientEditProfile = document.getElementById('client-edit-profile');
var clientEditFirms = document.getElementById('client-edit-firms');
var clientEditName = document.getElementById('client-edit-name');
var clientEditPhone = document.getElementById('client-edit-phone');
var clientEditEmail = document.getElementById('client-edit-email');
var clientEditExternalId = document.getElementById('client-edit-external-id');
var clientEditDescription = document.getElementById('client-edit-description');
var clientLinkedFirms = document.getElementById('client-linked-firms');
var clientLinkedFirmsEmpty = document.getElementById('client-linked-firms-empty');
var clientFirmSearch = document.getElementById('client-firm-search');
var clientFirmSearchBtn = document.getElementById('client-firm-search-btn');
var clientFirmSearchStatus = document.getElementById('client-firm-search-status');
var clientFirmSearchResults = document.getElementById('client-firm-search-results');
var firmDetailModal = document.getElementById('firm-detail-modal');
var firmDetailClose = document.getElementById('firm-detail-close');
var firmDetailCancel = document.getElementById('firm-detail-cancel');
var firmDetailError = document.getElementById('firm-detail-error');
var firmDetailLoading = document.getElementById('firm-detail-loading');
var firmDetailMessage = document.getElementById('firm-detail-message');
var firmDetailTitle = document.getElementById('firm-detail-title');
var firmDetailTrigger = null;
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
    }
    catch (error) {
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
    if (event.key !== 'Enter')
        return;
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
    }
    catch (error) {
        showCreateTicketError(error.message);
        setCreateTicketBusy(false);
    }
});
recordingModalClose.addEventListener('click', closeRecordingModal);
recordingModal.addEventListener('click', (event) => {
    if (event.target === recordingModal)
        closeRecordingModal();
});
clientEditClose.addEventListener('click', closeClientEditModal);
clientEditCancel.addEventListener('click', closeClientEditModal);
clientEditModal.addEventListener('click', (event) => {
    if (event.target === clientEditModal)
        closeClientEditModal();
});
clientFirmSearchBtn.addEventListener('click', () => {
    searchClientFirms().catch((error) => showClientEditError(error.message));
});
clientFirmSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter')
        return;
    event.preventDefault();
    searchClientFirms().catch((error) => showClientEditError(error.message));
});
clientEditForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEditClients || !editingClientId || clientEditBusy)
        return;
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
    }
    catch (error) {
        showClientEditError(error.message);
    }
    finally {
        setClientEditBusy(false);
    }
});
firmDetailClose.addEventListener('click', closeFirmDetailModal);
firmDetailCancel.addEventListener('click', closeFirmDetailModal);
firmDetailModal.addEventListener('click', (event) => {
    if (event.target === firmDetailModal)
        closeFirmDetailModal();
});
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape')
        return;
    if (!firmDetailModal.hidden)
        closeFirmDetailModal();
    else if (!createOrderModal.hidden)
        closeCreateOrderModal();
    else if (!clientEditModal.hidden)
        closeClientEditModal();
    else if (!createTicketModal.hidden)
        closeCreateTicketModal();
    else if (!recordingModal.hidden)
        closeRecordingModal();
});
createOrderCancel.addEventListener('click', () => closeCreateOrderModal());
createOrderClose.addEventListener('click', () => closeCreateOrderModal());
createOrderModal.addEventListener('click', (event) => {
    if (event.target === createOrderModal)
        closeCreateOrderModal();
});
firmSearchBtn.addEventListener('click', () => {
    triggerOrderFirmSearchNow();
});
firmSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        triggerOrderFirmSearchNow();
    }
});
createOrderForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeTicket || createOrderBusy)
        return;
    showCreateOrderError('');
    showSuccess('');
    setCreateOrderBusy(true);
    try {
        const payload = {
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
        }
        else {
            payload.client_name = activeTicket.client?.name || undefined;
        }
        const data = await api('/bot-admin/api/orders', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        const payUrl = data.payment_page_url;
        closeCreateOrderModal({ force: true });
        showSuccess(payUrl
            ? `Заказ ${data.order.id} создан. Страница оплаты: ${payUrl}`
            : `Заказ ${data.order.id} создан.`);
        await loadTickets().catch((error) => showError(error.message));
    }
    catch (error) {
        showCreateOrderError(error.message);
        setCreateOrderBusy(false);
    }
});
setupLogout();
init().catch((error) => {
    document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
