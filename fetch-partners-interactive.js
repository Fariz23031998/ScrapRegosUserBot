const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://sb.regos.uz/Partners/Index';
const OUTPUT_DIR = path.join(__dirname, 'output');
const AUTH_STATE_PATH = path.join(__dirname, 'auth-state.json');

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

  const {
    openDb,
    partnerFromApiRow,
    upsertPartners,
    startFetchRun,
    finishFetchRun,
    countPartners,
  } = require('./lib/partners-db');
  const { fetchAllPartners, DEFAULT_PAGE_SIZE } = require('./lib/partners-api');

  const pageSize = Number(process.env.PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const db = openDb();
  const runId = startFetchRun(db, 'api:/Partners/Get', pageSize);

  console.log(`\nSyncing all partners to SQLite (${pageSize} per page)...`);
  const { rows, total, pages } = await fetchAllPartners(page.request, {
    pageSize,
    onPage: ({ page: pageNum, fetched, total: totalRecords }) => {
      console.log(`  page ${pageNum}: ${fetched}/${totalRecords}`);
    },
  });

  const saved = upsertPartners(db, rows.map(partnerFromApiRow));
  finishFetchRun(db, runId, {
    pagesFetched: pages,
    recordsFetched: saved,
    recordsTotal: total,
  });

  console.log(`SQLite: saved ${saved} partner(s), ${countPartners(db)} total in data/regos.db`);
  db.close();

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
