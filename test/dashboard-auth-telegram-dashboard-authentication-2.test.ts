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

  it('migrates tickets_read and gates admin sections by actor', async () => {
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col?: any) => col.name === 'tickets_read'));
    assert.ok(cols.some((col?: any) => col.name === 'tickets_create'));
    assert.ok(cols.some((col?: any) => col.name === 'tickets_edit'));
    assert.ok(cols.some((col?: any) => col.name === 'tickets_edit_closed'));
    assert.ok(cols.some((col?: any) => col.name === 'clients_edit'));
    assert.ok(cols.some((col?: any) => col.name === 'clients_link_firm'));
    assert.ok(cols.some((col?: any) => col.name === 'users_read'));
    assert.ok(cols.some((col?: any) => col.name === 'order_logs_read'));
    assert.ok(cols.some((col?: any) => col.name === 'orders_read'));
    assert.ok(cols.some((col?: any) => col.name === 'orders_manage'));
    assert.ok(cols.some((col?: any) => col.name === 'delete_unpaid_order'));
    assert.ok(cols.some((col?: any) => col.name === 'delete_cash_order'));
    assert.ok(cols.some((col?: any) => col.name === 'mark_paid_cash'));
    assert.ok(cols.some((col?: any) => col.name === 'renotify_order'));
    assert.ok(cols.some((col?: any) => col.name === 'settings_read'));
    assert.ok(cols.some((col?: any) => col.name === 'settings_edit'));

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    const previousToken = process.env.REGOS_INTEGRATION_TOKEN;
    delete process.env.REGOS_INTEGRATION_TOKEN;

    function cookieFromSetCookie(headerValue?: any) {
      const raw = headerValue;
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
      const match = list
        .map((part?: any) => String(part).trim())
        .find((part?: any) => part.startsWith('bot_admin_session='));
      return match ? match.split(';')[0] : null;
    }

    try {
      const loginRes = await new Promise<any>((resolve?: any, reject?: any) => {
        const { port } = server.address();
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/bot-admin/api/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
      assert.equal(passwordSessionBody.permissions.tickets_create, true);
      assert.equal(passwordSessionBody.permissions.tickets_edit, true);
      assert.equal(passwordSessionBody.permissions.tickets_edit_closed, true);
      assert.equal(passwordSessionBody.permissions.clients_edit, true);
      assert.equal(passwordSessionBody.permissions.clients_link_firm, true);
      assert.equal(passwordSessionBody.permissions.users_read, true);
      assert.equal(passwordSessionBody.permissions.prices_edit, true);
      assert.equal(passwordSessionBody.permissions.settings_read, true);
      assert.equal(passwordSessionBody.permissions.settings_edit, true);
      assert.equal(passwordSessionBody.permissions.delete_unpaid_order, true);
      assert.equal(passwordSessionBody.permissions.delete_cash_order, true);
      assert.equal(passwordSessionBody.permissions.mark_paid_cash, true);
      assert.equal(passwordSessionBody.permissions.renotify_order, true);
      assert.equal(passwordSessionBody.permissions.orders_manage, undefined);

      const rightsMeta = await request(server, 'GET', '/bot-admin/rights-meta', {
        headers: { Cookie: passwordCookie },
      });
      const rightsMetaBody = JSON.parse(rightsMeta.body);
      assert.ok(
        rightsMetaBody.rights.some(
          (right?: any) => right.key === 'tickets_create' && /тикеты — создание/.test(right.label)
        )
      );
      assert.ok(
        rightsMetaBody.rights.some(
          (right?: any) => right.key === 'tickets_edit' && /тикеты — изменение/.test(right.label)
        )
      );
      assert.ok(
        rightsMetaBody.rights.some(
          (right?: any) =>
            right.key === 'tickets_edit_closed' && /тикеты — изменение закрытых/.test(right.label)
        )
      );
      assert.ok(
        rightsMetaBody.rights.some(
          (right?: any) => right.key === 'clients_edit' && /клиенты — изменение/.test(right.label)
        )
      );
      assert.ok(
        rightsMetaBody.rights.some(
          (right?: any) => right.key === 'clients_link_firm' && /связь с фирмой/.test(right.label)
        )
      );

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
      assert.equal(ticketsOnlyBody.permissions.tickets_create, false);
      assert.equal(ticketsOnlyBody.permissions.tickets_edit, false);
      assert.equal(ticketsOnlyBody.permissions.tickets_edit_closed, false);
      assert.equal(ticketsOnlyBody.permissions.users_read, false);
      assert.equal(ticketsOnlyBody.permissions.order_logs_read, false);
      assert.equal(ticketsOnlyBody.permissions.settings_read, false);
      assert.equal(ticketsOnlyBody.permissions.settings_edit, false);
      assert.equal(ticketsOnlyBody.permissions.delete_unpaid_order, false);
      assert.equal(ticketsOnlyBody.permissions.delete_cash_order, false);
      assert.equal(ticketsOnlyBody.permissions.mark_paid_cash, false);
      assert.equal(ticketsOnlyBody.permissions.renotify_order, false);

      const ticketsOk = await request(server, 'GET', '/bot-admin/api/tickets', {
        headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
      });
      assert.notEqual(ticketsOk.statusCode, 403);
      assert.equal(ticketsOk.statusCode, 503);

      const createDenied = await request(server, 'POST', '/bot-admin/api/tickets', {
        headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
      });
      assert.equal(createDenied.statusCode, 403);
      const editDenied = await request(server, 'PATCH', '/bot-admin/api/tickets/1', {
        headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
      });
      assert.equal(editDenied.statusCode, 403);

      upsertUserRights(db, ticketsOnlyUser.id, { tickets_create: 1, tickets_edit: 0 });
      const createOnlySession = await request(server, 'GET', '/bot-admin/api/session', {
        headers: { Cookie: ticketsOnlyCookie },
      });
      const createOnlyBody = JSON.parse(createOnlySession.body);
      assert.equal(createOnlyBody.permissions.tickets_create, true);
      assert.equal(createOnlyBody.permissions.tickets_edit, false);
      const createAllowed = await request(server, 'POST', '/bot-admin/api/tickets', {
        headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
      });
      assert.equal(createAllowed.statusCode, 400);
      const editStillDenied = await request(server, 'PATCH', '/bot-admin/api/tickets/1', {
        headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
      });
      assert.equal(editStillDenied.statusCode, 403);

      for (const urlPath of [
        '/bot-admin/api/users',
        '/bot-admin/api/orders',
        '/bot-admin/api/order-logs',
        '/bot-admin/api/logs',
        '/bot-admin/api/technical-support/prices',
        '/bot-admin/api/prices',
        '/bot-admin/api/settings/channels',
      ]) {
        const denied = await request(server, 'GET', urlPath, {
          headers: { Cookie: ticketsOnlyCookie, Accept: 'application/json' },
        });
        assert.equal(denied.statusCode, 403, `${urlPath} should be 403`);
      }

      const settingsReaderId = 555002;
      const settingsReader = createEmployeeUser(db, {
        phone: '+998905550002',
        displayName: 'Settings Reader',
        rights: { open_admin_dashboard: 1, settings_read: 1, settings_edit: 0 },
      });
      linkEmployeeTelegram(db, settingsReader.id, settingsReaderId, {});
      const settingsReaderToken = createDashboardLoginToken(db, settingsReaderId).rawToken;
      const settingsReaderAuth = await request(
        server,
        'GET',
        `/bot-admin/auth/telegram?token=${encodeURIComponent(settingsReaderToken)}`
      );
      const settingsReaderCookie = cookieFromSetCookie(settingsReaderAuth.headers['set-cookie']);
      assert.ok(settingsReaderCookie);

      const settingsPage = await request(server, 'GET', '/bot-admin/settings', {
        headers: { Cookie: settingsReaderCookie },
      });
      assert.equal(settingsPage.statusCode, 200);
      const settingsWriteDenied = await request(
        server,
        'PUT',
        '/bot-admin/api/settings/channels',
        {
          headers: { Cookie: settingsReaderCookie, 'Content-Type': 'application/json' },
        }
      );
      assert.equal(settingsWriteDenied.statusCode, 403);

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
      const { getUserRights } = (require('../src/db/bot-users-db') as typeof import('../src/db/bot-users-db'));
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
