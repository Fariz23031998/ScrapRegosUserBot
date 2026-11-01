declare var createTicketError: any, createTicketBusy: any, createTicketForm: any, createTicketSubmit: any, selectedTicketClient: any, ticketClientSelected: any, ticketClientSearch: any, ticketClientSearchStatus: any, ticketClientSearchResults: any, createTicketModal: any, createTicketToggle: any, FIRM_TYPE_LABELS: any, clientEditError: any, clientEditBusy: any, clientEditForm: any, clientEditClose: any, clientEditCancel: any, clientEditSubmit: any, clientFirmSearch: any, clientFirmSearchStatus: any, clientFirmSearchResults: any, linkedClientFirms: any, clientLinkedFirms: any, clientLinkedFirmsEmpty: any, clientEditName: any, clientEditPhone: any, clientEditEmail: any, clientEditExternalId: any, clientEditDescription: any, tickets: any;
declare function renderTicketsTable(...args: any[]): any;
declare function renderActiveTicket(...args: any[]): any;
declare var canEditClients: any, canLinkClientFirms: any, editingClientId: any, clientEditTrigger: any, clientEditProfile: any, clientEditFirms: any, clientEditLoading: any, clientEditModal: any;
function showCreateTicketError(message: any) {
  createTicketError.hidden = !message;
  createTicketError.textContent = message || '';
}

function setCreateTicketBusy(busy: any) {
  createTicketBusy = Boolean(busy);
  createTicketForm.querySelectorAll('input, select, textarea, button').forEach((control: any) => {
    control.disabled = createTicketBusy;
  });
  setButtonLoading(createTicketSubmit, createTicketBusy);
  if (!createTicketBusy) {
    createTicketSubmit.textContent = 'Создать';
  }
}

