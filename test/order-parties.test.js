const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { openDb, createOrder } = require('../src/db/partners-db');
const {
  createEmployeeUser,
  linkEmployeeTelegram,
  registerCustomer,
} = require('../src/db/bot-users-db');
const {
  formatTelegramPhone,
  enrichOrderParties,
  formatOrderPartyLines,
} = require('../src/bot/order-parties');
const { formatUnpaidOrderMessage } = require('../src/bot/bot-format');
const { formatOrderPaidMessage } = require('../src/bot/payment-notification');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-order-parties-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore missing files
    }
  }
}

describe('Telegram order party details', () => {
  let db;
  let dbPath;

  beforeEach(() => {
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
  });

  it('formats Uzbek phone numbers for Telegram messages', () => {
    assert.equal(formatTelegramPhone('+998993332323'), '+998 (99) 333-23-23');
    assert.equal(formatTelegramPhone('993332323'), '+998 (99) 333-23-23');
    assert.equal(formatTelegramPhone('other'), 'other');
  });

  it('resolves employee and customer names and phones', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998993332323',
      displayName: 'John',
      rights: {},
    });
    linkEmployeeTelegram(db, employee.id, 7001, {
      username: 'john',
      firstName: 'John',
      lastName: 'Smith',
    });
    registerCustomer(db, {
      telegramId: 7002,
      phone: '+998901112233',
      username: 'jane',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    const order = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 7001,
      botUserPhone: '+998993332323',
      clientPhone: '+998901112233',
      clientType: 'partner',
      amount: 50000,
      paymentProvider: 'payme',
      metadata: JSON.stringify({ clientName: 'Acme Customer' }),
    });

    const detailed = enrichOrderParties(db, order);
    assert.deepEqual(formatOrderPartyLines(detailed), [
      'Сотрудник: John - +998 (99) 333-23-23',
      'Клиент: Acme Customer - +998 (90) 111-22-33',
    ]);

    const unpaid = formatUnpaidOrderMessage(detailed);
    assert.match(unpaid, /Сотрудник: John - \+998 \(99\) 333-23-23/);
    assert.match(unpaid, /Клиент: Acme Customer - \+998 \(90\) 111-22-33/);

    const paid = formatOrderPaidMessage(detailed, { provider: 'payme' });
    assert.match(paid, /Сотрудник: John - \+998 \(99\) 333-23-23/);
    assert.match(paid, /Клиент: Acme Customer - \+998 \(90\) 111-22-33/);
  });

  it('falls back to Telegram profile and stored order phones', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998971234567',
      displayName: '',
      rights: {},
    });
    linkEmployeeTelegram(db, employee.id, 8001, {
      username: 'operator',
      firstName: 'Alex',
      lastName: 'Kim',
    });

    const order = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 8001,
      botUserPhone: '+998971234567',
      clientPhone: '+998935556677',
      clientType: 'partner',
      amount: 1000,
      paymentProvider: 'payme',
      metadata: null,
    });

    const detailed = enrichOrderParties(db, order);
    assert.deepEqual(formatOrderPartyLines(detailed), [
      'Сотрудник: Alex Kim - +998 (97) 123-45-67',
      'Клиент: Имя не указано - +998 (93) 555-66-77',
    ]);
  });
});
