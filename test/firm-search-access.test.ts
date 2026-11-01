import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser } from '../src/db/bot-users-db';
import { ADMIN_PERMISSION_KEYS } from '../src/db/user-rights';
import { SESSION_COOKIE } from '../src/admin/bot-admin-auth';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-firm-search-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function replaceModuleExports(specifier: string, overrides: Record<string, unknown>) {
  const id = require.resolve(specifier);
  const current = require(id);
  const next: Record<string, any> = {};
  for (const key of Object.keys(current)) next[key] = current[key];
  Object.assign(next, overrides);
  const cached = require.cache[id];
  const previous = cached?.exports;
  if (cached) cached.exports = next;
  return {
    restore() {
      if (cached) cached.exports = previous;
    },
  };
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore missing files
    }
  }
}

function cookieFromSetCookie(headerValue?: any) {
  const list = Array.isArray(headerValue) ? headerValue : String(headerValue || '').split(/,(?=\s*[^;=]+=)/);
  const match = list
    .map((part?: any) => String(part).trim())
    .find((part?: any) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? match.split(';')[0] : null;
}

function request(server: any, method: any, urlPath: any, { headers = {}, body }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
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

describe('firm search access', () => {
  let dbPath: any;
  let db: any;
  let server: any;
  let previousEnv: any;
  let originalSearchFirmAdmin: any;

  before(async () => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'firm-admin';
    process.env.BOT_ADMIN_PASSWORD = 'firm-admin-secret';

    const searchStub = replaceModuleExports('../src/bot/search-user', {
      searchFirmAdmin: async () => ({
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
    }),
    });
    originalSearchFirmAdmin = searchStub.restore;
    delete require.cache[require.resolve('../src/admin/bot-admin')];
    const { createBotAdminRouter } = (require('../src/admin/bot-admin') as typeof import('../src/admin/bot-admin'));

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
    server = await new Promise<any>((resolve?: any) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
  });

  after(() => {
    if (typeof originalSearchFirmAdmin === 'function') originalSearchFirmAdmin();
    delete require.cache[require.resolve('../src/admin/bot-admin')];
    process.env.BOT_ADMIN_LOGIN = previousEnv.BOT_ADMIN_LOGIN;
    process.env.BOT_ADMIN_PASSWORD = previousEnv.BOT_ADMIN_PASSWORD;
    if (server) server.close();
    if (db) db.close();
    if (dbPath) removeDbFiles(dbPath);
  });

  async function login(loginName?: any, password?: any) {
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
