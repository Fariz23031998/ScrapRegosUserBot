const fs = require('fs');
const path = require('path');
const { logsDir, rposAuthStatePath, ensureParentDir } = require('../paths');

const RPOS_BASE_URL = 'https://api.chayxanshik.uz';
const RPOS_LOGIN_URL = `${RPOS_BASE_URL}/admin/login/`;
const LOGS_DIR = logsDir();

function isRposAuthenticatedUrl(url) {
  const value = String(url || '');
  return value.includes('/admin/') && !value.includes('/login');
}

async function saveLoginErrorScreenshot(page, accountLabel) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const filePath = path.join(LOGS_DIR, `rpos-login-error-${accountLabel.toLowerCase()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

async function createRposContext(browser, { accountLabel, locale = 'ru-RU' } = {}) {
  const options = { locale };
  if (accountLabel) {
    const statePath = rposAuthStatePath(accountLabel);
    if (fs.existsSync(statePath)) {
      options.storageState = statePath;
    }
  }
  return browser.newContext(options);
}

async function persistRposAuthState(context, accountLabel) {
  const statePath = rposAuthStatePath(accountLabel);
  ensureParentDir(statePath);
  await context.storageState({ path: statePath });
  return statePath;
}

async function performRposLogin(page, { username, password, accountLabel = 'rpos' }) {
  if (!(await page.locator('#id_username').count())) {
    if (isRposAuthenticatedUrl(page.url())) {
      return;
    }
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`RPOS login form not found${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }

  await page.locator('#id_username').fill(username);
  await page.locator('#id_password').fill(password);
  await page.locator('input[type="submit"]').click();

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60000 }).catch(() => {});

  if (page.url().includes('/login')) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`RPOS login failed for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }
}

/**
 * Probe RPOS admin auth. Reuse when already authenticated; otherwise log in.
 * Returns { reused: true } when no credential login was needed.
 */
async function ensureRposSession(context, page, { username, password, accountLabel = 'rpos' }) {
  await page.goto(RPOS_LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!(await page.locator('#id_username').count()) && isRposAuthenticatedUrl(page.url())) {
    await persistRposAuthState(context, accountLabel);
    return { reused: true };
  }

  await performRposLogin(page, { username, password, accountLabel });
  await persistRposAuthState(context, accountLabel);
  return { reused: false };
}

/** Low-level login helper that skips credential entry when already authenticated. */
async function loginRposAdmin(page, { username, password, accountLabel = 'rpos' }) {
  await page.goto(RPOS_LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!(await page.locator('#id_username').count())) {
    if (isRposAuthenticatedUrl(page.url())) {
      return { reused: true };
    }
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`RPOS login form not found${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }

  await performRposLogin(page, { username, password, accountLabel });
  return { reused: false };
}

module.exports = {
  RPOS_BASE_URL,
  RPOS_LOGIN_URL,
  createRposContext,
  persistRposAuthState,
  ensureRposSession,
  loginRposAdmin,
};
