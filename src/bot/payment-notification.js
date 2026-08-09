const TelegramBot = require('node-telegram-bot-api');
const { enrichOrderParties, formatOrderPartyLines } = require('./order-parties');
const { formatOrderDateTimeLine } = require('./order-datetime');
const { formatOrderTicketLine } = require('./order-ticket');
const { TELEGRAM_HTML, bold, field } = require('./telegram-html');

let outboundBot = null;

function getOutboundBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return null;
  }
  if (!outboundBot) {
    // Send-only client — polling stays exclusive to apps/bot.
    outboundBot = new TelegramBot(token, { polling: false });
  }
  return outboundBot;
}

function formatOrderPaidMessage(order, { provider } = {}) {
  const currency = order.currency || 'UZS';
  const providerLabel = provider || order.payment_provider || 'unknown';
  return [
    `✅ ${bold('Заказ оплачен.')}`,
    field('🆔', 'ID', order.id),
    ...formatOrderPartyLines(order),
    formatOrderDateTimeLine(order),
    formatOrderTicketLine(order),
    field('💳', 'Сумма', `${order.amount} ${currency}`),
    field('🏦', 'Провайдер', providerLabel),
  ]
    .filter(Boolean)
    .join('\n');
}

async function notifyCreatorOrderPaid(order, { provider, db } = {}) {
  const telegramId = order?.telegram_id;
  if (telegramId == null) {
    return { sent: false, reason: 'no_telegram_id' };
  }

  const bot = getOutboundBot();
  if (!bot) {
    console.warn('[payment-notify] TELEGRAM_BOT_TOKEN not set — skipping paid notification.');
    return { sent: false, reason: 'no_token' };
  }

  const detailedOrder = db ? enrichOrderParties(db, order) : order;
  const text = formatOrderPaidMessage(detailedOrder, { provider });
  try {
    await bot.sendMessage(telegramId, text, TELEGRAM_HTML);
    return { sent: true };
  } catch (err) {
    console.error(
      `[payment-notify] Failed to notify creator ${telegramId} for order ${order.id}:`,
      err.message
    );
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = {
  getOutboundBot,
  formatOrderPaidMessage,
  notifyCreatorOrderPaid,
};
