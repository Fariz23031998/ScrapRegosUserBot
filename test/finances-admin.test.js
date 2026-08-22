const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createAccount } = require('../src/db/accounts');
const { createEmployeeUser, DEFAULT_RIGHTS } = require('../src/db/bot-users-db');
const { createLocation } = require('../src/db/locations');
const { listAdminAuditLogs } = require('../src/db/admin-audit-logs');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');
const { ADMIN_PERMISSION_KEYS, RIGHTS } = require('../src/db/user-rights');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-finances-admin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function cookieFromSetCookie(headerValue) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part) => String(part).trim())
    .find((part) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}

function request(server, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('finances admin API', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    setUsdUzsRate(db, 12500);
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const created = http.createServer(app);
      created.listen(0, '127.0.0.1', () => resolve(created));
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  async function login(loginName, password) {
    const res = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login: loginName, password },
    });
    assert.equal(res.statusCode, 200);
    const cookie = cookieFromSetCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  it('creates in and out payments, lists them, and deletes with audit', async () => {
    const cookie = await login('admin', 'test-password');
    const account = createAccount(db, { name: 'Касса API', currency: 'UZS' });

    const listedAccounts = await request(server, 'GET', '/bot-admin/api/finances/accounts', {
      headers: { Cookie: cookie },
    });
    assert.equal(listedAccounts.statusCode, 200);
    const accountsBody = JSON.parse(listedAccounts.body);
    assert.ok(accountsBody.accounts.some((item) => item.id === account.id));

    const createdIn = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: { account_id: account.id, direction: 'in', amount: 50000, note: 'Приход' },
    });
    assert.equal(createdIn.statusCode, 201);
    const inBody = JSON.parse(createdIn.body);
    assert.equal(inBody.payment.direction, 'in');
    assert.equal(inBody.payment.amount, 50000);
    assert.equal(inBody.account.value, 50000);

    const createdOut = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: { account_id: account.id, direction: 'out', amount: 12000 },
    });
    assert.equal(createdOut.statusCode, 201);
    const outBody = JSON.parse(createdOut.body);
    assert.equal(outBody.account.value, 38000);

    const listed = await request(
      server,
      'GET',
      `/bot-admin/api/finances/payments?account_id=${account.id}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(listed.statusCode, 200);
    const payments = JSON.parse(listed.body).payments;
    assert.equal(payments.length, 2);

    const deleted = await request(
      server,
      'DELETE',
      `/bot-admin/api/finances/payments/${outBody.payment.id}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(deleted.statusCode, 200);
    const deletedBody = JSON.parse(deleted.body);
    assert.equal(deletedBody.ok, true);
    assert.equal(deletedBody.account.value, 50000);

    const logs = listAdminAuditLogs(db, { limit: 20 });
    const actions = logs.logs.map((row) => `${row.entity_type}:${row.action}`);
    assert.ok(actions.includes('account_payment:create'));
    assert.ok(actions.includes('account_payment:delete'));
  });

  it('requires finances rights', async () => {
    createEmployeeUser(db, {
      phone: '+998901000081',
      displayName: 'Читатель',
      adminLogin: 'reader',
      password: 'reader-secret',
      rights: { open_admin_dashboard: 1, finances_read: 1 },
    });
    createEmployeeUser(db, {
      phone: '+998901000082',
      displayName: 'Гость',
      adminLogin: 'guest',
      password: 'guest-secret',
      rights: { open_admin_dashboard: 1 },
    });

    const guestCookie = await login('guest', 'guest-secret');
    const forbidden = await request(server, 'GET', '/bot-admin/api/finances/accounts', {
      headers: { Cookie: guestCookie },
    });
    assert.equal(forbidden.statusCode, 403);

    const readerCookie = await login('reader', 'reader-secret');
    const allowed = await request(server, 'GET', '/bot-admin/api/finances/accounts', {
      headers: { Cookie: readerCookie },
    });
    assert.equal(allowed.statusCode, 200);

    const createDenied = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: readerCookie },
      body: { account_id: 1, direction: 'in', amount: 1 },
    });
    assert.equal(createDenied.statusCode, 403);
  });

  it('rejects invalid payment payloads', async () => {
    const cookie = await login('admin', 'test-password');
    const account = createAccount(db, { name: 'Касса ошибок', currency: 'UZS' });
    const badAmount = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: { account_id: account.id, direction: 'in', amount: 0 },
    });
    assert.equal(badAmount.statusCode, 400);
    assert.match(JSON.parse(badAmount.body).message, /сумму/i);

    const missing = await request(server, 'DELETE', '/bot-admin/api/finances/payments/999999', {
      headers: { Cookie: cookie },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('creates, lists, updates, and deletes finance categories', async () => {
    const cookie = await login('admin', 'test-password');
    const created = await request(server, 'POST', '/bot-admin/api/finances/categories', {
      headers: { Cookie: cookie },
      body: { name: 'Аренда' },
    });
    assert.equal(created.statusCode, 201);
    const category = JSON.parse(created.body).category;
    assert.equal(category.name, 'Аренда');

    const listed = await request(server, 'GET', '/bot-admin/api/finances/categories', {
      headers: { Cookie: cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(JSON.parse(listed.body).categories.some((item) => item.id === category.id));

    const updated = await request(server, 'PUT', `/bot-admin/api/finances/categories/${category.id}`, {
      headers: { Cookie: cookie },
      body: { name: 'Коммунальные' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).category.name, 'Коммунальные');

    const account = createAccount(db, { name: 'Касса категорий API', currency: 'UZS' });
    const createdPayment = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: {
        account_id: account.id,
        direction: 'out',
        amount: 7000,
        category_id: category.id,
      },
    });
    assert.equal(createdPayment.statusCode, 201);
    const payment = JSON.parse(createdPayment.body).payment;
    assert.equal(payment.category_id, category.id);
    assert.equal(payment.category.name, 'Коммунальные');

    const filtered = await request(
      server,
      'GET',
      `/bot-admin/api/finances/payments?account_id=${account.id}&category_id=${category.id}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(filtered.statusCode, 200);
    assert.equal(JSON.parse(filtered.body).payments.length, 1);

    const deleted = await request(server, 'DELETE', `/bot-admin/api/finances/categories/${category.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(JSON.parse(deleted.body).ok, true);

    const afterDelete = await request(
      server,
      'GET',
      `/bot-admin/api/finances/payments?account_id=${account.id}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(afterDelete.statusCode, 200);
    const remaining = JSON.parse(afterDelete.body).payments.find((item) => item.id === payment.id);
    assert.equal(remaining.category_id, null);

    const logs = listAdminAuditLogs(db, { limit: 30 });
    const actions = logs.logs.map((row) => `${row.entity_type}:${row.action}`);
    assert.ok(actions.includes('finance_category:create'));
    assert.ok(actions.includes('finance_category:update'));
    assert.ok(actions.includes('finance_category:delete'));
  });

  it('requires finances_create to write categories', async () => {
    createEmployeeUser(db, {
      phone: '+998901000083',
      displayName: 'Читатель категорий',
      adminLogin: 'cat-reader',
      password: 'reader-secret',
      rights: { open_admin_dashboard: 1, finances_read: 1 },
    });
    const readerCookie = await login('cat-reader', 'reader-secret');
    const listed = await request(server, 'GET', '/bot-admin/api/finances/categories', {
      headers: { Cookie: readerCookie },
    });
    assert.equal(listed.statusCode, 200);

    const createDenied = await request(server, 'POST', '/bot-admin/api/finances/categories', {
      headers: { Cookie: readerCookie },
      body: { name: 'Запрещено' },
    });
    assert.equal(createDenied.statusCode, 403);
  });

  it('assigns a location to a payment and lists locations', async () => {
    const cookie = await login('admin', 'test-password');
    const employee = createEmployeeUser(db, { phone: '+998901000084', displayName: 'Кассир API' });
    const office = createLocation(db, { name: 'Офис API', allowed_user_ids: [employee.id] });
    const listed = await request(server, 'GET', '/bot-admin/api/finances/locations', {
      headers: { Cookie: cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(JSON.parse(listed.body).locations.some((item) => item.id === office.id));

    const account = createAccount(db, { name: 'Касса филиала API', currency: 'UZS' });
    const created = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: {
        account_id: account.id,
        direction: 'out',
        amount: 3500,
        location_id: office.id,
      },
    });
    assert.equal(created.statusCode, 201);
    const payment = JSON.parse(created.body).payment;
    assert.equal(payment.location_id, office.id);
    assert.equal(payment.location.name, 'Офис API');

    const filtered = await request(
      server,
      'GET',
      `/bot-admin/api/finances/payments?account_id=${account.id}&location_id=${office.id}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(filtered.statusCode, 200);
    assert.equal(JSON.parse(filtered.body).payments.length, 1);

    const uncategorized = await request(
      server,
      'GET',
      `/bot-admin/api/finances/payments?account_id=${account.id}&location_id=none`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(uncategorized.statusCode, 200);
    assert.equal(JSON.parse(uncategorized.body).payments.length, 0);

    const badLocation = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: { account_id: account.id, direction: 'in', amount: 1, location_id: 999999 },
    });
    assert.equal(badLocation.statusCode, 400);
  });

  it('exposes finances_edit permission', () => {
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(RIGHTS.finances_edit);
    assert.equal(DEFAULT_RIGHTS.finances_edit, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('finances_edit'));
    assert.ok(cols.some((col) => col.name === 'finances_edit'));
  });

  it('updates a payment with created_at and requires finances_edit', async () => {
    const cookie = await login('admin', 'test-password');
    const account = createAccount(db, { name: 'Касса правки', currency: 'UZS' });
    const created = await request(server, 'POST', '/bot-admin/api/finances/payments', {
      headers: { Cookie: cookie },
      body: {
        account_id: account.id,
        direction: 'in',
        amount: 8000,
        created_at: '2024-03-10T12:00:00.000Z',
      },
    });
    assert.equal(created.statusCode, 201);
    const payment = JSON.parse(created.body).payment;
    assert.equal(payment.created_at, '2024-03-10 12:00:00');

    const updated = await request(server, 'PUT', `/bot-admin/api/finances/payments/${payment.id}`, {
      headers: { Cookie: cookie },
      body: {
        account_id: account.id,
        direction: 'out',
        amount: 3000,
        note: 'Исправление',
        created_at: '2024-03-11T09:45:00.000Z',
      },
    });
    assert.equal(updated.statusCode, 200);
    const body = JSON.parse(updated.body);
    assert.equal(body.payment.direction, 'out');
    assert.equal(body.payment.amount, 3000);
    assert.equal(body.payment.note, 'Исправление');
    assert.equal(body.payment.created_at, '2024-03-11 09:45:00');
    assert.equal(body.account.value, -3000);

    const logs = listAdminAuditLogs(db, { limit: 20 });
    assert.ok(logs.logs.map((row) => `${row.entity_type}:${row.action}`).includes('account_payment:update'));

    const missing = await request(server, 'PUT', '/bot-admin/api/finances/payments/999999', {
      headers: { Cookie: cookie },
      body: { amount: 1 },
    });
    assert.equal(missing.statusCode, 404);

    createEmployeeUser(db, {
      phone: '+998901000085',
      displayName: 'Без правки',
      adminLogin: 'no-edit',
      password: 'secret-secret',
      rights: { open_admin_dashboard: 1, finances_read: 1, finances_create: 1 },
    });
    const noEditCookie = await login('no-edit', 'secret-secret');
    const denied = await request(server, 'PUT', `/bot-admin/api/finances/payments/${payment.id}`, {
      headers: { Cookie: noEditCookie },
      body: { amount: 1 },
    });
    assert.equal(denied.statusCode, 403);
  });
});
