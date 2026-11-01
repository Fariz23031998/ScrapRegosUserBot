import type { Unchecked } from '../src/types/unchecked';
import type { Db } from '../src/types/db';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import crypto from 'crypto';
import { openDb, createOrder, markOrderPaid, getOrderById } from '../src/db/partners-db';
import { createEmployeeUser, linkEmployeeTelegram, markPendingOrderPaidCash, upsertUserRights } from '../src/db/bot-users-db';
import { ALLOWED_DURATIONS, PRODUCT_TYPE, listTechnicalSupportPrices, updateTechnicalSupportPrices, getTechnicalSupportPrice, activateTechnicalSupportFromOrder, getActiveTechnicalSupportSubscription, listTechnicalSupportSubscriptions, createManualTechnicalSupportSubscription, deactivateTechnicalSupportSubscription, updateTechnicalSupportSubscriptionEndsAt, deleteTechnicalSupportSubscription, mapSubscriptionRow, addCalendarMonths, formatSupportUntilLabel, ensureTechnicalSupportTables, getActiveTechnicalSupportSubscription as getActiveSub, formatSupportUntilLabel as formatLabel } from '../src/db/technical-support';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { createDashboardLoginToken } from '../src/admin/dashboard-login-tokens';
import { makeServiceButtonForResult } from '../src/bot/service-bot';
import { EXPIRED_MESSAGE } from '../src/bot/search-user';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ts-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

function cookieFromSetCookie(setCookie?: any) {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) return null;
  return String(raw).split(';')[0];
}

function request(server: any, method: any, urlPath: any, { headers = {}, body = null }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

function createSupportOrder(db: Db, { phone = '+998901112233', months = 3, amount = 150000, telegramId = 1001 }: Unchecked = {}) {
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
  let dbPath: any;
  let db: any;
  let previousEnv: any;

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
      else process.env[key] = value as any;
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

  it('requires matching technical_support rights for subscription management APIs', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    async function loginEmployee(rights?: any) {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('computes ends_at and never stores it on subscriptions or orders', () => {
    const created = createManualTechnicalSupportSubscription(db, {
      phone: '+998901112233',
      months: 1,
      amount: 0,
    });
    const orderCols = db.prepare('PRAGMA table_info(technical_support_subscription_orders)').all();
    const subCols = db.prepare('PRAGMA table_info(technical_support_subscriptions)').all();
    assert.ok(!orderCols.some((col?: any) => col.name === 'ends_at'));
    assert.ok(!subCols.some((col?: any) => col.name === 'ends_at'));
    const stored = db
      .prepare('SELECT * FROM technical_support_subscription_orders WHERE id = ?')
      .get(created!.subscription!.id);
    assert.equal(stored.ends_at, undefined);
    assert.equal(
      created!.subscription!.ends_at,
      addCalendarMonths(new Date(created!.subscription!.starts_at), 1).toISOString()
    );
  });

  it('normalizes phone variants onto one subscription with stacked orders', () => {
    const first = createManualTechnicalSupportSubscription(db, {
      phone: '90 111-22-33',
      months: 1,
      amount: 0,
    });
    const second = createManualTechnicalSupportSubscription(db, {
      phone: '+998 (90) 111-22-33',
      months: 3,
      amount: 1000,
    });
    assert.equal(first!.subscription!.phone, '+998901112233');
    assert.equal(first!.subscription!.phone_key, '998901112233');
    assert.equal(second!.subscription!.phone, '+998901112233');
    assert.equal(second!.subscription!.phone_key, '998901112233');
    assert.equal(second!.subscription!.starts_at, first!.subscription!.ends_at);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM technical_support_subscriptions').get().count,
      1
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM technical_support_subscription_orders').get().count,
      2
    );
  });

  it('migrates legacy rows off stored ends_at', () => {
    db.exec('DROP TABLE IF EXISTS technical_support_subscription_orders');
    db.exec('DROP TABLE IF EXISTS technical_support_subscriptions');
    db.exec(`
      CREATE TABLE technical_support_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        phone_key TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE,
        months INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO technical_support_subscriptions
       (phone, phone_key, order_id, months, amount, starts_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      '+998 90 111 22 33',
      '998901112233',
      'manual:legacy',
      1,
      0,
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z'
    );

    ensureTechnicalSupportTables(db);

    const subCols = db.prepare('PRAGMA table_info(technical_support_subscriptions)').all();
    const orderCols = db.prepare('PRAGMA table_info(technical_support_subscription_orders)').all();
    assert.ok(!subCols.some((col?: any) => col.name === 'ends_at'));
    assert.ok(!orderCols.some((col?: any) => col.name === 'ends_at'));
    const listed = listTechnicalSupportSubscriptions(db, {});
    assert.equal(listed.total, 1);
    assert.equal(listed!.items[0]!.phone, '+998901112233');
    assert.equal(listed!.items[0]!.starts_at, '2026-01-01T00:00:00.000Z');
    assert.equal(
      listed!.items[0]!.ends_at,
      addCalendarMonths(new Date('2026-01-01T00:00:00.000Z'), 1).toISOString()
    );
  });
});
