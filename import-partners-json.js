const fs = require('fs');
const path = require('path');
const { openDb, upsertPartners, startFetchRun, finishFetchRun, countPartners } = require('./lib/partners-db');
const { parsePartnersFromTablesJson } = require('./lib/partners-parser');

const inputPath = process.argv[2] || path.join(__dirname, 'output', 'partners-tables.json');

function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const tablesJson = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const partners = parsePartnersFromTablesJson(tablesJson);

  if (partners.length === 0) {
    console.error('No partner rows found in JSON.');
    process.exit(1);
  }

  const db = openDb();
  const runId = startFetchRun(db, `json:${path.basename(inputPath)}`, partners.length);
  const saved = upsertPartners(db, partners);
  finishFetchRun(db, runId, {
    pagesFetched: 1,
    recordsFetched: saved,
    recordsTotal: saved,
  });

  console.log(`Imported ${saved} partner(s) from ${inputPath}`);
  console.log(`Database now has ${countPartners(db)} partner(s) total.`);
  db.close();
}

main();
