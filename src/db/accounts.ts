import type { Db } from '../types/db';
import { CURRENCIES, roundMoney } from './money';

const MAX_ACCOUNT_NAME = 100;

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureAccountTables(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UZS',
      value REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function mapAccount(row?: any) {
  if (!row) return null;
  const currency = CURRENCIES.includes(row.currency) ? row.currency : 'UZS';
  return {
    id: row.id,
    name: row.name,
    currency,
    value: roundMoney(Number(row.value) || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeAccountName(value?: any) {
  const name = String(value || '').trim();
  if (!name || name.length > MAX_ACCOUNT_NAME) throw new Error('INVALID_ACCOUNT_NAME');
  return name;
}

function normalizeAccountCurrency(value?: any) {
  const currency = String(value || '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_ACCOUNT_CURRENCY');
  return currency;
}

function accountSelectSql() {
  return 'SELECT id, name, currency, value, created_at, updated_at FROM accounts';
}

function getAccount(db: Db, id?: any) {
  ensureAccountTables(db);
  const accountId = Number(id);
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  return mapAccount(db.prepare(`${accountSelectSql()} WHERE id = ?`).get(accountId));
}

function listAccounts(db: Db) {
  ensureAccountTables(db);
  return db
    .prepare(`${accountSelectSql()} ORDER BY name COLLATE NOCASE ASC, id ASC`)
    .all()
    .map(mapAccount);
}

function createAccount(db: Db, input: any = {}) {
  ensureAccountTables(db);
  const name = normalizeAccountName(input.name);
  const currency = normalizeAccountCurrency(input.currency);
  const result = db
    .prepare(
      `INSERT INTO accounts (name, currency, value, created_at, updated_at)
       VALUES (?, ?, 0, datetime('now'), datetime('now'))`
    )
    .run(name, currency);
  return getAccount(db, Number(result.lastInsertRowid));
}

function countPaymentTypesForAccount(db: Db, accountId?: any) {
  if (!tableExists(db, 'payment_types')) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM payment_types WHERE account_id = ?').get(accountId);
  return Number(row?.n) || 0;
}

function countAccountPaymentsForAccount(db: Db, accountId?: any) {
  if (!tableExists(db, 'account_payments')) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM account_payments WHERE account_id = ?').get(accountId);
  return Number(row?.n) || 0;
}

function signedAmountSql(alias?: any, currencyPlaceholder?: any) {
  return `CASE WHEN ${currencyPlaceholder} = 'USD' THEN ${alias}.amount_usd ELSE ${alias}.amount_uzs END`;
}

function recalculateAccountValue(db: Db, id?: any) {
  ensureAccountTables(db);
  const account = getAccount(db, id);
  if (!account) return null;
  let value = 0;
  if (tableExists(db, 'task_payments')) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE
             WHEN p.kind = 'refund' THEN -${signedAmountSql('p', '?')}
             ELSE ${signedAmountSql('p', '?')}
           END
         ), 0) AS value
         FROM task_payments p
         WHERE p.account_id = ?`
      )
      .get(account.currency, account.currency, account.id);
    value = roundMoney(Number(row?.value) || 0);
  }
  if (tableExists(db, 'account_payments')) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE
             WHEN p.direction = 'out' THEN -${signedAmountSql('p', '?')}
             ELSE ${signedAmountSql('p', '?')}
           END
         ), 0) AS value
         FROM account_payments p
         WHERE p.account_id = ?`
      )
      .get(account.currency, account.currency, account.id);
    value = roundMoney(value + (Number(row?.value) || 0));
  }
  db.prepare(`UPDATE accounts SET value = ?, updated_at = datetime('now') WHERE id = ?`).run(
    value,
    account.id
  );
  return getAccount(db, account.id);
}

function recalculateAllAccountValues(db: Db) {
  ensureAccountTables(db);
  const ids = db.prepare('SELECT id FROM accounts').all().map((row?: any) => row.id);
  for (const id of ids) recalculateAccountValue(db, id);
}

function updateAccount(db: Db, id: any, input: any = {}) {
  ensureAccountTables(db);
  const current = getAccount(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const name = input.name != null ? normalizeAccountName(input.name) : current.name;
  const currency =
    input.currency != null ? normalizeAccountCurrency(input.currency) : current.currency;
  db.prepare(`UPDATE accounts SET name = ?, currency = ?, updated_at = datetime('now') WHERE id = ?`).run(
    name,
    currency,
    current.id
  );
  if (currency !== current.currency) return recalculateAccountValue(db, current.id);
  return getAccount(db, current.id);
}

function deleteAccount(db: Db, id?: any) {
  ensureAccountTables(db);
  const current = getAccount(db, id);
  if (!current) return false;
  if (countPaymentTypesForAccount(db, current.id) > 0) throw new Error('ACCOUNT_IN_USE');
  if (countAccountPaymentsForAccount(db, current.id) > 0) throw new Error('ACCOUNT_IN_USE');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(current.id);
  return true;
}

export {
  MAX_ACCOUNT_NAME,
  ensureAccountTables,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  recalculateAccountValue,
  recalculateAllAccountValues,
};
