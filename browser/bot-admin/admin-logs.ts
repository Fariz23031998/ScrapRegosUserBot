let logs: any[] = [];
let searchQuery = '';
let currentPage = 1;
let pageLimit = 25;
let totalLogs = 0;

const searchInput = (document.getElementById('log-search') as any);
const searchClearBtn = (document.getElementById('search-clear') as any);
const searchBox = (document.getElementById('search-box') as any);
const logsWrap = (document.getElementById('audit-logs-wrap') as any);
const logsPaginationEl = (document.getElementById('audit-logs-pagination') as any);

function formatActor(log: any) {
  const parts: any[] = [];
  if (log.actor_name) parts.push(log.actor_name);
  if (log.actor_phone) parts.push(log.actor_phone);
  if (log.actor_telegram_id) parts.push(`TG ${log.actor_telegram_id}`);
  return parts.length ? parts.join(' · ') : '—';
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

function formatEntity(log: any) {
  const label = log.entity_type_label || log.entity_type || '—';
  if (log.entity_id) {
    return `${label} · ${log.entity_id}`;
  }
  return label;
}

function formatAuditValue(value: any) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectChangeRows(details: any) {
  if (!details || typeof details !== 'object') return [];

  if (details.changes && typeof details.changes === 'object') {
    return Object.entries(details.changes).map(([field, change]: any) => ({
      field,
      from: change && typeof change === 'object' && 'from' in change ? change.from : null,
      to: change && typeof change === 'object' && 'to' in change ? change.to : change,
    }));
  }

  const before = details.before && typeof details.before === 'object' ? details.before : null;
  const after = details.after && typeof details.after === 'object' ? details.after : null;
  if (!before && !after) return [];

  const keys = Array.from(
    new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  );
  return keys
    .map((field: any) => ({
      field,
      from: before ? before[field] : null,
      to: after ? after[field] : null,
    }))
    .filter((row: any) => JSON.stringify(row.from) !== JSON.stringify(row.to));
}

function renderChangeDetails(details: any) {
  const rows = collectChangeRows(details);
  if (!rows.length) return '';

  return `
    <ul class="audit-diff">
      ${rows
        .map(
          (row: any) => `
        <li class="audit-diff__item">
          <span class="audit-diff__field">${escapeHtml(row.field)}</span>
          <span class="audit-diff__from" title="Было">${escapeHtml(formatAuditValue(row.from))}</span>
          <span class="audit-diff__arrow" aria-hidden="true">→</span>
          <span class="audit-diff__to" title="Стало">${escapeHtml(formatAuditValue(row.to))}</span>
        </li>`
        )
        .join('')}
    </ul>
  `;
}

function renderAuditLogsTable() {
  if (!logs.length) {
    const emptyMessage = searchQuery
      ? 'Ничего не найдено. Попробуйте другой запрос.'
      : 'Записей пока нет.';
    logsWrap.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  logsWrap.innerHTML = `
    <div class="table-scroll">
    <table class="data-table order-logs-table audit-logs-table">
      <thead>
        <tr>
          <th>Дата</th>
          <th>Действие</th>
          <th>Объект</th>
          <th>Описание / изменения</th>
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
            <td data-label="Объект">${escapeHtml(formatEntity(log))}</td>
            <td data-label="Описание / изменения">
              <div class="audit-summary">${escapeHtml(log.summary || '—')}</div>
              ${renderChangeDetails(log.details)}
            </td>
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
        loadAuditLogs().catch((error: any) => window.alert(error.message));
      },
      onLimitChange: (limit: any) => {
        pageLimit = limit;
        currentPage = 1;
        loadAuditLogs().catch((error: any) => window.alert(error.message));
      },
    }
  );
}

async function loadAuditLogs() {
  logsWrap.innerHTML = renderLoadingState();
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: String(pageLimit),
  });
  if (searchQuery) {
    params.set('q', searchQuery);
  }
  const data = await api(`/bot-admin/api/logs?${params.toString()}`);
  logs = data.logs || [];
  totalLogs = data.total ?? logs.length;
  currentPage = data.page ?? currentPage;
  pageLimit = data.limit ?? pageLimit;
  updateSearchBoxUi(searchInput, searchClearBtn, searchBox, searchQuery);
  renderAuditLogsTable();
  renderLogsPagination();
}

async function init() {
  await ensureSession({ requiredPermission: 'logs_read' });
  await loadAuditLogs();
}

(document.getElementById('refresh-logs-btn') as any).addEventListener('click', () => {
  loadAuditLogs().catch((error: any) => window.alert(error.message));
});

bindSearchBox({
  input: searchInput,
  clearBtn: searchClearBtn,
  box: searchBox,
  onSearch: (query: any) => {
    searchQuery = query;
    currentPage = 1;
    loadAuditLogs().catch((error: any) => window.alert(error.message));
  },
});

setupLogout();
init().catch((error: any) => {
  document.body.innerHTML = `<main class="page"><p class="message error">${escapeHtml(error.message)}</p></main>`;
});
