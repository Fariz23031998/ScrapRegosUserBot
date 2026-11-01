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
import { openDb, createOrder, getOrderById } from '../src/db/partners-db';
import { createEmployeeUser } from '../src/db/bot-users-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { formatTicketAdminUrl, formatOrderTicketLine } from '../src/bot/order-ticket';
import { addLink, listLinksByClient } from '../src/db/client-firm-links';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-order-ticket-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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


describe('order ticket helpers', () => {
  let previousBase: any;

  before(() => {
    previousBase = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
  });

  after(() => {
    if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBase;
  });

  it('builds ticket admin URL and order line', () => {
    assert.equal(formatTicketAdminUrl(123), 'http://localhost:3000/bot-admin/tickets/123');
    assert.equal(formatTicketAdminUrl(null), null);
    assert.equal(
      formatOrderTicketLine({ ticket_id: 123 }),
      '🎫 <a href="http://localhost:3000/bot-admin/tickets/123">Тикет #123</a>'
    );
    assert.equal(formatOrderTicketLine({}), null);
    assert.equal(formatOrderTicketLine({ ticket_id: null }), null);
  });
});

describe('createOrder ticket_id persistence', () => {
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

  it('stores optional ticket_id on orders', () => {
    const withTicket = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998902222222',
      amount: 50000,
      ticketId: 42,
    });
    assert.equal(getOrderById(db, withTicket!.id)!.ticket_id, 42);

    const withoutTicket = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998903333333',
      amount: 10000,
    });
    assert.equal(getOrderById(db, withoutTicket!.id)!.ticket_id, null);
  });
});

