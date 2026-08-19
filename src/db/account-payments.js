const { getAccount, ensureAccountTables, recalculateAccountValue } = require('./accounts');
const { CURRENCIES, getUsdUzsRate, roundMoney } = require('./money');

const MAX_PAYMENT_NOTE = 500;
const PAYMENT_DIRECTIONS = ['in', 'out'];

const PAYMENT_SELECT = `
  p.id, p.account_id, p.direction, p.amount, p.currency,
  p.amount_uzs, p.amount_usd, p.usd_uzs_rate, p.note,
  p.created_by_user_id, p.created_at,
  a.name AS account_name, a.currency AS account_currency,
  u.display_name AS created_by_display_name,
  u.first_name AS created_by_first_name,
  u.last_name AS created_by_last_name,
  u.admin_login AS created_by_admin_login,
  u.username AS created_by_username
`;

const PAYMENT_FROM = `
  account_payments p
  LEFT JOIN accounts a ON a.id = p.account_id
  LEFT JOIN bot_users u ON u.id = p.created_by_user_id
`;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureAccountPaymentTables(db) {
  ensureAccountTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      amount_uzs REAL NOT NULL,
      amount_usd REAL NOT NULL,
      usd_uzs_rate REAL NOT NULL,
      note TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_payments_account_id ON account_payments(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_payments_created_at ON account_payments(created_at);
  `);
}

function authorLabel(row) {
  const fullName = [row.created_by_first_name, row.created_by_last_name].filter(Boolean).join(' ').trim();
  return (
    row.created_by_display_name ||
    fullName ||
    row.created_by_admin_login ||
    (row.created_by_username ? `@${row.created_by_username}` : null)
  );
}

function mapAccountPayment(row) {
  if (!row) return null;
  const currency = CURRENCIES.includes(row.currency) ? row.currency : 'UZS';
  const direction = PAYMENT_DIRECTIONS.includes(row.direction) ? row.direction : 'in';
  return {
    id: row.id,
    account_id: row.account_id,
    account:
      row.account_id == null
        ? null
        : {
            id: row.account_id,
            name: row.account_name || `Счёт #${row.account_id}`,
            currency: CURRENCIES.includes(row.account_currency) ? row.account_currency : currency,
          },
    direction,
    amount: Number(row.amount) || 0,
    currency,
    amount_uzs: Number(row.amount_uzs) || 0,
    amount_usd: Number(row.amount_usd) || 0,
    usd_uzs_rate: Number(row.usd_uzs_rate) || 0,
    note: row.note || '',
    created_by_user_id: row.created_by_user_id ?? null,
    created_by:
      row.created_by_user_id == null
        ? null
        : {
            id: row.created_by_user_id,
            name: authorLabel(row) || `Сотрудник #${row.created_by_user_id}`,
          },
    created_at: row.created_at,
  };
}

function normalizePaymentAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_ACCOUNT_PAYMENT_AMOUNT');
  return roundMoney(amount);
}

function normalizePaymentNote(value) {
  if (value == null) return null;
  const note = String(value).trim();
  if (note.length > MAX_PAYMENT_NOTE) throw new Error('INVALID_ACCOUNT_PAYMENT_NOTE');
  return note || null;
}

function normalizePaymentCurrency(value, fallback) {
  const raw = value == null || value === '' ? fallback : value;
  const currency = String(raw || '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_ACCOUNT_PAYMENT_CURRENCY');
  return currency;
}

function normalizePaymentDirection(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (!PAYMENT_DIRECTIONS.includes(direction)) throw new Error('INVALID_ACCOUNT_PAYMENT_DIRECTION');
  return direction;
}

function convertPaymentAmount(amount, currency, rate) {
  if (currency === 'USD') {
    return { amount_uzs: roundMoney(amount * rate), amount_usd: roundMoney(amount) };
  }
  return { amount_uzs: roundMoney(amount), amount_usd: roundMoney(amount / rate) };
}

function getAccountPayment(db, id) {
  ensureAccountPaymentTables(db);
  const paymentId = Number(id);
  if (!Number.isFinite(paymentId) || paymentId <= 0) return null;
  return mapAccountPayment(
    db.prepare(`SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_FROM} WHERE p.id = ?`).get(paymentId)
  );
}

function listAccountPayments(db, filters = {}) {
  ensureAccountPaymentTables(db);
  const where = [];
  const params = [];
  const accountId = Number(filters.account_id);
  if (Number.isFinite(accountId) && accountId > 0) {
    where.push('p.account_id = ?');
    params.push(accountId);
  }
  if (filters.direction != null && filters.direction !== '') {
    where.push('p.direction = ?');
    params.push(normalizePaymentDirection(filters.direction));
  }
  const sql = `SELECT ${PAYMENT_SELECT} FROM ${PAYMENT_FROM}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY datetime(p.created_at) DESC, p.id DESC`;
  return db.prepare(sql).all(...params).map(mapAccountPayment);
}

function createAccountPayment(db, input = {}) {
  ensureAccountPaymentTables(db);
  const account = getAccount(db, input.account_id);
  if (!account) throw new Error('INVALID_ACCOUNT_PAYMENT_ACCOUNT');
  const direction = normalizePaymentDirection(input.direction);
  const amount = normalizePaymentAmount(input.amount);
  const currency = normalizePaymentCurrency(input.currency, account.currency);
  const note = normalizePaymentNote(input.note);
  const rate = getUsdUzsRate(db);
  const converted = convertPaymentAmount(amount, currency, rate);
  const createdBy = Number(input.created_by_user_id);
  const result = db
    .prepare(
      `INSERT INTO account_payments (
         account_id, direction, amount, currency,
         amount_uzs, amount_usd, usd_uzs_rate,
         note, created_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      account.id,
      direction,
      amount,
      currency,
      converted.amount_uzs,
      converted.amount_usd,
      rate,
      note,
      Number.isFinite(createdBy) && createdBy > 0 ? createdBy : null
    );
  recalculateAccountValue(db, account.id);
  return getAccountPayment(db, Number(result.lastInsertRowid));
}

function deleteAccountPayment(db, id) {
  ensureAccountPaymentTables(db);
  const current = getAccountPayment(db, id);
  if (!current) return false;
  db.prepare('DELETE FROM account_payments WHERE id = ?').run(current.id);
  if (current.account_id) recalculateAccountValue(db, current.account_id);
  return true;
}

function countAccountPaymentsForAccount(db, accountId) {
  ensureAccountPaymentTables(db);
  if (!tableExists(db, 'account_payments')) return 0;
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM account_payments WHERE account_id = ?').get(id);
  return Number(row?.n) || 0;
}

module.exports = {
  MAX_PAYMENT_NOTE,
  PAYMENT_DIRECTIONS,
  ensureAccountPaymentTables,
  listAccountPayments,
  getAccountPayment,
  createAccountPayment,
  deleteAccountPayment,
  countAccountPaymentsForAccount,
};
