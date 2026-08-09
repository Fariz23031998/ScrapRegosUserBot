const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb, createOrder } = require('../src/db/partners-db');
const {
  ensureTechnicalSupportTables,
  getTechnicalSupportStatusByPhone,
  activateTechnicalSupportFromOrder,
  PRODUCT_TYPE,
} = require('../src/db/technical-support');
const { addLink, ensureClientFirmLinksTable } = require('../src/db/client-firm-links');
const { enrichTicketsWithLocalData } = require('../src/admin/ticket-local-enrichment');
const { getFirmCardByTypeAndId } = require('../src/bot/search-user');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-enrich-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('ticket local enrichment', () => {
  let dbPath;
  let db;

  before(() => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    ensureTechnicalSupportTables(db);
    ensureClientFirmLinksTable(db);
  });

  after(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    removeDbFiles(dbPath);
  });

  beforeEach(() => {
    db.exec('DELETE FROM orders');
    db.exec('DELETE FROM technical_support_subscriptions');
    db.exec('DELETE FROM client_firm_links');
    db.exec('DELETE FROM partners');
  });

  it('maps unpaid orders, TS status, and firm links onto tickets', () => {
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1,
      botUserPhone: '998900000001',
      clientPhone: '998973923303',
      amount: 150000,
      currency: 'UZS',
      paymentProvider: 'click',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1,
      botUserPhone: '998900000001',
      clientPhone: '998973923303',
      amount: 50000,
      currency: 'UZS',
      paymentProvider: 'click',
    });

    const paidAt = new Date('2024-01-01T00:00:00.000Z');
    const supportOrder = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1,
      botUserPhone: '998900000001',
      clientPhone: '998973923303',
      amount: 100000,
      currency: 'UZS',
      paymentProvider: 'click',
      metadata: JSON.stringify({ product_type: PRODUCT_TYPE, months: 1 }),
    });
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(
      paidAt.toISOString(),
      supportOrder.id
    );
    const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(supportOrder.id);
    activateTechnicalSupportFromOrder(db, paidOrder, { paidAt });
    db.prepare(
      `UPDATE technical_support_subscriptions
       SET starts_at = '2024-01-01T00:00:00.000Z', ends_at = '2024-02-01T00:00:00.000Z'`
    ).run();

    addLink(db, {
      regos_client_id: 42,
      type: 'partner',
      recordId: 7,
      clientName: 'Acme LLC',
      phone: '998973923303',
    });

    const [enriched] = enrichTicketsWithLocalData(db, [
      {
        id: 1,
        client_id: 42,
        client: { id: 42, name: 'Fariz', phone: '998973923303' },
      },
    ]);

    assert.equal(enriched.local.unpaid_orders.count, 2);
    assert.equal(enriched.local.unpaid_orders.total_amount, 200000);
    assert.equal(enriched.local.technical_support.status, 'expired');
    assert.equal(enriched.local.firms.length, 1);
    assert.equal(enriched.local.firms[0].firm_name, 'Acme LLC');
  });

  it('matches unpaid orders and TS by linked firm phone when ticket phone differs', () => {
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1,
      botUserPhone: '998900000001',
      clientPhone: '998977078756',
      amount: 50000,
      currency: 'UZS',
      paymentProvider: 'click',
    });

    const paidAt = new Date('2024-01-01T00:00:00.000Z');
    const supportOrder = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1,
      botUserPhone: '998900000001',
      clientPhone: '998977078756',
      amount: 100000,
      currency: 'UZS',
      paymentProvider: 'click',
      metadata: JSON.stringify({ product_type: PRODUCT_TYPE, months: 1 }),
    });
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(
      paidAt.toISOString(),
      supportOrder.id
    );
    const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(supportOrder.id);
    activateTechnicalSupportFromOrder(db, paidOrder, { paidAt });
    db.prepare(
      `UPDATE technical_support_subscriptions
       SET starts_at = '2024-01-01T00:00:00.000Z', ends_at = '2024-02-01T00:00:00.000Z'`
    ).run();

    addLink(db, {
      regos_client_id: 3254,
      type: 'partner',
      recordId: 4593,
      clientName: 'Otkir Umarov',
      phone: '998977078756',
    });

    const [enriched] = enrichTicketsWithLocalData(db, [
      {
        id: 10551,
        client_id: 3254,
        client: { id: 3254, name: '977743001', phone: '977743001' },
      },
    ]);

    assert.equal(enriched.local.firms.length, 1);
    assert.equal(enriched.local.firms[0].firm_name, 'Otkir Umarov');
    assert.equal(enriched.local.unpaid_orders.count, 1);
    assert.equal(enriched.local.unpaid_orders.total_amount, 50000);
    assert.equal(enriched.local.unpaid_orders.orders[0].client_phone, '998977078756');
    assert.equal(enriched.local.technical_support.status, 'expired');
  });

  it('returns none TS status when phone has no subscription', () => {
    const status = getTechnicalSupportStatusByPhone(db, '998911111111');
    assert.equal(status.status, 'none');
    assert.equal(status.ends_at, null);
  });

  it('loads a partner firm card by type and id', () => {
    db.prepare(
      `INSERT INTO partners (
         id, name, legal_status, phone, contacts, description, moderation_status,
         balance, registered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(77, 'Demo Partner', 'ООО', '998901112233', '', '', 'ok', 0, '2026-01-01');

    const firm = getFirmCardByTypeAndId(db, 'partner', 77);
    assert.ok(firm);
    assert.equal(firm.type, 'partner');
    assert.equal(Number(firm.recordId), 77);
    assert.match(firm.message, /Demo Partner/);
  });
});
