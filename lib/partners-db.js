const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { logOrderEvent } = require('./order-logs');
const {
  migrateBotUsersSchema,
  getBotUser,
  getBotUserByTelegramId,
  getBotUserById,
  getEmployeeByPhone,
  findUserByPhone,
  getBotUsersByPhone,
  linkEmployeeTelegram,
  registerCustomer,
  createEmployeeUser,
  updateEmployeeUser,
  deleteEmployeeUser,
  listEmployeeUsers,
  getEmployeeWithRights,
  getUserRights,
  upsertUserRights,
  countBotUsers,
  isLinkedEmployee,
  getAllUnpaidOrders,
  deletePendingOrder,
  getEarningsRows,
} = require('./bot-users-db');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'regos.db');

function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partners (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      legal_status TEXT,
      phone TEXT,
      contacts TEXT,
      description TEXT,
      moderation_status TEXT,
      balance TEXT,
      registered_at TEXT,
      sale_partner INTEGER,
      sale_partner_accept INTEGER,
      sale_partner_accept_date TEXT,
      sale_partner_status TEXT,
      sale_partner_status_until TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fetch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      page_size INTEGER,
      pages_fetched INTEGER,
      records_fetched INTEGER,
      records_total INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS partner_accounts (
      id INTEGER PRIMARY KEY,
      partner TEXT NOT NULL,
      status TEXT,
      status_id INTEGER,
      api_server TEXT,
      api_login TEXT,
      tariff TEXT,
      paid_until TEXT,
      dealer_create TEXT,
      date_create TEXT,
      dealer TEXT,
      last_update TEXT,
      balance TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_partners_registered_at ON partners(registered_at);
    CREATE INDEX IF NOT EXISTS idx_partners_name ON partners(name);
    CREATE INDEX IF NOT EXISTS idx_partner_accounts_partner ON partner_accounts(partner);
    CREATE INDEX IF NOT EXISTS idx_partner_accounts_api_login ON partner_accounts(api_login);
    CREATE INDEX IF NOT EXISTS idx_partner_accounts_date_create ON partner_accounts(date_create);
    CREATE INDEX IF NOT EXISTS idx_partner_accounts_status_id ON partner_accounts(status_id);

    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY,
      fio TEXT NOT NULL,
      phone TEXT,
      generated TEXT,
      code TEXT,
      type TEXT,
      contract TEXT,
      license_key TEXT,
      objects INTEGER,
      cashes INTEGER,
      adr TEXT,
      note TEXT,
      active TEXT,
      server TEXT,
      support TEXT,
      partner TEXT,
      partner_phone TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_fio ON licenses(fio);
    CREATE INDEX IF NOT EXISTS idx_licenses_code ON licenses(code);
    CREATE INDEX IF NOT EXISTS idx_licenses_generated ON licenses(generated);
    CREATE INDEX IF NOT EXISTS idx_licenses_partner ON licenses(partner);

    CREATE TABLE IF NOT EXISTS rpos_clients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      created_at TEXT,
      source_account TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rpos_clients_phone ON rpos_clients(phone);
    CREATE INDEX IF NOT EXISTS idx_rpos_clients_created_at ON rpos_clients(created_at);

    CREATE TABLE IF NOT EXISTS rpos_accounts (
      id INTEGER PRIMARY KEY,
      code TEXT,
      client_name TEXT,
      created_at TEXT,
      source_account TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rpos_accounts_code ON rpos_accounts(code);
    CREATE INDEX IF NOT EXISTS idx_rpos_accounts_created_at ON rpos_accounts(created_at);

    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bot_users_phone ON bot_users(phone);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      bot_user_phone TEXT,
      client_phone TEXT NOT NULL,
      client_type TEXT,
      additional_phone TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UZS',
      status TEXT NOT NULL DEFAULT 'pending',
      payment_provider TEXT NOT NULL DEFAULT 'click',
      payment_transaction_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_telegram_id ON orders(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_client_phone ON orders(client_phone);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      telegram_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      provider TEXT NOT NULL,
      click_trans_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);

    CREATE TABLE IF NOT EXISTS payme_transactions (
      payme_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      state INTEGER NOT NULL,
      create_time INTEGER NOT NULL,
      perform_time INTEGER,
      cancel_time INTEGER,
      cancel_reason INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payme_transactions_order_id ON payme_transactions(order_id);
  `);
  migrateSchema(db);
}

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function migrateSchema(db) {
  if (!columnExists(db, 'payments', 'external_transaction_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN external_transaction_id TEXT');
  }
  if (!columnExists(db, 'orders', 'payme_receipt_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN payme_receipt_id TEXT');
  }
  if (!columnExists(db, 'orders', 'payme_receipt_created_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN payme_receipt_created_at INTEGER');
  }
  migrateBotUsersSchema(db);
  const { ensureOrderLogsTable } = require('./order-logs');
  ensureOrderLogsTable(db);
}

const upsertPartnerStmt = (db) =>
  db.prepare(`
    INSERT INTO partners (
      id, name, legal_status, phone, contacts, description,
      moderation_status, balance, registered_at,
      sale_partner, sale_partner_accept, sale_partner_accept_date,
      sale_partner_status, sale_partner_status_until, updated_at
    ) VALUES (
      @id, @name, @legal_status, @phone, @contacts, @description,
      @moderation_status, @balance, @registered_at,
      @sale_partner, @sale_partner_accept, @sale_partner_accept_date,
      @sale_partner_status, @sale_partner_status_until, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      legal_status = excluded.legal_status,
      phone = excluded.phone,
      contacts = excluded.contacts,
      description = excluded.description,
      moderation_status = excluded.moderation_status,
      balance = excluded.balance,
      registered_at = excluded.registered_at,
      sale_partner = excluded.sale_partner,
      sale_partner_accept = excluded.sale_partner_accept,
      sale_partner_accept_date = excluded.sale_partner_accept_date,
      sale_partner_status = excluded.sale_partner_status,
      sale_partner_status_until = excluded.sale_partner_status_until,
      updated_at = datetime('now')
  `);

function partnerFromApiRow(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    legal_status: row.legal_status ?? null,
    phone: row.phone ?? null,
    contacts: row.contacts ?? null,
    description: row.description ?? null,
    moderation_status: row.status ?? null,
    balance: row.balance ?? null,
    registered_at: row.create_date ?? null,
    sale_partner: row.sale_partner ? 1 : 0,
    sale_partner_accept: row.sale_partner_accept ? 1 : 0,
    sale_partner_accept_date: row.sale_partner_accept_date ?? null,
    sale_partner_status: row.sale_partner_status ?? null,
    sale_partner_status_until: row.sale_partner_status_until ?? null,
  };
}

function partnerFromTableRow(cells) {
  return {
    id: Number(cells[0]),
    name: cells[1] ?? '',
    legal_status: cells[2] || null,
    phone: cells[3] || null,
    contacts: cells[4] || null,
    description: cells[5] || null,
    moderation_status: cells[6] || null,
    balance: cells[7] || null,
    registered_at: cells[8] || null,
    sale_partner: null,
    sale_partner_accept: null,
    sale_partner_accept_date: null,
    sale_partner_status: null,
    sale_partner_status_until: null,
  };
}

function upsertPartners(db, partners) {
  const stmt = upsertPartnerStmt(db);
  db.exec('BEGIN');
  try {
    for (const row of partners) {
      stmt.run(row);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return partners.length;
}

function startFetchRun(db, source, pageSize) {
  const result = db
    .prepare('INSERT INTO fetch_runs (source, page_size) VALUES (?, ?)')
    .run(source, pageSize);
  return result.lastInsertRowid;
}

function finishFetchRun(db, runId, { pagesFetched, recordsFetched, recordsTotal }) {
  db.prepare(
    `UPDATE fetch_runs
     SET pages_fetched = ?, records_fetched = ?, records_total = ?, finished_at = datetime('now')
     WHERE id = ?`
  ).run(pagesFetched, recordsFetched, recordsTotal, runId);
}

function countPartners(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM partners').get().count;
}

const upsertPartnerAccountStmt = (db) =>
  db.prepare(`
    INSERT INTO partner_accounts (
      id, partner, status, status_id, api_server, api_login, tariff,
      paid_until, dealer_create, date_create, dealer, last_update, balance, updated_at
    ) VALUES (
      @id, @partner, @status, @status_id, @api_server, @api_login, @tariff,
      @paid_until, @dealer_create, @date_create, @dealer, @last_update, @balance, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      partner = excluded.partner,
      status = excluded.status,
      status_id = excluded.status_id,
      api_server = excluded.api_server,
      api_login = excluded.api_login,
      tariff = excluded.tariff,
      paid_until = excluded.paid_until,
      dealer_create = excluded.dealer_create,
      date_create = excluded.date_create,
      dealer = excluded.dealer,
      last_update = excluded.last_update,
      balance = excluded.balance,
      updated_at = datetime('now')
  `);

function partnerAccountFromApiRow(row) {
  return {
    id: row.id,
    partner: row.partner ?? '',
    status: row.status ?? null,
    status_id: row.status_id ?? null,
    api_server: row.api_server ?? null,
    api_login: row.api_login ?? null,
    tariff: row.tariff ?? null,
    paid_until: row.paid_until ?? null,
    dealer_create: row.dealer_create ?? null,
    date_create: row.date_create ?? null,
    dealer: row.dealer ?? null,
    last_update: row.last_update ?? null,
    balance: row.balance ?? null,
  };
}

function partnerAccountFromTableRow(cells) {
  const id = Number(cells[9]);
  return {
    id: Number.isFinite(id) ? id : null,
    partner: cells[0] ?? '',
    status: cells[1] || null,
    status_id: null,
    api_server: cells[2] || null,
    api_login: cells[3] || null,
    tariff: cells[4] || null,
    paid_until: cells[5] || null,
    dealer_create: cells[6] || null,
    date_create: cells[7] || null,
    dealer: cells[8] || null,
    last_update: null,
    balance: null,
  };
}

function upsertPartnerAccounts(db, accounts) {
  const stmt = upsertPartnerAccountStmt(db);
  db.exec('BEGIN');
  try {
    for (const row of accounts) {
      stmt.run(row);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return accounts.length;
}

function countPartnerAccounts(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM partner_accounts').get().count;
}

const upsertLicenseStmt = (db) =>
  db.prepare(`
    INSERT INTO licenses (
      id, fio, phone, generated, code, type, contract, license_key,
      objects, cashes, adr, note, active, server, support, partner, partner_phone, updated_at
    ) VALUES (
      @id, @fio, @phone, @generated, @code, @type, @contract, @license_key,
      @objects, @cashes, @adr, @note, @active, @server, @support, @partner, @partner_phone, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      fio = excluded.fio,
      phone = excluded.phone,
      generated = excluded.generated,
      code = excluded.code,
      type = excluded.type,
      contract = excluded.contract,
      license_key = excluded.license_key,
      objects = excluded.objects,
      cashes = excluded.cashes,
      adr = excluded.adr,
      note = excluded.note,
      active = excluded.active,
      server = excluded.server,
      support = excluded.support,
      partner = excluded.partner,
      partner_phone = excluded.partner_phone,
      updated_at = datetime('now')
  `);

function licenseFromApiRow(row) {
  return {
    id: row.id,
    fio: row.fio ?? '',
    phone: row.phone ?? null,
    generated: row.generated ?? null,
    code: row.code ?? null,
    type: row.type ?? null,
    contract: row.contract ?? null,
    license_key: row.key ?? null,
    objects: row.objects ?? null,
    cashes: row.cashes ?? null,
    adr: row.adr ?? null,
    note: row.note ?? null,
    active: row.active ?? null,
    server: row.server ?? null,
    support: row.support ?? null,
    partner: row.partner ?? null,
    partner_phone: row.partner_phone ?? null,
  };
}

function licenseFromTableRow(cells) {
  const id = Number(cells[9]);
  return {
    id: Number.isFinite(id) ? id : null,
    fio: cells[0] ?? '',
    phone: cells[1] || null,
    generated: cells[2] || null,
    code: cells[3] || null,
    type: cells[4] || null,
    contract: null,
    license_key: null,
    objects: null,
    cashes: null,
    adr: null,
    note: cells[7] || null,
    active: null,
    server: cells[6] || null,
    support: cells[5] || null,
    partner: cells[8] || null,
    partner_phone: null,
  };
}

function upsertLicenses(db, licenses) {
  const stmt = upsertLicenseStmt(db);
  db.exec('BEGIN');
  try {
    for (const row of licenses) {
      stmt.run(row);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return licenses.length;
}

function countLicenses(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM licenses').get().count;
}

const upsertRposClientStmt = (db) =>
  db.prepare(`
    INSERT INTO rpos_clients (id, name, phone, created_at, source_account, updated_at)
    VALUES (@id, @name, @phone, @created_at, @source_account, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone,
      created_at = excluded.created_at,
      source_account = excluded.source_account,
      updated_at = datetime('now')
  `);

const upsertRposAccountStmt = (db) =>
  db.prepare(`
    INSERT INTO rpos_accounts (id, code, client_name, created_at, source_account, updated_at)
    VALUES (@id, @code, @client_name, @created_at, @source_account, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      code = excluded.code,
      client_name = excluded.client_name,
      created_at = excluded.created_at,
      source_account = excluded.source_account,
      updated_at = datetime('now')
  `);

function upsertRposClients(db, clients) {
  const stmt = upsertRposClientStmt(db);
  db.exec('BEGIN');
  try {
    for (const row of clients) {
      stmt.run(row);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return clients.length;
}

function upsertRposAccounts(db, accounts) {
  const stmt = upsertRposAccountStmt(db);
  db.exec('BEGIN');
  try {
    for (const row of accounts) {
      stmt.run(row);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return accounts.length;
}

function countRposClients(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM rpos_clients').get().count;
}

function countRposAccounts(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM rpos_accounts').get().count;
}

function createOrder(
  db,
  {
    id,
    telegramId,
    botUserPhone,
    clientPhone,
    clientType,
    additionalPhone = null,
    amount,
    currency = 'UZS',
    status = 'pending',
    paymentProvider = 'click',
    metadata = null,
  }
) {
  db.prepare(
    `INSERT INTO orders (
      id, telegram_id, bot_user_phone, client_phone, client_type, additional_phone,
      amount, currency, status, payment_provider, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    id,
    telegramId,
    botUserPhone ?? null,
    clientPhone,
    clientType ?? null,
    additionalPhone,
    amount,
    currency,
    status,
    paymentProvider,
    metadata
  );
  const order = getOrderById(db, id);
  logOrderEvent(db, {
    orderId: id,
    action: 'created',
    actorTelegramId: telegramId,
    actorPhone: botUserPhone ?? null,
    orderAmount: amount,
    clientPhone,
  });
  return order;
}

function getOrderById(db, orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) ?? null;
}

function setOrderPaymeReceiptId(db, orderId, receiptId, receiptCreatedAt = Date.now()) {
  db.prepare(
    'UPDATE orders SET payme_receipt_id = ?, payme_receipt_created_at = ? WHERE id = ?'
  ).run(receiptId, receiptCreatedAt, orderId);
  return getOrderById(db, orderId);
}

function markOrderPaid(
  db,
  orderId,
  { clickTransId = null, transactionId = null, provider = null } = {}
) {
  const transId = transactionId ?? clickTransId;
  db.prepare(
    `UPDATE orders
     SET status = 'paid',
         payment_transaction_id = ?,
         payment_provider = COALESCE(?, payment_provider),
         paid_at = datetime('now')
     WHERE id = ?`
  ).run(transId, provider, orderId);
  return getOrderById(db, orderId);
}

function createPayment(
  db,
  {
    orderId,
    telegramId,
    amount,
    provider = 'click',
    clickTransId = null,
    externalTransactionId = null,
  }
) {
  const extId = externalTransactionId ?? clickTransId;
  const result = db
    .prepare(
      `INSERT INTO payments (
        order_id, telegram_id, amount, provider, click_trans_id,
        external_transaction_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(orderId, telegramId, amount, provider, clickTransId, extId);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(result.lastInsertRowid) ?? null;
}

function getPaymeTransaction(db, paymeId) {
  return db.prepare('SELECT * FROM payme_transactions WHERE payme_id = ?').get(paymeId) ?? null;
}

function getActivePaymeTransactionForOrder(db, orderId) {
  return (
    db
      .prepare(
        `SELECT * FROM payme_transactions
         WHERE order_id = ? AND state = 1
         ORDER BY create_time DESC
         LIMIT 1`
      )
      .get(orderId) ?? null
  );
}

function insertPaymeTransaction(
  db,
  { paymeId, orderId, amount, state, createTime, performTime = null, cancelTime = null, cancelReason = null }
) {
  db.prepare(
    `INSERT INTO payme_transactions (
      payme_id, order_id, amount, state, create_time,
      perform_time, cancel_time, cancel_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(paymeId, orderId, amount, state, createTime, performTime, cancelTime, cancelReason);
  return getPaymeTransaction(db, paymeId);
}

function updatePaymeTransaction(db, paymeId, { state, performTime, cancelTime, cancelReason } = {}) {
  const fields = [];
  const values = [];
  if (state !== undefined) {
    fields.push('state = ?');
    values.push(state);
  }
  if (performTime !== undefined) {
    fields.push('perform_time = ?');
    values.push(performTime);
  }
  if (cancelTime !== undefined) {
    fields.push('cancel_time = ?');
    values.push(cancelTime);
  }
  if (cancelReason !== undefined) {
    fields.push('cancel_reason = ?');
    values.push(cancelReason);
  }
  if (fields.length === 0) {
    return getPaymeTransaction(db, paymeId);
  }
  values.push(paymeId);
  db.prepare(`UPDATE payme_transactions SET ${fields.join(', ')} WHERE payme_id = ?`).run(...values);
  return getPaymeTransaction(db, paymeId);
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function phonesMatch(storedPhone, queryPhone) {
  const stored = normalizePhone(storedPhone);
  const query = normalizePhone(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

function getUnpaidOrdersByClientPhone(db, clientPhone) {
  if (!clientPhone) return [];
  const orders = db
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY datetime(created_at) DESC")
    .all();
  return orders.filter((row) => phonesMatch(row.client_phone, clientPhone));
}

function getUnpaidOrdersByUserPhone(db, userPhone) {
  if (!userPhone) return [];
  const orders = db
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY datetime(created_at) DESC")
    .all();
  return orders.filter(
    (row) => phonesMatch(row.client_phone, userPhone) || phonesMatch(row.additional_phone, userPhone)
  );
}

function getLatestUnpaidOrderByClientPhone(db, clientPhone) {
  return getUnpaidOrdersByClientPhone(db, clientPhone)[0] ?? null;
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  partnerFromApiRow,
  partnerFromTableRow,
  partnerAccountFromApiRow,
  partnerAccountFromTableRow,
  upsertPartners,
  upsertPartnerAccounts,
  licenseFromApiRow,
  licenseFromTableRow,
  upsertLicenses,
  startFetchRun,
  finishFetchRun,
  countPartners,
  countPartnerAccounts,
  countLicenses,
  upsertRposClients,
  upsertRposAccounts,
  countRposClients,
  countRposAccounts,
  getBotUser,
  getBotUserByTelegramId,
  getBotUserById,
  getEmployeeByPhone,
  findUserByPhone,
  getBotUsersByPhone,
  linkEmployeeTelegram,
  registerCustomer,
  createEmployeeUser,
  updateEmployeeUser,
  deleteEmployeeUser,
  listEmployeeUsers,
  getEmployeeWithRights,
  getUserRights,
  upsertUserRights,
  countBotUsers,
  isLinkedEmployee,
  getAllUnpaidOrders,
  deletePendingOrder,
  getEarningsRows,
  createOrder,
  getOrderById,
  setOrderPaymeReceiptId,
  markOrderPaid,
  createPayment,
  getPaymeTransaction,
  getActivePaymeTransactionForOrder,
  insertPaymeTransaction,
  updatePaymeTransaction,
  getUnpaidOrdersByClientPhone,
  getUnpaidOrdersByUserPhone,
  getLatestUnpaidOrderByClientPhone,
};
