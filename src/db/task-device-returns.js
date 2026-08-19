const { appendLocationAccessFilter, canViewerAccessLocation } = require('./locations');
const { isRepairReturnRequireSerials } = require('./repair-return-settings');
const { ensureTaskTables, getTask, touchTask } = require('./tasks');
const {
  consumeSerialsForReturn,
  getSerialByCode,
  listSerialsForLine,
  listSerialsForReturn,
  releaseSerialsForReturn,
} = require('./task-device-serials');

const MAX_NOTE = 500;
const MAX_LINE_QUANTITY = 999;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureTaskDeviceReturnTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_device_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      device_line_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      note TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (device_line_id) REFERENCES task_devices(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_device_returns_task_id ON task_device_returns(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_device_returns_device_line_id ON task_device_returns(device_line_id);
  `);
}

function lineQuantity(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.trunc(qty);
}

function normalizeReturnQuantity(value, maxQty) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > maxQty || qty > MAX_LINE_QUANTITY) {
    throw new Error('INVALID_TASK_RETURN_QUANTITY');
  }
  return qty;
}

function collectSerialRefs(input) {
  const ids = [];
  const codes = [];
  const rawIds = input.serial_ids;
  if (Array.isArray(rawIds)) {
    for (const value of rawIds) {
      const id = Number(value);
      if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
        throw new Error('INVALID_TASK_RETURN_SERIAL');
      }
      ids.push(id);
    }
  } else if (rawIds != null && rawIds !== '') {
    throw new Error('INVALID_TASK_RETURN_SERIAL');
  }

  const rawCodes = input.serial_codes;
  if (Array.isArray(rawCodes)) {
    for (const value of rawCodes) {
      const code = String(value == null ? '' : value).trim();
      if (!code) throw new Error('INVALID_TASK_RETURN_SERIAL');
      codes.push(code);
    }
  } else if (rawCodes != null && String(rawCodes).trim() !== '') {
    codes.push(String(rawCodes).trim());
  }
  return { ids, codes };
}

function resolveReturnSerialIds(db, lineId, input, requireSerials) {
  const { ids, codes } = collectSerialRefs(input);
  if (!ids.length && !codes.length) {
    if (requireSerials) throw new Error('TASK_RETURN_SERIALS_REQUIRED');
    return null;
  }

  const available = listSerialsForLine(db, lineId);
  const byId = new Map(available.map((serial) => [serial.id, serial]));
  const seen = new Set();
  const resolved = [];

  function takeSerial(serial) {
    if (!serial || Number(serial.device_line_id) !== Number(lineId) || serial.returned_at) {
      throw new Error('INVALID_TASK_RETURN_SERIAL');
    }
    if (seen.has(serial.id)) throw new Error('INVALID_TASK_RETURN_SERIAL');
    seen.add(serial.id);
    resolved.push(serial.id);
  }

  for (const id of ids) {
    takeSerial(byId.get(id) || null);
  }
  for (const code of codes) {
    takeSerial(getSerialByCode(db, code));
  }
  return resolved;
}

function normalizeNote(value) {
  if (value == null || String(value).trim() === '') return null;
  const note = String(value).trim();
  if (note.length > MAX_NOTE) throw new Error('INVALID_TASK_RETURN_NOTE');
  return note;
}

function authorLabel(row) {
  const fullName = [row.created_by_first_name, row.created_by_last_name].filter(Boolean).join(' ').trim();
  return (
    row.created_by_display_name ||
    fullName ||
    row.created_by_admin_login ||
    (row.created_by_username ? `@${row.created_by_username}` : null)
  );
}

function mapCreatedBy(row) {
  if (row.created_by_user_id == null) return null;
  return {
    id: row.created_by_user_id,
    name: authorLabel(row) || `Сотрудник #${row.created_by_user_id}`,
  };
}

function mapTaskSummary(row) {
  return {
    id: row.task_id,
    title: row.task_title || '',
    client_name: row.client_name || '',
    client_phone: row.client_phone || '',
    location:
      row.location_id != null
        ? { id: row.location_id, name: row.location_name || '' }
        : null,
    technician:
      row.technician_user_id != null
        ? {
            id: row.technician_user_id,
            name:
              row.technician_display_name ||
              [row.technician_first_name, row.technician_last_name].filter(Boolean).join(' ').trim() ||
              row.technician_admin_login ||
              (row.technician_username ? `@${row.technician_username}` : `Сотрудник #${row.technician_user_id}`),
          }
        : null,
    updated_at: row.task_updated_at,
  };
}

