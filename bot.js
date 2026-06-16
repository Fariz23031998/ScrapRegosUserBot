require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { searchUser, looksLikePhone } = require('./lib/search-user');
const { openDb, getBotUser, registerBotUser, getUnpaidOrdersByClientPhone } = require('./lib/partners-db');
const { isPhoneAllowed, normalizeRegisteredPhone } = require('./lib/bot-users');
const { registerVipHandlers, handleVipMessage } = require('./lib/vip-bot');
const { registerServiceHandlers, handleServiceMessage, makeServiceButtonForResult } = require('./lib/service-bot');
const { formatClickUrl } = require('./lib/click');
const { formatPaymentPageUrl } = require('./lib/payments-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env or environment variables.');
  process.exit(1);
}

const db = openDb();
const bot = new TelegramBot(token, { polling: true });

const HELP_TEXT = [
  'Отправьте номер телефона, код лицензии или API-логин для поиска.',
  '',
  'Поля поиска:',
  '- телефон партнёра (partners.phone)',
  '- телефон / код лицензии (licenses.phone / licenses.code)',
  '- телефон / код аккаунта RPOS (rpos_clients.phone / rpos_accounts.code)',
  '- API-логин (partner_accounts.api_login)',
  '',
  'Совпадения по телефону из разных источников возвращаются вместе.',
  'Для записей старше 3 месяцев добавляется: Срок технической поддержки истёк.',
].join('\n');

const REGISTER_PROMPT = [
  'Бот поиска пользователей Regos',
  '',
  'Для доступа нажмите кнопку ниже и отправьте свой номер телефона.',
  'Номер должен быть в списке разрешённых.',
].join('\n');

const REGISTER_SUCCESS = 'Регистрация успешна. Теперь вы можете выполнять поиск.';
const ACCESS_DENIED = 'Ваш номер телефона не найден в списке разрешённых. Доступ запрещён.';

const REGISTER_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📱 Отправить номер телефона', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

const REMOVE_KEYBOARD = {
  reply_markup: {
    remove_keyboard: true,
  },
};

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

function sendRegisterPrompt(chatId) {
  return bot.sendMessage(chatId, REGISTER_PROMPT, REGISTER_KEYBOARD);
}

