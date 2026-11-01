import type { Unchecked } from '../src/types/unchecked';
import type { Db } from '../src/types/db';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { createService } from '../src/db/services';
import { createDevice } from '../src/db/devices';
import { addTaskService, addTaskDevice, createTask, getTask, advanceTaskStatus, postTask } from '../src/db/tasks';
import { createAccount } from '../src/db/accounts';
import { setUsdUzsRate } from '../src/db/money';
import { createPaymentType, listPaymentTypes } from '../src/db/payment-types';
import { createTaskPayment } from '../src/db/task-payments';
import { refundTaskLine } from '../src/db/task-refunds';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-task-refunds-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

function makePaymentType(db: Db, { name, currency }: Unchecked) {
  const account = createAccount(db, { name: `${name} счёт`, currency });
  return createPaymentType(db, { name, account_id: account!.id });
}

function finalizeTask(db: Db, taskId?: any) {
  (advanceTaskStatus as any)(db, taskId);
  (advanceTaskStatus as any)(db, taskId);
  return postTask(db, taskId);
}

describe('task refunds', () => {
  let dbPath: any;
  let db: any;
  let cashUzs: any;
  let cardUsd: any;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    cashUzs = listPaymentTypes(db).find((item?: any) => item.code === 'cash');
    cardUsd = makePaymentType(db, { name: 'Карта USD', currency: 'USD' });
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('refunds a service line without changing the cart', () => {
    setUsdUzsRate(db, 12500);
    const service = createService(db, {
      name: 'Монтаж',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 100000,
    });
    const created = createTask(db, { title: 'Полный возврат услуги', devices: [] });
    addTaskService(db, created!.id, { service_id: service!.id, quantity: 1 });
    createTaskPayment(db, created!.id, { payment_type_id: cashUzs.id, amount: 100000 });
    finalizeTask(db, created!.id);

    const lineId = getTask(db, created!.id)!.services[0].id;
    const result = refundTaskLine(db, created!.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cashUzs.id,
      amount: 100000,
      currency: 'UZS',
      note: 'Клиент отказался',
    });

    assert.equal(result!.payment!.kind, 'refund');
    assert.equal(result!.payment!.amount, 100000);
    assert.equal(result!.payment!.refunded_quantity, 1);
    assert.equal(result!.task!.services.length, 1);
    assert.equal(result!.task!.services[0].quantity, 1);
    assert.equal(result!.task!.totals.price_uzs, 100000);
    assert.equal(result!.task!.payment_totals.paid_uzs, 100000);
    assert.equal(result!.task!.payment_totals.due_uzs, 0);
    assert.equal(result!.task!.payments.every((payment?: any) => payment.kind !== 'refund'), true);
    assert.equal(result!.task!.refunds.length, 1);
    assert.equal(result!.task!.refunds[0].lines[0].quantity, 1);
    assert.equal(result!.task!.refunds[0].payments[0].kind, 'refund');
    assert.equal(result.refund.id, result!.task!.refunds[0].id);
  });

  it('refunds a line without a payment operation', () => {
    const service = createService(db, {
      name: 'Возврат без оплаты',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 80000,
    });
    const created = createTask(db, { title: 'Возврат без денег', devices: [] });
    addTaskService(db, created!.id, { service_id: service!.id, quantity: 1 });
    createTaskPayment(db, created!.id, { payment_type_id: cashUzs.id, amount: 80000 });
    finalizeTask(db, created!.id);

    const lineId = getTask(db, created!.id)!.services[0].id;
    const result = refundTaskLine(db, created!.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      note: 'Товар вернули, деньги позже',
    });

    assert.equal(result.payment, null);
    assert.equal(result!.task!.services[0].quantity, 1);
    assert.equal(result!.task!.refunds.length, 1);
    assert.equal(result!.task!.refunds[0].lines[0].quantity, 1);
    assert.deepEqual(result!.task!.refunds[0].payments, []);
    assert.equal(result!.task!.payment_totals.paid_uzs, 80000);
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
    addTaskDevice(db, created!.id, { device_id: device!.id, action: 'install', quantity: 3 });
    createTaskPayment(db, created!.id, { payment_type_id: cashUzs.id, amount: 90000 });
    finalizeTask(db, created!.id);

    const lineId = getTask(db, created!.id)!.devices[0].id;
    const result = refundTaskLine(db, created!.id, {
      kind: 'device',
      line_id: lineId,
      quantity: 2,
      payment_type_id: cashUzs.id,
      amount: 60000,
      currency: 'UZS',
    });

    assert.equal(result!.task!.devices.length, 1);
    assert.equal(result!.task!.devices[0].quantity, 3);
    assert.equal(result!.task!.totals.price_uzs, 90000);
    assert.equal(result!.task!.payment_totals.paid_uzs, 90000);
    assert.equal(result!.task!.payment_totals.due_uzs, 0);
    assert.equal(result!.payment!.refunded_quantity, 2);
    assert.equal(result!.task!.refunds[0].lines[0].quantity, 2);
  });

  it('caps remaining refund quantity without changing the cart', () => {
    const service = createService(db, {
      name: 'Диагностика пакета',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 20000,
    });
    const created = createTask(db, { title: 'Лимит возврата', devices: [] });
    addTaskService(db, created!.id, { service_id: service!.id, quantity: 3 });
    finalizeTask(db, created!.id);
    const lineId = getTask(db, created!.id)!.services[0].id;

    refundTaskLine(db, created!.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 2,
      payment_type_id: cashUzs.id,
      amount: 40000,
      currency: 'UZS',
    });

    assert.throws(
      () =>
        refundTaskLine(db, created!.id, {
          kind: 'service',
          line_id: lineId,
          quantity: 2,
          payment_type_id: cashUzs.id,
          amount: 40000,
          currency: 'UZS',
        }),
      /INVALID_TASK_REFUND_QUANTITY/
    );

    const second = refundTaskLine(db, created!.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cashUzs.id,
      amount: 20000,
      currency: 'UZS',
    });
    assert.equal(second!.task!.services[0].quantity, 3);
    assert.equal(second!.task!.refunds.length, 2);
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
    addTaskService(db, created!.id, { service_id: service!.id });
    createTaskPayment(db, created!.id, { payment_type_id: cardUsd.id, amount: 10 });
    finalizeTask(db, created!.id);

    const lineId = getTask(db, created!.id)!.services[0].id;
    const result = refundTaskLine(db, created!.id, {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cardUsd.id,
      amount: 10,
      currency: 'USD',
    });

    assert.equal(result!.payment!.currency, 'USD');
    assert.equal(result!.payment!.amount_usd, 10);
    assert.equal(result!.task!.services.length, 1);
    assert.equal(result!.task!.payment_totals.paid_usd, 10);
    assert.equal(result!.task!.refunds[0].payments[0].amount_usd, 10);
  });

  it('rejects refunds unless the task is done and posted', () => {
    const service = createService(db, {
      name: 'Только после проведения',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 50000,
    });
    const created = createTask(db, { title: 'Черновик возврата', devices: [] });
    addTaskService(db, created!.id, { service_id: service!.id });
    const lineId = getTask(db, created!.id)!.services[0].id;
    const payload = {
      kind: 'service',
      line_id: lineId,
      quantity: 1,
      payment_type_id: cashUzs.id,
      amount: 50000,
      currency: 'UZS',
    };

    assert.throws(() => refundTaskLine(db, created!.id, payload), /TASK_NOT_DONE/);
    (advanceTaskStatus as any)(db, created!.id);
    (advanceTaskStatus as any)(db, created!.id);
    assert.throws(() => refundTaskLine(db, created!.id, payload), /TASK_NOT_POSTED/);
    postTask(db, created!.id);
    const result = refundTaskLine(db, created!.id, payload);
    assert.equal(result!.task!.refunds.length, 1);
  });

  it('rejects invalid refund requests', () => {
    const service = createService(db, {
      name: 'Диагностика',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 50000,
    });
    const created = createTask(db, { title: 'Валидация возврата', devices: [] });
    addTaskService(db, created!.id, { service_id: service!.id });
    finalizeTask(db, created!.id);
    const lineId = getTask(db, created!.id)!.services[0].id;

    assert.throws(
      () =>
        refundTaskLine(db, created!.id, {
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
        refundTaskLine(db, created!.id, {
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
        refundTaskLine(db, created!.id, {
          kind: 'service',
          line_id: lineId,
          quantity: 1,
          payment_type_id: cashUzs.id,
          amount: 60000,
          currency: 'UZS',
        }),
      /INVALID_TASK_REFUND_AMOUNT/
    );
    assert.equal(getTask(db, created!.id)!.services.length, 1);
  });
});
