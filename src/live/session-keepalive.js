const { createHttpRequest } = require('./http-client');
const { looksLikeLoginHtml, getRegosState, getRposState, refreshRegosSession, refreshRposSession } = require('./session-manager');
const { getConfiguredAccounts, hasRposCredentials } = require('../sync/accounts');
const { fetchPartnersPage } = require('../sync/partners-api');
const { fetchLicensesPage } = require('../sync/licenses-api');
const { fetchVcr1PartnersPage } = require('../sync/vcr1-partners-api');
const { searchRposClients } = require('../sync/rpos-api');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const PROBE_PAGE = { start: 0, length: 1, draw: 1, search: '' };

function resolveIntervalMs(value = process.env.SESSION_KEEPALIVE_INTERVAL_MS) {
  if (value == null || String(value).trim() === '') return DEFAULT_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_INTERVAL_MS;
  return Math.floor(parsed);
}

/**
 * Classify one portal probe. Login HTML and HTTP 401 mean the session is dead.
 * A JSON body with a 2xx status is a live session. Other failures (such as HTTP 500)
 * are portal errors and must not start a browser login.
 */
function classifyProbeResponse({ status, body, url } = {}) {
  const code = Number(status) || 0;
  const text = String(body ?? '');
  const href = String(url || '');
  if (code === 401 || looksLikeLoginHtml(text, href)) return 'expired';
  if (code < 200 || code >= 300) return 'error';
  try {
    JSON.parse(text);
    return 'ok';
  } catch {
    return 'error';
  }
}

function classifyThrownProbe(err) {
  const message = String(err?.message || err);
  const statusMatch = message.match(/failed with status (\d+)/i);
  if (statusMatch) {
    return classifyProbeResponse({ status: Number(statusMatch[1]), body: '', url: '' });
  }
  if (/session expired/i.test(message)) {
    return classifyProbeResponse({
      status: 200,
      body: '<html>Войти через Regos</html>',
      url: 'https://sb.regos.uz/account/login',
    });
  }
  return 'error';
}

async function runProbe(label, fn) {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    const outcome = classifyThrownProbe(err);
    if (outcome === 'error') {
      console.error(
        `[session-keepalive] ${label}: ${String(err?.message || err).split('\n')[0]}`
      );
    }
    return outcome;
  }
}

function summarizeProbe(results) {
  if (results.includes('expired')) return 'expired';
  if (results.length && results.every((item) => item === 'error')) return 'error';
  return 'ok';
}

async function probeRegosAccount(accountLabel) {
  const state = getRegosState(accountLabel);
  if (!state.cookies?.length) return 'expired';
  const request = createHttpRequest(state);
  const results = await Promise.all([
    runProbe(`${accountLabel} partners`, () => fetchPartnersPage(request, PROBE_PAGE)),
    runProbe(`${accountLabel} licenses`, () => fetchLicensesPage(request, PROBE_PAGE)),
    runProbe(`${accountLabel} vcr1`, () => fetchVcr1PartnersPage(request, PROBE_PAGE)),
  ]);
  return summarizeProbe(results);
}

async function probeRposAccount(accountLabel) {
  const state = getRposState(accountLabel);
  if (!state.cookies?.length) return 'expired';
  const request = createHttpRequest(state);
  return runProbe(`${accountLabel} rpos`, () =>
    searchRposClients(request, '0', { sourceAccount: accountLabel })
  );
}

async function maintainPortalSessions({
  accounts = getConfiguredAccounts(),
  probeRegos = probeRegosAccount,
  probeRpos = probeRposAccount,
  refreshRegos = (accountLabel) => refreshRegosSession(accountLabel, { scheduled: true }),
  refreshRpos = refreshRposSession,
  hasRpos = hasRposCredentials,
  log = console,
} = {}) {
  for (const accountLabel of accounts) {
    const parts = [];
    try {
      const regos = await probeRegos(accountLabel);
      if (regos === 'expired') {
        await refreshRegos(accountLabel);
        parts.push('regos refreshed');
      } else if (regos === 'error') {
        parts.push('regos probe failed');
      } else {
        parts.push('regos ok');
      }
    } catch (err) {
      parts.push(`regos refresh failed: ${String(err?.message || err).split('\n')[0]}`);
    }

    if (hasRpos(accountLabel)) {
      try {
        const rpos = await probeRpos(accountLabel);
        if (rpos === 'expired') {
          await refreshRpos(accountLabel);
          parts.push('rpos refreshed');
        } else if (rpos === 'error') {
          parts.push('rpos probe failed');
        } else {
          parts.push('rpos ok');
        }
      } catch (err) {
        parts.push(`rpos refresh failed: ${String(err?.message || err).split('\n')[0]}`);
      }
    }

    const line = `[session-keepalive] ${accountLabel} ${parts.join(', ')}`;
    if (parts.some((part) => part.includes('failed'))) log.error(line);
    else log.log(line);
  }
}

function startSessionKeepalive({
  intervalMs = resolveIntervalMs(),
  maintainSessions = maintainPortalSessions,
} = {}) {
  if (!intervalMs) {
    console.log('[session-keepalive] disabled');
    return { stop() {}, tick: async () => {} };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await maintainSessions();
    } catch (err) {
      console.error('[session-keepalive] tick failed:', err?.message || err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const initialDelay = Math.min(5000, intervalMs);
  const initial = setTimeout(tick, initialDelay);
  if (typeof initial.unref === 'function') initial.unref();
  console.log(`[session-keepalive] worker started (every ${intervalMs}ms)`);

  return {
    stop() {
      clearInterval(timer);
      clearTimeout(initial);
    },
    tick,
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  resolveIntervalMs,
  classifyProbeResponse,
  classifyThrownProbe,
  summarizeProbe,
  maintainPortalSessions,
  startSessionKeepalive,
};
