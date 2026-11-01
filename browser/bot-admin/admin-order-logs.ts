let logs: any[] = [];
let searchQuery = '';
let currentPage = 1;
let pageLimit = 25;
let totalLogs = 0;

const searchInput = (document.getElementById('log-search') as any);
const searchClearBtn = (document.getElementById('search-clear') as any);
const searchBox = (document.getElementById('search-box') as any);
const logsWrap = (document.getElementById('order-logs-wrap') as any);
const logsPaginationEl = (document.getElementById('order-logs-pagination') as any);

function formatAmount(amount: any) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString('ru-RU')} сум`;
}

function formatActor(log: any) {
  const parts: any[] = [];
  if (log.actor_name) parts.push(log.actor_name);
  if (log.actor_phone) parts.push(log.actor_phone);
  if (log.actor_telegram_id) parts.push(`TG ${log.actor_telegram_id}`);
  return parts.length ? parts.join(' · ') : '—';
}

function formatPaymentType(log: any) {
  return log.payment_provider_label || log.payment_provider || '—';
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

function renderOrderLogsTable() {
  if (!logs.length) {
    const emptyMessage = searchQuery
      ? 'Ничего не найдено. Попробуйте другой запрос.'
      : 'Записей пока нет.';
    logsWrap.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  logsWrap.innerHTML = `
    <div class="table-scroll">
    <table class="data-table order-logs-table">
      <thead>
        <tr>
          <th>Дата</th>
          <th>Действие</th>
          <th>Заказ</th>
          <th class="cell-num">Сумма</th>
          <th>Клиент</th>
          <th>Доп. номер</th>
          <th>Оплата</th>
          <th>Сотрудник</th>
        </tr>
      </thead>
      <tbody>
        ${logs
          .map(
            (log: any) => `
          <tr>
            <td class="cell-nowrap" data-label="Дата">${escapeHtml(formatDateTime(log.created_at))}</td>
            <td data-label="Действие">
              <span class="log-action log-action--${escapeHtml(log.action)}">${escapeHtml(log.action_label)}</span>
            </td>
            <td class="cell-mono" data-label="Заказ" title="${escapeHtml(log.order_id)}">${escapeHtml(log.order_id)}</td>
            <td class="cell-num" data-label="Сумма">${escapeHtml(formatAmount(log.order_amount))}</td>
            <td class="cell-phone" data-label="Клиент">${escapeHtml(log.client_phone || '—')}</td>
            <td class="cell-phone" data-label="Доп. номер">${escapeHtml(log.additional_phone || '—')}</td>
            <td data-label="Оплата">${escapeHtml(formatPaymentType(log))}</td>
            <td data-label="Сотрудник">${escapeHtml(formatActor(log))}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderLogsPagination() {
  renderPagination(
    logsPaginationEl,
    { page: currentPage, limit: pageLimit, total: totalLogs },
    {
      onPageChange: (page: any) => {
        currentPage = page;
        loadOrderLogs().catch((error: any) => window.alert(error.message));
      },
      onLimitChange: (limit: any) => {
        pageLimit = limit;
        currentPage = 1;
        loadOrderLogs().catch((error: any) => window.alert(error.message));
      },
    }
  );
}

async function loadOrderLogs() {
  logsWrap.innerHTML = renderLoadingState();
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: String(pageLimit),
  });
  if (searchQuery) {
    params.set('q', searchQuery);
  }
  const data = await api(`/bot-admin/api/order-logs?${params.toString()}`);
  logs = data.logs || [];
  totalLogs = data.total ?? logs.length;
  currentPage = data.page ?? currentPage;
  pageLimit = data.limit ?? pageLimit;
  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderOrderLogsTable();
  renderLogsPagination();
}

async function init() {
  await ensureSession({ requiredPermission: 'order_logs_read' });
  await loadOrderLogs();
}

(document.getElementById('refresh-logs-btn') as any).addEventListener('click', () => {
  loadOrderLogs().catch((error: any) => window.alert(error.message));
});

bindSearchBox({
  input: searchInput,
  clearBtn: searchClearBtn,
  box: searchBox,
  onSearch: (query: any) => {
    searchQuery = query;
    currentPage = 1;
    loadOrderLogs().catch((error: any) => window.alert(error.message));
  },
});

setupLogout();
init().catch((error: any) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
