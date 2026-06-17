const fs = require('fs');
const path = require('path');
const { logOrderEvent } = require('./order-logs');

const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, '..', 'users_phones.txt');

const DEFAULT_RIGHTS = {
  see_own_unpaid_orders: 0,
  see_own_report: 1,
  see_all_report: 0,
  delete_unpaid_order: 0,
  manage_vip: 0,
  see_all_unpaid_orders: 0,
};

const RIGHTS_COLUMNS = Object.keys(DEFAULT_RIGHTS);

function normalizePhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phonesMatch(storedPhone, queryPhone) {
  const stored = normalizePhoneKey(storedPhone);
  const query = normalizePhoneKey(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function loadLegacyEmployeePhones() {
  if (!fs.existsSync(DEFAULT_ALLOWLIST_PATH)) return [];
  const content = fs.readFileSync(DEFAULT_ALLOWLIST_PATH, 'utf8');
  return content
    .split(',')
    .map((phone) => phone.trim())
    .filter(Boolean);
}

function isLegacyEmployeePhone(phone, legacyPhones) {
  return legacyPhones.some((allowed) => phonesMatch(allowed, phone));
}

function ensureUserRightsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_rights (
      user_id INTEGER PRIMARY KEY REFERENCES bot_users(id) ON DELETE CASCADE,
      see_own_unpaid_orders INTEGER NOT NULL DEFAULT 0,
      see_own_report INTEGER NOT NULL DEFAULT 1,
      see_all_report INTEGER NOT NULL DEFAULT 0,
      delete_unpaid_order INTEGER NOT NULL DEFAULT 0,
      manage_vip INTEGER NOT NULL DEFAULT 0,
      see_all_unpaid_orders INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function finishBotUsersMigration(db) {
  if (tableExists(db, 'bot_users_new') && !tableExists(db, 'bot_users')) {
    db.exec('ALTER TABLE bot_users_new RENAME TO bot_users');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_phone ON bot_users(phone)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_telegram_id ON bot_users(telegram_id)');
  ensureUserRightsTable(db);
  seedMissingEmployeeRights(db);
}

function seedMissingEmployeeRights(db) {
  const vipManagerPhone = process.env.VIP_MANAGER_PHONE?.trim() || null;
  const employees = db.prepare("SELECT id, phone FROM bot_users WHERE role = 'employee'").all();
  for (const employee of employees) {
    const existing = db.prepare('SELECT user_id FROM user_rights WHERE user_id = ?').get(employee.id);
    if (existing) continue;
    seedRightsForUser(db, employee.id, {
      manageVip: vipManagerPhone && phonesMatch(vipManagerPhone, employee.phone),
    });
  }
}

function migrateBotUsersSchema(db) {
  if (columnExists(db, 'bot_users', 'id')) {
    ensureUserRightsTable(db);
    if (tableExists(db, 'bot_users_new')) {
      db.exec('DROP TABLE bot_users_new');
    }
    return;
  }

  if (!tableExists(db, 'bot_users') && tableExists(db, 'bot_users_new')) {
    finishBotUsersMigration(db);
    return;
  }

  if (!tableExists(db, 'bot_users')) {
    db.exec(`
      CREATE TABLE bot_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL UNIQUE,
        telegram_id INTEGER UNIQUE,
        role TEXT NOT NULL DEFAULT 'customer',
        display_name TEXT,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        linked_at TEXT
      );
    `);
    finishBotUsersMigration(db);
    return;
  }

  if (tableExists(db, 'bot_users_new')) {
    db.exec('DROP TABLE bot_users_new');
  }

  const legacyPhones = loadLegacyEmployeePhones();
  const vipManagerPhone = process.env.VIP_MANAGER_PHONE?.trim() || null;
  const pendingRights = [];

  db.exec(`
    CREATE TABLE bot_users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      telegram_id INTEGER UNIQUE,
      role TEXT NOT NULL DEFAULT 'customer',
      display_name TEXT,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      linked_at TEXT
    );
  `);

  const oldUsers = db.prepare('SELECT * FROM bot_users').all();
  const insertStmt = db.prepare(`
    INSERT INTO bot_users_new (
      phone, telegram_id, role, username, first_name, last_name, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const seenPhones = new Set();
  for (const row of oldUsers) {
    const key = normalizePhoneKey(row.phone);
    if (seenPhones.has(key)) continue;

    const role = isLegacyEmployeePhone(row.phone, legacyPhones) ? 'employee' : 'customer';
    insertStmt.run(
      row.phone,
      row.telegram_id,
      role,
      row.username,
      row.first_name,
      row.last_name,
      row.telegram_id ? row.registered_at || null : null
    );
    seenPhones.add(key);
    if (role === 'employee') {
      pendingRights.push({
        phone: row.phone,
        manageVip: vipManagerPhone && phonesMatch(vipManagerPhone, row.phone),
      });
    }
  }

  for (const phone of legacyPhones) {
    const key = normalizePhoneKey(phone);
    if (seenPhones.has(key)) continue;
    const alreadyStored = [...seenPhones].some((storedKey) => phonesMatch(storedKey, phone));
    if (alreadyStored) continue;

    insertStmt.run(phone, null, 'employee', null, null, null, null);
    pendingRights.push({
      phone,
      manageVip: vipManagerPhone && phonesMatch(vipManagerPhone, phone),
    });
    seenPhones.add(key);
  }

  db.exec('DROP TABLE bot_users');
  db.exec('ALTER TABLE bot_users_new RENAME TO bot_users');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_phone ON bot_users(phone)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_telegram_id ON bot_users(telegram_id)');
  ensureUserRightsTable(db);

  const employees = db.prepare("SELECT id, phone FROM bot_users WHERE role = 'employee'").all();
  for (const item of pendingRights) {
    const match = employees.find((employee) => phonesMatch(employee.phone, item.phone));
    if (match) {
      seedRightsForUser(db, match.id, item);
    }
  }
}

function seedRightsForUser(db, userId, { manageVip = false } = {}) {
  if (!userId) return;
  const rights = { ...DEFAULT_RIGHTS, manage_vip: manageVip ? 1 : 0 };
  upsertUserRights(db, userId, rights);
}

function mapRightsRow(row) {
  if (!row) return { ...DEFAULT_RIGHTS };
  const mapped = {};
  for (const key of RIGHTS_COLUMNS) {
    mapped[key] = Number(row[key]) ? 1 : 0;
  }
  return mapped;
}

function upsertUserRights(db, userId, rights = {}) {
  const merged = { ...DEFAULT_RIGHTS, ...rights };
  db.prepare(
    `INSERT INTO user_rights (
      user_id, see_own_unpaid_orders, see_own_report, see_all_report,
      delete_unpaid_order, manage_vip, see_all_unpaid_orders, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      see_own_unpaid_orders = excluded.see_own_unpaid_orders,
      see_own_report = excluded.see_own_report,
      see_all_report = excluded.see_all_report,
      delete_unpaid_order = excluded.delete_unpaid_order,
      manage_vip = excluded.manage_vip,
      see_all_unpaid_orders = excluded.see_all_unpaid_orders,
      updated_at = datetime('now')`
  ).run(
    userId,
    merged.see_own_unpaid_orders ? 1 : 0,
    merged.see_own_report ? 1 : 0,
    merged.see_all_report ? 1 : 0,
    merged.delete_unpaid_order ? 1 : 0,
    merged.manage_vip ? 1 : 0,
    merged.see_all_unpaid_orders ? 1 : 0
  );
}

function getUserRights(db, userId) {
  const row = db.prepare('SELECT * FROM user_rights WHERE user_id = ?').get(userId);
  return mapRightsRow(row);
}

function getBotUserByTelegramId(db, telegramId) {
  if (!telegramId) return null;
  return db.prepare('SELECT * FROM bot_users WHERE telegram_id = ?').get(telegramId) ?? null;
}

function getBotUserById(db, userId) {
  return db.prepare('SELECT * FROM bot_users WHERE id = ?').get(userId) ?? null;
}

function getBotUser(db, telegramId) {
  return getBotUserByTelegramId(db, telegramId);
}

function findUserByPhone(db, phone) {
  if (!phone) return null;
  const users = db.prepare('SELECT * FROM bot_users').all();
  return users.find((u) => phonesMatch(u.phone, phone)) ?? null;
}

function getEmployeeByPhone(db, phone) {
  const user = findUserByPhone(db, phone);
  if (!user || user.role !== 'employee') return null;
  return user;
}

function getBotUsersByPhone(db, phone) {
  if (!phone) return [];
  const users = db.prepare('SELECT * FROM bot_users WHERE telegram_id IS NOT NULL').all();
  return users.filter((u) => phonesMatch(u.phone, phone));
}

function linkEmployeeTelegram(db, userId, telegramId, { username, firstName, lastName } = {}) {
  const existing = getBotUserByTelegramId(db, telegramId);
  if (existing && existing.id !== userId) {
    throw new Error('TELEGRAM_ALREADY_LINKED');
  }
  db.prepare(
    `UPDATE bot_users SET
      telegram_id = ?,
      username = ?,
      first_name = ?,
      last_name = ?,
      linked_at = datetime('now')
     WHERE id = ? AND role = 'employee'`
  ).run(telegramId, username ?? null, firstName ?? null, lastName ?? null, userId);
  return getBotUserById(db, userId);
}

function registerCustomer(db, { telegramId, phone, username, firstName, lastName }) {
  const employee = getEmployeeByPhone(db, phone);
  if (employee) {
    throw new Error('PHONE_IS_EMPLOYEE');
  }

  const existing = findUserByPhone(db, phone);
  if (existing) {
    if (existing.role === 'employee') {
      throw new Error('PHONE_IS_EMPLOYEE');
    }
    if (existing.telegram_id && existing.telegram_id !== telegramId) {
      throw new Error('PHONE_ALREADY_LINKED');
    }
    db.prepare(
      `UPDATE bot_users SET
        telegram_id = ?,
        username = ?,
        first_name = ?,
        last_name = ?,
        linked_at = datetime('now')
       WHERE id = ?`
    ).run(telegramId, username ?? null, firstName ?? null, lastName ?? null, existing.id);
    return getBotUserById(db, existing.id);
  }

  const result = db
    .prepare(
      `INSERT INTO bot_users (phone, telegram_id, role, username, first_name, last_name, linked_at)
       VALUES (?, ?, 'customer', ?, ?, ?, datetime('now'))`
    )
    .run(phone, telegramId, username ?? null, firstName ?? null, lastName ?? null);
  return getBotUserById(db, Number(result.lastInsertRowid));
}

function normalizeStoredPhone(phone) {
  return String(phone || '').trim();
}

function createEmployeeUser(db, { phone, displayName, rights = {} }) {
  const normalized = normalizeStoredPhone(phone);
  const existing = findUserByPhone(db, normalized);
  if (existing) {
    throw new Error('PHONE_EXISTS');
  }

  const result = db
    .prepare(
      `INSERT INTO bot_users (phone, role, display_name)
       VALUES (?, 'employee', ?)`
    )
    .run(normalized, displayName?.trim() || null);
  const userId = Number(result.lastInsertRowid);
  upsertUserRights(db, userId, { ...DEFAULT_RIGHTS, ...rights });
  return getEmployeeWithRights(db, userId);
}

function updateEmployeeUser(db, userId, { phone, displayName, rights }) {
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') {
    throw new Error('NOT_FOUND');
  }

  if (phone && !phonesMatch(phone, user.phone)) {
    const conflict = findUserByPhone(db, phone);
    if (conflict && conflict.id !== userId) {
      throw new Error('PHONE_EXISTS');
    }
    db.prepare('UPDATE bot_users SET phone = ? WHERE id = ?').run(normalizeStoredPhone(phone), userId);
  }

  if (displayName !== undefined) {
    db.prepare('UPDATE bot_users SET display_name = ? WHERE id = ?').run(displayName?.trim() || null, userId);
  }

  if (rights) {
    upsertUserRights(db, userId, rights);
  }

  return getEmployeeWithRights(db, userId);
}

function convertCustomerToEmployee(db, userId, { displayName, rights = {} } = {}) {
  const user = getBotUserById(db, userId);
  if (!user) {
    throw new Error('NOT_FOUND');
  }
  if (user.role !== 'customer') {
    throw new Error('NOT_CUSTOMER');
  }

  const name =
    displayName !== undefined
      ? displayName?.trim() || null
      : [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;

  db.prepare("UPDATE bot_users SET role = 'employee', display_name = ? WHERE id = ?").run(name, userId);
  upsertUserRights(db, userId, { ...DEFAULT_RIGHTS, ...rights });
  return getEmployeeWithRights(db, userId);
}

function deleteEmployeeUser(db, userId) {
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') {
    return false;
  }
  const orderCount = db
    .prepare('SELECT COUNT(*) AS count FROM orders WHERE telegram_id = ?')
    .get(user.telegram_id)?.count;
  if (orderCount > 0) {
    throw new Error('HAS_ORDERS');
  }
  db.prepare('DELETE FROM bot_users WHERE id = ?').run(userId);
  return true;
}

function getEmployeeWithRights(db, userId) {
  const user = getBotUserById(db, userId);
  if (!user) return null;
  return {
    ...user,
    rights: getUserRights(db, userId),
    is_linked: user.telegram_id != null,
  };
}

function userMatchesQuery(user, query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const digits = lower.replace(/\D/g, '');
  if (digits && phonesMatch(user.phone, digits)) return true;

  const searchable = [
    user.phone,
    user.display_name,
    user.first_name,
    user.last_name,
    user.username,
    user.telegram_id != null ? String(user.telegram_id) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function listBotUsers(db, { role, query } = {}) {
  let sql = 'SELECT * FROM bot_users WHERE 1=1';
  const params = [];

  if (role === 'employee' || role === 'customer') {
    sql += ' AND role = ?';
    params.push(role);
  }

  sql += ' ORDER BY created_at DESC';

  let users = db.prepare(sql).all(...params);
  if (query) {
    users = users.filter((user) => userMatchesQuery(user, query));
  }

  return users.map((user) => ({
    ...user,
    rights: user.role === 'employee' ? getUserRights(db, user.id) : null,
    is_linked: user.telegram_id != null,
  }));
}

function listEmployeeUsers(db) {
  return listBotUsers(db, { role: 'employee' });
}

function countBotUsers(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM bot_users').get().count;
}

function isLinkedEmployee(user) {
  return !!user && user.role === 'employee' && user.telegram_id != null;
}

function getAllUnpaidOrders(db) {
  return db
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY datetime(created_at) DESC")
    .all();
}

function deletePendingOrder(db, orderId, actorTelegramId = null) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'pending') {
    return false;
  }

  const result = db
    .prepare("UPDATE orders SET status = 'deleted' WHERE id = ? AND status = 'pending'")
    .run(orderId);
  if (result.changes <= 0) {
    return false;
  }

  logOrderEvent(db, {
    orderId,
    action: 'deleted',
    actorTelegramId,
    orderAmount: order.amount,
    clientPhone: order.client_phone,
  });
  return true;
}

function getEarningsRows(db, { telegramId = null, from = null, to = null } = {}) {
  let sql = `
    SELECT
      p.created_at AS paid_at,
      p.order_id,
      p.amount,
      o.currency,
      p.provider,
      o.client_phone,
      COALESCE(bu.display_name, bu.first_name, bu.username, '') AS employee_name,
      bu.phone AS employee_phone,
      p.telegram_id
    FROM payments p
    INNER JOIN orders o ON o.id = p.order_id
    LEFT JOIN bot_users bu ON bu.telegram_id = p.telegram_id
    WHERE 1 = 1
  `;
  const params = [];

  if (telegramId != null) {
    sql += ' AND p.telegram_id = ?';
    params.push(telegramId);
  }
  if (from) {
    sql += ' AND date(p.created_at) >= date(?)';
    params.push(from);
  }
  if (to) {
    sql += ' AND date(p.created_at) <= date(?)';
    params.push(to);
  }

  sql += ' ORDER BY datetime(p.created_at) DESC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  DEFAULT_RIGHTS,
  RIGHTS_COLUMNS,
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
  convertCustomerToEmployee,
  deleteEmployeeUser,
  listBotUsers,
  listEmployeeUsers,
  getEmployeeWithRights,
  getUserRights,
  upsertUserRights,
  countBotUsers,
  isLinkedEmployee,
  getAllUnpaidOrders,
  deletePendingOrder,
  getEarningsRows,
};
