const { getBotUserById, getBotUserByTelegramId } = require('./bot-users-db');

const MAX_LOCATION_NAME = 100;

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

function employeeLabel(user) {
  if (!user) return null;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (
    user.display_name ||
    fullName ||
    user.admin_login ||
    (user.username ? `@${user.username}` : null) ||
    user.phone ||
    `Сотрудник #${user.id}`
  );
}

function mapAllowedUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: employeeLabel(row),
  };
}

function ensureLocationTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS location_allowed_users (
      location_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (location_id, user_id),
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES bot_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_location_allowed_users_user_id
      ON location_allowed_users(user_id);
  `);
  if (ensureColumn(db, 'tasks', 'location_id', 'INTEGER')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_location_id ON tasks(location_id)');
  } else if (tableExists(db, 'tasks')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_location_id ON tasks(location_id)');
  }
}

function normalizeLocationName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > MAX_LOCATION_NAME) throw new Error('INVALID_LOCATION_NAME');
  return name;
}

function normalizeAllowedUserIds(db, value) {
  if (value == null) throw new Error('INVALID_LOCATION_USERS');
  if (!Array.isArray(value)) throw new Error('INVALID_LOCATION_USERS');
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const userId = Number(item);
    if (!Number.isFinite(userId) || userId <= 0) throw new Error('INVALID_LOCATION_USERS');
    if (seen.has(userId)) continue;
    const user = getBotUserById(db, userId);
    if (!user || user.role !== 'employee') throw new Error('INVALID_LOCATION_USERS');
    seen.add(userId);
    ids.push(userId);
  }
  if (!ids.length) throw new Error('INVALID_LOCATION_USERS');
  return ids;
}

function listAllowedUsers(db, locationId) {
  return db
    .prepare(
      `SELECT u.id, u.display_name, u.first_name, u.last_name, u.admin_login, u.username, u.phone
       FROM location_allowed_users lu
       JOIN bot_users u ON u.id = lu.user_id
       WHERE lu.location_id = ?
       ORDER BY IFNULL(u.display_name, '') COLLATE NOCASE ASC, u.id ASC`
    )
    .all(locationId)
    .map(mapAllowedUser);
}

function replaceAllowedUsers(db, locationId, userIds) {
  db.prepare('DELETE FROM location_allowed_users WHERE location_id = ?').run(locationId);
  const insert = db.prepare(
    'INSERT INTO location_allowed_users (location_id, user_id) VALUES (?, ?)'
  );
  for (const userId of userIds) {
    insert.run(locationId, userId);
  }
}

function mapLocation(db, row) {
  if (!row) return null;
  const allowedUsers = listAllowedUsers(db, row.id);
  return {
    id: row.id,
    name: row.name,
    allowed_user_ids: allowedUsers.map((user) => user.id),
    allowed_users: allowedUsers,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapLocationSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
  };
}

function getLocation(db, id) {
  ensureLocationTables(db);
  const locationId = Number(id);
  if (!Number.isFinite(locationId) || locationId <= 0) return null;
  const row = db
    .prepare('SELECT id, name, created_at, updated_at FROM locations WHERE id = ?')
    .get(locationId);
  return mapLocation(db, row);
}

function listLocations(db) {
  ensureLocationTables(db);
  return db
    .prepare(
      `SELECT id, name, created_at, updated_at
       FROM locations
       ORDER BY name COLLATE NOCASE ASC, id ASC`
    )
    .all()
    .map((row) => mapLocation(db, row));
}

function createLocation(db, input = {}) {
  ensureLocationTables(db);
  const name = normalizeLocationName(input.name);
  const allowedUserIds = normalizeAllowedUserIds(db, input.allowed_user_ids);
  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `INSERT INTO locations (name, created_at, updated_at)
         VALUES (?, datetime('now'), datetime('now'))`
      )
      .run(name);
    const locationId = Number(result.lastInsertRowid);
    replaceAllowedUsers(db, locationId, allowedUserIds);
    db.exec('COMMIT');
    return getLocation(db, locationId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function updateLocation(db, id, input = {}) {
  ensureLocationTables(db);
  const current = getLocation(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const name = normalizeLocationName(input.name != null ? input.name : current.name);
  const allowedUserIds =
    input.allowed_user_ids !== undefined
      ? normalizeAllowedUserIds(db, input.allowed_user_ids)
      : current.allowed_user_ids;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE locations SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(
      name,
      current.id
    );
    replaceAllowedUsers(db, current.id, allowedUserIds);
    db.exec('COMMIT');
    return getLocation(db, current.id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteLocation(db, id) {
  ensureLocationTables(db);
  const current = getLocation(db, id);
  if (!current) return false;
  db.exec('BEGIN');
  try {
    if (tableExists(db, 'tasks')) {
      db.prepare('UPDATE tasks SET location_id = NULL WHERE location_id = ?').run(current.id);
    }
    if (tableExists(db, 'account_payments')) {
      const cols = db.prepare('PRAGMA table_info(account_payments)').all();
      if (cols.some((col) => col.name === 'location_id')) {
        db.prepare('UPDATE account_payments SET location_id = NULL WHERE location_id = ?').run(current.id);
      }
    }
    db.prepare('DELETE FROM location_allowed_users WHERE location_id = ?').run(current.id);
    db.prepare('DELETE FROM locations WHERE id = ?').run(current.id);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function userCanAccessLocation(db, locationId, userId) {
  ensureLocationTables(db);
  const locId = Number(locationId);
  const uid = Number(userId);
  if (!Number.isFinite(locId) || locId <= 0 || !Number.isFinite(uid) || uid <= 0) return false;
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM location_allowed_users WHERE location_id = ? AND user_id = ? LIMIT 1'
      )
      .get(locId, uid)
  );
}

function getLocationViewer(db, actor) {
  if (!actor || actor.type === 'password') return { seeAll: true, userId: null };
  let user = null;
  if (actor.type === 'telegram') {
    user = getBotUserByTelegramId(db, actor.telegramId);
  } else if (actor.type === 'user') {
    user = getBotUserById(db, actor.userId);
  }
  if (!user || user.role !== 'employee') return { seeAll: false, userId: -1 };
  return { seeAll: false, userId: user.id };
}

function canViewerAccessLocation(db, locationId, viewer) {
  if (!viewer || viewer.seeAll) return true;
  if (locationId == null) return true;
  return userCanAccessLocation(db, locationId, viewer.userId);
}

function listLocationsForViewer(db, viewer) {
  const locations = listLocations(db);
  if (!viewer || viewer.seeAll) {
    return locations.map((location) => mapLocationSummary(location));
  }
  return locations
    .filter((location) => location.allowed_user_ids.includes(viewer.userId))
    .map((location) => mapLocationSummary(location));
}

function appendLocationAccessFilter(where, params, viewer, alias = 't') {
  if (!viewer || viewer.seeAll) return;
  where.push(`(
    ${alias}.location_id IS NULL
    OR EXISTS (
      SELECT 1 FROM location_allowed_users lu
      WHERE lu.location_id = ${alias}.location_id AND lu.user_id = ?
    )
  )`);
  params.push(viewer.userId);
}

module.exports = {
  MAX_LOCATION_NAME,
  ensureLocationTables,
  listLocations,
  listLocationsForViewer,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
  userCanAccessLocation,
  getLocationViewer,
  canViewerAccessLocation,
  appendLocationAccessFilter,
};
