const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} = require('../src/db/accounts');
const { openDb } = require('../src/db/partners-db');
const {
  createPaymentType,
  deletePaymentType,
  listPaymentTypes,
  updatePaymentType,
} = require('../src/db/payment-types');
const { createService } = require('../src/db/services');
const { addTaskService, createTask } = require('../src/db/tasks');
const { setUsdUzsRate } = require('../src/db/money');
const { createTaskPayment, createTaskRefund } = require('../src/db/task-payments');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-accounts-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('accounts and system payment types', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
  });

  after(() => {
    db.close();
    removeDbFiles(dbPath);
  });

  it('seeds immutable Payme, Click, and cash payment types', () => {
    const types = listPaymentTypes(db);
    const byCode = Object.fromEntries(types.filter((item) => item.code).map((item) => [item.code, item]));
    assert.equal(byCode.payme.name, 'Payme');
    assert.equal(byCode.click.name, 'Click');
    assert.equal(byCode.cash.name, 'Наличные');
    assert.equal(byCode.payme.is_system, true);
    assert.equal(byCode.click.is_system, true);
    assert.equal(byCode.cash.is_system, true);
    assert.equal(byCode.payme.currency, 'UZS');
    assert.ok(byCode.payme.account_id);
    assert.equal(byCode.payme.account.name, 'Payme');

    assert.throws(
      () => updatePaymentType(db, byCode.cash.id, { name: 'Cash' }),
      /SYSTEM_PAYMENT_TYPE/
    );
    assert.throws(() => deletePaymentType(db, byCode.payme.id), /SYSTEM_PAYMENT_TYPE/);
    assert.equal(updatePaymentType(db, byCode.cash.id, { name: 'Наличные' }).name, 'Наличные');
  });

  it('creates accounts and uses their currency on payment types', () => {
    const account = createAccount(db, { name: 'Касса офиса', currency: 'USD' });
    assert.equal(account.value, 0);
    const paymentType = createPaymentType(db, { name: 'Карта офиса', account_id: account.id });
    assert.equal(paymentType.currency, 'USD');
    assert.equal(paymentType.account_id, account.id);
    assert.equal(listAccounts(db).some((item) => item.id === account.id), true);

    const uzsAccount = createAccount(db, { name: 'Касса сум', currency: 'UZS' });
    const updated = updatePaymentType(db, paymentType.id, { account_id: uzsAccount.id });
    assert.equal(updated.currency, 'UZS');
    assert.equal(updated.account.name, 'Касса сум');

    assert.throws(() => deleteAccount(db, uzsAccount.id), /ACCOUNT_IN_USE/);
    assert.equal(deletePaymentType(db, paymentType.id), true);
    assert.equal(deleteAccount(db, uzsAccount.id), true);
    assert.equal(getAccount(db, uzsAccount.id), null);
  });

  it('rejects invalid account input and changing currency recalculates value', () => {
    assert.throws(() => createAccount(db, { name: '  ', currency: 'UZS' }), /INVALID_ACCOUNT_NAME/);
    assert.throws(() => createAccount(db, { name: 'Касса', currency: 'EUR' }), /INVALID_ACCOUNT_CURRENCY/);

    const account = createAccount(db, { name: 'Валютный', currency: 'UZS' });
    const paymentType = createPaymentType(db, { name: 'Перевод валютный', account_id: account.id });
    const service = createService(db, {
      name: 'Услуга валютного счёта',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 125000,
    });
    const task = addTaskService(db, createTask(db, { title: 'Оплата на счёт', devices: [] }).id, {
      service_id: service.id,
    });
    createTaskPayment(db, task.id, { payment_type_id: paymentType.id, amount: 125000 });
    assert.equal(getAccount(db, account.id).value, 125000);

    const usdAccount = updateAccount(db, account.id, { currency: 'USD' });
    assert.equal(usdAccount.currency, 'USD');
    assert.equal(usdAccount.value, 10);
  });

  it('adds payments and subtracts refunds from the snapshot account', () => {
    const account = createAccount(db, { name: 'Касса возвратов', currency: 'UZS' });
    const paymentType = createPaymentType(db, { name: 'Возвратный', account_id: account.id });
    const service = createService(db, {
      name: 'Услуга возврата',
      cost_amount: 0,
      cost_currency: 'UZS',
      price_uzs: 50000,
    });
    const task = addTaskService(db, createTask(db, { title: 'Возврат на счёт', devices: [] }).id, {
      service_id: service.id,
    });
    createTaskPayment(db, task.id, { payment_type_id: paymentType.id, amount: 50000 });
    createTaskRefund(db, task.id, { payment_type_id: paymentType.id, amount: 15000 });
    assert.equal(getAccount(db, account.id).value, 35000);

    const otherAccount = createAccount(db, { name: 'Другая касса', currency: 'UZS' });
    updatePaymentType(db, paymentType.id, { account_id: otherAccount.id });
    assert.equal(getAccount(db, account.id).value, 35000);
    assert.equal(getAccount(db, otherAccount.id).value, 0);
    createTaskPayment(db, task.id, { payment_type_id: paymentType.id, amount: 5000 });
    assert.equal(getAccount(db, account.id).value, 35000);
    assert.equal(getAccount(db, otherAccount.id).value, 5000);
  });

  it('adds in payments and subtracts out payments from the snapshot account', () => {
    const { createAccountPayment, deleteAccountPayment } = require('../src/db/account-payments');
    const account = createAccount(db, { name: 'Касса прихода', currency: 'UZS' });
    createAccountPayment(db, { account_id: account.id, direction: 'in', amount: 80000 });
    createAccountPayment(db, { account_id: account.id, direction: 'out', amount: 20000 });
    assert.equal(getAccount(db, account.id).value, 60000);

    const usdIn = createAccountPayment(db, {
      account_id: account.id,
      direction: 'in',
      amount: 1,
      currency: 'USD',
    });
    assert.equal(getAccount(db, account.id).value, 72500);
    assert.equal(deleteAccountPayment(db, usdIn.id), true);
    assert.equal(getAccount(db, account.id).value, 60000);

    assert.throws(() => deleteAccount(db, account.id), /ACCOUNT_IN_USE/);
  });
});
