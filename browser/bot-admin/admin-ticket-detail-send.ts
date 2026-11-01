declare var ticketChatLoadOlderWrap: any, chatHasOlder: any, ticketChatMessagesEl: any, chatMessages: any;
declare function renderChatMessage(...args: any[]): any;
declare var chatPollTimer: any, CHAT_POLL_MS: any, CHAT_PAGE_LIMIT: any, chatRequestId: any;
declare function setChatStatus(...args: any[]): any;
declare function showTicketWorkspace(...args: any[]): any;
declare var ticketChatRefreshBtn: any, ticketChatLoadOlderBtn: any, chatOffset: any, chatTotal: any;
declare function setChatComposerEnabled(...args: any[]): any;
declare var ticket: any, ticketChatInput: any, pendingChatFiles: any, ticketChatSendBtn: any, ticketChatAttachBtn: any, ticketChatFileInput: any;
declare function fileExtension(...args: any[]): any;
declare function fileToBase64(...args: any[]): any;
declare function clearPendingChatFiles(...args: any[]): any;
declare var currentTicketId: any, ticketTitleEl: any, ticketDetailBody: any;
declare function renderTicket(...args: any[]): any;
declare function loadLinkedClientFirms(...args: any[]): any;
function updateLoadOlderVisibility() {
  ticketChatLoadOlderWrap.hidden = !chatHasOlder;
}

function upgradeChatMediaProbes() {
  if (!ticketChatMessagesEl) return;
  ticketChatMessagesEl.querySelectorAll('.ticket-chat__media--probe').forEach((container: any) => {
    if (container.dataset.probeReady === '1') return;
    container.dataset.probeReady = '1';
    const url = container.dataset.url || '';
    const name = container.dataset.name || 'файл';
    const img = container.querySelector('.ticket-chat__media-probe');
    if (!img || !url) return;

    img.addEventListener(
      'error',
      () => {
        container.classList.remove('ticket-chat__media--probe');
        container.classList.add('ticket-chat__media--video');
        container.innerHTML = `<video class="ticket-chat__video" controls preload="metadata" playsinline src="${escapeHtml(url)}"></video>
          <a class="ticket-chat__media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`;
        const video = container.querySelector('video');
        video?.addEventListener(
          'error',
          () => {
            container.classList.remove('ticket-chat__media--video');
            container.classList.add('ticket-chat__media--audio');
            container.innerHTML = `<audio class="ticket-chat__audio" controls preload="metadata" src="${escapeHtml(url)}"></audio>
              <a class="ticket-chat__media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`;
            const audio = container.querySelector('audio');
            audio?.addEventListener(
              'error',
              () => {
                container.innerHTML = `<a class="ticket-chat__file-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`;
              },
              { once: true }
            );
          },
          { once: true }
        );
      },
      { once: true }
    );
  });
}

function renderChatMessages({ stickToBottom = false }: any = {}) {
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
  upgradeChatMediaProbes();

  if (stickToBottom || wasNearBottom) {
    ticketChatMessagesEl.scrollTop = ticketChatMessagesEl.scrollHeight;
  } else if (previousHeight > 0) {
    ticketChatMessagesEl.scrollTop =
      ticketChatMessagesEl.scrollHeight - previousHeight + previousTop;
  }
}

