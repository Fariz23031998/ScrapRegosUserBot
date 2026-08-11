const DURATIONS = [1, 3, 6, 12];

const state = {
  page: 1,
  limit: 25,
  total: 0,
  query: '',
  status: '',
  canCreate: false,
  canEdit: false,
  canDelete: false,
  itemsById: new Map(),
};

function durationLabel(months) {
  const value = Number(months);
  if (value === 1) return '1 месяц';
  if (value === 3) return '3 месяца';
  if (value === 6) return '6 месяцев';
  if (value === 12) return '12 месяцев';
  return 'custom';
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return `${escapeHtml(date.toLocaleDateString('ru-RU'))}<span class="cell-sub">${escapeHtml(
    date.toLocaleTimeString('ru-RU')
  )}</span>`;
}

function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const match = /^998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  if (!match) return escapeHtml(value || '—');
  const [, code, first, second, third] = match;
  return escapeHtml(`+998 ${code} ${first}-${second}-${third}`);
}

function toDateInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addLocalMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getDate();
  result.setMonth(result.getMonth() + Number(months));
  if (result.getDate() < day) {
    result.setDate(0);
  }
  return result;
}

function suggestedEndsAtFromMonths(months) {
  return toDateInputValue(addLocalMonths(new Date(), months));
}

/** Convert YYYY-MM-DD to ISO at end of that local day. */
function fromDateInputValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

function showPricesMessage(text, isError = false) {
  const el = document.getElementById('prices-message');
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = `message ${isError ? 'error' : 'success'}`;
}

