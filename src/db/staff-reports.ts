import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getBotUserById, findBotUserByRegosUserId } from './bot-users-db';
import { appendLocationAccessFilter, appendLocationChoiceFilter } from './locations';
import { computeLineMoney, getUsdUzsRate, roundMoney } from './money';
import { ensureTaskTables } from './tasks';

const SQLITE_IN_CHUNK = 400;

function employeeLabel(user?: any) {
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

function unixSecondsToSqliteUtc(unix?: any) {
  if (unix == null || unix === '') return null;
  const n = Number(unix);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function roundStaffMoney(value?: any) {
  return roundMoney(value);
}

function staffQuantity(line?: any) {
  const qty = Number(line?.quantity);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return qty;
}

function queryInChunks(db: Db, sqlForPlaceholders: any, ids: any, extraParams: any = []) {
  const rows: any[] = [];
  if (!ids.length) return rows;
  for (let offset = 0; offset < ids.length; offset += SQLITE_IN_CHUNK) {
    const chunk = ids.slice(offset, offset + SQLITE_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(...db.prepare(sqlForPlaceholders(placeholders)).all(...chunk, ...extraParams));
  }
  return rows;
}

function tableExists(db: Db, name?: any) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function loadPostedTasks(db: Db, { from = null, to = null, viewer = null, locationId = null }: Unchecked = {}) {
  ensureTaskTables(db);
  const where = [`t.status = 'done'`, `IFNULL(t.posted, 0) = 1`];
  const params: any[] = [];
  if (from) {
    where.push(`datetime(t.created_at) >= datetime(?)`);
    params.push(from);
  }
  if (to) {
    where.push(`datetime(t.created_at) <= datetime(?)`);
    params.push(to);
  }
  appendLocationAccessFilter(where, params, viewer);
  appendLocationChoiceFilter(where, params, locationId, 't');

  return db
    .prepare(
      `SELECT t.id, t.manager_user_id, t.technician_user_id, t.location_id, t.action, t.distance_score
       FROM tasks t
       WHERE ${where.join(' AND ')}`
    )
    .all(...params);
}

function listReportDeviceLines(db: Db, taskIds?: any) {
  return queryInChunks(
    db,
    (placeholders?: any) => `
      SELECT td.task_id, td.quantity, td.cost_amount, td.cost_currency, td.price_uzs, td.price_usd,
             td.discount_type, td.discount_value, td.discount_currency,
             IFNULL(d.manager_sale_percent, 0) AS manager_sale_percent,
             IFNULL(d.technician_score, 0) AS technician_score,
             'device' AS line_kind
      FROM task_devices td
      LEFT JOIN devices d ON d.id = td.device_id
      WHERE td.task_id IN (${placeholders})
    `,
    taskIds
  );
}

function listReportServiceLines(db: Db, taskIds?: any) {
  if (!tableExists(db, 'task_services')) return [];
  return queryInChunks(
    db,
    (placeholders?: any) => `
      SELECT ts.task_id, ts.quantity, ts.cost_amount, ts.cost_currency, ts.price_uzs, ts.price_usd,
             ts.discount_type, ts.discount_value, ts.discount_currency,
             IFNULL(s.manager_sale_percent, 0) AS manager_sale_percent,
             IFNULL(s.technician_score, 0) AS technician_score,
             'service' AS line_kind
      FROM task_services ts
      LEFT JOIN services s ON s.id = ts.service_id
      WHERE ts.task_id IN (${placeholders})
    `,
    taskIds
  );
}

function listPostedTaskLines(db: Db, taskIds?: any) {
  return [...listReportDeviceLines(db, taskIds), ...listReportServiceLines(db, taskIds)];
}

function loadPostedTaskReportContext(db: Db, { fromUnix = null, toUnix = null, viewer = null, locationId = null }: Unchecked = {}) {
  const from = unixSecondsToSqliteUtc(fromUnix);
  const to = unixSecondsToSqliteUtc(toUnix);
  const tasks = loadPostedTasks(db, { from, to, viewer, locationId });
  const lines = listPostedTaskLines(
    db,
    tasks.map((task?: any) => task.id)
  );
  return {
    from,
    to,
    rate: getUsdUzsRate(db),
    tasks,
    lines,
    taskById: new Map(tasks.map((task?: any) => [task.id, task])),
  };
}

function namedEmployeeRow(db: Db, userId?: any, fallbackName?: any) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const user = getBotUserById(db, id);
  return {
    user_id: id,
    name: employeeLabel(user) || fallbackName || `Сотрудник #${id}`,
  };
}

function employeeNamer(db: Db) {
  const cache: Map<any, any> = new Map();
  return (userId?: any, fallbackName?: any) => {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (!cache.has(id)) cache.set(id, namedEmployeeRow(db, id, fallbackName));
    return cache.get(id);
  };
}

function emptyTechnicianRow(userId?: any, name?: any) {
  return {
    user_id: userId,
    name: name || `Сотрудник #${userId}`,
    technician_task_count: 0,
    technician_task_score: 0,
    distance_score: 0,
    ticket_count: 0,
    call_duration_seconds: 0,
  };
}

function emptyCommissionRow(userId?: any, name?: any) {
  return {
    user_id: userId,
    name: name || `Сотрудник #${userId}`,
    manager_task_count: 0,
    commission_uzs: 0,
    commission_usd: 0,
  };
}

function ensureMapRow(byUser?: any, userId?: any, factory?: any) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (!byUser.has(id)) byUser.set(id, factory(id));
  return byUser.get(id);
}

function isRepairDeviceLine(task?: any, line?: any) {
  return task?.action === 'repair' && line?.line_kind === 'device';
}

function addLineCommission(row?: any, line?: any, rate?: any) {
  const percent = Number(line.manager_sale_percent) || 0;
  if (percent <= 0) return;
  const money = computeLineMoney(line, rate);
  row.commission_uzs = roundStaffMoney(row.commission_uzs + (money.price_uzs * percent) / 100);
  row.commission_usd = roundStaffMoney(row.commission_usd + (money.price_usd * percent) / 100);
}

function addLineTechnicianScore(row?: any, line?: any) {
  const score = Number(line.technician_score) || 0;
  if (score <= 0) return;
  row.technician_task_score = roundStaffMoney(row.technician_task_score + score * staffQuantity(line));
}

function presentTechnicianRow(row?: any) {
  return {
    user_id: row.user_id,
    name: row.name,
    technician_task_count: Number(row.technician_task_count) || 0,
    technician_task_score: roundStaffMoney(row.technician_task_score),
    distance_score: roundStaffMoney(row.distance_score),
    ticket_count: Number(row.ticket_count) || 0,
    call_duration_seconds: Number(row.call_duration_seconds) || 0,
  };
}

function presentCommissionRow(row?: any) {
  return {
    user_id: row.user_id,
    name: row.name,
    manager_task_count: Number(row.manager_task_count) || 0,
    commission_uzs: roundStaffMoney(row.commission_uzs),
    commission_usd: roundStaffMoney(row.commission_usd),
  };
}

function isTechnicianRowEmpty(row?: any) {
  return (
    !row ||
    (Number(row.technician_task_count) === 0 &&
      Number(row.ticket_count) === 0 &&
      Number(row.technician_task_score) === 0 &&
      Number(row.distance_score) === 0 &&
      Number(row.call_duration_seconds) === 0)
  );
}

function isCommissionRowEmpty(row?: any) {
  return (
    !row ||
    (Number(row.manager_task_count) === 0 &&
      Number(row.commission_uzs) === 0 &&
      Number(row.commission_usd) === 0)
  );
}

function emptyTechnicianTotals() {
  return {
    technician_task_count: 0,
    technician_task_score: 0,
    distance_score: 0,
    ticket_count: 0,
    call_duration_seconds: 0,
  };
}

function emptyCommissionTotals() {
  return {
    manager_task_count: 0,
    commission_uzs: 0,
    commission_usd: 0,
  };
}

function sumTechnicianTotals(rows?: any) {
  const totals = emptyTechnicianTotals();
  for (const row of rows) {
    totals.technician_task_count += Number(row.technician_task_count) || 0;
    totals.technician_task_score = roundStaffMoney(
      totals.technician_task_score + (Number(row.technician_task_score) || 0)
    );
    totals.distance_score = roundStaffMoney(
      totals.distance_score + (Number(row.distance_score) || 0)
    );
    totals.ticket_count += Number(row.ticket_count) || 0;
    totals.call_duration_seconds += Number(row.call_duration_seconds) || 0;
  }
  return totals;
}

function sumCommissionTotals(rows?: any) {
  const totals = emptyCommissionTotals();
  for (const row of rows) {
    totals.manager_task_count += Number(row.manager_task_count) || 0;
    totals.commission_uzs = roundStaffMoney(totals.commission_uzs + (Number(row.commission_uzs) || 0));
    totals.commission_usd = roundStaffMoney(totals.commission_usd + (Number(row.commission_usd) || 0));
  }
  return totals;
}

function sortNamedRows(rows?: any) {
  return rows.sort((a?: any, b?: any) => a.name.localeCompare(b.name, 'ru'));
}

function buildTechnicianReport(
  db: Db,
  {
    fromUnix = null,
    toUnix = null,
    viewer = null,
    ticketsByRegosUserId = new Map(),
    durationByRegosUserId = new Map(),
    unassignedTicketCount = 0,
    unassignedCallDurationSeconds = 0,
  }: Unchecked = {}
) {
  const { tasks, lines, taskById } = loadPostedTaskReportContext(db, {
    fromUnix,
    toUnix,
    viewer,
  });
  const byUser: Map<any, any> = new Map();
  const nameOf = employeeNamer(db);

  for (const task of tasks) {
    if (task.technician_user_id == null) continue;
    const named = nameOf(task.technician_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id?: any) => emptyTechnicianRow(id, named.name));
    if (row) {
      row.technician_task_count += 1;
      const distanceScore = Number(task.distance_score) || 0;
      if (distanceScore > 0) {
        row.distance_score = roundStaffMoney(row.distance_score + distanceScore);
      }
    }
  }

  for (const line of lines) {
    const task = taskById.get(line.task_id);
    if (!task || task.technician_user_id == null) continue;
    const named = nameOf(task.technician_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id?: any) => emptyTechnicianRow(id, named.name));
    if (row) addLineTechnicianScore(row, line);
  }

  let unmatchedTickets = Number(unassignedTicketCount) || 0;
  let unmatchedDuration = Number(unassignedCallDurationSeconds) || 0;
  const regosUserIds = new Set([
    ...ticketsByRegosUserId.keys(),
    ...durationByRegosUserId.keys(),
  ]);
  for (const regosUserId of regosUserIds) {
    const n = Number(ticketsByRegosUserId.get(regosUserId)) || 0;
    const duration = Number(durationByRegosUserId.get(regosUserId)) || 0;
    if (n <= 0 && duration <= 0) continue;
    const user = findBotUserByRegosUserId(db, regosUserId);
    if (!user) {
      unmatchedTickets += n;
      unmatchedDuration += duration;
      continue;
    }
    const named = nameOf(user.id, employeeLabel(user));
    if (!named) {
      unmatchedTickets += n;
      unmatchedDuration += duration;
      continue;
    }
    const row = ensureMapRow(byUser, named.user_id, (id?: any) => emptyTechnicianRow(id, named.name));
    if (!row) {
      unmatchedTickets += n;
      unmatchedDuration += duration;
      continue;
    }
    row.ticket_count += n;
    row.call_duration_seconds += duration;
    if (!row.name) row.name = named.name;
  }

  const rows = sortNamedRows(
    [...byUser.values()].map(presentTechnicianRow).filter((row?: any) => !isTechnicianRowEmpty(row))
  );

  return {
    rows,
    totals: sumTechnicianTotals(rows),
    unassigned_ticket_count: unmatchedTickets,
    unassigned_call_duration_seconds: unmatchedDuration,
  };
}

