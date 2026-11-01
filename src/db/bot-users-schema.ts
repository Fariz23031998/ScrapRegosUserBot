import type { Db } from '../types/db';
import fs from 'fs';
import { usersPhonesPath } from '../paths';
import { parseSchedule } from '../lib/employee-schedule';
import { ADMIN_RIGHTS_COLUMNS, seedRightsForUser } from './bot-users-rights';

const DEFAULT_ALLOWLIST_PATH = usersPhonesPath();

function normalizePhoneKey(phone?: any) {
  return String(phone || '').replace(/\D/g, '');
}

function phonesMatch(storedPhone?: any, queryPhone?: any) {
  const stored = normalizePhoneKey(storedPhone);
  const query = normalizePhoneKey(queryPhone);
  if (!stored || !query) return false;
  if (stored === query) return true;
  if (stored.endsWith(query) || query.endsWith(stored)) return true;
  const storedTail = stored.slice(-9);
  const queryTail = query.slice(-9);
  return storedTail.length >= 9 && storedTail === queryTail;
}

function columnExists(db: Db, table?: any, column?: any) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c?: any) => c.name === column);
}

function loadLegacyEmployeePhones() {
  if (!fs.existsSync(DEFAULT_ALLOWLIST_PATH)) return [];
  const content = fs.readFileSync(DEFAULT_ALLOWLIST_PATH, 'utf8');
  return content
    .split(',')
    .map((phone?: any) => phone.trim())
    .filter(Boolean);
}

function isLegacyEmployeePhone(phone?: any, legacyPhones?: any) {
  return legacyPhones.some((allowed?: any) => phonesMatch(allowed, phone));
}

function ensureUserRightsTable(db: Db) {
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

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function ensureAdminCredentialColumns(db: Db) {
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

function ensureRegosLinkColumns(db: Db) {
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

function ensureEmployeeProfileColumns(db: Db) {
  if (!tableExists(db, 'bot_users')) return;
  if (!columnExists(db, 'bot_users', 'job_title')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN job_title TEXT');
  }
  if (!columnExists(db, 'bot_users', 'description')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN description TEXT');
  }
  if (!columnExists(db, 'bot_users', 'schedule')) {
    db.exec('ALTER TABLE bot_users ADD COLUMN schedule TEXT');
  }
}

function presentBotUser(user?: any) {
  if (!user) return user;
  return { ...user, schedule: parseSchedule(user.schedule) };
}

function finishBotUsersMigration(db: Db) {
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

function seedMissingEmployeeRights(db: Db) {
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

function migrateBotUsersSchema(db: Db) {
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
  const pendingRights: any[] = [];

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

  const seenPhones: Set<any> = new Set();
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
    const alreadyStored = [...seenPhones].some((storedKey?: any) => phonesMatch(storedKey, phone));
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
    const match = employees.find((employee?: any) => phonesMatch(employee.phone, item.phone));
    if (match) {
      seedRightsForUser(db, match.id, item);
    }
  }
}

export {
  normalizePhoneKey,
  phonesMatch,
  presentBotUser,
  ensureEmployeeProfileColumns,
  ensureRegosLinkColumns,
  migrateBotUsersSchema,
};
