declare var ticketsErrorEl: any, ticketsSuccessEl: any, createOrderErrorEl: any, firmSearchInput: any, firmSearchStatus: any, firmSearchResults: any, orderSelectedFirm: any, firmSelectedEl: any;
declare function firmTypeLabel(...args: any[]): any;
declare var orderClientPhoneInput: any, orderTicketDefaultPhone: any, orderLinkedClientFirms: any, orderFirmSearchRequestId: any, firmSearchBtn: any, createOrderForm: any, createOrderBusy: any, createOrderProgress: any, createOrderSubmit: any, createOrderCancel: any, createOrderClose: any, activeTicket: any, createOrderModal: any, orderAmountInput: any, summaryCalculating: any, ticketsSummaryEl: any, summary: any, userFilter: any, sessionRegosUserId: any, activeTicketUserId: any, activeTicketEl: any;
declare function formatUnix(...args: any[]): any;
declare function renderUnpaidOrdersCell(...args: any[]): any;
declare function renderTechnicalSupportCell(...args: any[]): any;
declare var tickets: any, searchQuery: any, statusFilter: any, channelFilter: any, dateFrom: any, dateTo: any, ticketsWrap: any;
declare function renderClientCell(...args: any[]): any;
declare function renderFirmsCell(...args: any[]): any;
declare function channelLabel(...args: any[]): any;
declare function statusLabel(...args: any[]): any;
declare function directionLabel(...args: any[]): any;
declare function userLabel(...args: any[]): any;
declare function getRecordingUrl(...args: any[]): any;
declare function getCachedRecordingDuration(...args: any[]): any;
declare function formatCallDuration(...args: any[]): any;
declare function openRecordingModal(...args: any[]): any;
declare function openClientEditModal(...args: any[]): any;
declare function openFirmDetailModal(...args: any[]): any;
declare function loadVisibleCallDurations(...args: any[]): any;
declare var ticketsPaginationEl: any, currentPage: any, pageLimit: any, totalTickets: any;
declare function loadTickets(...args: any[]): any;
function showError(message: any) {
  if (!message) {
    ticketsErrorEl.hidden = true;
    ticketsErrorEl.textContent = '';
    return;
  }
  ticketsErrorEl.hidden = false;
  ticketsErrorEl.textContent = message;
}

function showSuccess(message: any) {
  if (!message) {
    ticketsSuccessEl.hidden = true;
    ticketsSuccessEl.textContent = '';
    return;
  }
  ticketsSuccessEl.hidden = false;
  ticketsSuccessEl.textContent = message;
}

function showCreateOrderError(message: any) {
  if (!message) {
    createOrderErrorEl.hidden = true;
    createOrderErrorEl.textContent = '';
    return;
  }
  createOrderErrorEl.hidden = false;
  createOrderErrorEl.textContent = message;
}

function clearOrderFirmSearchUi() {
  firmSearchInput.value = '';
  firmSearchStatus.hidden = true;
  firmSearchStatus.textContent = '';
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
}

function renderOrderSelectedFirm() {
  if (!orderSelectedFirm) {
    firmSelectedEl.hidden = true;
    firmSelectedEl.innerHTML = '';
    return;
  }

  firmSelectedEl.hidden = false;
  firmSelectedEl.innerHTML = `
    <div class="firm-selected__body">
      <strong>${escapeHtml(orderSelectedFirm.clientName || 'Без названия')}</strong>
      <span>${escapeHtml(firmTypeLabel(orderSelectedFirm.type))}${
        orderSelectedFirm.phone ? ` · ${escapeHtml(orderSelectedFirm.phone)}` : ''
      }</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" id="firm-clear-btn">Сбросить</button>
  `;
  (document.getElementById('firm-clear-btn') as any)?.addEventListener('click', clearOrderSelectedFirm);
}

function clearOrderSelectedFirm() {
  orderSelectedFirm = null;
  renderOrderSelectedFirm();
  orderClientPhoneInput.value = orderTicketDefaultPhone;
}

