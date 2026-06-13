const { partnerFromTableRow } = require('./partners-db');

const HEADER_MARKERS = new Set(['ID', 'id']);

function isHeaderRow(cells) {
  return HEADER_MARKERS.has(String(cells[0]).trim());
}

function parsePartnersFromTablesJson(tablesJson) {
  const tables = Array.isArray(tablesJson) ? tablesJson : [tablesJson];
  const partners = [];
  const seen = new Set();

  for (const table of tables) {
    for (const row of table.rows ?? []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      if (isHeaderRow(row)) continue;

      const id = Number(row[0]);
      if (!Number.isFinite(id) || seen.has(id)) continue;

      seen.add(id);
      partners.push(partnerFromTableRow(row));
    }
  }

  return partners;
}

module.exports = {
  parsePartnersFromTablesJson,
};
