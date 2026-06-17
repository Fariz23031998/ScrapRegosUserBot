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

function renderOrderLogsTable(logs) {
  const wrap = document.getElementById('order-logs-wrap');
  if (!logs.length) {
    wrap.innerHTML = '<p class="empty-state">Записей пока нет.</p>';
    return;
  }

  wrap.innerHTML = `
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

async function loadOrderLogs() {
  const data = await api('/bot-admin/api/order-logs');
  renderOrderLogsTable(data.logs || []);
}

document.getElementById('refresh-logs-btn').addEventListener('click', () => {
  loadOrderLogs().catch((error) => window.alert(error.message));
});

window.addEventListener('bot-admin-ready', () => {
  loadOrderLogs().catch((error) => window.alert(error.message));
});
