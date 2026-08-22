const { ensureAccountPaymentTables } = require('./account-payments');
const {
  appendLocationAccessFilter,
  appendLocationChoiceFilter,
  ensureLocationTables,
  getLocation,
} = require('./locations');
const { computeLineMoney, roundMoney } = require('./money');
const {
  loadPostedTaskReportContext,
  queryInChunks,
  tableExists,
  isRepairDeviceLine,
  unixSecondsToSqliteUtc,
} = require('./staff-reports');
const { ensureTaskPaymentTables } = require('./task-payments');
const { ensureTaskRefundTables } = require('./task-refunds');

const UNASSIGNED_LOCATION_NAME = 'Без филиала';

function roundFinanceMoney(value) {
  return roundMoney(value);
}

function locationKey(locationId) {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) return 'none';
  return String(id);
}

function emptyFinanceRow(locationId, name) {
  const id = Number(locationId);
  return {
    location_id: Number.isFinite(id) && id > 0 ? id : null,
    name: name || UNASSIGNED_LOCATION_NAME,
    task_count: 0,
    revenue_uzs: 0,
    revenue_usd: 0,
    refund_uzs: 0,
    refund_usd: 0,
    net_revenue_uzs: 0,
    net_revenue_usd: 0,
    cost_uzs: 0,
    cost_usd: 0,
    profit_uzs: 0,
    profit_usd: 0,
    paid_uzs: 0,
    paid_usd: 0,
    refunded_cash_uzs: 0,
    refunded_cash_usd: 0,
    due_uzs: 0,
    due_usd: 0,
    income_uzs: 0,
    income_usd: 0,
    expense_uzs: 0,
    expense_usd: 0,
  };
}

function emptyFinanceTotals() {
  const totals = emptyFinanceRow(null, '');
  delete totals.location_id;
  delete totals.name;
  return totals;
}

function addMoney(row, field, uzs, usd) {
  row[`${field}_uzs`] = roundFinanceMoney((Number(row[`${field}_uzs`]) || 0) + (Number(uzs) || 0));
  row[`${field}_usd`] = roundFinanceMoney((Number(row[`${field}_usd`]) || 0) + (Number(usd) || 0));
}

function presentFinanceRow(row) {
  const revenueUzs = roundFinanceMoney(row.revenue_uzs);
  const revenueUsd = roundFinanceMoney(row.revenue_usd);
  const refundUzs = roundFinanceMoney(row.refund_uzs);
  const refundUsd = roundFinanceMoney(row.refund_usd);
  const netRevenueUzs = roundFinanceMoney(revenueUzs - refundUzs);
  const netRevenueUsd = roundFinanceMoney(revenueUsd - refundUsd);
  const costUzs = roundFinanceMoney(row.cost_uzs);
  const costUsd = roundFinanceMoney(row.cost_usd);
  const paidUzs = roundFinanceMoney(row.paid_uzs);
  const paidUsd = roundFinanceMoney(row.paid_usd);
  const refundedCashUzs = roundFinanceMoney(row.refunded_cash_uzs);
  const refundedCashUsd = roundFinanceMoney(row.refunded_cash_usd);
  const netPaidUzs = roundFinanceMoney(paidUzs - refundedCashUzs);
  const netPaidUsd = roundFinanceMoney(paidUsd - refundedCashUsd);
  const incomeUzs = roundFinanceMoney(row.income_uzs);
  const incomeUsd = roundFinanceMoney(row.income_usd);
  const expenseUzs = roundFinanceMoney(row.expense_uzs);
  const expenseUsd = roundFinanceMoney(row.expense_usd);
  return {
    location_id: row.location_id,
    name: row.name,
    task_count: Number(row.task_count) || 0,
    revenue_uzs: revenueUzs,
    revenue_usd: revenueUsd,
    refund_uzs: refundUzs,
    refund_usd: refundUsd,
    net_revenue_uzs: netRevenueUzs,
    net_revenue_usd: netRevenueUsd,
    cost_uzs: costUzs,
    cost_usd: costUsd,
    profit_uzs: roundFinanceMoney(netRevenueUzs - costUzs),
    profit_usd: roundFinanceMoney(netRevenueUsd - costUsd),
    paid_uzs: paidUzs,
    paid_usd: paidUsd,
    refunded_cash_uzs: refundedCashUzs,
    refunded_cash_usd: refundedCashUsd,
    due_uzs: roundFinanceMoney(netRevenueUzs - netPaidUzs),
    due_usd: roundFinanceMoney(netRevenueUsd - netPaidUsd),
    income_uzs: incomeUzs,
    income_usd: incomeUsd,
    expense_uzs: expenseUzs,
    expense_usd: expenseUsd,
  };
}

