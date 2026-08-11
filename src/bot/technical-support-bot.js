const crypto = require('crypto');
const { isLinkedEmployee } = require('../db/bot-users-db');
const { hasRight } = require('../db/user-rights');
const { createOrder, getBotUsersByPhone } = require('../db/partners-db');
const {
  PRODUCT_TYPE,
  listTechnicalSupportPrices,
  getTechnicalSupportPrice,
} = require('../db/technical-support');
const { formatClickUrlSafe } = require('../payments/click');
const { formatPaymentPageUrl, getDefaultPaymentProvider } = require('../payments/payments-api');
const { enqueueOrderPaymentSms } = require('../sms/sms-queue');
const { answerCallbackQuerySafe, onCallbackQuery, sendChatActionSafe } = require('./telegram-safe');
const { enrichOrderParties, formatOrderPartyLines } = require('./order-parties');
const { formatOrderDateTimeLine } = require('./order-datetime');
const { formatOrderTicketLine } = require('./order-ticket');
const { withHtml, bold, field, link } = require('./telegram-html');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const ACCESS_DENIED = 'Сначала пройдите регистрацию: отправьте свой номер телефона.';
const PERMISSION_DENIED = 'Доступ запрещён. Нет права на создание подписок технической поддержки.';
const CANCELLED_TEXT = 'Оформление техподдержки отменено.';
const NO_PHONE_TEXT = 'Для оформления ТП нужен номер телефона клиента.';
const NO_PRICES_TEXT =
  'Цены на техподдержку не настроены. Задайте их в админ-панели (Техподдержка).';
const DURATION_UNAVAILABLE_TEXT = 'Этот срок ТП сейчас недоступен. Выберите другой срок или настройте цену.';

const supportDrafts = new Map();
const pendingSupportSteps = new Map();

function generateToken() {
  return crypto.randomBytes(4).toString('hex');
}

function cleanupOldDrafts() {
  const now = Date.now();
  for (const [token, draft] of supportDrafts.entries()) {
    if (draft.expiresAt <= now) {
      supportDrafts.delete(token);
    }
  }
}

function formatAmount(amount) {
  return `${Number(amount).toLocaleString('ru-RU')} UZS`;
}

function durationLabel(months) {
  if (months === 1) return '1 месяц';
  if (months === 3) return '3 месяца';
  if (months === 6) return '6 месяцев';
  return '12 месяцев';
}

function createSupportDraft(result, telegramId) {
  cleanupOldDrafts();
  const token = generateToken();
  supportDrafts.set(token, {
    telegramId,
    clientPhone: result.phone || null,
    clientType: result.type || null,
    metadataBase: {
      type: result.type || null,
      message: result.message || '',
      recordId: result.recordId ?? null,
      clientName: result.clientName ?? null,
    },
    expiresAt: Date.now() + DRAFT_TTL_MS,
  });
  return token;
}

function getDraft(token) {
  cleanupOldDrafts();
  return supportDrafts.get(token) ?? null;
}

function clearPending(telegramId) {
  pendingSupportSteps.delete(telegramId);
}

function getPending(telegramId) {
  return pendingSupportSteps.get(telegramId) ?? null;
}

function cancelKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Отменить', callback_data: 'ts:cancel' }]],
    },
  };
}

