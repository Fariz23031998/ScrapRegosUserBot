const fs = require('fs');
const { chromium } = require('playwright');
const { openDb, syncPartners } = require('../src/sync/sync-data');
const { DEFAULT_PAGE_SIZE } = require('../src/sync/partners-api');
const { createRegosContext, persistRegosAuthState } = require('../src/sync/regos-auth');
const { authStatePath } = require('../src/paths');

const TARGET_URL = 'https://sb.regos.uz/Partners/Index';
const AUTH_STATE_PATH = authStatePath();

async function main() {
  if (!fs.existsSync(AUTH_STATE_PATH)) {
    console.error('No auth session found. Run: npm run login');
    process.exit(2);
  }

  const pageSize = Number(process.env.PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const headless = process.env.HEADLESS !== '0';

  const browser = await chromium.launch({ headless });
  const context = await createRegosContext(browser);
  const page = await context.newPage();

  console.log(`Opening ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

  if (page.url().toLowerCase().includes('/account/login')) {
    console.error('Session expired. Run: npm run login');
    await browser.close();
    process.exit(2);
  }

  console.log('Reusing authenticated Regos session.');

  const db = openDb();
  console.log(`Fetching partners (${pageSize} per page)...`);

  const result = await syncPartners(page.request, db, {
    pageSize,
    onPage: ({ page: pageNum, fetched, total }) => {
      console.log(`  page ${pageNum}: ${fetched}/${total}`);
    },
  });

  console.log(`Saved ${result.saved} partner(s) from ${result.pages} page(s) (API total: ${result.total}).`);
  console.log(`Database now has ${result.tableTotal} partner(s) total.`);

  await persistRegosAuthState(context);
  db.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