function returnedQuantitiesByLineIds(db, lineIds) {
  ensureTaskDeviceReturnTables(db);
  const ids = (lineIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const map = new Map();
  if (!ids.length || !tableExists(db, 'task_device_returns')) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT device_line_id, COALESCE(SUM(quantity), 0) AS qty
       FROM task_device_returns
       WHERE device_line_id IN (${placeholders})
       GROUP BY device_line_id`
    )
    .all(...ids);
  for (const row of rows) {
    map.set(Number(row.device_line_id), Number(row.qty) || 0);
  }
  return map;
}

function countTaskDeviceReturns(db, taskId) {
  ensureTaskDeviceReturnTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0 || !tableExists(db, 'task_device_returns')) return 0;
  const row = db.prepare('SELECT COUNT(*) AS count FROM task_device_returns WHERE task_id = ?').get(id);
  return Number(row?.count) || 0;
}

function deleteTaskDeviceReturns(db, taskId) {
  ensureTaskDeviceReturnTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const result = db.prepare('DELETE FROM task_device_returns WHERE task_id = ?').run(id);
  return Number(result.changes) || 0;
}

function loadDeviceLineForReturn(db, lineId) {
  return (
    db
      .prepare(
        `SELECT td.id, td.task_id, td.device_id, td.quantity,
                d.name AS device_name,
                t.action, t.status, t.posted, t.location_id
         FROM task_devices td
         INNER JOIN tasks t ON t.id = td.task_id
         LEFT JOIN devices d ON d.id = td.device_id
         WHERE td.id = ?`
      )
      .get(lineId) || null
  );
}

function assertReturnableTask(task) {
  if (!task) throw new Error('NOT_FOUND');
  if (task.action !== 'repair') throw new Error('TASK_NOT_REPAIR');
  if (task.status !== 'done') throw new Error('TASK_NOT_DONE');
  if (!task.posted) throw new Error('TASK_NOT_POSTED');
}

const LIST_FROM = `
  task_devices td
  INNER JOIN tasks t ON t.id = td.task_id
  LEFT JOIN devices d ON d.id = td.device_id
  LEFT JOIN locations loc ON loc.id = t.location_id
  LEFT JOIN bot_users tech ON tech.id = t.technician_user_id
  LEFT JOIN (
    SELECT device_line_id, COALESCE(SUM(quantity), 0) AS returned_qty
    FROM task_device_returns
    GROUP BY device_line_id
  ) ret ON ret.device_line_id = td.id
`;

const LIST_SELECT = `
  td.id AS device_line_id,
  td.device_id,
  td.quantity,
  IFNULL(d.name, '') AS device_name,
  IFNULL(ret.returned_qty, 0) AS returned_quantity,
  t.id AS task_id,
  t.title AS task_title,
  t.client_name,
  t.client_phone,
  t.location_id,
  loc.name AS location_name,
  t.technician_user_id,
  t.updated_at AS task_updated_at,
  tech.display_name AS technician_display_name,
  tech.first_name AS technician_first_name,
  tech.last_name AS technician_last_name,
  tech.admin_login AS technician_admin_login,
  tech.username AS technician_username
`;

const RETURNED_FROM = `
  task_device_returns r
  INNER JOIN task_devices td ON td.id = r.device_line_id
  INNER JOIN tasks t ON t.id = r.task_id
  LEFT JOIN devices d ON d.id = td.device_id
  LEFT JOIN locations loc ON loc.id = t.location_id
  LEFT JOIN bot_users tech ON tech.id = t.technician_user_id
  LEFT JOIN bot_users u ON u.id = r.created_by_user_id
  LEFT JOIN (
    SELECT device_line_id, COALESCE(SUM(quantity), 0) AS returned_qty
    FROM task_device_returns
    GROUP BY device_line_id
  ) ret ON ret.device_line_id = td.id
`;

const RETURNED_SELECT = `
  r.id,
  r.device_line_id,
  r.quantity AS return_quantity,
  r.note,
  r.created_at,
  r.created_by_user_id,
  td.device_id,
  td.quantity,
  IFNULL(d.name, '') AS device_name,
  IFNULL(ret.returned_qty, 0) AS returned_quantity,
  t.id AS task_id,
  t.title AS task_title,
  t.client_name,
  t.client_phone,
  t.location_id,
  loc.name AS location_name,
  t.technician_user_id,
  t.updated_at AS task_updated_at,
  tech.display_name AS technician_display_name,
  tech.first_name AS technician_first_name,
  tech.last_name AS technician_last_name,
  tech.admin_login AS technician_admin_login,
  tech.username AS technician_username,
  u.display_name AS created_by_display_name,
  u.first_name AS created_by_first_name,
  u.last_name AS created_by_last_name,
  u.admin_login AS created_by_admin_login,
  u.username AS created_by_username
`;

function eligibleTaskWhere() {
  return [`t.action = 'repair'`, `t.status = 'done'`, `IFNULL(t.posted, 0) = 1`];
}

function appendSearch(where, params, query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return;
  const like = `%${trimmed}%`;
  where.push(`(
    IFNULL(d.name, '') LIKE ?
    OR IFNULL(t.title, '') LIKE ?
    OR IFNULL(t.client_name, '') LIKE ?
    OR IFNULL(t.client_phone, '') LIKE ?
    OR IFNULL(loc.name, '') LIKE ?
  )`);
  params.push(like, like, like, like, like);
}

function appendLocationFilter(where, params, locationId) {
  if (locationId == null || locationId === '' || locationId === 'all') return;
  const parsed = Number(locationId);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_LOCATION');
  where.push('t.location_id = ?');
  params.push(parsed);
}

function mapPendingItem(db, row) {
  const quantity = lineQuantity(row.quantity);
  const returnedQuantity = Number(row.returned_quantity) || 0;
  const serials = listSerialsForLine(db, row.device_line_id).filter((serial) => !serial.returned_at);
  return {
    id: row.device_line_id,
    kind: 'pending',
    device_line_id: row.device_line_id,
    device_id: row.device_id,
    device_name: row.device_name || '',
    quantity,
    returned_quantity: returnedQuantity,
    remaining_quantity: Math.max(0, quantity - returnedQuantity),
    return_id: null,
    return_quantity: null,
    note: '',
    created_at: null,
    created_by: null,
    serials,
    task: mapTaskSummary(row),
  };
}

function mapReturnedItem(db, row) {
  const quantity = lineQuantity(row.quantity);
  const returnedQuantity = Number(row.returned_quantity) || 0;
  return {
    id: row.id,
    kind: 'returned',
    device_line_id: row.device_line_id,
    device_id: row.device_id,
    device_name: row.device_name || '',
    quantity,
    returned_quantity: returnedQuantity,
    remaining_quantity: Math.max(0, quantity - returnedQuantity),
    return_id: row.id,
    return_quantity: Number(row.return_quantity) || 0,
    note: row.note || '',
    created_at: row.created_at,
    created_by: mapCreatedBy(row),
    serials: listSerialsForReturn(db, row.id),
    task: mapTaskSummary(row),
  };
}

function listRepairDeviceReturns(
  db,
  { query, status = 'pending', locationId, viewer, limit = 25, offset = 0 } = {}
) {
  ensureTaskTables(db);
  ensureTaskDeviceReturnTables(db);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const kind = String(status || 'pending').trim() || 'pending';
  if (kind !== 'pending' && kind !== 'returned' && kind !== 'all') {
    throw new Error('INVALID_TASK_RETURN_STATUS');
  }
  if (locationId != null && locationId !== '' && locationId !== 'all') {
    const parsed = Number(locationId);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_LOCATION');
    if (!canViewerAccessLocation(db, parsed, viewer)) throw new Error('INVALID_TASK_LOCATION');
  }

  if (kind === 'returned') {
    const where = eligibleTaskWhere();
    const params = [];
    appendSearch(where, params, query);
    appendLocationFilter(where, params, locationId);
    appendLocationAccessFilter(where, params, viewer);
    const whereSql = ` WHERE ${where.join(' AND ')}`;
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM ${RETURNED_FROM}${whereSql}`)
      .get(...params).count;
    const rows = db
      .prepare(
        `SELECT ${RETURNED_SELECT}
         FROM ${RETURNED_FROM}${whereSql}
         ORDER BY datetime(r.created_at) DESC, r.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, safeOffset);
    return { items: rows.map((row) => mapReturnedItem(db, row)), total };
  }

  const where = eligibleTaskWhere();
  const params = [];
  appendSearch(where, params, query);
    appendLocationFilter(where, params, locationId);
  appendLocationAccessFilter(where, params, viewer);
  if (kind === 'pending') {
    where.push('(td.quantity - IFNULL(ret.returned_qty, 0)) > 0');
  } else {
    where.push('(td.quantity - IFNULL(ret.returned_qty, 0) > 0 OR IFNULL(ret.returned_qty, 0) > 0)');
  }
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM ${LIST_FROM}${whereSql}`).get(...params).count;
  const rows = db
    .prepare(
      `SELECT ${LIST_SELECT}
       FROM ${LIST_FROM}${whereSql}
       ORDER BY datetime(t.updated_at) DESC, td.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset);
  return { items: rows.map((row) => mapPendingItem(db, row)), total };
}

function loadReturnedItem(db, returnId) {
  const row = db
    .prepare(
      `SELECT ${RETURNED_SELECT}
       FROM ${RETURNED_FROM}
       WHERE r.id = ?`
    )
    .get(returnId);
  return row ? mapReturnedItem(db, row) : null;
}

function createTaskDeviceReturn(db, input = {}, viewer) {
  ensureTaskTables(db);
  ensureTaskDeviceReturnTables(db);
  const lineId = Number(input.device_line_id);
  if (!Number.isFinite(lineId) || lineId <= 0) throw new Error('INVALID_TASK_RETURN_LINE');
  const line = loadDeviceLineForReturn(db, lineId);
  if (!line) throw new Error('NOT_FOUND');
  const task = getTask(db, line.task_id, viewer);
  assertReturnableTask(task);
  const cartQty = lineQuantity(line.quantity);
  const already = returnedQuantitiesByLineIds(db, [lineId]).get(lineId) || 0;
  const remaining = Math.max(0, cartQty - already);
  const serialIds = resolveReturnSerialIds(db, lineId, input, isRepairReturnRequireSerials(db));
  const requested = serialIds
    ? serialIds.length
    : input.quantity == null || input.quantity === ''
      ? remaining
      : input.quantity;
  const quantity = normalizeReturnQuantity(requested, remaining);
  const note = normalizeNote(input.note);
  const createdBy = Number(input.created_by_user_id);
  const result = db
    .prepare(
      `INSERT INTO task_device_returns (task_id, device_line_id, quantity, note, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      line.task_id,
      lineId,
      quantity,
      note,
      Number.isFinite(createdBy) && createdBy > 0 ? createdBy : null
    );
  touchTask(db, line.task_id);
  const returnId = Number(result.lastInsertRowid);
  const serials = consumeSerialsForReturn(db, lineId, quantity, returnId, serialIds);
  return { item: loadReturnedItem(db, returnId), task: getTask(db, line.task_id, viewer), serials };
}

function deleteTaskDeviceReturn(db, returnId, viewer) {
  ensureTaskTables(db);
  ensureTaskDeviceReturnTables(db);
  const id = Number(returnId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const row = db
    .prepare('SELECT id, task_id, device_line_id FROM task_device_returns WHERE id = ?')
    .get(id);
  if (!row) throw new Error('NOT_FOUND');
  const task = getTask(db, row.task_id, viewer);
  assertReturnableTask(task);
  db.prepare('DELETE FROM task_device_returns WHERE id = ?').run(id);
  releaseSerialsForReturn(db, id);
  touchTask(db, row.task_id);
  return { ok: true, task: getTask(db, row.task_id, viewer) };
}

module.exports = {
  ensureTaskDeviceReturnTables,
  returnedQuantitiesByLineIds,
  countTaskDeviceReturns,
  deleteTaskDeviceReturns,
  listRepairDeviceReturns,
  createTaskDeviceReturn,
  deleteTaskDeviceReturn,
};
