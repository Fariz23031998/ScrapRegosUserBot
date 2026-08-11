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
  createManualTechnicalSupportSubscription,
  deactivateTechnicalSupportSubscription,
  updateTechnicalSupportSubscriptionEndsAt,
  deleteTechnicalSupportSubscription,
  mapSubscriptionRow,
  addCalendarMonths,
  formatSupportUntilLabel,
} = require('../src/db/technical-support');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createDashboardLoginToken } = require('../src/admin/dashboard-login-tokens');
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

function cookieFromSetCookie(setCookie) {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) return null;
  return String(raw).split(';')[0];
}

function request(server, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
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
    assert.match(label, /^Есть платные подписки ТП\n📅 До: \d{2}\.\d{2}\.\d{4}$/);
    const expectedDate = new Date(active.ends_at).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    assert.equal(label, `Есть платные подписки ТП\n📅 До: ${expectedDate}`);

    const message = `${EXPIRED_MESSAGE}\n\nRegos\nID: 1`;
    const without = message.startsWith(`${EXPIRED_MESSAGE}\n\n`)
      ? message.slice(`${EXPIRED_MESSAGE}\n\n`.length)
      : message;
    const finalMessage = `${without}\n\n${label}`;
    assert.ok(!finalMessage.startsWith(EXPIRED_MESSAGE));
    assert.ok(finalMessage.includes('Есть платные подписки ТП'));
    assert.ok(finalMessage.includes(`📅 До: ${expectedDate}`));
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

  it('manually creates, stacks, deactivates, edits ends_at, and deletes subscriptions', () => {
    const phone = '+998901234000';
    const first = createManualTechnicalSupportSubscription(db, {
      phone,
      months: 1,
      amount: 0,
    });
    assert.equal(first.created, true);
    assert.match(first.subscription.order_id, /^manual:/);
    assert.equal(Number(first.subscription.months), 1);

    const active = getActiveTechnicalSupportSubscription(db, phone);
    assert.ok(active);
    assert.equal(active.id, first.subscription.id);

    const second = createManualTechnicalSupportSubscription(db, {
      phone,
      months: 3,
      amount: 5000,
    });
    assert.equal(second.created, true);
    assert.equal(second.subscription.starts_at, first.subscription.ends_at);
    const expectedEnd = addCalendarMonths(new Date(first.subscription.ends_at), 3).toISOString();
    assert.equal(second.subscription.ends_at, expectedEnd);

    const stacked = getActiveTechnicalSupportSubscription(db, phone);
    assert.equal(stacked.id, second.subscription.id);

    const deactivated = deactivateTechnicalSupportSubscription(db, second.subscription.id);
    assert.equal(deactivated.changed, true);
    assert.equal(mapSubscriptionRow(deactivated.subscription).status, 'expired');
    assert.equal(getActiveTechnicalSupportSubscription(db, phone)?.id, first.subscription.id);

    const again = deactivateTechnicalSupportSubscription(db, second.subscription.id);
    assert.equal(again.changed, false);
    assert.equal(again.reason, 'already_expired');

    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const extended = updateTechnicalSupportSubscriptionEndsAt(db, first.subscription.id, future);
    assert.equal(Number(extended.subscription.months), 0);
    assert.equal(mapSubscriptionRow(extended.subscription).status, 'active');
    assert.equal(extended.subscription.ends_at, new Date(future).toISOString());

    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const shortened = updateTechnicalSupportSubscriptionEndsAt(db, first.subscription.id, past);
    assert.equal(Number(shortened.subscription.months), 0);
    assert.equal(mapSubscriptionRow(shortened.subscription).status, 'expired');
    assert.equal(getActiveTechnicalSupportSubscription(db, phone), null);

    assert.throws(
      () => createManualTechnicalSupportSubscription(db, { phone: '', months: 1 }),
      /INVALID_PHONE/
    );
    assert.throws(
      () => createManualTechnicalSupportSubscription(db, { phone, months: 2 }),
      /INVALID_MONTHS/
    );
    assert.throws(
      () =>
        createManualTechnicalSupportSubscription(db, {
          phone: '+998901234001',
          months: 1,
          ends_at: new Date(Date.now() - 60 * 1000).toISOString(),
        }),
      /INVALID_ENDS_AT/
    );

    const customEnd = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
    const custom = createManualTechnicalSupportSubscription(db, {
      phone: '+998901234002',
      months: 0,
      ends_at: customEnd,
    });
    assert.equal(custom.created, true);
    assert.equal(Number(custom.subscription.months), 0);
    assert.equal(custom.subscription.ends_at, new Date(customEnd).toISOString());
    assert.equal(mapSubscriptionRow(custom.subscription).status, 'active');

    assert.throws(
      () => updateTechnicalSupportSubscriptionEndsAt(db, first.subscription.id, 'not-a-date'),
      /INVALID_ENDS_AT/
    );
    assert.throws(() => deleteTechnicalSupportSubscription(db, 999999), /NOT_FOUND/);

    const deleted = deleteTechnicalSupportSubscription(db, first.subscription.id);
    assert.equal(deleted.deleted, true);
    const remaining = listTechnicalSupportSubscriptions(db, {});
    assert.equal(remaining.total, 2);
    assert.ok(remaining.items.every((row) => row.id !== first.subscription.id));
  });

  it('requires matching technical_support rights for subscription management APIs', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    async function loginEmployee(rights) {
      const telegramId = 800000 + Math.floor(Math.random() * 100000);
      const employee = createEmployeeUser(db, {
        phone: `+99890${String(telegramId).slice(-7)}`,
        displayName: 'TS Tester',
        rights: { open_admin_dashboard: 1, ...rights },
      });
      linkEmployeeTelegram(db, employee.id, telegramId, {});
      const token = createDashboardLoginToken(db, telegramId).rawToken;
      const auth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(token)}`
      );
      assert.equal(auth.statusCode, 302);
      const cookie = cookieFromSetCookie(auth.headers['set-cookie']);
      assert.ok(cookie);
      return cookie;
    }

    try {
      const readOnly = await loginEmployee({ technical_support_read: 1 });
      const listOk = await request(server, 'GET', '/bot-admin/api/technical-support/subscriptions', {
        headers: { Cookie: readOnly },
      });
      assert.equal(listOk.statusCode, 200);

      const createDenied = await request(server, 'POST', '/bot-admin/api/technical-support/subscriptions', {
        headers: { Cookie: readOnly },
        body: { phone: '+998909990001', months: 1, amount: 0 },
      });
      assert.equal(createDenied.statusCode, 403);

      const creator = await loginEmployee({
        technical_support_read: 1,
        technical_support_create: 1,
      });
      const created = await request(server, 'POST', '/bot-admin/api/technical-support/subscriptions', {
        headers: { Cookie: creator },
        body: { phone: '+998909990002', months: 1, amount: 0 },
      });
      assert.equal(created.statusCode, 201);
      const subscription = JSON.parse(created.body).subscription;
      assert.equal(subscription.status, 'active');
      assert.match(subscription.order_id, /^manual:/);

      const deactivateDenied = await request(
        server,
        'POST',
        `/bot-admin/api/technical-support/subscriptions/${subscription.id}/deactivate`,
        { headers: { Cookie: creator } }
      );
      assert.equal(deactivateDenied.statusCode, 403);

      const editor = await loginEmployee({
        technical_support_read: 1,
        technical_support_edit: 1,
      });
      const deactivated = await request(
        server,
        'POST',
        `/bot-admin/api/technical-support/subscriptions/${subscription.id}/deactivate`,
        { headers: { Cookie: editor } }
      );
      assert.equal(deactivated.statusCode, 200);
      assert.equal(JSON.parse(deactivated.body).subscription.status, 'expired');

      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      const edited = await request(
        server,
        'PUT',
        `/bot-admin/api/technical-support/subscriptions/${subscription.id}`,
        { headers: { Cookie: editor }, body: { ends_at: future } }
      );
      assert.equal(edited.statusCode, 200);
      assert.equal(JSON.parse(edited.body).subscription.status, 'active');

      const deleteDenied = await request(
        server,
        'DELETE',
        `/bot-admin/api/technical-support/subscriptions/${subscription.id}`,
        { headers: { Cookie: editor } }
      );
      assert.equal(deleteDenied.statusCode, 403);

      const deleter = await loginEmployee({
        technical_support_read: 1,
        technical_support_delete: 1,
      });
      const deleted = await request(
        server,
        'DELETE',
        `/bot-admin/api/technical-support/subscriptions/${subscription.id}`,
        { headers: { Cookie: deleter } }
      );
      assert.equal(deleted.statusCode, 200);
      assert.equal(JSON.parse(deleted.body).deleted, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
