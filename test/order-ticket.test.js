const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { openDb, createOrder, getOrderById } = require('../src/db/partners-db');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const {
  formatTicketAdminUrl,
  formatOrderTicketLine,
} = require('../src/bot/order-ticket');
const { addLink, listLinksByClient } = require('../src/db/client-firm-links');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-order-ticket-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('order ticket helpers', () => {
  let previousBase;

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
      'Тикет: http://localhost:3000/bot-admin/tickets/123'
    );
    assert.equal(formatOrderTicketLine({}), null);
    assert.equal(formatOrderTicketLine({ ticket_id: null }), null);
  });
});

describe('createOrder ticket_id persistence', () => {
  let dbPath;
  let db;

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
    assert.equal(getOrderById(db, withTicket.id).ticket_id, 42);

    const withoutTicket = createOrder(db, {
      id: crypto.randomUUID(),
      telegramId: 1001,
      botUserPhone: '998901111111',
      clientPhone: '998903333333',
      amount: 10000,
    });
    assert.equal(getOrderById(db, withoutTicket.id).ticket_id, null);
  });
});

describe('POST /bot-admin/api/orders', () => {
  let dbPath;
  let db;
  let previousEnv;
  let originalFetch;

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
    const server = await new Promise((resolve) => {
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
      assert.equal(stored.ticket_id, 99);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function loginEmployee(server, { login, password }) {
    const loginRes = await postJson(server, '/bot-admin/api/login', { login, password });
    assert.equal(loginRes.statusCode, 200);
    const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  function firmOrderPayload(overrides = {}) {
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
    const server = await new Promise((resolve) => {
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
      assert.equal(links[0].firm_type, 'partner');
      assert.equal(links[0].firm_record_id, '501');
      assert.equal(links[0].firm_name, 'Acme Firm');
      assert.equal(links[0].firm_phone, '998909998877');
    } finally {
      await new Promise((resolve) => server.close(resolve));
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
    const server = await new Promise((resolve) => {
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
      await new Promise((resolve) => server.close(resolve));
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
    const server = await new Promise((resolve) => {
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
      await new Promise((resolve) => server.close(resolve));
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
    const server = await new Promise((resolve) => {
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
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects password-only admin without bot user telegram', async () => {
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

      const res = await postJson(
        server,
        '/bot-admin/api/orders',
        { amount: 1000, client_phone: '998901234567', ticket_id: 1 },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  function getJson(server, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
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
  }

  it('searches firm data and stores firm metadata on create', async () => {
    const portalSearch = require('../src/live/portal-search');
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
    const originals = { ...portalSearch };
    portalSearch.liveSearchPartners = async (query) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('901112233') || q.includes('acme')) return [partner];
      return [];
    };
    portalSearch.liveSearchVcr1Partners = async (query) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('omega') || q.includes('909998877') || q.includes('305123456')) {
        return [vcr1Partner];
      }
      return [];
    };
    portalSearch.liveSearchPartnerAccounts = async () => [];
    portalSearch.liveSearchLicenses = async () => [];
    portalSearch.liveSearchVcr1Licenses = async () => [];
    portalSearch.liveSearchRposClients = async () => [];
    portalSearch.liveSearchRposAccounts = async () => [];

    delete require.cache[require.resolve('../src/bot/search-user')];
    delete require.cache[require.resolve('../src/admin/bot-admin')];
    const { createBotAdminRouter: createAdmin } = require('../src/admin/bot-admin');

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
    const server = await new Promise((resolve) => {
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
      assert.ok(hitBody.results.some((row) => row.recordId === 501 && row.type === 'partner'));

      const byName = await getJson(server, `/bot-admin/api/firm-search?q=${encodeURIComponent('Acme')}`, {
        Cookie: cookie,
      });
      assert.equal(byName.statusCode, 200);
      const byNameBody = JSON.parse(byName.body);
      assert.equal(byNameBody.found, true);
      assert.ok(byNameBody.results.some((row) => row.recordId === 501 && row.type === 'partner'));

      const byCompany = await getJson(
        server,
        `/bot-admin/api/firm-search?q=${encodeURIComponent('Omega Company')}`,
        { Cookie: cookie }
      );
      assert.equal(byCompany.statusCode, 200);
      const byCompanyBody = JSON.parse(byCompany.body);
      assert.equal(byCompanyBody.found, true);
      assert.ok(
        byCompanyBody.results.some((row) => row.recordId === 601 && row.type === 'vcr1_partner')
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
      Object.assign(portalSearch, originals);
      delete require.cache[require.resolve('../src/bot/search-user')];
      delete require.cache[require.resolve('../src/admin/bot-admin')];
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('searchUser vs searchFirmAdmin', () => {
  let dbPath;
  let db;

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
    const portalSearch = require('../src/live/portal-search');
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

    const original = {
      liveSearchPartners: portalSearch.liveSearchPartners,
      liveSearchPartnerAccounts: portalSearch.liveSearchPartnerAccounts,
      liveSearchLicenses: portalSearch.liveSearchLicenses,
      liveSearchVcr1Partners: portalSearch.liveSearchVcr1Partners,
      liveSearchVcr1Licenses: portalSearch.liveSearchVcr1Licenses,
      liveSearchRposClients: portalSearch.liveSearchRposClients,
      liveSearchRposAccounts: portalSearch.liveSearchRposAccounts,
    };

    portalSearch.liveSearchPartners = async (query) => {
      const q = String(query || '').toLowerCase();
      if (q.includes('uniquename') || q.includes('901234000')) return [partner];
      return [];
    };
    portalSearch.liveSearchPartnerAccounts = async () => [];
    portalSearch.liveSearchLicenses = async () => [];
    portalSearch.liveSearchVcr1Partners = async () => [];
    portalSearch.liveSearchVcr1Licenses = async () => [];
    portalSearch.liveSearchRposClients = async () => [];
    portalSearch.liveSearchRposAccounts = async () => [];

    try {
      delete require.cache[require.resolve('../src/bot/search-user')];
      const { searchUser, searchFirmAdmin } = require('../src/bot/search-user');

      const botResult = await searchUser('UniqueName', db);
      assert.equal(botResult.found, false);

      const adminResult = await searchFirmAdmin('UniqueName', db);
      assert.equal(adminResult.found, true);
      assert.ok(adminResult.results.some((row) => row.recordId === 701 && row.type === 'partner'));

      const phoneResult = await searchUser('998901234000', db);
      assert.equal(phoneResult.found, true);
    } finally {
      Object.assign(portalSearch, original);
      delete require.cache[require.resolve('../src/bot/search-user')];
    }
  });
});
