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


describe('listOrders helper', () => {
  let dbPath: any;
  let db: any;

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

    const all = listOrders(db, { limit: 50 });
    assert.deepEqual(all.summary, {
      count: 3,
      pending: 2,
      paid: 1,
      deleted: 0,
      amount: 20000,
    });

    const byStatus = listOrders(db, { status: 'pending', limit: 50 });
    assert.equal(byStatus.total, 2);
    assert.ok(byStatus.orders.every((row?: any) => row.status === 'pending'));
    assert.deepEqual(byStatus.summary, {
      count: 2,
      pending: 2,
      paid: 0,
      deleted: 0,
      amount: 0,
    });

    const cash = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998908888888',
      amount: 15000,
      status: 'paid_cash',
      paymentProvider: 'cash',
    });
    const paidIncludingCash = listOrders(db, { status: 'paid', limit: 50 });
    assert.equal(paidIncludingCash.total, 2);
    assert.ok(paidIncludingCash.orders.some((row?: any) => row.id === cash!.id));
    assert.deepEqual(paidIncludingCash.summary, {
      count: 2,
      pending: 0,
      paid: 2,
      deleted: 0,
      amount: 35000,
    });
    const byCash = listOrders(db, { paymentProvider: 'cash', limit: 50 });
    assert.equal(byCash.total, 1);
    assert.equal(byCash.orders[0].id, cash!.id);

    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 2002,
      botUserPhone: '998906666666',
      clientPhone: '998907777777',
      amount: 40000,
      status: 'pending',
    });
    const byEmployee = listOrders(db, { telegramId: 2002, limit: 50 });
    assert.equal(byEmployee.total, 1);
    assert.equal(byEmployee.orders[0].telegram_id, 2002);

    const byPhone = listOrders(db, { query: '555555', limit: 50 });
    assert.equal(byPhone.total, 1);
    assert.equal(byPhone.orders[0].additional_phone, '998905555555');

    const byClientPhone = listOrders(db, { clientPhone: '998902222222', limit: 50 });
    assert.equal(byClientPhone.total, 1);
    assert.equal(byClientPhone.orders[0].id, pending!.id);

    const byClientPhoneTail = listOrders(db, { clientPhone: '2222222', status: 'pending', limit: 50 });
    assert.equal(byClientPhoneTail.total, 1);
    assert.equal(byClientPhoneTail.orders[0].client_phone, '998902222222');

    // additional_phone is part of the client filter; employee bot_user_phone is not
    const byAdditionalOnly = listOrders(db, { clientPhone: '998905555555', limit: 50 });
    assert.equal(byAdditionalOnly.total, 1);
    assert.equal(byAdditionalOnly.orders[0].additional_phone, '998905555555');

    const byEmployeePhone = listOrders(db, { clientPhone: '998901111111', limit: 50 });
    assert.equal(byEmployeePhone.total, 0);

    const byId = listOrders(db, { query: (pending!.id! as any).slice(0, 8), limit: 50 });
    assert.ok(byId.orders.some((row?: any) => row.id === pending!.id));
  });
});

describe('legacy order rights migration', () => {
  let dbPath: any;
  let db: any;

  after(() => {
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
  });

  it('converts orders_manage once and keeps later granular revocations', () => {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    const employee = createEmployeeUser(db, {
      phone: '+998901234567',
      displayName: 'Legacy Order Manager',
      rights: { orders_manage: 1 },
    });

    migrateBotUsersSchema(db);
    let rights = getUserRights(db, employee.id);
    assert.equal(rights.orders_manage, 0);
    assert.equal(rights.delete_unpaid_order, 1);
    assert.equal(rights.mark_paid_cash, 1);
    assert.equal(rights.renotify_order, 1);

    db.prepare('UPDATE user_rights SET delete_unpaid_order = 0 WHERE user_id = ?').run(employee.id);
    migrateBotUsersSchema(db);
    rights = getUserRights(db, employee.id);
    assert.equal(rights.delete_unpaid_order, 0);
  });
});

describe('admin orders action controls', () => {
  it('wires each button to its matching session permission', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'bot-admin', 'admin-orders.js'),
      'utf8'
    );

    assert.match(source, /canDeleteOrders = hasPermission\(session, 'delete_unpaid_order'\)/);
    assert.match(source, /canDeleteCashOrders = hasPermission\(session, 'delete_cash_order'\)/);
    assert.match(source, /canMarkOrdersPaidCash = hasPermission\(session, 'mark_paid_cash'\)/);
    assert.match(source, /canRenotifyOrders = hasPermission\(session, 'renotify_order'\)/);
    assert.doesNotMatch(source, /hasPermission\(session, 'orders_manage'\)/);
  });
});
