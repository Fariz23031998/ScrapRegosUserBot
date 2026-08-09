const { RPOS_BASE_URL } = require('../sync/rpos-auth');
const { getRposCredentials } = require('../sync/accounts');
const { createHttpRequest } = require('./http-client');
const { loadStorageState, saveStorageState } = require('./cookie-jar');
const { rposAuthStatePath } = require('../paths');

function extractCsrfToken(html) {
  const match =
    String(html || '').match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/i) ||
    String(html || '').match(/value=['"]([^'"]+)['"]\s+name=['"]csrfmiddlewaretoken['"]/i);
  return match ? match[1] : null;
}

/**
 * Pure-HTTP Django admin login. Mutates and persists cookie jar on success.
 */
async function loginRposHttp(accountLabel, stateRef) {
  const credentials = getRposCredentials(accountLabel);
  if (!credentials) {
    throw new Error(`RPOS credentials not configured for ${accountLabel}`);
  }

  const request = createHttpRequest(stateRef);
  const loginUrl = `${RPOS_BASE_URL}/admin/login/`;
  const getRes = await request.get(loginUrl, {
    headers: { Accept: 'text/html' },
    timeout: 30000,
  });
  const html = await getRes.text();
  const csrf = extractCsrfToken(html);
  if (!csrf) {
    // Already authenticated (login form missing).
    if (!html.includes('id_username') && getRes.url().includes('/admin/')) {
      saveStorageState(rposAuthStatePath(accountLabel), {
        cookies: stateRef.cookies,
        origins: stateRef.origins || [],
      });
      return { reused: true };
    }
    throw new Error(`RPOS CSRF token not found for ${accountLabel}`);
  }

  const postRes = await request.post(loginUrl, {
    form: {
      username: credentials.username,
      password: credentials.password,
      csrfmiddlewaretoken: csrf,
      next: '/admin/',
    },
    headers: {
      Referer: loginUrl,
      Origin: RPOS_BASE_URL,
      Accept: 'text/html',
    },
    timeout: 30000,
  });

  const finalUrl = postRes.url();
  const body = await postRes.text();
  if (finalUrl.includes('/login') || body.includes('id_username')) {
    throw new Error(`RPOS HTTP login failed for ${accountLabel}`);
  }

  saveStorageState(rposAuthStatePath(accountLabel), {
    cookies: stateRef.cookies,
    origins: stateRef.origins || [],
  });
  return { reused: false };
}

function loadRposState(accountLabel) {
  return loadStorageState(rposAuthStatePath(accountLabel));
}

module.exports = {
  extractCsrfToken,
  loginRposHttp,
  loadRposState,
};
