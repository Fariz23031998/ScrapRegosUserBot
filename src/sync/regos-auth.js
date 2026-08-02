const fs = require('fs');
const path = require('path');
const {
  logsDir,
  authStatePath,
  authStatePathForAccount,
  ensureParentDir,
} = require('../paths');

const SB_BASE_URL = 'https://sb.regos.uz';
const ET_BASE_URL = 'https://my.easytrade.uz';
const VCR1_BASE_URL = 'https://vcr1.regos.uz';
const LOGIN_ENTRY_URL = `${SB_BASE_URL}/Partners/Index`;
const LOGS_DIR = logsDir();

function isLoginUrl(url) {
  return url.toLowerCase().includes('/account/login');
}

function resolveRegosAuthStatePath(accountLabel) {
  if (accountLabel) {
    return authStatePathForAccount(accountLabel);
  }
  return authStatePath();
}

async function createRegosContext(browser, { accountLabel, locale = 'ru-RU' } = {}) {
  const options = { locale, ignoreHTTPSErrors: true };
  const statePath = resolveRegosAuthStatePath(accountLabel);
  if (fs.existsSync(statePath)) {
    options.storageState = statePath;
  }
  return browser.newContext(options);
}

async function persistRegosAuthState(context, accountLabel) {
  const statePath = resolveRegosAuthStatePath(accountLabel);
  ensureParentDir(statePath);
  await context.storageState({ path: statePath });
  return statePath;
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

function isAuthenticatedAppUrl(url) {
  const href = typeof url === 'string' ? url : url.toString();
  let hostname;
  try {
    hostname = new URL(href).hostname;
  } catch {
    return false;
  }
  if (isLoginUrl(href)) return false;
  return /regos\.uz|easytrade\.uz/i.test(hostname);
}

async function performRegosIdLogin(page, { phone, password, accountLabel = 'account' }) {
  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (!(await loginLink.count())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`Regos ID login link not found${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }

  await loginLink.click();
  // SSO may show the credential form, or silently complete and land on an app page.
  await page
    .waitForURL(
      (url) => url.hostname.includes('auth.regos.uz') || isAuthenticatedAppUrl(url),
      { timeout: 120000 }
    )
    .catch(async () => {
      await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    });

  if (!page.url().includes('auth.regos.uz')) {
    if (isAuthenticatedAppUrl(page.url())) {
      return; // silent SSO auto-completed login
    }
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

/**
 * Probe the Regos session. Reuse when already authenticated; otherwise log in.
 * Returns { reused: true } when no credential login was needed.
 */
async function ensureRegosSession(context, page, { phone, password, accountLabel = 'account' }) {
  await page.goto(LOGIN_ENTRY_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    await persistRegosAuthState(context, accountLabel);
    return { reused: true };
  }

  await performRegosIdLogin(page, { phone, password, accountLabel });
  await persistRegosAuthState(context, accountLabel);
  return { reused: false };
}

/** @deprecated Prefer ensureRegosSession; kept for callers that only have a page. */
async function loginWithRegosId(page, { phone, password, accountLabel = 'account' }) {
  await page.goto(LOGIN_ENTRY_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    return { reused: true };
  }

  await performRegosIdLogin(page, { phone, password, accountLabel });
  return { reused: false };
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

/**
 * Within an already-authenticated Regos SSO browser context, open EasyTrade.
 * Does not log out. Callers should persist the context after a successful sync.
 */
async function ensureEasyTradeSession(page) {
  await page.goto(`${ET_BASE_URL}/Licenses/Index`, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    return { reused: true };
  }

  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (await loginLink.count()) {
    await loginLink.click();
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
  }

  if (isLoginUrl(page.url())) {
    throw new Error('EasyTrade session not available');
  }

  return { reused: false };
}

async function ensureVcr1IndexPage(page, indexPath, accountLabel = 'account') {
  const url = `${VCR1_BASE_URL}${indexPath}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  if (isLoginUrl(page.url())) {
    const loginLink = page.getByRole('link', { name: /войти через regos/i });
    if (!(await loginLink.count())) {
      const screenshot = await saveLoginErrorScreenshot(page, `vcr1-${accountLabel}`);
      throw new Error(
        `vcr1 Regos ID login link not found on ${indexPath}${screenshot ? ` (screenshot: ${screenshot})` : ''}`
      );
    }

    await loginLink.click();
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  }

  if (isLoginUrl(page.url())) {
    const screenshot = await saveLoginErrorScreenshot(page, `vcr1-${accountLabel}`);
    throw new Error(
      `vcr1 session not available on ${indexPath} for ${accountLabel}${
        screenshot ? ` (screenshot: ${screenshot})` : ''
      }`
    );
  }

  if (!page.url().includes(indexPath)) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  }

  if (isLoginUrl(page.url()) || !page.url().includes(indexPath)) {
    const screenshot = await saveLoginErrorScreenshot(page, `vcr1-${accountLabel}`);
    throw new Error(
      `Failed to open vcr1 ${indexPath} for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`
    );
  }
}

async function ensureVcr1PartnersIndex(page, accountLabel) {
  return ensureVcr1IndexPage(page, '/Partners/Index', accountLabel);
}

async function ensureVcr1LicensesIndex(page, accountLabel) {
  return ensureVcr1IndexPage(page, '/Licenses/Index', accountLabel);
}

module.exports = {
  LOGIN_ENTRY_URL,
  SB_BASE_URL,
  ET_BASE_URL,
  VCR1_BASE_URL,
  createRegosContext,
  persistRegosAuthState,
  ensureRegosSession,
  loginWithRegosId,
  ensurePartnersIndex,
  ensurePartnerAccountsIndex,
  ensureEasyTradeSession,
  ensureVcr1PartnersIndex,
  ensureVcr1LicensesIndex,
  isLoginUrl,
};