function presentFinanceTotals(row) {
  const presented = presentFinanceRow({ ...row, location_id: null, name: '' });
  const { location_id: _locationId, name: _name, ...totals } = presented;
  return totals;
}

function sumFinanceTotals(rows) {
  const totals = emptyFinanceTotals();
  for (const row of rows) {
    totals.task_count += Number(row.task_count) || 0;
    addMoney(totals, 'revenue', row.revenue_uzs, row.revenue_usd);
    addMoney(totals, 'refund', row.refund_uzs, row.refund_usd);
    addMoney(totals, 'net_revenue', row.net_revenue_uzs, row.net_revenue_usd);
    addMoney(totals, 'cost', row.cost_uzs, row.cost_usd);
    addMoney(totals, 'profit', row.profit_uzs, row.profit_usd);
    addMoney(totals, 'paid', row.paid_uzs, row.paid_usd);
    addMoney(totals, 'refunded_cash', row.refunded_cash_uzs, row.refunded_cash_usd);
    addMoney(totals, 'due', row.due_uzs, row.due_usd);
    addMoney(totals, 'income', row.income_uzs, row.income_usd);
    addMoney(totals, 'expense', row.expense_uzs, row.expense_usd);
  }
  return presentFinanceTotals(totals);
}

function isFinanceRowActive(row) {
  return (
    (Number(row.task_count) || 0) > 0 ||
    (Number(row.income_uzs) || 0) !== 0 ||
    (Number(row.income_usd) || 0) !== 0 ||
    (Number(row.expense_uzs) || 0) !== 0 ||
    (Number(row.expense_usd) || 0) !== 0
  );
}

function locationNameFor(db, locationId) {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) return UNASSIGNED_LOCATION_NAME;
  const location = getLocation(db, id);
  return location?.name || `Филиал #${id}`;
}

function ensureFinanceRow(byLocation, db, locationId) {
  const key = locationKey(locationId);
  if (!byLocation.has(key)) {
    byLocation.set(key, emptyFinanceRow(locationId, locationNameFor(db, locationId)));
  }
  return byLocation.get(key);
}

function listRefundTotalsByTask(db, taskIds) {
  if (!tableExists(db, 'task_refunds') || !tableExists(db, 'task_refund_lines')) return [];
  return queryInChunks(
    db,
    (placeholders) => `
      SELECT tr.task_id,
             SUM(trl.price_uzs) AS refund_uzs,
             SUM(trl.price_usd) AS refund_usd
      FROM task_refunds tr
      INNER JOIN task_refund_lines trl ON trl.refund_id = tr.id
      WHERE tr.task_id IN (${placeholders})
      GROUP BY tr.task_id
    `,
    taskIds
  );
}

function listAccountPaymentTotalsByLocation(
  db,
  { fromUnix = null, toUnix = null, viewer = null, locationId = null } = {}
) {
  ensureAccountPaymentTables(db);
  if (!tableExists(db, 'account_payments')) return [];
  const from = unixSecondsToSqliteUtc(fromUnix);
  const to = unixSecondsToSqliteUtc(toUnix);
  const where = [];
  const params = [];
  if (from) {
    where.push(`datetime(p.created_at) >= datetime(?)`);
    params.push(from);
  }
  if (to) {
    where.push(`datetime(p.created_at) <= datetime(?)`);
    params.push(to);
  }
  appendLocationAccessFilter(where, params, viewer, 'p');
  appendLocationChoiceFilter(where, params, locationId, 'p');
  const sql = `
    SELECT p.location_id, p.direction,
           SUM(p.amount_uzs) AS amount_uzs,
           SUM(p.amount_usd) AS amount_usd
    FROM account_payments p
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY p.location_id, p.direction
  `;
  return db.prepare(sql).all(...params);
}

function listPaymentTotalsByTask(db, taskIds) {
  if (!tableExists(db, 'task_payments')) return [];
  return queryInChunks(
    db,
    (placeholders) => `
      SELECT task_id, kind,
             SUM(amount_uzs) AS amount_uzs,
             SUM(amount_usd) AS amount_usd
      FROM task_payments
      WHERE task_id IN (${placeholders})
      GROUP BY task_id, kind
    `,
    taskIds
  );
}

function sortFinanceRows(rows) {
  const named = rows.filter((row) => row.location_id != null);
  const unassigned = rows.filter((row) => row.location_id == null);
  named.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return [...named, ...unassigned];
}

function emptyOrderSummary() {
  return { count: 0, pending: 0, paid: 0, deleted: 0, amount: 0, amount_uzs: 0, amount_usd: 0 };
}

