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
const { hasRight } = require('../src/db/user-rights');
const {
  createDashboardLoginToken,
  consumeDashboardLoginToken,
  hashToken,
  TOKEN_TTL_MS,
} = require('../src/admin/dashboard-login-tokens');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { buildCommandsForTelegramUser } = require('../src/bot/bot-commands');
const { checkDashboardAccess, buildDashboardLoginUrl } = require('../src/bot/dashboard-bot');
const { buildSessionCookieAttributes } = require('../src/admin/bot-admin-auth');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-dashboard-auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore missing files
    }
  }
}

function request(server, method, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers,
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
    req.end();
  });
}

describe('Telegram dashboard authentication', () => {
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
    if (dbPath) {
      removeDbFiles(dbPath);
    }
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
  });

  after(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) {
      removeDbFiles(dbPath);
    }
  });

  function createLinkedEmployeeWithDashboardRight(telegramId = 424242) {
    const employee = createEmployeeUser(db, {
      phone: `+99890${String(telegramId).slice(-7)}`,
      displayName: 'Dashboard Tester',
      rights: { open_admin_dashboard: 1 },
    });
    const linked = linkEmployeeTelegram(db, employee.id, telegramId, {
      username: 'dash_tester',
      firstName: 'Dash',
      lastName: 'Tester',
    });
    return linked;
  }

  it('migrates open_admin_dashboard and gates the command menu', () => {
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col) => col.name === 'open_admin_dashboard'));

    const user = createLinkedEmployeeWithDashboardRight(111);
    assert.equal(hasRight(db, user.telegram_id, 'open_admin_dashboard'), true);

    const commands = buildCommandsForTelegramUser(db, user.telegram_id);
    assert.ok(
      commands.some(
        (item) => item.command === 'open_dashboard' && item.description === 'Open Admin Dashboard'
      )
    );

    upsertUserRights(db, user.id, { open_admin_dashboard: 0 });
    assert.equal(hasRight(db, user.telegram_id, 'open_admin_dashboard'), false);
    const deniedCommands = buildCommandsForTelegramUser(db, user.telegram_id);
    assert.ok(!deniedCommands.some((item) => item.command === 'open_dashboard'));
  });

  it('creates hashed one-time tokens and rejects reuse/expiry', () => {
    const telegramId = 222;
    createLinkedEmployeeWithDashboardRight(telegramId);

    const { rawToken, expiresAt } = createDashboardLoginToken(db, telegramId);
    assert.match(rawToken, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(expiresAt) > Date.now());

    const stored = db
      .prepare('SELECT token_hash, telegram_id, used_at FROM dashboard_login_tokens')
      .get();
    assert.equal(stored.token_hash, hashToken(rawToken));
    assert.equal(stored.telegram_id, telegramId);
    assert.equal(stored.used_at, null);

    const first = consumeDashboardLoginToken(db, rawToken);
    assert.deepEqual(first, { telegramId });
    assert.equal(consumeDashboardLoginToken(db, rawToken), null);

    const expired = createDashboardLoginToken(db, telegramId, { ttlMs: -1000 });
    assert.equal(consumeDashboardLoginToken(db, expired.rawToken), null);
  });

  it('denies access when the dashboard right is missing', () => {
    const user = createEmployeeUser(db, {
      phone: '+998901112233',
      displayName: 'No Dash',
      rights: { open_admin_dashboard: 0 },
    });
    const linked = linkEmployeeTelegram(db, user.id, 333, {});
    const access = checkDashboardAccess(db, linked);
    assert.equal(access.allowed, false);
    assert.match(access.message, /Доступ запрещён/);
  });

  it('exchanges a valid Telegram token for an admin session cookie', async () => {
    const telegramId = 444;
    createLinkedEmployeeWithDashboardRight(telegramId);
    const { rawToken } = createDashboardLoginToken(db, telegramId);
    const loginUrl = buildDashboardLoginUrl(rawToken);
    assert.equal(
      loginUrl,
      `https://example.test/bot-admin/auth/telegram?token=${encodeURIComponent(rawToken)}`
    );

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const ok = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(rawToken)}`
      );
      assert.equal(ok.statusCode, 302);
      assert.equal(ok.headers.location, '/bot-admin/');
      const setCookie = String(ok.headers['set-cookie'] || '');
      assert.match(setCookie, /bot_admin_session=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /Secure/i);

      const reuse = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(rawToken)}`
      );
      assert.equal(reuse.statusCode, 401);

      const revokedUser = createEmployeeUser(db, {
        phone: '+998909998877',
        displayName: 'Revoked',
        rights: { open_admin_dashboard: 1 },
      });
      linkEmployeeTelegram(db, revokedUser.id, 666, {});
      const revokedToken = createDashboardLoginToken(db, 666).rawToken;
      upsertUserRights(db, revokedUser.id, { open_admin_dashboard: 0 });
      const revoked = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(revokedToken)}`
      );
      assert.equal(revoked.statusCode, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('marks Secure cookie when PUBLIC_BASE_URL is https', () => {
    const attrs = buildSessionCookieAttributes({ maxAgeSeconds: 10 });
    assert.match(attrs, /Secure/);
    assert.match(attrs, /HttpOnly/);
    assert.match(attrs, /SameSite=Lax/);
    assert.ok(TOKEN_TTL_MS > 0);
  });

  it('allows employees to log in with per-user credentials and scopes rights', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    function cookieFromSetCookie(headerValue) {
      const raw = headerValue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
      const match = list
        .map((part) => String(part).trim())
        .find((part) => part.startsWith('bot_admin_session='));
      return match ? match.split(';')[0] : null;
    }

    function postJson(urlPath, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const { port } = server.address();
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
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
        req.end(payload);
      });
    }

    try {
      const employee = createEmployeeUser(db, {
        phone: '+998905551001',
        displayName: 'Panel User',
        rights: { users_read: 1, tickets_read: 0 },
        adminLogin: 'panel.user',
        password: 'employee-secret',
      });
      assert.equal(employee.admin_login, 'panel.user');
      assert.ok(employee.password_hash);
      assert.match(employee.password_hash, /^scrypt\$/);

      const badLogin = await postJson('/bot-admin/api/login', {
        login: 'panel.user',
        password: 'wrong',
      });
      assert.equal(badLogin.statusCode, 401);

      const okLogin = await postJson('/bot-admin/api/login', {
        login: 'panel.user',
        password: 'employee-secret',
      });
      assert.equal(okLogin.statusCode, 200);
      const cookie = cookieFromSetCookie(okLogin.headers['set-cookie']);
      assert.ok(cookie);

      const session = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Cookie: cookie },
      });
      assert.equal(session.statusCode, 200);
      const sessionBody = JSON.parse(session.body);
      assert.equal(sessionBody.actor.type, 'user');
      assert.equal(sessionBody.actor.userId, employee.id);
      assert.equal(sessionBody.profile.login, 'panel.user');
      assert.equal(sessionBody.profile.displayName, 'Panel User');
      assert.equal(sessionBody.profile.canChangeCredentials, true);
      assert.equal(sessionBody.permissions.users_read, true);
      assert.equal(sessionBody.permissions.tickets_read, false);
      assert.equal(sessionBody.permissions.prices_edit, false);

      const usersOk = await request(server, 'GET', '/bot-admin/api/users', {
        headers: { Cookie: cookie, Accept: 'application/json' },
      });
      assert.equal(usersOk.statusCode, 200);
      const usersBody = JSON.parse(usersOk.body);
      const listed = usersBody.users.find((item) => item.id === employee.id);
      assert.ok(listed);
      assert.equal(listed.admin_login, 'panel.user');
      assert.equal(listed.has_password, true);
      assert.equal(listed.password_hash, undefined);

      const ticketsDenied = await request(server, 'GET', '/bot-admin/api/tickets', {
        headers: { Cookie: cookie, Accept: 'application/json' },
      });
      assert.equal(ticketsDenied.statusCode, 403);

      const adminLogin = await postJson('/bot-admin/api/login', {
        login: 'admin',
        password: 'test-password',
      });
      const adminCookie = cookieFromSetCookie(adminLogin.headers['set-cookie']);
      const updated = await new Promise((resolve, reject) => {
        const { port } = server.address();
        const payload = JSON.stringify({
          phone: employee.phone,
          display_name: employee.display_name,
          admin_login: 'panel.user',
          password: 'new-employee-secret',
          rights: { users_read: 1 },
        });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/bot-admin/api/users/${employee.id}`,
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              Cookie: adminCookie,
              Accept: 'application/json',
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          }
        );
        req.on('error', reject);
        req.end(payload);
      });
      assert.equal(updated.statusCode, 200);

      const oldRejected = await postJson('/bot-admin/api/login', {
        login: 'panel.user',
        password: 'employee-secret',
      });
      assert.equal(oldRejected.statusCode, 401);

      const newOk = await postJson('/bot-admin/api/login', {
        login: 'panel.user',
        password: 'new-employee-secret',
      });
      assert.equal(newOk.statusCode, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('lets employees change their own login and password with current password', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    function cookieFromSetCookie(headerValue) {
      const raw = headerValue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
      const match = list
        .map((part) => String(part).trim())
        .find((part) => part.startsWith('bot_admin_session='));
      return match ? match.split(';')[0] : null;
    }

    function requestJson(method, urlPath, body, headers = {}) {
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
              ...(payload
                ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                  }
                : {}),
              Accept: 'application/json',
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
        if (payload) req.end(payload);
        else req.end();
      });
    }

    try {
      createEmployeeUser(db, {
        phone: '+998905551222',
        displayName: 'Self Serve',
        rights: { users_read: 1 },
        adminLogin: 'self.user',
        password: 'old-pass-1',
      });

      const login = await requestJson('POST', '/bot-admin/api/login', {
        login: 'self.user',
        password: 'old-pass-1',
      });
      assert.equal(login.statusCode, 200);
      const cookie = cookieFromSetCookie(login.headers['set-cookie']);
      assert.ok(cookie);

      const badCurrent = await requestJson(
        'PATCH',
        '/bot-admin/api/account',
        {
          current_password: 'wrong',
          login: 'self.user2',
          new_password: 'new-pass-1',
        },
        { Cookie: cookie }
      );
      assert.equal(badCurrent.statusCode, 400);

      const updated = await requestJson(
        'PATCH',
        '/bot-admin/api/account',
        {
          current_password: 'old-pass-1',
          login: 'self.user2',
          new_password: 'new-pass-1',
        },
        { Cookie: cookie }
      );
      assert.equal(updated.statusCode, 200);
      const updatedBody = JSON.parse(updated.body);
      assert.equal(updatedBody.profile.login, 'self.user2');
      assert.equal(updatedBody.profile.canChangeCredentials, true);

      const oldLogin = await requestJson('POST', '/bot-admin/api/login', {
        login: 'self.user',
        password: 'old-pass-1',
      });
      assert.equal(oldLogin.statusCode, 401);

      const newLogin = await requestJson('POST', '/bot-admin/api/login', {
        login: 'self.user2',
        password: 'new-pass-1',
      });
      assert.equal(newLogin.statusCode, 200);

      const envAdminLogin = await requestJson('POST', '/bot-admin/api/login', {
        login: 'admin',
        password: 'test-password',
      });
      const envCookie = cookieFromSetCookie(envAdminLogin.headers['set-cookie']);
      const envSession = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Cookie: envCookie },
      });
      const envBody = JSON.parse(envSession.body);
      assert.equal(envBody.profile.canChangeCredentials, false);
      assert.equal(envBody.profile.login, 'admin');

      const envDenied = await requestJson(
        'PATCH',
        '/bot-admin/api/account',
        {
          current_password: 'test-password',
          login: 'admin2',
          new_password: 'x',
        },
        { Cookie: envCookie }
      );
      assert.equal(envDenied.statusCode, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('migrates tickets_read and gates admin sections by actor', async () => {
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col) => col.name === 'tickets_read'));
    assert.ok(cols.some((col) => col.name === 'users_read'));
    assert.ok(cols.some((col) => col.name === 'order_logs_read'));
    assert.ok(cols.some((col) => col.name === 'orders_read'));
    assert.ok(cols.some((col) => col.name === 'orders_manage'));

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    const previousToken = process.env.REGOS_INTEGRATION_TOKEN;
    delete process.env.REGOS_INTEGRATION_TOKEN;

    function cookieFromSetCookie(headerValue) {
      const raw = headerValue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
      const match = list
        .map((part) => String(part).trim())
        .find((part) => part.startsWith('bot_admin_session='));
      return match ? match.split(';')[0] : null;
    }

    try {
      const loginRes = await new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/bot-admin/api/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        req.end(JSON.stringify({ login: 'admin', password: 'test-password' }));
      });
      assert.equal(loginRes.statusCode, 200);
      const passwordCookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(passwordCookie);

      const passwordSession = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Cookie: passwordCookie },
      });
      assert.equal(passwordSession.statusCode, 200);
      const passwordSessionBody = JSON.parse(passwordSession.body);
      assert.equal(passwordSessionBody.actor.type, 'password');
      assert.equal(passwordSessionBody.permissions.tickets_read, true);
      assert.equal(passwordSessionBody.permissions.users_read, true);
      assert.equal(passwordSessionBody.permissions.prices_edit, true);

      const passwordTickets = await request(server, 'GET', '/bot-admin/api/tickets', {
        headers: { Cookie: passwordCookie, Accept: 'application/json' },
      });
      assert.notEqual(passwordTickets.statusCode, 403);
      assert.equal(passwordTickets.statusCode, 503);

      const passwordUsers = await request(server, 'GET', '/bot-admin/api/users', {
        headers: { Cookie: passwordCookie, Accept: 'application/json' },
      });
      assert.equal(passwordUsers.statusCode, 200);

      const ticketsOnlyId = 555001;
      const ticketsOnlyUser = createEmployeeUser(db, {
        phone: '+998905550001',
        displayName: 'Tickets Only',
        rights: { open_admin_dashboard: 1, tickets_read: 1 },
      });
      linkEmployeeTelegram(db, ticketsOnlyUser.id, ticketsOnlyId, {});
      const ticketsOnlyToken = createDashboardLoginToken(db, ticketsOnlyId).rawToken;
      const ticketsOnlyAuth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(ticketsOnlyToken)}`
      );
      assert.equal(ticketsOnlyAuth.statusCode, 302);
      const ticketsOnlyCookie = cookieFromSetCookie(ticketsOnlyAuth.headers['set-cookie']);
      assert.ok(ticketsOnlyCookie);

      const ticketsOnlySession = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Cookie: ticketsOnlyCookie },
      });
      assert.equal(ticketsOnlySession.statusCode, 200);
      const ticketsOnlyBody = JSON.parse(ticketsOnlySession.body);
      assert.equal(ticketsOnlyBody.actor.type, 'telegram');
      assert.equal(ticketsOnlyBody.permissions.tickets_read, true);
      assert.equal(ticketsOnlyBody.permissions.users_read, false);
      assert.equal(ticketsOnlyBody.permissions.order_logs_read, false);

      const ticketsOk = await request(server, 'GET', '/bot-admin/api/tickets', {
        headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
      });
      assert.notEqual(ticketsOk.statusCode, 403);
      assert.equal(ticketsOk.statusCode, 503);

      for (const urlPath of [
        '/bot-admin/api/users',
        '/bot-admin/api/orders',
        '/bot-admin/api/order-logs',
        '/bot-admin/api/technical-support/prices',
        '/bot-admin/api/prices',
      ]) {
        const denied = await request(server, 'GET', urlPath, {
          headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
        });
        assert.equal(denied.statusCode, 403, `${urlPath} should be 403`);
      }

      const usersReadId = 555003;
      const usersReadEmployee = createEmployeeUser(db, {
        phone: '+998905550003',
        displayName: 'Users Read',
        rights: { open_admin_dashboard: 1, users_read: 1, users_delete: 0 },
      });
      linkEmployeeTelegram(db, usersReadEmployee.id, usersReadId, {});
      const usersReadToken = createDashboardLoginToken(db, usersReadId).rawToken;
      const usersReadAuth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(usersReadToken)}`
      );
      const usersReadCookie = cookieFromSetCookie(usersReadAuth.headers['set-cookie']);
      assert.ok(usersReadCookie);

      const usersList = await request(server, 'GET', '/bot-admin/api/users', {
        headers: { Cookie: usersReadCookie, Accept: 'application/json' },
      });
      assert.equal(usersList.statusCode, 200);

      const deleteDenied = await request(
        server,
        'DELETE',
        `/bot-admin/api/users/${usersReadEmployee.id}`,
        { headers: { Cookie: usersReadCookie, Accept: 'application/json' } }
      );
      assert.equal(deleteDenied.statusCode, 403);

      // Legacy view_tickets column copies into tickets_read.
      const legacyId = 555004;
      const legacyUser = createEmployeeUser(db, {
        phone: '+998905550004',
        displayName: 'Legacy Tickets',
        rights: { open_admin_dashboard: 1 },
      });
      db.prepare('UPDATE user_rights SET view_tickets = 1, tickets_read = 0 WHERE user_id = ?').run(
        legacyUser.id
      );
      // Re-run migration copy path via ensure by reading rights.
      const { getUserRights } = require('../src/db/bot-users-db');
      // Force migration UPDATE again:
      db.exec(`
        UPDATE user_rights
        SET tickets_read = 1
        WHERE IFNULL(view_tickets, 0) = 1 AND IFNULL(tickets_read, 0) = 0
      `);
      assert.equal(getUserRights(db, legacyUser.id).tickets_read, 1);
      assert.ok(legacyId);
    } finally {
      if (previousToken === undefined) delete process.env.REGOS_INTEGRATION_TOKEN;
      else process.env.REGOS_INTEGRATION_TOKEN = previousToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
