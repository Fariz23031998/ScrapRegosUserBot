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

  it('searches firm data and stores firm metadata on create', async () => {
    const partner = {
      id: 501,
      name: 'Acme Firm',
      phone: '998901112233',
      legal_status: null,
      contacts: null,
      description: null,
      moderation_status: null,
      balance: null,
      registered_at: '01.01.2026',
    };
    const vcr1Partner = {
      id: 601,
      name: 'VCR Partner',
      inn: '305123456',
      phone: '998909998877',
      company: 'Omega Company LLC',
      legal_status: null,
      contacts: null,
      balance: null,
      registered_at: '01.01.2026',
    };
    const portalSearch = replaceModuleExports('../src/live/portal-search', {
      liveSearchPartners: async (query?: any) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('901112233') || q.includes('acme')) return [partner];
      return [];
    },
      liveSearchVcr1Partners: async (query?: any) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('omega') || q.includes('909998877') || q.includes('305123456')) {
        return [vcr1Partner];
      }
      return [];
    },
      liveSearchPartnerAccounts: async () => [],
      liveSearchLicenses: async () => [],
      liveSearchVcr1Licenses: async () => [],
      liveSearchRposClients: async () => [],
      liveSearchRposAccounts: async () => [],
    });

    delete require.cache[require.resolve('../src/bot/search-user')];
    delete require.cache[require.resolve('../src/admin/bot-admin')];
    const { createBotAdminRouter: createAdmin } = (require('../src/admin/bot-admin') as typeof import('../src/admin/bot-admin'));

    const employee = createEmployeeUser(db, {
      phone: '+998905559900',
      displayName: 'Firm Creator',
      rights: { tickets_read: 1 },
      adminLogin: 'firm.creator',
      password: 'panel-secret',
    });
    db.prepare('UPDATE bot_users SET telegram_id = ? WHERE id = ?').run(555002, employee.id);

    const app = express();
    app.use('/bot-admin', createAdmin(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const loginRes = await postJson(server, '/bot-admin/api/login', {
        login: 'firm.creator',
        password: 'panel-secret',
      });
      assert.equal(loginRes.statusCode, 200);
      const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
      assert.ok(cookie);

      const empty = await getJson(server, '/bot-admin/api/firm-search?q=', { Cookie: cookie });
      assert.equal(empty.statusCode, 400);

      const miss = await getJson(server, '/bot-admin/api/firm-search?q=99999999999', {
        Cookie: cookie,
      });
      assert.equal(miss.statusCode, 200);
      const missBody = JSON.parse(miss.body);
      assert.equal(missBody.found, false);
      assert.deepEqual(missBody.results, []);

      const hit = await getJson(server, '/bot-admin/api/firm-search?q=998901112233', {
        Cookie: cookie,
      });
      assert.equal(hit.statusCode, 200);
      const hitBody = JSON.parse(hit.body);
      assert.equal(hitBody.found, true);
      assert.ok(hitBody.results.some((row?: any) => row.recordId === 501 && row.type === 'partner'));

      const byName = await getJson(server, `/bot-admin/api/firm-search?q=${encodeURIComponent('Acme')}`, {
        Cookie: cookie,
      });
      assert.equal(byName.statusCode, 200);
      const byNameBody = JSON.parse(byName.body);
      assert.equal(byNameBody.found, true);
      assert.ok(byNameBody.results.some((row?: any) => row.recordId === 501 && row.type === 'partner'));

      const byCompany = await getJson(
        server,
        `/bot-admin/api/firm-search?q=${encodeURIComponent('Omega Company')}`,
        { Cookie: cookie }
      );
      assert.equal(byCompany.statusCode, 200);
      const byCompanyBody = JSON.parse(byCompany.body);
      assert.equal(byCompanyBody.found, true);
      assert.ok(
        byCompanyBody.results.some((row?: any) => row.recordId === 601 && row.type === 'vcr1_partner')
      );

      const create = await postJson(
        server,
        '/bot-admin/api/orders',
        {
          amount: 25000,
          client_phone: '998901112233',
          ticket_id: 77,
          client_name: 'Acme Firm',
          client_type: 'partner',
          record_id: 501,
          firm_message: 'Acme Firm block',
        },
        { Cookie: cookie }
      );
      assert.equal(create.statusCode, 201, create.body);
      const created = JSON.parse(create.body);
      assert.equal(created.order.client_type, 'partner');
      const meta = JSON.parse(created.order.metadata);
      assert.equal(meta.recordId, 501);
      assert.equal(meta.clientName, 'Acme Firm');
      assert.equal(meta.message, 'Acme Firm block');
      assert.equal(meta.type, 'partner');
    } finally {
      portalSearch.restore();
      delete require.cache[require.resolve('../src/bot/search-user')];
      delete require.cache[require.resolve('../src/admin/bot-admin')];
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});

describe('searchUser vs searchFirmAdmin', () => {
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

  it('keeps searchUser phone/code-only while searchFirmAdmin finds by name', async () => {
    const partner = {
      id: 701,
      name: 'UniqueName Corp',
      phone: '998901234000',
      legal_status: null,
      contacts: null,
      description: null,
      moderation_status: null,
      balance: null,
      registered_at: '01.01.2026',
    };
    const portalSearch = replaceModuleExports('../src/live/portal-search', {
      liveSearchPartners: async (query?: any) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('uniquename') || q.includes('901234000')) return [partner];
      return [];
    },
      liveSearchPartnerAccounts: async () => [],
      liveSearchLicenses: async () => [],
      liveSearchVcr1Partners: async () => [],
      liveSearchVcr1Licenses: async () => [],
      liveSearchRposClients: async () => [],
      liveSearchRposAccounts: async () => [],
    });

    try {
      delete require.cache[require.resolve('../src/bot/search-user')];
      const { searchUser, searchFirmAdmin } = (require('../src/bot/search-user') as typeof import('../src/bot/search-user'));

      const botResult = await searchUser('UniqueName', db);
      assert.equal(botResult.found, false);

      const adminResult = await searchFirmAdmin('UniqueName', db);
      assert.equal(adminResult.found, true);
      assert.ok((adminResult as any).results.some((row?: any) => row.recordId === 701 && row.type === 'partner'));

      const phoneResult = await searchUser('998901234000', db);
      assert.equal(phoneResult.found, true);
    } finally {
      portalSearch.restore();
      delete require.cache[require.resolve('../src/bot/search-user')];
    }
  });
});
