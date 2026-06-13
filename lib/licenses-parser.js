const { licenseFromTableRow } = require('./partners-db');

const HEADER_MARKERS = new Set(['ФИО', 'ID', 'id', 'Клиент']);

function isHeaderRow(cells) {
  return HEADER_MARKERS.has(String(cells[0]).trim());
}

function parseLicensesFromTablesJson(tablesJson) {
  const tables = Array.isArray(tablesJson) ? tablesJson : [tablesJson];
  const licenses = [];
  const seen = new Set();

  for (const table of tables) {
    for (const row of table.rows ?? []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      if (isHeaderRow(row)) continue;

      const license = licenseFromTableRow(row);
      if (!Number.isFinite(license.id) || seen.has(license.id)) continue;

      seen.add(license.id);
      licenses.push(license);
    }
  }

  return licenses;
}

module.exports = {
  parseLicensesFromTablesJson,
};
