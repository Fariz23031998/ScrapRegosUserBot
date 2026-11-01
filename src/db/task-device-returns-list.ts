import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { appendLocationAccessFilter, canViewerAccessLocation } from './locations';
import { ensureTaskTables } from './tasks';
import { listSerialsForLine, listSerialsForReturn } from './task-device-serials';
import { ensureTaskDeviceReturnTables } from './task-device-returns';
import { resolveListOrderBy, staffNameSql } from './list-sort';

function lineQuantity(value?: any) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.trunc(qty);
}

function authorLabel(row?: any) {
  const fullName = [row.created_by_first_name, row.created_by_last_name].filter(Boolean).join(' ').trim();
  return (
    row.created_by_display_name ||
    fullName ||
    row.created_by_admin_login ||
    (row.created_by_username ? `@${row.created_by_username}` : null)
  );
}

function mapCreatedBy(row?: any) {
  if (row.created_by_user_id == null) return null;
  return {
    id: row.created_by_user_id,
    name: authorLabel(row) || `Сотрудник #${row.created_by_user_id}`,
  };
}

function mapTaskSummary(row?: any) {
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

function appendSearch(where?: any, params?: any, query?: any) {
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

function appendLocationFilter(where?: any, params?: any, locationId?: any) {
  if (locationId == null || locationId === '' || locationId === 'all') return;
  const parsed = Number(locationId);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_TASK_LOCATION');
  where.push('t.location_id = ?');
  params.push(parsed);
}

function mapPendingItem(db: Db, row?: any) {
  const quantity = lineQuantity(row.quantity);
  const returnedQuantity = Number(row.returned_quantity) || 0;
  const serials = listSerialsForLine(db, row.device_line_id).filter((serial?: any) => !serial.returned_at);
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

function mapReturnedItem(db: Db, row?: any) {
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
  db: Db,
  { query, status = 'pending', locationId, viewer, limit = 25, offset = 0, sort }: Unchecked = {}
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
    const params: any[] = [];
    appendSearch(where, params, query);
    appendLocationFilter(where, params, locationId);
    appendLocationAccessFilter(where, params, viewer);
    const whereSql = ` WHERE ${where.join(' AND ')}`;
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${RETURNED_FROM}${whereSql}`)
        .get(...params) as { count: number } | undefined
    )!.count;
    const returnedOrder =
      resolveListOrderBy(
        sort,
        {
          id: 'r.id',
          device: 'd.name COLLATE NOCASE',
          quantity: 'r.quantity',
          task: 't.title COLLATE NOCASE',
          client: 't.client_name COLLATE NOCASE',
          location: 'loc.name COLLATE NOCASE',
          technician: staffNameSql('tech'),
          date: 'datetime(r.created_at)',
          author: staffNameSql('u'),
        },
        'r.id',
      ) || 'ORDER BY datetime(r.created_at) DESC, r.id DESC';
    const rows = db
      .prepare(
        `SELECT ${RETURNED_SELECT}
         FROM ${RETURNED_FROM}${whereSql}
         ${returnedOrder}
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, safeOffset);
    return { items: rows.map((row?: any) => mapReturnedItem(db, row)), total };
  }

  const where = eligibleTaskWhere();
  const params: any[] = [];
  appendSearch(where, params, query);
    appendLocationFilter(where, params, locationId);
  appendLocationAccessFilter(where, params, viewer);
  if (kind === 'pending') {
    where.push('(td.quantity - IFNULL(ret.returned_qty, 0)) > 0');
  } else {
    where.push('(td.quantity - IFNULL(ret.returned_qty, 0) > 0 OR IFNULL(ret.returned_qty, 0) > 0)');
  }
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${LIST_FROM}${whereSql}`).get(...params) as { count: number } | undefined)!.count;
  const pendingOrder =
    resolveListOrderBy(
      sort,
      {
        id: 'td.id',
        device: 'd.name COLLATE NOCASE',
        quantity: '(td.quantity - IFNULL(ret.returned_qty, 0))',
        task: 't.title COLLATE NOCASE',
        client: 't.client_name COLLATE NOCASE',
        location: 'loc.name COLLATE NOCASE',
        technician: staffNameSql('tech'),
        date: 'datetime(t.updated_at)',
      },
      'td.id',
    ) || 'ORDER BY datetime(t.updated_at) DESC, td.id DESC';
  const rows = db
    .prepare(
      `SELECT ${LIST_SELECT}
       FROM ${LIST_FROM}${whereSql}
       ${pendingOrder}
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset);
  return { items: rows.map((row?: any) => mapPendingItem(db, row)), total };
}

function loadReturnedItem(db: Db, returnId?: any) {
  const row = db
    .prepare(
      `SELECT ${RETURNED_SELECT}
       FROM ${RETURNED_FROM}
       WHERE r.id = ?`
    )
    .get(returnId);
  return row ? mapReturnedItem(db, row) : null;
}

export { lineQuantity, listRepairDeviceReturns, loadReturnedItem };
