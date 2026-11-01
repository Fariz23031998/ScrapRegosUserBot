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
var ticket = null;
var userNames = {};
var ticketUsers = [];
var selectedFirm = null;
var linkedClientFirms = [];
var ticketDefaultPhone = '';
var createOrderBusy = false;
var chatMessages = [];
var chatOffset = 0;
var chatTotal = 0;
var chatHasOlder = false;
var chatPollTimer = null;
var chatRequestId = 0;
var currentTicketId = null;
var editTicketBusy = false;
var canEditTickets = false;
var canEditClosedTickets = false;
var CHAT_PAGE_LIMIT = 50;
var CHAT_POLL_MS = 18000;
var MAX_CHAT_FILES = 5;
var MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
var IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
var AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'm4a', 'aac', 'opus', 'oga', 'weba']);
var VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv']);
var pendingChatFiles = [];
var pendingChatFileSeq = 0;
var ticketTitleEl = document.getElementById('ticket-title');
var ticketSubtitleEl = document.getElementById('ticket-subtitle');
var ticketErrorEl = document.getElementById('ticket-error');
var ticketSuccessEl = document.getElementById('ticket-success');
var ticketWorkspace = document.getElementById('ticket-workspace');
var ticketViewTabs = document.getElementById('ticket-view-tabs');
var ticketDetailCard = document.getElementById('ticket-detail-card');
var ticketDetailBody = document.getElementById('ticket-detail-body');
var ticketChatCard = document.getElementById('ticket-chat-card');
var ticketChatMessagesEl = document.getElementById('ticket-chat-messages');
var ticketChatStatusEl = document.getElementById('ticket-chat-status');
var ticketChatRefreshBtn = document.getElementById('ticket-chat-refresh');
var ticketChatLoadOlderWrap = document.getElementById('ticket-chat-load-older-wrap');
var ticketChatLoadOlderBtn = document.getElementById('ticket-chat-load-older');
var ticketChatCompose = document.getElementById('ticket-chat-compose');
var ticketChatPendingEl = document.getElementById('ticket-chat-pending');
var ticketChatInput = document.getElementById('ticket-chat-input');
var ticketChatFileInput = document.getElementById('ticket-chat-file');
var ticketChatAttachBtn = document.getElementById('ticket-chat-attach');
var ticketChatSendBtn = document.getElementById('ticket-chat-send');
var createOrderModal = document.getElementById('create-order-modal');
var createOrderForm = document.getElementById('create-order-form');
var createOrderToggle = document.getElementById('create-order-toggle');
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
var editTicketToggle = document.getElementById('edit-ticket-toggle');
var editTicketModal = document.getElementById('edit-ticket-modal');
var editTicketForm = document.getElementById('edit-ticket-form');
var editTicketClose = document.getElementById('edit-ticket-close');
var editTicketCancel = document.getElementById('edit-ticket-cancel');
var editTicketSubmit = document.getElementById('edit-ticket-submit');
var editTicketError = document.getElementById('edit-ticket-error');
var editTicketSubject = document.getElementById('edit-ticket-subject');
var editTicketDirection = document.getElementById('edit-ticket-direction');
var editTicketStatus = document.getElementById('edit-ticket-status');
var editTicketResponsible = document.getElementById('edit-ticket-responsible');
var editTicketDescription = document.getElementById('edit-ticket-description');
createOrderToggle.addEventListener('click', openCreateOrderModal);
editTicketToggle.addEventListener('click', openEditTicketModal);
editTicketCancel.addEventListener('click', closeEditTicketModal);
editTicketClose.addEventListener('click', closeEditTicketModal);
createOrderCancel.addEventListener('click', closeCreateOrderModal);
createOrderClose.addEventListener('click', closeCreateOrderModal);
ticketViewTabs.querySelectorAll('.role-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        setTicketView(tab.dataset.view);
    });
});
ticketChatRefreshBtn.addEventListener('click', () => {
    if (currentTicketId == null)
        return;
    loadChatMessages(currentTicketId).catch((error) => {
        setChatStatus(error.message || 'Не удалось обновить чат.', { isError: true });
    });
});
ticketChatLoadOlderBtn.addEventListener('click', () => {
    if (currentTicketId == null)
        return;
    loadOlderChatMessages(currentTicketId).catch((error) => {
        setChatStatus(error.message || 'Не удалось загрузить сообщения.', { isError: true });
    });
});
ticketChatCompose.addEventListener('submit', (event) => {
    event.preventDefault();
    if (currentTicketId == null || ticketChatSendBtn.disabled)
        return;
    sendChatMessage(currentTicketId).catch((error) => {
        setChatStatus(error.message || 'Не удалось отправить сообщение.', { isError: true });
    });
});
ticketChatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey)
        return;
    event.preventDefault();
    if (currentTicketId == null || ticketChatSendBtn.disabled)
        return;
    ticketChatCompose.requestSubmit();
});
ticketChatInput.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => isChatImage(file));
    if (!files.length)
        return;
    event.preventDefault();
    addPendingChatFiles(files);
});
ticketChatAttachBtn?.addEventListener('click', () => {
    if (ticketChatFileInput?.disabled)
        return;
    ticketChatFileInput.click();
});
ticketChatFileInput?.addEventListener('change', () => {
    addPendingChatFiles(ticketChatFileInput.files);
    ticketChatFileInput.value = '';
});
ticketChatPendingEl?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pending-id]');
    if (!button)
        return;
    removePendingChatFile(button.dataset.pendingId);
});
function isFileDrag(event) {
    const types = event.dataTransfer?.types;
    if (!types)
        return false;
    return [...types].includes('Files');
}
function handleChatDragEnter(event) {
    if (!isFileDrag(event) || ticketChatCompose.hidden)
        return;
    event.preventDefault();
    setChatDropActive(true);
}
function handleChatDragOver(event) {
    if (!isFileDrag(event))
        return;
    event.preventDefault();
    if (ticketChatCompose.hidden)
        return;
    event.dataTransfer.dropEffect = 'copy';
}
function handleChatDragLeave(event) {
    if (!isFileDrag(event))
        return;
    const next = event.relatedTarget;
    if (next && ticketChatCard.contains(next))
        return;
    setChatDropActive(false);
}
function handleChatDrop(event) {
    if (!isFileDrag(event))
        return;
    event.preventDefault();
    setChatDropActive(false);
    if (ticketChatCompose.hidden)
        return;
    addPendingChatFiles(filesFromDataTransfer(event.dataTransfer));
}
ticketChatCard.addEventListener('dragenter', handleChatDragEnter);
ticketChatCard.addEventListener('dragover', handleChatDragOver);
ticketChatCard.addEventListener('dragleave', handleChatDragLeave);
ticketChatCard.addEventListener('drop', handleChatDrop);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentTicketId != null && ticket?.chat_id) {
        refreshChatTail(currentTicketId).catch(() => { });
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape')
        return;
    if (!editTicketModal.hidden)
        closeEditTicketModal();
    else if (!createOrderModal.hidden)
        closeCreateOrderModal();
});
editTicketForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ticket || editTicketBusy)
        return;
    showEditTicketError('');
    setEditTicketBusy(true);
    const payload = {
        subject: editTicketSubject.value.trim(),
        description: editTicketDescription.value.trim(),
        direction: editTicketDirection.value,
        status: editTicketStatus.value,
    };
    if (editTicketResponsible.value) {
        payload.responsible_user_id = Number(editTicketResponsible.value);
    }
    try {
        const data = await api(`/bot-admin/api/tickets/${encodeURIComponent(ticket.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });
        renderTicket(data.ticket);
        closeEditTicketModal({ force: true });
        showSuccess('Тикет обновлён.');
    }
    catch (error) {
        showEditTicketError(error.message);
        setEditTicketBusy(false);
    }
});
firmSearchBtn.addEventListener('click', () => {
    triggerFirmSearchNow();
});
firmSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        triggerFirmSearchNow();
    }
});
createOrderForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (createOrderBusy)
        return;
    showModalError('');
    showSuccess('');
    setCreateOrderBusy(true);
    try {
        const payload = {
            amount: orderAmountInput.value,
            client_phone: orderClientPhoneInput.value.trim(),
            additional_phone: orderAdditionalPhoneInput.value.trim() || undefined,
            ticket_id: ticket?.id,
            client_id: ticket?.client_id ?? ticket?.client?.id,
        };
        if (selectedFirm) {
            payload.client_name = selectedFirm.clientName || undefined;
            payload.client_type = selectedFirm.type || undefined;
            payload.record_id = selectedFirm.recordId ?? undefined;
            payload.firm_message = selectedFirm.message || undefined;
            payload.firm_phone = selectedFirm.phone || undefined;
        }
        else {
            payload.client_name = ticket?.client?.name || undefined;
        }
        const data = await api('/bot-admin/api/orders', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        const payUrl = data.payment_page_url;
        showSuccess(payUrl
            ? `Заказ ${data.order.id} создан. Страница оплаты: ${payUrl}`
            : `Заказ ${data.order.id} создан.`);
        closeCreateOrderModal({ force: true });
    }
    catch (error) {
        showModalError(error.message);
        setCreateOrderBusy(false);
    }
});
async function init() {
    const session = await ensureSession({ requiredPermission: 'tickets_read' });
    canEditTickets = hasPermission(session, 'tickets_edit');
    canEditClosedTickets = hasPermission(session, 'tickets_edit_closed');
    updateEditTicketToggleVisibility();
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
