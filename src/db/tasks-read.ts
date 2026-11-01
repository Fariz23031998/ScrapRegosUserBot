import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { attachCatalogImages } from './catalog-images';
import { presentTaskLineMoney, emptyLineMoneySnapshot, emptyDiscount, sumMoneyTotals, emptyMoneyTotals, getUsdUzsRate } from './money';
import { emptyTaskPaymentTotals, listTaskPayments, summarizeTaskPayments } from './task-payments';
import { canViewerAccessLocation } from './locations';
import { ensureTaskTables, tableExists } from './tasks-schema';
import { TASK_ACTION_LABELS, TASK_STATUS_LABELS } from './tasks-normalize';

const TASK_SELECT = `
  t.id, t.title, t.status, t.posted, t.action, t.notes, t.address, t.distance_km, t.distance_score,
  t.category_id, t.location_id,
  t.regos_client_id, t.client_name, t.client_phone,
  t.manager_user_id, t.technician_user_id, t.currency,
  t.planned_start_at, t.planned_finish_at, t.technician_reminder_sent_at,
  t.created_at, t.updated_at,
  c.name AS category_name,
  loc.name AS location_name,
  manager.display_name AS manager_display_name,
  manager.first_name AS manager_first_name,
  manager.last_name AS manager_last_name,
  manager.admin_login AS manager_admin_login,
  manager.username AS manager_username,
  tech.display_name AS technician_display_name,
  tech.first_name AS technician_first_name,
  tech.last_name AS technician_last_name,
  tech.admin_login AS technician_admin_login,
  tech.username AS technician_username
`;

const TASK_FROM = `
  tasks t
  LEFT JOIN task_categories c ON c.id = t.category_id
  LEFT JOIN locations loc ON loc.id = t.location_id
  LEFT JOIN bot_users manager ON manager.id = t.manager_user_id
  LEFT JOIN bot_users tech ON tech.id = t.technician_user_id
`;

function employeeLabel(row?: any, prefix?: any) {
  const displayName = row[`${prefix}_display_name`];
  const firstName = row[`${prefix}_first_name`];
  const lastName = row[`${prefix}_last_name`];
  const adminLogin = row[`${prefix}_admin_login`];
  const username = row[`${prefix}_username`];
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  return displayName || fullName || adminLogin || (username ? `@${username}` : null);
}

function mapEmployeeSummary(id?: any, name?: any) {
  if (id == null) return null;
  return { id, name: name || `Сотрудник #${id}` };
}

function mapTaskDevice(row: any, rate: any, { returnedQuantity = 0 }: Unchecked = {}) {
  if (!row) return null;
  const quantity = Number(row.quantity) > 0 ? Number(row.quantity) : 1;
  const returned = Math.max(0, Number(returnedQuantity) || 0);
  const repair = (row.task_action || row.action) === 'repair';
  const moneyRow = repair
    ? { ...row, ...emptyLineMoneySnapshot(), ...emptyDiscount() }
    : row;
  return {
    id: row.id,
    task_id: row.task_id,
    device_id: row.device_id,
    device_name: row.device_name || '',
    description: row.device_description || '',
    action: row.action,
    action_label: TASK_ACTION_LABELS[row.action as keyof typeof TASK_ACTION_LABELS] || row.action,
    notes: row.notes || '',
    quantity,
    returned_quantity: returned,
    remaining_return_quantity: Math.max(0, quantity - returned),
    sort_order: row.sort_order ?? 0,
    ...presentTaskLineMoney(moneyRow, rate),
  };
}

function mapTaskService(row?: any, rate?: any) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    service_id: row.service_id,
    service_name: row.service_name || '',
    description: row.service_description || '',
    notes: row.notes || '',
    quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
    sort_order: row.sort_order ?? 0,
    ...presentTaskLineMoney(row, rate),
  };
}

