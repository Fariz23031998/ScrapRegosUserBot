import type { Db } from '../types/db';
import { emptyDiscount, normalizeDiscountInput } from './money';
import { ensureTaskTables } from './tasks-schema';
import { getTask, touchTask } from './tasks-read';
import {
  MAX_LINE_QUANTITY,
  applyCreateStaffAssignment,
  normalizeTaskInput,
  normalizeTaskDevices,
  normalizeTaskDeviceLine,
  normalizeTaskServiceLine,
  normalizeQuantity,
  assertTaskCartEditable,
  assertForwardStatus,
  shouldResetTechnicianReminder,
} from './tasks-normalize';

function nextSortOrder(db: Db, table?: any, taskId?: any) {
  if (table !== 'task_devices' && table !== 'task_services') {
    throw new Error('INVALID_TABLE');
  }
  const row = db.prepare(`SELECT MAX(sort_order) AS max_order FROM ${table} WHERE task_id = ?`).get(taskId);
  if (row?.max_order == null) return 0;
  return Number(row.max_order) + 1;
}

function replaceTaskDevices(db: Db, taskId?: any, devices?: any) {
  db.prepare('DELETE FROM task_devices WHERE task_id = ?').run(taskId);
  const insert = db.prepare(
    `INSERT INTO task_devices (
       task_id, device_id, action, notes, quantity, sort_order, cost_amount, cost_currency, price_uzs, price_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of devices) {
    insert.run(
      taskId,
      item.device_id,
      item.action,
      item.notes,
      item.quantity,
      item.sort_order,
      item.cost_amount,
      item.cost_currency,
      item.price_uzs,
      item.price_usd
    );
  }
}

function createTask(db: Db, input: any, options: any = {}) {
  ensureTaskTables(db);
  const assignedInput = applyCreateStaffAssignment(db, input, options.actorUserId);
  const task = normalizeTaskInput(db, assignedInput, options);
  const devices = normalizeTaskDevices(db, assignedInput.devices || [], task.action);
  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `INSERT INTO tasks (
           title, status, action, notes, address, distance_km, distance_score, category_id, location_id,
           regos_client_id, client_name, client_phone,
           manager_user_id, technician_user_id, currency,
           planned_start_at, planned_finish_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        task.title,
        task.status,
        task.action,
        task.notes,
        task.address,
        task.distance_km,
        task.distance_score,
        task.category_id,
        task.location_id,
        task.regos_client_id,
        task.client_name,
        task.client_phone,
        task.manager_user_id,
        task.technician_user_id,
        task.currency,
        task.planned_start_at,
        task.planned_finish_at
      );
    const taskId = Number(result.lastInsertRowid);
    replaceTaskDevices(db, taskId, devices);
    db.exec('COMMIT');
    return getTask(db, taskId);
  } catch (error: any) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function updateTask(db: Db, id: any, input: any = {}, options: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, id, options.viewer);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const task = normalizeTaskInput(db, input, { partial: true, current, ...options });
  if (!options.allowAnyStatus) {
    assertForwardStatus(current.status, task.status);
  }
  const devices = input.devices != null ? normalizeTaskDevices(db, input.devices, task.action) : null;
  db.exec('BEGIN');
  try {
    const reminderSentAt = shouldResetTechnicianReminder(current, task)
      ? null
      : current.technician_reminder_sent_at || null;
    db.prepare(
      `UPDATE tasks
       SET title = ?, status = ?, action = ?, notes = ?, address = ?, distance_km = ?, distance_score = ?,
           category_id = ?, location_id = ?,
           regos_client_id = ?, client_name = ?, client_phone = ?,
           manager_user_id = ?, technician_user_id = ?, currency = ?,
           planned_start_at = ?, planned_finish_at = ?, technician_reminder_sent_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      task.title,
      task.status,
      task.action,
      task.notes,
      task.address,
      task.distance_km,
      task.distance_score,
      task.category_id,
      task.location_id,
      task.regos_client_id,
      task.client_name,
      task.client_phone,
      task.manager_user_id,
      task.technician_user_id,
      task.currency,
      task.planned_start_at,
      task.planned_finish_at,
      reminderSentAt,
      current.id
    );
    if (devices) replaceTaskDevices(db, current.id, devices);
    else if (task.action !== current.action) {
      db.prepare('UPDATE task_devices SET action = ? WHERE task_id = ?').run(task.action, current.id);
    }
    db.exec('COMMIT');
    return getTask(db, current.id);
  } catch (error: any) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function bumpLineQuantity(db: Db, table?: any, lineId?: any, currentQuantity?: any) {
  if (table !== 'task_devices' && table !== 'task_services') {
    throw new Error('INVALID_TABLE');
  }
  const next = (Number(currentQuantity) > 0 ? Number(currentQuantity) : 1) + 1;
  if (next > MAX_LINE_QUANTITY) throw new Error('INVALID_TASK_QUANTITY');
  db.prepare(`UPDATE ${table} SET quantity = ? WHERE id = ?`).run(next, lineId);
}

function addTaskDevice(db: Db, taskId: any, input: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const existing = db
    .prepare(
      `SELECT id, quantity FROM task_devices
       WHERE task_id = ? AND device_id = ?
       ORDER BY sort_order ASC, id ASC
       LIMIT 1`
    )
    .get(current.id, Number(input.device_id));
  if (existing) {
    bumpLineQuantity(db, 'task_devices', existing.id, existing.quantity);
    touchTask(db, current.id);
    return getTask(db, current.id);
  }
  const line = normalizeTaskDeviceLine(
    db,
    input,
    nextSortOrder(db, 'task_devices', current.id),
    current.action
  );
  db.prepare(
    `INSERT INTO task_devices (
       task_id, device_id, action, notes, quantity, sort_order, cost_amount, cost_currency, price_uzs, price_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    current.id,
    line.device_id,
    line.action,
    line.notes,
    line.quantity,
    line.sort_order,
    line.cost_amount,
    line.cost_currency,
    line.price_uzs,
    line.price_usd
  );
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function deleteTaskDevice(db: Db, taskId?: any, lineId?: any) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const result = db.prepare('DELETE FROM task_devices WHERE id = ? AND task_id = ?').run(id, current.id);
  if (!result.changes) throw new Error('NOT_FOUND');
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function addTaskService(db: Db, taskId: any, input: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const existing = db
    .prepare(
      `SELECT id, quantity FROM task_services
       WHERE task_id = ? AND service_id = ?
       ORDER BY sort_order ASC, id ASC
       LIMIT 1`
    )
    .get(current.id, Number(input.service_id));
  if (existing) {
    bumpLineQuantity(db, 'task_services', existing.id, existing.quantity);
    touchTask(db, current.id);
    return getTask(db, current.id);
  }
  const line = normalizeTaskServiceLine(db, input, nextSortOrder(db, 'task_services', current.id));
  db.prepare(
    `INSERT INTO task_services (
       task_id, service_id, notes, quantity, sort_order, cost_amount, cost_currency, price_uzs, price_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    current.id,
    line.service_id,
    line.notes,
    line.quantity,
    line.sort_order,
    line.cost_amount,
    line.cost_currency,
    line.price_uzs,
    line.price_usd
  );
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function deleteTaskService(db: Db, taskId?: any, lineId?: any) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const result = db.prepare('DELETE FROM task_services WHERE id = ? AND task_id = ?').run(id, current.id);
  if (!result.changes) throw new Error('NOT_FOUND');
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function updateTaskDevice(db: Db, taskId: any, lineId: any, input: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const row = db
    .prepare(
      `SELECT id, quantity, discount_type, discount_value, discount_currency
       FROM task_devices WHERE id = ? AND task_id = ?`
    )
    .get(id, current.id);
  if (!row) throw new Error('NOT_FOUND');
  const quantity = input.quantity !== undefined ? normalizeQuantity(input.quantity) : row.quantity || 1;
  (require('./task-device-serials') as typeof import('./task-device-serials')).syncSerialsForLine(db, current.id, id, quantity);
  const discount =
    input.discount_type !== undefined || input.type !== undefined || input.clear
      ? input.clear
        ? emptyDiscount()
        : normalizeDiscountInput(input)
      : {
          discount_type: row.discount_type || null,
          discount_value: Number(row.discount_value) || 0,
          discount_currency: row.discount_currency || null,
        };
  db.prepare(
    `UPDATE task_devices
     SET quantity = ?, discount_type = ?, discount_value = ?, discount_currency = ?
     WHERE id = ? AND task_id = ?`
  ).run(quantity, discount.discount_type, discount.discount_value, discount.discount_currency, id, current.id);
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function updateTaskService(db: Db, taskId: any, lineId: any, input: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const id = Number(lineId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('NOT_FOUND');
  const row = db
    .prepare(
      `SELECT id, quantity, discount_type, discount_value, discount_currency
       FROM task_services WHERE id = ? AND task_id = ?`
    )
    .get(id, current.id);
  if (!row) throw new Error('NOT_FOUND');
  const quantity = input.quantity !== undefined ? normalizeQuantity(input.quantity) : row.quantity || 1;
  const discount =
    input.discount_type !== undefined || input.type !== undefined || input.clear
      ? input.clear
        ? emptyDiscount()
        : normalizeDiscountInput(input)
      : {
          discount_type: row.discount_type || null,
          discount_value: Number(row.discount_value) || 0,
          discount_currency: row.discount_currency || null,
        };
  db.prepare(
    `UPDATE task_services
     SET quantity = ?, discount_type = ?, discount_value = ?, discount_currency = ?
     WHERE id = ? AND task_id = ?`
  ).run(quantity, discount.discount_type, discount.discount_value, discount.discount_currency, id, current.id);
  touchTask(db, current.id);
  return getTask(db, current.id);
}

function writeLineDiscount(db: Db, kind?: any, taskId?: any, lineId?: any, discount?: any) {
  const table = kind === 'service' ? 'task_services' : kind === 'device' ? 'task_devices' : null;
  if (!table) throw new Error('INVALID_TABLE');
  const result = db
    .prepare(
      `UPDATE ${table}
       SET discount_type = ?, discount_value = ?, discount_currency = ?
       WHERE id = ? AND task_id = ?`
    )
    .run(discount.discount_type, discount.discount_value, discount.discount_currency, lineId, taskId);
  if (!result.changes) throw new Error('NOT_FOUND');
}

function cartLines(task?: any) {
  return [
    ...(task.devices || []).map((line?: any) => ({ kind: 'device', ...line })),
    ...(task.services || []).map((line?: any) => ({ kind: 'service', ...line })),
  ];
}

function resolveDiscountTargets(task: any, input: any = {}) {
  const all = cartLines(task);
  const scope = String(input.scope || '').trim();
  if (scope === 'all' || input.all === true) return all;
  const requested = Array.isArray(input.lines) ? input.lines : [];
  if (!requested.length) throw new Error('INVALID_TASK_DISCOUNT_TARGET');
  const byKey: Map<any, any> = new Map(all.map((line?: any) => [`${line.kind}:${line.id}`, line]));
  const targets: any[] = [];
  for (const item of requested) {
    const kind = item?.kind === 'service' ? 'service' : item?.kind === 'device' ? 'device' : null;
    const id = Number(item?.id);
    if (!kind || !Number.isFinite(id) || id <= 0) throw new Error('INVALID_TASK_DISCOUNT_TARGET');
    const line = byKey.get(`${kind}:${id}`);
    if (!line) throw new Error('INVALID_TASK_DISCOUNT_TARGET');
    targets.push(line);
  }
  return targets;
}

function distributeAmountDiscount(lines?: any, discount?: any) {
  const currency = discount.discount_currency === 'USD' ? 'USD' : 'UZS';
  const key = currency === 'USD' ? 'price_without_discount_usd' : 'price_without_discount_uzs';
  const total = lines.reduce((sum?: any, line?: any) => sum + (Number(line[key]) || 0), 0);
  if (total <= 0 || !discount.discount_value) {
    return lines.map((line?: any) => ({ line, discount: emptyDiscount() }));
  }
  let remaining = discount.discount_value;
  return lines.map((line?: any, index?: any) => {
    const share = (Number(line[key]) || 0) / total;
    const value =
      index === lines.length - 1 ? roundMoneySafe(remaining) : roundMoneySafe(discount.discount_value * share);
    remaining = roundMoneySafe(remaining - value);
    return {
      line,
      discount: {
        discount_type: 'amount',
        discount_value: value,
        discount_currency: currency,
      },
    };
  });
}

function roundMoneySafe(value?: any) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

function applyTaskDiscount(db: Db, taskId: any, input: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, taskId);
  if (!current) throw new Error('NOT_FOUND');
  assertTaskCartEditable(current);
  const targets = resolveDiscountTargets(current, input);
  if (!targets.length) throw new Error('INVALID_TASK_DISCOUNT_TARGET');
  const clear = input.clear === true || input.discount_type === 'none' || input.type === 'none';
  const discount = clear ? emptyDiscount() : normalizeDiscountInput(input, { allowEmpty: false });
  const updates =
    !clear && discount.discount_type === 'amount' && targets.length > 1
      ? distributeAmountDiscount(targets, discount)
      : targets.map((line?: any) => ({ line, discount }));
  db.exec('BEGIN');
  try {
    for (const item of updates) {
      writeLineDiscount(db, item.line.kind, current.id, item.line.id, item.discount);
    }
    touchTask(db, current.id);
    db.exec('COMMIT');
  } catch (error: any) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getTask(db, current.id);
}

function deleteTask(db: Db, id?: any) {
  const current = getTask(db, id);
  if (!current) return false;
  assertTaskCartEditable(current);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM task_services WHERE task_id = ?').run(current.id);
    db.prepare('DELETE FROM task_devices WHERE task_id = ?').run(current.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(current.id);
    db.exec('COMMIT');
    return true;
  } catch (error: any) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export {
  createTask,
  updateTask,
  addTaskDevice,
  updateTaskDevice,
  deleteTaskDevice,
  addTaskService,
  updateTaskService,
  deleteTaskService,
  applyTaskDiscount,
  deleteTask,
};
