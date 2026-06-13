const { chromium } = require('playwright');
const { openDb, syncLicenses } = require('./lib/sync-data');
const { DEFAULT_PAGE_SIZE } = require('./lib/licenses-api');
const { createEasyTradeContext, ensureEasyTradeSession } = require('./lib/easytrade-auth');

const TARGET_URL = 'https://my.easytrade.uz/Licenses/Index';

async function main() {
  const pageSize = Number(process.env.PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const headless = process.env.HEADLESS !== '0';

  const browser = await chromium.launch({ headless });
  const context = await createEasyTradeContext(browser);
  const page = await context.newPage();

  console.log(`Opening ${TARGET_URL}...`);
  await ensureEasyTradeSession(context, page, TARGET_URL);

  const db = openDb();
  console.log(`Fetching licenses (${pageSize} per page)...`);

  const result = await syncLicenses(page.request, db, {
    pageSize,
    onPage: ({ page: pageNum, fetched, total }) => {
      console.log(`  page ${pageNum}: ${fetched}/${total}`);
    },
  });

  console.log(`Saved ${result.saved} license(s) from ${result.pages} page(s) (API total: ${result.total}).`);
  console.log(`Database now has ${result.tableTotal} license(s) total.`);

  db.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