function summarizeFinanceOrders(db, { fromUnix = null, toUnix = null, rate = 0 } = {}) {
  if (!tableExists(db, 'orders')) return emptyOrderSummary();
  const from = unixSecondsToSqliteUtc(fromUnix);
  const to = unixSecondsToSqliteUtc(toUnix);
  const where = [];
  const params = [];
  if (from) {
    where.push(`datetime(created_at) >= datetime(?)`);
    params.push(from);
  }
  if (to) {
    where.push(`datetime(created_at) <= datetime(?)`);
    params.push(to);
  }
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('paid', 'paid_cash') THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted,
        SUM(CASE WHEN status IN ('paid', 'paid_cash') AND UPPER(IFNULL(currency, 'UZS')) = 'USD' THEN amount ELSE 0 END) AS paid_usd,
        SUM(CASE WHEN status IN ('paid', 'paid_cash') AND UPPER(IFNULL(currency, 'UZS')) != 'USD' THEN amount ELSE 0 END) AS paid_uzs
      FROM orders
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    `
    )
    .get(...params);
  const nativeUzs = Number(row?.paid_uzs) || 0;
  const nativeUsd = Number(row?.paid_usd) || 0;
  const safeRate = Number(rate) > 0 ? Number(rate) : 1;
  const amount_uzs = roundFinanceMoney(nativeUzs + nativeUsd * safeRate);
  const amount_usd = roundFinanceMoney(nativeUsd + nativeUzs / safeRate);
  return {
    count: Number(row?.count) || 0,
    pending: Number(row?.pending) || 0,
    paid: Number(row?.paid) || 0,
    deleted: Number(row?.deleted) || 0,
    amount: amount_uzs,
    amount_uzs,
    amount_usd,
  };
}

function addOrderAmountsToTotals(totals, orders) {
  addMoney(totals, 'income', orders.amount_uzs, orders.amount_usd);
  addMoney(totals, 'paid', orders.amount_uzs, orders.amount_usd);
  return totals;
}

function buildFinanceReport(db, { fromUnix = null, toUnix = null, viewer = null, locationId = null } = {}) {
  ensureLocationTables(db);
  ensureAccountPaymentTables(db);
  ensureTaskPaymentTables(db);
  ensureTaskRefundTables(db);

  const { rate, tasks, lines, taskById } = loadPostedTaskReportContext(db, {
    fromUnix,
    toUnix,
    viewer,
    locationId,
  });
  const byLocation = new Map();

  for (const task of tasks) {
    const row = ensureFinanceRow(byLocation, db, task.location_id);
    row.task_count += 1;
  }

  for (const line of lines) {
    const task = taskById.get(line.task_id);
    if (!task) continue;
    if (isRepairDeviceLine(task, line)) continue;
    const money = computeLineMoney(line, rate);
    const row = ensureFinanceRow(byLocation, db, task.location_id);
    addMoney(row, 'revenue', money.price_uzs, money.price_usd);
    addMoney(row, 'cost', money.cost_uzs, money.cost_usd);
  }

  const taskIds = tasks.map((task) => task.id);
  for (const refund of listRefundTotalsByTask(db, taskIds)) {
    const task = taskById.get(refund.task_id);
    if (!task) continue;
    const row = ensureFinanceRow(byLocation, db, task.location_id);
    addMoney(row, 'refund', refund.refund_uzs, refund.refund_usd);
  }

  for (const payment of listPaymentTotalsByTask(db, taskIds)) {
    const task = taskById.get(payment.task_id);
    if (!task) continue;
    const row = ensureFinanceRow(byLocation, db, task.location_id);
    if (payment.kind === 'refund') {
      addMoney(row, 'refunded_cash', payment.amount_uzs, payment.amount_usd);
    } else {
      addMoney(row, 'paid', payment.amount_uzs, payment.amount_usd);
    }
  }

  for (const payment of listAccountPaymentTotalsByLocation(db, { fromUnix, toUnix, viewer, locationId })) {
    const row = ensureFinanceRow(byLocation, db, payment.location_id);
    if (payment.direction === 'out') {
      addMoney(row, 'expense', payment.amount_uzs, payment.amount_usd);
    } else {
      addMoney(row, 'income', payment.amount_uzs, payment.amount_usd);
    }
  }

  const rows = sortFinanceRows(
    [...byLocation.values()].map(presentFinanceRow).filter(isFinanceRowActive)
  );
  const orders = summarizeFinanceOrders(db, { fromUnix, toUnix, rate });
  const totals = addOrderAmountsToTotals(sumFinanceTotals(rows), orders);

  return {
    rows,
    totals,
    orders,
  };
}

module.exports = {
  UNASSIGNED_LOCATION_NAME,
  buildFinanceReport,
};
