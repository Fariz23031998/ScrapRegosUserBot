const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createEmployeeUser, DEFAULT_RIGHTS } = require('../src/db/bot-users-db');
const { ADMIN_PERMISSION_KEYS, RIGHTS } = require('../src/db/user-rights');
const { getResolvedPrompt, createPrompt, setActivePrompt } = require('../src/db/ai-prompts');
const {
  listPromptVariables,
  getPromptVariable,
  createPromptVariable,
  updatePromptVariable,
  deletePromptVariable,
  interpolatePrompt,
  runVariable,
  testVariableSource,
} = require('../src/db/ai-prompt-variables');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-prompt-vars-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function request(server, method, urlPath, { headers = {}, body = null } = {}) {
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
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
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
    if (payload) req.write(payload);
    req.end();
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

describe('AI prompt variables', { concurrency: false }, () => {
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

  it('exposes prompt_variables_create permission and user_rights column', () => {
    assert.ok(RIGHTS.prompt_variables_create);
    assert.equal(DEFAULT_RIGHTS.prompt_variables_create, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('prompt_variables_create'));
    const cols = db.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col) => col.name === 'prompt_variables_create'));
  });

  it('creates, updates, lists, and deletes variables', () => {
    const created = createPromptVariable(db, {
      key: 'price_names',
      name: 'Названия услуг',
      source: "return query('SELECT 1 AS ok').map((row) => row.ok).join(',');",
    });
    assert.equal(created.key, 'price_names');
    assert.equal(created.name, 'Названия услуг');
    assert.equal(listPromptVariables(db).length, 1);
    assert.equal(getPromptVariable(db, created.id).key, 'price_names');

    const updated = updatePromptVariable(db, created.id, {
      key: 'service_names',
      name: 'Услуги',
      source: "return 'ok';",
    });
    assert.equal(updated.key, 'service_names');
    assert.equal(updated.name, 'Услуги');

    assert.throws(
      () =>
        createPromptVariable(db, {
          key: 'service_names',
          name: 'Дубль',
          source: "return 'x';",
        }),
      /VARIABLE_KEY_TAKEN/
    );
    assert.throws(
      () =>
        createPromptVariable(db, {
          key: 'Bad Key',
          name: 'Bad',
          source: "return 'x';",
        }),
      /INVALID_VARIABLE_KEY/
    );

    const deleted = deletePromptVariable(db, created.id);
    assert.equal(deleted.ok, true);
    assert.equal(listPromptVariables(db).length, 0);
    assert.throws(() => getPromptVariable(db, created.id), /VARIABLE_NOT_FOUND/);
  });

  it('interpolates {{key}} via getResolvedPrompt and leaves unknown tokens', () => {
    createPromptVariable(db, {
      key: 'hello',
      name: 'Hello',
      source: "return 'world';",
    });
    const prompt = createPrompt(db, {
      type: 'customer',
      name: 'With var',
      body: 'Hello {{hello}} and {{missing}}',
    });
    setActivePrompt(db, 'customer', prompt.id);
    assert.equal(getResolvedPrompt(db, 'customer'), 'Hello world and {{missing}}');
    assert.equal(interpolatePrompt(db, 'No tokens'), 'No tokens');
  });

  it('runs SELECT queries and injects ticket context', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_var_demo (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO prompt_var_demo (id, name) VALUES (?, ?)').run(1, 'Support');
    createPromptVariable(db, {
      key: 'demo_name',
      name: 'Demo',
      source: "const rows = query('SELECT name FROM prompt_var_demo WHERE id = ?', [1]); return rows[0].name;",
    });
    createPromptVariable(db, {
      key: 'ticket_id',
      name: 'Ticket',
      source: 'return String(context.ticket && context.ticket.id || "");',
    });
    const prompt = createPrompt(db, {
      type: 'customer',
      name: 'Context',
      body: '{{demo_name}} #{{ticket_id}}',
    });
    setActivePrompt(db, 'customer', prompt.id);
    assert.equal(getResolvedPrompt(db, 'customer', { ticket: { id: 42 } }), 'Support #42');
  });

  it('rejects writes and ATTACH, and fails soft on thrown code', () => {
    assert.match(runVariable(db, "return query(\"INSERT INTO bot_users (phone) VALUES ('x')\");"), /^$/);
    assert.equal(testVariableSource(db, "return query(\"INSERT INTO bot_users (phone) VALUES ('x')\");").error, 'Разрешены только SELECT-запросы.');
    assert.equal(
      testVariableSource(db, "return query(\"ATTACH DATABASE ':memory:' AS x\");").error,
      'Разрешены только SELECT-запросы.'
    );
    assert.equal(runVariable(db, "throw new Error('boom');"), '');
    createPromptVariable(db, {
      key: 'broken',
      name: 'Broken',
      source: "throw new Error('boom');",
    });
    assert.equal(interpolatePrompt(db, 'X{{broken}}Y'), 'XY');
  });

  it('times out infinite loops', () => {
    const result = testVariableSource(db, 'while (true) {}');
    assert.match(result.error || '', /время выполнения/i);
  });
});

describe('AI prompt variables API', { concurrency: false }, () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

  before(async () => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
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
    for (const [key, value] of Object.entries(previousEnv || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function loginEmployee(rights) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
    const login = `pv-${suffix}`;
    const password = 'pv-pass';
    const employee = createEmployeeUser(db, {
      phone: `+99891${suffix}`,
      displayName: 'Prompt Var Tester',
      adminLogin: login,
      password,
      rights: { open_admin_dashboard: 1, settings_read: 1, ...rights },
    });
    const res = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login, password },
    });
    assert.equal(res.statusCode, 200);
    const cookie = cookieFromSetCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return { cookie, employee };
  }

  it('allows read with settings_read and requires prompt_variables_create for writes', async () => {
    const reader = await loginEmployee({ settings_edit: 1 });
    const author = await loginEmployee({ prompt_variables_create: 1 });

    const listed = await request(server, 'GET', '/bot-admin/api/ai/prompt-variables', {
      headers: { Cookie: reader.cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(listed.body).variables));

    const denied = await request(server, 'POST', '/bot-admin/api/ai/prompt-variables', {
      headers: { Cookie: reader.cookie },
      body: { key: 'denied', name: 'Denied', source: "return 'x';" },
    });
    assert.equal(denied.statusCode, 403);

    const created = await request(server, 'POST', '/bot-admin/api/ai/prompt-variables', {
      headers: { Cookie: author.cookie },
      body: { key: 'ok_var', name: 'OK', source: "return query('SELECT 1 AS n')[0].n;" },
    });
    assert.equal(created.statusCode, 201);
    const variable = JSON.parse(created.body).variable;
    assert.equal(variable.key, 'ok_var');

    const tested = await request(server, 'POST', `/bot-admin/api/ai/prompt-variables/${variable.id}/test`, {
      headers: { Cookie: author.cookie },
      body: {},
    });
    assert.equal(tested.statusCode, 200);
    assert.equal(JSON.parse(tested.body).value, '1');

    const testDenied = await request(server, 'POST', `/bot-admin/api/ai/prompt-variables/${variable.id}/test`, {
      headers: { Cookie: reader.cookie },
      body: {},
    });
    assert.equal(testDenied.statusCode, 403);

    const deleted = await request(server, 'DELETE', `/bot-admin/api/ai/prompt-variables/${variable.id}`, {
      headers: { Cookie: author.cookie },
    });
    assert.equal(deleted.statusCode, 200);
  });
});
