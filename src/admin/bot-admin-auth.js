const crypto = require('crypto');
const { getPublicBaseUrl } = require('../payments/payments-api');
const { hasRight, ADMIN_PERMISSION_KEYS } = require('../db/user-rights');
const { getBotUserById, getUserRights } = require('../db/bot-users-db');

const SESSION_COOKIE = 'bot_admin_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function getAdminCredentials() {
  const login = process.env.BOT_ADMIN_LOGIN?.trim();
  const password = process.env.BOT_ADMIN_PASSWORD?.trim();
  if (!login || !password) return null;
  return { login, password };
}

function base64UrlEncode(bufferOrString) {
  const buf = Buffer.isBuffer(bufferOrString)
    ? bufferOrString
    : Buffer.from(String(bufferOrString), 'utf8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecodeToString(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLength), 'base64').toString('utf8');
}

function signPayload(password, payloadB64) {
  return base64UrlEncode(
    crypto.createHmac('sha256', password).update(`bot-admin-session-v1:${payloadB64}`).digest()
  );
}

function createSessionToken(password, actor) {
  const payload = { v: 1 };
  if (actor?.type === 'telegram') {
    const telegramId = Number(actor.telegramId);
    if (!Number.isFinite(telegramId)) {
      throw new Error('Invalid telegram actor');
    }
    payload.typ = 'telegram';
    payload.tid = telegramId;
  } else if (actor?.type === 'user') {
    const userId = Number(actor.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new Error('Invalid user actor');
    }
    payload.typ = 'user';
    payload.uid = userId;
  } else {
    payload.typ = 'password';
  }
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(password, payloadB64);
  return `${payloadB64}.${signature}`;
}

function parseSessionToken(password, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return null;

  const expected = signPayload(password, payloadB64);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  try {
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;

  if (payload.typ === 'password') {
    return { type: 'password' };
  }
  if (payload.typ === 'telegram') {
    const telegramId = Number(payload.tid);
    if (!Number.isFinite(telegramId)) return null;
    return { type: 'telegram', telegramId };
  }
  if (payload.typ === 'user') {
    const userId = Number(payload.uid);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    return { type: 'user', userId };
  }
  return null;
}

function decodeSessionTokenValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getSessionToken(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(\S+)/i);
  if (bearer) return decodeSessionTokenValue(bearer[1]);

  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeSessionTokenValue(match[1]) : null;
}

function getSessionActor(req) {
  const creds = getAdminCredentials();
  if (!creds) return null;
  const token = getSessionToken(req);
  if (!token) return null;
  return parseSessionToken(creds.password, token);
}

function isAuthenticated(req) {
  return Boolean(getSessionActor(req));
}

function buildSessionCookieAttributes({ maxAgeSeconds }) {
  const base = getPublicBaseUrl();
  const secure = /^https:\/\//i.test(base) ? '; Secure' : '';
  return `Path=/bot-admin; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function setSessionCookie(res, creds, actor = { type: 'password' }) {
  const token = createSessionToken(creds.password, actor);
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${buildSessionCookieAttributes({ maxAgeSeconds: maxAge })}`
  );
  return token;
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; ${buildSessionCookieAttributes({ maxAgeSeconds: 0 })}`
  );
}

// Browser fetch() sends `Accept: */*`, which also matches HTML, so API callers
// would otherwise be redirected to the login page and receive HTML instead of
// the 401 they need to react to.
function wantsJsonResponse(req) {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  if (pathname.includes('/api/') || pathname.endsWith('/rights-meta')) {
    return true;
  }
  return req.accepts(['html', 'json']) === 'json';
}

function respondMissingCredentials(req, res) {
  if (wantsJsonResponse(req)) {
    return res.status(503).json({
      message:
        'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.',
    });
  }
  return res
    .status(503)
    .send(
      'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.'
    );
}

function respondUnauthorized(req, res) {
  if (wantsJsonResponse(req)) {
    return res.status(401).json({ message: 'Требуется вход в систему.' });
  }
  return res.redirect('/bot-admin/login');
}

function respondForbidden(req, res) {
  if (wantsJsonResponse(req)) {
    return res.status(403).json({ message: 'Нет доступа.' });
  }
  return res.status(403).send('Нет доступа. Недостаточно прав для этого раздела.');
}

function employeeHasPermission(db, userId, rightKey) {
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') return false;
  const rights = getUserRights(db, userId);
  return Boolean(rights[rightKey]);
}

function actorHasPermission(db, actor, rightKey) {
  if (!actor) return false;
  if (actor.type === 'password') return true;
  if (actor.type === 'telegram') {
    return hasRight(db, actor.telegramId, rightKey);
  }
  if (actor.type === 'user') {
    return employeeHasPermission(db, actor.userId, rightKey);
  }
  return false;
}

function actorHasAnyPermission(db, actor, rightKeys) {
  if (!actor) return false;
  if (actor.type === 'password') return true;
  return rightKeys.some((key) => actorHasPermission(db, actor, key));
}

function getSessionPermissions(db, actor) {
  const permissions = {};
  for (const key of ADMIN_PERMISSION_KEYS) {
    permissions[key] = actorHasPermission(db, actor, key);
  }
  return permissions;
}

function requireAdminAuth(req, res, next) {
  const creds = getAdminCredentials();
  if (!creds) {
    return respondMissingCredentials(req, res);
  }

  if (!isAuthenticated(req)) {
    return respondUnauthorized(req, res);
  }

  return next();
}

function requireRight(db, rightKey) {
  return function requireRightMiddleware(req, res, next) {
    const creds = getAdminCredentials();
    if (!creds) {
      return respondMissingCredentials(req, res);
    }

    const actor = getSessionActor(req);
    if (!actor) {
      return respondUnauthorized(req, res);
    }

    if (!actorHasPermission(db, actor, rightKey)) {
      return respondForbidden(req, res);
    }

    return next();
  };
}

function requireAnyRight(db, rightKeys) {
  const keys = Array.isArray(rightKeys) ? rightKeys : [rightKeys];
  return function requireAnyRightMiddleware(req, res, next) {
    const creds = getAdminCredentials();
    if (!creds) {
      return respondMissingCredentials(req, res);
    }

    const actor = getSessionActor(req);
    if (!actor) {
      return respondUnauthorized(req, res);
    }

    if (!actorHasAnyPermission(db, actor, keys)) {
      return respondForbidden(req, res);
    }

    return next();
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  getAdminCredentials,
  getSessionActor,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireAdminAuth,
  requireRight,
  requireAnyRight,
  actorHasPermission,
  actorHasAnyPermission,
  getSessionPermissions,
  buildSessionCookieAttributes,
  createSessionToken,
  parseSessionToken,
};
