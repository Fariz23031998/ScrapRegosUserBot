const {
  loadTelegramTicketSettings,
} = require('./telegram-ticket-settings');
const { resolveRegosClient } = require('./regos-client-resolve');
const { setBotUserRegosClientId, getBotUserById } = require('../db/bot-users-db');

const MSG_CLIENT_FOUND = 'Вы успешно зарегистрированы';
const MSG_CLIENT_ALREADY_REGISTERED = 'Вы уже зарегистрированы';
const MSG_CLIENT_CREATED = 'Создана карточка клиента в ROFEEV.';
const MSG_CLIENT_FALLBACK = 'Клиент привязан к карточке ROFEEV по умолчанию.';
const MSG_CLIENT_FAILED = 'Не удалось связать профиль с ROFEEV. Попробуйте /start позже.';
const MSG_CLIENT_NOT_REGISTERED =
  'Вы не зарегистрированы, пожалуйста отправьте номер телефона для регистрации';

const REGISTER_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📱 Отправить номер телефона', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

function statusMessageForSource(source) {
  if (source === 'phone' || source === 'stored') return MSG_CLIENT_FOUND;
  if (source === 'created') return MSG_CLIENT_CREATED;
  if (source === 'fallback') return MSG_CLIENT_FALLBACK;
  return MSG_CLIENT_FAILED;
}

/**
 * Ensure a non-employee Telegram user has a REGOS client, send status, then run onReady
 * (typically /start follow-up hints — unpaid orders are /my_unpaid_orders).
 */
async function ensureCustomerRegosOnStart({
  bot,
  msg,
  botUser,
  db,
  onReady,
  alreadyRegistered = false,
  deps = {},
} = {}) {
  const chatId = msg?.chat?.id ?? msg?.from?.id;

  if (!botUser?.phone) {
    if (chatId != null && bot?.sendMessage) {
      await bot.sendMessage(chatId, MSG_CLIENT_NOT_REGISTERED, REGISTER_KEYBOARD);
    }
    return {
      ok: false,
      source: 'none',
      client: null,
      botUser,
      statusText: MSG_CLIENT_NOT_REGISTERED,
    };
  }

  const loadSettings = deps.loadTelegramTicketSettings || loadTelegramTicketSettings;
  const resolve = deps.resolveRegosClient || resolveRegosClient;
  const setClientId = deps.setBotUserRegosClientId || setBotUserRegosClientId;
  const getUser = deps.getBotUserById || getBotUserById;

  const settings = loadSettings(db);
  const displayName = [
    msg?.from?.first_name || botUser.first_name,
    msg?.from?.last_name || botUser.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  let result;
  try {
    result = await resolve({
      phone: botUser.phone,
      displayName: displayName || botUser.phone,
      settings,
      storedClientId: botUser.regos_client_id,
      deps,
    });
  } catch (error) {
    console.error('[customer-start] resolveRegosClient failed:', error);
    result = { client: null, source: 'none' };
  }

  const statusText = alreadyRegistered
    ? MSG_CLIENT_ALREADY_REGISTERED
    : statusMessageForSource(result.source);
  if (chatId != null && bot?.sendMessage) {
    await bot.sendMessage(chatId, statusText);
  }

  let nextUser = botUser;
  if (result.client?.id && botUser.id) {
    try {
      nextUser = setClientId(db, botUser.id, result.client.id) || botUser;
    } catch (error) {
      console.warn('[customer-start] setBotUserRegosClientId failed:', error?.message || error);
      nextUser = getUser(db, botUser.id) || botUser;
    }
  }

  if (typeof onReady === 'function') {
    await onReady(nextUser);
  }

  return {
    ok: Boolean(result.client?.id),
    source: result.source,
    client: result.client,
    botUser: nextUser,
    statusText,
  };
}

module.exports = {
  ensureCustomerRegosOnStart,
  statusMessageForSource,
  MSG_CLIENT_FOUND,
  MSG_CLIENT_ALREADY_REGISTERED,
  MSG_CLIENT_CREATED,
  MSG_CLIENT_FALLBACK,
  MSG_CLIENT_FAILED,
  MSG_CLIENT_NOT_REGISTERED,
  REGISTER_KEYBOARD,
};
