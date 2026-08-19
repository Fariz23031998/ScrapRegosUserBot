const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccount } = require('../src/db/accounts');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createDevice } = require('../src/db/devices');
const { createService } = require('../src/db/services');
const { buildFinanceReport, UNASSIGNED_LOCATION_NAME } = require('../src/db/finance-reports');
const { createLocation } = require('../src/db/locations');
const { openDb } = require('../src/db/partners-db');
const { createPaymentType, listPaymentTypes } = require('../src/db/payment-types');
const { setUsdUzsRate } = require('../src/db/money');
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
});
