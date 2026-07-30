const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_PATH = path.join(os.tmpdir(), 'ScrapRegosUserBot-sync-all.lock');
const LOCK_RETRY_MS = 250;
const LOCK_MAX_RETRIES = 20;

function isProcessRunning(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;

  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLockPid() {
  try {
    return fs.readFileSync(LOCK_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function lockMessage(message) {
  process.stderr.write(`${message}\n`);
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // brief spin while waiting for lock contention to settle
  }
}

function acquireSyncLock() {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const existing = readLockPid();
      if (existing && isProcessRunning(existing)) {
        lockMessage(`Another sync is already running (pid ${existing}). Exiting.`);
        return false;
      }

      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        // another process may have taken over
      }

      if (attempt < LOCK_MAX_RETRIES - 1) {
        sleep(LOCK_RETRY_MS);
      }
    }
  }

  lockMessage('Could not acquire sync lock after several attempts. Exiting.');
  return false;
}

function releaseSyncLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const owner = readLockPid();
    if (owner && owner !== String(process.pid)) return;
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // ignore cleanup errors
  }
}

if (!acquireSyncLock()) {
  process.exit(0);
}

require('dotenv').config({ path: require('../src/paths').envPath() });
const { chromium } = require('playwright');
const { validateAllAccountsConfigured, hasRposCredentials, getRposCredentials } = require('../src/sync/accounts');
const {
  createRegosContext,
  ensureRegosSession,
  persistRegosAuthState,
  ensurePartnersIndex,
  ensurePartnerAccountsIndex,
  ensureEasyTradeSession,
  ensureVcr1PartnersIndex,
  ensureVcr1LicensesIndex,
} = require('../src/sync/regos-auth');
const { createRposContext, ensureRposSession, persistRposAuthState } = require('../src/sync/rpos-auth');
const {
  openDb,
  syncPartners,
  syncPartnerAccounts,
  syncLicenses,
  syncRposClients,
  syncRposAccounts,
  syncVcr1Partners,
  syncVcr1Licenses,
} = require('../src/sync/sync-data');
const { DEFAULT_PAGE_SIZE: PARTNERS_PAGE_SIZE } = require('../src/sync/partners-api');
const { DEFAULT_PAGE_SIZE: ACCOUNTS_PAGE_SIZE, DEFAULT_ACCOUNT_STATUS } = require('../src/sync/partner-accounts-api');
const { DEFAULT_PAGE_SIZE: LICENSES_PAGE_SIZE } = require('../src/sync/licenses-api');
const { DEFAULT_PAGE_SIZE: VCR1_PARTNERS_PAGE_SIZE } = require('../src/sync/vcr1-partners-api');
const { DEFAULT_PAGE_SIZE: VCR1_LICENSES_PAGE_SIZE } = require('../src/sync/vcr1-licenses-api');
const { logsDir } = require('../src/paths');

const LOGS_DIR = logsDir();

function logPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `sync-${date}.log`);
}

function writeLog(message, { toFile = true } = {}) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  if (!toFile) return;
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.appendFileSync(logPath(), line, 'utf8');
}

function logPageProgress(label) {
  return ({ page, fetched, total }) => {
    writeLog(`  ${label} page ${page}: ${fetched}/${total}`, { toFile: false });
  };
}

