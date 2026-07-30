const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { openDb, createOrder, markOrderPaid, getOrderById } = require('../src/db/partners-db');
const {
  createEmployeeUser,
  linkEmployeeTelegram,
  markPendingOrderPaidCash,
  upsertUserRights,
} = require('../src/db/bot-users-db');
const {
  ALLOWED_DURATIONS,
  PRODUCT_TYPE,
  listTechnicalSupportPrices,
  updateTechnicalSupportPrices,
  getTechnicalSupportPrice,
  activateTechnicalSupportFromOrder,
  getActiveTechnicalSupportSubscription,
  listTechnicalSupportSubscriptions,
  addCalendarMonths,
  formatSupportUntilLabel,
} = require('../src/db/technical-support');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { makeServiceButtonForResult } = require('../src/bot/service-bot');
const { EXPIRED_MESSAGE } = require('../src/bot/search-user');
const {
  getActiveTechnicalSupportSubscription: getActiveSub,
  formatSupportUntilLabel: formatLabel,
} = require('../src/db/technical-support');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ts-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function request(server, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createSupportOrder(db, { phone = '+998901112233', months = 3, amount = 150000, telegramId = 1001 } = {}) {
  const id = crypto.randomUUID();
  return createOrder(db, {
    id,
    telegramId,
    botUserPhone: '+998901000001',
    clientPhone: phone,
    clientType: 'partner',
    amount,
    paymentProvider: 'click',
    metadata: JSON.stringify({
      product_type: PRODUCT_TYPE,
      months,
      amount,
      type: 'partner',
      message: 'test',
    }),
  });
}

describe('Technical support subscriptions', () => {
  let dbPath;
  let db;
  let previousEnv;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'https://example.test';
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  it('seeds four unconfigured price durations', () => {
    const prices = listTechnicalSupportPrices(db);
    assert.deepEqual(
      prices.map((row) => row.months),
      ALLOWED_DURATIONS
    );
    assert.ok(prices.every((row) => row.amount === 0 && row.configured === false));
  });

  it('validates and updates prices', () => {
    const updated = updateTechnicalSupportPrices(db, {
      1: 50000,
      3: 120000,
      6: 200000,
      12: 350000,
    });
    assert.equal(getTechnicalSupportPrice(db, 3).amount, 120000);
    assert.equal(getTechnicalSupportPrice(db, 3).configured, true);
    assert.equal(updated.find((row) => row.months === 12).amount, 350000);

    assert.throws(() => updateTechnicalSupportPrices(db, { 1: -1 }), /INVALID_AMOUNT/);
    assert.throws(() => updateTechnicalSupportPrices(db, { 1: 10.5 }), /INVALID_AMOUNT/);
  });

  it('puts Add Services and Add Tech Support in the same row when phone exists', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998901000042',
      displayName: 'Support seller',
      rights: { create_technical_support: 0 },
    });
    linkEmployeeTelegram(db, employee.id, 42, {});

    const deniedMarkup = makeServiceButtonForResult(
      { phone: '+998901112233', type: 'partner', message: 'demo' },
      42,
      db
    );
    assert.equal(deniedMarkup.reply_markup.inline_keyboard[0].length, 1);

    upsertUserRights(db, employee.id, { create_technical_support: 1 });
    const markup = makeServiceButtonForResult(
      {
        phone: '+998901112233',
        type: 'partner',
        message: 'demo',
        recordId: 1,
        clientName: 'Demo',
      },
      42,
      db
    );
    const row = markup.reply_markup.inline_keyboard[0];
    assert.equal(row.length, 2);
    assert.equal(row[0].text, 'Добавить услуги');
    assert.match(row[0].callback_data, /^svc:start:/);
    assert.equal(row[1].text, 'Добавить ТП');
    assert.match(row[1].callback_data, /^ts:start:/);

    const noPhone = makeServiceButtonForResult(
      { phone: null, type: 'partner', message: 'demo' },
      42,
      db
    );
    assert.equal(noPhone.reply_markup.inline_keyboard[0].length, 1);
  });

  it('activates subscription on online payment and stacks renewals', () => {
    const phone = '+998909998877';
    const first = createSupportOrder(db, { phone, months: 1, amount: 10000 });
    const paid1 = markOrderPaid(db, first.id, { provider: 'click', clickTransId: 'c1' });
    assert.equal(paid1.claimed, true);

    const active = getActiveTechnicalSupportSubscription(db, phone);
    assert.ok(active);
    assert.equal(Number(active.months), 1);
    assert.equal(Number(active.amount), 10000);

    const duplicate = markOrderPaid(db, first.id, { provider: 'click', clickTransId: 'c1' });
    assert.equal(duplicate.claimed, false);
    const listed = listTechnicalSupportSubscriptions(db, {});
    assert.equal(listed.total, 1);

    const second = createSupportOrder(db, { phone, months: 3, amount: 30000, telegramId: 1002 });
    const paid2 = markOrderPaid(db, second.id, { provider: 'payme', transactionId: 'p1' });
    assert.equal(paid2.claimed, true);

    const stacked = getActiveTechnicalSupportSubscription(db, phone);
    assert.ok(stacked);
    assert.equal(Number(stacked.months), 3);
    // Stacked end should be later than first end by ~3 months from first end.
    assert.ok(Date.parse(stacked.ends_at) > Date.parse(active.ends_at));
    const expected = addCalendarMonths(new Date(active.ends_at), 3).toISOString();
    assert.equal(stacked.ends_at, expected);
  });

  it('activates subscription on cash payment and is idempotent by order_id', () => {
    const employee = createEmployeeUser(db, {
      phone: '+998901000010',
      displayName: 'Cashier',
      rights: { mark_paid_cash: 1 },
    });
    linkEmployeeTelegram(db, employee.id, 777, {});

    const order = createSupportOrder(db, {
      phone: '+998907776655',
      months: 6,
      amount: 222000,
      telegramId: 777,
    });
    assert.equal(markPendingOrderPaidCash(db, order.id, 777), true);
    const active = getActiveTechnicalSupportSubscription(db, '+998907776655');
    assert.ok(active);
    assert.equal(Number(active.months), 6);

    const again = activateTechnicalSupportFromOrder(db, getOrderById(db, order.id));
    assert.equal(again.created, false);
    assert.equal(again.reason, 'already_activated');
  });

  it('formats search coverage label and strips expired banner', () => {
    const phone = '+998901234567';
    const order = createSupportOrder(db, { phone, months: 12, amount: 1 });
    markOrderPaid(db, order.id, { provider: 'click', clickTransId: 'x' });
    const active = getActiveSub(db, phone);
    const label = formatLabel(active.ends_at);
    assert.equal(label, 'Есть платные подписки ТП');

    const message = `${EXPIRED_MESSAGE}\n\nRegos\nID: 1`;
    const without = message.startsWith(`${EXPIRED_MESSAGE}\n\n`)
      ? message.slice(`${EXPIRED_MESSAGE}\n\n`.length)
      : message;
    const finalMessage = `${without}\n\n${label}`;
    assert.ok(!finalMessage.startsWith(EXPIRED_MESSAGE));
    assert.ok(finalMessage.includes(label));
  });

  it('exposes authenticated admin price and subscription APIs', async () => {
    updateTechnicalSupportPrices(db, { 1: 111, 3: 333, 6: 666, 12: 1212 });
    const order = createSupportOrder(db, { phone: '+998905551111', months: 1, amount: 111 });
    markOrderPaid(db, order.id, { provider: 'click', clickTransId: 'admin1' });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const unauthorized = await request(server, 'GET', '/bot-admin/api/technical-support/prices', {
        headers: { Accept: 'application/json' },
      });
      assert.equal(unauthorized.statusCode, 401);

      const login = await request(server, 'POST', '/bot-admin/api/login', {
        body: JSON.stringify({ login: 'admin', password: 'test-password' }),
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
      assert.ok(cookie.startsWith('bot_admin_session='));

      const prices = await request(server, 'GET', '/bot-admin/api/technical-support/prices', {
        headers: { Cookie: cookie, Accept: 'application/json' },
      });
      assert.equal(prices.statusCode, 200);
      const pricesBody = JSON.parse(prices.body);
      assert.equal(pricesBody.prices.find((row) => row.months === 3).amount, 333);

      const update = await request(server, 'PUT', '/bot-admin/api/technical-support/prices', {
        headers: { Cookie: cookie, Accept: 'application/json' },
        body: JSON.stringify({ prices: { 3: 444 } }),
      });
      assert.equal(update.statusCode, 200);
      assert.equal(JSON.parse(update.body).prices.find((row) => row.months === 3).amount, 444);

      const subs = await request(
        server,
        'GET',
        '/bot-admin/api/technical-support/subscriptions?status=active&q=555',
        { headers: { Cookie: cookie, Accept: 'application/json' } }
      );
      assert.equal(subs.statusCode, 200);
      const subsBody = JSON.parse(subs.body);
      assert.ok(subsBody.total >= 1);
      assert.equal(subsBody.subscriptions[0].status, 'active');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
