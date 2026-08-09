const fs = require('fs');
const { ensureParentDir } = require('../paths');

function normalizeDomain(domain) {
  return String(domain || '')
    .replace(/^\./, '')
    .toLowerCase();
}

function hostMatchesCookie(hostname, cookieDomain) {
  const host = String(hostname || '').toLowerCase();
  const domain = normalizeDomain(cookieDomain);
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function loadStorageState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { cookies: [], origins: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      origins: Array.isArray(parsed.origins) ? parsed.origins : [],
    };
  } catch {
    return { cookies: [], origins: [] };
  }
}

function saveStorageState(filePath, state) {
  ensureParentDir(filePath);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        cookies: state.cookies || [],
        origins: state.origins || [],
      },
      null,
      2
    )
  );
}

function cookieHeaderForUrl(cookies, url) {
  const target = new URL(url);
  const now = Date.now() / 1000;
  const parts = [];
  for (const cookie of cookies || []) {
    if (cookie.expires != null && Number(cookie.expires) > 0 && Number(cookie.expires) < now) {
      continue;
    }
    if (!hostMatchesCookie(target.hostname, cookie.domain)) continue;
    if (cookie.secure && target.protocol !== 'https:') continue;
    const path = cookie.path || '/';
    if (!target.pathname.startsWith(path)) continue;
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join('; ');
}

function parseSetCookieHeader(headerValue) {
  if (!headerValue) return null;
  const segments = String(headerValue).split(';').map((s) => s.trim());
  const [nameValue, ...attrs] = segments;
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: nameValue.slice(0, eq),
    value: nameValue.slice(eq + 1),
    domain: '',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower === 'httponly') cookie.httpOnly = true;
    else if (lower === 'secure') cookie.secure = true;
    else if (lower.startsWith('domain=')) cookie.domain = attr.slice(7);
    else if (lower.startsWith('path=')) cookie.path = attr.slice(5) || '/';
    else if (lower.startsWith('expires=')) {
      const t = Date.parse(attr.slice(8));
      if (!Number.isNaN(t)) cookie.expires = t / 1000;
    } else if (lower.startsWith('max-age=')) {
      const seconds = Number(attr.slice(8));
      if (Number.isFinite(seconds)) cookie.expires = Date.now() / 1000 + seconds;
    } else if (lower.startsWith('samesite=')) {
      cookie.sameSite = attr.slice(9);
    }
  }
  return cookie;
}

function mergeSetCookieHeaders(cookies, setCookieHeaders, requestUrl) {
  const url = new URL(requestUrl);
  const next = [...(cookies || [])];
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];

  for (const header of headers) {
    const parsed = parseSetCookieHeader(header);
    if (!parsed) continue;
    if (!parsed.domain) parsed.domain = url.hostname;
    const idx = next.findIndex(
      (c) =>
        c.name === parsed.name &&
        normalizeDomain(c.domain) === normalizeDomain(parsed.domain) &&
        (c.path || '/') === (parsed.path || '/')
    );
    if (parsed.expires === 0 || parsed.value === '') {
      if (idx >= 0) next.splice(idx, 1);
      continue;
    }
    if (idx >= 0) next[idx] = { ...next[idx], ...parsed };
    else next.push(parsed);
  }
  return next;
}

function getSetCookieList(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

module.exports = {
  loadStorageState,
  saveStorageState,
  cookieHeaderForUrl,
  mergeSetCookieHeaders,
  getSetCookieList,
  hostMatchesCookie,
};
