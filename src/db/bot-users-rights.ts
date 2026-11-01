import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import crypto from 'crypto';

const ADMIN_PASSWORD_HASH_PREFIX = 'scrypt';
const ADMIN_PASSWORD_KEYLEN = 64;

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
  finances_read: 0,
  finances_create: 0,
  finances_edit: 0,
  finances_delete: 0,
  knowledge_read: 0,
  knowledge_edit: 0,
  knowledge_lock: 0,
  knowledge_unlock: 0,
  knowledge_confirm: 0,
  ai_customer_test: 0,
  ai_customer_test_history: 0,
  prompt_variables_create: 0,
  tasks_read: 0,
  tasks_create: 0,
  tasks_edit: 0,
  tasks_delete: 0,
  tasks_payment_create: 0,
  tasks_payment_delete: 0,
  tasks_post: 0,
  tasks_unpost: 0,
  tasks_status: 0,
  tasks_manager: 0,
  tasks_technician: 0,
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
  'finances_read',
  'finances_create',
  'finances_edit',
  'finances_delete',
  'knowledge_read',
  'knowledge_edit',
  'knowledge_lock',
  'knowledge_unlock',
  'knowledge_confirm',
  'ai_customer_test',
  'ai_customer_test_history',
  'prompt_variables_create',
  'tasks_read',
  'tasks_create',
  'tasks_edit',
  'tasks_delete',
  'tasks_payment_create',
  'tasks_payment_delete',
  'tasks_post',
  'tasks_unpost',
  'tasks_status',
  'tasks_manager',
  'tasks_technician',
  'devices_read',
  'devices_create',
  'devices_edit',
  'devices_delete',
  'services_read',
  'services_create',
  'services_edit',
  'services_delete',
];

function normalizeAdminLogin(login?: any) {
  const value = String(login || '').trim();
  return value || null;
}

function hashAdminPassword(password?: any) {
  const plain = String(password || '');
  if (!plain) {
    throw new Error('PASSWORD_REQUIRED');
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, ADMIN_PASSWORD_KEYLEN);
  return `${ADMIN_PASSWORD_HASH_PREFIX}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyAdminPassword(password?: any, storedHash?: any) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== ADMIN_PASSWORD_HASH_PREFIX) return false;
  const [, saltB64, hashB64] = parts;
  let salt: any;
  let expected: any;
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

function findEmployeeByAdminLogin(db: Db, login?: any) {
  const normalized = normalizeAdminLogin(login);
  if (!normalized) return null;
  return (
    db
      .prepare("SELECT * FROM bot_users WHERE role = 'employee' AND lower(admin_login) = lower(?)")
      .get(normalized) ?? null
  );
}

function assertAdminLoginAvailable(db: Db, login: any, excludeUserId: any = null) {
  const normalized = normalizeAdminLogin(login);
  if (!normalized) return null;
  const existing = findEmployeeByAdminLogin(db, normalized);
  if (existing && existing.id !== excludeUserId) {
    throw new Error('LOGIN_EXISTS');
  }
  return normalized;
}

function seedRightsForUser(db: Db, userId: any, { manageVip = false }: Unchecked = {}) {
  if (!userId) return;
  const rights = { ...DEFAULT_RIGHTS, manage_vip: manageVip ? 1 : 0 };
  upsertUserRights(db, userId, rights);
}

function mapRightsRow(row?: any) {
  if (!row) return { ...DEFAULT_RIGHTS };
  const mapped: Unchecked = {};
  for (const key of RIGHTS_COLUMNS) {
    mapped[key] = Number(row[key]) ? 1 : 0;
  }
  return mapped;
}

function upsertUserRights(db: Db, userId: any, rights: any = {}) {
  const merged = { ...DEFAULT_RIGHTS, ...rights };
  const cols = RIGHTS_COLUMNS;
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.map((column?: any) => `${column} = excluded.${column}`).join(',\n      ');
  db.prepare(
    `INSERT INTO user_rights (
      user_id, ${cols.join(', ')}, updated_at
    ) VALUES (?, ${placeholders}, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      ${updates},
      updated_at = datetime('now')`
  ).run(userId, ...cols.map((column?: any) => (merged[column] ? 1 : 0)));
}

function getUserRights(db: Db, userId?: any) {
  const row = db.prepare('SELECT * FROM user_rights WHERE user_id = ?').get(userId);
  const mapped = mapRightsRow(row);
  // Fallback if migration copy has not run yet on a stale row shape.
  if (!mapped.tickets_read && row && Number(row.view_tickets)) {
    mapped.tickets_read = 1;
  }
  return mapped;
}

export {
  DEFAULT_RIGHTS,
  RIGHTS_COLUMNS,
  ADMIN_RIGHTS_COLUMNS,
  hashAdminPassword,
  verifyAdminPassword,
  findEmployeeByAdminLogin,
  assertAdminLoginAvailable,
  seedRightsForUser,
  getUserRights,
  upsertUserRights,
};
