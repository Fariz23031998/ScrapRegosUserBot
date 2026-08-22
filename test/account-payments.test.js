const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccount, getAccount } = require('../src/db/accounts');
const {
  createAccountPayment,
  deleteAccountPayment,
  getAccountPayment,
  listAccountPayments,
  updateAccountPayment,
} = require('../src/db/account-payments');
const { createCatalogCategory } = require('../src/db/catalog-categories');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createLocation } = require('../src/db/locations');
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

  it('assigns a category and filters payments by it', () => {
    const account = createAccount(db, { name: 'Категории платежей', currency: 'UZS' });
    const category = createCatalogCategory(db, 'finance', { name: 'Закупка' });
    const categorized = createAccountPayment(db, {
      account_id: account.id,
      direction: 'out',
      amount: 40,
      category_id: category.id,
    });
    createAccountPayment(db, { account_id: account.id, direction: 'in', amount: 10 });

    assert.equal(categorized.category_id, category.id);
    assert.equal(categorized.category.name, 'Закупка');
    assert.equal(listAccountPayments(db, { account_id: account.id, category_id: category.id }).length, 1);
    assert.equal(listAccountPayments(db, { account_id: account.id, category_id: 'none' }).length, 1);

    assert.throws(
      () =>
        createAccountPayment(db, {
          account_id: account.id,
          direction: 'in',
          amount: 1,
          category_id: 999999,
        }),
      /INVALID_FINANCE_CATEGORY/
    );
  });

  it('assigns a location and filters payments by it', () => {
    const employee = createEmployeeUser(db, { phone: '+998901000091', displayName: 'Кассир' });
    const office = createLocation(db, { name: 'Офис Чиланзар', allowed_user_ids: [employee.id] });
    const account = createAccount(db, { name: 'Касса филиала', currency: 'UZS' });
    const tagged = createAccountPayment(db, {
      account_id: account.id,
      direction: 'out',
      amount: 30,
      location_id: office.id,
    });
    createAccountPayment(db, { account_id: account.id, direction: 'in', amount: 8 });

    assert.equal(tagged.location_id, office.id);
    assert.equal(tagged.location.name, 'Офис Чиланзар');
    assert.equal(listAccountPayments(db, { account_id: account.id, location_id: office.id }).length, 1);
    assert.equal(listAccountPayments(db, { account_id: account.id, location_id: 'none' }).length, 1);

    assert.throws(
      () =>
        createAccountPayment(db, {
          account_id: account.id,
          direction: 'in',
          amount: 1,
          location_id: 999999,
        }),
      /INVALID_ACCOUNT_PAYMENT_LOCATION/
    );
  });

  it('stores a chosen created_at and updates a payment', () => {
    const first = createAccount(db, { name: 'Редактирование А', currency: 'UZS' });
    const second = createAccount(db, { name: 'Редактирование Б', currency: 'UZS' });
    const payment = createAccountPayment(db, {
      account_id: first.id,
      direction: 'in',
      amount: 100,
      note: 'Старый',
      created_at: '2024-01-15T10:30:00.000Z',
    });
    assert.equal(payment.created_at, '2024-01-15 10:30:00');
    assert.equal(getAccount(db, first.id).value, 100);

    const updated = updateAccountPayment(db, payment.id, {
      account_id: second.id,
      direction: 'out',
      amount: 40,
      note: 'Новый',
      created_at: '2024-02-01T08:15:00.000Z',
    });
    assert.equal(updated.account_id, second.id);
    assert.equal(updated.direction, 'out');
    assert.equal(updated.amount, 40);
    assert.equal(updated.note, 'Новый');
    assert.equal(updated.created_at, '2024-02-01 08:15:00');
    assert.equal(getAccount(db, first.id).value, 0);
    assert.equal(getAccount(db, second.id).value, -40);

    assert.throws(
      () => createAccountPayment(db, { account_id: first.id, direction: 'in', amount: 1, created_at: 'not-a-date' }),
      /INVALID_ACCOUNT_PAYMENT_CREATED_AT/
    );
    assert.throws(
      () => updateAccountPayment(db, updated.id, { created_at: 'not-a-date' }),
      /INVALID_ACCOUNT_PAYMENT_CREATED_AT/
    );
    assert.throws(() => updateAccountPayment(db, 999999, { amount: 1 }), /NOT_FOUND/);
  });
});
