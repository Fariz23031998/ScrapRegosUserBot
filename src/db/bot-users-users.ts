import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { serializeSchedule } from '../lib/employee-schedule';
import {
  normalizePhoneKey,
  phonesMatch,
  presentBotUser,
  ensureEmployeeProfileColumns,
  ensureRegosLinkColumns,
} from './bot-users-schema';
import {
  DEFAULT_RIGHTS,
  hashAdminPassword,
  assertAdminLoginAvailable,
  getUserRights,
  upsertUserRights,
} from './bot-users-rights';
import { resolveListOrderBy } from './list-sort';

function getBotUserByTelegramId(db: Db, telegramId?: any) {
  if (!telegramId) return null;
  return db.prepare('SELECT * FROM bot_users WHERE telegram_id = ?').get(telegramId) ?? null;
}

function getBotUserById(db: Db, userId?: any) {
  return db.prepare('SELECT * FROM bot_users WHERE id = ?').get(userId) ?? null;
}

function getBotUser(db: Db, telegramId?: any) {
  return getBotUserByTelegramId(db, telegramId);
}

function findUserByPhone(db: Db, phone?: any) {
  if (!phone) return null;
  const users = db.prepare('SELECT * FROM bot_users').all();
  return users.find((u?: any) => phonesMatch(u.phone, phone)) ?? null;
}

function getEmployeeByPhone(db: Db, phone?: any) {
  const user = findUserByPhone(db, phone);
  if (!user || user.role !== 'employee') return null;
  return user;
}

function getBotUsersByPhone(db: Db, phone?: any) {
  if (!phone) return [];
  const users = db.prepare('SELECT * FROM bot_users WHERE telegram_id IS NOT NULL').all();
  return users.filter((u?: any) => phonesMatch(u.phone, phone));
}

