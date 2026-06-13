require('dotenv').config();

const { chromium } = require('playwright');
const { ACCOUNT_NAMES, getRposCredentials, hasRposCredentials } = require('./lib/accounts');
const { loginRposAdmin, logoutRposAdmin } = require('./lib/rpos-auth');
const { openDb, syncRposClients, syncRposAccounts } = require('./lib/sync-data');

function logPageProgress(label) {
  return ({ page, fetched, total }) => {
    console.log(`  ${label} page ${page}: ${fetched}/${total}`);
  };
}

async function syncRposForAccount(accountLabel, db) {
  const credentials = getRposCredentials(accountLabel);
  if (!credentials) {
    console.log(`RPOS credentials not configured for ${accountLabel}, skipping`);
    return;
  }

  const headless = process.env.HEADLESS !== '0';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: 'ru-RU' });
  const page = await context.newPage();

  try {
    console.log(`=== ${accountLabel} RPOS ===`);
    console.log(`Logging in to RPOS as ${accountLabel}...`);
    await loginRposAdmin(page, { ...credentials, accountLabel });
    console.log(`RPOS login successful for ${accountLabel}.`);

    console.log(`Syncing RPOS clients for ${accountLabel}...`);
    const clients = await syncRposClients(page, db, {
      accountLabel,
      onPage: logPageProgress('rpos_clients'),
    });
    console.log(
      `RPOS clients: saved ${clients.saved} from ${clients.pages} page(s), DB total ${clients.tableTotal}`
    );

    console.log(`Syncing RPOS accounts for ${accountLabel}...`);
    const accounts = await syncRposAccounts(page, db, {
      accountLabel,
      onPage: logPageProgress('rpos_accounts'),
    });
    console.log(
      `RPOS accounts: saved ${accounts.saved} from ${accounts.pages} page(s), DB total ${accounts.tableTotal}`
    );

    console.log(`Logging out RPOS for ${accountLabel}...`);
    await logoutRposAdmin(page, context);
    console.log(`RPOS logout complete for ${accountLabel}.`);
  } catch (err) {
    try {
      await logoutRposAdmin(page, context);
    } catch {
      // ignore cleanup errors
    }
    await browser.close();
    throw err;
  }

  await browser.close();
}

async function main() {
  const configured = ACCOUNT_NAMES.filter(hasRposCredentials);
  if (configured.length === 0) {
    console.error('No RPOS credentials configured. Set {ACCOUNT}_RPOS_USERNAME and {ACCOUNT}_RPOS_PASSWORD in .env');
    process.exit(2);
  }

  const db = openDb();

  for (const accountLabel of configured) {
    await syncRposForAccount(accountLabel, db);
  }

  db.close();
  console.log('RPOS sync finished.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
