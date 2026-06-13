require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { validateAllAccountsConfigured, hasRposCredentials, getRposCredentials } = require('./lib/accounts');
const { loginWithRegosId, ensureEasyTradeSession, logoutRegosSession } = require('./lib/regos-auth');
const { loginRposAdmin, logoutRposAdmin } = require('./lib/rpos-auth');
const {
  openDb,
  syncPartners,
  syncPartnerAccounts,
  syncLicenses,
  syncRposClients,
  syncRposAccounts,
} = require('./lib/sync-data');
const { DEFAULT_PAGE_SIZE: PARTNERS_PAGE_SIZE } = require('./lib/partners-api');
const { DEFAULT_PAGE_SIZE: ACCOUNTS_PAGE_SIZE, DEFAULT_ACCOUNT_STATUS } = require('./lib/partner-accounts-api');
const { DEFAULT_PAGE_SIZE: LICENSES_PAGE_SIZE } = require('./lib/licenses-api');

const LOGS_DIR = path.join(__dirname, 'logs');

function logPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `sync-${date}.log`);
}

function writeLog(message) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logPath(), line, 'utf8');
  process.stdout.write(line);
}

function logPageProgress(label) {
  return ({ page, fetched, total }) => {
    writeLog(`  ${label} page ${page}: ${fetched}/${total}`);
  };
}

async function syncAccountData(page, db, accountLabel) {
  const request = page.request;
  const pageSize = Number(process.env.PAGE_SIZE) || PARTNERS_PAGE_SIZE;
  const accountStatus = Number(process.env.ACCOUNT_STATUS) || DEFAULT_ACCOUNT_STATUS;
  const licensesPageSize = Number(process.env.PAGE_SIZE) || LICENSES_PAGE_SIZE;

  writeLog(`Syncing partners for ${accountLabel}...`);
  const partners = await syncPartners(request, db, {
    accountLabel,
    pageSize,
    onPage: logPageProgress('partners'),
  });
  writeLog(
    `Partners: saved ${partners.saved} from ${partners.pages} page(s), DB total ${partners.tableTotal}`
  );

  writeLog(`Syncing partner accounts for ${accountLabel}...`);
  const accounts = await syncPartnerAccounts(request, db, {
    accountLabel,
    pageSize: Number(process.env.PAGE_SIZE) || ACCOUNTS_PAGE_SIZE,
    accountStatus,
    onPage: logPageProgress('partner_accounts'),
  });
  writeLog(
    `Partner accounts: saved ${accounts.saved} from ${accounts.pages} page(s), DB total ${accounts.tableTotal}`
  );

  writeLog(`Opening EasyTrade for ${accountLabel}...`);
  await ensureEasyTradeSession(page);

  writeLog(`Syncing licenses for ${accountLabel}...`);
  const licenses = await syncLicenses(request, db, {
    accountLabel,
    pageSize: licensesPageSize,
    onPage: logPageProgress('licenses'),
  });
  writeLog(
    `Licenses: saved ${licenses.saved} from ${licenses.pages} page(s), DB total ${licenses.tableTotal}`
  );
}

async function syncRposData(page, db, accountLabel) {
  writeLog(`Syncing RPOS clients for ${accountLabel}...`);
  const clients = await syncRposClients(page, db, {
    accountLabel,
    onPage: logPageProgress('rpos_clients'),
  });
  writeLog(
    `RPOS clients: saved ${clients.saved} from ${clients.pages} page(s), DB total ${clients.tableTotal}`
  );

  writeLog(`Syncing RPOS accounts for ${accountLabel}...`);
  const accounts = await syncRposAccounts(page, db, {
    accountLabel,
    onPage: logPageProgress('rpos_accounts'),
  });
  writeLog(
    `RPOS accounts: saved ${accounts.saved} from ${accounts.pages} page(s), DB total ${accounts.tableTotal}`
  );
}

async function main() {
  const accounts = validateAllAccountsConfigured();
  const headless = process.env.HEADLESS !== '0';
  const db = openDb();

  writeLog('Daily sync started.');

  for (const accountLabel of accounts) {
    const { getAccountCredentials } = require('./lib/accounts');
    const credentials = getAccountCredentials(accountLabel);

    writeLog(`=== ${accountLabel} ===`);
    writeLog(`Logging in as ${accountLabel}...`);

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ locale: 'ru-RU', ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      await loginWithRegosId(page, { ...credentials, accountLabel });
      writeLog(`Login successful for ${accountLabel}.`);

      await syncAccountData(page, db, accountLabel);

      writeLog(`Logging out ${accountLabel}...`);
      await logoutRegosSession(page, context);
      writeLog(`Logout complete for ${accountLabel}.`);
    } catch (err) {
      writeLog(`Error for ${accountLabel}: ${err.message}`);
      try {
        await logoutRegosSession(page, context);
      } catch {
        // ignore cleanup errors
      }
      await browser.close();
      db.close();
      process.exit(1);
    }

    await browser.close();

    if (hasRposCredentials(accountLabel)) {
      const rposCredentials = getRposCredentials(accountLabel);
      writeLog(`Starting RPOS sync for ${accountLabel}...`);

      const rposBrowser = await chromium.launch({ headless });
      const rposContext = await rposBrowser.newContext({ locale: 'ru-RU' });
      const rposPage = await rposContext.newPage();

      try {
        await loginRposAdmin(rposPage, { ...rposCredentials, accountLabel });
        writeLog(`RPOS login successful for ${accountLabel}.`);

        await syncRposData(rposPage, db, accountLabel);

        writeLog(`Logging out RPOS for ${accountLabel}...`);
        await logoutRposAdmin(rposPage, rposContext);
        writeLog(`RPOS logout complete for ${accountLabel}.`);
      } catch (err) {
        writeLog(`RPOS error for ${accountLabel}: ${err.message}`);
        try {
          await logoutRposAdmin(rposPage, rposContext);
        } catch {
          // ignore cleanup errors
        }
        await rposBrowser.close();
        db.close();
        process.exit(1);
      }

      await rposBrowser.close();
    } else {
      writeLog(`RPOS credentials not configured for ${accountLabel}, skipping`);
    }
  }

  writeLog('Daily sync finished successfully.');
  db.close();
}

main().catch((err) => {
  writeLog(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
