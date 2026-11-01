declare function openCreateOrderModal(...args: any[]): any;
declare function openEditTicketModal(...args: any[]): any;
declare function closeEditTicketModal(...args: any[]): any;
declare function closeCreateOrderModal(...args: any[]): any;
declare function setTicketView(...args: any[]): any;
declare function loadChatMessages(...args: any[]): any;
declare function setChatStatus(...args: any[]): any;
declare function loadOlderChatMessages(...args: any[]): any;
declare function sendChatMessage(...args: any[]): any;
declare function isChatImage(...args: any[]): any;
declare function addPendingChatFiles(...args: any[]): any;
declare function removePendingChatFile(...args: any[]): any;
declare function setChatDropActive(...args: any[]): any;
declare function filesFromDataTransfer(...args: any[]): any;
declare function refreshChatTail(...args: any[]): any;
declare function showEditTicketError(...args: any[]): any;
declare function setEditTicketBusy(...args: any[]): any;
declare function renderTicket(...args: any[]): any;
declare function showSuccess(...args: any[]): any;
declare function triggerFirmSearchNow(...args: any[]): any;
declare function showModalError(...args: any[]): any;
declare function setCreateOrderBusy(...args: any[]): any;
declare function updateEditTicketToggleVisibility(...args: any[]): any;
declare function parseTicketIdFromPath(...args: any[]): any;
declare function showError(...args: any[]): any;
declare function loadUsers(...args: any[]): any;
declare function loadTicket(...args: any[]): any;
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

var ticket: any = null;
var userNames: any = {};
var ticketUsers: any[] = [];
var selectedFirm: any = null;
var linkedClientFirms: any[] = [];
var ticketDefaultPhone = '';
var createOrderBusy = false;
var chatMessages: any[] = [];
var chatOffset = 0;
var chatTotal = 0;
var chatHasOlder = false;
var chatPollTimer: any = null;
var chatRequestId = 0;
var currentTicketId: any = null;
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

var pendingChatFiles: any[] = [];
var pendingChatFileSeq = 0;

var ticketTitleEl = (document.getElementById('ticket-title') as any);
var ticketSubtitleEl = (document.getElementById('ticket-subtitle') as any);
var ticketErrorEl = (document.getElementById('ticket-error') as any);
var ticketSuccessEl = (document.getElementById('ticket-success') as any);
var ticketWorkspace = (document.getElementById('ticket-workspace') as any);
var ticketViewTabs = (document.getElementById('ticket-view-tabs') as any);
var ticketDetailCard = (document.getElementById('ticket-detail-card') as any);
var ticketDetailBody = (document.getElementById('ticket-detail-body') as any);
var ticketChatCard = (document.getElementById('ticket-chat-card') as any);
var ticketChatMessagesEl = (document.getElementById('ticket-chat-messages') as any);
var ticketChatStatusEl = (document.getElementById('ticket-chat-status') as any);
var ticketChatRefreshBtn = (document.getElementById('ticket-chat-refresh') as any);
var ticketChatLoadOlderWrap = (document.getElementById('ticket-chat-load-older-wrap') as any);
var ticketChatLoadOlderBtn = (document.getElementById('ticket-chat-load-older') as any);
var ticketChatCompose = (document.getElementById('ticket-chat-compose') as any);
var ticketChatPendingEl = (document.getElementById('ticket-chat-pending') as any);
var ticketChatInput = (document.getElementById('ticket-chat-input') as any);
var ticketChatFileInput = (document.getElementById('ticket-chat-file') as any);
var ticketChatAttachBtn = (document.getElementById('ticket-chat-attach') as any);
var ticketChatSendBtn = (document.getElementById('ticket-chat-send') as any);
var createOrderModal = (document.getElementById('create-order-modal') as any);
var createOrderForm = (document.getElementById('create-order-form') as any);
var createOrderToggle = (document.getElementById('create-order-toggle') as any);
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
var editTicketToggle = (document.getElementById('edit-ticket-toggle') as any);
var editTicketModal = (document.getElementById('edit-ticket-modal') as any);
var editTicketForm = (document.getElementById('edit-ticket-form') as any);
var editTicketClose = (document.getElementById('edit-ticket-close') as any);
var editTicketCancel = (document.getElementById('edit-ticket-cancel') as any);
var editTicketSubmit = (document.getElementById('edit-ticket-submit') as any);
var editTicketError = (document.getElementById('edit-ticket-error') as any);
var editTicketSubject = (document.getElementById('edit-ticket-subject') as any);
var editTicketDirection = (document.getElementById('edit-ticket-direction') as any);
var editTicketStatus = (document.getElementById('edit-ticket-status') as any);
var editTicketResponsible = (document.getElementById('edit-ticket-responsible') as any);
var editTicketDescription = (document.getElementById('edit-ticket-description') as any);





