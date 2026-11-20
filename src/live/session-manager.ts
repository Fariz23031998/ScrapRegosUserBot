import fs from 'fs';
import { authStatePathForAccount, rposAuthStatePath } from '../paths';
import { loadStorageState, saveStorageState } from './cookie-jar';
import { createHttpRequest } from './http-client';
import { bootstrapRegosSession, bootstrapRposSession } from './playwright-bootstrap';
import { loginRposHttp } from './rpos-login';
import { hasRposCredentials } from '../sync/accounts';

const regosLocks: Map<any, any> = new Map();
const rposLocks: Map<any, any> = new Map();
const regosStates: Map<any, any> = new Map();
const rposStates: Map<any, any> = new Map();

const REFRESH_REUSE_MS = 20_000;
const REFRESH_FAILURE_COOLDOWN_MS = 60_000;

function isSessionExpiryMessage(message: string) {
  return /401|login|session|unauthorized|html/i.test(message);
}

/** vcr1 SSO can be dead while sb.regos.uz and EasyTrade are still usable. */
function isVcr1SessionExpiry(err: any) {
  const message = String(err?.message || err);
  return /vcr1/i.test(message) && isSessionExpiryMessage(message);
}

/**
 * What to do after an authenticated Regos call throws.
 * renew: sign in once and retry. skip: a vcr1 login just failed, so do not open
 * another browser. rethrow: not a dead session.
 * A dead billing session still renews during the vcr1 cooldown.
 */
function regosSessionRecovery(
  err: any,
  { refreshFailedAt, now = Date.now() }: { refreshFailedAt?: number; now?: number } = {}
) {
  const message = String(err?.message || err);
  if (!isSessionExpiryMessage(message)) return 'rethrow';
  if (
    isVcr1SessionExpiry(err) &&
    refreshFailedAt &&
    now - refreshFailedAt < REFRESH_FAILURE_COOLDOWN_MS
  ) {
    return 'skip';
  }
  return 'renew';
}

function withLock(map?: any, key?: any, fn?: any) {
  const prev = map.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  map.set(
    key,
    next.catch(() => {}).then(() => {})
  );
  return next;
}

function looksLikeLoginHtml(text?: any, url?: any) {
  const body = String(text || '');
  const href = String(url || '');
  if (/\/account\/login/i.test(href) || /auth\.regos\.uz/i.test(href)) return true;
  if (/войти через regos/i.test(body) && /login/i.test(body)) return true;
  if (body.includes('id_username') && href.includes('/login')) return true;
  return false;
}

function readAuthMtime(filePath?: any) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function loadAuthState(map?: any, accountLabel?: any, filePath?: any) {
  const mtimeMs = readAuthMtime(filePath);
  const current = map.get(accountLabel);
  if (current && mtimeMs <= (current.loadedMtimeMs || 0)) {
    return current;
  }

  const loaded = loadStorageState(filePath);
  const replaced = Boolean(current);
  const next = {
    cookies: loaded.cookies,
    origins: loaded.origins,
    loadedMtimeMs: mtimeMs,
    refreshedAt: replaced ? Date.now() : current?.refreshedAt,
    refreshFailedAt: replaced ? undefined : current?.refreshFailedAt,
    refreshError: replaced ? undefined : current?.refreshError,
  };
  map.set(accountLabel, next);
  return next;
}

function getRegosState(accountLabel?: any) {
  return loadAuthState(regosStates, accountLabel, authStatePathForAccount(accountLabel));
}

function getRposState(accountLabel?: any) {
  return loadAuthState(rposStates, accountLabel, rposAuthStatePath(accountLabel));
}

function persistRegos(accountLabel?: any) {
  const state = getRegosState(accountLabel);
  const filePath = authStatePathForAccount(accountLabel);
  saveStorageState(filePath, state);
  state.loadedMtimeMs = readAuthMtime(filePath);
}

function persistRpos(accountLabel?: any) {
  const state = getRposState(accountLabel);
  const filePath = rposAuthStatePath(accountLabel);
  saveStorageState(filePath, state);
  state.loadedMtimeMs = readAuthMtime(filePath);
}

