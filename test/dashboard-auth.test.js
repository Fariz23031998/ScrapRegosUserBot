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
});
