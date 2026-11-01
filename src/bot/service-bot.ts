import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';
import { looksLikePhone, normalizePhone } from './search-user';
import { createOrder, getBotUsersByPhone } from '../db/partners-db';
import { isLinkedEmployee } from '../db/bot-users-db';
import { formatClickUrlSafe } from '../payments/click';
import { formatPaymentPageUrl, getDefaultPaymentProvider } from '../payments/payments-api';
import { enqueueOrderPaymentSms } from '../sms/sms-queue';
import { createSupportDraft } from './technical-support-bot';
import { createTariffInfoToken } from './tariff-info-bot';
import { hasRight } from '../db/user-rights';
import { answerCallbackQuerySafe, onCallbackQuery, sendChatActionSafe } from './telegram-safe';
import { enrichOrderParties, formatOrderPartyLines } from './order-parties';
import { formatOrderDateTimeLine } from './order-datetime';
import { formatOrderTicketLine } from './order-ticket';
import { bold, field, link, withHtml } from './telegram-html';

const DRAFT_TTL_MS = 30 * 60 * 1000;
const ORDER_ACCESS_DENIED = 'Сначала пройдите регистрацию: отправьте свой номер телефона.';
const ENTER_PRICE_TEXT = 'Введите стоимость услуги (сум, только число):';
const ENTER_ADDITIONAL_PHONE_TEXT =
  'Отправьте дополнительный номер телефона, нажмите Пропустить или Отменить.';
const INVALID_PRICE_TEXT = 'Неверная сумма. Введите положительное число.';
const INVALID_PHONE_TEXT = 'Неверный номер телефона.';
const CANCELLED_TEXT = 'Оформление услуги отменено.';

const resultDrafts: Map<any, any> = new Map();
const pendingOrderSteps: Map<any, any> = new Map();

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

