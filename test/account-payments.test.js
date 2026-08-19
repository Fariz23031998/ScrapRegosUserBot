const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccount } = require('../src/db/accounts');
const {
  createAccountPayment,
  deleteAccountPayment,
  getAccountPayment,
  listAccountPayments,
} = require('../src/db/account-payments');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-account-payments-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('account payments', () => {
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

  it('creates in and out payments on an account', () => {
    const account = createAccount(db, { name: 'Касса финансов', currency: 'UZS' });
    const incoming = createAccountPayment(db, {
      account_id: account.id,
      direction: 'in',
      amount: 100000,
      note: 'Приход',
    });
    assert.equal(incoming.direction, 'in');
    assert.equal(incoming.amount, 100000);
    assert.equal(incoming.currency, 'UZS');
    assert.equal(incoming.amount_uzs, 100000);
    assert.equal(incoming.amount_usd, 8);
    assert.equal(incoming.account_id, account.id);
    assert.equal(incoming.account.name, 'Касса финансов');
    assert.equal(incoming.note, 'Приход');

    const outgoing = createAccountPayment(db, {
      account_id: account.id,
      direction: 'out',
      amount: 25000,
      currency: 'UZS',
    });
    assert.equal(outgoing.direction, 'out');
    assert.equal(outgoing.amount, 25000);
    assert.equal(getAccountPayment(db, outgoing.id).id, outgoing.id);
  });

  it('lists payments filtered by account and direction', () => {
    const first = createAccount(db, { name: 'Фильтр А', currency: 'UZS' });
    const second = createAccount(db, { name: 'Фильтр Б', currency: 'USD' });
    createAccountPayment(db, { account_id: first.id, direction: 'in', amount: 10 });
    createAccountPayment(db, { account_id: first.id, direction: 'out', amount: 4 });
    createAccountPayment(db, { account_id: second.id, direction: 'in', amount: 2, currency: 'USD' });

    const forFirst = listAccountPayments(db, { account_id: first.id });
    assert.equal(forFirst.length, 2);
    assert.ok(forFirst.every((item) => item.account_id === first.id));

    const outs = listAccountPayments(db, { account_id: first.id, direction: 'out' });
    assert.equal(outs.length, 1);
    assert.equal(outs[0].direction, 'out');
    assert.equal(outs[0].amount, 4);
  });

  it('converts USD input onto a UZS account', () => {
    const account = createAccount(db, { name: 'Конвертация', currency: 'UZS' });
    const payment = createAccountPayment(db, {
      account_id: account.id,
      direction: 'in',
      amount: 2,
      currency: 'USD',
    });
    assert.equal(payment.currency, 'USD');
    assert.equal(payment.amount, 2);
    assert.equal(payment.amount_usd, 2);
    assert.equal(payment.amount_uzs, 25000);
  });

  it('rejects invalid input and deletes a payment', () => {
    const account = createAccount(db, { name: 'Удаление', currency: 'UZS' });
    assert.throws(
      () => createAccountPayment(db, { account_id: 999999, direction: 'in', amount: 1 }),
      /INVALID_ACCOUNT_PAYMENT_ACCOUNT/
    );
    assert.throws(
      () => createAccountPayment(db, { account_id: account.id, direction: 'sideways', amount: 1 }),
      /INVALID_ACCOUNT_PAYMENT_DIRECTION/
    );
    assert.throws(
      () => createAccountPayment(db, { account_id: account.id, direction: 'in', amount: 0 }),
      /INVALID_ACCOUNT_PAYMENT_AMOUNT/
    );
    assert.throws(
      () => createAccountPayment(db, { account_id: account.id, direction: 'in', amount: 1, currency: 'EUR' }),
      /INVALID_ACCOUNT_PAYMENT_CURRENCY/
    );

    const payment = createAccountPayment(db, { account_id: account.id, direction: 'in', amount: 15 });
    assert.equal(deleteAccountPayment(db, payment.id), true);
    assert.equal(getAccountPayment(db, payment.id), null);
    assert.equal(deleteAccountPayment(db, payment.id), false);
  });
});
