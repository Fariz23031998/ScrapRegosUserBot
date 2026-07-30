const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { SESSION_COOKIE } = require('../src/admin/bot-admin-auth');
const { botAdminPublicDir } = require('../src/paths');

const ADMIN_PAGES = ['index.html', 'order-logs.html', 'technical-support.html', 'prices.html'];
const ADMIN_SCRIPTS = ['admin.js', 'admin-order-logs.js', 'admin-technical-support.js', 'admin-prices.js'];
const LOCAL_ASSET_REF = /(?:href|src)="(?!https?:|\/\/|#|mailto:)([^"]+)"/g;
const TABLE_ELEMENT_CLASS = /<(?:table|thead|tbody|tr|th|td|div)\s+class="([^"${]+)"/g;
const TABLE_CLASS_PREFIXES = ['table-', 'data-table', 'cell-', 'order-logs-table'];

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-admin-assets-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function request(server, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
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
    req.end();
  });
}

describe('Bot admin static assets and API auth', () => {
  let dbPath;
  let db;
  let server;
  let sessionCookie;
  let previousEnv;

  before(async () => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);

    dbPath = makeTempDbPath();
    db = openDb(dbPath);

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const login = await new Promise((resolve, reject) => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/bot-admin/api/login',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers['set-cookie'] || []));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ login: 'admin', password: 'test-password' }));
    });
    sessionCookie = login.map((cookie) => cookie.split(';')[0]).join('; ');
    assert.match(sessionCookie, new RegExp(`^${SESSION_COOKIE}=`));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  it('references every local asset under /bot-admin/', () => {
    const publicDir = botAdminPublicDir();
    for (const page of ADMIN_PAGES) {
      const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
      const refs = [...html.matchAll(LOCAL_ASSET_REF)].map((match) => match[1]);
      assert.ok(refs.length > 0, `${page} should reference local assets`);
      for (const ref of refs) {
        if (ref === '/prices') continue;
        assert.ok(
          ref.startsWith('/bot-admin/'),
          `${page} references "${ref}" which breaks when the URL has no trailing slash`
        );
      }
    }
  });

  it('defines every table class the renderers use', () => {
    const publicDir = botAdminPublicDir();
    const css = fs.readFileSync(path.join(publicDir, 'admin.css'), 'utf8');

    const used = new Set();
    for (const script of ADMIN_SCRIPTS) {
      const source = fs.readFileSync(path.join(publicDir, script), 'utf8');
      for (const match of source.matchAll(TABLE_ELEMENT_CLASS)) {
        for (const token of match[1].trim().split(/\s+/)) {
          if (TABLE_CLASS_PREFIXES.some((prefix) => token.startsWith(prefix))) {
            used.add(token);
          }
        }
      }
    }

    assert.ok(used.has('data-table'), 'renderers should use the shared table class');
    assert.ok(used.has('table-scroll'), 'tables should sit in a scroll container');
    for (const token of used) {
      assert.ok(
        css.includes(`.${token}`),
        `admin.css has no rule for ".${token}" used in a table`
      );
    }
  });

  it('redirects /bot-admin to the canonical trailing-slash URL', async () => {
    const response = await request(server, '/bot-admin', { headers: { Cookie: sessionCookie } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/bot-admin/');
  });

  it('serves stylesheets and scripts with the right content types', async () => {
    const expected = {
      '/bot-admin/admin.css': 'text/css',
      '/bot-admin/admin-common.js': 'application/javascript',
      '/bot-admin/admin.js': 'application/javascript',
      '/bot-admin/admin-order-logs.js': 'application/javascript',
      '/bot-admin/admin-technical-support.js': 'application/javascript',
      '/bot-admin/admin-prices.js': 'application/javascript',
    };

    for (const [urlPath, contentType] of Object.entries(expected)) {
      const response = await request(server, urlPath, { headers: { Cookie: sessionCookie } });
      assert.equal(response.statusCode, 200, `${urlPath} should be served`);
      assert.match(response.headers['content-type'], new RegExp(contentType));
    }
  });

  it('answers unauthenticated API requests with 401 JSON even for browser Accept headers', async () => {
    for (const urlPath of ['/bot-admin/api/users', '/bot-admin/rights-meta']) {
      const response = await request(server, urlPath, { headers: { Accept: '*/*' } });
      assert.equal(response.statusCode, 401, `${urlPath} should return 401`);
      assert.match(response.headers['content-type'], /application\/json/);
      assert.equal(JSON.parse(response.body).message, 'Требуется вход в систему.');
    }
  });

  it('still redirects unauthenticated page requests to the login form', async () => {
    for (const urlPath of ['/bot-admin/', '/bot-admin/order-logs', '/bot-admin/technical-support', '/bot-admin/prices']) {
      const response = await request(server, urlPath, { headers: { Accept: 'text/html' } });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/bot-admin/login');
    }
  });
});
