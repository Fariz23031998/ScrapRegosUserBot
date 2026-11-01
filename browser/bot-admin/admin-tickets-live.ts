declare var ticketUsers: any, userNames: any, userSelect: any, userFilter: any, ticketCreateResponsible: any, ticketChannels: any, channelNames: any, channelSelect: any, channelFilter: any, ticketCreateChannel: any;
declare function showError(...args: any[]): any;
declare var summaryCalculationGeneration: any, ticketsWrap: any, currentPage: any, pageLimit: any, ticketsPaginationEl: any, searchQuery: any, statusFilter: any, minimumCallDuration: any;
declare function datetimeLocalToUnix(...args: any[]): any;
declare var dateFrom: any, dateTo: any, withoutDuplicates: any, duplicateIntervalMinutes: any, tickets: any, totalTickets: any, summary: any, summaryCalculating: any, activeTicket: any, activeTicketUserId: any, searchInput: any, searchClearBtn: any, searchBox: any;
declare function renderSummary(...args: any[]): any;
declare function renderActiveTicket(...args: any[]): any;
declare function renderTicketsTable(...args: any[]): any;
declare var realtimeTicketsRefreshInFlight: any, realtimeTicketsRefreshPending: any, realtimeTicketsRefreshTimer: any, ticketEventsPaused: any, ticketEventsReconnectTimer: any, ticketEventsReconnectAttempt: any, ticketEvents: any, ticketEventsReady: any;
async function loadUsers({ preferredUserId = undefined }: any = {}) {
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
        (user: any) =>
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
        (user: any) =>
          `<option value="${escapeHtml(user.id)}">${escapeHtml(
            user.full_name || user.login || `Пользователь #${user.id}`
          )}</option>`
      )
      .join('');
}

async function loadChannels({ preferredChannelId = undefined }: any = {}) {
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
          (channel: any) =>
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
          (channel: any) =>
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

async function loadTickets({ silent = false }: any = {}) {
  showError('');
  const summaryGeneration = ++summaryCalculationGeneration;
  if (!silent) {
    ticketsWrap.innerHTML = renderLoadingState();
  }
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
  const embeddedSummary = data.summary || null;
  if (embeddedSummary) {
    summary = embeddedSummary;
    summaryCalculating = false;
  } else {
    summaryCalculating = true;
  }
  activeTicket = data.active_ticket || null;
  activeTicketUserId =
    data.active_ticket_user_id != null ? Number(data.active_ticket_user_id) : null;

  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderActiveTicket();
  renderTicketsTable();
  renderTicketsPagination();
  renderSummary();

  if (!embeddedSummary) {
    const generation = summaryGeneration;
    api(`/bot-admin/api/tickets/summary?${params.toString()}`)
      .then((summaryData: any) => {
        if (generation !== summaryCalculationGeneration) return;
        summary = summaryData.summary || { count: totalTickets, slaBreached: 0, rated: 0 };
        summaryCalculating = false;
        renderSummary();
      })
      .catch((error: any) => {
        if (generation !== summaryCalculationGeneration) return;
        console.warn('Не удалось рассчитать итоги по тикетам:', error);
        summary = { count: totalTickets, slaBreached: 0, rated: 0 };
        summaryCalculating = false;
        renderSummary();
      });
  }
}

async function runRealtimeTicketsRefresh() {
  if (realtimeTicketsRefreshInFlight || !realtimeTicketsRefreshPending) return;
  realtimeTicketsRefreshPending = false;
  realtimeTicketsRefreshInFlight = true;
  try {
    await loadTickets({ silent: true });
  } catch (error: any) {
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

function handleTicketEvent(event: any) {
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
  source.onmessage = (message: any) => {
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

function renderTicketsPagination() {
  renderPagination(
    ticketsPaginationEl,
    { page: currentPage, limit: pageLimit, total: totalTickets },
    {
      onPageChange: (page: any) => {
        currentPage = page;
        loadTickets().catch((error: any) => showError(error.message));
      },
      onLimitChange: (limit: any) => {
        pageLimit = limit;
        currentPage = 1;
        loadTickets().catch((error: any) => showError(error.message));
      },
    }
  );
}