createOrderToggle.addEventListener('click', openCreateOrderModal);
editTicketToggle.addEventListener('click', openEditTicketModal);
editTicketCancel.addEventListener('click', closeEditTicketModal);
editTicketClose.addEventListener('click', closeEditTicketModal);
createOrderCancel.addEventListener('click', closeCreateOrderModal);
createOrderClose.addEventListener('click', closeCreateOrderModal);
ticketViewTabs.querySelectorAll('.role-tab').forEach((tab: any) => {
  tab.addEventListener('click', () => {
    setTicketView(tab.dataset.view);
  });
});
ticketChatRefreshBtn.addEventListener('click', () => {
  if (currentTicketId == null) return;
  loadChatMessages(currentTicketId).catch((error: any) => {
    setChatStatus(error.message || 'Не удалось обновить чат.', { isError: true });
  });
});
ticketChatLoadOlderBtn.addEventListener('click', () => {
  if (currentTicketId == null) return;
  loadOlderChatMessages(currentTicketId).catch((error: any) => {
    setChatStatus(error.message || 'Не удалось загрузить сообщения.', { isError: true });
  });
});
ticketChatCompose.addEventListener('submit', (event: any) => {
  event.preventDefault();
  if (currentTicketId == null || ticketChatSendBtn.disabled) return;
  sendChatMessage(currentTicketId).catch((error: any) => {
    setChatStatus(error.message || 'Не удалось отправить сообщение.', { isError: true });
  });
});
ticketChatInput.addEventListener('keydown', (event: any) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (currentTicketId == null || ticketChatSendBtn.disabled) return;
  ticketChatCompose.requestSubmit();
});
ticketChatInput.addEventListener('paste', (event: any) => {
  const files = [...(event.clipboardData?.files || [])].filter((file: any) => isChatImage(file));
  if (!files.length) return;
  event.preventDefault();
  addPendingChatFiles(files);
});
ticketChatAttachBtn?.addEventListener('click', () => {
  if (ticketChatFileInput?.disabled) return;
  ticketChatFileInput.click();
});
ticketChatFileInput?.addEventListener('change', () => {
  addPendingChatFiles(ticketChatFileInput.files);
  ticketChatFileInput.value = '';
});
ticketChatPendingEl?.addEventListener('click', (event: any) => {
  const button = event.target.closest('[data-pending-id]');
  if (!button) return;
  removePendingChatFile(button.dataset.pendingId);
});

function isFileDrag(event: any) {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return [...types].includes('Files');
}

function handleChatDragEnter(event: any) {
  if (!isFileDrag(event) || ticketChatCompose.hidden) return;
  event.preventDefault();
  setChatDropActive(true);
}

function handleChatDragOver(event: any) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (ticketChatCompose.hidden) return;
  event.dataTransfer.dropEffect = 'copy';
}

function handleChatDragLeave(event: any) {
  if (!isFileDrag(event)) return;
  const next = event.relatedTarget;
  if (next && ticketChatCard.contains(next)) return;
  setChatDropActive(false);
}

function handleChatDrop(event: any) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  setChatDropActive(false);
  if (ticketChatCompose.hidden) return;
  addPendingChatFiles(filesFromDataTransfer(event.dataTransfer));
}

ticketChatCard.addEventListener('dragenter', handleChatDragEnter);
ticketChatCard.addEventListener('dragover', handleChatDragOver);
ticketChatCard.addEventListener('dragleave', handleChatDragLeave);
ticketChatCard.addEventListener('drop', handleChatDrop);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTicketId != null && ticket?.chat_id) {
    refreshChatTail(currentTicketId).catch(() => {});
  }
});
document.addEventListener('keydown', (event: any) => {
  if (event.key !== 'Escape') return;
  if (!editTicketModal.hidden) closeEditTicketModal();
  else if (!createOrderModal.hidden) closeCreateOrderModal();
});

editTicketForm.addEventListener('submit', async (event: any) => {
  event.preventDefault();
  if (!ticket || editTicketBusy) return;
  showEditTicketError('');
  setEditTicketBusy(true);
  const payload: any = {
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
  } catch (error: any) {
    showEditTicketError(error.message);
    setEditTicketBusy(false);
  }
});

firmSearchBtn.addEventListener('click', () => {
  triggerFirmSearchNow();
});
firmSearchInput.addEventListener('keydown', (event: any) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    triggerFirmSearchNow();
  }
});

createOrderForm.addEventListener('submit', async (event: any) => {
  event.preventDefault();
  if (createOrderBusy) return;
  showModalError('');
  showSuccess('');
  setCreateOrderBusy(true);
  try {
    const payload: any = {
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
  } catch (error: any) {
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
init().catch((error: any) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
