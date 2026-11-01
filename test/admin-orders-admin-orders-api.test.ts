import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import crypto from 'crypto';
import { openDb, createOrder, getOrderById, listOrders } from '../src/db/partners-db';
import { createEmployeeUser, linkEmployeeTelegram, getUserRights, migrateBotUsersSchema } from '../src/db/bot-users-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { createDashboardLoginToken } from '../src/admin/dashboard-login-tokens';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-admin-orders-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function request(server: any, method: any, urlPath: any, { headers = {}, body = null }: Unchecked = {}) {
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
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk?: any) => chunks.push(chunk));
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

function cookieFromSetCookie(headerValue?: any) {
  const raw = headerValue;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part?: any) => String(part).trim())
    .find((part?: any) => part.startsWith('bot_admin_session='));
  return match ? match.split(';')[0] : null;
}


describe('admin orders API', () => {
  let dbPath: any;
  let db: any;
  let server: any;
  let previousEnv: any;

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
      else process.env[key] = value as any;
    }
  });

  beforeEach(async () => {
    if (server) {
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  after(async () => {
    if (server) {
      await new Promise<any>((resolve?: any) => server.close(resolve));
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

  async function loginEmployee(rights?: any) {
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

  it('requires orders_read for the list and each granular right for its action', async () => {
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
    for (const action of ['delete', 'paid-cash', 'renotify', 'delete-cash']) {
      const denied = await request(server, 'POST', `/bot-admin/api/orders/${pendingId}/${action}`, {
        headers: { Cookie: readOnly.cookie },
      });
      assert.equal(denied.statusCode, 403, `${action} should require its action right`);
    }

    const actionRights = {
      delete: 'delete_unpaid_order',
      'paid-cash': 'mark_paid_cash',
      renotify: 'renotify_order',
    };
    for (const [allowedAction, right] of Object.entries(actionRights)) {
      const actor = await loginEmployee({ orders_read: 1, [right]: 1 });
      for (const action of Object.keys(actionRights)) {
        const order = createOrder(db, {
          id: crypto.randomUUID(),
          telegramId: actor.telegramId,
          botUserPhone: '998901111111',
          clientPhone: '998902222222',
          amount: 15000,
        });
        const response = await request(
          server,
          'POST',
          `/bot-admin/api/orders/${order!.id}/${action}`,
          { headers: { Cookie: actor.cookie } }
        );
        assert.equal(
          response.statusCode,
          action === allowedAction ? 200 : 403,
          `${right} should ${action === allowedAction ? 'allow' : 'deny'} ${action}`
        );
      }
    }

    const cashDeleter = await loginEmployee({ orders_read: 1, delete_cash_order: 1 });
    const cashOrder = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: cashDeleter.telegramId,
      botUserPhone: '998901111111',
      clientPhone: '998902222222',
      amount: 16000,
      status: 'paid_cash',
      paymentProvider: 'cash',
    });
    const cashDeleteDenied = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${cashOrder!.id}/delete-cash`,
      { headers: { Cookie: readOnly.cookie } }
    );
    assert.equal(cashDeleteDenied.statusCode, 403);
    const cashDeleteOk = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${cashOrder!.id}/delete-cash`,
      { headers: { Cookie: cashDeleter.cookie } }
    );
    assert.equal(cashDeleteOk.statusCode, 200);
    assert.equal(getOrderById(db, cashOrder!.id)!.status, 'deleted');

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
    assert.deepEqual(allBody.summary, {
      count: 2,
      pending: 1,
      paid: 1,
      deleted: 0,
      amount: 20000,
    });

    const filtered = await request(server, 'GET', '/bot-admin/api/orders?status=pending', {
      headers: { Cookie: cookie },
    });
    assert.equal(filtered.statusCode, 200);
    const filteredBody = JSON.parse(filtered.body);
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.orders[0].id, pending!.id);
    assert.equal(filteredBody.orders[0].status, 'pending');
    assert.ok(filteredBody.orders[0].status_label);
    assert.equal(filteredBody.orders[0].payment_provider, null);
    assert.equal(filteredBody.orders[0].payment_provider_label, null);

    const byClient = await request(
      server,
      'GET',
      '/bot-admin/api/orders?status=pending&client=998902222222',
      { headers: { Cookie: cookie } }
    );
    assert.equal(byClient.statusCode, 200);
    const byClientBody = JSON.parse(byClient.body);
    assert.equal(byClientBody.total, 1);
    assert.equal(byClientBody.orders[0].id, pending!.id);

    const cash = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998909999999',
      amount: 15000,
      status: 'paid_cash',
      paymentProvider: 'cash',
    });
    const paid = await request(server, 'GET', '/bot-admin/api/orders?status=paid&limit=50', {
      headers: { Cookie: cookie },
    });
    assert.equal(paid.statusCode, 200);
    const paidBody = JSON.parse(paid.body);
    assert.equal(paidBody.total, 2);
    const cashRow = paidBody.orders.find((row?: any) => row.id === cash!.id);
    assert.ok(cashRow);
    assert.equal(cashRow.status, 'paid_cash');
    assert.equal(cashRow.status_label, 'Оплачен');
    assert.equal(cashRow.payment_provider, 'cash');

    const byPayment = await request(server, 'GET', '/bot-admin/api/orders?payment=cash&limit=50', {
      headers: { Cookie: cookie },
    });
    assert.equal(byPayment.statusCode, 200);
    const byPaymentBody = JSON.parse(byPayment.body);
    assert.equal(byPaymentBody.total, 1);
    assert.equal(byPaymentBody.orders[0].id, cash!.id);

    const byClick = await request(server, 'GET', '/bot-admin/api/orders?payment=click&limit=50', {
      headers: { Cookie: cookie },
    });
    assert.equal(byClick.statusCode, 200);
    const byClickBody = JSON.parse(byClick.body);
    assert.equal(byClickBody.total, 1);
    assert.equal(byClickBody.orders[0].status, 'paid');
    assert.equal(byClickBody.orders[0].payment_provider, 'click');
  });

  it('allows delete / paid-cash / renotify only for pending orders', async () => {
    const manager = await loginEmployee({
      orders_read: 1,
      delete_unpaid_order: 1,
      delete_cash_order: 1,
      mark_paid_cash: 1,
      renotify_order: 1,
    });

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
    const paidCash = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: manager.telegramId,
      botUserPhone: '998901111111',
      clientPhone: '998906666666',
      amount: 15000,
      status: 'paid_cash',
      paymentProvider: 'cash',
    });

    const deleted = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingDelete!.id}/delete`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(deleted.statusCode, 200);
    assert.equal(getOrderById(db, pendingDelete!.id)!.status, 'deleted');

    const cash = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingCash!.id}/paid-cash`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(cash.statusCode, 200);
    assert.equal(getOrderById(db, pendingCash!.id)!.status, 'paid_cash');
    assert.equal(getOrderById(db, pendingCash!.id)!.payment_provider, 'cash');

    const renotify = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingRenotify!.id}/renotify`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(renotify.statusCode, 200);
    const renotifyBody = JSON.parse(renotify.body);
    assert.equal(renotifyBody.ok, true);
    assert.ok(renotifyBody.message);
    assert.equal(getOrderById(db, pendingRenotify!.id)!.status, 'pending');

    for (const action of ['delete', 'paid-cash', 'renotify', 'delete-cash']) {
      const fail = await request(server, 'POST', `/bot-admin/api/orders/${paid!.id}/${action}`, {
        headers: { Cookie: manager.cookie },
      });
      assert.equal(fail.statusCode, 409, `${action} on paid should be 409`);
    }

    const unpaidDeleteOnCash = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${paidCash!.id}/delete`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(unpaidDeleteOnCash.statusCode, 409);
    assert.equal(getOrderById(db, paidCash!.id)!.status, 'paid_cash');

    const deleteCashOnPending = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${pendingRenotify!.id}/delete-cash`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(deleteCashOnPending.statusCode, 409);

    const deletedCash = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${paidCash!.id}/delete-cash`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(deletedCash.statusCode, 200);
    assert.equal(getOrderById(db, paidCash!.id)!.status, 'deleted');

    const deleteCashAgain = await request(
      server,
      'POST',
      `/bot-admin/api/orders/${paidCash!.id}/delete-cash`,
      { headers: { Cookie: manager.cookie } }
    );
    assert.equal(deleteCashAgain.statusCode, 409);
  });
});
