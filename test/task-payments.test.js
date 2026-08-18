const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createService } = require('../src/db/services');
const { addTaskService, createTask, getTask } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');
const { createPaymentType, deletePaymentType } = require('../src/db/payment-types');
const {
  createTaskPayment,
  deleteTaskPayment,
  listTaskPayments,
} = require('../src/db/task-payments');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-payments-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function taskWithPrice(db, { title, priceUzs }) {
  const service = createService(db, {
    name: `${title} — услуга`,
    cost_amount: 0,
    cost_currency: 'UZS',
    price_uzs: priceUzs,
  });
  const created = createTask(db, { title, devices: [] });
  return addTaskService(db, created.id, { service_id: service.id });
}

describe('task payments', () => {
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

  it('tracks paid and remaining amounts across currencies', () => {
    setUsdUzsRate(db, 12500);
    const task = taskWithPrice(db, { title: 'Оплата частями', priceUzs: 300000 });
    assert.equal(task.totals.price_uzs, 300000);
    assert.equal(task.payment_totals.paid_uzs, 0);
    assert.equal(task.payment_totals.due_uzs, 300000);

    const payment = createTaskPayment(db, task.id, {
      payment_type_id: cashUzs.id,
      amount: 100000,
      note: 'Аванс',
    });
    assert.equal(payment.payment_type_name, 'Наличные');
    assert.equal(payment.currency, 'UZS');
    assert.equal(payment.amount_uzs, 100000);
    assert.equal(payment.amount_usd, 8);
    assert.equal(payment.usd_uzs_rate, 12500);
    assert.equal(payment.note, 'Аванс');
    assert.equal(payment.created_by, null);

    createTaskPayment(db, task.id, { payment_type_id: cardUsd.id, amount: 5 });

    const withPayments = getTask(db, task.id);
    assert.equal(withPayments.payments.length, 2);
    assert.equal(withPayments.payment_totals.paid_uzs, 162500);
    assert.equal(withPayments.payment_totals.paid_usd, 13);
    assert.equal(withPayments.payment_totals.due_uzs, 137500);
  });

  it('keeps stored amounts when the exchange rate changes later', () => {
    setUsdUzsRate(db, 12500);
    const task = taskWithPrice(db, { title: 'Курс', priceUzs: 125000 });
    createTaskPayment(db, task.id, { payment_type_id: cardUsd.id, amount: 4 });

    setUsdUzsRate(db, 13000);
    const afterRateChange = getTask(db, task.id);
    assert.equal(afterRateChange.payments[0].amount, 4);
    assert.equal(afterRateChange.payments[0].amount_uzs, 50000);
    assert.equal(afterRateChange.payments[0].usd_uzs_rate, 12500);
    assert.equal(afterRateChange.payment_totals.paid_uzs, 50000);
    assert.equal(afterRateChange.payment_totals.due_uzs, 75000);
    setUsdUzsRate(db, 12500);
  });

  it('reports an overpayment as a negative remainder', () => {
    setUsdUzsRate(db, 12500);
    const task = taskWithPrice(db, { title: 'Переплата', priceUzs: 50000 });
    createTaskPayment(db, task.id, { payment_type_id: cashUzs.id, amount: 60000 });

    const overpaid = getTask(db, task.id);
    assert.equal(overpaid.payment_totals.paid_uzs, 60000);
    assert.equal(overpaid.payment_totals.due_uzs, -10000);
  });

  it('rejects invalid payments', () => {
    const task = taskWithPrice(db, { title: 'Валидация', priceUzs: 10000 });
    assert.throws(
      () => createTaskPayment(db, task.id, { payment_type_id: cashUzs.id, amount: 0 }),
      /INVALID_TASK_PAYMENT_AMOUNT/
    );
    assert.throws(
      () => createTaskPayment(db, task.id, { payment_type_id: cashUzs.id, amount: -100 }),
      /INVALID_TASK_PAYMENT_AMOUNT/
    );
    assert.throws(
      () => createTaskPayment(db, task.id, { payment_type_id: 999999, amount: 1000 }),
      /INVALID_TASK_PAYMENT_TYPE/
    );
    assert.throws(
      () => createTaskPayment(db, task.id, { payment_type_id: cashUzs.id, amount: 1000, currency: 'EUR' }),
      /INVALID_TASK_PAYMENT_CURRENCY/
    );
    assert.throws(
      () => createTaskPayment(db, 999999, { payment_type_id: cashUzs.id, amount: 1000 }),
      /NOT_FOUND/
    );
    assert.equal(listTaskPayments(db, task.id).length, 0);
  });

  it('deletes a payment and restores the remaining amount', () => {
    setUsdUzsRate(db, 12500);
    const task = taskWithPrice(db, { title: 'Удаление оплаты', priceUzs: 90000 });
    const payment = createTaskPayment(db, task.id, {
      payment_type_id: cashUzs.id,
      amount: 90000,
    });
    assert.equal(getTask(db, task.id).payment_totals.due_uzs, 0);

    assert.equal(deleteTaskPayment(db, task.id, payment.id), true);
    assert.equal(deleteTaskPayment(db, task.id, payment.id), false);

    const afterDelete = getTask(db, task.id);
    assert.equal(afterDelete.payments.length, 0);
    assert.equal(afterDelete.payment_totals.paid_uzs, 0);
    assert.equal(afterDelete.payment_totals.due_uzs, 90000);
  });

  it('keeps the payment type name after the type is removed', () => {
    const temporaryType = createPaymentType(db, { name: 'Перевод', currency: 'UZS' });
    const task = taskWithPrice(db, { title: 'Снимок типа', priceUzs: 20000 });
    createTaskPayment(db, task.id, { payment_type_id: temporaryType.id, amount: 20000 });
    deletePaymentType(db, temporaryType.id);

    const [payment] = getTask(db, task.id).payments;
    assert.equal(payment.payment_type_name, 'Перевод');
    assert.equal(payment.amount_uzs, 20000);
  });
});
