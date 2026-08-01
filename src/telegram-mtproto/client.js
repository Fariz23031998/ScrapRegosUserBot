'use strict';

const crypto = require('crypto');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { generateRandomLong } = require('telegram/Helpers');
const { formatPhoneForSms } = require('../sms/sms-message');

const HELLO_SENTENCES = [
  'Здравствуйте!',
  'Добрый день!',
  'Здравствуйте, добрый день!',
  'Приветствую вас!',
  'Доброго времени суток!',
  'Здравствуйте, рады вас приветствовать!',
  'Добрый день, здравствуйте!',
  'Приветствую!',
  'Здравствуйте, хорошего дня!',
  'Добрый день, рад(-а) вас видеть!',
];

const GREETING_DELAY_MS = 1500;

let sharedClient = null;
let connectingPromise = null;

function pickRandomHello() {
  return HELLO_SENTENCES[crypto.randomInt(0, HELLO_SENTENCES.length)];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getApiCredentials() {
  const apiIdRaw = process.env.TELEGRAM_API_ID?.trim() || '';
  const apiId = apiIdRaw ? Number(apiIdRaw) : NaN;
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';
  const session = process.env.TELEGRAM_MTPROTO_SESSION?.trim() || '';
  return { apiId, apiHash, session };
}

function isTelegramMtprotoConfigured() {
  const { apiId, apiHash, session } = getApiCredentials();
  return Number.isInteger(apiId) && apiId > 0 && Boolean(apiHash && session);
}

function isTelegramMtprotoEnabled() {
  return process.env.ENABLE_TELEGRAM_MTPROTO?.trim() === '1' && isTelegramMtprotoConfigured();
}

function formatPhoneForTelegram(phone) {
  const digits = formatPhoneForSms(phone);
  if (!digits) return null;
  return `+${digits}`;
}

async function createConnectedClient() {
  const { apiId, apiHash, session } = getApiCredentials();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash || !session) {
    throw new Error(
      'TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_MTPROTO_SESSION are required'
    );
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
  });
  if (typeof client.setLogLevel === 'function') {
    client.setLogLevel('error');
  }
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors after auth failure
    }
    throw new Error(
      'TELEGRAM_MTPROTO_SESSION is invalid or unauthorized; run npm run telegram:login'
    );
  }

  return client;
}

async function getClient() {
  if (sharedClient?.connected) {
    return sharedClient;
  }

  if (!connectingPromise) {
    connectingPromise = createConnectedClient()
      .then((client) => {
        sharedClient = client;
        return client;
      })
      .catch((err) => {
        sharedClient = null;
        throw err;
      })
      .finally(() => {
        connectingPromise = null;
      });
  }

  return connectingPromise;
}

async function resetClient() {
  const client = sharedClient;
  sharedClient = null;
  connectingPromise = null;
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    // ignore
  }
}

async function resolveUserByPhone(client, e164Phone) {
  const digits = e164Phone.replace(/^\+/, '');

  try {
    const resolved = await client.invoke(new Api.contacts.ResolvePhone({ phone: digits }));
    const user = resolved?.users?.[0];
    if (user) {
      return { user, method: 'resolve_phone' };
    }
  } catch {
    // Privacy restrictions or unknown number — try ImportContacts.
  }

  const imported = await client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: generateRandomLong(),
          phone: e164Phone,
          firstName: digits.slice(-4) || 'Client',
          lastName: '',
        }),
      ],
    })
  );

  const user = imported?.users?.[0];
  if (!user) {
    throw new Error(`No Telegram user found for phone ${e164Phone}`);
  }
  return { user, method: 'import_contacts' };
}

function toInputPeerUser(user) {
  if (!user?.id || user.accessHash == null) {
    throw new Error('Resolved Telegram user is missing id/accessHash');
  }
  return new Api.InputPeerUser({
    userId: user.id,
    accessHash: user.accessHash,
  });
}

async function sendTelegramByPhone(
  { phone, text, withGreeting = false },
  {
    getClientFn = getClient,
    resolveUserByPhoneFn = resolveUserByPhone,
    pickRandomHelloFn = pickRandomHello,
    delayFn = delay,
    greetingDelayMs = GREETING_DELAY_MS,
  } = {}
) {
  const e164 = formatPhoneForTelegram(phone);
  if (!e164) {
    throw new Error('Invalid Telegram recipient phone');
  }
  if (text == null || String(text).trim() === '') {
    throw new Error('Message text is required');
  }

  const client = await getClientFn();
  const { user, method } = await resolveUserByPhoneFn(client, e164);
  const peer = toInputPeerUser(user);

  let greeting = null;
  if (withGreeting) {
    greeting = pickRandomHelloFn();
    await client.sendMessage(peer, { message: greeting });
    await delayFn(greetingDelayMs);
  }

  await client.sendMessage(peer, { message: String(text) });

  const userId = user?.id != null ? String(user.id) : null;
  const result = {
    sent: true,
    recipient: e164,
    userId,
    method,
  };
  if (greeting != null) {
    result.greeting = greeting;
  }
  return result;
}

module.exports = {
  HELLO_SENTENCES,
  GREETING_DELAY_MS,
  pickRandomHello,
  getApiCredentials,
  isTelegramMtprotoConfigured,
  isTelegramMtprotoEnabled,
  formatPhoneForTelegram,
  getClient,
  resetClient,
  resolveUserByPhone,
  toInputPeerUser,
  sendTelegramByPhone,
};
