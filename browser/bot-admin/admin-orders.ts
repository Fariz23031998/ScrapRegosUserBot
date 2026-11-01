let orders: any[] = [];
let searchQuery = '';
let clientFilter = '';
let statusFilter = '';
let dateFrom = '';
let dateTo = '';
let currentPage = 1;
let pageLimit = 25;
let totalOrders = 0;
let canDeleteOrders = false;
let canDeleteCashOrders = false;
let canMarkOrdersPaidCash = false;
let canRenotifyOrders = false;

const searchInput = (document.getElementById('order-search') as any);
const searchClearBtn = (document.getElementById('search-clear') as any);
const searchBox = (document.getElementById('search-box') as any);
const clientFilterInput = (document.getElementById('client-filter') as any);
const statusSelect = (document.getElementById('status-filter') as any);
const dateFromInput = (document.getElementById('date-from') as any);
const dateToInput = (document.getElementById('date-to') as any);
const ordersWrap = (document.getElementById('orders-wrap') as any);
const ordersPaginationEl = (document.getElementById('orders-pagination') as any);
const filtersForm = (document.getElementById('order-filters') as any);

function formatAmount(amount: any) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString('ru-RU')} сум`;
}

function formatDateTime(value: any) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatEmployee(order: any) {
  const parts: any[] = [];
  if (order.employee_name) parts.push(order.employee_name);
  if (order.employee_phone) parts.push(order.employee_phone);
  return parts.length ? parts.join(' · ') : '—';
}

function formatPayment(order: any) {
  const status = String(order.status || '');
  if (status !== 'paid' && status !== 'paid_cash') return '';
  return order.payment_provider_label || order.payment_provider || '';
}

function formatTicketCell(order: any) {
  if (order.ticket_id == null) return '—';
  const id = Number(order.ticket_id);
  if (!Number.isFinite(id)) return escapeHtml(String(order.ticket_id));
  return `<a href="/bot-admin/tickets/${id}">${escapeHtml(String(id))}</a>`;
}

function statusBadgeClass(status: any) {
  if (status === 'pending') return 'order-status order-status--pending';
  if (status === 'paid') return 'order-status order-status--paid';
  if (status === 'paid_cash') return 'order-status order-status--paid_cash';
  if (status === 'deleted') return 'order-status order-status--deleted';
  return 'order-status';
}

function hasActiveFilters() {
  return Boolean(searchQuery || clientFilter || statusFilter || dateFrom || dateTo);
}

function renderActions(order: any) {
  const id = escapeHtml(order.id);
  const actions: any[] = [];

  if (order.status === 'pending') {
    if (canRenotifyOrders) {
      actions.push(
        `<button type="button" class="btn btn-secondary btn-sm" data-action="renotify" data-order-id="${id}">Уведомить</button>`
      );
    }
    if (canMarkOrdersPaidCash) {
      actions.push(
        `<button type="button" class="btn btn-secondary btn-sm" data-action="paid-cash" data-order-id="${id}">Наличные</button>`
      );
    }
    if (canDeleteOrders) {
      actions.push(
        `<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-order-id="${id}">Удалить</button>`
      );
    }
  } else if (order.status === 'paid_cash' && canDeleteCashOrders) {
    actions.push(
      `<button type="button" class="btn btn-danger btn-sm" data-action="delete-cash" data-order-id="${id}">Удалить</button>`
    );
  }

  if (!actions.length) return '—';
  return `
    <div class="row-actions">
      ${actions.join('')}
    </div>
  `;
}

function renderOrdersTable() {
  if (!orders.length) {
    const emptyMessage = hasActiveFilters()
      ? 'Ничего не найдено. Измените фильтры.'
      : 'Заказов пока нет.';
    ordersWrap.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  ordersWrap.innerHTML = `
    <div class="table-scroll">
    <table class="data-table orders-table">
      <thead>
        <tr>
          <th>Дата</th>
          <th>ID</th>
          <th>Статус</th>
          <th class="cell-num">Сумма</th>
          <th>Клиент</th>
          <th>Доп. номер</th>
          <th>Сотрудник</th>
          <th>Оплата</th>
          <th>Тикет</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>
        ${orders
          .map(
            (order: any) => `
          <tr data-order-id="${escapeHtml(order.id)}">
            <td class="cell-nowrap" data-label="Дата">${escapeHtml(formatDateTime(order.created_at))}</td>
            <td class="cell-mono" data-label="ID" title="${escapeHtml(order.id)}">${escapeHtml(order.id)}</td>
            <td data-label="Статус">
              <span class="${statusBadgeClass(order.status)}">${escapeHtml(order.status_label || order.status)}</span>
            </td>
            <td class="cell-num" data-label="Сумма">${escapeHtml(formatAmount(order.amount))}</td>
            <td class="cell-phone" data-label="Клиент">${escapeHtml(order.client_phone || '—')}</td>
            <td class="cell-phone" data-label="Доп. номер">${escapeHtml(order.additional_phone || '—')}</td>
            <td data-label="Сотрудник">${escapeHtml(formatEmployee(order))}</td>
            <td data-label="Оплата">${escapeHtml(formatPayment(order))}</td>
            <td data-label="Тикет">${formatTicketCell(order)}</td>
            <td data-label="Действия">${renderActions(order)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;

  ordersWrap.querySelectorAll('[data-action]').forEach((button: any) => {
    button.addEventListener('click', () => {
      handleOrderAction(button.dataset.action, button.dataset.orderId, button).catch((error: any) =>
        window.alert(error.message)
      );
    });
  });
}

function renderOrdersPagination() {
  renderPagination(
    ordersPaginationEl,
    { page: currentPage, limit: pageLimit, total: totalOrders },
    {
      onPageChange: (page: any) => {
        currentPage = page;
        loadOrders().catch((error: any) => window.alert(error.message));
      },
      onLimitChange: (limit: any) => {
        pageLimit = limit;
        currentPage = 1;
        loadOrders().catch((error: any) => window.alert(error.message));
      },
    }
  );
}

async function loadOrders() {
  ordersWrap.innerHTML = renderLoadingState();
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: String(pageLimit),
  });
  if (searchQuery) params.set('q', searchQuery);
  if (clientFilter) params.set('client', clientFilter);
  if (statusFilter) params.set('status', statusFilter);
  if (dateFrom) params.set('from_date', dateFrom);
  if (dateTo) params.set('to_date', dateTo);

  const data = await api(`/bot-admin/api/orders?${params.toString()}`);
  orders = data.orders || [];
  totalOrders = data.total ?? orders.length;
  currentPage = data.page ?? currentPage;
  pageLimit = data.limit ?? pageLimit;
  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderOrdersTable();
  renderOrdersPagination();
}

async function handleOrderAction(action: any, orderId: any, button: any) {
  if (!orderId) return;

  if (action === 'delete' && canDeleteOrders) {
    if (!window.confirm('Удалить неоплаченный заказ?')) return;
  } else if (action === 'delete-cash' && canDeleteCashOrders) {
    if (!window.confirm('Удалить заказ „Наличные“?')) return;
  } else if (action === 'paid-cash' && canMarkOrdersPaidCash) {
    if (!window.confirm('Отметить заказ как оплаченный наличными?')) return;
  } else if (action === 'renotify' && canRenotifyOrders) {
    // proceed
  } else {
    return;
  }

  setButtonLoading(button, true);
  try {
    if (action === 'delete') {
      const data = await api(`/bot-admin/api/orders/${encodeURIComponent(orderId)}/delete`, {
        method: 'POST',
      });
      window.alert(data.message || 'Заказ удалён.');
    } else if (action === 'delete-cash') {
      const data = await api(`/bot-admin/api/orders/${encodeURIComponent(orderId)}/delete-cash`, {
        method: 'POST',
      });
      window.alert(data.message || 'Заказ „Наличные“ удалён.');
    } else if (action === 'paid-cash') {
      const data = await api(`/bot-admin/api/orders/${encodeURIComponent(orderId)}/paid-cash`, {
        method: 'POST',
      });
      window.alert(data.message || 'Заказ закрыт.');
    } else if (action === 'renotify') {
      const data = await api(`/bot-admin/api/orders/${encodeURIComponent(orderId)}/renotify`, {
        method: 'POST',
      });
      window.alert(data.message || 'Уведомление отправлено.');
    }

    await loadOrders();
  } catch (error: any) {
    setButtonLoading(button, false);
    throw error;
  }
}

function applyFiltersFromForm() {
  searchQuery = searchInput.value.trim();
  clientFilter = clientFilterInput.value.trim();
  statusFilter = statusSelect.value;
  dateFrom = dateFromInput.value;
  dateTo = dateToInput.value;
  currentPage = 1;
}

function applyFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const q = String(params.get('q') || '').trim();
  const client = String(params.get('client') || params.get('client_phone') || '').trim();
  const status = String(params.get('status') || '').trim();
  const from = String(params.get('from_date') || '').trim();
  const to = String(params.get('to_date') || '').trim();

  if (q) {
    searchQuery = q;
    searchInput.value = q;
  }
  if (client) {
    clientFilter = client;
    clientFilterInput.value = client;
  }
  if (status) {
    statusFilter = status;
    statusSelect.value = status;
  }
  if (from) {
    dateFrom = from;
    dateFromInput.value = from;
  }
  if (to) {
    dateTo = to;
    dateToInput.value = to;
  }
}

async function init() {
  const session = await ensureSession({ requiredPermission: 'orders_read' });
  canDeleteOrders = hasPermission(session, 'delete_unpaid_order');
  canDeleteCashOrders = hasPermission(session, 'delete_cash_order');
  canMarkOrdersPaidCash = hasPermission(session, 'mark_paid_cash');
  canRenotifyOrders = hasPermission(session, 'renotify_order');

  applyFiltersFromUrl();
  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);

  await loadOrders();
}

filtersForm.addEventListener('submit', (event: any) => {
  event.preventDefault();
  applyFiltersFromForm();
  loadOrders().catch((error: any) => window.alert(error.message));
});

(document.getElementById('refresh-orders-btn') as any).addEventListener('click', () => {
  applyFiltersFromForm();
  loadOrders().catch((error: any) => window.alert(error.message));
});

bindSearchBox({
  input: searchInput,
  clearBtn: searchClearBtn,
  box: searchBox,
  onSearch: (query: any) => {
    searchQuery = query;
    currentPage = 1;
    loadOrders().catch((error: any) => window.alert(error.message));
  },
});

setupLogout();
init().catch((error: any) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
