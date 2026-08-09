const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { dbPath } = require('../paths');
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
  markPendingOrderPaidCash,
  getEarningsRows,
} = require('./bot-users-db');

const DEFAULT_DB_PATH = dbPath();

function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  return db;
}

const SCRAPED_TABLES = [
  'partners',
  'partner_accounts',
  'licenses',
  'rpos_clients',
  'rpos_accounts',
  'vcr1_partners',
  'vcr1_licenses',
  'fetch_runs',
];

function dropScrapedTables(db) {
  for (const table of SCRAPED_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

function initSchema(db) {
  dropScrapedTables(db);
  db.exec(`
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
  dropScrapedTables(db);
  if (!columnExists(db, 'payments', 'external_transaction_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN external_transaction_id TEXT');
  }
  if (!columnExists(db, 'orders', 'payme_receipt_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN payme_receipt_id TEXT');
  }
  if (!columnExists(db, 'orders', 'payme_receipt_created_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN payme_receipt_created_at INTEGER');
  }
  if (!columnExists(db, 'orders', 'ticket_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN ticket_id INTEGER');
  }
  migrateBotUsersSchema(db);
  const { ensureOrderLogsTable } = require('./order-logs');
  ensureOrderLogsTable(db);
  const { ensureDashboardLoginTokensTable } = require('../admin/dashboard-login-tokens');
  ensureDashboardLoginTokensTable(db);
  const { ensureTechnicalSupportTables } = require('./technical-support');
  ensureTechnicalSupportTables(db);
  const { ensureServicePricesTables } = require('./service-prices');
  ensureServicePricesTables(db);
  const { ensureRegosChannelSettingsTable } = require('./regos-channel-settings');
  ensureRegosChannelSettingsTable(db);
  const { ensureTicketRecordingsTable } = require('./ticket-recordings');
  ensureTicketRecordingsTable(db);
}

const {
  partnerFromApiRow,
  partnerAccountFromApiRow,
  licenseFromApiRow,
  vcr1PartnerFromApiRow,
  vcr1LicenseFromApiRow,
  partnerFromTableRow,
  partnerAccountFromTableRow,
  licenseFromTableRow,
  rposClientFromRow,
  rposAccountFromRow,
} = require('../live/mappers');


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
    ticketId = null,
  }
) {
  const normalizedTicketId =
    ticketId == null || ticketId === '' ? null : Number(ticketId);
  db.prepare(
    `INSERT INTO orders (
      id, telegram_id, bot_user_phone, client_phone, client_type, additional_phone,
      amount, currency, status, payment_provider, metadata, ticket_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
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
    metadata,
    Number.isFinite(normalizedTicketId) ? normalizedTicketId : null
  );
  const order = getOrderById(db, id);
  logOrderEvent(db, {
    orderId: id,
    action: 'created',
    actorTelegramId: telegramId,
    actorPhone: botUserPhone ?? null,
    orderAmount: amount,
    clientPhone,
    additionalPhone,
  });
  return order;
}

function getOrderById(db, orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) ?? null;
}

const ORDER_LIST_STATUSES = new Set(['pending', 'paid', 'paid_cash', 'deleted']);

function orderMatchesQuery(order, query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');
  const phones = [order.client_phone, order.additional_phone, order.bot_user_phone].filter(
    Boolean
  );

  if (digits && phones.some((phone) => String(phone).replace(/\D/g, '').includes(digits))) {
    return true;
  }

  const searchable = [
    order.id,
    order.client_phone,
    order.additional_phone,
    order.bot_user_phone,
    order.status,
    order.payment_provider,
    order.ticket_id != null ? String(order.ticket_id) : '',
    order.amount != null ? String(order.amount) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function parseClientPhoneFilter(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function orderMatchesClientPhone(order, clientPhone) {
  const phones = parseClientPhoneFilter(clientPhone);
  if (!phones.length) return true;
  return phones.some(
    (phone) =>
      phonesMatch(order.client_phone, phone) || phonesMatch(order.additional_phone, phone)
  );
}

function listOrders(db, { query, clientPhone, status, from, to, offset = 0, limit = 25 } = {}) {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];

  if (status && ORDER_LIST_STATUSES.has(status)) {
    sql += ' AND status = ?';
    params.push(status);
  }

  const fromDate = String(from || '').trim();
  if (fromDate) {
    sql += ' AND date(created_at) >= date(?)';
    params.push(fromDate);
  }

  const toDate = String(to || '').trim();
  if (toDate) {
    sql += ' AND date(created_at) <= date(?)';
    params.push(toDate);
  }

  sql += ' ORDER BY datetime(created_at) DESC';

  let rows = db.prepare(sql).all(...params);
  if (clientPhone) {
    rows = rows.filter((row) => orderMatchesClientPhone(row, clientPhone));
  }
  if (query) {
    rows = rows.filter((row) => orderMatchesQuery(row, query));
  }

  const total = rows.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return {
    orders: rows.slice(safeOffset, safeOffset + safeLimit),
    total,
  };
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
  const { activateTechnicalSupportFromOrder } = require('./technical-support');
  const transId = transactionId ?? clickTransId;

  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE orders
         SET status = 'paid',
             payment_transaction_id = ?,
             payment_provider = COALESCE(?, payment_provider),
             paid_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(transId, provider, orderId);

    const order = getOrderById(db, orderId);
    if (result.changes > 0 && order) {
      activateTechnicalSupportFromOrder(db, order, { paidAt: order.paid_at });
      logOrderEvent(db, {
        orderId,
        action: 'paid',
        actorTelegramId: order.telegram_id,
        orderAmount: order.amount,
        clientPhone: order.client_phone,
        additionalPhone: order.additional_phone,
        paymentProvider: order.payment_provider || provider || null,
      });
    }

    db.exec('COMMIT');
    return {
      claimed: result.changes > 0,
      order,
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }
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

function getUnpaidOrdersByCreatorTelegramId(db, telegramId) {
  if (telegramId == null) return [];
  return db
    .prepare(
      "SELECT * FROM orders WHERE telegram_id = ? AND status = 'pending' ORDER BY datetime(created_at) DESC"
    )
    .all(telegramId);
}

function getLatestUnpaidOrderByClientPhone(db, clientPhone) {
  return getUnpaidOrdersByClientPhone(db, clientPhone)[0] ?? null;
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  partnerFromApiRow,
  partnerAccountFromApiRow,
  licenseFromApiRow,
  vcr1PartnerFromApiRow,
  vcr1LicenseFromApiRow,
  partnerFromTableRow,
  partnerAccountFromTableRow,
  licenseFromTableRow,
  rposClientFromRow,
  rposAccountFromRow,
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
  markPendingOrderPaidCash,
  getEarningsRows,
  createOrder,
  getOrderById,
  listOrders,
  setOrderPaymeReceiptId,
  markOrderPaid,
  createPayment,
  getPaymeTransaction,
  getActivePaymeTransactionForOrder,
  insertPaymeTransaction,
  updatePaymeTransaction,
  getUnpaidOrdersByClientPhone,
  getUnpaidOrdersByUserPhone,
  getUnpaidOrdersByCreatorTelegramId,
  getLatestUnpaidOrderByClientPhone,
};