async function refreshRegosSession(accountLabel: any, options: any = {}) {
  return withLock(regosLocks, accountLabel, async () => {
    const current = regosStates.get(accountLabel);
    const now = Date.now();
    if (
      current?.cookies?.length &&
      current.refreshedAt &&
      now - current.refreshedAt < REFRESH_REUSE_MS
    ) {
      return current;
    }
    // The scheduler must not immediately launch another browser after a failed
    // login. A person searching still gets one attempt; the lock above keeps
    // that attempt from running beside a login that is already in progress.
    if (
      options.scheduled &&
      current?.refreshFailedAt &&
      now - current.refreshFailedAt < REFRESH_FAILURE_COOLDOWN_MS
    ) {
      throw new Error(
        current.refreshError || `Regos session refresh for ${accountLabel} failed recently`
      );
    }

    try {
      const { storageState, vcr1 } = await bootstrapRegosSession(accountLabel, {
        headless: process.env.HEADLESS !== '0',
      });
      const filePath = authStatePathForAccount(accountLabel);
      const next: any = {
        cookies: storageState.cookies || [],
        origins: storageState.origins || [],
        refreshedAt: Date.now(),
        loadedMtimeMs: readAuthMtime(filePath),
      };
      if (vcr1 === false) {
        next.refreshFailedAt = Date.now();
        next.refreshError = `vcr1 session was not established for ${accountLabel}`;
      }
      regosStates.set(accountLabel, next);
      return next;
    } catch (err: any) {
      const state = getRegosState(accountLabel);
      state.refreshFailedAt = Date.now();
      state.refreshError = String(err?.message || err).split('\n')[0];
      throw err;
    }
  });
}

async function refreshRposSession(accountLabel?: any) {
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

async function ensureRegosRequest(accountLabel?: any) {
  let state = getRegosState(accountLabel);
  if (!state.cookies.length) {
    state = await refreshRegosSession(accountLabel);
  }
  return createHttpRequest(state);
}

async function ensureRposRequest(accountLabel?: any) {
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
 * Run an authenticated portal call. On login HTML or HTTP 401, sign in once and retry.
 * A vcr1 login that just failed does not start another browser; the other portals
 * still return, and the next search after the cooldown tries vcr1 again.
 */
async function withRegosSession(accountLabel?: any, fn?: any) {
  let request = await ensureRegosRequest(accountLabel);
  try {
    const result = await fn(request);
    persistRegos(accountLabel);
    return result;
  } catch (err: any) {
    const failedAt = regosStates.get(accountLabel)?.refreshFailedAt;
    const recovery = regosSessionRecovery(err, { refreshFailedAt: failedAt });
    if (recovery !== 'renew') throw err;
    await refreshRegosSession(accountLabel);
    request = await ensureRegosRequest(accountLabel);
    const result = await fn(request);
    persistRegos(accountLabel);
    return result;
  }
}

async function withRposSession(accountLabel?: any, fn?: any) {
  let request = await ensureRposRequest(accountLabel);
  try {
    const result = await fn(request);
    persistRpos(accountLabel);
    return result;
  } catch (err: any) {
    const message = String(err?.message || err);
    if (!/401|login|session|csrf|unauthorized|html/i.test(message)) throw err;
    await refreshRposSession(accountLabel);
    request = await ensureRposRequest(accountLabel);
    const result = await fn(request);
    persistRpos(accountLabel);
    return result;
  }
}

function assertJsonOrThrow(response?: any, label?: any) {
  return response.text().then((text?: any) => {
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

export {
  ensureRegosRequest,
  ensureRposRequest,
  getRegosState,
  getRposState,
  REFRESH_FAILURE_COOLDOWN_MS,
  isVcr1SessionExpiry,
  regosSessionRecovery,
  withRegosSession,
  withRposSession,
  refreshRegosSession,
  refreshRposSession,
  assertJsonOrThrow,
  looksLikeLoginHtml,
};
