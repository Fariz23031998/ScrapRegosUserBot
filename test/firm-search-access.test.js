const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { ADMIN_PERMISSION_KEYS } = require('../src/db/user-rights');
const { SESSION_COOKIE } = require('../src/admin/bot-admin-auth');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-firm-search-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore missing files
    }
  }
}

function cookieFromSetCookie(headerValue) {
  const list = Array.isArray(headerValue) ? headerValue : String(headerValue || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part) => String(part).trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? match.split(';')[0] : null;
}

function request(server, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload =
      body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: reqHeaders },
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

describe('firm search access', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;
  let originalSearchFirmAdmin;

  before(async () => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'firm-admin';
    process.env.BOT_ADMIN_PASSWORD = 'firm-admin-secret';

    const searchUser = require('../src/bot/search-user');
    originalSearchFirmAdmin = searchUser.searchFirmAdmin;
    searchUser.searchFirmAdmin = async () => ({
      found: true,
      results: [
        {
          type: 'partner',
          phone: '+998901112233',
          recordId: '9',
          clientName: 'Acme',
          message: '<b>Телефон:</b> +998901112233',
        },
      ],
    });
    delete require.cache[require.resolve('../src/admin/bot-admin')];
    const { createBotAdminRouter } = require('../src/admin/bot-admin');

    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    createEmployeeUser(db, {
      phone: '+998901110001',
      displayName: 'Dashboard only',
      adminLogin: 'dashboard.only',
      password: 'dashboard-secret',
      rights: { open_admin_dashboard: 1 },
    });
    createEmployeeUser(db, {
      phone: '+998901110002',
      displayName: 'No firm access',
      adminLogin: 'no.firms',
      password: 'no-firms-secret',
      rights: { open_admin_dashboard: 0, tickets_read: 0, clients_link_firm: 0 },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
  });

  after(() => {
    const searchUser = require('../src/bot/search-user');
    if (originalSearchFirmAdmin) searchUser.searchFirmAdmin = originalSearchFirmAdmin;
    delete require.cache[require.resolve('../src/admin/bot-admin')];
    process.env.BOT_ADMIN_LOGIN = previousEnv.BOT_ADMIN_LOGIN;
    process.env.BOT_ADMIN_PASSWORD = previousEnv.BOT_ADMIN_PASSWORD;
    if (server) server.close();
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
  });

  async function login(loginName, password) {
    const response = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login: loginName, password },
    });
    assert.equal(response.statusCode, 200);
    const cookie = cookieFromSetCookie(response.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  it('includes open_admin_dashboard in session permissions', () => {
    assert.ok(ADMIN_PERMISSION_KEYS.includes('open_admin_dashboard'));
  });

  it('lets a dashboard user search and refuses a user without firm rights', async () => {
    const allowedCookie = await login('dashboard.only', 'dashboard-secret');
    const session = await request(server, 'GET', '/bot-admin/api/session', {
      headers: { Cookie: allowedCookie },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(JSON.parse(session.body).permissions.open_admin_dashboard, true);

    const hit = await request(server, 'GET', '/bot-admin/api/firm-search?q=Acme', {
      headers: { Cookie: allowedCookie },
    });
    assert.equal(hit.statusCode, 200);
    const hitBody = JSON.parse(hit.body);
    assert.equal(hitBody.found, true);
    assert.equal(hitBody.results[0].clientName, 'Acme');
    assert.equal(hitBody.results[0].phone, '+998901112233');

    const deniedCookie = await login('no.firms', 'no-firms-secret');
    const denied = await request(server, 'GET', '/bot-admin/api/firm-search?q=Acme', {
      headers: { Cookie: deniedCookie },
    });
    assert.equal(denied.statusCode, 403);
  });
});