function renderSelectedTicketClient() {
  if (!selectedTicketClient) {
    ticketClientSelected.hidden = true;
    ticketClientSelected.innerHTML = '';
    return;
  }
  const meta = [selectedTicketClient.phone, selectedTicketClient.email].filter(Boolean).join(' · ');
  ticketClientSelected.hidden = false;
  ticketClientSelected.innerHTML = `
    <div class="firm-selected__body">
      <strong>${escapeHtml(selectedTicketClient.name || `Клиент #${selectedTicketClient.id}`)}</strong>
      <span>${escapeHtml(meta || `ID ${selectedTicketClient.id}`)}</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" id="ticket-client-clear">Изменить</button>
  `;
  (document.getElementById('ticket-client-clear') as any).addEventListener('click', () => {
    selectedTicketClient = null;
    renderSelectedTicketClient();
    ticketClientSearch.focus();
  });
}

async function searchTicketClients() {
  const query = ticketClientSearch.value.trim();
  if (query.length < 2) {
    ticketClientSearchStatus.hidden = false;
    ticketClientSearchStatus.textContent = 'Введите минимум 2 символа.';
    ticketClientSearchResults.hidden = true;
    return;
  }
  ticketClientSearchStatus.hidden = false;
  ticketClientSearchStatus.textContent = 'Поиск…';
  const data = await api(`/bot-admin/api/tickets/clients?q=${encodeURIComponent(query)}`);
  const clients = data.clients || [];
  ticketClientSearchStatus.textContent = clients.length ? '' : 'Клиенты не найдены.';
  ticketClientSearchStatus.hidden = clients.length > 0;
  ticketClientSearchResults.hidden = clients.length === 0;
  ticketClientSearchResults.innerHTML = clients
    .map((client: any, index: any) => {
      const meta = [client.phone, client.email, client.external_id].filter(Boolean).join(' · ');
      return `<button type="button" class="firm-search-result" data-client-index="${index}">
        <strong>${escapeHtml(client.name || `Клиент #${client.id}`)}</strong>
        <span class="firm-search-result__meta">${escapeHtml(meta || `ID ${client.id}`)}</span>
      </button>`;
    })
    .join('');
  ticketClientSearchResults.querySelectorAll('[data-client-index]').forEach((button: any) => {
    button.addEventListener('click', () => {
      selectedTicketClient = clients[Number(button.dataset.clientIndex)];
      ticketClientSearchResults.hidden = true;
      ticketClientSearchStatus.hidden = true;
      renderSelectedTicketClient();
    });
  });
}

function openCreateTicketModal() {
  showCreateTicketError('');
  createTicketModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  ticketClientSearch.focus();
}

function closeCreateTicketModal() {
  if (createTicketBusy) return;
  createTicketModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  createTicketToggle.focus();
}

function firmTypeLabel(type: any) {
  return FIRM_TYPE_LABELS[type] || type || '—';
}

function showClientEditError(message: any) {
  clientEditError.hidden = !message;
  clientEditError.textContent = message || '';
}

function setClientEditBusy(busy: any) {
  clientEditBusy = Boolean(busy);
  clientEditForm.querySelectorAll('input, select, textarea, button').forEach((control: any) => {
    if (control === clientEditClose || control === clientEditCancel) return;
    control.disabled = clientEditBusy;
  });
  setButtonLoading(clientEditSubmit, clientEditBusy);
  if (!clientEditBusy) {
    clientEditSubmit.textContent = 'Сохранить';
  }
}

function resetClientFirmSearch() {
  clientFirmSearch.value = '';
  clientFirmSearchStatus.hidden = true;
  clientFirmSearchStatus.textContent = '';
  clientFirmSearchResults.hidden = true;
  clientFirmSearchResults.innerHTML = '';
}

function renderLinkedClientFirms() {
  if (!linkedClientFirms.length) {
    clientLinkedFirms.innerHTML = '';
    clientLinkedFirmsEmpty.hidden = false;
    return;
  }
  clientLinkedFirmsEmpty.hidden = true;
  clientLinkedFirms.innerHTML = linkedClientFirms
    .map((firm: any) => {
      const meta = [firmTypeLabel(firm.firm_type), firm.firm_phone].filter(Boolean).join(' · ');
      return `<div class="client-linked-firm" data-link-id="${escapeHtml(firm.id)}">
        <div class="client-linked-firm__body">
          <strong>${escapeHtml(firm.firm_name || `Запись #${firm.firm_record_id}`)}</strong>
          <span class="client-linked-firm__meta">${escapeHtml(meta)}</span>
          ${
            firm.firm_message
              ? `<span class="client-linked-firm__meta">${escapeHtml(firm.firm_message)}</span>`
              : ''
          }
        </div>
        <button type="button" class="btn btn-secondary btn-sm client-firm-unlink" data-link-id="${escapeHtml(
          firm.id
        )}">Отвязать</button>
      </div>`;
    })
    .join('');

  clientLinkedFirms.querySelectorAll('.client-firm-unlink').forEach((button: any) => {
    button.addEventListener('click', () => {
      unlinkClientFirm(Number(button.dataset.linkId)).catch((error: any) => {
        showClientEditError(error.message);
      });
    });
  });
}

function fillClientEditForm(client: any) {
  clientEditName.value = client?.name || '';
  clientEditPhone.value = client?.phone || '';
  clientEditEmail.value = client?.email || '';
  clientEditExternalId.value = client?.external_id || '';
  clientEditDescription.value = client?.description || '';
}

function applyClientToTickets(client: any) {
  if (!client?.id) return;
  let changed = false;
  tickets = tickets.map((ticket: any) => {
    const ticketClientId = Number(ticket.client_id ?? ticket.client?.id);
    if (ticketClientId !== Number(client.id)) return ticket;
    changed = true;
    return {
      ...ticket,
      client_id: client.id,
      client: {
        ...(ticket.client || {}),
        id: client.id,
        name: client.name,
        phone: client.phone,
        email: client.email,
      },
    };
  });
  if (changed) {
    renderTicketsTable();
    renderActiveTicket();
  }
}

async function openClientEditModal(clientId: any, trigger: any) {
  if (!canEditClients && !canLinkClientFirms) return;
  editingClientId = Number(clientId);
  if (!Number.isInteger(editingClientId) || editingClientId <= 0) return;

  clientEditTrigger = trigger || null;
  showClientEditError('');
  resetClientFirmSearch();
  linkedClientFirms = [];
  fillClientEditForm(null);
  clientEditProfile.hidden = !canEditClients;
  clientEditFirms.hidden = !canLinkClientFirms;
  clientEditSubmit.hidden = !canEditClients;
  clientEditLoading.hidden = false;
  clientEditModal.hidden = false;
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');

  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(editingClientId)}`);
    fillClientEditForm(data.client);
    linkedClientFirms = data.firms || [];
    renderLinkedClientFirms();
    clientEditLoading.hidden = true;
    if (canEditClients) clientEditName.focus();
    else if (canLinkClientFirms) clientFirmSearch.focus();
  } catch (error: any) {
    clientEditLoading.hidden = true;
    showClientEditError(error.message);
  }
}

