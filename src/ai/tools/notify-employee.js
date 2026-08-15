const { getBotUserById } = require('../../db/bot-users-db');

function formatClientNotifyLines(client) {
  if (!client || typeof client !== 'object') return [];
  const lines = [];
  const name = String(client.name || '').trim();
  const phone = String(client.phone || '').trim();
  const id = client.id != null && String(client.id).trim() !== '' ? String(client.id).trim() : '';
  const email = String(client.email || '').trim();
  if (name) lines.push(`Клиент: ${name}`);
  if (phone) lines.push(`Телефон: ${phone}`);
  if (id) lines.push(`ID клиента: ${id}`);
  if (email) lines.push(`Email: ${email}`);
  return lines;
}

function buildEmployeeNotifyText({ message, ticketId, client } = {}) {
  const parts = [];
  const body = String(message || '').trim();
  if (body) parts.push(body);

  const clientLines = formatClientNotifyLines(client);
  if (clientLines.length) parts.push(clientLines.join('\n'));

  if (ticketId) {
    const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const link = base ? `${base}/bot-admin/tickets/${ticketId}` : `тикет #${ticketId}`;
    parts.push(`Тикет: ${link}`);
  }

  return parts.join('\n\n').trim();
}

async function notifyEmployee(db, { employeeId, message, ticketId, client, sendTelegram } = {}) {
  const user = getBotUserById(db, employeeId);
  if (!user || user.role !== 'employee') {
    return { ok: false, error: 'employee_not_found' };
  }
  if (user.telegram_id == null) {
    return { ok: false, error: 'no_telegram' };
  }
  const text = buildEmployeeNotifyText({ message, ticketId, client });
  if (!text) return { ok: false, error: 'empty_message' };

  const send =
    sendTelegram ||
    (async (telegramId, body) => {
      const { getOutboundBot } = require('../../bot/payment-notification');
      const bot = getOutboundBot();
      if (!bot) throw new Error('no_bot');
      await bot.sendMessage(telegramId, body);
    });

  try {
    await send(user.telegram_id, text);
    return {
      ok: true,
      employee_id: user.id,
      display_name: user.display_name || null,
    };
  } catch (error) {
    return { ok: false, error: error.message || 'notify_failed' };
  }
}

module.exports = {
  formatClientNotifyLines,
  buildEmployeeNotifyText,
  notifyEmployee,
};
