import type { Unchecked } from '../src/types/unchecked';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb, createOrder } from '../src/db/partners-db';
import { createEmployeeUser, linkEmployeeTelegram, setBotUserRegosLink } from '../src/db/bot-users-db';
import { replaceRegosChannelSettings } from '../src/db/regos-channel-settings';
import { upsertTicketRecording } from '../src/db/ticket-recordings';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { PAGE_LIMIT } from '../src/integrations/regos-crm-http';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-list-summary-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function jsonOk(result: any[], total: number) {
  return {
    ok: true,
    async json() {
      return { ok: true, result, next_offset: result.length, total };
    },
  };
}

describe('GET /bot-admin/api/tickets summary split', () => {
  let dbPath: any;
  let db: any;
  let previousEnv: any;
  let originalFetch: any;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      REGOS_INTEGRATION_TOKEN: process.env.REGOS_INTEGRATION_TOKEN,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
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

  function requestJson(server: any, method: any, urlPath: any, { headers }: Unchecked = {}) {
    return new Promise<any>((resolve?: any, reject?: any) => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
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

  it('returns one REGOS page from the list and scans the catalog only for summary', async () => {
    const calls: any[] = [];
    const unexpected: string[] = [];
    const pageTicket = {
      id: 7,
      subject: 'Visible',
      status: 'Open',
      sla_breached: false,
      rating: null,
    };
    let catalog: any[] = [];

    (global as any).fetch = async (url?: any, options?: any) => {
      const urlStr = String(url);
      const endpoint = urlStr.split('/v1/')[1] || '';
      if (endpoint !== 'Ticket/Get') {
        unexpected.push(urlStr);
        throw new Error(`Unexpected fetch ${urlStr}`);
      }
      const body = options?.body ? JSON.parse(options.body) : {};
      calls.push(body);
      const offset = Number(body.offset) || 0;
      const limit = Number(body.limit) || 0;
      if (limit !== PAGE_LIMIT) {
        return jsonOk([pageTicket], 1740);
      }
      return jsonOk(catalog.slice(offset, offset + limit), catalog.length);
    };

    replaceRegosChannelSettings(db, [
      { channel_id: 'phone', interaction_mode: 'call', channel_name: 'Phone' },
      { channel_id: 'chat', interaction_mode: 'message_only', channel_name: 'Chat' },
    ]);
    upsertTicketRecording(db, {
      ticketId: 1,
      recordingUrl: 'http://calls.example/1.wav',
      durationSeconds: 45,
    });
    upsertTicketRecording(db, {
      ticketId: 2,
      recordingUrl: 'http://calls.example/2.wav',
    });

    const durationCatalog = [
      {
        id: 1,
        channel_id: 'phone',
        sla_breached: true,
        rating: 5,
        status: 'Open',
        client_id: 1,
        created_date: 10,
        last_update: 30,
      },
      {
        id: 2,
        channel_id: 'phone',
        sla_breached: false,
        rating: null,
        status: 'Open',
        client_id: 2,
        created_date: 10,
        last_update: 20,
      },
      {
        id: 10,
        channel_id: 'chat',
        sla_breached: true,
        rating: 4,
        status: 'Open',
        client_id: 3,
        created_date: 10,
        last_update: 10,
      },
    ];

    const app = express();
    app.use(express.json());
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    try {
      const loginName = `ticket.list.${Math.floor(Math.random() * 1e6)}`;
      createEmployeeUser(db, {
        phone: `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
        displayName: 'Ticket Reader',
        rights: { open_admin_dashboard: 1, tickets_read: 1 },
        adminLogin: loginName,
        password: 'panel-secret',
        telegramId: 770000 + Math.floor(Math.random() * 10000),
      });
      const loginRes = await new Promise<any>((resolve?: any, reject?: any) => {
        const { port } = server.address();
        const payload = JSON.stringify({ login: loginName, password: 'panel-secret' });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/bot-admin/api/login',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
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
      assert.equal(loginRes.statusCode, 200);
      const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(cookie);

      calls.length = 0;
      const pageRes = await requestJson(
        server,
        'GET',
        '/bot-admin/api/tickets?page=2&limit=25',
        { headers: { Cookie: cookie } }
      );
      assert.equal(pageRes.statusCode, 200);
      const pageBody = JSON.parse(pageRes.body);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].limit, 25);
      assert.equal(calls[0].offset, 25);
      assert.equal(pageBody.total, 1740);
      assert.equal(pageBody.tickets.length, 1);
      assert.equal(pageBody.tickets[0].id, 7);
      assert.equal(pageBody.summary, undefined);
      assert.equal(pageBody.duration_summary, undefined);
      assert.deepEqual(unexpected, []);

      calls.length = 0;
      const filteredList = await requestJson(
        server,
        'GET',
        '/bot-admin/api/tickets?page=1&limit=25&minimum_call_duration_seconds=30',
        { headers: { Cookie: cookie } }
      );
      assert.equal(filteredList.statusCode, 200);
      const filteredBody = JSON.parse(filteredList.body);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].limit, 25);
      assert.equal(calls[0].offset, 0);
      assert.equal(filteredBody.summary, undefined);
      assert.equal(filteredBody.duration_summary, undefined);

      catalog = durationCatalog;
      calls.length = 0;
      const summaryRes = await requestJson(
        server,
        'GET',
        '/bot-admin/api/tickets/summary?minimum_call_duration_seconds=30',
        { headers: { Cookie: cookie } }
      );
      assert.equal(summaryRes.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].limit, PAGE_LIMIT);
      assert.equal(calls[0].offset, 0);
      assert.deepEqual(JSON.parse(summaryRes.body).summary, {
        count: 2,
        slaBreached: 2,
        rated: 2,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unexpected, []);

      catalog = durationCatalog;
      calls.length = 0;
      const deduped = await requestJson(
        server,
        'GET',
        '/bot-admin/api/tickets?limit=25&without_duplicates=1&minimum_call_duration_seconds=30',
        { headers: { Cookie: cookie } }
      );
      assert.equal(deduped.statusCode, 200);
      const dedupedBody = JSON.parse(deduped.body);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].limit, PAGE_LIMIT);
      assert.equal(dedupedBody.duration_summary, undefined);
      assert.deepEqual(dedupedBody.summary, {
        count: 2,
        slaBreached: 2,
        rated: 2,
      });
      assert.deepEqual(
        dedupedBody.tickets.map((ticket: any) => ticket.id),
        [1, 2, 10]
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unexpected, []);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('returns per-employee rating totals with duration and dedupe filters', async () => {
    const calls: any[] = [];
    const unexpected: string[] = [];

    (global as any).fetch = async (url?: any, options?: any) => {
      const urlStr = String(url);
      const endpoint = urlStr.split('/v1/')[1] || '';
      if (endpoint === 'User/Get') {
        return jsonOk(
          [
            { id: 101, full_name: 'Анна', login: 'anna' },
            { id: 202, full_name: 'Борис', login: 'boris' },
          ],
          2
        );
      }
      if (endpoint !== 'Ticket/Get') {
        unexpected.push(urlStr);
        throw new Error(`Unexpected fetch ${urlStr}`);
      }
      const body = options?.body ? JSON.parse(options.body) : {};
      calls.push(body);
      return jsonOk(
        [
          {
            id: 1,
            channel_id: 'phone',
            responsible_user_id: 101,
            sla_breached: true,
            rating: 5,
            status: 'Open',
            client_id: 1,
            created_date: 10,
            last_update: 40,
          },
          {
            id: 2,
            channel_id: 'phone',
            responsible_user_id: 101,
            sla_breached: false,
            rating: null,
            status: 'Open',
            client_id: 1,
            created_date: 11,
            last_update: 35,
          },
          {
            id: 3,
            channel_id: 'chat',
            responsible_user_id: 202,
            sla_breached: true,
            rating: 4,
            status: 'Closed',
            client_id: 2,
            created_date: 12,
            last_update: 30,
          },
          {
            id: 4,
            channel_id: 'chat',
            responsible_user_id: null,
            sla_breached: false,
            rating: null,
            status: 'Open',
            client_id: 3,
            created_date: 13,
            last_update: 20,
          },
        ],
        4
      );
    };

    replaceRegosChannelSettings(db, [
      { channel_id: 'phone', interaction_mode: 'call', channel_name: 'Phone' },
      { channel_id: 'chat', interaction_mode: 'message_only', channel_name: 'Chat' },
    ]);
    upsertTicketRecording(db, {
      ticketId: 1,
      recordingUrl: 'http://calls.example/1.wav',
      durationSeconds: 45,
    });
    upsertTicketRecording(db, {
      ticketId: 2,
      recordingUrl: 'http://calls.example/2.wav',
      durationSeconds: 10,
    });

    const anna = createEmployeeUser(db, {
      phone: '+998901010101',
      displayName: 'Анна',
    });
    const boris = createEmployeeUser(db, {
      phone: '+998902020202',
      displayName: 'Борис',
    });
    linkEmployeeTelegram(db, anna.id, 101001);
    linkEmployeeTelegram(db, boris.id, 202002);
    setBotUserRegosLink(db, anna.id, { regosUserId: 101, regosFullName: 'Анна' });
    setBotUserRegosLink(db, boris.id, { regosUserId: 202, regosFullName: 'Борис' });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 101001,
      botUserPhone: '+998901010101',
      clientPhone: '+998903030303',
      amount: 10000,
      status: 'pending',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 101001,
      botUserPhone: '+998901010101',
      clientPhone: '+998904040404',
      amount: 20000,
      status: 'paid',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 101001,
      botUserPhone: '+998901010101',
      clientPhone: '+998905050505',
      amount: 99999,
      status: 'deleted',
    });
    createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 202002,
      botUserPhone: '+998902020202',
      clientPhone: '+998906060606',
      amount: 5000,
      status: 'paid_cash',
      paymentProvider: 'cash',
    });

    const app = express();
    app.use(express.json());
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    try {
      const loginName = `ticket.rating.${Math.floor(Math.random() * 1e6)}`;
      createEmployeeUser(db, {
        phone: `+99891${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
        displayName: 'Ticket Rater',
        rights: { open_admin_dashboard: 1, tickets_read: 1 },
        adminLogin: loginName,
        password: 'panel-secret',
        telegramId: 780000 + Math.floor(Math.random() * 10000),
      });
      const loginRes = await new Promise<any>((resolve?: any, reject?: any) => {
        const { port } = server.address();
        const payload = JSON.stringify({ login: loginName, password: 'panel-secret' });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/bot-admin/api/login',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
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
      assert.equal(loginRes.statusCode, 200);
      const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(cookie);

      calls.length = 0;
      const ratingRes = await requestJson(
        server,
        'GET',
        '/bot-admin/api/tickets/rating?minimum_call_duration_seconds=30&without_duplicates=1',
        { headers: { Cookie: cookie } }
      );
      assert.equal(ratingRes.statusCode, 200);
      const body = JSON.parse(ratingRes.body);
      // Call #2 fails duration (10s <= 30); message tickets + call #1 remain.
      assert.deepEqual(body.summary, {
        count: 3,
        slaBreached: 2,
        rated: 2,
        call_duration_seconds: 45,
        orders_amount: 35000,
        orders_paid_amount: 25000,
      });
      assert.deepEqual(body.employees, [
        {
          user_id: 101,
          name: 'Анна',
          count: 1,
          slaBreached: 1,
          rated: 1,
          call_duration_seconds: 45,
          orders_amount: 30000,
          orders_paid_amount: 20000,
        },
        {
          user_id: 202,
          name: 'Борис',
          count: 1,
          slaBreached: 1,
          rated: 1,
          call_duration_seconds: 0,
          orders_amount: 5000,
          orders_paid_amount: 5000,
        },
        {
          user_id: null,
          name: 'Без ответственного',
          count: 1,
          slaBreached: 0,
          rated: 0,
          call_duration_seconds: 0,
          orders_amount: 0,
          orders_paid_amount: 0,
        },
      ]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].limit, PAGE_LIMIT);
      assert.deepEqual(unexpected, []);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
