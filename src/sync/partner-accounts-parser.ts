import { partnerAccountFromTableRow } from '../db/partners-db';

const HEADER_MARKERS: Set<any> = new Set(['Клиент', 'ID', 'id']);

function isHeaderRow(cells?: any) {
  return HEADER_MARKERS.has(String(cells[0]).trim());
}

function parsePartnerAccountsFromTablesJson(tablesJson?: any) {
  const tables = Array.isArray(tablesJson) ? tablesJson : [tablesJson];
  const accounts: any[] = [];
  const seen: Set<any> = new Set();

  for (const table of tables) {
    for (const row of table.rows ?? []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      if (isHeaderRow(row)) continue;

      const account = partnerAccountFromTableRow(row);
      if (!Number.isFinite(account.id) || seen.has(account.id)) continue;

      seen.add(account.id);
      accounts.push(account);
    }
  }

  return accounts;
}

export { parsePartnerAccountsFromTablesJson };