function durationKeyboard(prices) {
  const rows = [];
  for (const price of prices) {
    if (!price.configured) continue;
    rows.push([
      {
        text: `${durationLabel(price.months)} — ${formatAmount(price.amount)}`,
        callback_data: `ts:months:${price.months}`,
      },
    ]);
  }
  rows.push([{ text: 'Отменить', callback_data: 'ts:cancel' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl, months) {
  const href = paymentPageUrl || paymentUrl;
  return [
    `🆕 ${bold('Заказ техподдержки создан.')}`,
    field('🆔', 'ID', order.id),
    ...formatOrderPartyLines(order),
    formatOrderDateTimeLine(order),
    formatOrderTicketLine(order),
    field('⏱', 'Срок', durationLabel(months)),
    field('💳', 'Сумма', `${order.amount} UZS`),
    '',
    href
      ? `🔗 ${link(href, paymentPageUrl ? 'Страница оплаты' : 'Ссылка для оплаты')}`
      : '⚠️ Ссылка на оплату недоступна: задайте PUBLIC_BASE_URL.',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatCustomerCreatedOrderMessage(order, months) {
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  return [
    `🆕 ${bold('Создана ссылка для оплаты техподдержки.')}`,
    field('🆔', 'ID', order.id),
    ...formatOrderPartyLines(order),
    formatOrderDateTimeLine(order),
    formatOrderTicketLine(order),
    field('⏱', 'Срок', durationLabel(months)),
    field('💳', 'Сумма', `${order.amount} ${order.currency || 'UZS'}`),
    '',
    paymentPageUrl
      ? `🔗 ${link(paymentPageUrl, 'Страница оплаты')}`
      : 'Ссылка на оплату доступна после открытия заказа.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function notifyCustomersAboutOrder(bot, db, botUser, order, months) {
  const candidates = [getBotUsersByPhone(db, order.client_phone)];
  const byTelegramId = new Map();
  for (const group of candidates) {
    for (const user of group) {
      if (botUser && user.telegram_id === botUser.telegram_id) continue;
      byTelegramId.set(user.telegram_id, user);
    }
  }
  if (byTelegramId.size === 0) return;

  const text = formatCustomerCreatedOrderMessage(order, months);
  for (const user of byTelegramId.values()) {
    try {
      await bot.sendMessage(user.telegram_id, text, withHtml());
    } catch (err) {
      console.warn(
        `[tech-support] Skip Bot API notify for telegram_id=${user.telegram_id}: ${err.message}`
      );
    }
  }
}

function createSupportOrder(db, botUser, draft, months, amount) {
  const id = crypto.randomUUID();
  const metadata = JSON.stringify({
    product_type: PRODUCT_TYPE,
    months,
    amount,
    ...draft.metadataBase,
  });

  const order = createOrder(db, {
    id,
    telegramId: botUser.telegram_id,
    botUserPhone: botUser.phone,
    clientPhone: draft.clientPhone,
    clientType: draft.clientType,
    additionalPhone: null,
    amount,
    paymentProvider: getDefaultPaymentProvider(),
    metadata,
  });
  const detailedOrder = enrichOrderParties(db, order);
  const paymentUrl = formatClickUrlSafe(detailedOrder.id, detailedOrder.amount);
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  return { order: detailedOrder, paymentUrl, paymentPageUrl };
}

async function startSupportPurchase(bot, chatId, telegramId, db, token) {
  const draft = getDraft(token);
  if (!draft || draft.expiresAt <= Date.now()) {
    supportDrafts.delete(token);
    await bot.sendMessage(chatId, 'Ссылка устарела. Выполните поиск заново.');
    return;
  }
  if (draft.telegramId !== telegramId) {
    await bot.sendMessage(chatId, 'Эта кнопка доступна только пользователю, который выполнил поиск.');
    return;
  }
  if (!draft.clientPhone) {
    await bot.sendMessage(chatId, NO_PHONE_TEXT);
    return;
  }

  const prices = listTechnicalSupportPrices(db).filter((item) => item.configured);
  if (!prices.length) {
    await bot.sendMessage(chatId, NO_PRICES_TEXT);
    return;
  }

  pendingSupportSteps.set(telegramId, {
    step: 'await_months',
    ...draft,
  });
  await bot.sendMessage(chatId, 'Выберите срок техподдержки:', durationKeyboard(prices));
}

async function completeSupportPurchase(bot, chatId, telegramId, db, botUser, months) {
  const pending = getPending(telegramId);
  if (!pending || pending.step !== 'await_months') {
    return;
  }

  const price = getTechnicalSupportPrice(db, months);
  if (!price || !price.configured) {
    await bot.sendMessage(chatId, DURATION_UNAVAILABLE_TEXT, cancelKeyboard());
    return;
  }

  await sendChatActionSafe(bot, chatId);
  const { order, paymentUrl, paymentPageUrl } = createSupportOrder(
    db,
    botUser,
    pending,
    price.months,
    price.amount
  );
  clearPending(telegramId);

  await bot.sendMessage(
    chatId,
    formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl, price.months),
    withHtml()
  );
  try {
    await notifyCustomersAboutOrder(bot, db, botUser, order, price.months);
  } catch (err) {
    console.error('[tech-support] Customer Bot API notify failed:', err.message);
  }
  await enqueueOrderPaymentSms(db, order, paymentPageUrl);
}

function registerTechnicalSupportHandlers(bot, { db, getBotUser }) {
  onCallbackQuery(bot, 'technical support', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('ts:')) return;

    const chatId = query.message?.chat?.id;
    const telegramId = query.from.id;
    const botUser = getBotUser(telegramId);
    await answerCallbackQuerySafe(bot, query.id);

    if (!botUser || !isLinkedEmployee(botUser)) {
      await bot.sendMessage(chatId, ACCESS_DENIED);
      return;
    }
    if (!hasRight(db, telegramId, 'create_technical_support')) {
      clearPending(telegramId);
      await bot.sendMessage(chatId, PERMISSION_DENIED);
      return;
    }

    if (data === 'ts:cancel') {
      if (getPending(telegramId)) {
        clearPending(telegramId);
        await bot.sendMessage(chatId, CANCELLED_TEXT);
      }
      return;
    }

    if (data.startsWith('ts:start:')) {
      const token = data.slice('ts:start:'.length);
      await startSupportPurchase(bot, chatId, telegramId, db, token);
      return;
    }

    if (data.startsWith('ts:months:')) {
      const months = Number(data.slice('ts:months:'.length));
      await completeSupportPurchase(bot, chatId, telegramId, db, botUser, months);
    }
  });
}

async function handleTechnicalSupportMessage(bot, msg, botUser, db) {
  const pending = getPending(msg.from.id);
  if (!pending) return false;

  if (!botUser || !isLinkedEmployee(botUser)) {
    clearPending(msg.from.id);
    await bot.sendMessage(msg.chat.id, ACCESS_DENIED);
    return true;
  }
  if (!hasRight(db, msg.from.id, 'create_technical_support')) {
    clearPending(msg.from.id);
    await bot.sendMessage(msg.chat.id, PERMISSION_DENIED);
    return true;
  }

  const text = String(msg.text || '').trim().toLowerCase();
  if (text === '/cancel' || text === 'отмена' || text === 'cancel') {
    clearPending(msg.from.id);
    await bot.sendMessage(msg.chat.id, CANCELLED_TEXT);
    return true;
  }

  if (pending.step === 'await_months') {
    await bot.sendMessage(
      msg.chat.id,
      'Выберите срок кнопкой ниже или нажмите Отменить.',
      cancelKeyboard()
    );
    return true;
  }

  return false;
}

module.exports = {
  registerTechnicalSupportHandlers,
  handleTechnicalSupportMessage,
  createSupportDraft,
  durationLabel,
  formatAmount,
};
