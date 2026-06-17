require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { searchUser, looksLikePhone } = require('./lib/search-user');
const {
  openDb,
  getBotUser,
  getEmployeeByPhone,
  linkEmployeeTelegram,
  registerCustomer,
  getUnpaidOrdersByClientPhone,
  getUnpaidOrdersByUserPhone,
} = require('./lib/partners-db');
const { isLinkedEmployee, hasRight } = require('./lib/user-rights');
const { syncUserCommands, getHelpCommandLines } = require('./lib/bot-commands');
const { registerVipHandlers, handleVipMessage } = require('./lib/vip-bot');
const { registerServiceHandlers, handleServiceMessage, makeServiceButtonForResult } = require('./lib/service-bot');
const { registerReportHandlers, handleReportMessage } = require('./lib/report-bot');
const {
  registerOrderActionHandlers,
  appendDeleteButtonsForOrders,
} = require('./lib/order-actions-bot');
const { formatUnpaidOrdersBlock } = require('./lib/bot-format');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env or environment variables.');
  process.exit(1);
}

const db = openDb();
const bot = new TelegramBot(token, { polling: true });

const SEARCH_HELP = [
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

function buildHelpText(telegramId) {
  const commandLines = getHelpCommandLines(db, telegramId);
  if (!commandLines.length) {
    return SEARCH_HELP;
  }
  return [SEARCH_HELP, '', ...commandLines].join('\n');
}

const REGISTER_PROMPT = [
  'Бот поиска пользователей Regos',
  '',
  'Нажмите кнопку ниже и отправьте свой номер телефона.',
  'После этого бот покажет доступные действия.',
].join('\n');

const REGISTER_SUCCESS = 'Регистрация успешна. Теперь вы можете выполнять поиск.';
const CUSTOMER_NO_ORDERS = 'По вашему номеру не найдено неоплаченных заказов.';
const CUSTOMER_ONLY_MODE_TEXT = 'Доступ только к оплате. Отправьте /start для проверки заказов.';
const PHONE_ALREADY_LINKED = 'Номер уже привязан к другому аккаунту Telegram.';
const EMPLOYEE_NOT_CONFIGURED =
  'Ваш номер не найден среди сотрудников. Обратитесь к администратору для добавления в систему.';

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

function getProfileFromMessage(msg) {
  return {
    username: msg.from.username,
    firstName: msg.from.first_name,
    lastName: msg.from.last_name,
  };
}

function getPhoneFromMessage(msg) {
  if (msg.contact?.phone_number) {
    return msg.contact.phone_number;
  }
  return msg.text?.trim() || null;
}

async function sendCustomerPaymentLinks(chatId, phone) {
  const orders = getUnpaidOrdersByUserPhone(db, phone);
  const unpaidBlock = formatUnpaidOrdersBlock(orders);
  if (!unpaidBlock) {
    await sendBotMessage(chatId, CUSTOMER_NO_ORDERS, REMOVE_KEYBOARD);
    return;
  }
  await sendBotMessage(chatId, unpaidBlock, REMOVE_KEYBOARD);
}

async function sendEmployeeStartMessage(chatId, telegramId) {
  const text = `Бот поиска пользователей Regos\n\n${buildHelpText(telegramId)}`;
  await sendBotMessage(chatId, text, REMOVE_KEYBOARD);
}

async function sendSearchResultWithAction(chatId, telegramId, entry, { appendUnpaid = true } = {}) {
  let text = entry.message || '';
  let unpaidOrders = [];
  if (appendUnpaid) {
    unpaidOrders = getUnpaidOrdersByClientPhone(db, entry.phone);
    const unpaidBlock = formatUnpaidOrdersBlock(unpaidOrders);
    if (unpaidBlock) {
      text = `${text}\n\n${unpaidBlock}`;
    }
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

  if (unpaidOrders.length && hasRight(db, telegramId, 'delete_unpaid_order')) {
    await appendDeleteButtonsForOrders(bot, chatId, unpaidOrders, telegramId, db);
  }
}

function tryRegisterUser(msg) {
  const phoneInput = getPhoneFromMessage(msg);
  if (!phoneInput || !looksLikePhone(phoneInput)) {
    return { ok: false, reason: 'invalid' };
  }

  const phone = String(phoneInput).trim();
  const profile = getProfileFromMessage(msg);
  const employee = getEmployeeByPhone(db, phone);

  if (employee) {
    if (employee.telegram_id && employee.telegram_id !== msg.from.id) {
      return { ok: false, reason: 'phone_taken' };
    }
    const user = employee.telegram_id
      ? getBotUser(db, msg.from.id)
      : linkEmployeeTelegram(db, employee.id, msg.from.id, profile);
    return { ok: true, role: 'employee', user };
  }

  try {
    const user = registerCustomer(db, {
      telegramId: msg.from.id,
      phone,
      ...profile,
    });
    return { ok: true, role: 'customer', user };
  } catch (error) {
    if (error.message === 'PHONE_ALREADY_LINKED') {
      return { ok: false, reason: 'phone_taken' };
    }
    throw error;
  }
}

registerVipHandlers(bot, {
  db,
  getBotUser: (telegramId) => getBotUser(db, telegramId),
  sendRegisterPrompt,
});
registerServiceHandlers(bot, {
  db,
  getBotUser: (telegramId) => getBotUser(db, telegramId),
});
registerReportHandlers(bot, { db });
registerOrderActionHandlers(bot, { db });

bot.onText(/\/start/, async (msg) => {
  const botUser = getBotUser(db, msg.from.id);
  if (botUser) {
    await syncUserCommands(bot, db, msg.from.id);
    if (isLinkedEmployee(botUser)) {
      await sendEmployeeStartMessage(msg.chat.id, msg.from.id);
      return;
    }
    await sendCustomerPaymentLinks(msg.chat.id, botUser.phone);
    return;
  }
  await sendRegisterPrompt(msg.chat.id);
});

bot.onText(/\/help/, async (msg) => {
  const botUser = getBotUser(db, msg.from.id);
  if (!botUser) {
    await sendRegisterPrompt(msg.chat.id);
    return;
  }
  if (!isLinkedEmployee(botUser)) {
    await sendCustomerPaymentLinks(msg.chat.id, botUser.phone);
    return;
  }
  await syncUserCommands(bot, db, msg.from.id);
  await bot.sendMessage(msg.chat.id, buildHelpText(msg.from.id), REMOVE_KEYBOARD);
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  if (text?.startsWith('/')) return;

  const botUser = getBotUser(db, msg.from.id);

  if (!botUser) {
    const registration = tryRegisterUser(msg);
    if (!registration.ok) {
      if (registration.reason === 'phone_taken') {
        await sendBotMessage(msg.chat.id, PHONE_ALREADY_LINKED, REMOVE_KEYBOARD);
        return;
      }
      await sendRegisterPrompt(msg.chat.id);
      return;
    }
    if (registration.role === 'employee') {
      await syncUserCommands(bot, db, msg.from.id);
      await sendBotMessage(
        msg.chat.id,
        `${REGISTER_SUCCESS}\n\n${buildHelpText(msg.from.id)}`,
        REMOVE_KEYBOARD
      );
      return;
    }
    await sendCustomerPaymentLinks(msg.chat.id, registration.user.phone);
    return;
  }

  if (!isLinkedEmployee(botUser)) {
    if (text && looksLikePhone(text)) {
      const employee = getEmployeeByPhone(db, text);
      if (employee && !employee.telegram_id) {
        const registration = tryRegisterUser(msg);
        if (registration.ok && registration.role === 'employee') {
          await syncUserCommands(bot, db, msg.from.id);
          await sendBotMessage(
            msg.chat.id,
            `${REGISTER_SUCCESS}\n\n${buildHelpText(msg.from.id)}`,
            REMOVE_KEYBOARD
          );
          return;
        }
      }
      if (employee && employee.telegram_id && employee.telegram_id !== msg.from.id) {
        await sendBotMessage(msg.chat.id, PHONE_ALREADY_LINKED, REMOVE_KEYBOARD);
        return;
      }
      if (employee) {
        await sendBotMessage(msg.chat.id, EMPLOYEE_NOT_CONFIGURED, REMOVE_KEYBOARD);
        return;
      }
    }
    await sendBotMessage(msg.chat.id, CUSTOMER_ONLY_MODE_TEXT, REMOVE_KEYBOARD);
    return;
  }

  if (!text) return;

  if (await handleReportMessage(bot, msg, db)) {
    return;
  }

  if (await handleServiceMessage(bot, msg, botUser, db)) {
    return;
  }

  if (await handleVipMessage(bot, msg, botUser, db)) {
    return;
  }

  try {
    const result = searchUser(text, db);
    if (result.found && Array.isArray(result.results) && result.results.length > 0) {
      const shownUnpaidForPhones = new Set();
      for (const entry of result.results) {
        const phoneKey = String(entry.phone || '').trim();
        const appendUnpaid = !phoneKey || !shownUnpaidForPhones.has(phoneKey);
        if (appendUnpaid && phoneKey) {
          shownUnpaidForPhones.add(phoneKey);
        }
        await sendSearchResultWithAction(msg.chat.id, msg.from.id, entry, { appendUnpaid });
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

bot
  .setMyCommands([{ command: 'start', description: 'Начать работу с ботом' }])
  .catch((error) => {
    console.error('Failed to set default bot commands:', error.message);
  });

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
