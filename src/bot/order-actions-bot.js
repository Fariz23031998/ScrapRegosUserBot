const { hasRight } = require('../db/user-rights');
const {
  getAllUnpaidOrders,
  deletePendingOrder,
  markPendingOrderPaidCash,
  getUnpaidOrdersByCreatorTelegramId,
  getOrderById,
} = require('../db/partners-db');
const { formatPaymentPageUrl } = require('../payments/payments-api');
const { enqueueOrderPaymentSms } = require('../sms/sms-queue');
const { formatUnpaidOrderMessage, buildOrderActionsKeyboard } = require('./bot-format');
const { answerCallbackQuerySafe, onCallbackQuery } = require('./telegram-safe');
const { enrichOrderParties } = require('./order-parties');

const ORDER_DENIED = 'Нет доступа к неоплаченным заказам.';
const DELETE_DENIED = 'Нет прав на удаление заказов.';
const DELETE_OK = 'Неоплаченный заказ удалён.';
const DELETE_FAIL = 'Не удалось удалить заказ. Возможно, он уже оплачен.';
const PAID_CASH_DENIED = 'Нет прав на отметку оплаты наличными.';
const PAID_CASH_OK = 'Заказ закрыт: Оплачено наличными.';
const PAID_CASH_FAIL = 'Не удалось закрыть заказ. Возможно, он уже оплачен или удалён.';
const RENOTIFY_DENIED = 'Нет прав на повторное уведомление о заказе.';
const RENOTIFY_FAIL = 'Не удалось уведомить. Заказ не найден или уже оплачен.';
const RENOTIFY_NO_URL = 'Не удалось уведомить: не задан PUBLIC_BASE_URL.';
const RENOTIFY_NO_PHONE = 'Не удалось уведомить: нет телефона клиента.';
const RENOTIFY_NO_PROVIDERS = 'Не удалось уведомить: нет включённых каналов уведомления.';
const RENOTIFY_OK = 'Уведомление о заказе отправлено повторно.';

function formatRenotifyResultMessage(result) {
  if (!result) return RENOTIFY_FAIL;
  if (result.skipped) {
    if (result.reason === 'no_url') return RENOTIFY_NO_URL;
    if (result.reason === 'no_phone' || result.reason === 'invalid_phone') return RENOTIFY_NO_PHONE;
    if (result.reason === 'no_providers') return RENOTIFY_NO_PROVIDERS;
    return RENOTIFY_FAIL;
  }

  const parts = [];
  if (result.getsms?.sent) parts.push('GETSMS');
  if (result.gateway?.queued) parts.push('SMS gateway');
  if (result.mtproto?.sent) parts.push('Telegram');
  if (!parts.length) return RENOTIFY_NO_PROVIDERS;
  return `${RENOTIFY_OK} (${parts.join(', ')})`;
}

async function sendOrdersWithActions(bot, chatId, orders, telegramId, db, { includeClientPhone = false } = {}) {
  if (!orders.length) {
    await bot.sendMessage(chatId, 'Неоплаченных заказов нет.');
    return;
  }

  const canDelete = hasRight(db, telegramId, 'delete_unpaid_order');
  const canMarkPaidCash = hasRight(db, telegramId, 'mark_paid_cash');
  const canRenotify = hasRight(db, telegramId, 'renotify_order');

  for (const order of orders) {
    const detailedOrder = enrichOrderParties(db, order);
    const text = formatUnpaidOrderMessage(detailedOrder, { includeClientPhone });
    const options = buildOrderActionsKeyboard(order.id, {
      canDelete,
      canMarkPaidCash,
      canRenotify,
    });
    await bot.sendMessage(chatId, text, options);
  }
}

async function sendUnpaidOrdersList(bot, chatId, orders, telegramId, db) {
  await sendOrdersWithActions(bot, chatId, orders, telegramId, db);
}

async function sendAllUnpaidOrdersList(bot, chatId, telegramId, db) {
  const orders = getAllUnpaidOrders(db);
  await sendOrdersWithActions(bot, chatId, orders, telegramId, db, { includeClientPhone: true });
}

function registerOrderActionHandlers(bot, { db }) {
  bot.onText(/^\/order(?:@\w+)?$/i, async (msg) => {
    const telegramId = msg.from.id;
    if (!hasRight(db, telegramId, 'see_own_unpaid_orders')) {
      await bot.sendMessage(msg.chat.id, ORDER_DENIED);
      return;
    }

    const orders = getUnpaidOrdersByCreatorTelegramId(db, telegramId);
    await sendUnpaidOrdersList(bot, msg.chat.id, orders, telegramId, db);
  });

  bot.onText(/^\/orders(?:@\w+)?$/i, async (msg) => {
    const telegramId = msg.from.id;
    if (!hasRight(db, telegramId, 'see_all_unpaid_orders')) {
      await bot.sendMessage(msg.chat.id, ORDER_DENIED);
      return;
    }

    await sendAllUnpaidOrdersList(bot, msg.chat.id, telegramId, db);
  });

  onCallbackQuery(bot, 'order action', async (query) => {
    const data = query.data || '';
    const isDelete = data.startsWith('order:delete:');
    const isPaidCash = data.startsWith('order:paid_cash:');
    const isRenotify = data.startsWith('order:renotify:');
    if (!isDelete && !isPaidCash && !isRenotify) return;

    const chatId = query.message?.chat?.id;
    const telegramId = query.from.id;
    await answerCallbackQuerySafe(bot, query.id);

    if (isDelete) {
      if (!hasRight(db, telegramId, 'delete_unpaid_order')) {
        await bot.sendMessage(chatId, DELETE_DENIED);
        return;
      }

      const orderId = data.slice('order:delete:'.length);
      const deleted = deletePendingOrder(db, orderId, telegramId);
      await bot.sendMessage(chatId, deleted ? DELETE_OK : DELETE_FAIL);
      return;
    }

    if (isPaidCash) {
      if (!hasRight(db, telegramId, 'mark_paid_cash')) {
        await bot.sendMessage(chatId, PAID_CASH_DENIED);
        return;
      }

      const orderId = data.slice('order:paid_cash:'.length);
      const closed = markPendingOrderPaidCash(db, orderId, telegramId);
      await bot.sendMessage(chatId, closed ? PAID_CASH_OK : PAID_CASH_FAIL);
      return;
    }

    if (!hasRight(db, telegramId, 'renotify_order')) {
      await bot.sendMessage(chatId, RENOTIFY_DENIED);
      return;
    }

    const orderId = data.slice('order:renotify:'.length);
    const order = getOrderById(db, orderId);
    if (!order || order.status !== 'pending') {
      await bot.sendMessage(chatId, RENOTIFY_FAIL);
      return;
    }

    const paymentPageUrl = formatPaymentPageUrl(order.id);
    const result = await enqueueOrderPaymentSms(db, order, paymentPageUrl);
    await bot.sendMessage(chatId, formatRenotifyResultMessage(result));
  });
}

module.exports = {
  registerOrderActionHandlers,
  sendOrdersWithActions,
  formatRenotifyResultMessage,
};
