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

  it('returns a session token on login and accepts Authorization Bearer', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const loginRes = await request(server, 'POST', '/bot-admin/api/login', {
        body: { login: 'admin', password: 'test-password' },
      });
      assert.equal(loginRes.statusCode, 200);
      const loginBody = JSON.parse(loginRes.body);
      assert.equal(loginBody.ok, true);
      assert.equal(typeof loginBody.token, 'string');
      assert.match(loginBody.token, /^eyJ/);

      const noAuth = await request(server, 'GET', '/bot-admin/api/session');
      assert.equal(noAuth.statusCode, 401);

      const bearerSession = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Authorization: `Bearer ${loginBody.token}` },
      });
      assert.equal(bearerSession.statusCode, 200);
      const sessionBody = JSON.parse(bearerSession.body);
      assert.equal(sessionBody.actor.type, 'password');
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('allows employees to log in with per-user credentials and scopes rights', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    function cookieFromSetCookie(headerValue?: any) {
      const raw = headerValue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
      const match = list
        .map((part?: any) => String(part).trim())
        .find((part?: any) => part.startsWith('bot_admin_session='));
      return match ? match.split(';')[0] : null;
    }

    function postJson(urlPath: any, body: any, headers: any = {}) {
      return new Promise<any>((resolve?: any, reject?: any) => {
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
      const listed = usersBody.users.find((item?: any) => item.id === employee.id);
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
      const updated = await new Promise<any>((resolve?: any, reject?: any) => {
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
              Cookie: adminCookie!,
              Accept: 'application/json',
            },
          },
          (res: any) => {
            const chunks: any[] = [];
            res.on('data', (chunk?: any) => chunks.push(chunk));
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('lets employees change their own login and password with current password', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    function cookieFromSetCookie(headerValue?: any) {
      const raw = headerValue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
      const match = list
        .map((part?: any) => String(part).trim())
        .find((part?: any) => part.startsWith('bot_admin_session='));
      return match ? match.split(';')[0] : null;
    }

    function requestJson(method: any, urlPath: any, body: any, headers: any = {}) {
      return new Promise<any>((resolve?: any, reject?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