describe('POST /bot-admin/api/orders', () => {
  let dbPath: any;
  let db: any;
  let previousEnv: any;
  let originalFetch: any;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      REGOS_INTEGRATION_TOKEN: process.env.REGOS_INTEGRATION_TOKEN,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
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

  function postJson(server: any, urlPath: any, body: any, headers: any = {}) {
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

  function cookieFromSetCookie(headerValue?: any) {
    const raw = headerValue;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
    const match = list
      .map((part?: any) => String(part).trim())
      .find((part?: any) => part.startsWith('bot_admin_session='));
    return match ? match.split(';')[0] : null;
  }

  async function loginEmployee(server: any, { login, password }: Unchecked) {
    const loginRes = await postJson(server, '/bot-admin/api/login', { login, password });
    assert.equal(loginRes.statusCode, 200);
    const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  function firmOrderPayload(overrides: any = {}) {
    return {
      amount: 25000,
      client_phone: '998901234567',
      ticket_id: 42,
      client_id: 777,
      client_name: 'Acme Firm',
      client_type: 'partner',
      record_id: 501,
      firm_message: 'Partner card',
      firm_phone: '998909998877',
      ...overrides,
    };
  }

  function getJson(server: any, urlPath: any, headers: any = {}) {
    return new Promise<any>((resolve?: any, reject?: any) => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
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
      req.end();
    });
  }

  it('creates order with ticket_id for employee session and rejects bad input', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905551122',
      displayName: 'Order Creator',
      rights: { tickets_read: 1 },
      adminLogin: 'order.creator',
      password: 'panel-secret',
      telegramId: 555001,
    });
    assert.ok(employee.telegram_id || employee.id);

    // Ensure telegram_id is set on the employee for creator notifications.
    db.prepare('UPDATE bot_users SET telegram_id = ? WHERE id = ?').run(555001, employee.id);

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const loginRes = await postJson(server, '/bot-admin/api/login', {
        login: 'order.creator',
        password: 'panel-secret',
      });
      assert.equal(loginRes.statusCode, 200);
      const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(cookie);

      const badAmount = await postJson(
        server,
        '/bot-admin/api/orders',
        { amount: 0, client_phone: '998901234567', ticket_id: 9 },
        { Cookie: cookie }
      );
      assert.equal(badAmount.statusCode, 400);

      const badPhone = await postJson(
        server,
        '/bot-admin/api/orders',
        { amount: 1000, client_phone: '', ticket_id: 9 },
        { Cookie: cookie }
      );
      assert.equal(badPhone.statusCode, 400);

      const ok = await postJson(
        server,
        '/bot-admin/api/orders',
        {
          amount: 150000,
          client_phone: '998901234567',
          ticket_id: 99,
          client_name: 'Test Client',
        },
        { Cookie: cookie }
      );
      assert.equal(ok.statusCode, 201, ok.body);
      const body = JSON.parse(ok.body);
      assert.equal(body.order.ticket_id, 99);
      assert.equal(body.order.amount, 150000);
      assert.equal(body.order.client_phone, '998901234567');
      assert.match(String(body.payment_page_url || ''), /order_id=/);

      const stored = getOrderById(db, body.order.id);
      assert.equal(stored!.ticket_id, 99);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('auto-links selected firm to client when user has clients_link_firm', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905551200',
      displayName: 'Linker',
      rights: { tickets_read: 1, clients_link_firm: 1 },
      adminLogin: 'order.linker',
      password: 'panel-secret',
    });
    db.prepare('UPDATE bot_users SET telegram_id = ? WHERE id = ?').run(555200, employee.id);

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, {
        login: 'order.linker',
        password: 'panel-secret',
      });
      const res = await postJson(server, '/bot-admin/api/orders', firmOrderPayload(), {
        Cookie: cookie,
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.firm_link?.linked, true);
      assert.ok(body.firm_link?.id);

      const links = listLinksByClient(db, 777);
      assert.equal(links.length, 1);
      assert.equal(links![0]!.firm_type, 'partner');
      assert.equal(links![0]!.firm_record_id, '501');
      assert.equal(links![0]!.firm_name, 'Acme Firm');
      assert.equal(links![0]!.firm_phone, '998909998877');
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('does not auto-link firm without clients_link_firm permission', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905551201',
      displayName: 'No Link Right',
      rights: { tickets_read: 1 },
      adminLogin: 'order.nolink',
      password: 'panel-secret',
    });
    db.prepare('UPDATE bot_users SET telegram_id = ? WHERE id = ?').run(555201, employee.id);

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, {
        login: 'order.nolink',
        password: 'panel-secret',
      });
      const res = await postJson(server, '/bot-admin/api/orders', firmOrderPayload(), {
        Cookie: cookie,
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.firm_link?.linked, false);
      assert.equal(body.firm_link?.reason, 'no_permission');
      assert.equal(listLinksByClient(db, 777).length, 0);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('treats already-linked firm as success when creating an order', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905551202',
      displayName: 'Dup Linker',
      rights: { tickets_read: 1, clients_link_firm: 1 },
      adminLogin: 'order.duplink',
      password: 'panel-secret',
    });
    db.prepare('UPDATE bot_users SET telegram_id = ? WHERE id = ?').run(555202, employee.id);
    addLink(db, {
      regos_client_id: 777,
      type: 'partner',
      recordId: 501,
      clientName: 'Acme Firm',
      phone: '998909998877',
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, {
        login: 'order.duplink',
        password: 'panel-secret',
      });
      const res = await postJson(server, '/bot-admin/api/orders', firmOrderPayload(), {
        Cookie: cookie,
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.firm_link?.linked, true);
      assert.equal(body.firm_link?.reason, 'already_linked');
      assert.equal(listLinksByClient(db, 777).length, 1);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('skips auto-link when firm is selected but client_id is missing', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905551203',
      displayName: 'No Client Id',
      rights: { tickets_read: 1, clients_link_firm: 1 },
      adminLogin: 'order.noclient',
      password: 'panel-secret',
    });
    db.prepare('UPDATE bot_users SET telegram_id = ? WHERE id = ?').run(555203, employee.id);

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, {
        login: 'order.noclient',
        password: 'panel-secret',
      });
      const { client_id: _ignored, ...payload } = firmOrderPayload();
      const res = await postJson(server, '/bot-admin/api/orders', payload, { Cookie: cookie });
      assert.equal(res.statusCode, 201, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.firm_link?.linked, false);
      assert.equal(body.firm_link?.reason, 'no_client_id');
      assert.equal(listLinksByClient(db, 777).length, 0);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('rejects password-only admin without bot user telegram', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const loginRes = await postJson(server, '/bot-admin/api/login', {
        login: 'admin',
        password: 'test-password',
      });
      assert.equal(loginRes.statusCode, 200);
      const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(cookie);

      const res = await postJson(
        server,
        '/bot-admin/api/orders',
        { amount: 1000, client_phone: '998901234567', ticket_id: 1 },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 403);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
