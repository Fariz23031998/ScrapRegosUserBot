const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const {
  getServicePricesCatalog,
  replaceServicePricesCatalog,
  DEFAULT_SERVICE_PRICES_CATALOG,
} = require('../src/db/service-prices');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { buildCommandsForTelegramUser, buildDefaultBotCommands } = require('../src/bot/bot-commands');
const { buildPublicPricesUrl } = require('../src/bot/prices-bot');
const { createEmployeeUser, linkEmployeeTelegram, upsertUserRights } = require('../src/db/bot-users-db');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-prices-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function request(server, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Service prices catalog', () => {
  let dbPath;
  let db;
  let previousEnv;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'https://example.test';
  });

  after(() => {
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

  it('seeds the РЕГЛАМЕНТ catalog with bilingual fields and exact Excel prices', () => {
    const catalog = getServicePricesCatalog(db);
    assert.equal(catalog.title_ru, 'РЕГЛАМЕНТ');
    assert.equal(catalog.title_uz, 'REGLAMENT');
    assert.match(catalog.notice_ru, /БЕСПЛАТНО/);
    assert.match(catalog.notice_uz, /BEPUL/);
    assert.equal(catalog.categories.length, 7);
    assert.equal(catalog.categories[0].name_ru, 'STORE MANAGEMENT');
    assert.equal(catalog.categories[6].name_uz, 'USKUNALAR');

    const storeAdd = catalog.categories[0].items[0];
    assert.equal(storeAdd.prices.fixed, '1440000');
    assert.equal(storeAdd.name_uz.includes('STORE'), true);

    const printers = catalog.categories[6].items.find((item) =>
      item.name_ru.includes('принтеров')
    );
    assert.equal(printers.prices.fixed, '70 000/120 000');

    const vcr = catalog.categories[3].items[0];
    assert.equal(vcr.prices.fixed, '0');

    const expectedItemCount = DEFAULT_SERVICE_PRICES_CATALOG.categories.reduce(
      (sum, category) => sum + category.items.length,
      0
    );
    const actualItemCount = catalog.categories.reduce(
      (sum, category) => sum + category.items.length,
      0
    );
    assert.equal(actualItemCount, expectedItemCount);
  });

  it('replaces the catalog atomically and rejects invalid payloads', () => {
    const updated = replaceServicePricesCatalog(db, {
      title_ru: 'Прайс',
      title_uz: 'Narxlar',
      notice_ru: 'RU notice',
      notice_uz: 'UZ notice',
      categories: [
        {
          name_ru: 'Категория',
          name_uz: 'Turkum',
          items: [
            {
              name_ru: 'Услуга',
              name_uz: 'Xizmat',
              prices: { fixed: '1000', min5: '', min30: null, hour1: '2000', hour2: '' },
            },
          ],
        },
      ],
    });
    assert.equal(updated.categories.length, 1);
    assert.equal(updated.categories[0].items[0].prices.fixed, '1000');
    assert.equal(updated.categories[0].items[0].prices.hour1, '2000');
    assert.equal(updated.categories[0].items[0].prices.min5, null);

    assert.throws(
      () =>
        replaceServicePricesCatalog(db, {
          title_ru: '',
          title_uz: 'x',
          notice_ru: 'a',
          notice_uz: 'b',
          categories: [{ name_ru: 'A', name_uz: 'B', items: [{ name_ru: 'C', name_uz: 'D', prices: {} }] }],
        }),
      /INVALID_TEXT/
    );

    const afterInvalid = getServicePricesCatalog(db);
    assert.equal(afterInvalid.title_ru, 'Прайс');
  });

  it('exposes a public read API and authenticated editor API', async () => {
    const app = express();
    app.get('/api/prices', (_req, res) => res.json(getServicePricesCatalog(db)));
    app.get('/prices', (_req, res) => res.status(200).send('ok-public'));
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const publicCatalog = await request(server, 'GET', '/api/prices');
      assert.equal(publicCatalog.statusCode, 200);
      assert.equal(JSON.parse(publicCatalog.body).categories.length, 7);

      const unauthorized = await request(server, 'GET', '/bot-admin/api/prices', {
        headers: { Accept: 'application/json' },
      });
      assert.equal(unauthorized.statusCode, 401);

      const login = await request(server, 'POST', '/bot-admin/api/login', {
        body: JSON.stringify({ login: 'admin', password: 'test-password' }),
      });
      const cookie = String(login.headers['set-cookie'] || '').split(';')[0];

      const adminGet = await request(server, 'GET', '/bot-admin/api/prices', {
        headers: { Cookie: cookie, Accept: 'application/json' },
      });
      assert.equal(adminGet.statusCode, 200);

      const adminPut = await request(server, 'PUT', '/bot-admin/api/prices', {
        headers: { Cookie: cookie, Accept: 'application/json' },
        body: JSON.stringify({
          title_ru: 'Новый',
          title_uz: 'Yangi',
          notice_ru: 'RU',
          notice_uz: 'UZ',
          categories: [
            {
              name_ru: 'A',
              name_uz: 'B',
              items: [{ name_ru: 'C', name_uz: 'D', prices: { fixed: '42' } }],
            },
          ],
        }),
      });
      assert.equal(adminPut.statusCode, 200);
      assert.equal(JSON.parse(adminPut.body).title_ru, 'Новый');
      assert.equal(getServicePricesCatalog(db).categories[0].items[0].prices.fixed, '42');

      const page = await request(server, 'GET', '/bot-admin/prices', {
        headers: { Cookie: cookie, Accept: 'text/html' },
      });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Прайс услуг/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('adds /prices for everyone without rights and builds the public URL', () => {
    assert.ok(buildDefaultBotCommands().some((item) => item.command === 'prices'));

    const guestCommands = buildCommandsForTelegramUser(db, 999001);
    assert.ok(guestCommands.some((item) => item.command === 'prices'));

    const employee = createEmployeeUser(db, {
      phone: '+998901112233',
      displayName: 'Emp',
      rights: { open_admin_dashboard: 0 },
    });
    linkEmployeeTelegram(db, employee.id, 777, {});
    upsertUserRights(db, employee.id, { open_admin_dashboard: 0 });
    const employeeCommands = buildCommandsForTelegramUser(db, 777);
    assert.ok(employeeCommands.some((item) => item.command === 'prices'));
    assert.ok(!employeeCommands.some((item) => item.command === 'open_dashboard'));

    assert.equal(buildPublicPricesUrl(), 'https://example.test/prices');
    process.env.PUBLIC_BASE_URL = 'not-a-url';
    assert.equal(buildPublicPricesUrl(), null);
    process.env.PUBLIC_BASE_URL = 'https://example.test';
  });
});
