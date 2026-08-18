const { CURRENCIES, roundMoney } = require('./money');

const MAX_ACCOUNT_NAME = 100;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureAccountTables(db) {
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

function mapAccount(row) {
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

function normalizeAccountName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > MAX_ACCOUNT_NAME) throw new Error('INVALID_ACCOUNT_NAME');
  return name;
}

function normalizeAccountCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_ACCOUNT_CURRENCY');
  return currency;
}

function accountSelectSql() {
  return 'SELECT id, name, currency, value, created_at, updated_at FROM accounts';
}

function getAccount(db, id) {
  ensureAccountTables(db);
  const accountId = Number(id);
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  return mapAccount(db.prepare(`${accountSelectSql()} WHERE id = ?`).get(accountId));
}

function listAccounts(db) {
  ensureAccountTables(db);
  return db
    .prepare(`${accountSelectSql()} ORDER BY name COLLATE NOCASE ASC, id ASC`)
    .all()
    .map(mapAccount);
}

function createAccount(db, input = {}) {
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

function countPaymentTypesForAccount(db, accountId) {
  if (!tableExists(db, 'payment_types')) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM payment_types WHERE account_id = ?').get(accountId);
  return Number(row?.n) || 0;
}

function recalculateAccountValue(db, id) {
  ensureAccountTables(db);
  const account = getAccount(db, id);
  if (!account) return null;
  let value = 0;
  if (tableExists(db, 'task_payments')) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE
             WHEN p.kind = 'refund' THEN -CASE WHEN ? = 'USD' THEN p.amount_usd ELSE p.amount_uzs END
             ELSE CASE WHEN ? = 'USD' THEN p.amount_usd ELSE p.amount_uzs END
           END
         ), 0) AS value
         FROM task_payments p
         WHERE p.account_id = ?`
      )
      .get(account.currency, account.currency, account.id);
    value = roundMoney(Number(row?.value) || 0);
  }
  db.prepare(`UPDATE accounts SET value = ?, updated_at = datetime('now') WHERE id = ?`).run(
    value,
    account.id
  );
  return getAccount(db, account.id);
}

function recalculateAllAccountValues(db) {
  ensureAccountTables(db);
  const ids = db.prepare('SELECT id FROM accounts').all().map((row) => row.id);
  for (const id of ids) recalculateAccountValue(db, id);
}

function updateAccount(db, id, input = {}) {
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

function deleteAccount(db, id) {
  ensureAccountTables(db);
  const current = getAccount(db, id);
  if (!current) return false;
  if (countPaymentTypesForAccount(db, current.id) > 0) throw new Error('ACCOUNT_IN_USE');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(current.id);
  return true;
}

module.exports = {
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
