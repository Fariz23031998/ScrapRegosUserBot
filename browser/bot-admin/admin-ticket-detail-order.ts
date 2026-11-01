declare var firmSearchInput: any, firmSearchStatus: any, firmSearchResults: any, selectedFirm: any, firmSelectedEl: any;
declare function firmTypeLabel(...args: any[]): any;
declare var orderClientPhoneInput: any, ticketDefaultPhone: any, linkedClientFirms: any, firmSearchBtn: any, createOrderForm: any;
declare function showModalError(...args: any[]): any;
declare var editTicketError: any, editTicketBusy: any, editTicketForm: any, editTicketSubmit: any, ticket: any, editTicketSubject: any, editTicketDescription: any, editTicketDirection: any, editTicketStatus: any, editTicketResponsible: any, ticketUsers: any, editTicketModal: any, editTicketToggle: any;
declare function showError(...args: any[]): any;
declare var createOrderModal: any, orderAmountInput: any, createOrderBusy: any, createOrderProgress: any, createOrderSubmit: any, createOrderCancel: any, createOrderClose: any;
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
  (document.getElementById('firm-clear-btn') as any)?.addEventListener('click', clearSelectedFirm);
}

function clearSelectedFirm() {
  selectedFirm = null;
  renderSelectedFirm();
  orderClientPhoneInput.value = ticketDefaultPhone;
}

function selectFirm(firm: any) {
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

function applyDefaultLinkedFirm() {
  const firm = firmFromLinkedClient(linkedClientFirms[0]);
  if (!firm) return;
  selectFirm(firm);
}

async function loadLinkedClientFirms(clientId: any) {
  linkedClientFirms = [];
  const id = Number(clientId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(id)}`);
    linkedClientFirms = Array.isArray(data.firms) ? data.firms : [];
  } catch {
    linkedClientFirms = [];
  }
}

function renderFirmResults(results: any) {
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
      if (firm) selectFirm(firm);
    });
  });
}

let firmSearchRequestId = 0;

function clearFirmSearchResults() {
  firmSearchStatus.hidden = true;
  firmSearchStatus.textContent = '';
  firmSearchResults.hidden = true;
  firmSearchResults.innerHTML = '';
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
  } catch (error: any) {
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

function triggerFirmSearchNow() {
  runFirmSearch().catch((error: any) => {
    firmSearchStatus.hidden = false;
    firmSearchStatus.textContent = error.message;
  });
}

function resetCreateOrderForm() {
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

function showEditTicketError(message: any) {
  editTicketError.hidden = !message;
  editTicketError.textContent = message || '';
}

function setEditTicketBusy(busy: any) {
  editTicketBusy = Boolean(busy);
  editTicketForm.querySelectorAll('input, select, textarea, button').forEach((control: any) => {
    control.disabled = editTicketBusy;
  });
  setButtonLoading(editTicketSubmit, editTicketBusy);
  if (!editTicketBusy) {
    editTicketSubmit.textContent = 'Сохранить';
  }
}

function openEditTicketModal() {
  if (!ticket) return;
  showEditTicketError('');
  editTicketSubject.value = ticket.subject || '';
  editTicketDescription.value = ticket.description || '';
  editTicketDirection.value = ticket.direction || 'Inbound';
  editTicketStatus.value = ticket.status || 'Open';
  editTicketResponsible.innerHTML =
    '<option value="">Не менять</option>' +
    ticketUsers
      .map(
        (user: any) =>
          `<option value="${escapeHtml(user.id)}">${escapeHtml(
            user.full_name || user.login || `Пользователь #${user.id}`
          )}</option>`
      )
      .join('');
  editTicketResponsible.value =
    ticket.responsible_user_id != null ? String(ticket.responsible_user_id) : '';
  setEditTicketBusy(false);
  editTicketModal.hidden = false;
  lockPageScroll();
  editTicketSubject.focus();
}

function closeEditTicketModal({ force = false }: any = {}) {
  if (editTicketBusy && !force) return;
  editTicketModal.hidden = true;
  unlockPageScroll();
  editTicketToggle.focus();
}

function openCreateOrderModal() {
  resetCreateOrderForm();
  applyDefaultLinkedFirm();
  showError('');
  setCreateOrderBusy(false);
  createOrderModal.hidden = false;
  lockPageScroll();
  orderAmountInput.focus();
}

function closeCreateOrderModal({ force = false }: any = {}) {
  if (createOrderBusy && !force) return;
  setCreateOrderBusy(false);
  createOrderModal.hidden = true;
  unlockPageScroll();
  resetCreateOrderForm();
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
