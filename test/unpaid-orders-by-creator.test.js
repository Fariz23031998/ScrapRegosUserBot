const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  openDb,
  createOrder,
  markOrderPaid,
  getUnpaidOrdersByCreatorTelegramId,
} = require('../src/db/partners-db');
const { deletePendingOrder } = require('../src/db/bot-users-db');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-orders-by-creator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function makeOrder(db, { telegramId, status = 'pending', clientPhone = '+998901112233' }) {
  const order = createOrder(db, {
    id: crypto.randomUUID(),
    telegramId,
    botUserPhone: `+99899${String(telegramId).slice(-7).padStart(7, '0')}`,
    clientPhone,
    clientType: 'partner',
    amount: 10000,
    paymentProvider: 'payme',
    metadata: null,
  });

  if (status === 'paid') {
    markOrderPaid(db, order.id, { provider: 'payme', transactionId: `tx-${order.id}` });
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  }
  if (status === 'deleted') {
    deletePendingOrder(db, order.id, telegramId);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  }
  return order;
}

describe('getUnpaidOrdersByCreatorTelegramId', () => {
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

  it('returns only pending orders created by the requested employee', () => {
    const minePending = makeOrder(db, { telegramId: 1001 });
    makeOrder(db, { telegramId: 1001, status: 'paid' });
    makeOrder(db, { telegramId: 1001, status: 'deleted' });
    makeOrder(db, { telegramId: 2002 });

    const orders = getUnpaidOrdersByCreatorTelegramId(db, 1001);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, minePending.id);
    assert.equal(orders[0].telegram_id, 1001);
    assert.equal(orders[0].status, 'pending');
  });

  it('returns an empty list for missing telegram id', () => {
    makeOrder(db, { telegramId: 1001 });
    assert.deepEqual(getUnpaidOrdersByCreatorTelegramId(db, null), []);
    assert.deepEqual(getUnpaidOrdersByCreatorTelegramId(db, undefined), []);
  });

  it('orders results newest first', () => {
    const older = makeOrder(db, { telegramId: 1001, clientPhone: '+998901111111' });
    const newer = makeOrder(db, { telegramId: 1001, clientPhone: '+998902222222' });

    db.prepare("UPDATE orders SET created_at = '2026-01-01 10:00:00' WHERE id = ?").run(older.id);
    db.prepare("UPDATE orders SET created_at = '2026-01-02 10:00:00' WHERE id = ?").run(newer.id);

    const orders = getUnpaidOrdersByCreatorTelegramId(db, 1001);
    assert.deepEqual(
      orders.map((row) => row.id),
      [newer.id, older.id]
    );
  });
});
