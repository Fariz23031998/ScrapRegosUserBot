import { licenseFromTableRow } from '../db/partners-db';

const HEADER_MARKERS: Set<any> = new Set(['ФИО', 'ID', 'id', 'Клиент']);

function isHeaderRow(cells?: any) {
  return HEADER_MARKERS.has(String(cells[0]).trim());
}

function parseLicensesFromTablesJson(tablesJson?: any) {
  const tables = Array.isArray(tablesJson) ? tablesJson : [tablesJson];
  const licenses: any[] = [];
  const seen: Set<any> = new Set();

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

export { parseLicensesFromTablesJson };
