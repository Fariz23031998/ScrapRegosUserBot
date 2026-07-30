const crypto = require('crypto');
const { getPublicBaseUrl } = require('../payments/payments-api');

const SESSION_COOKIE = 'bot_admin_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function getAdminCredentials() {
  const login = process.env.BOT_ADMIN_LOGIN?.trim();
  const password = process.env.BOT_ADMIN_PASSWORD?.trim();
  if (!login || !password) return null;
  return { login, password };
}

function createSessionToken(login, password) {
  return crypto.createHmac('sha256', password).update(`bot-admin-session:${login}`).digest('hex');
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isAuthenticated(req) {
  const creds = getAdminCredentials();
  if (!creds) return false;
  const token = getSessionToken(req);
  if (!token) return false;
  const expected = createSessionToken(creds.login, creds.password);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

function buildSessionCookieAttributes({ maxAgeSeconds }) {
  const base = getPublicBaseUrl();
  const secure = /^https:\/\//i.test(base) ? '; Secure' : '';
  return `Path=/bot-admin; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function setSessionCookie(res, creds) {
  const token = createSessionToken(creds.login, creds.password);
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${buildSessionCookieAttributes({ maxAgeSeconds: maxAge })}`
  );
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

function requireAdminAuth(req, res, next) {
  const creds = getAdminCredentials();
  if (!creds) {
    return res.status(503).json({
      message:
        'Admin credentials are not configured. Set BOT_ADMIN_LOGIN and BOT_ADMIN_PASSWORD in .env and restart the server.',
    });
  }

  if (!isAuthenticated(req)) {
    if (wantsJsonResponse(req)) {
      return res.status(401).json({ message: 'Требуется вход в систему.' });
    }
    return res.redirect('/bot-admin/login');
  }

  return next();
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  getAdminCredentials,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireAdminAuth,
  buildSessionCookieAttributes,
};
