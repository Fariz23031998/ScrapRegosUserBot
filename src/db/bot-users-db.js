const fs = require('fs');
const crypto = require('crypto');
const { usersPhonesPath } = require('../paths');
const { logOrderEvent } = require('./order-logs');

const ADMIN_PASSWORD_HASH_PREFIX = 'scrypt';
const ADMIN_PASSWORD_KEYLEN = 64;

const DEFAULT_ALLOWLIST_PATH = usersPhonesPath();

const DEFAULT_RIGHTS = {
  see_own_unpaid_orders: 0,
  see_own_report: 1,
  see_all_report: 0,
  delete_unpaid_order: 0,
  delete_cash_order: 0,
  manage_vip: 0,
  see_all_unpaid_orders: 0,
  mark_paid_cash: 0,
  open_admin_dashboard: 0,
  create_technical_support: 0,
  renotify_order: 0,
  users_read: 0,
  users_create: 0,
  users_edit: 0,
  users_delete: 0,
  order_logs_read: 0,
  logs_read: 0,
  orders_read: 0,
  orders_manage: 0,
  tickets_read: 0,
  tickets_create: 0,
  tickets_edit: 0,
  tickets_edit_closed: 0,
  tickets_ai_prompt: 0,
  clients_edit: 0,
  clients_link_firm: 0,
  technical_support_read: 0,
  technical_support_create: 0,
  technical_support_edit: 0,
  technical_support_delete: 0,
  prices_read: 0,
  prices_create: 0,
  prices_edit: 0,
  prices_delete: 0,
  settings_read: 0,
  settings_edit: 0,
  knowledge_read: 0,
  knowledge_edit: 0,
  knowledge_lock: 0,
  knowledge_unlock: 0,
  ai_customer_test: 0,
  ai_customer_test_history: 0,
  prompt_variables_create: 0,
  tasks_read: 0,
  tasks_create: 0,
  tasks_edit: 0,
  tasks_delete: 0,
  devices_read: 0,
  devices_create: 0,
  devices_edit: 0,
  devices_delete: 0,
  services_read: 0,
  services_create: 0,
  services_edit: 0,
  services_delete: 0,
};

const RIGHTS_COLUMNS = Object.keys(DEFAULT_RIGHTS);

