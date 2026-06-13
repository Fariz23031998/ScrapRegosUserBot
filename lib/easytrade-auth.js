const fs = require('fs');
const path = require('path');

const EASYTRADE_AUTH_STATE_PATH = path.join(__dirname, '..', 'auth-state-easytrade.json');
const REGOS_AUTH_STATE_PATH = path.join(__dirname, '..', 'auth-state.json');
const EASYTRADE_BASE_URL = 'https://my.easytrade.uz';

function resolveAuthStatePath() {
  if (fs.existsSync(EASYTRADE_AUTH_STATE_PATH)) {
    return EASYTRADE_AUTH_STATE_PATH;
  }
  if (fs.existsSync(REGOS_AUTH_STATE_PATH)) {
    return REGOS_AUTH_STATE_PATH;
  }
  return null;
}

async function createEasyTradeContext(browser, { locale = 'ru-RU' } = {}) {
  const authPath = resolveAuthStatePath();
  if (!authPath) {
    throw new Error('No auth session found. Run: npm run login:easytrade');
  }

  return browser.newContext({
    storageState: authPath,
    locale,
    ignoreHTTPSErrors: true,
  });
}

async function ensureEasyTradeSession(context, page, targetUrl) {
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

  if (!page.url().toLowerCase().includes('/account/login')) {
    return false;
  }

  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (await loginLink.count()) {
    await loginLink.click();
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
  }

  if (page.url().toLowerCase().includes('/account/login')) {
    throw new Error('EasyTrade session expired. Run: npm run login:easytrade');
  }

  await context.storageState({ path: EASYTRADE_AUTH_STATE_PATH });
  return true;
}

module.exports = {
  EASYTRADE_AUTH_STATE_PATH,
  EASYTRADE_BASE_URL,
  resolveAuthStatePath,
  createEasyTradeContext,
  ensureEasyTradeSession,
};