function selectOrderFirm(firm: any) {
  orderSelectedFirm = firm;
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
  firmSearchStatus.hidden = true;
  renderOrderSelectedFirm();
  if (firm.phone) {
    orderClientPhoneInput.value = firm.phone;
  } else if (!orderClientPhoneInput.value.trim()) {
    orderClientPhoneInput.value = orderTicketDefaultPhone;
  }
}

function firmFromLinkedClient(link: any) {
  if (!link) return null;
  return {
    type: link.firm_type || null,
    recordId: link.firm_record_id ?? null,
    clientName: link.firm_name || null,
    phone: link.firm_phone || null,
    message: link.firm_message || null,
  };
}

function applyDefaultOrderLinkedFirm() {
  const firm = firmFromLinkedClient(orderLinkedClientFirms[0]);
  if (!firm) return;
  selectOrderFirm(firm);
}

async function loadOrderLinkedClientFirms(clientId: any) {
  orderLinkedClientFirms = [];
  const id = Number(clientId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(id)}`);
    orderLinkedClientFirms = Array.isArray(data.firms) ? data.firms : [];
  } catch {
    orderLinkedClientFirms = [];
  }
}

function renderOrderFirmResults(results: any) {
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
    .map((firm: any, index: any) => {
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

  firmSearchResults.querySelectorAll('.firm-search-result').forEach((btn: any) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.getAttribute('data-firm-index'));
      const firm = results[index];
      if (firm) selectOrderFirm(firm);
    });
  });
}

function clearOrderFirmSearchResults() {
  firmSearchStatus.hidden = true;
  firmSearchStatus.textContent = '';
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
}

async function runOrderFirmSearch() {
  const q = firmSearchInput.value.trim();
  if (!q) {
    clearOrderFirmSearchResults();
    return;
  }
  const requestId = ++orderFirmSearchRequestId;
  firmSearchBtn.disabled = true;
  firmSearchStatus.hidden = false;
  firmSearchStatus.textContent = 'Поиск…';
  try {
    const data = await api(`/bot-admin/api/firm-search?q=${encodeURIComponent(q)}`);
    if (requestId !== orderFirmSearchRequestId) return;
    renderOrderFirmResults(data.results || []);
  } catch (error: any) {
    if (requestId !== orderFirmSearchRequestId) return;
    firmSearchResults.hidden = true;
    firmSearchStatus.hidden = false;
    firmSearchStatus.textContent = error.message;
  } finally {
    if (requestId === orderFirmSearchRequestId) {
      firmSearchBtn.disabled = false;
    }
  }
}

function triggerOrderFirmSearchNow() {
  runOrderFirmSearch().catch((error: any) => {
    firmSearchStatus.hidden = false;
    firmSearchStatus.textContent = error.message;
  });
}

function resetCreateOrderForm() {
  orderFirmSearchRequestId += 1;
  createOrderForm.reset();
  orderSelectedFirm = null;
  clearOrderFirmSearchUi();
  renderOrderSelectedFirm();
  orderClientPhoneInput.value = orderTicketDefaultPhone;
  showCreateOrderError('');
}

function setCreateOrderBusy(busy: any) {
  createOrderBusy = Boolean(busy);
  createOrderProgress.hidden = !createOrderBusy;
  createOrderForm.setAttribute('aria-busy', createOrderBusy ? 'true' : 'false');
  createOrderSubmit.disabled = createOrderBusy;
  createOrderCancel.disabled = createOrderBusy;
  createOrderClose.disabled = createOrderBusy;
  createOrderSubmit.classList.toggle('is-loading', createOrderBusy);
  createOrderForm.querySelectorAll('input, button').forEach((el: any) => {
    if (el === createOrderSubmit || el === createOrderCancel || el === createOrderClose) return;
    el.disabled = createOrderBusy;
  });
}

async function openCreateOrderModal() {
  if (!activeTicket) return;
  orderTicketDefaultPhone = activeTicket.client?.phone || '';
  resetCreateOrderForm();
  setCreateOrderBusy(false);
  showError('');
  showSuccess('');
  createOrderModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  orderAmountInput.focus();
  await loadOrderLinkedClientFirms(activeTicket.client_id ?? activeTicket.client?.id);
  if (!createOrderModal.hidden && !createOrderBusy && !orderSelectedFirm) {
    applyDefaultOrderLinkedFirm();
  }
}

function closeCreateOrderModal({ force = false }: any = {}) {
  if (createOrderBusy && !force) return;
  setCreateOrderBusy(false);
  createOrderModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  resetCreateOrderForm();
  (document.getElementById('active-ticket-create-order') as any)?.focus();
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

function openTicketPage(ticketId: any) {
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
    <div class="active-ticket__extras">
      <span class="active-ticket__extra">
        <span class="active-ticket__extra-label">Неоплаченные:</span>
        ${renderUnpaidOrdersCell(activeTicket)}
      </span>
      <span class="active-ticket__extra">
        <span class="active-ticket__extra-label">ТП:</span>
        ${renderTechnicalSupportCell(activeTicket)}
      </span>
      <span class="active-ticket__actions">
        <button type="button" class="btn btn-primary btn-sm" id="active-ticket-create-order">
          Создать заказ
        </button>
      </span>
    </div>
  `;

  const openBtn = (document.getElementById('active-ticket-open') as any);
  if (openBtn) {
    openBtn.addEventListener('click', () => openTicketPage(activeTicket.id));
  }
  const createOrderBtn = (document.getElementById('active-ticket-create-order') as any);
  if (createOrderBtn) {
    createOrderBtn.addEventListener('click', () => {
      openCreateOrderModal().catch((error: any) => {
        showCreateOrderError(error.message || 'Не удалось открыть форму заказа.');
      });
    });
  }
}

