const fs = require('fs');
const path = require('path');

const RPOS_BASE_URL = 'https://api.chayxanshik.uz';
const RPOS_LOGIN_URL = `${RPOS_BASE_URL}/admin/login/`;
const LOGS_DIR = path.join(__dirname, '..', 'logs');

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

async function loginRposAdmin(page, { username, password, accountLabel = 'rpos' }) {
  await page.goto(RPOS_LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!(await page.locator('#id_username').count())) {
    if (page.url().includes('/admin/') && !page.url().includes('/login')) {
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

async function logoutRposAdmin(page, context) {
  try {
    await page.goto(`${RPOS_BASE_URL}/admin/logout/`, { waitUntil: 'networkidle', timeout: 30000 });
  } catch {
    // ignore
  }
  await context.clearCookies();
}

module.exports = {
  RPOS_BASE_URL,
  RPOS_LOGIN_URL,
  loginRposAdmin,
  logoutRposAdmin,
};
