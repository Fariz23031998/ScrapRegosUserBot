const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { outputDir, authStatePath } = require('../src/paths');

const TARGET_URL = 'https://sb.regos.uz/Partners/Index';
const OUTPUT_DIR = outputDir();
const AUTH_STATE_PATH = authStatePath();

async function savePageData(page, label) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const prefix = label ? `${label}-` : '';
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${prefix}page.png`),
    fullPage: true,
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, `${prefix}page.html`), await page.content(), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, `${prefix}page.txt`), await page.locator('body').innerText(), 'utf8');

  const tables = await page.locator('table').count();
  if (tables > 0) {
    const tableData = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table')).map((table, i) => {
        const headers = Array.from(
          table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')
        ).map((el) => el.innerText.trim());
        const rows = Array.from(table.querySelectorAll('tbody tr, tr'))
          .slice(0, 200)
          .map((tr) => Array.from(tr.querySelectorAll('td, th')).map((el) => el.innerText.trim()));
        return { index: i, headers, rows };
      })
    );
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${prefix}tables.json`),
      JSON.stringify(tableData, null, 2),
      'utf8'
    );
    console.log(`Saved ${tables} table(s) to output/${prefix}tables.json`);
  }
}

async function main() {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH);
  const headless = process.env.HEADLESS === '1';

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext(
    hasAuth
      ? { storageState: AUTH_STATE_PATH, locale: 'ru-RU' }
      : { locale: 'ru-RU' }
  );
  const page = await context.newPage();

  console.log(`Navigating to ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

  const onLoginPage =
    page.url().includes('/Account/Login') ||
    (await page.getByText('Войти через Regos ID').count()) > 0;

  if (onLoginPage) {
    if (headless) {
      console.log('Not authenticated. Run: npm run login');
      await browser.close();
      process.exit(2);
    }

    console.log('\n=== Manual login required ===');
    console.log('1. Click "Войти через Regos ID" in the browser window');
    console.log('2. Complete Regos ID sign-in');
    console.log('3. Wait until Partners page loads (or you see the main app)');
    console.log('Waiting up to 5 minutes...\n');

    await page.waitForURL(
      (url) => !url.pathname.toLowerCase().includes('/account/login'),
      { timeout: 300000 }
    ).catch(async () => {
      await page.waitForFunction(
        () => !window.location.pathname.toLowerCase().includes('/account/login'),
        { timeout: 300000 }
      );
    });

    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`Session saved to ${AUTH_STATE_PATH}`);

    if (!page.url().includes('/Partners')) {
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    }
  }

  console.log(`Final URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  await savePageData(page, 'partners');
  console.log('Data saved to output/partners-*');

  const { persistRegosAuthState } = require('../src/sync/regos-auth');
  const { searchPartners } = require('../src/sync/partners-api');
  const sample = await searchPartners(page.request, '', { pageSize: 5 });
  console.log(`Live Partners/Get sample: ${sample.rows.length} row(s), filtered ${sample.total}`);
  await persistRegosAuthState(context);
  console.log('Auth session saved. Prefer: npm run login:sessions');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
