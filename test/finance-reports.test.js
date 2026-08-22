const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccount } = require('../src/db/accounts');
const { createAccountPayment } = require('../src/db/account-payments');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createDevice } = require('../src/db/devices');
const { createService } = require('../src/db/services');
const { buildFinanceReport, UNASSIGNED_LOCATION_NAME } = require('../src/db/finance-reports');
const { createLocation } = require('../src/db/locations');
const { openDb, createOrder } = require('../src/db/partners-db');
const { createPaymentType, listPaymentTypes } = require('../src/db/payment-types');
const { setUsdUzsRate, roundMoney } = require('../src/db/money');
const { createTaskPayment } = require('../src/db/task-payments');
const { refundTaskLine } = require('../src/db/task-refunds');
const { addTaskService, createTask, getTask, postTask, updateTaskDevice } = require('../src/db/tasks');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-finance-reports-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

function currentPeriod() {
  const now = Math.floor(Date.now() / 1000);
  return { fromUnix: now - 24 * 3600, toUnix: now + 3600 };
}

function makePaymentType(db, { name, currency }) {
  const account = createAccount(db, { name: `${name} счёт`, currency });
  return createPaymentType(db, { name, account_id: account.id });
}

function postedTask(db, input) {
  const task = createTask(db, { status: 'done', ...input });
  return postTask(db, task.id);
}

