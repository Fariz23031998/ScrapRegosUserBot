const crypto = require('crypto');

const WEBAPP_AUTH_MAX_AGE_SEC = 24 * 60 * 60;

function getTelegramBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
}

function webAppSecretKey(botToken) {
  return crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
}

function dataCheckStringFromParams(params) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join('\n');
}

function timingSafeEqualHex(actual, expected) {
  const actualBuf = Buffer.from(String(actual || ''), 'hex');
  const expectedBuf = Buffer.from(String(expected || ''), 'hex');
  if (
    actualBuf.length === 0 ||
    expectedBuf.length === 0 ||
    actualBuf.length !== expectedBuf.length
  ) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Verify Telegram Mini App initData and return { telegramId } or null.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function parseTelegramWebAppInitData(
  initData,
  botToken,
  { maxAgeSec = WEBAPP_AUTH_MAX_AGE_SEC, nowSec = Math.floor(Date.now() / 1000) } = {}
) {
  const raw = String(initData || '').trim();
  const token = String(botToken || '').trim();
  if (!raw || !token) return null;

  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;

  const dataCheckString = dataCheckStringFromParams(params);
  const computed = crypto
    .createHmac('sha256', webAppSecretKey(token))
    .update(dataCheckString)
    .digest('hex');
  if (!timingSafeEqualHex(computed, hash)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (nowSec - authDate > maxAgeSec) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }

  const telegramId = Number(user?.id);
  if (!Number.isFinite(telegramId)) return null;
  return { telegramId };
}

/** Build a signed initData string for tests. */
function signTelegramWebAppInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'hash') continue;
    params.set(key, String(value));
  }
  const dataCheckString = dataCheckStringFromParams(params);
  const hash = crypto
    .createHmac('sha256', webAppSecretKey(botToken))
    .update(dataCheckString)
    .digest('hex');
  params.set('hash', hash);
  return params.toString();
}

module.exports = {
  WEBAPP_AUTH_MAX_AGE_SEC,
  getTelegramBotToken,
  parseTelegramWebAppInitData,
  signTelegramWebAppInitData,
};