function buildCommissionReport(db: Db, { fromUnix = null, toUnix = null, viewer = null }: Unchecked = {}) {
  const { rate, tasks, lines, taskById } = loadPostedTaskReportContext(db, {
    fromUnix,
    toUnix,
    viewer,
  });
  const byUser: Map<any, any> = new Map();
  const nameOf = employeeNamer(db);

  for (const task of tasks) {
    if (task.manager_user_id == null) continue;
    const named = nameOf(task.manager_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id?: any) => emptyCommissionRow(id, named.name));
    if (row) row.manager_task_count += 1;
  }

  for (const line of lines) {
    const task = taskById.get(line.task_id);
    if (!task || task.manager_user_id == null) continue;
    const named = nameOf(task.manager_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id?: any) => emptyCommissionRow(id, named.name));
    if (row && !isRepairDeviceLine(task, line)) addLineCommission(row, line, rate);
  }

  const rows = sortNamedRows(
    [...byUser.values()].map(presentCommissionRow).filter((row?: any) => !isCommissionRowEmpty(row))
  );

  return {
    rows,
    totals: sumCommissionTotals(rows),
  };
}

export {
  unixSecondsToSqliteUtc,
  queryInChunks,
  tableExists,
  loadPostedTasks,
  listPostedTaskLines,
  loadPostedTaskReportContext,
  isRepairDeviceLine,
  buildTechnicianReport,
  buildCommissionReport,
};
