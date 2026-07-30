const fs = require('fs');
const {
  easytradeAuthStatePath,
  authStatePath,
  ensureParentDir,
} = require('../paths');

const EASYTRADE_AUTH_STATE_PATH = easytradeAuthStatePath();
const REGOS_AUTH_STATE_PATH = authStatePath();
const EASYTRADE_BASE_URL = 'https://my.easytrade.uz';

function isLoginUrl(url) {
  return String(url || '').toLowerCase().includes('/account/login');
}

function resolveAuthStatePath() {
  if (fs.existsSync(EASYTRADE_AUTH_STATE_PATH)) {
    return EASYTRADE_AUTH_STATE_PATH;
  }
  if (fs.existsSync(REGOS_AUTH_STATE_PATH)) {
    return REGOS_AUTH_STATE_PATH;
  }
  return null;
}

async function createEasyTradeContext(browser, { locale = 'ru-RU', requireExisting = true } = {}) {
  const authPath = resolveAuthStatePath();
  if (!authPath && requireExisting) {
    throw new Error('No auth session found. Run: npm run login:easytrade');
  }

  const options = {
    locale,
    ignoreHTTPSErrors: true,
  };
  if (authPath) {
    options.storageState = authPath;
  }

  return browser.newContext(options);
}

async function persistEasyTradeAuthState(context) {
  ensureParentDir(EASYTRADE_AUTH_STATE_PATH);
  await context.storageState({ path: EASYTRADE_AUTH_STATE_PATH });
  return EASYTRADE_AUTH_STATE_PATH;
}

/**
 * Probe EasyTrade auth. Reuse when already authenticated; otherwise try Regos SSO link.
 * Persists refreshed state. Never logs out.
 * Returns { reused: true } when no SSO hop was needed.
 */
async function ensureEasyTradeSession(context, page, targetUrl = `${EASYTRADE_BASE_URL}/Licenses/Index`) {
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    await persistEasyTradeAuthState(context);
    return { reused: true };
  }

  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (await loginLink.count()) {
    await loginLink.click();
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
  }

  if (isLoginUrl(page.url())) {
    throw new Error('EasyTrade session expired. Run: npm run login:easytrade');
  }

  await persistEasyTradeAuthState(context);
  return { reused: false };
}

module.exports = {
  EASYTRADE_AUTH_STATE_PATH,
  EASYTRADE_BASE_URL,
  resolveAuthStatePath,
  createEasyTradeContext,
  persistEasyTradeAuthState,
  ensureEasyTradeSession,
};
