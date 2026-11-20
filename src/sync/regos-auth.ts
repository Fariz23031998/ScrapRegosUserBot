import type { Unchecked } from '../types/unchecked';
import fs from 'fs';
import path from 'path';
import { logsDir, authStatePath, authStatePathForAccount, ensureParentDir } from '../paths';

const SB_BASE_URL = 'https://sb.regos.uz';
const ET_BASE_URL = 'https://my.easytrade.uz';
const VCR1_BASE_URL = 'https://vcr1.regos.uz';
const LOGIN_ENTRY_URL = `${SB_BASE_URL}/Partners/Index`;
const LOGS_DIR = logsDir();

function isLoginUrl(url?: any) {
  return url.toLowerCase().includes('/account/login');
}

function resolveRegosAuthStatePath(accountLabel?: any) {
  if (accountLabel) {
    return authStatePathForAccount(accountLabel);
  }
  return authStatePath();
}

async function createRegosContext(browser: any, { accountLabel, locale = 'ru-RU' }: Unchecked = {}) {
  const options: Unchecked = { locale, ignoreHTTPSErrors: true };
  const statePath = resolveRegosAuthStatePath(accountLabel);
  if (fs.existsSync(statePath)) {
    options.storageState = statePath;
  }
  return browser.newContext(options);
}

async function persistRegosAuthState(context?: any, accountLabel?: any) {
  const statePath = resolveRegosAuthStatePath(accountLabel);
  ensureParentDir(statePath);
  await context.storageState({ path: statePath });
  return statePath;
}

