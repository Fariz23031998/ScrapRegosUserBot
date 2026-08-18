const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createService } = require('../src/db/services');
const { createDevice } = require('../src/db/devices');
const { addTaskService, addTaskDevice, createTask, getTask } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');
const { createPaymentType } = require('../src/db/payment-types');
const { createTaskPayment } = require('../src/db/task-payments');
const { refundTaskLine } = require('../src/db/task-refunds');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-refunds-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('task refunds', () => {
  let dbPath;
  let db;
  let cashUzs;
  let cardUsd;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    cashUzs = createPaymentType(db, { name: 'Наличные', currency: 'UZS' });
    cardUsd = createPaymentType(db, { name: 'Карта USD', currency: 'USD' });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('refunds a service line fully and lowers paid totals', () => {
    setUsdUzsRate(db, 12500);
    const service = createService(db, {
      name: 'Монтаж',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 100000,
    });
    const created = createTask(db, { title: 'Полный возврат услуги', devices: [] });
    addTaskService(db, created.id, { service_id: service.id, quantity: 1 });
    createTaskPayment(db, created.id, { payment_type_id: cashUzs.id, amount: 100000 });

    const lineId = getTask(db, created.id).services[0].id;
    const result = refundTaskLine(db, created.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cashUzs.id,
      amount: 100000,
      currency: 'UZS',
      note: 'Клиент отказался',
    });

    assert.equal(result.payment.kind, 'refund');
    assert.equal(result.payment.amount, 100000);
    assert.equal(result.payment.refunded_quantity, 1);
    assert.equal(result.task.services.length, 0);
    assert.equal(result.task.totals.price_uzs, 0);
    assert.equal(result.task.payment_totals.paid_uzs, 0);
    assert.equal(result.task.payment_totals.due_uzs, 0);
    assert.equal(result.task.payments.length, 2);
    assert.equal(result.task.payments[0].kind, 'refund');
  });

  it('supports partial quantity refund on a device line', () => {
    setUsdUzsRate(db, 12500);
    const device = createDevice(db, {
      name: 'Датчик',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 30000,
    });
    const created = createTask(db, { title: 'Частичный возврат', devices: [] });
    addTaskDevice(db, created.id, { device_id: device.id, action: 'install', quantity: 3 });
    createTaskPayment(db, created.id, { payment_type_id: cashUzs.id, amount: 90000 });

    const lineId = getTask(db, created.id).devices[0].id;
    const result = refundTaskLine(db, created.id, {
      kind: 'device',
      line_id: lineId,
      quantity: 2,
      payment_type_id: cashUzs.id,
      amount: 60000,
      currency: 'UZS',
    });

    assert.equal(result.task.devices.length, 1);
    assert.equal(result.task.devices[0].quantity, 1);
    assert.equal(result.task.totals.price_uzs, 30000);
    assert.equal(result.task.payment_totals.paid_uzs, 30000);
    assert.equal(result.task.payment_totals.due_uzs, 0);
    assert.equal(result.payment.refunded_quantity, 2);
  });

  it('allows refund payment in USD for a UZS-priced line', () => {
    setUsdUzsRate(db, 12500);
    const service = createService(db, {
      name: 'Настройка',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 125000,
    });
    const created = createTask(db, { title: 'USD возврат', devices: [] });
    addTaskService(db, created.id, { service_id: service.id });
    createTaskPayment(db, created.id, { payment_type_id: cardUsd.id, amount: 10 });

    const lineId = getTask(db, created.id).services[0].id;
    const result = refundTaskLine(db, created.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cardUsd.id,
      amount: 10,
      currency: 'USD',
    });

    assert.equal(result.payment.currency, 'USD');
    assert.equal(result.payment.amount_usd, 10);
    assert.equal(result.task.services.length, 0);
    assert.equal(result.task.payment_totals.paid_usd, 0);
  });

  it('rejects invalid refund requests', () => {
    const service = createService(db, {
      name: 'Диагностика',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 50000,
    });
    const created = createTask(db, { title: 'Валидация возврата', devices: [] });
    addTaskService(db, created.id, { service_id: service.id });
    const lineId = getTask(db, created.id).services[0].id;

    assert.throws(
      () =>
        refundTaskLine(db, created.id, {
          kind: 'service',
          line_id: lineId,
          quantity: 2,
          payment_type_id: cashUzs.id,
          amount: 50000,
          currency: 'UZS',
        }),
      /INVALID_TASK_REFUND_QUANTITY/
    );
    assert.throws(
      () =>
        refundTaskLine(db, created.id, {
          kind: 'service',
          line_id: 999999,
          quantity: 1,
          payment_type_id: cashUzs.id,
          amount: 50000,
          currency: 'UZS',
        }),
      /INVALID_TASK_REFUND_LINE/
    );
    assert.throws(
      () =>
        refundTaskLine(db, created.id, {
          kind: 'service',
          line_id: lineId,
          quantity: 1,
          payment_type_id: cashUzs.id,
          amount: 60000,
          currency: 'UZS',
        }),
      /INVALID_TASK_REFUND_AMOUNT/
    );
    assert.equal(getTask(db, created.id).services.length, 1);
  });
});
