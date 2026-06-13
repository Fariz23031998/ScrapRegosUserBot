const fs = require('fs');
const path = require('path');
const {
  openDb,
  upsertLicenses,
  startFetchRun,
  finishFetchRun,
  countLicenses,
} = require('./lib/partners-db');
const { parseLicensesFromTablesJson } = require('./lib/licenses-parser');

const inputPath = process.argv[2] || path.join(__dirname, 'output', 'licenses-tables.json');

function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const tablesJson = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const licenses = parseLicensesFromTablesJson(tablesJson);

  if (licenses.length === 0) {
    console.error('No license rows found in JSON.');
    process.exit(1);
  }

  const db = openDb();
  const runId = startFetchRun(db, `json:${path.basename(inputPath)}`, licenses.length);
  const saved = upsertLicenses(db, licenses);
  finishFetchRun(db, runId, {
    pagesFetched: 1,
    recordsFetched: saved,
    recordsTotal: saved,
  });

  console.log(`Imported ${saved} license(s) from ${inputPath}`);
  console.log(`Database now has ${countLicenses(db)} license(s) total.`);
  db.close();
}

main();
