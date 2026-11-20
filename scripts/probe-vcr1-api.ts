/**
 * One-off discovery for vcr1 Billing 1.22.x OAuth + DataTables APIs.
 * Does not persist auth state permanently beyond writing probe artifacts under logs/.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { envPath, logsDir } from '../src/paths';
import { getAccountCredentials } from '../src/sync/accounts';
import {
  VCR1_BASE_URL,
  acceptRegosPersonalDevice,
  isLoginUrl,
} from '../src/sync/regos-auth';

dotenv.config({ path: envPath() });

const OUT_DIR = path.join(logsDir(), 'vcr1-probe');

function isRegosAuthUrl(url: string) {
  return url.toLowerCase().includes('auth.regos.uz');
}

async function waitUntilLeftRegosAuth(page: any, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRegosAuthUrl(page.url())) return;
    const allow = page.getByRole('button', { name: /разрешить доступ/i });
    if (await allow.count()) await allow.first().click().catch(() => {});
    await acceptRegosPersonalDevice(page).catch(() => {});
    const remaining = Math.max(1, deadline - Date.now());
    await page
      .waitForURL((url: URL) => !isRegosAuthUrl(url.toString()), {
        timeout: Math.min(2000, remaining),
      })
      .catch(() => {});
  }
  if (isRegosAuthUrl(page.url())) {
    throw new Error(`Still on auth.regos.uz: ${page.url()}`);
  }
}

async function fillAuthCredentials(page: any, phone: string, password: string) {
  const phoneInput = page.locator('#PhoneNumber');
  await phoneInput.waitFor({ state: 'visible', timeout: 60000 });
  await phoneInput.fill(phone);
  await page.locator('#Password').fill(password);
  await page.getByRole('button', { name: /^войти$/i }).click();
  await waitUntilLeftRegosAuth(page);
}

async function loginVcr1(page: any, phone: string, password: string) {
  const returnUrl = '/Partners/Index';
  const loginUrl = `${VCR1_BASE_URL}/account/external-login?provider=Regos&returnUrl=${encodeURIComponent(returnUrl)}&ui_locales=ru`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

  if (isRegosAuthUrl(page.url())) {
    await fillAuthCredentials(page, phone, password);
  } else if (isLoginUrl(page.url())) {
    const button = page.getByRole('button', { name: /^войти$/i });
    if (await button.count()) {
      await button.first().click();
      await page.waitForURL((url: URL) => isRegosAuthUrl(url.toString()) || !isLoginUrl(url.toString()), {
        timeout: 90000,
      });
      if (isRegosAuthUrl(page.url())) {
        await fillAuthCredentials(page, phone, password);
      }
    }
  }

  if (isLoginUrl(page.url()) || isRegosAuthUrl(page.url())) {
    throw new Error(`Login failed, landed on ${page.url()}`);
  }

  if (!page.url().includes('/Partners/Index')) {
    await page.goto(`${VCR1_BASE_URL}/Partners/Index`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  if (isLoginUrl(page.url())) {
    throw new Error(`Partners/Index still login after OAuth: ${page.url()}`);
  }
}

function summarizeCookies(cookies: any[]) {
  return cookies
    .filter((c) => String(c.domain || '').includes('vcr1.regos.uz') || String(c.domain || '').includes('regos.uz'))
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
}

async function postGet(page: any, pathName: string, referer: string, form: Record<string, string>) {
  return page.evaluate(
    async (args: { pathName: string; referer: string; form: Record<string, string> }) => {
      const body = new URLSearchParams(args.form);
      const response = await fetch(args.pathName, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: args.referer,
        },
        body,
      });
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        contentType: response.headers.get('content-type'),
        textPreview: text.slice(0, 4000),
        textLength: text.length,
        json: (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })(),
      };
    },
    { pathName, referer, form }
  );
}

function partnerForm() {
  const columns = ['id', 'name', 'inn', 'phone', 'contacts', 'company', 'balance', 'id'];
  const orderable = [true, true, true, false, false, true, false, false];
  const form: Record<string, string> = {
    draw: '1',
    start: '0',
    length: '3',
    'search[value]': '',
    'search[regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'DESC',
    'additionalproperty[0][name]': 'legal_status',
    'additionalproperty[1][name]': 'company',
  };
  columns.forEach((data, index) => {
    form[`columns[${index}][data]`] = data;
    form[`columns[${index}][name]`] = '';
    form[`columns[${index}][searchable]`] = 'true';
    form[`columns[${index}][orderable]`] = String(orderable[index]);
    form[`columns[${index}][search][value]`] = '';
    form[`columns[${index}][search][regex]`] = 'false';
  });
  return form;
}

function licenseForm() {
  const columns = [
    'partner',
    'contract',
    'create',
    'status',
    'fm',
    'serial',
    'license',
    'fda_version',
    'app_build_time',
    'db_version',
    'last_receipt_date',
    'last_check_attempt',
    'last_sync',
    'id',
  ];
  const form: Record<string, string> = {
    draw: '1',
    start: '0',
    length: '3',
    'search[value]': '',
    'search[regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'DESC',
  };
  columns.forEach((data, index) => {
    form[`columns[${index}][data]`] = data;
    form[`columns[${index}][name]`] = '';
    form[`columns[${index}][searchable]`] = 'true';
    form[`columns[${index}][orderable]`] = 'true';
    form[`columns[${index}][search][value]`] = '';
    form[`columns[${index}][search][regex]`] = 'false';
  });
  return form;
}

function extractInlineScripts(html: string) {
  const scripts: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const body = match[1].trim();
    if (/DataTable|columns|ajax|Partners\/Get|Licenses\/Get|additionalproperty/i.test(body)) {
      scripts.push(body.slice(0, 12000));
    }
  }
  return scripts;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { phone, password } = getAccountCredentials('BUKHARA');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ru-RU', ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const network: any[] = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/vcr1\.regos\.uz|auth\.regos\.uz/i.test(url)) return;
    if (!/\/(Partners|Licenses|Billing|account|signin)/i.test(url)) return;
    network.push({
      url,
      status: response.status(),
      contentType: response.headers()['content-type'] || null,
    });
  });

  try {
    console.log('Logging into vcr1 via OAuth external-login…');
    await loginVcr1(page, phone, password);
    console.log('Landed:', page.url());

    const partnersHtml = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, 'partners-index.html'), partnersHtml, 'utf8');
    fs.writeFileSync(
      path.join(OUT_DIR, 'partners-index-scripts.json'),
      JSON.stringify(extractInlineScripts(partnersHtml), null, 2),
      'utf8'
    );

    const partnersGet = await postGet(
      page,
      '/Partners/Get',
      `${VCR1_BASE_URL}/Partners/Index`,
      partnerForm()
    );
    fs.writeFileSync(path.join(OUT_DIR, 'partners-get.json'), JSON.stringify(partnersGet, null, 2), 'utf8');
    console.log('Partners/Get', partnersGet.status, partnersGet.json ? Object.keys(partnersGet.json.data?.[0] || {}) : partnersGet.textPreview.slice(0, 200));

    await page.goto(`${VCR1_BASE_URL}/Licenses/Index`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const licensesHtml = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, 'licenses-index.html'), licensesHtml, 'utf8');
    fs.writeFileSync(
      path.join(OUT_DIR, 'licenses-index-scripts.json'),
      JSON.stringify(extractInlineScripts(licensesHtml), null, 2),
      'utf8'
    );

    const licensesGet = await postGet(
      page,
      '/Licenses/Get',
      `${VCR1_BASE_URL}/Licenses/Index`,
      licenseForm()
    );
    fs.writeFileSync(path.join(OUT_DIR, 'licenses-get.json'), JSON.stringify(licensesGet, null, 2), 'utf8');
    console.log('Licenses/Get', licensesGet.status, licensesGet.json ? Object.keys(licensesGet.json.data?.[0] || {}) : licensesGet.textPreview.slice(0, 200));

    const search = await page.evaluate(async () => {
      const response = await fetch('/Billing/Search?q=998', {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const text = await response.text();
      return {
        status: response.status,
        billingHeader: response.headers.get('X-Billing-Search'),
        textPreview: text.slice(0, 3000),
      };
    });
    fs.writeFileSync(path.join(OUT_DIR, 'billing-search.json'), JSON.stringify(search, null, 2), 'utf8');
    console.log('Billing/Search', search.status, search.billingHeader);

    const cookies = summarizeCookies(await context.cookies());
    fs.writeFileSync(path.join(OUT_DIR, 'cookies.json'), JSON.stringify(cookies, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(network, null, 2), 'utf8');
    console.log('Cookies:', cookies.map((c) => c.name).join(', '));
    console.log('Wrote probe artifacts to', OUT_DIR);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