function splitTelegramMessage(text, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  const separator = '\n\n---\n\n';
  const parts = text.split(separator);
  let current = '';

  for (const part of parts) {
    const piece = current ? `${current}${separator}${part}` : part;
    if (piece.length <= maxLength) {
      current = piece;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (part.length <= maxLength) {
      current = part;
      continue;
    }

    let offset = 0;
    while (offset < part.length) {
      chunks.push(part.slice(offset, offset + maxLength));
      offset += maxLength;
    }
    current = '';
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function sendBotMessage(chatId, text, options) {
  const chunks = splitTelegramMessage(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const chunkOptions = i === chunks.length - 1 ? options : undefined;
    await bot.sendMessage(chatId, chunk, chunkOptions);
  }
}

function formatUnpaidOrderLines(order) {
  const paymentPageUrl = formatPaymentPageUrl(order.id);
  let paymentUrl = null;
  try {
    paymentUrl = formatClickUrl(order.id, order.amount);
  } catch {
    paymentUrl = null;
  }
  const paymentLink = paymentPageUrl || paymentUrl;
  const lines = [
    `ID: ${order.id}`,
    `Сумма: ${order.amount} ${order.currency || 'UZS'}`,
    `Статус: ${order.status}`,
  ];
  if (paymentLink) {
    lines.push(`${paymentPageUrl ? 'Страница оплаты' : 'Ссылка на оплату'}: ${paymentLink}`);
  }
  return lines;
}

function formatUnpaidOrdersBlock(orders) {
  if (!orders.length) return '';

  const header =
    orders.length === 1
      ? 'Есть неоплаченный заказ:'
      : `Есть неоплаченные заказы (${orders.length}):`;

  const blocks = orders.map((order, index) => {
    const lines = formatUnpaidOrderLines(order);
    if (orders.length === 1) {
      return lines.join('\n');
    }
    return [`Заказ ${index + 1}:`, ...lines].join('\n');
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

async function sendSearchResultWithAction(chatId, telegramId, entry) {
  let text = entry.message || '';
  const unpaidOrders = getUnpaidOrdersByClientPhone(db, entry.phone);
  const unpaidBlock = formatUnpaidOrdersBlock(unpaidOrders);
  if (unpaidBlock) {
    text = `${text}\n\n${unpaidBlock}`;
  }

  const chunks = splitTelegramMessage(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    if (isLast) {
      await bot.sendMessage(chatId, chunks[i], makeServiceButtonForResult(entry, telegramId));
    } else {
      await bot.sendMessage(chatId, chunks[i]);
    }
  }
}
function getPhoneFromMessage(msg) {
  if (msg.contact?.phone_number) {
    return msg.contact.phone_number;
  }
  return msg.text?.trim() || null;
}

function tryRegisterUser(msg) {
  const phoneInput = getPhoneFromMessage(msg);
  if (!phoneInput || !looksLikePhone(phoneInput)) {
    return { ok: false, reason: 'invalid' };
  }

  if (!isPhoneAllowed(phoneInput)) {
    return { ok: false, reason: 'denied' };
  }

  const phone = normalizeRegisteredPhone(phoneInput);
  const user = registerBotUser(db, {
    telegramId: msg.from.id,
    phone,
    username: msg.from.username,
    firstName: msg.from.first_name,
    lastName: msg.from.last_name,
  });

  return { ok: true, user };
}

registerVipHandlers(bot, {
  getBotUser: (telegramId) => getBotUser(db, telegramId),
  sendRegisterPrompt,
});
registerServiceHandlers(bot, {
  db,
  getBotUser: (telegramId) => getBotUser(db, telegramId),
});

bot.onText(/\/start/, (msg) => {
  const botUser = getBotUser(db, msg.from.id);
  if (botUser) {
    bot.sendMessage(msg.chat.id, `Бот поиска пользователей Regos\n\n${HELP_TEXT}`, REMOVE_KEYBOARD);
    return;
  }
  sendRegisterPrompt(msg.chat.id);
});

bot.onText(/\/help/, (msg) => {
  const botUser = getBotUser(db, msg.from.id);
  if (!botUser) {
    sendRegisterPrompt(msg.chat.id);
    return;
  }
  bot.sendMessage(msg.chat.id, HELP_TEXT, REMOVE_KEYBOARD);
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  if (text?.startsWith('/')) return;

  const botUser = getBotUser(db, msg.from.id);

  if (!botUser) {
    const registration = tryRegisterUser(msg);
    if (registration.ok) {
      await sendBotMessage(msg.chat.id, `${REGISTER_SUCCESS}\n\n${HELP_TEXT}`, REMOVE_KEYBOARD);
      return;
    }
    if (registration.reason === 'denied') {
      await bot.sendMessage(msg.chat.id, ACCESS_DENIED, REGISTER_KEYBOARD);
      return;
    }
    await sendRegisterPrompt(msg.chat.id);
    return;
  }

  if (!text) return;

  if (await handleServiceMessage(bot, msg, botUser, db)) {
    return;
  }

  if (await handleVipMessage(bot, msg, botUser)) {
    return;
  }

  try {
    const result = searchUser(text, db);
    if (result.found && Array.isArray(result.results) && result.results.length > 0) {
      for (const entry of result.results) {
        await sendSearchResultWithAction(msg.chat.id, msg.from.id, entry);
      }
      return;
    }
    await sendBotMessage(msg.chat.id, result.message);
  } catch (err) {
    console.error(`Failed to send search result to ${msg.chat.id}:`, err.message);
    await bot.sendMessage(msg.chat.id, 'Ошибка при отправке результата. Попробуйте ещё раз.');
  }
});

console.log('Telegram bot is running.');

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
