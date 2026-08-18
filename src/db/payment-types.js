const {
  createAccount,
  ensureAccountTables,
  getAccount,
  recalculateAccountValue,
} = require('./accounts');
const { CURRENCIES } = require('./money');

const MAX_PAYMENT_TYPE_NAME = 100;
const SYSTEM_PAYMENT_TYPES = [
  { code: 'payme', name: 'Payme', aliases: ['payme'] },
  { code: 'click', name: 'Click', aliases: ['click'] },
  { code: 'cash', name: 'Наличные', aliases: ['cash', 'наличные'] },
];
const SYSTEM_PAYMENT_TYPE_CODES = SYSTEM_PAYMENT_TYPES.map((item) => item.code);

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

function paymentTypeSelectSql() {
  return `
    SELECT
      pt.id, pt.name, pt.code, pt.is_system, pt.account_id, pt.created_at, pt.updated_at,
      a.name AS account_name, a.currency AS account_currency, a.value AS account_value,
      a.created_at AS account_created_at, a.updated_at AS account_updated_at
    FROM payment_types pt
    LEFT JOIN accounts a ON a.id = pt.account_id
  `;
}

function backfillPaymentTypeAccounts(db) {
  const rows = db
    .prepare('SELECT id, name, currency, account_id FROM payment_types WHERE account_id IS NULL')
    .all();
  for (const row of rows) {
    const currency = CURRENCIES.includes(row.currency) ? row.currency : 'UZS';
    const account = createAccount(db, { name: row.name, currency });
    db.prepare('UPDATE payment_types SET account_id = ? WHERE id = ?').run(account.id, row.id);
  }
}

function seedSystemPaymentTypes(db) {
  const existing = db.prepare('SELECT id, name, code, account_id FROM payment_types').all();
  for (const spec of SYSTEM_PAYMENT_TYPES) {
    let row = existing.find((item) => item.code === spec.code);
    if (!row) {
      const aliases = spec.aliases;
      row = existing.find((item) => aliases.includes(String(item.name || '').trim().toLowerCase()));
    }
    if (row) {
      if (row.code === spec.code && row.account_id) continue;
      let accountId = row.account_id;
      if (!accountId) {
        const account = createAccount(db, { name: spec.name, currency: 'UZS' });
        accountId = account.id;
      }
      db.prepare(
        `UPDATE payment_types
         SET name = ?, code = ?, is_system = 1, account_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(spec.name, spec.code, accountId, row.id);
      row.code = spec.code;
      row.account_id = accountId;
      continue;
    }
    const account = createAccount(db, { name: spec.name, currency: 'UZS' });
    const inserted = db
      .prepare(
        `INSERT INTO payment_types (name, account_id, code, is_system, created_at, updated_at)
         VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`
      )
      .run(spec.name, account.id, spec.code);
    existing.push({
      id: Number(inserted.lastInsertRowid),
      name: spec.name,
      code: spec.code,
      account_id: account.id,
    });
  }
}

function ensurePaymentTypeTables(db) {
  ensureAccountTables(db);
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
  ensureColumn(db, 'payment_types', 'account_id', 'INTEGER');
  ensureColumn(db, 'payment_types', 'code', 'TEXT');
  ensureColumn(db, 'payment_types', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_types_code ON payment_types(code) WHERE code IS NOT NULL'
  );
  backfillPaymentTypeAccounts(db);
  seedSystemPaymentTypes(db);
}

function mapPaymentType(row) {
  if (!row) return null;
  const account =
    row.account_id && row.account_name
      ? {
          id: row.account_id,
          name: row.account_name,
          currency: CURRENCIES.includes(row.account_currency) ? row.account_currency : 'UZS',
          value: Number(row.account_value) || 0,
          created_at: row.account_created_at,
          updated_at: row.account_updated_at,
        }
      : null;
  const currency = account?.currency || (CURRENCIES.includes(row.currency) ? row.currency : 'UZS');
  return {
    id: row.id,
    name: row.name,
    code: row.code || null,
    is_system: Boolean(row.is_system),
    account_id: row.account_id ?? null,
    account,
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

function normalizePaymentTypeAccountId(db, value) {
  const account = getAccount(db, value);
  if (!account) throw new Error('INVALID_PAYMENT_TYPE_ACCOUNT');
  return account.id;
}

function listPaymentTypes(db) {
  ensurePaymentTypeTables(db);
  return db
    .prepare(
      `${paymentTypeSelectSql()}
       ORDER BY CASE WHEN IFNULL(pt.is_system, 0) = 1 THEN 0 ELSE 1 END,
                pt.name COLLATE NOCASE ASC, pt.id ASC`
    )
    .all()
    .map(mapPaymentType);
}

function getPaymentType(db, id) {
  ensurePaymentTypeTables(db);
  const paymentTypeId = Number(id);
  if (!Number.isFinite(paymentTypeId) || paymentTypeId <= 0) return null;
  return mapPaymentType(
    db.prepare(`${paymentTypeSelectSql()} WHERE pt.id = ?`).get(paymentTypeId)
  );
}

function createPaymentType(db, input = {}) {
  ensurePaymentTypeTables(db);
  const name = normalizePaymentTypeName(input.name);
  const accountId = normalizePaymentTypeAccountId(db, input.account_id);
  const result = db
    .prepare(
      `INSERT INTO payment_types (name, account_id, is_system, created_at, updated_at)
       VALUES (?, ?, 0, datetime('now'), datetime('now'))`
    )
    .run(name, accountId);
  return getPaymentType(db, Number(result.lastInsertRowid));
}

function updatePaymentType(db, id, input = {}) {
  ensurePaymentTypeTables(db);
  const current = getPaymentType(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const nextAccountId =
    input.account_id != null ? normalizePaymentTypeAccountId(db, input.account_id) : current.account_id;
  if (!nextAccountId) throw new Error('INVALID_PAYMENT_TYPE_ACCOUNT');
  let name = current.name;
  if (current.is_system) {
    if (input.name != null && normalizePaymentTypeName(input.name) !== current.name) {
      throw new Error('SYSTEM_PAYMENT_TYPE');
    }
  } else if (input.name != null) {
    name = normalizePaymentTypeName(input.name);
  }
  const previousAccountId = current.account_id;
  db.prepare(
    `UPDATE payment_types SET name = ?, account_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name, nextAccountId, current.id);
  if (previousAccountId !== nextAccountId) {
    if (previousAccountId) recalculateAccountValue(db, previousAccountId);
    recalculateAccountValue(db, nextAccountId);
  }
  return getPaymentType(db, current.id);
}

function deletePaymentType(db, id) {
  ensurePaymentTypeTables(db);
  const current = getPaymentType(db, id);
  if (!current) return false;
  if (current.is_system) throw new Error('SYSTEM_PAYMENT_TYPE');
  db.prepare('DELETE FROM payment_types WHERE id = ?').run(current.id);
  return true;
}

module.exports = {
  MAX_PAYMENT_TYPE_NAME,
  SYSTEM_PAYMENT_TYPES,
  SYSTEM_PAYMENT_TYPE_CODES,
  ensurePaymentTypeTables,
  listPaymentTypes,
  getPaymentType,
  createPaymentType,
  updatePaymentType,
  deletePaymentType,
};