function statusBadgeClass(status: any) {
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
          <th>Обновлён</th>
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
            (ticket: any, index: any) => `
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
            <td class="cell-nowrap" data-label="Обновлён">${escapeHtml(formatUnix(ticket.last_update))}</td>
            <td class="cell-nowrap" data-label="Создан">${escapeHtml(formatUnix(ticket.created_date))}</td>
            <td data-label="Ссылка на запись">${
              getRecordingUrl(ticket)
                ? `<button type="button" class="ticket-recording-open" data-recording-index="${index}" aria-label="Воспроизвести запись тикета №${escapeHtml(ticket.id)}">Воспроизвести</button>`
                : '—'
            }</td>
            <td class="cell-mono cell-nowrap" data-label="Длительность звонка" data-call-duration-index="${index}">${
              Number.isFinite(getCachedRecordingDuration(ticket))
                ? escapeHtml(formatCallDuration(getCachedRecordingDuration(ticket)))
                : '—'
            }</td>
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

  ticketsWrap.querySelectorAll('.tickets-table__row').forEach((row: any) => {
    const open = (event: any) => {
      if (event?.target.closest('button, a, input, select, textarea')) return;
      const id = Number(row.getAttribute('data-ticket-id'));
      openTicketPage(id);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event: any) => {
      if (event.target.closest('button, a, input, select, textarea')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(event);
      }
    });
  });

  ticketsWrap.querySelectorAll('.ticket-recording-open').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      const index = Number(button.getAttribute('data-recording-index'));
      const ticket = tickets[index];
      if (ticket) openRecordingModal(ticket, button);
    });
  });

  ticketsWrap.querySelectorAll('.ticket-client-open').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      const clientId = Number(button.getAttribute('data-client-id'));
      openClientEditModal(clientId, button).catch((error: any) => {
        showError(error.message);
      });
    });
  });

  ticketsWrap.querySelectorAll('.ticket-firm-open').forEach((button: any) => {
    button.addEventListener('click', (event: any) => {
      event.stopPropagation();
      const firmType = button.getAttribute('data-firm-type');
      const recordId = button.getAttribute('data-firm-record-id');
      const title = button.getAttribute('title') || 'Фирма';
      openFirmDetailModal(firmType, recordId, button, title).catch((error: any) => {
        showError(error.message);
      });
    });
  });

  loadVisibleCallDurations();
}