function mapTask(row: any, devices: any = [], services: any = [], totals: any = null, payments: any = null, paymentTotals: any = null, refunds: any = null) {
  if (!row) return null;
  const managerName = employeeLabel(row, 'manager');
  const technicianName = employeeLabel(row, 'technician');
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    status_label: TASK_STATUS_LABELS[row.status as keyof typeof TASK_STATUS_LABELS] || row.status,
    posted: Boolean(row.posted),
    action: row.action || 'install',
    action_label: TASK_ACTION_LABELS[row.action as keyof typeof TASK_ACTION_LABELS] || TASK_ACTION_LABELS.install,
    notes: row.notes || '',
    address: row.address || '',
    distance_km: row.distance_km == null || row.distance_km === '' ? null : Number(row.distance_km),
    distance_score: row.distance_score == null || row.distance_score === '' ? null : Number(row.distance_score),
    category_id: row.category_id ?? null,
    category: row.category_id
      ? { id: row.category_id, name: row.category_name || '' }
      : null,
    location_id: row.location_id ?? null,
    location: row.location_id
      ? { id: row.location_id, name: row.location_name || '' }
      : null,
    regos_client_id: row.regos_client_id ?? null,
    client_name: row.client_name || '',
    client_phone: row.client_phone || '',
    manager_user_id: row.manager_user_id ?? null,
    manager: mapEmployeeSummary(row.manager_user_id, managerName),
    technician_user_id: row.technician_user_id ?? null,
    technician: mapEmployeeSummary(row.technician_user_id, technicianName),
    currency: row.currency === 'USD' ? 'USD' : row.currency === 'UZS' ? 'UZS' : null,
    planned_start_at: row.planned_start_at || null,
    planned_finish_at: row.planned_finish_at || null,
    technician_reminder_sent_at: row.technician_reminder_sent_at || null,
    devices,
    services,
    totals: totals || emptyMoneyTotals(),
    payments: payments || [],
    payment_totals: paymentTotals || emptyTaskPaymentTotals(),
    refunds: refunds || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listTaskDevicesForIds(db: Db, taskIds?: any, rate?: any) {
  const map: Map<any, any> = new Map();
  if (!taskIds.length) return map;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT td.id, td.task_id, td.device_id, td.action, td.notes, td.quantity, td.sort_order,
              td.cost_amount, td.cost_currency, td.price_uzs, td.price_usd,
              td.discount_type, td.discount_value, td.discount_currency,
              t.action AS task_action,
              d.name AS device_name,
              d.description AS device_description
       FROM task_devices td
       LEFT JOIN tasks t ON t.id = td.task_id
       LEFT JOIN devices d ON d.id = td.device_id
       WHERE td.task_id IN (${placeholders})
       ORDER BY td.sort_order ASC, td.id ASC`
    )
    .all(...taskIds);
  const returnedByLine = (require('./task-device-returns') as typeof import('./task-device-returns')).returnedQuantitiesByLineIds(
    db,
    rows.map((row?: any) => row.id)
  );
  for (const row of rows) {
    const list = map.get(row.task_id) || [];
    list.push(mapTaskDevice(row, rate, { returnedQuantity: returnedByLine.get(row.id) || 0 }));
    map.set(row.task_id, list);
  }
  const allLines = [...map.values()].flat();
  attachCatalogImages(db, allLines, 'device', 'device_id');
  (require('./task-device-serials') as typeof import('./task-device-serials')).attachSerials(db, allLines);
  return map;
}

function listTaskServicesForIds(db: Db, taskIds?: any, rate?: any) {
  const map: Map<any, any> = new Map();
  if (!taskIds.length || !tableExists(db, 'task_services')) return map;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ts.id, ts.task_id, ts.service_id, ts.notes, ts.quantity, ts.sort_order,
              ts.cost_amount, ts.cost_currency, ts.price_uzs, ts.price_usd,
              ts.discount_type, ts.discount_value, ts.discount_currency,
              s.name AS service_name,
              s.description AS service_description
       FROM task_services ts
       LEFT JOIN services s ON s.id = ts.service_id
       WHERE ts.task_id IN (${placeholders})
       ORDER BY ts.sort_order ASC, ts.id ASC`
    )
    .all(...taskIds);
  for (const row of rows) {
    const list = map.get(row.task_id) || [];
    list.push(mapTaskService(row, rate));
    map.set(row.task_id, list);
  }
  const allLines = [...map.values()].flat();
  attachCatalogImages(db, allLines, 'service', 'service_id');
  return map;
}

function getTaskRow(db: Db, id?: any) {
  const taskId = Number(id);
  if (!Number.isFinite(taskId) || taskId <= 0) return null;
  return db.prepare(`SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ?`).get(taskId) || null;
}

function assembleTask(db: Db, row?: any) {
  const rate = getUsdUzsRate(db);
  const devices = listTaskDevicesForIds(db, [row.id], rate).get(row.id) || [];
  (require('./task-device-serials') as typeof import('./task-device-serials')).ensureSerialsForDevices(db, row.id, devices);
  (require('./task-device-serials') as typeof import('./task-device-serials')).attachSerials(db, devices);
  const services = listTaskServicesForIds(db, [row.id], rate).get(row.id) || [];
  const totals = sumMoneyTotals([...devices, ...services], rate);
  const allPayments = listTaskPayments(db, row.id);
  const payments = allPayments.filter((payment?: any) => payment.kind !== 'refund');
  const refunds = (require('./task-refunds') as typeof import('./task-refunds')).listTaskRefunds(db, row.id, allPayments);
  return mapTask(row, devices, services, totals, payments, summarizeTaskPayments(payments, totals), refunds);
}

function getTask(db: Db, id?: any, viewer?: any) {
  ensureTaskTables(db);
  const row = getTaskRow(db, id);
  if (!row) return null;
  if (!canViewerAccessLocation(db, row.location_id, viewer)) return null;
  return assembleTask(db, row);
}

function touchTask(db: Db, taskId?: any) {
  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(taskId);
}

export {
  TASK_SELECT,
  TASK_FROM,
  mapTask,
  listTaskDevicesForIds,
  listTaskServicesForIds,
  getTask,
  touchTask,
};
