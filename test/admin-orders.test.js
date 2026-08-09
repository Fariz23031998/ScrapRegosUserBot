const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { openDb, createOrder, getOrderById, listOrders } = require('../src/db/partners-db');
const { createEmployeeUser, linkEmployeeTelegram } = require('../src/db/bot-users-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createDashboardLoginToken } = require('../src/admin/dashboard-login-tokens');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-admin-orders-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function cookieFromSetCookie(headerValue) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part) => String(part).trim())
    .find((part) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}

describe('listOrders helper', () => {
  let dbPath;
  let db;

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

  it('filters by status and search query', () => {
    const pending = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998902222222',
      amount: 10000,
      status: 'pending',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998903333333',
      amount: 20000,
      status: 'paid',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998904444444',
      additionalPhone: '998905555555',
      amount: 30000,
      status: 'pending',
    });

    const byStatus = listOrders(db, { status: 'pending', limit: 50 });
    assert.equal(byStatus.total, 2);
    assert.ok(byStatus.orders.every((row) => row.status === 'pending'));

    const byPhone = listOrders(db, { query: '555555', limit: 50 });
    assert.equal(byPhone.total, 1);
    assert.equal(byPhone.orders[0].additional_phone, '998905555555');

    const byId = listOrders(db, { query: pending.id.slice(0, 8), limit: 50 });
    assert.ok(byId.orders.some((row) => row.id === pending.id));
  });
});

describe('admin orders API', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
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

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
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

  async function loginPassword() {
    const loginRes = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login: 'admin', password: 'test-password' },
    });
    assert.equal(loginRes.statusCode, 200);
    const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  async function loginEmployee(rights) {
    const telegramId = 700000 + Math.floor(Math.random() * 100000);
    const employee = createEmployeeUser(db, {
      phone: `+99890${String(telegramId).slice(-7)}`,
      displayName: 'Orders Tester',
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
    return { cookie, telegramId, employee };
  }

  it('requires orders_read for list and orders_manage for actions', async () => {
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998902222222',
      amount: 15000,
    });

    const readOnly = await loginEmployee({ orders_read: 1 });
    const listOk = await request(server, 'GET', '/bot-admin/api/orders', {
      headers: { Cookie: readOnly.cookie },
    });
    assert.equal(listOk.statusCode, 200);
    const listBody = JSON.parse(listOk.body);
    assert.equal(listBody.total, 1);
    assert.equal(listBody.orders.length, 1);

    const pendingId = listBody.orders[0].id;
    for (const action of ['delete', 'paid-cash', 'renotify']) {
      const denied = await request(server, 'POST', `/bot-admin/api/orders/${pendingId}/${action}`, {
        headers: { Cookie: readOnly.cookie },
      });
      assert.equal(denied.statusCode, 403, `${action} should require orders_manage`);
    }

    const noAccess = await loginEmployee({ tickets_read: 1 });
    const listDenied = await request(server, 'GET', '/bot-admin/api/orders', {
      headers: { Cookie: noAccess.cookie },
    });
    assert.equal(listDenied.statusCode, 403);
  });

  it('lists seeded orders and filters by status', async () => {
    const pending = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998902222222',
      amount: 10000,
      status: 'pending',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998903333333',
      amount: 20000,
      status: 'paid',
    });

    const cookie = await loginPassword();
    const all = await request(server, 'GET', '/bot-admin/api/orders?limit=50', {
      headers: { Cookie: cookie },
    });
    assert.equal(all.statusCode, 200);
    const allBody = JSON.parse(all.body);
    assert.equal(allBody.total, 2);

    const filtered = await request(server, 'GET', '/bot-admin/api/orders?status=pending', {
      headers: { Cookie: cookie },
    });
    assert.equal(filtered.statusCode, 200);
    const filteredBody = JSON.parse(filtered.body);
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.orders[0].id, pending.id);
    assert.equal(filteredBody.orders[0].status, 'pending');
    assert.ok(filteredBody.orders[0].status_label);
  });

  it('allows delete / paid-cash / renotify only for pending orders', async () => {
    const manager = await loginEmployee({ orders_read: 1, orders_manage: 1 });

    const pendingDelete = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: manager.telegramId,
      botUserPhone: '998901111111',
      clientPhone: '998902222222',
      amount: 11000,
    });
    const pendingCash = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: manager.telegramId,
      botUserPhone: '998901111111',
      clientPhone: '998903333333',
      amount: 12000,
    });
    const pendingRenotify = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: manager.telegramId,
      botUserPhone: '998901111111',
      clientPhone: '998904444444',
      amount: 13000,
    });
    const paid = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: manager.telegramId,
      botUserPhone: '998901111111',
      clientPhone: '998905555555',
      amount: 14000,
      status: 'paid',
    });

    const deleted = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingDelete.id}/delete`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(deleted.statusCode, 200);
    assert.equal(getOrderById(db, pendingDelete.id).status, 'deleted');

    const cash = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingCash.id}/paid-cash`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(cash.statusCode, 200);
    assert.equal(getOrderById(db, pendingCash.id).status, 'paid_cash');
    assert.equal(getOrderById(db, pendingCash.id).payment_provider, 'cash');

    const renotify = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingRenotify.id}/renotify`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(renotify.statusCode, 200);
    const renotifyBody = JSON.parse(renotify.body);
    assert.equal(renotifyBody.ok, true);
    assert.ok(renotifyBody.message);
    assert.equal(getOrderById(db, pendingRenotify.id).status, 'pending');

    for (const action of ['delete', 'paid-cash', 'renotify']) {
      const fail = await request(server, 'POST', `/bot-admin/api/orders/${paid.id}/${action}`, {
        headers: { Cookie: manager.cookie },
      });
      assert.equal(fail.statusCode, 409, `${action} on paid should be 409`);
    }
  });
});
