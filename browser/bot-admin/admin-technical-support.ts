declare function formatPhone(...args: any[]): any;
declare function durationLabel(...args: any[]): any;
declare function formatAmount(...args: any[]): any;
declare function formatDateTime(...args: any[]): any;
declare function openEditModal(...args: any[]): any;
declare function showModalError(...args: any[]): any;
declare function fromDateInputValue(...args: any[]): any;
declare function catalogAmountForMonths(...args: any[]): any;
declare function closeCreateModal(...args: any[]): any;
declare function closeEditModal(...args: any[]): any;
declare function openCreateModal(...args: any[]): any;
declare function syncCreateDurationFields(...args: any[]): any;
declare function loadPrices(...args: any[]): any;
declare function savePrices(...args: any[]): any;
var DURATIONS = [1, 3, 6, 12];

var state: any = {
  page: 1,
  limit: 25,
  total: 0,
  query: '',
  status: '',
  canCreate: false,
  canEdit: false,
  canDelete: false,
  itemsById: new Map(),
  pricesByMonths: {},
};


function statusBadge(status: any) {
  if (status === 'active') {
    return '<span class="badge badge--ok">Активна</span>';
  }
  return '<span class="badge badge--muted">Истекла</span>';
}

function renderRowActions(row: any) {
  const actions: any[] = [];
  const id = Number(row.id);
  if (state.canEdit && row.status === 'active') {
    actions.push(
      `<button type="button" class="btn btn-secondary btn-sm" data-action="deactivate" data-id="${id}">Деактивировать</button>`
    );
  }
  if (state.canEdit) {
    actions.push(
      `<button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${id}">Изменить</button>`
    );
  }
  if (state.canDelete) {
    actions.push(
      `<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${id}">Удалить</button>`
    );
  }
  if (!actions.length) return '—';
  return `<div class="row-actions">${actions.join('')}</div>`;
}

