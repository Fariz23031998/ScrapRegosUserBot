import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser, linkEmployeeTelegram, upsertUserRights } from '../src/db/bot-users-db';
import { hasRight } from '../src/db/user-rights';
import { createDashboardLoginToken, consumeDashboardLoginToken, lookupDashboardLoginToken, hasActiveDashboardSession, invalidateDashboardLoginTokensForTelegramId, cleanupDashboardLoginTokens, hashToken, TOKEN_TTL_MS } from '../src/admin/dashboard-login-tokens';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { buildCommandsForTelegramUser } from '../src/bot/bot-commands';
import { checkDashboardAccess, buildDashboardLoginUrl, buildDashboardWebAppUrl } from '../src/bot/dashboard-bot';
import { buildSessionCookieAttributes, createSessionToken, parseSessionToken, SESSION_COOKIE } from '../src/admin/bot-admin-auth';
import { parseTelegramWebAppInitData, signTelegramWebAppInitData, WEBAPP_AUTH_MAX_AGE_SEC } from '../src/admin/telegram-webapp-auth';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-dashboard-auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore missing files
    }
  }
}

function cookieFromSetCookie(headerValue?: any) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part?: any) => String(part).trim())
    .find((part?: any) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? match.split(';')[0] : null;
}

function sessionActorFromSetCookie(headerValue?: any) {
  const cookieHeader = cookieFromSetCookie(headerValue);
  if (!cookieHeader) return null;
  const token = decodeURIComponent(cookieHeader.slice(`${SESSION_COOKIE}=`.length));
  return parseSessionToken(process.env.BOT_ADMIN_PASSWORD, token);
}

