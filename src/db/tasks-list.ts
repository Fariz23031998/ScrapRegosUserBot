import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getUsdUzsRate, sumMoneyTotals } from './money';
import { appendLocationAccessFilter, canViewerAccessLocation } from './locations';
import { ensureTaskTables } from './tasks-schema';
import { resolveListOrderBy, staffNameSql } from './list-sort';
import { TASK_SELECT, TASK_FROM, listTaskDevicesForIds, listTaskServicesForIds, mapTask, getTask } from './tasks-read';
import {
  TASK_STATUSES,
  countTaskRefunds,
  nextTaskStatus,
  shouldAssignTechnicianOnStatus,
  resolveEmployeeId,
  staffAllowedOnLocation,
  sameStaffId,
} from './tasks-normalize';

const TASK_SORT_COLUMNS: Record<string, string> = {
  id: 't.id',
  title: 't.title COLLATE NOCASE',
  category: 'c.name COLLATE NOCASE',
  location: 'loc.name COLLATE NOCASE',
  client: 't.client_name COLLATE NOCASE',
  manager: staffNameSql('manager'),
  technician: staffNameSql('tech'),
  status: 't.status COLLATE NOCASE',
  action: 't.action COLLATE NOCASE',
  planned_start_at: 'datetime(t.planned_start_at)',
  planned_finish_at: 'datetime(t.planned_finish_at)',
  updated_at: 'datetime(t.updated_at)',
};

function listTasks(db: Db, { query, status, categoryId, locationId, viewer, limit = 25, offset = 0, sort }: Unchecked = {}) {
  ensureTaskTables(db);
  const rate = getUsdUzsRate(db);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const where: any[] = [];
  const params: any[] = [];
  const trimmed = String(query || '').trim();
  if (trimmed) {
    const like = `%${trimmed}%`;
    where.push(`(
      t.title LIKE ?
      OR IFNULL(t.client_name, '') LIKE ?
      OR IFNULL(t.client_phone, '') LIKE ?
      OR IFNULL(t.address, '') LIKE ?
      OR IFNULL(t.notes, '') LIKE ?
      OR IFNULL(c.name, '') LIKE ?
      OR IFNULL(loc.name, '') LIKE ?
      OR EXISTS (
        SELECT 1 FROM task_devices td
        LEFT JOIN devices d ON d.id = td.device_id
        WHERE td.task_id = t.id AND IFNULL(d.name, '') LIKE ?
      )
      OR EXISTS (
        SELECT 1 FROM task_services ts
        LEFT JOIN services s ON s.id = ts.service_id
        WHERE ts.task_id = t.id AND IFNULL(s.name, '') LIKE ?
      )
    )`);
    params.push(like, like, like, like, like, like, like, like, like);
  }
  if (status) {
    if (!TASK_STATUSES.includes(status)) throw new Error('INVALID_TASK_STATUS');
    where.push('t.status = ?');
    params.push(status);
  }
  if (categoryId != null && categoryId !== '' && categoryId !== 'all') {
    const parsed = Number(categoryId);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_CATEGORY');
    where.push('t.category_id = ?');
    params.push(parsed);
  }
  if (locationId != null && locationId !== '' && locationId !== 'all') {
    const parsed = Number(locationId);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_LOCATION');
    if (!canViewerAccessLocation(db, parsed, viewer)) throw new Error('INVALID_TASK_LOCATION');
    where.push('t.location_id = ?');
    params.push(parsed);
  }
  appendLocationAccessFilter(where, params, viewer);
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${TASK_FROM}${whereSql}`).get(...params) as { count: number } | undefined)!.count;
  const rows = db
    .prepare(
      `SELECT ${TASK_SELECT}
       FROM ${TASK_FROM}${whereSql}
       ${resolveListOrderBy(sort, TASK_SORT_COLUMNS, 't.id') || 'ORDER BY datetime(t.updated_at) DESC, t.id DESC'}
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset);
  const ids = rows.map((row?: any) => row.id);
  const devicesByTask = listTaskDevicesForIds(db, ids, rate);
  const servicesByTask = listTaskServicesForIds(db, ids, rate);
  return {
    tasks: rows.map((row?: any) => {
      const devices = devicesByTask.get(row.id) || [];
      const services = servicesByTask.get(row.id) || [];
      return mapTask(row, devices, services, sumMoneyTotals([...devices, ...services], rate));
    }),
    total,
  };
}

function postTask(db: Db, id?: any, viewer?: any) {
  ensureTaskTables(db);
  const current = getTask(db, id, viewer);
  if (!current) throw new Error('NOT_FOUND');
  if (current.posted) return current;
  db.prepare(`UPDATE tasks SET posted = 1, updated_at = datetime('now') WHERE id = ?`).run(current.id);
  return getTask(db, current.id, viewer);
}

function unpostTask(db: Db, id: any, viewer: any, options: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, id, viewer);
  if (!current) throw new Error('NOT_FOUND');
  if (!current.posted) return current;
  const refundCount = countTaskRefunds(db, current.id);
  if (refundCount > 0 && !options.deleteRefunds) throw new Error('TASK_HAS_REFUNDS');
  const deviceReturns = (require('./task-device-returns') as typeof import('./task-device-returns'));
  const returnCount = deviceReturns.countTaskDeviceReturns(db, current.id);
  if (returnCount > 0 && !options.deleteReturns) throw new Error('TASK_HAS_DEVICE_RETURNS');
  db.exec('BEGIN');
  try {
    if (refundCount > 0) (require('./task-refunds') as typeof import('./task-refunds')).deleteTaskRefunds(db, current.id);
    if (returnCount > 0) deviceReturns.deleteTaskDeviceReturns(db, current.id);
    db.prepare(`UPDATE tasks SET posted = 0, updated_at = datetime('now') WHERE id = ?`).run(current.id);
    db.exec('COMMIT');
  } catch (error: any) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getTask(db, current.id, viewer);
}

function advanceTaskStatus(db: Db, id: any, viewer: any, options: any = {}) {
  ensureTaskTables(db);
  const current = getTask(db, id, viewer);
  if (!current) throw new Error('NOT_FOUND');
  const next = nextTaskStatus(current.status);
  if (!next) throw new Error('INVALID_TASK_STATUS_TRANSITION');
  let technicianUserId = shouldAssignTechnicianOnStatus(current.action, next)
    ? resolveEmployeeId(db, options.actorUserId)
    : null;
  if (technicianUserId && !staffAllowedOnLocation(db, current.location_id, technicianUserId)) {
    technicianUserId = null;
  }
  if (technicianUserId) {
    const reminderSentAt = sameStaffId(current.technician_user_id, technicianUserId)
      ? current.technician_reminder_sent_at || null
      : null;
    db.prepare(
      `UPDATE tasks
       SET status = ?, technician_user_id = ?, technician_reminder_sent_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(next, technicianUserId, reminderSentAt, current.id);
  } else {
    db.prepare(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(next, current.id);
  }
  return getTask(db, current.id, viewer);
}

export { listTasks, postTask, unpostTask, advanceTaskStatus };