describe('finance reports', () => {
  let dbPath;
  let db;
  let alice;
  let bob;
  let office;
  let warehouse;
  let device;
  let cashUzs;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    alice = createEmployeeUser(db, { phone: '+998901000031', displayName: 'Алиса' });
    bob = createEmployeeUser(db, { phone: '+998901000032', displayName: 'Борис' });
    office = createLocation(db, { name: 'Офис', allowed_user_ids: [alice.id] });
    warehouse = createLocation(db, { name: 'Склад', allowed_user_ids: [bob.id] });
    device = createDevice(db, {
      name: 'Терминал',
      cost_amount: 40000,
      cost_currency: 'UZS',
      price_uzs: 100000,
    });
    cashUzs = listPaymentTypes(db).find((item) => item.code === 'cash') || makePaymentType(db, { name: 'Наличные', currency: 'UZS' });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('sums revenue, cost and profit for posted done tasks by location', () => {
    postedTask(db, {
      title: 'Офис установка',
      location_id: office.id,
      devices: [{ device_id: device.id, quantity: 1 }],
    });

    const report = buildFinanceReport(db, currentPeriod());
    const officeRow = report.rows.find((row) => row.location_id === office.id);
    assert.ok(officeRow);
    assert.equal(officeRow.task_count, 1);
    assert.equal(officeRow.revenue_uzs, 100000);
    assert.equal(officeRow.cost_uzs, 40000);
    assert.equal(officeRow.profit_uzs, 60000);
    assert.equal(officeRow.net_revenue_uzs, 100000);
    assert.equal(officeRow.paid_uzs, 0);
    assert.equal(officeRow.due_uzs, 100000);
    assert.equal(report.totals.task_count, 1);
    assert.equal(report.totals.profit_uzs, 60000);
  });

  it('ignores new and unposted tasks', () => {
    const before = buildFinanceReport(db, currentPeriod());
    createTask(db, {
      title: 'Черновик финансы',
      status: 'new',
      location_id: office.id,
      devices: [{ device_id: device.id }],
    });
    const unposted = createTask(db, {
      title: 'Не проведена',
      status: 'done',
      location_id: office.id,
      devices: [{ device_id: device.id }],
    });
    assert.equal(unposted.posted, false);

    const after = buildFinanceReport(db, currentPeriod());
    assert.equal(after.totals.task_count, before.totals.task_count);
    assert.equal(after.totals.revenue_uzs, before.totals.revenue_uzs);
  });

  it('applies percent discount to revenue and profit', () => {
    const before = buildFinanceReport(db, currentPeriod());
    const task = createTask(db, {
      title: 'Со скидкой финансы',
      status: 'done',
      location_id: office.id,
      devices: [{ device_id: device.id, quantity: 1 }],
    });
    updateTaskDevice(db, task.id, task.devices[0].id, {
      discount_type: 'percent',
      discount_value: 10,
    });
    postTask(db, task.id);

    const after = buildFinanceReport(db, currentPeriod());
    assert.equal(after.totals.revenue_uzs, before.totals.revenue_uzs + 90000);
    assert.equal(after.totals.cost_uzs, before.totals.cost_uzs + 40000);
    assert.equal(after.totals.profit_uzs, before.totals.profit_uzs + 50000);
  });

  it('nets refunds out of revenue and cash refunds out of paid', () => {
    const task = postedTask(db, {
      title: 'Возврат финансы',
      location_id: warehouse.id,
      devices: [{ device_id: device.id, quantity: 1 }],
    });
    createTaskPayment(db, task.id, { payment_type_id: cashUzs.id, amount: 100000 });
    const lineId = getTask(db, task.id).devices[0].id;
    refundTaskLine(db, task.id, {
      kind: 'device',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cashUzs.id,
      amount: 100000,
      currency: 'UZS',
    });

    const report = buildFinanceReport(db, currentPeriod());
    const warehouseRow = report.rows.find((row) => row.location_id === warehouse.id);
    assert.ok(warehouseRow);
    assert.equal(warehouseRow.task_count, 1);
    assert.equal(warehouseRow.revenue_uzs, 100000);
    assert.equal(warehouseRow.refund_uzs, 100000);
    assert.equal(warehouseRow.net_revenue_uzs, 0);
    assert.equal(warehouseRow.paid_uzs, 100000);
    assert.equal(warehouseRow.refunded_cash_uzs, 100000);
    assert.equal(warehouseRow.due_uzs, 0);
    assert.equal(warehouseRow.profit_uzs, -40000);
  });

  it('groups unassigned tasks separately', () => {
    postedTask(db, {
      title: 'Без филиала',
      devices: [{ device_id: device.id, quantity: 1 }],
    });

    const report = buildFinanceReport(db, currentPeriod());
    const unassigned = report.rows.find((row) => row.location_id == null);
    assert.ok(unassigned);
    assert.equal(unassigned.name, UNASSIGNED_LOCATION_NAME);
    assert.equal(unassigned.task_count, 1);
    assert.equal(unassigned.revenue_uzs, 100000);
    assert.equal(report.rows[report.rows.length - 1].location_id, null);
  });

  it('hides locations the viewer cannot access and keeps null-location tasks', () => {
    const report = buildFinanceReport(db, {
      ...currentPeriod(),
      viewer: { seeAll: false, userId: alice.id },
    });
    assert.equal(report.rows.some((row) => row.location_id === office.id), true);
    assert.equal(report.rows.some((row) => row.location_id === warehouse.id), false);
    assert.equal(report.rows.some((row) => row.location_id == null), true);
  });

  it('excludes repair task device prices from revenue and still counts services', () => {
    const service = createService(db, {
      name: 'Диагностика',
      cost_amount: 10000,
      cost_currency: 'UZS',
      price_uzs: 25000,
    });
    const before = buildFinanceReport(db, currentPeriod());
    const officeBefore = before.rows.find((row) => row.location_id === office.id);
    const task = createTask(db, {
      title: 'Ремонт терминала финансы',
      action: 'repair',
      status: 'done',
      location_id: office.id,
      devices: [{ device_id: device.id, quantity: 1 }],
    });
    addTaskService(db, task.id, { service_id: service.id, quantity: 1 });
    postTask(db, task.id);

    const after = buildFinanceReport(db, currentPeriod());
    const officeAfter = after.rows.find((row) => row.location_id === office.id);
    assert.ok(officeAfter);
    assert.equal(officeAfter.task_count, (officeBefore?.task_count || 0) + 1);
    assert.equal(officeAfter.revenue_uzs, (officeBefore?.revenue_uzs || 0) + 25000);
    assert.equal(officeAfter.cost_uzs, (officeBefore?.cost_uzs || 0) + 10000);
  });

  it('adds period income and expense from account payments by location', () => {
    const account = createAccount(db, { name: 'Касса отчёта', currency: 'UZS' });
    const before = buildFinanceReport(db, currentPeriod());
    const officeBefore = before.rows.find((row) => row.location_id === office.id);
    createAccountPayment(db, {
      account_id: account.id,
      direction: 'in',
      amount: 50000,
      location_id: office.id,
    });
    createAccountPayment(db, {
      account_id: account.id,
      direction: 'out',
      amount: 12000,
      location_id: office.id,
    });
    createAccountPayment(db, {
      account_id: account.id,
      direction: 'in',
      amount: 8000,
      created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      location_id: office.id,
    });

    const after = buildFinanceReport(db, currentPeriod());
    const officeAfter = after.rows.find((row) => row.location_id === office.id);
    assert.ok(officeAfter);
    assert.equal(officeAfter.income_uzs, (officeBefore?.income_uzs || 0) + 50000);
    assert.equal(officeAfter.expense_uzs, (officeBefore?.expense_uzs || 0) + 12000);
    assert.equal(officeAfter.profit_uzs, officeBefore?.profit_uzs || 0);
    assert.equal(after.totals.income_uzs, before.totals.income_uzs + 50000);
    assert.equal(after.totals.expense_uzs, before.totals.expense_uzs + 12000);
  });

  it('keeps a payment-only location and converts USD account payments', () => {
    const shop = createLocation(db, { name: 'Магазин', allowed_user_ids: [alice.id] });
    const usdAccount = createAccount(db, { name: 'USD касса отчёта', currency: 'USD' });
    createAccountPayment(db, {
      account_id: usdAccount.id,
      direction: 'in',
      amount: 10,
      currency: 'USD',
      location_id: shop.id,
    });

    const report = buildFinanceReport(db, currentPeriod());
    const shopRow = report.rows.find((row) => row.location_id === shop.id);
    assert.ok(shopRow);
    assert.equal(shopRow.task_count, 0);
    assert.equal(shopRow.income_usd, 10);
    assert.equal(shopRow.income_uzs, 125000);
    assert.equal(shopRow.expense_uzs, 0);
  });

  it('hides account payments for locations the viewer cannot access', () => {
    const account = createAccount(db, { name: 'Складская касса', currency: 'UZS' });
    createAccountPayment(db, {
      account_id: account.id,
      direction: 'out',
      amount: 3000,
      location_id: warehouse.id,
    });
    createAccountPayment(db, {
      account_id: account.id,
      direction: 'in',
      amount: 4000,
    });

    const report = buildFinanceReport(db, {
      ...currentPeriod(),
      viewer: { seeAll: false, userId: alice.id },
    });
    assert.equal(report.rows.some((row) => row.location_id === warehouse.id), false);
    const unassigned = report.rows.find((row) => row.location_id == null);
    assert.ok(unassigned);
    assert.equal(unassigned.income_uzs >= 4000, true);
    assert.equal(
      report.rows.some((row) => row.location_id === warehouse.id && row.expense_uzs > 0),
      false
    );
  });

  it('summarizes period orders without mixing paid amount into profit', () => {
    const before = buildFinanceReport(db, currentPeriod());
    createOrder(db, {
      id: `fin-ord-paid-${Date.now()}`,
      telegramId: 91001,
      clientPhone: '998901110001',
      amount: 15000,
      status: 'paid',
    });
    createOrder(db, {
      id: `fin-ord-cash-${Date.now()}`,
      telegramId: 91001,
      clientPhone: '998901110002',
      amount: 7000,
      status: 'paid_cash',
      paymentProvider: 'cash',
    });
    createOrder(db, {
      id: `fin-ord-pending-${Date.now()}`,
      telegramId: 91001,
      clientPhone: '998901110003',
      amount: 9000,
      status: 'pending',
    });
    createOrder(db, {
      id: `fin-ord-deleted-${Date.now()}`,
      telegramId: 91001,
      clientPhone: '998901110004',
      amount: 4000,
      status: 'deleted',
    });
    const oldOrder = createOrder(db, {
      id: `fin-ord-old-${Date.now()}`,
      telegramId: 91001,
      clientPhone: '998901110005',
      amount: 50000,
      status: 'paid',
    });
    db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
      oldOrder.id
    );

    const after = buildFinanceReport(db, currentPeriod());
    assert.equal(after.orders.count, before.orders.count + 4);
    assert.equal(after.orders.paid, before.orders.paid + 2);
    assert.equal(after.orders.pending, before.orders.pending + 1);
    assert.equal(after.orders.deleted, before.orders.deleted + 1);
    assert.equal(after.orders.amount, before.orders.amount + 22000);
    assert.equal(after.orders.amount_uzs, before.orders.amount_uzs + 22000);
    assert.equal(after.totals.profit_uzs, before.totals.profit_uzs);
    assert.equal(after.totals.due_uzs, before.totals.due_uzs);
    assert.equal(after.totals.income_uzs, before.totals.income_uzs + 22000);
    assert.equal(after.totals.paid_uzs, before.totals.paid_uzs + 22000);
    const officeAfter = after.rows.find((row) => row.location_id === office.id);
    const officeBefore = before.rows.find((row) => row.location_id === office.id);
    assert.equal(officeAfter?.income_uzs, officeBefore?.income_uzs);
    assert.equal(officeAfter?.paid_uzs, officeBefore?.paid_uzs);
  });

  it('converts paid USD orders into totals income and paid', () => {
    const before = buildFinanceReport(db, currentPeriod());
    createOrder(db, {
      id: `fin-ord-usd-${Date.now()}`,
      telegramId: 91001,
      clientPhone: '998901110099',
      amount: 10,
      currency: 'USD',
      status: 'paid',
    });
    const after = buildFinanceReport(db, currentPeriod());
    assert.equal(after.totals.income_uzs, before.totals.income_uzs + 125000);
    assert.equal(after.totals.income_usd, roundMoney(before.totals.income_usd + 10));
    assert.equal(after.totals.paid_uzs, before.totals.paid_uzs + 125000);
    assert.equal(after.totals.paid_usd, roundMoney(before.totals.paid_usd + 10));
    assert.equal(after.totals.profit_uzs, before.totals.profit_uzs);
    assert.equal(after.totals.due_uzs, before.totals.due_uzs);
  });

  it('filters posted tasks and account payments by location', () => {
    const all = buildFinanceReport(db, currentPeriod());
    const officeOnly = buildFinanceReport(db, { ...currentPeriod(), locationId: office.id });
    const noneOnly = buildFinanceReport(db, { ...currentPeriod(), locationId: 'none' });
    assert.equal(officeOnly.rows.every((row) => row.location_id === office.id), true);
    assert.equal(officeOnly.rows.some((row) => row.location_id === warehouse.id), false);
    const allOffice = all.rows.find((row) => row.location_id === office.id);
    const filteredOffice = officeOnly.rows.find((row) => row.location_id === office.id);
    assert.ok(filteredOffice);
    assert.equal(filteredOffice.task_count, allOffice?.task_count);
    assert.equal(filteredOffice.income_uzs, allOffice?.income_uzs);
    assert.equal(noneOnly.rows.every((row) => row.location_id == null), true);
    assert.equal(officeOnly.orders.amount, all.orders.amount);
    assert.equal(officeOnly.totals.income_uzs, (filteredOffice.income_uzs || 0) + officeOnly.orders.amount_uzs);
  });
});
