const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { openDb, createOrder, markOrderPaid } = require('../src/db/partners-db');
const {
  createEmployeeUser,
  linkEmployeeTelegram,
  registerCustomer,
  deletePendingOrder,
  markPendingOrderPaidCash,
} = require('../src/db/bot-users-db');
const {
  formatTelegramPhone,
  enrichOrderParties,
  formatOrderPartyLines,
} = require('../src/bot/order-parties');
const {
  formatOrderDateTimeValue,
  formatOrderDateTimeLine,
} = require('../src/bot/order-datetime');
const { formatUnpaidOrderMessage } = require('../src/bot/bot-format');
const { formatOrderPaidMessage } = require('../src/bot/payment-notification');
const { listOrderLogs, mapOrderLogRow } = require('../src/db/order-logs');

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
      '👤 <b>Сотрудник:</b> John - +998 (99) 333-23-23',
      '👥 <b>Клиент:</b> Acme Customer - +998 (90) 111-22-33',
    ]);
    assert.doesNotMatch(formatUnpaidOrderMessage(detailed), /Доп\. номер:/);

    const unpaid = formatUnpaidOrderMessage(detailed);
    assert.match(unpaid, /👤 <b>Сотрудник:<\/b> John - \+998 \(99\) 333-23-23/);
    assert.match(unpaid, /👥 <b>Клиент:<\/b> Acme Customer - \+998 \(90\) 111-22-33/);
    assert.match(unpaid, /^📅 <b>Дата заказа:<\/b> \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/m);
    assert.equal(
      formatOrderDateTimeLine(detailed),
      `📅 <b>Дата заказа:</b> ${formatOrderDateTimeValue(detailed.created_at)}`
    );

    const paid = formatOrderPaidMessage(detailed, { provider: 'payme' });
    assert.match(paid, /✅ <b>Заказ оплачен\.<\/b>/);
    assert.match(paid, /👤 <b>Сотрудник:<\/b> John - \+998 \(99\) 333-23-23/);
    assert.match(paid, /👥 <b>Клиент:<\/b> Acme Customer - \+998 \(90\) 111-22-33/);
    assert.match(paid, /^📅 <b>Дата заказа:<\/b> \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/m);
    assert.doesNotMatch(paid, /Доп\. номер:/);
  });

  it('shows additional phone in Telegram messages and order logs', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998993332323',
      displayName: 'John',
      rights: {},
    });
    linkEmployeeTelegram(db, employee.id, 7003, {
      username: 'john2',
      firstName: 'John',
      lastName: 'Smith',
    });

    const order = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 7003,
      botUserPhone: '+998993332323',
      clientPhone: '+998901112233',
      clientType: 'partner',
      additionalPhone: '+998935554433',
      amount: 25000,
      paymentProvider: 'payme',
      metadata: JSON.stringify({ clientName: 'Acme Customer' }),
    });

    const detailed = enrichOrderParties(db, order);
    assert.deepEqual(formatOrderPartyLines(detailed), [
      '👤 <b>Сотрудник:</b> John - +998 (99) 333-23-23',
      '👥 <b>Клиент:</b> Acme Customer - +998 (90) 111-22-33',
      '📱 <b>Доп. номер:</b> +998 (93) 555-44-33',
    ]);

    const unpaid = formatUnpaidOrderMessage(detailed);
    assert.match(unpaid, /^📱 <b>Доп\. номер:<\/b> \+998 \(93\) 555-44-33$/m);

    const paid = formatOrderPaidMessage(detailed, { provider: 'payme' });
    assert.match(paid, /^📱 <b>Доп\. номер:<\/b> \+998 \(93\) 555-44-33$/m);

    const createdLogs = listOrderLogs(db, { query: '5554433' });
    assert.equal(createdLogs.total, 1);
    assert.equal(mapOrderLogRow(createdLogs.logs[0]).additional_phone, '+998935554433');
    assert.equal(mapOrderLogRow(createdLogs.logs[0]).action, 'created');
    assert.equal(mapOrderLogRow(createdLogs.logs[0]).payment_provider, null);

    deletePendingOrder(db, order.id, 7003);
    const deletedLogs = listOrderLogs(db, { query: order.id });
    const deleted = deletedLogs.logs.find((row) => row.action === 'deleted');
    assert.ok(deleted);
    assert.equal(mapOrderLogRow(deleted).additional_phone, '+998935554433');
  });

  it('logs additional phone and payment type after online and cash payment', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998993332323',
      displayName: 'John',
      rights: { mark_paid_cash: 1 },
    });
    linkEmployeeTelegram(db, employee.id, 7004, {
      username: 'john3',
      firstName: 'John',
      lastName: 'Smith',
    });

    const onlineOrder = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 7004,
      botUserPhone: '+998993332323',
      clientPhone: '+998901112233',
      clientType: 'partner',
      additionalPhone: '+998911112233',
      amount: 12000,
      paymentProvider: 'payme',
      metadata: null,
    });

    const { claimed } = markOrderPaid(db, onlineOrder.id, {
      provider: 'payme',
      transactionId: 'payme-tx-1',
    });
    assert.equal(claimed, true);

    const paidLogs = listOrderLogs(db, { query: onlineOrder.id });
    const paid = paidLogs.logs.find((row) => row.action === 'paid');
    assert.ok(paid);
    const paidMapped = mapOrderLogRow(paid);
    assert.equal(paidMapped.additional_phone, '+998911112233');
    assert.equal(paidMapped.payment_provider, 'payme');
    assert.equal(paidMapped.payment_provider_label, 'Payme');
    assert.equal(paidMapped.action_label, 'Оплачен');

    const cashOrder = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 7004,
      botUserPhone: '+998993332323',
      clientPhone: '+998901112233',
      clientType: 'partner',
      additionalPhone: '+998922223344',
      amount: 15000,
      paymentProvider: 'payme',
      metadata: null,
    });
    assert.equal(markPendingOrderPaidCash(db, cashOrder.id, 7004), true);

    const cashLogs = listOrderLogs(db, { query: cashOrder.id });
    const cashPaid = cashLogs.logs.find((row) => row.action === 'paid_cash');
    assert.ok(cashPaid);
    const cashMapped = mapOrderLogRow(cashPaid);
    assert.equal(cashMapped.additional_phone, '+998922223344');
    assert.equal(cashMapped.payment_provider, 'cash');
    assert.equal(cashMapped.payment_provider_label, 'Наличные');

    const byProvider = listOrderLogs(db, { query: 'Payme' });
    assert.ok(byProvider.logs.some((row) => row.order_id === onlineOrder.id && row.action === 'paid'));
  });

  it('formats order datetime in Asia/Tashkent as dd.MM.yyyy HH:mm', () => {
    assert.equal(formatOrderDateTimeValue('2026-07-30 16:05:00'), '30.07.2026 21:05');
    assert.equal(formatOrderDateTimeValue('2026-01-15 20:30:00'), '16.01.2026 01:30');
    assert.equal(formatOrderDateTimeLine({ created_at: '2026-07-30 16:05:00' }), '📅 <b>Дата заказа:</b> 30.07.2026 21:05');
    assert.equal(formatOrderDateTimeValue(null), null);
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
      '👤 <b>Сотрудник:</b> Alex Kim - +998 (97) 123-45-67',
      '👥 <b>Клиент:</b> Имя не указано - +998 (93) 555-66-77',
    ]);
  });
});
