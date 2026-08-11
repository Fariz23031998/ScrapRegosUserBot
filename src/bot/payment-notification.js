const TelegramBot = require('node-telegram-bot-api');
const {
  getOrderById,
  claimOrderPaidNotification,
  clearOrderPaidNotificationClaim,
} = require('../db/partners-db');
const { enrichOrderParties, formatOrderPartyLines } = require('./order-parties');
const { formatOrderDateTimeLine } = require('./order-datetime');
const { formatOrderTicketLine } = require('./order-ticket');
const { withHtml, bold, field } = require('./telegram-html');

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

function formatChatId(telegramId) {
  if (typeof telegramId === 'bigint') {
    return telegramId.toString();
  }
  return telegramId;
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

  try {
    const detailedOrder = db ? enrichOrderParties(db, order) : order;
    const text = formatOrderPaidMessage(detailedOrder, { provider });
    // withHtml() returns a mutable copy — node-telegram-bot-api assigns chat_id onto options.
    await bot.sendMessage(formatChatId(telegramId), text, withHtml());
    return { sent: true };
  } catch (err) {
    console.error(
      `[payment-notify] Failed to notify creator ${telegramId} for order ${order.id}:`,
      err.message
    );
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

/**
 * Send the employee "order paid" Telegram message at most once.
 * Uses paid_notified_at as a claim so concurrent Payme syncs can retry safely
 * if the first attempt fails after the order was already marked paid.
 */
async function ensureCreatorPaidNotification(db, order, { provider } = {}) {
  if (!db || !order?.id) {
    return { sent: false, reason: 'missing_args' };
  }

  const current = getOrderById(db, order.id) || order;
  if (current.status !== 'paid') {
    return { sent: false, reason: 'not_paid' };
  }
  if (current.paid_notified_at) {
    return { sent: false, reason: 'already_notified' };
  }

  if (!claimOrderPaidNotification(db, current.id)) {
    return { sent: false, reason: 'already_notified' };
  }

  const result = await module.exports.notifyCreatorOrderPaid(current, {
    provider: provider || current.payment_provider || null,
    db,
  });

  if (!result.sent) {
    clearOrderPaidNotificationClaim(db, current.id);
  }

  return result;
}

module.exports = {
  getOutboundBot,
  formatOrderPaidMessage,
  notifyCreatorOrderPaid,
  ensureCreatorPaidNotification,
};
