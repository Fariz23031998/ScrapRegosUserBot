import type { Db } from '../types/db';

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function ensureColumn(db: Db, table?: any, column?: any, ddl?: any) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col?: any) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function formatSerialCode(id?: any) {
  return `SR${String(id).padStart(8, '0')}`;
}

function ensureTaskDeviceSerialTables(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_device_serials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      device_line_id INTEGER NOT NULL,
      code TEXT NOT NULL UNIQUE,
      printed_at TEXT,
      returned_at TEXT,
      return_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (device_line_id) REFERENCES task_devices(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_device_serials_task_id ON task_device_serials(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_device_serials_line_id ON task_device_serials(device_line_id);
    CREATE INDEX IF NOT EXISTS idx_task_device_serials_return_id ON task_device_serials(return_id);
  `);
  ensureColumn(db, 'task_device_serials', 'printed_at', 'TEXT');
  ensureColumn(db, 'task_device_serials', 'returned_at', 'TEXT');
  ensureColumn(db, 'task_device_serials', 'return_id', 'INTEGER');
}

function mapSerial(row?: any) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    device_line_id: row.device_line_id,
    code: row.code,
    printed_at: row.printed_at || null,
    returned_at: row.returned_at || null,
    return_id: row.return_id == null ? null : Number(row.return_id),
    created_at: row.created_at,
  };
}

function listSerialsForLine(db: Db, lineId?: any) {
  ensureTaskDeviceSerialTables(db);
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) return [];
  return db
    .prepare(
      `SELECT id, task_id, device_line_id, code, printed_at, returned_at, return_id, created_at
       FROM task_device_serials
       WHERE device_line_id = ?
       ORDER BY id ASC`
    )
    .all(id)
    .map(mapSerial);
}

function listSerialsForReturn(db: Db, returnId?: any) {
  ensureTaskDeviceSerialTables(db);
  const id = Number(returnId);
  if (!Number.isFinite(id) || id <= 0) return [];
  return db
    .prepare(
      `SELECT id, task_id, device_line_id, code, printed_at, returned_at, return_id, created_at
       FROM task_device_serials
       WHERE return_id = ?
       ORDER BY id ASC`
    )
    .all(id)
    .map(mapSerial);
}

function getSerialByCode(db: Db, code?: any) {
  ensureTaskDeviceSerialTables(db);
  const value = String(code || '').trim().toUpperCase();
  if (!value) return null;
  return mapSerial(
    db
      .prepare(
        `SELECT id, task_id, device_line_id, code, printed_at, returned_at, return_id, created_at
         FROM task_device_serials
         WHERE UPPER(code) = ?`
      )
      .get(value)
  );
}

function insertSerial(db: Db, taskId?: any, lineId?: any) {
  const placeholder = `TMP-${taskId}-${lineId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = db
    .prepare(
      `INSERT INTO task_device_serials (task_id, device_line_id, code, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(taskId, lineId, placeholder);
  const id = Number(result.lastInsertRowid);
  const code = formatSerialCode(id);
  db.prepare('UPDATE task_device_serials SET code = ? WHERE id = ?').run(code, id);
  return mapSerial(
    db
      .prepare(
        `SELECT id, task_id, device_line_id, code, printed_at, returned_at, return_id, created_at
         FROM task_device_serials WHERE id = ?`
      )
      .get(id)
  );
}

function syncSerialsForLine(db: Db, taskId?: any, lineId?: any, quantity?: any) {
  ensureTaskDeviceSerialTables(db);
  const qty = Math.max(0, Math.trunc(Number(quantity) || 0));
  const existing = listSerialsForLine(db, lineId);
  if (existing.length < qty) {
    const missing = qty - existing.length;
    for (let i = 0; i < missing; i += 1) {
      insertSerial(db, taskId, lineId);
    }
    return listSerialsForLine(db, lineId);
  }
  if (existing.length > qty) {
    const extra = existing.length - qty;
    const removable = [...existing]
      .reverse()
      .filter((serial?: any) => !serial.printed_at && !serial.returned_at);
    if (removable.length < extra) {
      throw new Error('SERIALS_LOCKED');
    }
    const del = db.prepare('DELETE FROM task_device_serials WHERE id = ?');
    for (const serial of removable.slice(0, extra)) {
      del.run(serial!.id);
    }
  }
  return listSerialsForLine(db, lineId);
}

function ensureSerialsForDevices(db: Db, taskId?: any, devices?: any) {
  ensureTaskDeviceSerialTables(db);
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return;
  for (const line of devices || []) {
    if (!line?.id) continue;
    const qty = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
    syncSerialsForLine(db, id, line.id, qty);
  }
}

function attachSerials(db: Db, devices?: any) {
  if (!devices?.length) return devices;
  for (const line of devices) {
    line.serials = listSerialsForLine(db, line.id);
  }
  return devices;
}

function markSerialsPrinted(db: Db, serialIds?: any) {
  ensureTaskDeviceSerialTables(db);
  const stmt = db.prepare(
    `UPDATE task_device_serials
     SET printed_at = datetime('now')
     WHERE id = ? AND printed_at IS NULL`
  );
  for (const id of serialIds || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) stmt.run(n);
  }
}

function consumeSerialsForReturn(db: Db, lineId?: any, quantity?: any, returnId?: any, serialIds?: any) {
  ensureTaskDeviceSerialTables(db);
  const available = listSerialsForLine(db, lineId).filter((serial?: any) => !serial.returned_at);
  const qty = Math.trunc(Number(quantity) || 0);
  if (qty < 1) return [];
  const requestedIds = Array.isArray(serialIds) ? serialIds.map((id?: any) => Number(id)) : [];
  let taken: any;
  if (requestedIds.length) {
    if (requestedIds.length !== qty) throw new Error('INVALID_TASK_RETURN_QUANTITY');
    const byId: Map<any, any> = new Map(available.map((serial?: any) => [serial.id, serial]));
    const seen: Set<any> = new Set();
    taken = [];
    for (const id of requestedIds) {
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) throw new Error('INVALID_TASK_RETURN_SERIAL');
      const serial = byId.get(id);
      if (!serial) throw new Error('INVALID_TASK_RETURN_SERIAL');
      seen.add(id);
      taken.push(serial);
    }
  } else {
    if (available.length < qty) throw new Error('INVALID_TASK_RETURN_QUANTITY');
    taken = available.slice(0, qty);
  }
  const stmt = db.prepare(
    `UPDATE task_device_serials
     SET returned_at = datetime('now'), return_id = ?
     WHERE id = ?`
  );
  for (const serial of taken) {
    stmt.run(returnId, serial.id);
  }
  return listSerialsForReturn(db, returnId);
}

function releaseSerialsForReturn(db: Db, returnId?: any) {
  ensureTaskDeviceSerialTables(db);
  db.prepare(
    `UPDATE task_device_serials
     SET returned_at = NULL, return_id = NULL
     WHERE return_id = ?`
  ).run(returnId);
}

export {
  formatSerialCode,
  ensureTaskDeviceSerialTables,
  listSerialsForLine,
  listSerialsForReturn,
  getSerialByCode,
  syncSerialsForLine,
  ensureSerialsForDevices,
  attachSerials,
  markSerialsPrinted,
  consumeSerialsForReturn,
  releaseSerialsForReturn,
};
