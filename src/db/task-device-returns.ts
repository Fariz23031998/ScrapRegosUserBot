import type { Db } from '../types/db';
import { isRepairReturnRequireSerials } from './repair-return-settings';
import { ensureTaskTables, getTask, touchTask } from './tasks';
import { consumeSerialsForReturn, getSerialByCode, listSerialsForLine, releaseSerialsForReturn } from './task-device-serials';
import { lineQuantity, loadReturnedItem } from './task-device-returns-list';

const MAX_NOTE = 500;
const MAX_LINE_QUANTITY = 999;

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureTaskDeviceReturnTables(db: Db) {
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

function normalizeReturnQuantity(value?: any, maxQty?: any) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1 || qty > maxQty || qty > MAX_LINE_QUANTITY) {
    throw new Error('INVALID_TASK_RETURN_QUANTITY');
  }
  return qty;
}

function collectSerialRefs(input?: any) {
  const ids: any[] = [];
  const codes: any[] = [];
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

function resolveReturnSerialIds(db: Db, lineId?: any, input?: any, requireSerials?: any) {
  const { ids, codes } = collectSerialRefs(input);
  if (!ids.length && !codes.length) {
    if (requireSerials) throw new Error('TASK_RETURN_SERIALS_REQUIRED');
    return null;
  }

  const available = listSerialsForLine(db, lineId);
  const byId: Map<any, any> = new Map(available.map((serial?: any) => [serial.id, serial]));
  const seen: Set<any> = new Set();
  const resolved: any[] = [];

  function takeSerial(serial?: any) {
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

function normalizeNote(value?: any) {
  if (value == null || String(value).trim() === '') return null;
  const note = String(value).trim();
  if (note.length > MAX_NOTE) throw new Error('INVALID_TASK_RETURN_NOTE');
  return note;
}

function returnedQuantitiesByLineIds(db: Db, lineIds?: any) {
  ensureTaskDeviceReturnTables(db);
  const ids = (lineIds || [])
    .map((id?: any) => Number(id))
    .filter((id?: any) => Number.isFinite(id) && id > 0);
  const map: Map<any, any> = new Map();
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

function countTaskDeviceReturns(db: Db, taskId?: any) {
  ensureTaskDeviceReturnTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0 || !tableExists(db, 'task_device_returns')) return 0;
  const row = db.prepare('SELECT COUNT(*) AS count FROM task_device_returns WHERE task_id = ?').get(id);
  return Number(row?.count) || 0;
}

function deleteTaskDeviceReturns(db: Db, taskId?: any) {
  ensureTaskDeviceReturnTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const result = db.prepare('DELETE FROM task_device_returns WHERE task_id = ?').run(id);
  return Number(result.changes) || 0;
}

function loadDeviceLineForReturn(db: Db, lineId?: any) {
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

function assertReturnableTask(task?: any) {
  if (!task) throw new Error('NOT_FOUND');
  if (task.action !== 'repair') throw new Error('TASK_NOT_REPAIR');
  if (task.status !== 'done') throw new Error('TASK_NOT_DONE');
  if (!task.posted) throw new Error('TASK_NOT_POSTED');
}

function createTaskDeviceReturn(db: Db, input: any = {}, viewer?: any) {
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

function deleteTaskDeviceReturn(db: Db, returnId?: any, viewer?: any) {
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

export {
  ensureTaskDeviceReturnTables,
  returnedQuantitiesByLineIds,
  countTaskDeviceReturns,
  deleteTaskDeviceReturns,
  createTaskDeviceReturn,
  deleteTaskDeviceReturn,
};
export { listRepairDeviceReturns } from './task-device-returns-list';