function telegramCookieHeader(telegramId?: any) {
  const token = createSessionToken(process.env.BOT_ADMIN_PASSWORD, {
    type: 'telegram',
    telegramId,
  });
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function request(server: any, method: any, urlPath: any, { headers = {}, body }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const { port } = server.address();
    const payload =
      body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (payload) {
      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      reqHeaders['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: reqHeaders,
      },
      (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk?: any) => chunks.push(chunk));
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


describe('Telegram dashboard authentication', () => {
  let dbPath: any;
  let db: any;
  let previousEnv: any;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
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

  function createLinkedEmployeeWithDashboardRight(telegramId: any = 424242) {
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
    assert.ok(cols.some((col?: any) => col.name === 'open_admin_dashboard'));

    const user = createLinkedEmployeeWithDashboardRight(111);
    assert.equal(hasRight(db, user!.telegram_id, 'open_admin_dashboard'), true);

    const commands = buildCommandsForTelegramUser(db, user!.telegram_id);
    assert.ok(
      commands.some(
        (item?: any) => item.command === 'open_dashboard' && item.description === 'Open Admin Dashboard'
      )
    );

    upsertUserRights(db, user!.id, { open_admin_dashboard: 0 });
    assert.equal(hasRight(db, user!.telegram_id, 'open_admin_dashboard'), false);
    const deniedCommands = buildCommandsForTelegramUser(db, user!.telegram_id);
    assert.ok(!deniedCommands.some((item?: any) => item.command === 'open_dashboard'));
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

    const lookedUp = lookupDashboardLoginToken(db, rawToken);
    assert.equal(lookedUp!.telegramId, telegramId);
    assert.equal(lookedUp!.usedAt, null);
    assert.equal(hasActiveDashboardSession(db, telegramId), false);

    const first = consumeDashboardLoginToken(db, rawToken);
    assert.deepEqual(first, { telegramId });
    assert.equal(consumeDashboardLoginToken(db, rawToken), null);
    assert.equal(hasActiveDashboardSession(db, telegramId), true);

    const usedLookup = lookupDashboardLoginToken(db, rawToken);
    assert.ok(usedLookup!.usedAt);

    cleanupDashboardLoginTokens(db);
    assert.ok(
      db
        .prepare('SELECT token_hash FROM dashboard_login_tokens WHERE token_hash = ?')
        .get(hashToken(rawToken))
    );

    const expired = createDashboardLoginToken(db, telegramId, { ttlMs: -1000 });
    assert.equal(consumeDashboardLoginToken(db, expired.rawToken), null);
    assert.equal(lookupDashboardLoginToken(db, expired.rawToken), null);
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
    assert.match((access.message as any), /Доступ запрещён/);
  });

  it('exchanges a valid Telegram token for an admin session cookie and reuses it', async () => {
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
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const authPath = `/bot-admin/auth/telegram?token=${encodeURIComponent(rawToken)}`;
      const ok = await request(server, 'GET', authPath);
      assert.equal(ok.statusCode, 302);
      assert.equal(ok.headers.location, '/bot-admin/');
      const setCookie = String(ok.headers['set-cookie'] || '');
      assert.match(setCookie, /bot_admin_session=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /Secure/i);
      assert.deepEqual(sessionActorFromSetCookie(ok.headers['set-cookie']), {
        type: 'telegram',
        telegramId,
      });
      const firstCookie = cookieFromSetCookie(ok.headers['set-cookie']);

      const reuseWithoutCookie = await request(server, 'GET', authPath);
      assert.equal(reuseWithoutCookie.statusCode, 302);
      assert.equal(reuseWithoutCookie.headers.location, '/bot-admin/');
      assert.deepEqual(sessionActorFromSetCookie(reuseWithoutCookie.headers['set-cookie']), {
        type: 'telegram',
        telegramId,
      });

      const reuseWithCookie = await request(server, 'GET', authPath, {
        headers: { Cookie: firstCookie },
      });
      assert.equal(reuseWithCookie.statusCode, 302);
      assert.deepEqual(sessionActorFromSetCookie(reuseWithCookie.headers['set-cookie']), {
        type: 'telegram',
        telegramId,
      });

      invalidateDashboardLoginTokensForTelegramId(db, telegramId);
      const expiredUnused = createDashboardLoginToken(db, telegramId, { ttlMs: -1000 }).rawToken;
      const expired = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(expiredUnused)}`
      );
      assert.equal(expired.statusCode, 401);

      const staleToken = createDashboardLoginToken(db, telegramId).rawToken;
      const staleAuth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(staleToken)}`
      );
      assert.equal(staleAuth.statusCode, 302);
      db.prepare(
        `UPDATE dashboard_login_tokens
         SET used_at = datetime('now', '-13 hours')
         WHERE token_hash = ?`
      ).run(hashToken(staleToken));
      const staleReuse = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(staleToken)}`
      );
      assert.equal(staleReuse.statusCode, 401);

      const otherId = 445;
      createLinkedEmployeeWithDashboardRight(otherId);
      const otherToken = createDashboardLoginToken(db, otherId).rawToken;
      const switched = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(otherToken)}`,
        { headers: { Cookie: telegramCookieHeader(telegramId) } }
      );
      assert.equal(switched.statusCode, 302);
      assert.deepEqual(sessionActorFromSetCookie(switched.headers['set-cookie']), {
        type: 'telegram',
        telegramId: otherId,
      });

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

      const reuseRevokeId = 667;
      const reuseRevokeUser = createLinkedEmployeeWithDashboardRight(reuseRevokeId);
      const reuseRevokeToken = createDashboardLoginToken(db, reuseRevokeId).rawToken;
      const reuseRevokeAuth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(reuseRevokeToken)}`
      );
      assert.equal(reuseRevokeAuth.statusCode, 302);
      upsertUserRights(db, reuseRevokeUser!.id, { open_admin_dashboard: 0 });
      const reuseRevoked = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(reuseRevokeToken)}`
      );
      assert.equal(reuseRevoked.statusCode, 403);

      const logoutId = 668;
      createLinkedEmployeeWithDashboardRight(logoutId);
      const logoutToken = createDashboardLoginToken(db, logoutId).rawToken;
      const logoutAuth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(logoutToken)}`
      );
      assert.equal(logoutAuth.statusCode, 302);
      const logoutCookie = cookieFromSetCookie(logoutAuth.headers['set-cookie']);
      const logoutRes = await request(server, 'POST', '/bot-admin/api/logout', {
        headers: { Cookie: logoutCookie, Accept: 'application/json' },
      });
      assert.equal(logoutRes.statusCode, 200);
      const afterLogout = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(logoutToken)}`
      );
      assert.equal(afterLogout.statusCode, 401);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('marks Secure cookie when PUBLIC_BASE_URL is https', () => {
    const attrs = buildSessionCookieAttributes({ maxAgeSeconds: 10 });
    assert.match(attrs, /Secure/);
    assert.match(attrs, /HttpOnly/);
    assert.match(attrs, /SameSite=Lax/);
    assert.ok(TOKEN_TTL_MS > 0);
    assert.equal(buildDashboardWebAppUrl(), 'https://example.test/bot-admin/');
    assert.ok(WEBAPP_AUTH_MAX_AGE_SEC > 0);
  });

  it('validates Telegram Mini App initData HMAC and rejects stale or forged payloads', () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramId = 777001;
    const nowSec = 1_700_000_000;
    const initData = signTelegramWebAppInitData(
      {
        auth_date: String(nowSec),
        query_id: 'AAE',
        user: JSON.stringify({ id: telegramId, first_name: 'Dash' }),
      },
      botToken
    );

    assert.deepEqual(parseTelegramWebAppInitData(initData, botToken, { nowSec }), { telegramId });

    const tampered = new URLSearchParams(initData);
    tampered.set('hash', '0'.repeat(64));
    assert.equal(parseTelegramWebAppInitData(tampered.toString(), botToken, { nowSec }), null);

    const stale = signTelegramWebAppInitData(
      {
        auth_date: String(nowSec - WEBAPP_AUTH_MAX_AGE_SEC - 1),
        user: JSON.stringify({ id: telegramId, first_name: 'Dash' }),
      },
      botToken
    );
    assert.equal(parseTelegramWebAppInitData(stale, botToken, { nowSec }), null);
  });

  it('exchanges Telegram Mini App initData for an admin session cookie', async () => {
    const telegramId = 777002;
    createLinkedEmployeeWithDashboardRight(telegramId);
    const initData = signTelegramWebAppInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id: telegramId, first_name: 'Mini' }),
      },
      process.env.TELEGRAM_BOT_TOKEN
    );

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const ok = await request(server, 'POST', '/bot-admin/api/auth/telegram-webapp', {
        body: { initData },
      });
      assert.equal(ok.statusCode, 200);
      const okBody = JSON.parse(ok.body);
      assert.equal(okBody.ok, true);
      assert.equal(typeof okBody.token, 'string');
      assert.deepEqual(sessionActorFromSetCookie(ok.headers['set-cookie']), {
        type: 'telegram',
        telegramId,
      });
      const cookie = cookieFromSetCookie(ok.headers['set-cookie']);

      const session = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Cookie: cookie },
      });
      assert.equal(session.statusCode, 200);
      assert.equal(JSON.parse(session.body).actor.telegramId, telegramId);

      const reuse = await request(server, 'POST', '/bot-admin/api/auth/telegram-webapp', {
        headers: { Cookie: cookie },
        body: { initData },
      });
      assert.equal(reuse.statusCode, 200);
      assert.deepEqual(sessionActorFromSetCookie(reuse.headers['set-cookie']), {
        type: 'telegram',
        telegramId,
      });

      const tamperedParams = new URLSearchParams(initData);
      tamperedParams.set('hash', '0'.repeat(64));
      const badHash = await request(server, 'POST', '/bot-admin/api/auth/telegram-webapp', {
        body: { initData: tamperedParams.toString() },
      });
      assert.equal(badHash.statusCode, 401);

      const deniedUser = createEmployeeUser(db, {
        phone: '+998907770003',
        displayName: 'No Mini',
        rights: { open_admin_dashboard: 0 },
      });
      linkEmployeeTelegram(db, deniedUser.id, 777003, {});
      const deniedInit = signTelegramWebAppInitData(
        {
          auth_date: String(Math.floor(Date.now() / 1000)),
          user: JSON.stringify({ id: 777003, first_name: 'NoMini' }),
        },
        process.env.TELEGRAM_BOT_TOKEN
      );
      const denied = await request(server, 'POST', '/bot-admin/api/auth/telegram-webapp', {
        body: { initData: deniedInit },
      });
      assert.equal(denied.statusCode, 403);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
