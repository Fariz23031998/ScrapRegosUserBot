const { CURRENCIES } = require('./money');

const MAX_PAYMENT_TYPE_NAME = 100;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

function ensurePaymentTypeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UZS',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(db, 'payment_types', 'currency', "TEXT NOT NULL DEFAULT 'UZS'");
}

function mapPaymentType(row) {
  if (!row) return null;
  const currency = CURRENCIES.includes(row.currency) ? row.currency : 'UZS';
  return {
    id: row.id,
    name: row.name,
    currency,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizePaymentTypeName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > MAX_PAYMENT_TYPE_NAME) throw new Error('INVALID_PAYMENT_TYPE_NAME');
  return name;
}

function normalizePaymentTypeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('INVALID_PAYMENT_TYPE_CURRENCY');
  return currency;
}

function listPaymentTypes(db) {
  ensurePaymentTypeTables(db);
  return db
    .prepare(
      `SELECT id, name, currency, created_at, updated_at
       FROM payment_types
       ORDER BY name COLLATE NOCASE ASC, id ASC`
    )
    .all()
    .map(mapPaymentType);
}

function getPaymentType(db, id) {
  ensurePaymentTypeTables(db);
  const paymentTypeId = Number(id);
  if (!Number.isFinite(paymentTypeId) || paymentTypeId <= 0) return null;
  return mapPaymentType(
    db
      .prepare('SELECT id, name, currency, created_at, updated_at FROM payment_types WHERE id = ?')
      .get(paymentTypeId)
  );
}

function createPaymentType(db, input = {}) {
  ensurePaymentTypeTables(db);
  const name = normalizePaymentTypeName(input.name);
  const currency = normalizePaymentTypeCurrency(input.currency);
  const result = db
    .prepare(
      `INSERT INTO payment_types (name, currency, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`
    )
    .run(name, currency);
  return getPaymentType(db, Number(result.lastInsertRowid));
}

function updatePaymentType(db, id, input = {}) {
  ensurePaymentTypeTables(db);
  const current = getPaymentType(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const name = normalizePaymentTypeName(input.name != null ? input.name : current.name);
  const currency = normalizePaymentTypeCurrency(
    input.currency != null ? input.currency : current.currency
  );
  db.prepare(
    `UPDATE payment_types SET name = ?, currency = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name, currency, current.id);
  return getPaymentType(db, current.id);
}

function deletePaymentType(db, id) {
  ensurePaymentTypeTables(db);
  const current = getPaymentType(db, id);
  if (!current) return false;
  db.prepare('DELETE FROM payment_types WHERE id = ?').run(current.id);
  return true;
}

module.exports = {
  MAX_PAYMENT_TYPE_NAME,
  ensurePaymentTypeTables,
  listPaymentTypes,
  getPaymentType,
  createPaymentType,
  updatePaymentType,
  deletePaymentType,
};
