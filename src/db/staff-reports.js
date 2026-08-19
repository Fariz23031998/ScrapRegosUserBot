const { getBotUserById, findBotUserByRegosUserId } = require('./bot-users-db');
const { appendLocationAccessFilter } = require('./locations');
const { computeLineMoney, getUsdUzsRate, roundMoney } = require('./money');
const { ensureTaskTables } = require('./tasks');

const SQLITE_IN_CHUNK = 400;

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

function unixSecondsToSqliteUtc(unix) {
  if (unix == null || unix === '') return null;
  const n = Number(unix);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function roundStaffMoney(value) {
  return roundMoney(value);
}

function staffQuantity(line) {
  const qty = Number(line?.quantity);
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return qty;
}

function queryInChunks(db, sqlForPlaceholders, ids, extraParams = []) {
  const rows = [];
  if (!ids.length) return rows;
  for (let offset = 0; offset < ids.length; offset += SQLITE_IN_CHUNK) {
    const chunk = ids.slice(offset, offset + SQLITE_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(...db.prepare(sqlForPlaceholders(placeholders)).all(...chunk, ...extraParams));
  }
  return rows;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function loadPostedTasks(db, { from = null, to = null, viewer = null } = {}) {
  ensureTaskTables(db);
  const where = [`t.status = 'done'`, `IFNULL(t.posted, 0) = 1`];
  const params = [];
  if (from) {
    where.push(`datetime(t.created_at) >= datetime(?)`);
    params.push(from);
  }
  if (to) {
    where.push(`datetime(t.created_at) <= datetime(?)`);
    params.push(to);
  }
  appendLocationAccessFilter(where, params, viewer);

  return db
    .prepare(
      `SELECT t.id, t.manager_user_id, t.technician_user_id, t.location_id
       FROM tasks t
       WHERE ${where.join(' AND ')}`
    )
    .all(...params);
}

function listReportDeviceLines(db, taskIds) {
  return queryInChunks(
    db,
    (placeholders) => `
      SELECT td.task_id, td.quantity, td.cost_amount, td.cost_currency, td.price_uzs, td.price_usd,
             td.discount_type, td.discount_value, td.discount_currency,
             IFNULL(d.manager_sale_percent, 0) AS manager_sale_percent,
             IFNULL(d.technician_score, 0) AS technician_score
      FROM task_devices td
      LEFT JOIN devices d ON d.id = td.device_id
      WHERE td.task_id IN (${placeholders})
    `,
    taskIds
  );
}

function listReportServiceLines(db, taskIds) {
  if (!tableExists(db, 'task_services')) return [];
  return queryInChunks(
    db,
    (placeholders) => `
      SELECT ts.task_id, ts.quantity, ts.cost_amount, ts.cost_currency, ts.price_uzs, ts.price_usd,
             ts.discount_type, ts.discount_value, ts.discount_currency,
             IFNULL(s.manager_sale_percent, 0) AS manager_sale_percent,
             IFNULL(s.technician_score, 0) AS technician_score
      FROM task_services ts
      LEFT JOIN services s ON s.id = ts.service_id
      WHERE ts.task_id IN (${placeholders})
    `,
    taskIds
  );
}

function listPostedTaskLines(db, taskIds) {
  return [...listReportDeviceLines(db, taskIds), ...listReportServiceLines(db, taskIds)];
}

function loadPostedTaskReportContext(db, { fromUnix = null, toUnix = null, viewer = null } = {}) {
  const from = unixSecondsToSqliteUtc(fromUnix);
  const to = unixSecondsToSqliteUtc(toUnix);
  const tasks = loadPostedTasks(db, { from, to, viewer });
  const lines = listPostedTaskLines(
    db,
    tasks.map((task) => task.id)
  );
  return {
    from,
    to,
    rate: getUsdUzsRate(db),
    tasks,
    lines,
    taskById: new Map(tasks.map((task) => [task.id, task])),
  };
}

function namedEmployeeRow(db, userId, fallbackName) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const user = getBotUserById(db, id);
  return {
    user_id: id,
    name: employeeLabel(user) || fallbackName || `Сотрудник #${id}`,
  };
}

function employeeNamer(db) {
  const cache = new Map();
  return (userId, fallbackName) => {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (!cache.has(id)) cache.set(id, namedEmployeeRow(db, id, fallbackName));
    return cache.get(id);
  };
}

function emptyTechnicianRow(userId, name) {
  return {
    user_id: userId,
    name: name || `Сотрудник #${userId}`,
    technician_task_count: 0,
    technician_task_score: 0,
    ticket_count: 0,
  };
}

function emptyCommissionRow(userId, name) {
  return {
    user_id: userId,
    name: name || `Сотрудник #${userId}`,
    manager_task_count: 0,
    commission_uzs: 0,
    commission_usd: 0,
  };
}

function ensureMapRow(byUser, userId, factory) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (!byUser.has(id)) byUser.set(id, factory(id));
  return byUser.get(id);
}

function addLineCommission(row, line, rate) {
  const percent = Number(line.manager_sale_percent) || 0;
  if (percent <= 0) return;
  const money = computeLineMoney(line, rate);
  row.commission_uzs = roundStaffMoney(row.commission_uzs + (money.price_uzs * percent) / 100);
  row.commission_usd = roundStaffMoney(row.commission_usd + (money.price_usd * percent) / 100);
}

function addLineTechnicianScore(row, line) {
  const score = Number(line.technician_score) || 0;
  if (score <= 0) return;
  row.technician_task_score = roundStaffMoney(row.technician_task_score + score * staffQuantity(line));
}

function presentTechnicianRow(row) {
  return {
    user_id: row.user_id,
    name: row.name,
    technician_task_count: Number(row.technician_task_count) || 0,
    technician_task_score: roundStaffMoney(row.technician_task_score),
    ticket_count: Number(row.ticket_count) || 0,
  };
}

function presentCommissionRow(row) {
  return {
    user_id: row.user_id,
    name: row.name,
    manager_task_count: Number(row.manager_task_count) || 0,
    commission_uzs: roundStaffMoney(row.commission_uzs),
    commission_usd: roundStaffMoney(row.commission_usd),
  };
}

function isTechnicianRowEmpty(row) {
  return (
    !row ||
    (Number(row.technician_task_count) === 0 &&
      Number(row.ticket_count) === 0 &&
      Number(row.technician_task_score) === 0)
  );
}

function isCommissionRowEmpty(row) {
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
    ticket_count: 0,
  };
}

