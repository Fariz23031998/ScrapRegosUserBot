let logs = [];
let searchQuery = '';
let currentPage = 1;
let pageLimit = 25;
let totalLogs = 0;

const searchInput = document.getElementById('log-search');
const searchClearBtn = document.getElementById('search-clear');
const searchBox = document.getElementById('search-box');
const logsWrap = document.getElementById('order-logs-wrap');
const logsPaginationEl = document.getElementById('order-logs-pagination');

function formatAmount(amount) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString('ru-RU')} сум`;
}

function formatActor(log) {
  const parts = [];
  if (log.actor_name) parts.push(log.actor_name);
  if (log.actor_phone) parts.push(log.actor_phone);
  if (log.actor_telegram_id) parts.push(`TG ${log.actor_telegram_id}`);
  return parts.length ? parts.join(' · ') : '—';
}

function formatDateTime(value) {
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
    <table class="users-table order-logs-table">
      <thead>
        <tr>
          <th>Дата</th>
          <th>Действие</th>
          <th>Заказ</th>
          <th>Сумма</th>
          <th>Клиент</th>
          <th>Сотрудник</th>
        </tr>
      </thead>
      <tbody>
        ${logs
          .map(
            (log) => `
          <tr>
            <td class="cell-nowrap">${escapeHtml(formatDateTime(log.created_at))}</td>
            <td>
              <span class="log-action log-action--${escapeHtml(log.action)}">${escapeHtml(log.action_label)}</span>
            </td>
            <td class="cell-mono">${escapeHtml(log.order_id)}</td>
            <td>${escapeHtml(formatAmount(log.order_amount))}</td>
            <td class="cell-phone">${escapeHtml(log.client_phone || '—')}</td>
            <td>${escapeHtml(formatActor(log))}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderLogsPagination() {
  renderPagination(
    logsPaginationEl,
    { page: currentPage, limit: pageLimit, total: totalLogs },
    {
      onPageChange: (page) => {
        currentPage = page;
        loadOrderLogs().catch((error) => window.alert(error.message));
      },
      onLimitChange: (limit) => {
        pageLimit = limit;
        currentPage = 1;
        loadOrderLogs().catch((error) => window.alert(error.message));
      },
    }
  );
}

async function loadOrderLogs() {
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
  await ensureSession();
  await loadOrderLogs();
}

document.getElementById('refresh-logs-btn').addEventListener('click', () => {
  loadOrderLogs().catch((error) => window.alert(error.message));
});

bindSearchBox({
  input: searchInput,
  clearBtn: searchClearBtn,
  box: searchBox,
  onSearch: (query) => {
    searchQuery = query;
    currentPage = 1;
    loadOrderLogs().catch((error) => window.alert(error.message));
  },
});

setupLogout();
init().catch((error) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