async function saveLoginErrorScreenshot(page?: any, accountLabel?: any) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const filePath = path.join(LOGS_DIR, `login-error-${accountLabel.toLowerCase()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch {
    return null;
  }
}

function isRegosAuthUrl(url?: any) {
  const href = typeof url === 'string' ? url : url.toString();
  return href.toLowerCase().includes('auth.regos.uz');
}

function isAuthenticatedAppUrl(url?: any) {
  const href = typeof url === 'string' ? url : url.toString();
  let hostname: any;
  try {
    hostname = new URL(href).hostname;
  } catch {
    return false;
  }
  if (isLoginUrl(href) || isRegosAuthUrl(href)) return false;
  return /regos\.uz|easytrade\.uz/i.test(hostname);
}

async function acceptRegosOAuthConsent(page?: any) {
  const allow = page.getByRole('button', { name: /разрешить доступ/i });
  if (!(await allow.count())) return false;
  await allow.first().click();
  return true;
}

const PERSONAL_DEVICE_BUTTON = /да,?\s*это мо[её] устройство/i;

async function acceptRegosPersonalDevice(page?: any) {
  const trust = page.getByRole('button', { name: PERSONAL_DEVICE_BUTTON });
  if (await trust.count()) {
    await trust.first().click();
    return true;
  }
  if (typeof page.getByText !== 'function') return false;
  const byText = page.getByText(PERSONAL_DEVICE_BUTTON);
  if (!(await byText.count())) return false;
  await byText.first().click();
  return true;
}

/**
 * Password sign-in often stops on auth.regos.uz while still asking for a click:
 * oauth consent (“Разрешить доступ”) or device trust (“Да, это моё устройство”).
 * Those pages stay on auth.regos.uz, so waiting to leave the host never finishes
 * unless the button is clicked.
 */
async function regosIdLoginFormVisible(page: any) {
  if (typeof page?.locator !== 'function') return false;
  try {
    return (await page.locator('#PhoneNumber').count()) > 0;
  } catch {
    return false;
  }
}

/**
 * The vcr1 SSO hop often stops on the Regos ID credential form.
 * Submit the same phone and password the billing session already uses.
 * Returns true when the form was submitted.
 */
async function completeRegosIdLoginForm(page: any, credentials: any) {
  if (!(await regosIdLoginFormVisible(page))) return false;
  const phone = credentials?.phone;
  const password = credentials?.password;
  if (!phone || !password) {
    throw new Error('Regos ID login form is waiting for a phone and password');
  }
  await page.locator('#PhoneNumber').fill(phone, { timeout: 5000 });
  await page.locator('#Password').fill(password, { timeout: 5000 });
  await page.getByRole('button', { name: /^войти$/i }).click();
  return true;
}

async function waitUntilLeftRegosAuth(page: any, timeoutMs: any = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRegosAuthUrl(page.url())) return;
    await acceptRegosOAuthConsent(page).catch(() => {});
    await acceptRegosPersonalDevice(page).catch(() => {});
    const remaining = Math.max(1, deadline - Date.now());
    await page
      .waitForURL((url?: any) => !isRegosAuthUrl(url), { timeout: Math.min(2000, remaining) })
      .catch(() => {});
  }

  if (!isRegosAuthUrl(page.url())) return;

  let location = 'auth.regos.uz';
  try {
    const parsed = new URL(page.url());
    location = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // keep the short fallback
  }
  const screenshot = await saveLoginErrorScreenshot(page, 'regos-auth');
  throw new Error(
    `Regos ID did not finish sign-in (${location})${screenshot ? ` (screenshot: ${screenshot})` : ''}`
  );
}

async function performRegosIdLogin(page: any, { phone, password, accountLabel = 'account' }: Unchecked) {
  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (!(await loginLink.count())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`Regos ID login link not found${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }

  await loginLink.click();
  // SSO may show the credential form, or silently complete and land on an app page.
  await page
    .waitForURL(
      (url?: any) => url.hostname.includes('auth.regos.uz') || isAuthenticatedAppUrl(url),
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
  await waitUntilLeftRegosAuth(page);

  if (isLoginUrl(page.url())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(`Login failed for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`);
  }
}

/**
 * Probe the Regos session. Reuse when already authenticated; otherwise log in.
 * Returns { reused: true } when no credential login was needed.
 */
async function ensureRegosSession(context: any, page: any, { phone, password, accountLabel = 'account' }: Unchecked) {
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
async function loginWithRegosId(page: any, { phone, password, accountLabel = 'account' }: Unchecked) {
  await page.goto(LOGIN_ENTRY_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (!isLoginUrl(page.url())) {
    return { reused: true };
  }

  await performRegosIdLogin(page, { phone, password, accountLabel });
  return { reused: false };
}

async function ensureRegosIndexPage(page: any, indexPath: any, accountLabel: any = 'account') {
  const url = `${SB_BASE_URL}${indexPath}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  if (isLoginUrl(page.url())) {
    const screenshot = await saveLoginErrorScreenshot(page, accountLabel);
    throw new Error(
      `Session expired on ${indexPath} for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`
    );
  }
}

async function ensurePartnersIndex(page?: any, accountLabel?: any) {
  return ensureRegosIndexPage(page, '/Partners/Index', accountLabel);
}

async function ensurePartnerAccountsIndex(page?: any, accountLabel?: any) {
  return ensureRegosIndexPage(page, '/PartnerAccounts/Index', accountLabel);
}

/**
 * Within an already-authenticated Regos SSO browser context, open EasyTrade.
 * Does not log out. Callers should persist the context after a successful sync.
 */
async function ensureEasyTradeSession(page?: any) {
  const indexUrl = `${ET_BASE_URL}/Licenses/Index`;
  await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (isRegosAuthUrl(page.url())) {
    await waitUntilLeftRegosAuth(page);
    if (!page.url().includes('easytrade.uz')) {
      await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }

  if (!isLoginUrl(page.url()) && !isRegosAuthUrl(page.url())) {
    return { reused: true };
  }

  const loginLink = page.getByRole('link', { name: /войти через regos/i });
  if (await loginLink.count()) {
    await loginLink.click();
    await waitUntilLeftRegosAuth(page);
    if (!page.url().includes('easytrade.uz')) {
      await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }

  if (isLoginUrl(page.url()) || isRegosAuthUrl(page.url())) {
    throw new Error('EasyTrade session not available');
  }

  return { reused: false };
}

/**
 * Billing 1.22+ uses the hosted Regos Account widget + OAuth PKCE.
 * Start the same flow the widget uses: /account/external-login → auth.regos.uz → /signin-regos.
 */
async function startVcr1ExternalLogin(page: any, returnPath: any) {
  const returnUrl = String(returnPath || '/Billing/Search').startsWith('/')
    ? String(returnPath || '/Billing/Search')
    : `/${returnPath}`;
  const loginUrl = `${VCR1_BASE_URL}/account/external-login?provider=Regos&returnUrl=${encodeURIComponent(
    returnUrl
  )}&ui_locales=ru`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function ensureVcr1IndexPage(
  page: any,
  indexPath: any,
  accountLabel: any = 'account',
  credentials: any = null
) {
  const url = `${VCR1_BASE_URL}${indexPath}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (isLoginUrl(page.url()) || isRegosAuthUrl(page.url())) {
    if (isLoginUrl(page.url())) {
      // Hosted widget button, else navigate to external-login directly (no «Войти через Regos» link).
      const signIn = page.getByRole('button', { name: /^войти$/i });
      if (await signIn.count()) {
        await signIn.first().click();
        await page
          .waitForURL(
            (next?: any) => {
              const href = typeof next === 'string' ? next : String(next?.href || next || '');
              return isRegosAuthUrl(href) || isAuthenticatedAppUrl(href) || !isLoginUrl(href);
            },
            { timeout: 20000 }
          )
          .catch(() => {});
      }
      if (isLoginUrl(page.url())) {
        await startVcr1ExternalLogin(page, indexPath);
      }
    }

    if (isRegosAuthUrl(page.url())) {
      const submitted = await completeRegosIdLoginForm(page, credentials);
      await waitUntilLeftRegosAuth(page, submitted ? 25000 : 90000);
    }

    if (!page.url().includes(indexPath) && !isLoginUrl(page.url()) && !isRegosAuthUrl(page.url())) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }

  if (isLoginUrl(page.url()) || isRegosAuthUrl(page.url())) {
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

  if (isLoginUrl(page.url()) || isRegosAuthUrl(page.url()) || !page.url().includes(indexPath)) {
    const screenshot = await saveLoginErrorScreenshot(page, `vcr1-${accountLabel}`);
    throw new Error(
      `Failed to open vcr1 ${indexPath} for ${accountLabel}${screenshot ? ` (screenshot: ${screenshot})` : ''}`
    );
  }
}

async function ensureVcr1PartnersIndex(page?: any, accountLabel?: any, credentials?: any) {
  return ensureVcr1IndexPage(page, '/Partners/Index', accountLabel, credentials);
}

async function ensureVcr1LicensesIndex(page?: any, accountLabel?: any, credentials?: any) {
  return ensureVcr1IndexPage(page, '/Licenses/Index', accountLabel, credentials);
}

export {
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
  startVcr1ExternalLogin,
  completeRegosIdLoginForm,
  ensureVcr1PartnersIndex,
  ensureVcr1LicensesIndex,
  isLoginUrl,
  acceptRegosPersonalDevice,
};
