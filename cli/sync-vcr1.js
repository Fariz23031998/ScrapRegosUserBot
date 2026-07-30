require('dotenv').config({ path: require('../src/paths').envPath() });

const { chromium } = require('playwright');
const { validateAllAccountsConfigured, getAccountCredentials } = require('../src/sync/accounts');
const {
  createRegosContext,
  ensureRegosSession,
  persistRegosAuthState,
  ensureVcr1PartnersIndex,
  ensureVcr1LicensesIndex,
} = require('../src/sync/regos-auth');
const { openDb, syncVcr1Partners, syncVcr1Licenses } = require('../src/sync/sync-data');
const { DEFAULT_PAGE_SIZE: VCR1_PARTNERS_PAGE_SIZE } = require('../src/sync/vcr1-partners-api');
const { DEFAULT_PAGE_SIZE: VCR1_LICENSES_PAGE_SIZE } = require('../src/sync/vcr1-licenses-api');

function logPageProgress(label) {
  return ({ page, fetched, total }) => {
    console.log(`  ${label} page ${page}: ${fetched}/${total}`);
  };
}

async function syncVcr1ForAccount(accountLabel, db) {
  const credentials = getAccountCredentials(accountLabel);
  const headless = process.env.HEADLESS !== '0';
  const pageSize = Number(process.env.PAGE_SIZE) || VCR1_PARTNERS_PAGE_SIZE;
  const licensesPageSize = Number(process.env.PAGE_SIZE) || VCR1_LICENSES_PAGE_SIZE;

  const browser = await chromium.launch({ headless });
  const context = await createRegosContext(browser, { accountLabel });
  const page = await context.newPage();

  try {
    console.log(`=== ${accountLabel} vcr1 ===`);
    console.log(`Checking Regos session for ${accountLabel}...`);
    const { reused } = await ensureRegosSession(context, page, { ...credentials, accountLabel });
    console.log(
      reused
        ? `Reusing authenticated Regos session for ${accountLabel}.`
        : `Logged in to Regos as ${accountLabel}.`
    );

    console.log(`Opening vcr1 Partners index for ${accountLabel}...`);
    await ensureVcr1PartnersIndex(page, accountLabel);

    console.log(`Syncing vcr1 partners for ${accountLabel}...`);
    const partners = await syncVcr1Partners(page.request, db, {
      accountLabel,
      pageSize,
      onPage: logPageProgress('vcr1_partners'),
    });
    console.log(
      `vcr1 Partners: saved ${partners.saved} from ${partners.pages} page(s), DB total ${partners.tableTotal}`
    );

    console.log(`Opening vcr1 Licenses index for ${accountLabel}...`);
    await ensureVcr1LicensesIndex(page, accountLabel);

    console.log(`Syncing vcr1 licenses for ${accountLabel}...`);
    const licenses = await syncVcr1Licenses(page.request, db, {
      accountLabel,
      pageSize: licensesPageSize,
      onPage: logPageProgress('vcr1_licenses'),
    });
    console.log(
      `vcr1 Licenses: saved ${licenses.saved} from ${licenses.pages} page(s), DB total ${licenses.tableTotal}`
    );

    await persistRegosAuthState(context, accountLabel);
    console.log(`Persisted Regos/vcr1 session for ${accountLabel}.`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const accounts = validateAllAccountsConfigured();
  const db = openDb();

  try {
    for (const accountLabel of accounts) {
      await syncVcr1ForAccount(accountLabel, db);
    }
    console.log('vcr1 sync finished.');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
