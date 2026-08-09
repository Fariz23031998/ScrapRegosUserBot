const DURATIONS = [1, 3, 6, 12];

const state = {
  page: 1,
  limit: 25,
  total: 0,
  query: '',
  status: '',
};

function durationLabel(months) {
  if (months === 1) return '1 месяц';
  if (months === 3) return '3 месяца';
  if (months === 6) return '6 месяцев';
  return '12 месяцев';
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

function renderSubscriptions(items) {
  const wrap = document.getElementById('subscriptions-wrap');
  if (!items.length) {
    wrap.innerHTML = '<p class="empty-state">Подписки не найдены.</p>';
    return;
  }

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
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
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

async function init() {
  const session = await ensureSession({ requiredPermission: 'technical_support_read' });
  const canEdit = Boolean(session.permissions?.technical_support_edit);
  setupLogout();
  await loadPrices(canEdit);
  await loadSubscriptions();

  const submitBtn = document.getElementById('prices-submit');
  if (!canEdit) {
    submitBtn.hidden = true;
  } else {
    document.getElementById('prices-form').addEventListener('submit', savePrices);
  }
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