const ADMIN_RIGHTS_COLUMNS = [
  'users_read',
  'users_create',
  'users_edit',
  'users_delete',
  'order_logs_read',
  'logs_read',
  'orders_read',
  'orders_manage',
  'tickets_read',
  'tickets_create',
  'tickets_edit',
  'tickets_edit_closed',
  'tickets_ai_prompt',
  'clients_edit',
  'clients_link_firm',
  'technical_support_read',
  'technical_support_create',
  'technical_support_edit',
  'technical_support_delete',
  'prices_read',
  'prices_create',
  'prices_edit',
  'prices_delete',
  'settings_read',
  'settings_edit',
  'knowledge_read',
  'knowledge_edit',
  'knowledge_lock',
  'knowledge_unlock',
  'ai_customer_test',
  'ai_customer_test_history',
  'prompt_variables_create',
  'tasks_read',
  'tasks_create',
  'tasks_edit',
  'tasks_delete',
  'devices_read',
  'devices_create',
  'devices_edit',
  'devices_delete',
  'services_read',
  'services_create',
  'services_edit',
  'services_delete',
];

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
      delete_cash_order INTEGER NOT NULL DEFAULT 0,
      manage_vip INTEGER NOT NULL DEFAULT 0,
      see_all_unpaid_orders INTEGER NOT NULL DEFAULT 0,
      mark_paid_cash INTEGER NOT NULL DEFAULT 0,
      open_admin_dashboard INTEGER NOT NULL DEFAULT 0,
      create_technical_support INTEGER NOT NULL DEFAULT 0,
      renotify_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const legacyColumns = [
    'mark_paid_cash',
    'open_admin_dashboard',
    'create_technical_support',
    'renotify_order',
    'delete_cash_order',
    'view_tickets',
  ];
  for (const column of legacyColumns) {
    if (!columnExists(db, 'user_rights', column)) {
      db.exec(`ALTER TABLE user_rights ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  for (const column of ADMIN_RIGHTS_COLUMNS) {
    if (!columnExists(db, 'user_rights', column)) {
      db.exec(`ALTER TABLE user_rights ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  // Replace the legacy all-or-nothing admin order grant with revocable action rights.
  db.exec(`
    UPDATE user_rights
    SET delete_unpaid_order = 1,
        mark_paid_cash = 1,
        renotify_order = 1,
        orders_manage = 0
    WHERE IFNULL(orders_manage, 0) = 1
  `);

  // One-time copy: view_tickets → tickets_read (orphan view_tickets column kept).
  if (
    columnExists(db, 'user_rights', 'view_tickets') &&
    columnExists(db, 'user_rights', 'tickets_read')
  ) {
    db.exec(`
      UPDATE user_rights
      SET tickets_read = 1
      WHERE IFNULL(view_tickets, 0) = 1 AND IFNULL(tickets_read, 0) = 0
    `);
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureAdminCredentialColumns(db) {
  if (!tableExists(db, 'bot_users')) return;
  if (!columnExists(db, 'bot_users', 'admin_login')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN admin_login TEXT');
  }
  if (!columnExists(db, 'bot_users', 'password_hash')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN password_hash TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_users_admin_login
    ON bot_users(admin_login)
    WHERE admin_login IS NOT NULL
  `);
}

function ensureRegosLinkColumns(db) {
  if (!tableExists(db, 'bot_users')) return;
  if (!columnExists(db, 'bot_users', 'regos_user_id')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN regos_user_id INTEGER');
  }
  if (!columnExists(db, 'bot_users', 'regos_login')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN regos_login TEXT');
  }
  if (!columnExists(db, 'bot_users', 'regos_full_name')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN regos_full_name TEXT');
  }
  if (!columnExists(db, 'bot_users', 'regos_client_id')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN regos_client_id INTEGER');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_users_regos_user_id
    ON bot_users(regos_user_id)
    WHERE regos_user_id IS NOT NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bot_users_regos_client_id
    ON bot_users(regos_client_id)
    WHERE regos_client_id IS NOT NULL
  `);
}

function ensureEmployeeProfileColumns(db) {
  if (!tableExists(db, 'bot_users')) return;
  if (!columnExists(db, 'bot_users', 'job_title')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN job_title TEXT');
  }
  if (!columnExists(db, 'bot_users', 'description')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN description TEXT');
  }
}

function finishBotUsersMigration(db) {
  if (tableExists(db, 'bot_users_new') && !tableExists(db, 'bot_users')) {
    db.exec('ALTER TABLE bot_users_new RENAME TO bot_users');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_phone ON bot_users(phone)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_users_telegram_id ON bot_users(telegram_id)');
  ensureAdminCredentialColumns(db);
  ensureRegosLinkColumns(db);
  ensureEmployeeProfileColumns(db);
  ensureUserRightsTable(db);
  seedMissingEmployeeRights(db);
}

function normalizeAdminLogin(login) {
  const value = String(login || '').trim();
  return value || null;
}

function hashAdminPassword(password) {
  const plain = String(password || '');
  if (!plain) {
    throw new Error('PASSWORD_REQUIRED');
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, ADMIN_PASSWORD_KEYLEN);
  return `${ADMIN_PASSWORD_HASH_PREFIX}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyAdminPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== ADMIN_PASSWORD_HASH_PREFIX) return false;
  const [, saltB64, hashB64] = parts;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, expected.length);
  if (actual.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function findEmployeeByAdminLogin(db, login) {
  const normalized = normalizeAdminLogin(login);
  if (!normalized) return null;
  return (
    db
      .prepare("SELECT * FROM bot_users WHERE role = 'employee' AND lower(admin_login) = lower(?)")
      .get(normalized) ?? null
  );
}

function assertAdminLoginAvailable(db, login, excludeUserId = null) {
  const normalized = normalizeAdminLogin(login);
  if (!normalized) return null;
  const existing = findEmployeeByAdminLogin(db, normalized);
  if (existing && existing.id !== excludeUserId) {
    throw new Error('LOGIN_EXISTS');
  }
  return normalized;
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
    ensureAdminCredentialColumns(db);
    ensureRegosLinkColumns(db);
    ensureEmployeeProfileColumns(db);
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
        admin_login TEXT,
        password_hash TEXT,
        regos_user_id INTEGER,
        regos_login TEXT,
        regos_full_name TEXT,
        regos_client_id INTEGER,
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
  ensureAdminCredentialColumns(db);
  ensureRegosLinkColumns(db);
  ensureEmployeeProfileColumns(db);
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
  const cols = RIGHTS_COLUMNS;
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.map((column) => `${column} = excluded.${column}`).join(',\n      ');
  db.prepare(
    `INSERT INTO user_rights (
      user_id, ${cols.join(', ')}, updated_at
    ) VALUES (?, ${placeholders}, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      ${updates},
      updated_at = datetime('now')`
  ).run(userId, ...cols.map((column) => (merged[column] ? 1 : 0)));
}

function getUserRights(db, userId) {
  const row = db.prepare('SELECT * FROM user_rights WHERE user_id = ?').get(userId);
  const mapped = mapRightsRow(row);
  // Fallback if migration copy has not run yet on a stale row shape.
  if (!mapped.tickets_read && row && Number(row.view_tickets)) {
    mapped.tickets_read = 1;
  }
  return mapped;
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

function applyEmployeeAdminCredentials(db, userId, { adminLogin, password } = {}, { requirePair = false } = {}) {
  const loginProvided = adminLogin !== undefined;
  const passwordProvided = password !== undefined && String(password) !== '';

  if (!loginProvided && !passwordProvided) {
    return;
  }

  const current = getBotUserById(db, userId);
  if (!current || current.role !== 'employee') {
    throw new Error('NOT_FOUND');
  }

  let nextLogin = current.admin_login || null;
  if (loginProvided) {
    nextLogin = assertAdminLoginAvailable(db, adminLogin, userId);
  }

  if (requirePair && nextLogin && !passwordProvided && !current.password_hash) {
    throw new Error('PASSWORD_REQUIRED');
  }
  if (requirePair && passwordProvided && !nextLogin) {
    throw new Error('LOGIN_REQUIRED');
  }
  if (passwordProvided && !nextLogin) {
    throw new Error('LOGIN_REQUIRED');
  }
  if (nextLogin && !passwordProvided && !current.password_hash) {
    throw new Error('PASSWORD_REQUIRED');
  }

  let nextHash = current.password_hash || null;
  if (!nextLogin) {
    nextHash = null;
  } else if (passwordProvided) {
    nextHash = hashAdminPassword(password);
  }

  db.prepare('UPDATE bot_users SET admin_login = ?, password_hash = ? WHERE id = ?').run(
    nextLogin,
    nextHash,
    userId
  );
}

function createEmployeeUser(db, { phone, displayName, jobTitle, description, rights = {}, adminLogin, password } = {}) {
  ensureEmployeeProfileColumns(db);
  const normalized = normalizeStoredPhone(phone);
  const existing = findUserByPhone(db, normalized);
  if (existing) {
    throw new Error('PHONE_EXISTS');
  }

  const login = assertAdminLoginAvailable(db, adminLogin);
  if (login && (password === undefined || String(password) === '')) {
    throw new Error('PASSWORD_REQUIRED');
  }
  if (!login && password !== undefined && String(password) !== '') {
    throw new Error('LOGIN_REQUIRED');
  }

  const result = db
    .prepare(
      `INSERT INTO bot_users (phone, role, display_name, job_title, description, admin_login, password_hash)
       VALUES (?, 'employee', ?, ?, ?, ?, ?)`
    )
    .run(
      normalized,
      displayName?.trim() || null,
      jobTitle?.trim() || null,
      description?.trim() || null,
      login,
      login ? hashAdminPassword(password) : null
    );
  const userId = Number(result.lastInsertRowid);
  upsertUserRights(db, userId, { ...DEFAULT_RIGHTS, ...rights });
  return getEmployeeWithRights(db, userId);
}

function updateEmployeeUser(db, userId, { phone, displayName, jobTitle, description, rights, adminLogin, password } = {}) {
  ensureEmployeeProfileColumns(db);
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

  if (jobTitle !== undefined) {
    db.prepare('UPDATE bot_users SET job_title = ? WHERE id = ?').run(jobTitle?.trim() || null, userId);
  }

  if (description !== undefined) {
    db.prepare('UPDATE bot_users SET description = ? WHERE id = ?').run(description?.trim() || null, userId);
  }

  applyEmployeeAdminCredentials(db, userId, { adminLogin, password });

  if (rights) {
    upsertUserRights(db, userId, rights);
  }

  return getEmployeeWithRights(db, userId);
}

function convertCustomerToEmployee(db, userId, { displayName, jobTitle, description, rights = {}, adminLogin, password } = {}) {
  ensureEmployeeProfileColumns(db);
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

  db.prepare(
    "UPDATE bot_users SET role = 'employee', display_name = ?, job_title = ?, description = ? WHERE id = ?"
  ).run(name, jobTitle?.trim() || null, description?.trim() || null, userId);
  applyEmployeeAdminCredentials(db, userId, { adminLogin, password }, { requirePair: true });
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

function findBotUserByRegosUserId(db, regosUserId) {
  const id = Number(regosUserId);
  if (!Number.isFinite(id)) return null;
  return db.prepare('SELECT * FROM bot_users WHERE regos_user_id = ?').get(id) ?? null;
}

function clearBotUserRegosLink(db, userId) {
  const user = getBotUserById(db, userId);
  if (!user) {
    throw new Error('NOT_FOUND');
  }
  db.prepare(
    `UPDATE bot_users
     SET regos_user_id = NULL, regos_login = NULL, regos_full_name = NULL
     WHERE id = ?`
  ).run(userId);
  return getEmployeeWithRights(db, userId) || getBotUserById(db, userId);
}

function setBotUserRegosLink(db, userId, { regosUserId, regosLogin = null, regosFullName = null } = {}) {
  const user = getBotUserById(db, userId);
  if (!user) {
    throw new Error('NOT_FOUND');
  }

  const id = Number(regosUserId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('INVALID_REGOS_USER');
  }

  const conflict = findBotUserByRegosUserId(db, id);
  if (conflict && conflict.id !== userId) {
    throw new Error('REGOS_USER_LINKED');
  }

  db.prepare(
    `UPDATE bot_users
     SET regos_user_id = ?,
         regos_login = ?,
         regos_full_name = ?
     WHERE id = ?`
  ).run(id, regosLogin?.trim() || null, regosFullName?.trim() || null, userId);

  return getEmployeeWithRights(db, userId) || getBotUserById(db, userId);
}

function setBotUserRegosClientId(db, userId, regosClientId) {
  ensureRegosLinkColumns(db);
  const user = getBotUserById(db, userId);
  if (!user) {
    throw new Error('NOT_FOUND');
  }
  if (regosClientId == null || regosClientId === '') {
    db.prepare('UPDATE bot_users SET regos_client_id = NULL WHERE id = ?').run(userId);
    return getBotUserById(db, userId);
  }
  const id = Number(regosClientId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('INVALID_REGOS_CLIENT');
  }
  db.prepare('UPDATE bot_users SET regos_client_id = ? WHERE id = ?').run(id, userId);
  return getBotUserById(db, userId);
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
    user.job_title,
    user.description,
    user.first_name,
    user.last_name,
    user.username,
    user.admin_login,
    user.regos_login,
    user.regos_full_name,
    user.regos_user_id != null ? String(user.regos_user_id) : '',
    user.telegram_id != null ? String(user.telegram_id) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes(lower);
}

function listBotUsers(db, { role, query, offset = 0, limit } = {}) {
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

  const total = users.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = limit == null ? total : Math.min(Math.max(Number(limit) || 25, 1), 100);
  const pageUsers = users.slice(safeOffset, safeOffset + safeLimit);

  return {
    users: pageUsers.map((user) => ({
      ...user,
      rights: user.role === 'employee' ? getUserRights(db, user.id) : null,
      is_linked: user.telegram_id != null,
    })),
    total,
  };
}

function listEmployeeUsers(db) {
  return listBotUsers(db, { role: 'employee' }).users;
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
    additionalPhone: order.additional_phone,
  });
  return true;
}

function deletePaidCashOrder(db, orderId, actorTelegramId = null) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'paid_cash') {
    return false;
  }

  const result = db
    .prepare("UPDATE orders SET status = 'deleted' WHERE id = ? AND status = 'paid_cash'")
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
    additionalPhone: order.additional_phone,
  });
  return true;
}

function markPendingOrderPaidCash(db, orderId, actorTelegramId = null) {
  const { activateTechnicalSupportFromOrder } = require('./technical-support');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'pending') {
    return false;
  }

  const paymentTelegramId = actorTelegramId ?? order.telegram_id;
  if (paymentTelegramId == null) {
    return false;
  }

  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE orders
         SET status = 'paid_cash',
             payment_provider = 'cash',
             paid_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(orderId);
    if (result.changes <= 0) {
      db.exec('COMMIT');
      return false;
    }

    db.prepare(
      `INSERT INTO payments (
        order_id, telegram_id, amount, provider, click_trans_id,
        external_transaction_id, created_at
      ) VALUES (?, ?, ?, 'cash', NULL, NULL, datetime('now'))`
    ).run(orderId, paymentTelegramId, order.amount);

    const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    activateTechnicalSupportFromOrder(db, paidOrder, { paidAt: paidOrder?.paid_at });

    logOrderEvent(db, {
      orderId,
      action: 'paid_cash',
      actorTelegramId,
      orderAmount: order.amount,
      clientPhone: order.client_phone,
      additionalPhone: order.additional_phone,
      paymentProvider: 'cash',
    });

    db.exec('COMMIT');
    return true;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  }
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
  findEmployeeByAdminLogin,
  verifyAdminPassword,
  hashAdminPassword,
  findBotUserByRegosUserId,
  setBotUserRegosLink,
  clearBotUserRegosLink,
  setBotUserRegosClientId,
  normalizePhoneKey,
  phonesMatch,
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
  deletePaidCashOrder,
  markPendingOrderPaidCash,
  getEarningsRows,
};
