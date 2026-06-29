const fs = require('fs');
const path = require('path');

const SB_BASE_URL = 'https://sb.regos.uz';
const ET_BASE_URL = 'https://my.easytrade.uz';
const LOGIN_ENTRY_URL = `${SB_BASE_URL}/Partners/Index`;
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function isLoginUrl(url) {
  return url.toLowerCase().includes('/account/login');
}

async function saveLoginErrorScreenshot(page, accountLabel) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const filePath = path.join(LOGS_DIR, `login-error-${accountLabel.toLowerCase()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

async function loginWithRegosId(page, { phone, password, accountLabel = 'account' }) {
  await page.goto(LOGIN_ENTRY_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    return;
  }

  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (!(await loginLink.count())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`Regos ID login link not found${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }

  await loginLink.click();
  await page.waitForURL(/auth\.regos\.uz/i, { timeout: 120000 }).catch(async () => {
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
  });

  if (!page.url().includes('auth.regos.uz')) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`Expected auth.regos.uz, got ${page.url()}${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }

  await page.locator('#PhoneNumber').fill(phone);
  await page.locator('#Password').fill(password);
  await page.getByRole('button', { name: /^войти$/i }).click();

  await page
    .waitForURL((url) => !url.hostname.includes('auth.regos.uz'), { timeout: 120000 })
    .catch(async () => {
      await page.waitForFunction(
        () => !window.location.hostname.includes('auth.regos.uz'),
        { timeout: 120000 }
      );
    });

  if (isLoginUrl(page.url())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`Login failed for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }
}

async function ensureRegosIndexPage(page, indexPath, accountLabel = 'account') {
  const url = `${SB_BASE_URL}${indexPath}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  if (isLoginUrl(page.url())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(
      `Session expired on ${indexPath} for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`
    );
  }
}

async function ensurePartnersIndex(page, accountLabel) {
  return ensureRegosIndexPage(page, '/Partners/Index', accountLabel);
}

async function ensurePartnerAccountsIndex(page, accountLabel) {
  return ensureRegosIndexPage(page, '/PartnerAccounts/Index', accountLabel);
}

async function ensureEasyTradeSession(page) {
  await page.goto(`${ET_BASE_URL}/Licenses/Index`, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    return;
  }

  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (await loginLink.count()) {
    await loginLink.click();
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
  }

  if (isLoginUrl(page.url())) {
    throw new Error('EasyTrade session not available');
  }
}

async function logoutRegosSession(page, context) {
  for (const logoutUrl of [`${SB_BASE_URL}/Account/Logout`, `${ET_BASE_URL}/Account/Logout`]) {
    try {
      await page.goto(logoutUrl, { waitUntil: 'networkidle', timeout: 60000 });
    } catch {
      // continue cleanup even if logout page fails
    }
  }

  await context.clearCookies();
}

module.exports = {
  LOGIN_ENTRY_URL,
  SB_BASE_URL,
  ET_BASE_URL,
  loginWithRegosId,
  ensurePartnersIndex,
  ensurePartnerAccountsIndex,
  ensureEasyTradeSession,
  logoutRegosSession,
  isLoginUrl,
};