function emptyCommissionTotals() {
  return {
    manager_task_count: 0,
    commission_uzs: 0,
    commission_usd: 0,
  };
}

function sumTechnicianTotals(rows) {
  const totals = emptyTechnicianTotals();
  for (const row of rows) {
    totals.technician_task_count += Number(row.technician_task_count) || 0;
    totals.technician_task_score = roundStaffMoney(
      totals.technician_task_score + (Number(row.technician_task_score) || 0)
    );
    totals.ticket_count += Number(row.ticket_count) || 0;
  }
  return totals;
}

function sumCommissionTotals(rows) {
  const totals = emptyCommissionTotals();
  for (const row of rows) {
    totals.manager_task_count += Number(row.manager_task_count) || 0;
    totals.commission_uzs = roundStaffMoney(totals.commission_uzs + (Number(row.commission_uzs) || 0));
    totals.commission_usd = roundStaffMoney(totals.commission_usd + (Number(row.commission_usd) || 0));
  }
  return totals;
}

function sortNamedRows(rows) {
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function buildTechnicianReport(
  db,
  {
    fromUnix = null,
    toUnix = null,
    viewer = null,
    ticketsByRegosUserId = new Map(),
    unassignedTicketCount = 0,
  } = {}
) {
  const { tasks, lines, taskById } = loadPostedTaskReportContext(db, {
    fromUnix,
    toUnix,
    viewer,
  });
  const byUser = new Map();
  const nameOf = employeeNamer(db);

  for (const task of tasks) {
    if (task.technician_user_id == null) continue;
    const named = nameOf(task.technician_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id) => emptyTechnicianRow(id, named.name));
    if (row) row.technician_task_count += 1;
  }

  for (const line of lines) {
    const task = taskById.get(line.task_id);
    if (!task || task.technician_user_id == null) continue;
    const named = nameOf(task.technician_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id) => emptyTechnicianRow(id, named.name));
    if (row) addLineTechnicianScore(row, line);
  }

  let unmatchedTickets = Number(unassignedTicketCount) || 0;
  for (const [regosUserId, count] of ticketsByRegosUserId) {
    const n = Number(count) || 0;
    if (n <= 0) continue;
    const user = findBotUserByRegosUserId(db, regosUserId);
    if (!user) {
      unmatchedTickets += n;
      continue;
    }
    const named = nameOf(user.id, employeeLabel(user));
    if (!named) {
      unmatchedTickets += n;
      continue;
    }
    const row = ensureMapRow(byUser, named.user_id, (id) => emptyTechnicianRow(id, named.name));
    if (!row) {
      unmatchedTickets += n;
      continue;
    }
    row.ticket_count += n;
    if (!row.name) row.name = named.name;
  }

  const rows = sortNamedRows(
    [...byUser.values()].map(presentTechnicianRow).filter((row) => !isTechnicianRowEmpty(row))
  );

  return {
    rows,
    totals: sumTechnicianTotals(rows),
    unassigned_ticket_count: unmatchedTickets,
  };
}

function buildCommissionReport(db, { fromUnix = null, toUnix = null, viewer = null } = {}) {
  const { rate, tasks, lines, taskById } = loadPostedTaskReportContext(db, {
    fromUnix,
    toUnix,
    viewer,
  });
  const byUser = new Map();
  const nameOf = employeeNamer(db);

  for (const task of tasks) {
    if (task.manager_user_id == null) continue;
    const named = nameOf(task.manager_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id) => emptyCommissionRow(id, named.name));
    if (row) row.manager_task_count += 1;
  }

  for (const line of lines) {
    const task = taskById.get(line.task_id);
    if (!task || task.manager_user_id == null) continue;
    const named = nameOf(task.manager_user_id);
    if (!named) continue;
    const row = ensureMapRow(byUser, named.user_id, (id) => emptyCommissionRow(id, named.name));
    if (row) addLineCommission(row, line, rate);
  }

  const rows = sortNamedRows(
    [...byUser.values()].map(presentCommissionRow).filter((row) => !isCommissionRowEmpty(row))
  );

  return {
    rows,
    totals: sumCommissionTotals(rows),
  };
}

module.exports = {
  unixSecondsToSqliteUtc,
  queryInChunks,
  tableExists,
  loadPostedTasks,
  listPostedTaskLines,
  loadPostedTaskReportContext,
  buildTechnicianReport,
  buildCommissionReport,
};
