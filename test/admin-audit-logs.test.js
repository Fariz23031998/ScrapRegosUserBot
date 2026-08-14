const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const {
  createEmployeeUser,
  linkEmployeeTelegram,
  upsertUserRights,
} = require('../src/db/bot-users-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createDashboardLoginToken } = require('../src/admin/dashboard-login-tokens');
const { listAdminAuditLogs, mapAdminAuditLogRow } = require('../src/db/admin-audit-logs');
const { updateTechnicalSupportPrices } = require('../src/db/technical-support');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-admin-audit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('Admin audit logs', () => {
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
    process.env.PUBLIC_BASE_URL = 'https://example.test';
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
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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

  async function loginAsPassword() {
    const login = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login: 'admin', password: 'test-password' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = cookieFromSetCookie(login.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  it('records mutations and lists them via /api/logs', async () => {
    const cookie = await loginAsPassword();

    const created = await request(server, 'POST', '/bot-admin/api/users', {
      headers: { Cookie: cookie },
      body: {
        phone: '+998901112233',
        display_name: 'Audit User',
        rights: { users_read: 1, logs_read: 1 },
        regos_user_id: null,
        auto_link_regos: false,
      },
    });
    assert.equal(created.statusCode, 201);
    const user = JSON.parse(created.body).user;
    assert.ok(user?.id);

    const prices = await request(server, 'PUT', '/bot-admin/api/technical-support/prices', {
      headers: { Cookie: cookie },
      body: { prices: { 1: 50000, 3: 120000, 6: 200000, 12: 350000 } },
    });
    assert.equal(prices.statusCode, 200);

    const listed = await request(server, 'GET', '/bot-admin/api/logs?limit=50', {
      headers: { Cookie: cookie },
    });
    assert.equal(listed.statusCode, 200);
    const body = JSON.parse(listed.body);
    assert.ok(body.total >= 2);
    assert.ok(Array.isArray(body.logs));

    const actions = body.logs.map((row) => `${row.entity_type}:${row.action}`);
    assert.ok(actions.includes('user:create'));
    assert.ok(actions.includes('technical_support_price:update'));

    const userLog = body.logs.find((row) => row.entity_type === 'user' && row.action === 'create');
    assert.equal(String(userLog.entity_id), String(user.id));
    assert.match(userLog.summary, /Создан сотрудник/);
    assert.equal(userLog.actor_type, 'password');
    assert.match(String(userLog.actor_name || ''), /admin/);
    assert.equal(userLog.details?.before ?? null, null);
    assert.equal(userLog.details?.after?.phone, '+998901112233');
    assert.ok(userLog.details?.changes?.phone);
    assert.equal(userLog.details.changes.phone.from, null);
    assert.equal(userLog.details.changes.phone.to, '+998901112233');

    const priceLog = body.logs.find(
      (row) => row.entity_type === 'technical_support_price' && row.action === 'update'
    );
    assert.ok(priceLog);
    assert.equal(priceLog.details?.before?.['3'], 0);
    assert.equal(priceLog.details?.after?.['3'], 120000);
    assert.equal(priceLog.details?.changes?.['3']?.from, 0);
    assert.equal(priceLog.details?.changes?.['3']?.to, 120000);

    const updated = await request(server, 'PUT', `/bot-admin/api/users/${user.id}`, {
      headers: { Cookie: cookie },
      body: {
        phone: '+998901112233',
        display_name: 'Audit User Renamed',
        regos_user_id: null,
        auto_link_regos: false,
      },
    });
    assert.equal(updated.statusCode, 200);

    const listedAfterUpdate = await request(server, 'GET', '/bot-admin/api/logs?limit=50', {
      headers: { Cookie: cookie },
    });
    const updateLog = JSON.parse(listedAfterUpdate.body).logs.find(
      (row) => row.entity_type === 'user' && row.action === 'update' && String(row.entity_id) === String(user.id)
    );
    assert.ok(updateLog);
    assert.equal(updateLog.details?.before?.display_name, 'Audit User');
    assert.equal(updateLog.details?.after?.display_name, 'Audit User Renamed');
    assert.equal(updateLog.details?.changes?.display_name?.from, 'Audit User');
    assert.equal(updateLog.details?.changes?.display_name?.to, 'Audit User Renamed');

    const page = await request(server, 'GET', '/bot-admin/logs', {
      headers: { Cookie: cookie, Accept: 'text/html' },
    });
    assert.equal(page.statusCode, 200);
    if (/bot-admin\/assets\//.test(page.body) || /id="root"/.test(page.body)) {
      assert.match(page.body, /Bot Admin/);
    } else {
      assert.match(page.body, /Журнал изменений/);
      assert.match(page.body, /admin-logs\.js/);
    }
  });

  it('denies /api/logs without logs_read', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905550010',
      displayName: 'No Logs',
      rights: { open_admin_dashboard: 1, users_read: 1, logs_read: 0 },
    });
    linkEmployeeTelegram(db, employee.id, 555010, {});
    const token = createDashboardLoginToken(db, 555010).rawToken;
    const auth = await request(
      server,
      'GET',
      `/bot-admin/auth/telegram?token=${encodeURIComponent(token)}`
    );
    assert.equal(auth.statusCode, 302);
    const cookie = cookieFromSetCookie(auth.headers['set-cookie']);
    assert.ok(cookie);

    const denied = await request(server, 'GET', '/bot-admin/api/logs', {
      headers: { Cookie: cookie },
    });
    assert.equal(denied.statusCode, 403);

    // React SPA serves the shell for deep links; permissions are enforced by APIs/client.
    // Legacy HTML pages still return 403 when logs_read is missing.
    const pageDenied = await request(server, 'GET', '/bot-admin/logs', {
      headers: { Cookie: cookie, Accept: 'text/html' },
    });
    if (pageDenied.statusCode === 403) {
      assert.match(pageDenied.body, /Нет доступа|Недостаточно прав/i);
    } else {
      assert.equal(pageDenied.statusCode, 200);
      assert.match(pageDenied.body, /bot-admin\/assets\/|id="root"/);
    }

    upsertUserRights(db, employee.id, { logs_read: 1 });
    const allowed = await request(server, 'GET', '/bot-admin/api/logs', {
      headers: { Cookie: cookie },
    });
    assert.equal(allowed.statusCode, 200);
  });

  it('maps audit rows with labels and before/after details', () => {
    updateTechnicalSupportPrices(db, { 1: 1000 });
    const { logAdminAudit, buildAuditDetails } = require('../src/db/admin-audit-logs');
    logAdminAudit(db, {
      entityType: 'technical_support_price',
      entityId: null,
      action: 'update',
      summary: 'test',
      details: buildAuditDetails({
        before: { '1': 0 },
        after: { '1': 1000 },
      }),
      actor: { type: 'password' },
    });
    const listed = listAdminAuditLogs(db, { limit: 5 });
    assert.ok(listed.total >= 1);
    const mapped = mapAdminAuditLogRow(listed.logs[0]);
    assert.equal(mapped.action_label, 'Изменение');
    assert.equal(mapped.entity_type_label, 'Цены техподдержки');
    assert.equal(mapped.details?.before?.['1'], 0);
    assert.equal(mapped.details?.after?.['1'], 1000);
    assert.equal(mapped.details?.changes?.['1']?.from, 0);
    assert.equal(mapped.details?.changes?.['1']?.to, 1000);
  });
});
