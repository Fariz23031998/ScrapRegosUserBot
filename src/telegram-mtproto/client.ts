import type { Unchecked } from '../types/unchecked';
import crypto from 'crypto';
import { TelegramClient, Api } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import { generateRandomLong } from 'telegram/Helpers';
import { formatPhoneForSms } from '../sms/sms-message';

'use strict';

const DEFAULT_HELLO_SENTENCES = Object.freeze([
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
]);

const HELLO_SENTENCES = DEFAULT_HELLO_SENTENCES;

const GREETING_DELAY_MS = 1500;

let sharedClient: any = null;
let connectingPromise: any = null;

function parseHelloSentences(raw?: any) {
  if (raw == null) return [];
  return String(raw)
    .split(/\r?\n/)
    .map((line?: any) => line.trim())
    .filter(Boolean);
}

function getHelloSentences() {
  const fromEnv = parseHelloSentences(process.env.HELLO_SENTENCES);
  return fromEnv.length ? fromEnv : [...DEFAULT_HELLO_SENTENCES];
}

function pickRandomHello() {
  const sentences = getHelloSentences();
  return sentences[crypto.randomInt(0, sentences.length)];
}

function delay(ms?: any) {
  return new Promise<any>((resolve?: any) => setTimeout(resolve, ms));
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

function formatPhoneForTelegram(phone?: any) {
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
    client.setLogLevel(LogLevel.ERROR);
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
      .then((client?: any) => {
        sharedClient = client;
        return client;
      })
      .catch((err: Error) => {
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

async function resolveUserByPhone(client?: any, e164Phone?: any) {
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

function toInputPeerUser(user?: any) {
  if (!user?.id || user.accessHash == null) {
    throw new Error('Resolved Telegram user is missing id/accessHash');
  }
  return new Api.InputPeerUser({
    userId: user.id,
    accessHash: user.accessHash,
  });
}

async function sendTelegramByPhone(
  { phone, text, withGreeting = false, parseMode = 'html' }: Unchecked,
  {
    getClientFn = getClient,
    resolveUserByPhoneFn = resolveUserByPhone,
    pickRandomHelloFn = pickRandomHello,
    delayFn = delay,
    greetingDelayMs = GREETING_DELAY_MS,
  }: Unchecked = {}
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

  let greeting: any = null;
  if (withGreeting) {
    greeting = pickRandomHelloFn();
    // Greetings are plain text — disable Markdown/HTML parsing.
    await client.sendMessage(peer, { message: greeting, parseMode: false });
    await delayFn(greetingDelayMs);
  }

  await client.sendMessage(peer, {
    message: String(text),
    parseMode: parseMode == null ? false : parseMode,
  });

  const userId = user?.id != null ? String(user.id) : null;
  const result: Unchecked = {
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

export {
  DEFAULT_HELLO_SENTENCES,
  HELLO_SENTENCES,
  GREETING_DELAY_MS,
  parseHelloSentences,
  getHelloSentences,
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