function mergeMessages(existing: any, incoming: any, { prepend = false }: any = {}) {
  const byId = new Map();
  const ordered = prepend ? [...incoming, ...existing] : [...existing, ...incoming];
  for (const message of ordered) {
    if (!message?.id) continue;
    byId.set(String(message.id), message);
  }
  return [...byId.values()].sort((a: any, b: any) => {
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

function startChatPolling(ticketId: any) {
  stopChatPolling();
  chatPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshChatTail(ticketId).catch(() => {});
  }, CHAT_POLL_MS);
}

async function fetchChatPage(ticketId: any, { limit = CHAT_PAGE_LIMIT, offset, fromEnd = false }: any = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (fromEnd) {
    params.set('from_end', '1');
  } else if (offset != null) {
    params.set('offset', String(offset));
  }
  return api(`/bot-admin/api/tickets/${ticketId}/messages?${params.toString()}`);
}

async function loadChatMessages(ticketId: any, { silent = false }: any = {}) {
  const requestId = ++chatRequestId;
  if (!silent) {
    setChatStatus('Загрузка сообщений…', { loading: true });
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
    chatOffset = data.next_offset ?? (data.offset || 0) + chatMessages.length;
    chatTotal = data.total || chatMessages.length;
    chatHasOlder = Boolean(data.has_older);
    setChatComposerEnabled(true);
    renderChatMessages({ stickToBottom: true });
    setChatStatus(
      chatTotal > 0 ? `Сообщений: ${chatMessages.length} из ${chatTotal}` : ''
    );
    startChatPolling(ticketId);
  } catch (error: any) {
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

async function loadOlderChatMessages(ticketId: any) {
  if (!chatHasOlder || chatOffset <= 0) return;
  const requestId = ++chatRequestId;
  const prevScrollHeight = ticketChatMessagesEl.scrollHeight;
  const prevScrollTop = ticketChatMessagesEl.scrollTop;
  ticketChatLoadOlderBtn.disabled = true;
  setChatStatus('Загрузка предыдущих сообщений…', { loading: true });

  try {
    const data = await fetchChatPage(ticketId, { limit: CHAT_PAGE_LIMIT, offset: chatOffset });
    if (requestId !== chatRequestId) return;

    const page = data.messages || [];
    chatMessages = mergeMessages(chatMessages, page, { prepend: true });
    chatOffset = data.next_offset ?? chatOffset + page.length;
    chatTotal = data.total ?? chatTotal;
    chatHasOlder = Boolean(data.has_older);
    renderChatMessages();
    ticketChatMessagesEl.scrollTop =
      ticketChatMessagesEl.scrollHeight - prevScrollHeight + prevScrollTop;
    setChatStatus(`Сообщений: ${chatMessages.length} из ${chatTotal}`);
  } catch (error: any) {
    if (requestId !== chatRequestId) return;
    setChatStatus(error.message || 'Не удалось загрузить сообщения.', { isError: true });
  } finally {
    if (requestId === chatRequestId) {
      ticketChatLoadOlderBtn.disabled = false;
    }
  }
}

async function refreshChatTail(ticketId: any) {
  if (!ticket?.chat_id) return;
  const data = await fetchChatPage(ticketId, { fromEnd: true, limit: CHAT_PAGE_LIMIT });
  if (!data.chat_id) return;

  const incoming = data.messages || [];
  const knownIds = new Set(chatMessages.map((m: any) => String(m.id)));
  const newCount = incoming.filter((m: any) => m?.id && !knownIds.has(String(m.id))).length;
  if (!newCount && incoming.length <= chatMessages.length) {
    chatTotal = data.total ?? chatTotal;
    return;
  }

  // Keep older messages that were already loaded; merge the latest page.
  chatMessages = mergeMessages(chatMessages, incoming);
  chatTotal = data.total ?? chatTotal;
  chatOffset += newCount;
  chatHasOlder = chatTotal > 0 ? chatOffset < chatTotal : chatHasOlder;
  renderChatMessages({ stickToBottom: true });
  setChatStatus(chatTotal > 0 ? `Сообщений: ${chatMessages.length} из ${chatTotal}` : '');
}

async function sendChatMessage(ticketId: any) {
  const text = ticketChatInput.value.trim();
  if (!text && !pendingChatFiles.length) {
    setChatStatus('Введите текст сообщения или прикрепите файл.', { isError: true });
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
  if (ticketChatAttachBtn) ticketChatAttachBtn.disabled = true;
  if (ticketChatFileInput) ticketChatFileInput.disabled = true;
  setButtonLoading(ticketChatSendBtn, true);
  setChatStatus('Отправка…', { loading: true });

  try {
    const files = await Promise.all(
      pendingChatFiles.map(async (item: any) => ({
        name: item.file.name,
        extension: fileExtension(item.file.name),
        data: await fileToBase64(item.file),
      }))
    );
    await api(`/bot-admin/api/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, files }),
    });
    ticketChatInput.value = '';
    clearPendingChatFiles();
    await refreshChatTail(ticketId);
    setChatStatus(chatTotal > 0 ? `Сообщений: ${chatMessages.length} из ${chatTotal}` : '');
  } catch (error: any) {
    setChatStatus(error.message || 'Не удалось отправить сообщение.', { isError: true });
  } finally {
    const canSend = Boolean(ticket?.chat_id);
    ticketChatInput.disabled = !canSend;
    if (ticketChatFileInput) ticketChatFileInput.disabled = !canSend;
    if (ticketChatAttachBtn) ticketChatAttachBtn.disabled = !canSend;
    setButtonLoading(ticketChatSendBtn, false);
    ticketChatSendBtn.disabled = !canSend;
    if (canSend) {
      ticketChatInput.focus();
    }
  }
}

async function loadTicket(ticketId: any) {
  currentTicketId = ticketId;
  ticketTitleEl.textContent = 'Тикет';
  ticketDetailBody.innerHTML = renderLoadingState();
  ticketChatMessagesEl.innerHTML = renderLoadingState('Загрузка сообщений…');
  showTicketWorkspace();
  const data = await api(`/bot-admin/api/tickets/${ticketId}`);
  renderTicket(data.ticket);
  await Promise.all([
    loadChatMessages(ticketId),
    loadLinkedClientFirms(data.ticket?.client_id ?? data.ticket?.client?.id),
  ]);
}
