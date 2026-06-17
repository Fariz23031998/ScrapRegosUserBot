const { hasRight } = require('./user-rights');
const {
  getAllUnpaidOrders,
  deletePendingOrder,
  getBotUserByTelegramId,
  getUnpaidOrdersByUserPhone,
} = require('./partners-db');
const { formatUnpaidOrdersBlock, buildDeleteKeyboard } = require('./bot-format');

const ORDER_DENIED = 'Нет доступа к неоплаченным заказам.';
const DELETE_DENIED = 'Нет прав на удаление заказов.';
const DELETE_OK = 'Неоплаченный заказ удалён.';
const DELETE_FAIL = 'Не удалось удалить заказ. Возможно, он уже оплачен.';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

function splitTelegramMessage(text, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxLength));
    offset += maxLength;
  }
  return chunks;
}

async function sendUnpaidOrdersList(bot, chatId, orders, telegramId, db) {
  if (!orders.length) {
    await bot.sendMessage(chatId, 'Неоплаченных заказов нет.');
    return;
  }

  const unpaidBlock = formatUnpaidOrdersBlock(orders);
  const chunks = splitTelegramMessage(unpaidBlock);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk);
  }

  if (hasRight(db, telegramId, 'delete_unpaid_order')) {
    await appendDeleteButtonsForOrders(bot, chatId, orders, telegramId, db);
  }
}

async function sendAllUnpaidOrdersList(bot, chatId, telegramId, db) {
  const orders = getAllUnpaidOrders(db);
  if (!orders.length) {
    await bot.sendMessage(chatId, 'Неоплаченных заказов нет.');
    return;
  }

  const canDelete = hasRight(db, telegramId, 'delete_unpaid_order');
  const header = `Неоплаченные заказы (${orders.length}):`;
  const lines = orders.map((order, index) => {
    const parts = [
      `Заказ ${index + 1}:`,
      `ID: ${order.id}`,
      `Клиент: ${order.client_phone}`,
      `Сумма: ${order.amount} ${order.currency || 'UZS'}`,
      `Статус: ${order.status}`,
    ];
    return parts.join('\n');
  });

  const text = `${header}\n\n${lines.join('\n\n')}`;
  const chunks = splitTelegramMessage(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    const options =
      isLast && canDelete && orders.length === 1
        ? buildDeleteKeyboard(orders[0].id)
        : undefined;
    await bot.sendMessage(chatId, chunks[i], options);
  }

  if (canDelete && orders.length > 1) {
    for (const order of orders) {
      await bot.sendMessage(chatId, `Удалить заказ ${order.id}?`, buildDeleteKeyboard(order.id));
    }
  }
}

function registerOrderActionHandlers(bot, { db }) {
  bot.onText(/^\/order(?:@\w+)?$/i, async (msg) => {
    const telegramId = msg.from.id;
    if (!hasRight(db, telegramId, 'see_own_unpaid_orders')) {
      await bot.sendMessage(msg.chat.id, ORDER_DENIED);
      return;
    }

    const botUser = getBotUserByTelegramId(db, telegramId);
    const orders = getUnpaidOrdersByUserPhone(db, botUser?.phone);
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

  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('order:delete:')) return;

    const chatId = query.message?.chat?.id;
    const telegramId = query.from.id;
    await bot.answerCallbackQuery(query.id);

    if (!hasRight(db, telegramId, 'delete_unpaid_order')) {
      await bot.sendMessage(chatId, DELETE_DENIED);
      return;
    }

    const orderId = data.slice('order:delete:'.length);
    const deleted = deletePendingOrder(db, orderId, telegramId);
    await bot.sendMessage(chatId, deleted ? DELETE_OK : DELETE_FAIL);
  });
}

function appendDeleteButtonsForOrders(bot, chatId, orders, telegramId, db) {
  if (!hasRight(db, telegramId, 'delete_unpaid_order')) return Promise.resolve();
  return Promise.all(
    orders.map((order) =>
      bot.sendMessage(chatId, `Удалить заказ ${order.id}?`, buildDeleteKeyboard(order.id))
    )
  );
}

module.exports = {
  registerOrderActionHandlers,
  appendDeleteButtonsForOrders,
  formatUnpaidOrdersBlock,
};