function showModalError(id, text) {
  const el = document.getElementById(id);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

function setModalOpen(overlay, open) {
  overlay.hidden = !open;
  document.documentElement.classList.toggle('modal-open', open);
  document.body.classList.toggle('modal-open', open);
}

function closeCreateModal() {
  setModalOpen(document.getElementById('create-subscription-modal'), false);
  showModalError('create-subscription-error', '');
}

function closeEditModal() {
  setModalOpen(document.getElementById('edit-subscription-modal'), false);
  showModalError('edit-subscription-error', '');
}

function openCreateModal() {
  const form = document.getElementById('create-subscription-form');
  form.reset();
  document.getElementById('create-months').value = '3';
  document.getElementById('create-amount').value = '0';
  document.getElementById('create-ends-at').value = suggestedEndsAtFromMonths(3);
  showModalError('create-subscription-error', '');
  setModalOpen(document.getElementById('create-subscription-modal'), true);
  document.getElementById('create-phone').focus();
}

function openEditModal(row) {
  document.getElementById('edit-subscription-id').value = String(row.id);
  document.getElementById('edit-subscription-meta').textContent =
    `${row.phone || ''} · ${durationLabel(row.months)}`;
  document.getElementById('edit-ends-at').value = toDateInputValue(row.ends_at);
  showModalError('edit-subscription-error', '');
  setModalOpen(document.getElementById('edit-subscription-modal'), true);
  document.getElementById('edit-ends-at').focus();
}

function renderPricesForm(prices, { canEdit = true } = {}) {
  const grid = document.getElementById('prices-grid');
  const byMonths = new Map((prices || []).map((row) => [Number(row.months), row]));
  grid.innerHTML = DURATIONS.map((months) => {
    const row = byMonths.get(months) || { amount: 0, configured: false };
    const hint = row.configured
      ? 'Настроено'
      : 'Не настроено (кнопка в боте будет скрыта)';
    return `
      <label class="field">
        <span>${durationLabel(months)}</span>
        <input
          type="number"
          min="0"
          step="1"
          name="price_${months}"
          data-months="${months}"
          value="${Number(row.amount || 0)}"
          required
          ${canEdit ? '' : 'readonly disabled'}
        />
        <small class="field-hint ${row.configured ? 'field-hint--ok' : 'field-hint--warn'}">${hint}</small>
      </label>
    `;
  }).join('');
}

async function loadPrices(canEdit = true) {
  const grid = document.getElementById('prices-grid');
  grid.innerHTML = renderLoadingState();
  const data = await api('/bot-admin/api/technical-support/prices');
  renderPricesForm(data.prices || [], { canEdit });
}

async function savePrices(event) {
  event.preventDefault();
  showPricesMessage('');
  const prices = {};
  for (const input of document.querySelectorAll('#prices-grid input[data-months]')) {
    const months = input.getAttribute('data-months');
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 0) {
      showPricesMessage('Сумма должна быть целым числом ≥ 0.', true);
      return;
    }
    prices[months] = amount;
  }

  const submitBtn = document.getElementById('prices-submit');
  setButtonLoading(submitBtn, true);
  try {
    const data = await api('/bot-admin/api/technical-support/prices', {
      method: 'PUT',
      body: JSON.stringify({ prices }),
    });
    renderPricesForm(data.prices || []);
    showPricesMessage('Цены сохранены.');
  } catch (error) {
    showPricesMessage(error.message || 'Не удалось сохранить цены.', true);
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

function statusBadge(status) {
  if (status === 'active') {
    return '<span class="badge badge--ok">Активна</span>';
  }
  return '<span class="badge badge--muted">Истекла</span>';
}

function renderRowActions(row) {
  const actions = [];
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

function renderSubscriptions(items) {
  const wrap = document.getElementById('subscriptions-wrap');
  state.itemsById = new Map((items || []).map((row) => [Number(row.id), row]));
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
              (row) => `
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

  wrap.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      handleSubscriptionAction(button.dataset.action, Number(button.dataset.id), button).catch(
        (error) => window.alert(error.message)
      );
    });
  });
}

async function loadSubscriptions() {
  const wrap = document.getElementById('subscriptions-wrap');
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
  renderPagination(document.getElementById('subscriptions-pagination'), state, {
    onPageChange: (page) => {
      state.page = page;
      loadSubscriptions().catch((error) => {
        document.getElementById('subscriptions-wrap').innerHTML =
          `<p class="message error">${escapeHtml(error.message)}</p>`;
      });
    },
    onLimitChange: (limit) => {
      state.limit = limit;
      state.page = 1;
      loadSubscriptions().catch((error) => {
        document.getElementById('subscriptions-wrap').innerHTML =
          `<p class="message error">${escapeHtml(error.message)}</p>`;
      });
    },
  });
}

async function handleSubscriptionAction(action, id, button) {
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

async function submitCreateSubscription(event) {
  event.preventDefault();
  showModalError('create-subscription-error', '');
  const phone = document.getElementById('create-phone').value.trim();
  const monthsRaw = document.getElementById('create-months').value;
  const isCustom = monthsRaw === 'custom';
  const months = isCustom ? 0 : Number(monthsRaw);
  const endsAt = fromDateInputValue(document.getElementById('create-ends-at').value);
  const amountRaw = document.getElementById('create-amount').value;
  const amount = amountRaw === '' ? 0 : Number(amountRaw);
  if (!phone) {
    showModalError('create-subscription-error', 'Укажите телефон.');
    return;
  }
  if (!isCustom && !DURATIONS.includes(months)) {
    showModalError('create-subscription-error', 'Срок должен быть 1, 3, 6 или 12 месяцев.');
    return;
  }
  if (!endsAt) {
    showModalError('create-subscription-error', 'Укажите корректную дату окончания.');
    return;
  }
  if (Date.parse(endsAt) <= Date.now()) {
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

  const submitBtn = document.getElementById('create-subscription-submit');
  setButtonLoading(submitBtn, true);
  try {
    await api('/bot-admin/api/technical-support/subscriptions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    closeCreateModal();
    state.page = 1;
    await loadSubscriptions();
  } catch (error) {
    showModalError('create-subscription-error', error.message || 'Не удалось создать подписку.');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

async function submitEditSubscription(event) {
  event.preventDefault();
  showModalError('edit-subscription-error', '');
  const id = Number(document.getElementById('edit-subscription-id').value);
  const endsAt = fromDateInputValue(document.getElementById('edit-ends-at').value);
  if (!endsAt) {
    showModalError('edit-subscription-error', 'Укажите корректную дату окончания.');
    return;
  }

  const submitBtn = document.getElementById('edit-subscription-submit');
  setButtonLoading(submitBtn, true);
  try {
    await api(`/bot-admin/api/technical-support/subscriptions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ends_at: endsAt }),
    });
    closeEditModal();
    await loadSubscriptions();
  } catch (error) {
    showModalError('edit-subscription-error', error.message || 'Не удалось обновить подписку.');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

function bindModals() {
  document.getElementById('create-subscription-btn').addEventListener('click', openCreateModal);
  document.getElementById('create-subscription-close').addEventListener('click', closeCreateModal);
  document.getElementById('create-subscription-cancel').addEventListener('click', closeCreateModal);
  document.getElementById('create-months').addEventListener('change', (event) => {
    const value = event.target.value;
    if (value === 'custom') return;
    const months = Number(value);
    if (DURATIONS.includes(months)) {
      document.getElementById('create-ends-at').value = suggestedEndsAtFromMonths(months);
    }
  });
  document.getElementById('create-ends-at').addEventListener('input', () => {
    document.getElementById('create-months').value = 'custom';
  });
  document
    .getElementById('create-subscription-form')
    .addEventListener('submit', (event) => {
      submitCreateSubscription(event).catch((error) => window.alert(error.message));
    });

  document.getElementById('edit-subscription-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-subscription-cancel').addEventListener('click', closeEditModal);
  document.getElementById('edit-subscription-form').addEventListener('submit', (event) => {
    submitEditSubscription(event).catch((error) => window.alert(error.message));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const createModal = document.getElementById('create-subscription-modal');
    const editModal = document.getElementById('edit-subscription-modal');
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

  const submitBtn = document.getElementById('prices-submit');
  if (!state.canEdit) {
    submitBtn.hidden = true;
  } else {
    document.getElementById('prices-form').addEventListener('submit', savePrices);
  }

  const createBtn = document.getElementById('create-subscription-btn');
  if (state.canCreate) {
    createBtn.hidden = false;
  }

  bindModals();

  document.getElementById('refresh-subscriptions-btn').addEventListener('click', () => {
    loadSubscriptions().catch((error) => {
      document.getElementById('subscriptions-wrap').innerHTML =
        `<p class="message error">${escapeHtml(error.message)}</p>`;
    });
  });
  document.getElementById('status-filter').addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    loadSubscriptions().catch((error) => {
      document.getElementById('subscriptions-wrap').innerHTML =
        `<p class="message error">${escapeHtml(error.message)}</p>`;
    });
  });

  bindSearchBox({
    input: document.getElementById('subscription-search'),
    clearBtn: document.getElementById('search-clear'),
    box: document.getElementById('search-box'),
    onSearch: (query) => {
      state.query = query;
      state.page = 1;
      updateSearchBoxUi(
        document.getElementById('subscription-search'),
        document.getElementById('search-clear'),
        document.getElementById('search-box'),
        query
      );
      loadSubscriptions().catch((error) => {
        document.getElementById('subscriptions-wrap').innerHTML =
          `<p class="message error">${escapeHtml(error.message)}</p>`;
      });
    },
  });
}

init().catch((error) => {
  console.error(error);
  window.location.href = '/bot-admin/login';
});