function closeClientEditModal() {
  if (clientEditBusy) return;
  clientEditModal.hidden = true;
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  editingClientId = null;
  linkedClientFirms = [];
  resetClientFirmSearch();
  showClientEditError('');
  if (clientEditTrigger?.focus) clientEditTrigger.focus();
  clientEditTrigger = null;
}

async function searchClientFirms() {
  const query = clientFirmSearch.value.trim();
  if (!query) {
    clientFirmSearchStatus.hidden = false;
    clientFirmSearchStatus.textContent = 'Введите запрос для поиска.';
    clientFirmSearchResults.hidden = true;
    return;
  }
  clientFirmSearchStatus.hidden = false;
  clientFirmSearchStatus.textContent = 'Поиск…';
  const data = await api(`/bot-admin/api/firm-search?q=${encodeURIComponent(query)}`);
  const results = data.results || [];
  clientFirmSearchStatus.textContent = results.length ? '' : 'Фирмы не найдены.';
  clientFirmSearchStatus.hidden = results.length > 0;
  clientFirmSearchResults.hidden = results.length === 0;
  clientFirmSearchResults.innerHTML = results
    .map((firm: any, index: any) => {
      const meta = [firmTypeLabel(firm.type), firm.phone].filter(Boolean).join(' · ');
      return `<button type="button" class="firm-search-result" data-firm-index="${index}">
        <strong>${escapeHtml(firm.clientName || 'Без названия')}</strong>
        <span class="firm-search-result__meta">${escapeHtml(meta || firm.type || '—')}</span>
        ${
          firm.message
            ? `<span class="firm-search-result__preview">${escapeHtml(firm.message)}</span>`
            : ''
        }
      </button>`;
    })
    .join('');

  clientFirmSearchResults.querySelectorAll('[data-firm-index]').forEach((button: any) => {
    button.addEventListener('click', () => {
      const firm = results[Number(button.dataset.firmIndex)];
      if (!firm) return;
      linkClientFirm(firm).catch((error: any) => showClientEditError(error.message));
    });
  });
}

async function linkClientFirm(firm: any) {
  if (!editingClientId || clientEditBusy) return;
  showClientEditError('');
  setClientEditBusy(true);
  try {
    const data = await api(`/bot-admin/api/clients/${encodeURIComponent(editingClientId)}/firms`, {
      method: 'POST',
      body: JSON.stringify({
        type: firm.type,
        recordId: firm.recordId,
        clientName: firm.clientName,
        phone: firm.phone,
        message: firm.message,
      }),
    });
    linkedClientFirms = [data.firm, ...linkedClientFirms.filter((row: any) => row.id !== data.firm.id)];
    renderLinkedClientFirms();
    resetClientFirmSearch();
  } finally {
    setClientEditBusy(false);
  }
}

async function unlinkClientFirm(linkId: any) {
  if (!editingClientId || clientEditBusy) return;
  showClientEditError('');
  setClientEditBusy(true);
  try {
    await api(
      `/bot-admin/api/clients/${encodeURIComponent(editingClientId)}/firms/${encodeURIComponent(linkId)}`,
      { method: 'DELETE' }
    );
    linkedClientFirms = linkedClientFirms.filter((firm: any) => Number(firm.id) !== Number(linkId));
    renderLinkedClientFirms();
  } finally {
    setClientEditBusy(false);
  }
}
