const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createAccount } = require('../src/db/accounts');
const { listAdminAuditLogs } = require('../src/db/admin-audit-logs');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { openDb } = require('../src/db/partners-db');
const { setUsdUzsRate } = require('../src/db/money');

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
});
