const {
  authStatePathForAccount,
  rposAuthStatePath,
} = require('../paths');
const { loadStorageState, saveStorageState } = require('./cookie-jar');
const { createHttpRequest } = require('./http-client');
const { bootstrapRegosSession, bootstrapRposSession } = require('./playwright-bootstrap');
const { loginRposHttp } = require('./rpos-login');
const { hasRposCredentials } = require('../sync/accounts');

const regosLocks = new Map();
const rposLocks = new Map();
const regosStates = new Map();
const rposStates = new Map();

function withLock(map, key, fn) {
  const prev = map.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  map.set(
    key,
    next.catch(() => {}).then(() => {})
  );
  return next;
}

function looksLikeLoginHtml(text, url) {
  const body = String(text || '');
  const href = String(url || '');
  if (/\/account\/login/i.test(href) || /auth\.regos\.uz/i.test(href)) return true;
  if (/войти через regos/i.test(body) && /login/i.test(body)) return true;
  if (body.includes('id_username') && href.includes('/login')) return true;
  return false;
}

function getRegosState(accountLabel) {
  if (!regosStates.has(accountLabel)) {
    const loaded = loadStorageState(authStatePathForAccount(accountLabel));
    regosStates.set(accountLabel, {
      cookies: loaded.cookies,
      origins: loaded.origins,
    });
  }
  return regosStates.get(accountLabel);
}

function getRposState(accountLabel) {
  if (!rposStates.has(accountLabel)) {
    const loaded = loadStorageState(rposAuthStatePath(accountLabel));
    rposStates.set(accountLabel, {
      cookies: loaded.cookies,
      origins: loaded.origins,
    });
  }
  return rposStates.get(accountLabel);
}

function persistRegos(accountLabel) {
  const state = getRegosState(accountLabel);
  saveStorageState(authStatePathForAccount(accountLabel), state);
}

function persistRpos(accountLabel) {
  const state = getRposState(accountLabel);
  saveStorageState(rposAuthStatePath(accountLabel), state);
}

async function refreshRegosSession(accountLabel) {
  return withLock(regosLocks, accountLabel, async () => {
    const { storageState } = await bootstrapRegosSession(accountLabel, {
      headless: process.env.HEADLESS !== '0',
    });
    regosStates.set(accountLabel, {
      cookies: storageState.cookies || [],
      origins: storageState.origins || [],
    });
    return getRegosState(accountLabel);
  });
}

async function refreshRposSession(accountLabel) {
  return withLock(rposLocks, accountLabel, async () => {
    const state = getRposState(accountLabel);
    try {
      await loginRposHttp(accountLabel, state);
      return state;
    } catch {
      const { storageState } = await bootstrapRposSession(accountLabel, {
        headless: process.env.HEADLESS !== '0',
      });
      rposStates.set(accountLabel, {
        cookies: storageState.cookies || [],
        origins: storageState.origins || [],
      });
      return getRposState(accountLabel);
    }
  });
}

async function ensureRegosRequest(accountLabel) {
  let state = getRegosState(accountLabel);
  if (!state.cookies.length) {
    state = await refreshRegosSession(accountLabel);
  }
  return createHttpRequest(state);
}

async function ensureRposRequest(accountLabel) {
  if (!hasRposCredentials(accountLabel)) {
    throw new Error(`RPOS credentials not configured for ${accountLabel}`);
  }
  let state = getRposState(accountLabel);
  if (!state.cookies.length) {
    state = await refreshRposSession(accountLabel);
  }
  return createHttpRequest(state);
}

/**
 * Run an authenticated portal call; on login HTML / 401 refresh session once and retry.
 */
async function withRegosSession(accountLabel, fn) {
  let request = await ensureRegosRequest(accountLabel);
  try {
    const result = await fn(request);
    persistRegos(accountLabel);
    return result;
  } catch (err) {
    const message = String(err?.message || err);
    if (!/401|login|session|unauthorized|html/i.test(message)) throw err;
    await refreshRegosSession(accountLabel);
    request = await ensureRegosRequest(accountLabel);
    const result = await fn(request);
    persistRegos(accountLabel);
    return result;
  }
}

async function withRposSession(accountLabel, fn) {
  let request = await ensureRposRequest(accountLabel);
  try {
    const result = await fn(request);
    persistRpos(accountLabel);
    return result;
  } catch (err) {
    const message = String(err?.message || err);
    if (!/401|login|session|csrf|unauthorized|html/i.test(message)) throw err;
    await refreshRposSession(accountLabel);
    request = await ensureRposRequest(accountLabel);
    const result = await fn(request);
    persistRpos(accountLabel);
    return result;
  }
}

function assertJsonOrThrow(response, label) {
  return response.text().then((text) => {
    const url = typeof response.url === 'function' ? response.url() : '';
    if (!response.ok()) {
      throw new Error(`${label} failed with status ${response.status()}`);
    }
    if (looksLikeLoginHtml(text, url) || text.trimStart().startsWith('<!')) {
      throw new Error(`${label} returned login/HTML (session expired)`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} returned non-JSON response`);
    }
  });
}

module.exports = {
  ensureRegosRequest,
  ensureRposRequest,
  withRegosSession,
  withRposSession,
  refreshRegosSession,
  refreshRposSession,
  assertJsonOrThrow,
  looksLikeLoginHtml,
};
