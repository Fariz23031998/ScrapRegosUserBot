const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-edit-closed-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

describe('PATCH /bot-admin/api/tickets/:id closed gate', () => {
  let dbPath;
  let db;
  let previousEnv;
  let originalFetch;

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
      else process.env[key] = value;
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

  function requestJson(server, method, urlPath, { body, headers } = {}) {
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

  function cookieFromSetCookie(headerValue) {
    const raw = headerValue;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
    const match = list
      .map((part) => String(part).trim())
      .find((part) => part.startsWith('bot_admin_session='));
    return match ? match.split(';')[0] : null;
  }

  function mockTicket(ticket) {
    let current = { ...ticket };
    global.fetch = async (url, options) => {
      const endpoint = String(url).split('/v1/')[1] || '';
      const body = options?.body ? JSON.parse(options.body) : {};

      if (endpoint === 'Ticket/Get') {
        const rows = current ? [current] : [];
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              result: rows,
              next_offset: rows.length,
              total: rows.length,
            };
          },
        };
      }

      if (endpoint === 'Ticket/Edit') {
        current = { ...current, ...body, id: current.id };
        return {
          ok: true,
          async json() {
            return { ok: true, result: { row_affected: 1, ids: [current.id] } };
          },
        };
      }

      if (endpoint === 'Ticket/SetStatus') {
        current = { ...current, status: body.status };
        return {
          ok: true,
          async json() {
            return { ok: true, result: { row_affected: 1, ids: [current.id] } };
          },
        };
      }

      if (endpoint === 'Ticket/SetResponsible') {
        current = { ...current, responsible_user_id: body.responsible_user_id };
        return {
          ok: true,
          async json() {
            return { ok: true, result: { row_affected: 1, ids: [current.id] } };
          },
        };
      }

      throw new Error(`Unexpected Regos endpoint: ${endpoint}`);
    };
  }

  async function loginEmployee(server, rights) {
    const login = `ticket.edit.${Math.floor(Math.random() * 1e6)}`;
    createEmployeeUser(db, {
      phone: `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      displayName: 'Ticket Editor',
      rights: { open_admin_dashboard: 1, ...rights },
      adminLogin: login,
      password: 'panel-secret',
      telegramId: 880000 + Math.floor(Math.random() * 10000),
    });
    const loginRes = await requestJson(server, 'POST', '/bot-admin/api/login', {
      body: { login, password: 'panel-secret' },
    });
    assert.equal(loginRes.statusCode, 200);
    const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  it('allows open tickets with tickets_edit only', async () => {
    mockTicket({
      id: 101,
      subject: 'Open ticket',
      description: 'Desc',
      direction: 'Inbound',
      status: 'Open',
      responsible_user_id: 5,
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, { tickets_edit: 1 });
      const res = await requestJson(server, 'PATCH', '/bot-admin/api/tickets/101', {
        headers: { Cookie: cookie },
        body: { subject: 'Updated open' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).ticket.subject, 'Updated open');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('denies closed tickets with tickets_edit only', async () => {
    mockTicket({
      id: 202,
      subject: 'Closed ticket',
      description: 'Desc',
      direction: 'Inbound',
      status: 'Closed',
      responsible_user_id: 5,
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, { tickets_edit: 1 });
      const res = await requestJson(server, 'PATCH', '/bot-admin/api/tickets/202', {
        headers: { Cookie: cookie },
        body: { subject: 'Should fail', status: 'Open' },
      });
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).message, /закрытого тикета/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('allows closed tickets with tickets_edit and tickets_edit_closed', async () => {
    mockTicket({
      id: 303,
      subject: 'Closed ticket',
      description: 'Desc',
      direction: 'Inbound',
      status: 'Closed',
      responsible_user_id: 5,
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const cookie = await loginEmployee(server, {
        tickets_edit: 1,
        tickets_edit_closed: 1,
      });
      const res = await requestJson(server, 'PATCH', '/bot-admin/api/tickets/303', {
        headers: { Cookie: cookie },
        body: { subject: 'Reopened subject', status: 'Open' },
      });
      assert.equal(res.statusCode, 200);
      const ticket = JSON.parse(res.body).ticket;
      assert.equal(ticket.subject, 'Reopened subject');
      assert.equal(ticket.status, 'Open');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
