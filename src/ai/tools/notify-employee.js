const { getBotUserById } = require('../../db/bot-users-db');

function buildEmployeeNotifyText({ message, ticketId }) {
  const lines = [String(message || '').trim()];
  if (ticketId) {
    const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const link = base ? `${base}/bot-admin/tickets/${ticketId}` : `тикет #${ticketId}`;
    lines.push('', `Тикет: ${link}`);
  }
  return lines.filter((line, index) => line || index === 0).join('\n').trim();
}

async function notifyEmployee(db, { employeeId, message, ticketId, sendTelegram } = {}) {
  const user = getBotUserById(db, employeeId);
  if (!user || user.role !== 'employee') {
    return { ok: false, error: 'employee_not_found' };
  }
  if (user.telegram_id == null) {
    return { ok: false, error: 'no_telegram' };
  }
  const text = buildEmployeeNotifyText({ message, ticketId });
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
  buildEmployeeNotifyText,
  notifyEmployee,
};