function linkEmployeeTelegram(db: Db, userId: any, telegramId: any, { username, firstName, lastName }: Unchecked = {}) {
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

function registerCustomer(db: Db, { telegramId, phone, username, firstName, lastName }: Unchecked) {
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

function normalizeStoredPhone(phone?: any) {
  return String(phone || '').trim();
}

function applyEmployeeAdminCredentials(db: Db, userId: any, { adminLogin, password }: Unchecked = {}, { requirePair = false }: Unchecked = {}) {
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

function createEmployeeUser(db: Db, { phone, displayName, jobTitle, description, schedule, rights = {}, adminLogin, password }: Unchecked = {}) {
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
  const storedSchedule = serializeSchedule(schedule);

  const result = db
    .prepare(
      `INSERT INTO bot_users (phone, role, display_name, job_title, description, schedule, admin_login, password_hash)
       VALUES (?, 'employee', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      normalized,
      displayName?.trim() || null,
      jobTitle?.trim() || null,
      description?.trim() || null,
      storedSchedule,
      login,
      login ? hashAdminPassword(password) : null
    );
  const userId = Number(result.lastInsertRowid);
  upsertUserRights(db, userId, { ...DEFAULT_RIGHTS, ...rights });
  return getEmployeeWithRights(db, userId);
}

function updateEmployeeUser(db: Db, userId: any, { phone, displayName, jobTitle, description, schedule, rights, adminLogin, password }: Unchecked = {}) {
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

  if (schedule !== undefined) {
    db.prepare('UPDATE bot_users SET schedule = ? WHERE id = ?').run(serializeSchedule(schedule), userId);
  }

  applyEmployeeAdminCredentials(db, userId, { adminLogin, password });

  if (rights) {
    upsertUserRights(db, userId, rights);
  }

  return getEmployeeWithRights(db, userId);
}

function convertCustomerToEmployee(db: Db, userId: any, { displayName, jobTitle, description, schedule, rights = {}, adminLogin, password }: Unchecked = {}) {
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
    "UPDATE bot_users SET role = 'employee', display_name = ?, job_title = ?, description = ?, schedule = ? WHERE id = ?"
  ).run(
    name,
    jobTitle?.trim() || null,
    description?.trim() || null,
    serializeSchedule(schedule),
    userId
  );
  applyEmployeeAdminCredentials(db, userId, { adminLogin, password }, { requirePair: true });
  upsertUserRights(db, userId, { ...DEFAULT_RIGHTS, ...rights });
  return getEmployeeWithRights(db, userId);
}

function deleteEmployeeUser(db: Db, userId?: any) {
  const user = getBotUserById(db, userId);
  if (!user || user.role !== 'employee') {
    return false;
  }
  const orderCount = (
    db
      .prepare('SELECT COUNT(*) AS count FROM orders WHERE telegram_id = ?')
      .get(user.telegram_id) as { count: number } | undefined
  )?.count;
  if (orderCount! > 0) {
    throw new Error('HAS_ORDERS');
  }
  db.prepare('DELETE FROM bot_users WHERE id = ?').run(userId);
  return true;
}

function findBotUserByRegosUserId(db: Db, regosUserId?: any) {
  const id = Number(regosUserId);
  if (!Number.isFinite(id)) return null;
  return db.prepare('SELECT * FROM bot_users WHERE regos_user_id = ?').get(id) ?? null;
}

function clearBotUserRegosLink(db: Db, userId?: any) {
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

function setBotUserRegosLink(db: Db, userId: any, { regosUserId, regosLogin = null, regosFullName = null }: Unchecked = {}) {
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

function setBotUserRegosClientId(db: Db, userId?: any, regosClientId?: any) {
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

function getEmployeeWithRights(db: Db, userId?: any) {
  const user = getBotUserById(db, userId);
  if (!user) return null;
  return presentBotUser({
    ...user,
    rights: getUserRights(db, userId),
    is_linked: user.telegram_id != null,
  });
}

function userMatchesQuery(user?: any, query?: any) {
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

const USER_SORT_COLUMNS: Record<string, string> = {
  id: 'id',
  phone: 'phone COLLATE NOCASE',
  name: `COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), username) COLLATE NOCASE`,
  login: 'admin_login COLLATE NOCASE',
  job_title: 'job_title COLLATE NOCASE',
  regos: 'COALESCE(regos_full_name, regos_login) COLLATE NOCASE',
  telegram: 'telegram_id',
  linked_at: 'datetime(linked_at)',
};

function listBotUsers(db: Db, { role, query, offset = 0, limit, sort }: Unchecked = {}) {
  let sql = 'SELECT * FROM bot_users WHERE 1=1';
  const params: any[] = [];

  if (role === 'employee' || role === 'customer') {
    sql += ' AND role = ?';
    params.push(role);
  }

  sql += ` ${resolveListOrderBy(sort, USER_SORT_COLUMNS, 'id') || 'ORDER BY created_at DESC'}`;

  let users = db.prepare(sql).all(...params);
  if (query) {
    users = users.filter((user?: any) => userMatchesQuery(user, query));
  }

  const total = users.length;
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeLimit = limit == null ? total : Math.min(Math.max(Number(limit) || 25, 1), 100);
  const pageUsers = users.slice(safeOffset, safeOffset + safeLimit);

  return {
    users: pageUsers.map((user?: any) =>
      presentBotUser({
        ...user,
        rights: user.role === 'employee' ? getUserRights(db, user.id) : null,
        is_linked: user.telegram_id != null,
      })
    ),
    total,
  };
}

function listEmployeeUsers(db: Db) {
  return listBotUsers(db, { role: 'employee' }).users;
}

function countBotUsers(db: Db) {
  return (db.prepare('SELECT COUNT(*) AS count FROM bot_users').get() as { count: number } | undefined)!.count;
}

function isLinkedEmployee(user?: any) {
  return !!user && user.role === 'employee' && user.telegram_id != null;
}

export {
  getBotUserByTelegramId,
  getBotUserById,
  getBotUser,
  findUserByPhone,
  getEmployeeByPhone,
  getBotUsersByPhone,
  linkEmployeeTelegram,
  registerCustomer,
  createEmployeeUser,
  updateEmployeeUser,
  convertCustomerToEmployee,
  deleteEmployeeUser,
  findBotUserByRegosUserId,
  clearBotUserRegosLink,
  setBotUserRegosLink,
  setBotUserRegosClientId,
  getEmployeeWithRights,
  listBotUsers,
  listEmployeeUsers,
  countBotUsers,
  isLinkedEmployee,
};
