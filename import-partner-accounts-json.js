const fs = require('fs');
const path = require('path');
const {
  openDb,
  upsertPartnerAccounts,
  startFetchRun,
  finishFetchRun,
  countPartnerAccounts,
} = require('./lib/partners-db');
const { parsePartnerAccountsFromTablesJson } = require('./lib/partner-accounts-parser');

const inputPath = process.argv[2] || path.join(__dirname, 'output', 'partner-accounts-tables.json');

function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const tablesJson = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const accounts = parsePartnerAccountsFromTablesJson(tablesJson);

  if (accounts.length === 0) {
    console.error('No partner account rows found in JSON.');
    process.exit(1);
  }

  const db = openDb();
  const runId = startFetchRun(db, `json:${path.basename(inputPath)}`, accounts.length);
  const saved = upsertPartnerAccounts(db, accounts);
  finishFetchRun(db, runId, {
    pagesFetched: 1,
    recordsFetched: saved,
    recordsTotal: saved,
  });

  console.log(`Imported ${saved} partner account(s) from ${inputPath}`);
  console.log(`Database now has ${countPartnerAccounts(db)} partner account(s) total.`);
  db.close();
}

main();