function renderSubscriptions(items: any) {
  const wrap = (document.getElementById('subscriptions-wrap') as any);
  state.itemsById = new Map((items || []).map((row: any) => [Number(row.id), row]));
  if (!items.length) {
    wrap.innerHTML = '<p class="empty-state">Подписки не найдены.</p>';
    return;
  }

  const showActions = state.canCreate || state.canEdit || state.canDelete;
  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Телефон</th>
            <th>Срок</th>
            <th class="cell-num">Сумма</th>
            <th>Заказ</th>
            <th>Начало</th>
            <th>Окончание</th>
            <th>Статус</th>
            ${showActions ? '<th>Действия</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (row: any) => `
            <tr>
              <td class="cell-phone" data-label="Телефон">${formatPhone(row.phone)}</td>
              <td class="cell-nowrap" data-label="Срок">${escapeHtml(durationLabel(row.months))}</td>
              <td class="cell-num" data-label="Сумма">${formatAmount(row.amount)}<span class="cell-unit">UZS</span></td>
              <td class="cell-mono" data-label="Заказ" title="${escapeHtml(row.order_id)}">${escapeHtml(row.order_id)}</td>
              <td class="cell-nowrap" data-label="Начало">${formatDateTime(row.starts_at)}</td>
              <td class="cell-nowrap" data-label="Окончание">${formatDateTime(row.ends_at)}</td>
              <td data-label="Статус">${statusBadge(row.status)}</td>
              ${
                showActions
                  ? `<td data-label="Действия">${renderRowActions(row)}</td>`
                  : ''
              }
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  wrap.querySelectorAll('button[data-action]').forEach((button: any) => {
    button.addEventListener('click', () => {
      handleSubscriptionAction(button.dataset.action, Number(button.dataset.id), button).catch(
        (error: any) => window.alert(error.message)
      );
    });
  });
}

async function loadSubscriptions() {
  const wrap = (document.getElementById('subscriptions-wrap') as any);
  wrap.innerHTML = renderLoadingState();
  const params = new URLSearchParams({
    page: String(state.page),
    limit: String(state.limit),
  });
  if (state.query) params.set('q', state.query);
  if (state.status) params.set('status', state.status);

  const data = await api(`/bot-admin/api/technical-support/subscriptions?${params}`);
  state.total = data.total || 0;
  state.page = data.page || state.page;
  state.limit = data.limit || state.limit;
  renderSubscriptions(data.subscriptions || []);
  renderPagination((document.getElementById('subscriptions-pagination') as any), state, {
    onPageChange: (page: any) => {
      state.page = page;
      loadSubscriptions().catch((error: any) => {
        (document.getElementById('subscriptions-wrap') as any).innerHTML =
          `<p class="message error">${escapeHtml(error.message)}</p>`;
      });
    },
    onLimitChange: (limit: any) => {
      state.limit = limit;
      state.page = 1;
      loadSubscriptions().catch((error: any) => {
        (document.getElementById('subscriptions-wrap') as any).innerHTML =
          `<p class="message error">${escapeHtml(error.message)}</p>`;
      });
    },
  });
}

async function handleSubscriptionAction(action: any, id: any, button: any) {
  const row = state.itemsById.get(id);
  if (!row) return;

  if (action === 'edit' && state.canEdit) {
    openEditModal(row);
    return;
  }

  if (action === 'deactivate' && state.canEdit) {
    if (!window.confirm('Деактивировать подписку сейчас?')) return;
    setButtonLoading(button, true);
    try {
      await api(`/bot-admin/api/technical-support/subscriptions/${id}/deactivate`, {
        method: 'POST',
      });
      await loadSubscriptions();
    } finally {
      setButtonLoading(button, false);
    }
    return;
  }

  if (action === 'delete' && state.canDelete) {
    if (!window.confirm('Удалить подписку безвозвратно?')) return;
    setButtonLoading(button, true);
    try {
      await api(`/bot-admin/api/technical-support/subscriptions/${id}`, { method: 'DELETE' });
      await loadSubscriptions();
    } finally {
      setButtonLoading(button, false);
    }
  }
}

async function submitCreateSubscription(event: any) {
  event.preventDefault();
  showModalError('create-subscription-error', '');
  const phone = (document.getElementById('create-phone') as any).value.trim();
  const monthsRaw = (document.getElementById('create-months') as any).value;
  const isCustom = monthsRaw === 'custom';
  const months = isCustom ? 0 : Number(monthsRaw);
  const endsAt = fromDateInputValue((document.getElementById('create-ends-at') as any).value);
  const amountRaw = (document.getElementById('create-amount') as any).value;
  const amount = isCustom
    ? amountRaw === ''
      ? 0
      : Number(amountRaw)
    : catalogAmountForMonths(months);
  if (!phone) {
    showModalError('create-subscription-error', 'Укажите телефон.');
    return;
  }
  if (!isCustom && !DURATIONS.includes(months)) {
    showModalError('create-subscription-error', 'Срок должен быть 1, 3, 6 или 12 месяцев.');
    return;
  }
  if (isCustom && !endsAt) {
    showModalError('create-subscription-error', 'Укажите корректную дату окончания.');
    return;
  }
  if (isCustom && Date.parse(endsAt!) <= Date.now()) {
    showModalError('create-subscription-error', 'Дата окончания должна быть в будущем.');
    return;
  }
  if (!Number.isInteger(amount) || amount < 0) {
    showModalError('create-subscription-error', 'Сумма должна быть целым числом ≥ 0.');
    return;
  }

  const payload = isCustom
    ? { phone, months: 0, amount, ends_at: endsAt }
    : { phone, months, amount };

  const submitBtn = (document.getElementById('create-subscription-submit') as any);
  setButtonLoading(submitBtn, true);
  try {
    await api('/bot-admin/api/technical-support/subscriptions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    closeCreateModal();
    state.page = 1;
    await loadSubscriptions();
  } catch (error: any) {
    showModalError('create-subscription-error', error.message || 'Не удалось создать подписку.');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function submitEditSubscription(event: any) {
  event.preventDefault();
  showModalError('edit-subscription-error', '');
  const id = Number((document.getElementById('edit-subscription-id') as any).value);
  const endsAt = fromDateInputValue((document.getElementById('edit-ends-at') as any).value);
  if (!endsAt) {
    showModalError('edit-subscription-error', 'Укажите корректную дату окончания.');
    return;
  }

  const submitBtn = (document.getElementById('edit-subscription-submit') as any);
  setButtonLoading(submitBtn, true);
  try {
    await api(`/bot-admin/api/technical-support/subscriptions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ends_at: endsAt }),
    });
    closeEditModal();
    await loadSubscriptions();
  } catch (error: any) {
    showModalError('edit-subscription-error', error.message || 'Не удалось обновить подписку.');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

function bindModals() {
  (document.getElementById('create-subscription-btn') as any).addEventListener('click', openCreateModal);
  (document.getElementById('create-subscription-close') as any).addEventListener('click', closeCreateModal);
  (document.getElementById('create-subscription-cancel') as any).addEventListener('click', closeCreateModal);
  (document.getElementById('create-months') as any).addEventListener('change', () => {
    syncCreateDurationFields();
  });
  (document.getElementById('create-ends-at') as any).addEventListener('input', () => {
    if ((document.getElementById('create-ends-at') as any).disabled) return;
    (document.getElementById('create-months') as any).value = 'custom';
    syncCreateDurationFields();
  });
  (document.getElementById('create-subscription-form') as any)
    .addEventListener('submit', (event: any) => {
      submitCreateSubscription(event).catch((error: any) => window.alert(error.message));
    });

  (document.getElementById('edit-subscription-close') as any).addEventListener('click', closeEditModal);
  (document.getElementById('edit-subscription-cancel') as any).addEventListener('click', closeEditModal);
  (document.getElementById('edit-subscription-form') as any).addEventListener('submit', (event: any) => {
    submitEditSubscription(event).catch((error: any) => window.alert(error.message));
  });

  document.addEventListener('keydown', (event: any) => {
    if (event.key !== 'Escape') return;
    const createModal = (document.getElementById('create-subscription-modal') as any);
    const editModal = (document.getElementById('edit-subscription-modal') as any);
    if (!createModal.hidden) closeCreateModal();
    if (!editModal.hidden) closeEditModal();
  });
}

async function init() {
  const session = await ensureSession({ requiredPermission: 'technical_support_read' });
  state.canCreate = Boolean(session.permissions?.technical_support_create);
  state.canEdit = Boolean(session.permissions?.technical_support_edit);
  state.canDelete = Boolean(session.permissions?.technical_support_delete);
  setupLogout();
  await loadPrices(state.canEdit);
  await loadSubscriptions();

  const submitBtn = (document.getElementById('prices-submit') as any);
  if (!state.canEdit) {
    submitBtn.hidden = true;
  } else {
    (document.getElementById('prices-form') as any).addEventListener('submit', savePrices);
  }

  const createBtn = (document.getElementById('create-subscription-btn') as any);
  if (state.canCreate) {
    createBtn.hidden = false;
  }

  bindModals();

  (document.getElementById('refresh-subscriptions-btn') as any).addEventListener('click', () => {
    loadSubscriptions().catch((error: any) => {
      (document.getElementById('subscriptions-wrap') as any).innerHTML =
        `<p class="message error">${escapeHtml(error.message)}</p>`;
    });
  });
  (document.getElementById('status-filter') as any).addEventListener('change', (event: any) => {
    state.status = event.target.value;
    state.page = 1;
    loadSubscriptions().catch((error: any) => {
      (document.getElementById('subscriptions-wrap') as any).innerHTML =
        `<p class="message error">${escapeHtml(error.message)}</p>`;
    });
  });

  bindSearchBox({
    input: (document.getElementById('subscription-search') as any),
    clearBtn: (document.getElementById('search-clear') as any),
    box: (document.getElementById('search-box') as any),
    onSearch: (query: any) => {
      state.query = query;
      state.page = 1;
      updateSearchBoxUi(
        (document.getElementById('subscription-search') as any),
        (document.getElementById('search-clear') as any),
        (document.getElementById('search-box') as any),
        query
      );
      loadSubscriptions().catch((error: any) => {
        (document.getElementById('subscriptions-wrap') as any).innerHTML =
          `<p class="message error">${escapeHtml(error.message)}</p>`;
      });
    },
  });
}

init().catch((error: any) => {
  console.error(error);
  window.location.href = '/bot-admin/login';
});
