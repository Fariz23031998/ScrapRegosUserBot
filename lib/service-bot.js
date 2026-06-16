const crypto = require('crypto');
const { looksLikePhone, normalizePhone } = require('./search-user');
const { createOrder } = require('./partners-db');
const { formatClickUrl } = require('./click');
const { formatPaymentPageUrl } = require('./payments-api');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const ORDER_ACCESS_DENIED = 'Сначала пройдите регистрацию: отправьте свой номер телефона.';
const ENTER_PRICE_TEXT = 'Введите стоимость услуги (сум, только число):';
const ENTER_ADDITIONAL_PHONE_TEXT =
  'Отправьте дополнительный номер телефона, нажмите Пропустить или Отменить.';
const INVALID_PRICE_TEXT = 'Неверная сумма. Введите положительное число.';
const INVALID_PHONE_TEXT = 'Неверный номер телефона.';
const CANCELLED_TEXT = 'Оформление услуги отменено.';

const resultDrafts = new Map();
const pendingOrderSteps = new Map();

function generateToken() {
  return crypto.randomBytes(4).toString('hex');
}

function cleanupOldDrafts() {
  const now = Date.now();
  for (const [token, draft] of resultDrafts.entries()) {
    if (draft.expiresAt <= now) {
      resultDrafts.delete(token);
    }
  }
}

function makeServiceButtonForResult(result, telegramId) {
  cleanupOldDrafts();
  const token = generateToken();
  resultDrafts.set(token, {
    telegramId,
    clientPhone: result.phone || null,
    clientType: result.type || null,
    metadata: JSON.stringify({
      type: result.type || null,
      message: result.message || '',
      recordId: result.recordId ?? null,
      clientName: result.clientName ?? null,
    }),
    expiresAt: Date.now() + DRAFT_TTL_MS,
  });

  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Добавить услуги', callback_data: `svc:start:${token}` }]],
    },
  };
}

function draftActionKeyboard({ showSkip = false } = {}) {
  const rows = [];
  if (showSkip) {
    rows.push([{ text: 'Пропустить', callback_data: 'svc:skip' }]);
  }
  rows.push([{ text: 'Отменить', callback_data: 'svc:cancel' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function menuAfterOrderKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [],
    },
  };
}

function parsePositiveAmount(text) {
  const value = Number(String(text || '').replace(/[^\d]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function setPendingPrice(telegramId, draft) {
  pendingOrderSteps.set(telegramId, { step: 'await_price', ...draft });
}

function setPendingPhone(telegramId, ctx) {
  pendingOrderSteps.set(telegramId, { ...ctx, step: 'await_phone' });
}

function clearPending(telegramId) {
  pendingOrderSteps.delete(telegramId);
}

function getPending(telegramId) {
  return pendingOrderSteps.get(telegramId) ?? null;
}

function isCancelCommand(text) {
  const value = String(text || '').trim().toLowerCase();
  return value === '/cancel' || value === 'отмена' || value === 'cancel';
}

function formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl, extraLine = '') {
  const link = paymentPageUrl || paymentUrl;
  return [
    'Заказ создан.',
    `ID: ${order.id}`,
    `Клиент: ${order.client_phone}`,
    `Сумма: ${order.amount} UZS`,
    extraLine,
    '',
    paymentPageUrl ? 'Страница оплаты:' : 'Ссылка для оплаты:',
    link,
  ]
    .filter(Boolean)
    .join('\n');
}
function createOrderFromContext(db, botUser, ctx, additionalPhone) {
  const id = crypto.randomUUID();
  const order = createOrder(db, {
    id,
    telegramId: botUser.telegram_id,
    botUserPhone: botUser.phone,
    clientPhone: ctx.clientPhone || botUser.phone,
    clientType: ctx.clientType,
    additionalPhone,
    amount: ctx.amount,
    paymentProvider: 'click',
    metadata: ctx.metadata,
  });
  const paymentUrl = formatClickUrl(order.id, order.amount);
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  return { order, paymentUrl, paymentPageUrl };
}

function registerServiceHandlers(bot, { db, getBotUser }) {
  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('svc:')) return;

    const chatId = query.message?.chat?.id;
    const telegramId = query.from.id;
    const botUser = getBotUser(telegramId);
    await bot.answerCallbackQuery(query.id);

    if (!botUser) {
      await bot.sendMessage(chatId, ORDER_ACCESS_DENIED);
      return;
    }

    if (data === 'svc:cancel') {
      const pending = getPending(telegramId);
      if (!pending) {
        return;
      }
      clearPending(telegramId);
      await bot.sendMessage(chatId, CANCELLED_TEXT);
      return;
    }

    if (data === 'svc:skip') {
      const pending = getPending(telegramId);
      if (!pending || pending.step !== 'await_phone') {
        return;
      }
      const { order, paymentUrl, paymentPageUrl } = createOrderFromContext(db, botUser, pending, null);
      clearPending(telegramId);
      await bot.sendMessage(
        chatId,
        formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl),
        menuAfterOrderKeyboard()
      );
      return;
    }

    if (!data.startsWith('svc:start:')) return;
    const token = data.slice('svc:start:'.length);
    const draft = resultDrafts.get(token);
    if (!draft || draft.expiresAt <= Date.now()) {
      resultDrafts.delete(token);
      await bot.sendMessage(chatId, 'Ссылка устарела. Выполните поиск заново.');
      return;
    }
    if (draft.telegramId !== telegramId) {
      await bot.sendMessage(chatId, 'Эта кнопка доступна только пользователю, который выполнил поиск.');
      return;
    }

    setPendingPrice(telegramId, draft);
    await bot.sendMessage(chatId, ENTER_PRICE_TEXT, draftActionKeyboard());
  });
}

async function handleServiceMessage(bot, msg, botUser, db) {
  const pending = getPending(msg.from.id);
  if (!pending) return false;

  if (!botUser) {
    clearPending(msg.from.id);
    await bot.sendMessage(msg.chat.id, ORDER_ACCESS_DENIED);
    return true;
  }

  const text = msg.text?.trim() || '';
  if (isCancelCommand(text)) {
    clearPending(msg.from.id);
    await bot.sendMessage(msg.chat.id, CANCELLED_TEXT);
    return true;
  }

  if (pending.step === 'await_price') {
    const amount = parsePositiveAmount(text);
    if (!amount) {
      await bot.sendMessage(msg.chat.id, INVALID_PRICE_TEXT, draftActionKeyboard());
      return true;
    }
    setPendingPhone(msg.from.id, { ...pending, amount });
    await bot.sendMessage(msg.chat.id, ENTER_ADDITIONAL_PHONE_TEXT, draftActionKeyboard({ showSkip: true }));
    return true;
  }

  if (pending.step === 'await_phone') {
    if (!looksLikePhone(text)) {
      await bot.sendMessage(msg.chat.id, INVALID_PHONE_TEXT, draftActionKeyboard({ showSkip: true }));
      return true;
    }
    const { order, paymentUrl, paymentPageUrl } = createOrderFromContext(db, botUser, pending, normalizePhone(text));
    clearPending(msg.from.id);
    await bot.sendMessage(
      msg.chat.id,
      formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl, `Доп. номер: ${text}`),
      menuAfterOrderKeyboard()
    );
    return true;
  }

  return false;
}

module.exports = {
  registerServiceHandlers,
  handleServiceMessage,
  makeServiceButtonForResult,
};