function makeServiceButtonForResult(result: any, telegramId: any, db: Db = null!) {
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

  const row = [{ text: 'Добавить услуги', callback_data: `svc:start:${token}` }];
  if (result.phone && db && hasRight(db, telegramId, 'create_technical_support')) {
    const supportToken = createSupportDraft(result, telegramId);
    row.push({ text: 'Добавить ТП', callback_data: `ts:start:${supportToken}` });
  }

  const rows = [row];
  const tariffToken = createTariffInfoToken(result, telegramId);
  if (tariffToken) {
    rows.push([{ text: 'О тарифе', callback_data: `tariff:info:${tariffToken}` }]);
  }

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function draftActionKeyboard({ showSkip = false }: Unchecked = {}) {
  const rows: any[] = [];
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

function parsePositiveAmount(text?: any) {
  const value = Number(String(text || '').replace(/[^\d]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function setPendingPrice(telegramId?: any, draft?: any) {
  pendingOrderSteps.set(telegramId, { step: 'await_price', ...draft });
}

function setPendingPhone(telegramId?: any, ctx?: any) {
  pendingOrderSteps.set(telegramId, { ...ctx, step: 'await_phone' });
}

function clearPending(telegramId?: any) {
  pendingOrderSteps.delete(telegramId);
}

function getPending(telegramId?: any) {
  return pendingOrderSteps.get(telegramId) ?? null;
}

function isCancelCommand(text?: any) {
  const value = String(text || '').trim().toLowerCase();
  return value === '/cancel' || value === 'отмена' || value === 'cancel';
}

function formatOrderPaymentMessage(order: any, paymentPageUrl: any, paymentUrl: any, extraLine: any = '') {
  const href = paymentPageUrl || paymentUrl;
  return [
    `🆕 ${bold('Заказ создан.')}`,
    field('🆔', 'ID', order.id),
    ...formatOrderPartyLines(order),
    formatOrderDateTimeLine(order),
    formatOrderTicketLine(order),
    field('💳', 'Сумма', `${order.amount} UZS`),
    extraLine,
    '',
    href
      ? `🔗 ${link(href, paymentPageUrl ? 'Страница оплаты' : 'Ссылка для оплаты')}`
      : '⚠️ Ссылка на оплату недоступна: задайте PUBLIC_BASE_URL.',
  ]
    .filter(Boolean)
    .join('\n');
}
function createOrderFromContext(db: Db, botUser?: any, ctx?: any, additionalPhone?: any) {
  const id = crypto.randomUUID();
  const order = createOrder(db, {
    id,
    telegramId: botUser.telegram_id,
    botUserPhone: botUser.phone,
    clientPhone: ctx.clientPhone || botUser.phone,
    clientType: ctx.clientType,
    additionalPhone,
    amount: ctx.amount,
    paymentProvider: getDefaultPaymentProvider(),
    metadata: ctx.metadata,
    ticketId: ctx.ticketId ?? null,
  });
  const detailedOrder = enrichOrderParties(db, order);
  const paymentUrl = formatClickUrlSafe(detailedOrder.id, detailedOrder.amount);
  const paymentPageUrl = formatPaymentPageUrl(order!.id);
  return { order: detailedOrder, paymentUrl, paymentPageUrl };
}

function formatCustomerCreatedOrderMessage(order?: any) {
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  return [
    `🆕 ${bold('Создана ссылка для оплаты услуги.')}`,
    field('🆔', 'ID', order.id),
    ...formatOrderPartyLines(order),
    formatOrderDateTimeLine(order),
    formatOrderTicketLine(order),
    field('💳', 'Сумма', `${order.amount} ${order.currency || 'UZS'}`),
    '',
    paymentPageUrl
      ? `🔗 ${link(paymentPageUrl, 'Страница оплаты')}`
      : 'Ссылка на оплату доступна после открытия заказа.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function afterOrderCreated(bot: TelegramBot, db: Db, botUser?: any, order?: any, paymentPageUrl?: any) {
  try {
    await notifyCustomersAboutOrder(bot, db, botUser, order);
  } catch (err: any) {
    console.error('[service] Customer Bot API notify failed:', err.message);
  }
  await enqueueOrderPaymentSms(db, order, paymentPageUrl);
}

async function notifyCustomersAboutOrder(bot: TelegramBot, db: Db, botUser?: any, order?: any) {
  if (!bot) return;

  const candidates: any[] = [];
  candidates.push(getBotUsersByPhone(db, order.client_phone));
  if (order.additional_phone) {
    candidates.push(getBotUsersByPhone(db, order.additional_phone));
  }

  const byTelegramId: Map<any, any> = new Map();
  for (const group of candidates) {
    for (const u of group) {
      if (botUser && u.telegram_id === botUser.telegram_id) continue; // avoid notifying the creator
      byTelegramId.set(u.telegram_id, u);
    }
  }

  if (byTelegramId.size === 0) return;

  const text = formatCustomerCreatedOrderMessage(order);
  for (const u of byTelegramId.values()) {
    try {
      await bot.sendMessage(u.telegram_id, text, withHtml());
    } catch (err: any) {
      // Bot API cannot DM users who never started the bot / deleted the chat.
      console.warn(
        `[service] Skip Bot API notify for telegram_id=${u.telegram_id}: ${err.message}`
      );
    }
  }
}

function registerServiceHandlers(bot: TelegramBot, { db, getBotUser }: Unchecked) {
  onCallbackQuery(bot, 'service', async (query?: any) => {
    const data = query.data || '';
    if (!data.startsWith('svc:')) return;

    const chatId = query.message?.chat?.id;
    const telegramId = query.from.id;
    const botUser = getBotUser(telegramId);
    await answerCallbackQuerySafe(bot, query.id);

    if (!botUser || !isLinkedEmployee(botUser)) {
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
      await sendChatActionSafe(bot, chatId);
      await bot.sendMessage(
        chatId,
        formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl),
        withHtml(menuAfterOrderKeyboard())
      );
      await afterOrderCreated(bot, db, botUser, order, paymentPageUrl);
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

async function handleServiceMessage(bot: TelegramBot, msg: any, botUser: any, db: Db) {
  const pending = getPending(msg.from.id);
  if (!pending) return false;

  if (!botUser || !isLinkedEmployee(botUser)) {
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
    await sendChatActionSafe(bot, msg.chat.id);
    await bot.sendMessage(
      msg.chat.id,
      formatOrderPaymentMessage(order, paymentPageUrl, paymentUrl),
      withHtml(menuAfterOrderKeyboard())
    );
    await afterOrderCreated(bot, db, botUser, order, paymentPageUrl);
    return true;
  }

  return false;
}

export {
  registerServiceHandlers,
  handleServiceMessage,
  makeServiceButtonForResult,
  parsePositiveAmount,
  createOrderFromContext,
  formatOrderPaymentMessage,
  afterOrderCreated,
  notifyCustomersAboutOrder,
};
