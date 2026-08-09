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
  setBotUserRegosLink,
  findBotUserByRegosUserId,
} = require('../src/db/bot-users-db');
const {
  collectRegosUserPhones,
  matchPhoneToRegosUser,
  planRegosLinksByPhone,
  mapRegosUserSummary,
} = require('../src/integrations/regos-crm');
const { createBotAdminRouter } = require('../src/admin/bot-admin');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-regos-link-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

describe('REGOS user linking by phone', () => {
  it('collects main_phone and phones list values', () => {
    assert.deepEqual(
      collectRegosUserPhones({
        main_phone: '+998901111111',
        phones: '+998902222222; +998903333333',
      }),
      ['+998901111111', '+998902222222', '+998903333333']
    );
  });

  it('matches phones with different formatting and detects ambiguity', () => {
    const regosUsers = [
      { id: 1, login: 'a', main_phone: '+998 90 111-11-11', full_name: 'A' },
      { id: 2, login: 'b', phones: '998902222222', full_name: 'B' },
    ];
    const matched = matchPhoneToRegosUser('901111111', regosUsers);
    assert.equal(matched.status, 'matched');
    assert.equal(matched.user.id, 1);

    const none = matchPhoneToRegosUser('+998909999999', regosUsers);
    assert.equal(none.status, 'none');

    const ambiguous = matchPhoneToRegosUser('901111111', [
      { id: 10, main_phone: '+998901111111' },
      { id: 11, phones: '998901111111' },
    ]);
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);
  });

  it('plans unique links and skips already linked users', () => {
    const botUsers = [
      { id: 1, phone: '+998901111111', regos_user_id: null },
      { id: 2, phone: '+998902222222', regos_user_id: 99 },
      { id: 3, phone: '+998903333333', regos_user_id: null },
    ];
    const regosUsers = [
      { id: 11, login: 'one', main_phone: '+998901111111', full_name: 'One' },
      { id: 22, login: 'two', main_phone: '+998902222222', full_name: 'Two' },
      { id: 33, login: 'three', main_phone: '+998904444444', full_name: 'Three' },
    ];
    const plan = planRegosLinksByPhone(botUsers, regosUsers);
    assert.equal(plan[0].status, 'matched');
    assert.equal(plan[0].regosUser.id, 11);
    assert.equal(plan[1].status, 'already_linked');
    assert.equal(plan[2].status, 'none');
  });

  it('maps REGOS user summaries', () => {
    const summary = mapRegosUserSummary({
      id: 7,
      login: 'ivanov',
      first_name: 'Ivan',
      last_name: 'Ivanov',
      main_phone: '+998901234567',
    });
    assert.equal(summary.id, 7);
    assert.equal(summary.login, 'ivanov');
    assert.equal(summary.full_name, 'Ivanov Ivan');
  });
});

describe('REGOS link persistence and admin API', () => {
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
    process.env.PUBLIC_BASE_URL = 'https://example.test';
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
    if (dbPath) {
      removeDbFiles(dbPath);
    }
    dbPath = makeTempDbPath();
    db = openDb(dbPath);

    const cols = db.prepare('PRAGMA table_info(bot_users)').all().map((col) => col.name);
    assert.ok(cols.includes('regos_user_id'));
    assert.ok(cols.includes('regos_login'));
    assert.ok(cols.includes('regos_full_name'));
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

  function mockRegosUsers(users) {
    global.fetch = async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          result: users,
          next_offset: users.length,
          total: users.length,
        };
      },
    });
  }

  function postJson(server, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
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
      req.end(payload);
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

  it('stores and enforces unique REGOS links', () => {
    const first = createEmployeeUser(db, {
      phone: '+998901111111',
      displayName: 'First',
    });
    const second = createEmployeeUser(db, {
      phone: '+998902222222',
      displayName: 'Second',
    });

    setBotUserRegosLink(db, first.id, {
      regosUserId: 17,
      regosLogin: 'ivanov',
      regosFullName: 'Ivan Ivanov',
    });
    const linked = findBotUserByRegosUserId(db, 17);
    assert.equal(linked.id, first.id);
    assert.equal(linked.regos_login, 'ivanov');

    assert.throws(
      () =>
        setBotUserRegosLink(db, second.id, {
          regosUserId: 17,
          regosLogin: 'ivanov',
        }),
      /REGOS_USER_LINKED/
    );
  });

  it('auto-links employees through the admin API by phone', async () => {
    mockRegosUsers([
      {
        id: 17,
        first_name: 'Ivan',
        last_name: 'Ivanov',
        full_name: 'Ivan Ivanov',
        login: 'ivanov',
        main_phone: '+998901234567',
        phones: '+998909999999',
        active: true,
      },
      {
        id: 18,
        first_name: 'Petr',
        last_name: 'Petrov',
        full_name: 'Petr Petrov',
        login: 'petrov',
        main_phone: '+998907777777',
        active: true,
      },
    ]);

    const employee = createEmployeeUser(db, {
      phone: '998901234567',
      displayName: 'Bot Ivan',
      rights: { users_edit: 1, users_read: 1 },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
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

      const auto = await postJson(
        server,
        '/bot-admin/api/users/regos-auto-link',
        {},
        { Cookie: cookie, Accept: 'application/json' }
      );
      assert.equal(auto.statusCode, 200);
      const autoBody = JSON.parse(auto.body);
      assert.equal(autoBody.summary.matched, 1);

      const stored = findBotUserByRegosUserId(db, 17);
      assert.equal(stored.id, employee.id);
      assert.equal(stored.regos_login, 'ivanov');

      const single = await postJson(
        server,
        `/bot-admin/api/users/${employee.id}/regos-link`,
        { auto: true },
        { Cookie: cookie, Accept: 'application/json' }
      );
      assert.equal(single.statusCode, 200);
      const singleBody = JSON.parse(single.body);
      assert.equal(singleBody.user.regos_user_id, 17);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('exposes linked regosUserId on employee password session', async () => {
    const employee = createEmployeeUser(db, {
      phone: '+998905551122',
      displayName: 'Linked Panel',
      rights: { tickets_read: 1 },
      adminLogin: 'linked.panel',
      password: 'panel-secret',
    });
    setBotUserRegosLink(db, employee.id, {
      regosUserId: 42,
      regosLogin: 'linked',
      regosFullName: 'Linked Panel',
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const loginRes = await postJson(server, '/bot-admin/api/login', {
        login: 'linked.panel',
        password: 'panel-secret',
      });
      assert.equal(loginRes.statusCode, 200);
      const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(cookie);

      const sessionRes = await new Promise((resolve, reject) => {
        const { port } = server.address();
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/bot-admin/api/session',
            method: 'GET',
            headers: { Cookie: cookie, Accept: 'application/json' },
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
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
      assert.equal(sessionRes.statusCode, 200);
      const sessionBody = JSON.parse(sessionRes.body);
      assert.equal(sessionBody.actor.type, 'user');
      assert.equal(sessionBody.actor.userId, employee.id);
      assert.equal(sessionBody.actor.regosUserId, 42);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