async function syncAccountData(page, db, accountLabel) {
  const request = page.request;
  const pageSize = Number(process.env.PAGE_SIZE) || PARTNERS_PAGE_SIZE;
  const accountStatus = Number(process.env.ACCOUNT_STATUS) || DEFAULT_ACCOUNT_STATUS;
  const licensesPageSize = Number(process.env.PAGE_SIZE) || LICENSES_PAGE_SIZE;

  writeLog(`Opening Partners index for ${accountLabel}...`);
  await ensurePartnersIndex(page, accountLabel);

  writeLog(`Syncing partners for ${accountLabel}...`);
  const partners = await syncPartners(request, db, {
    accountLabel,
    pageSize,
    onPage: logPageProgress('partners'),
  });
  writeLog(
    `Partners: saved ${partners.saved} from ${partners.pages} page(s), DB total ${partners.tableTotal}`
  );

  writeLog(`Opening PartnerAccounts index for ${accountLabel}...`);
  await ensurePartnerAccountsIndex(page, accountLabel);

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

  const vcr1PageSize = Number(process.env.PAGE_SIZE) || VCR1_PARTNERS_PAGE_SIZE;
  const vcr1LicensesPageSize = Number(process.env.PAGE_SIZE) || VCR1_LICENSES_PAGE_SIZE;

  writeLog(`Opening vcr1 Partners index for ${accountLabel}...`);
  await ensureVcr1PartnersIndex(page, accountLabel);

  writeLog(`Syncing vcr1 partners for ${accountLabel}...`);
  const vcr1Partners = await syncVcr1Partners(request, db, {
    accountLabel,
    pageSize: vcr1PageSize,
    onPage: logPageProgress('vcr1_partners'),
  });
  writeLog(
    `vcr1 Partners: saved ${vcr1Partners.saved} from ${vcr1Partners.pages} page(s), DB total ${vcr1Partners.tableTotal}`
  );

  writeLog(`Opening vcr1 Licenses index for ${accountLabel}...`);
  await ensureVcr1LicensesIndex(page, accountLabel);

  writeLog(`Syncing vcr1 licenses for ${accountLabel}...`);
  const vcr1Licenses = await syncVcr1Licenses(request, db, {
    accountLabel,
    pageSize: vcr1LicensesPageSize,
    onPage: logPageProgress('vcr1_licenses'),
  });
  writeLog(
    `vcr1 Licenses: saved ${vcr1Licenses.saved} from ${vcr1Licenses.pages} page(s), DB total ${vcr1Licenses.tableTotal}`
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

async function syncRegosAccount(accountLabel, db, headless) {
  const { getAccountCredentials } = require('../src/sync/accounts');
  const credentials = getAccountCredentials(accountLabel);

  writeLog(`=== ${accountLabel} ===`);
  writeLog(`Checking Regos session for ${accountLabel}...`);

  const browser = await chromium.launch({ headless });
  const context = await createRegosContext(browser, { accountLabel });
  const page = await context.newPage();

  try {
    const { reused } = await ensureRegosSession(context, page, { ...credentials, accountLabel });
    writeLog(
      reused
        ? `Reusing authenticated Regos session for ${accountLabel}.`
        : `Logged in to Regos as ${accountLabel}.`
    );

    await syncAccountData(page, db, accountLabel);

    await persistRegosAuthState(context, accountLabel);
    writeLog(`Persisted Regos session for ${accountLabel}.`);
  } finally {
    await browser.close();
  }
}

async function syncRposAccount(accountLabel, db, headless) {
  if (!hasRposCredentials(accountLabel)) {
    writeLog(`RPOS credentials not configured for ${accountLabel}, skipping`);
    return;
  }

  const rposCredentials = getRposCredentials(accountLabel);
  writeLog(`Starting RPOS sync for ${accountLabel}...`);
  writeLog(`Checking RPOS session for ${accountLabel}...`);

  const rposBrowser = await chromium.launch({ headless });
  const rposContext = await createRposContext(rposBrowser, { accountLabel });
  const rposPage = await rposContext.newPage();

  try {
    const { reused } = await ensureRposSession(rposContext, rposPage, {
      ...rposCredentials,
      accountLabel,
    });
    writeLog(
      reused
        ? `Reusing authenticated RPOS session for ${accountLabel}.`
        : `Logged in to RPOS as ${accountLabel}.`
    );

    await syncRposData(rposPage, db, accountLabel);

    await persistRposAuthState(rposContext, accountLabel);
    writeLog(`Persisted RPOS session for ${accountLabel}.`);
  } finally {
    await rposBrowser.close();
  }
}

async function main() {
  const accounts = validateAllAccountsConfigured();
  const headless = process.env.HEADLESS !== '0';
  const db = openDb();
  const failures = [];

  writeLog('Daily sync started.');

  try {
    for (const accountLabel of accounts) {
      try {
        await syncRegosAccount(accountLabel, db, headless);
      } catch (err) {
        writeLog(`Error for ${accountLabel}: ${err.message}`);
        failures.push(`${accountLabel} (Regos): ${err.message}`);
      }

      try {
        await syncRposAccount(accountLabel, db, headless);
      } catch (err) {
        writeLog(`RPOS error for ${accountLabel}: ${err.message}`);
        failures.push(`${accountLabel} (RPOS): ${err.message}`);
      }
    }

    if (failures.length > 0) {
      writeLog(`Daily sync finished with ${failures.length} error(s):`);
      for (const failure of failures) {
        writeLog(`  - ${failure}`);
      }
      process.exitCode = 1;
      return;
    }

    writeLog('Daily sync finished successfully.');
  } finally {
    db.close();
    releaseSyncLock();
  }
}

main().catch((err) => {
  writeLog(`Fatal error: ${err.message}`);
  console.error(err);
  releaseSyncLock();
  process.exit(1);
});
