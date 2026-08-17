const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createPromptVariable } = require('../src/db/ai-prompt-variables');
const { createKnowledgeCategory, formatKnowledgeCategoriesForTools } = require('../src/db/knowledge-articles');
const {
  listToolDescriptions,
  getToolDescription,
  saveToolDescription,
  resetToolDescription,
  resolveToolDescription,
  prepareAgentTools,
} = require('../src/db/ai-tool-descriptions');
const { getDefaultToolDescription, DEFAULT_TOOL_DESCRIPTIONS } = require('../src/ai/tools/descriptions');
const { AGENT_TOOL_CATALOG } = require('../src/ai/tools/catalog');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-tool-desc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
          }),
        );
      },
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

describe('AI tool descriptions', { concurrency: false }, () => {
  let db = null;
  let dbPath = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (dbPath) removeDbFiles(dbPath);
    dbPath = null;
  });

  function createDb() {
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    return db;
  }

  it('covers every catalog tool with a factory default', () => {
    for (const tool of AGENT_TOOL_CATALOG) {
      assert.ok(getDefaultToolDescription(tool.name), `missing default for ${tool.name}`);
    }
    assert.equal(Object.keys(DEFAULT_TOOL_DESCRIPTIONS).length, AGENT_TOOL_CATALOG.length);
  });

  it('lists defaults without interpolating stored tokens', () => {
    const database = createDb();
    createPromptVariable(database, { key: 'hello', name: 'Hello', source: "return 'world';" });
    const listed = listToolDescriptions(database);
    const search = listed.find((tool) => tool.name === 'search_knowledge');
    assert.ok(search);
    assert.equal(search.body, search.default_body);
    assert.equal(search.is_custom, false);
    assert.equal(search.default_body, getDefaultToolDescription('search_knowledge'));

    const saved = saveToolDescription(database, 'search_knowledge', 'Find {{hello}} and {{missing}}');
    assert.equal(saved.is_custom, true);
    assert.equal(saved.body, 'Find {{hello}} and {{missing}}');
    assert.equal(getToolDescription(database, 'search_knowledge').body, 'Find {{hello}} and {{missing}}');
  });

  it('round-trips a custom body and resets default-equal or empty values', () => {
    const database = createDb();
    const custom = saveToolDescription(database, 'get_article', 'Load article {{hello}}');
    assert.equal(custom.is_custom, true);
    assert.equal(custom.body, 'Load article {{hello}}');

    const sameAsDefault = saveToolDescription(
      database,
      'get_article',
      getDefaultToolDescription('get_article'),
    );
    assert.equal(sameAsDefault.is_custom, false);
    assert.equal(sameAsDefault.body, getDefaultToolDescription('get_article'));

    saveToolDescription(database, 'get_article', 'Keep this');
    const emptied = saveToolDescription(database, 'get_article', '  ');
    assert.equal(emptied.is_custom, false);

    saveToolDescription(database, 'get_article', 'Keep this');
    const reset = resetToolDescription(database, 'get_article');
    assert.equal(reset.is_custom, false);
    assert.equal(reset.body, getDefaultToolDescription('get_article'));
  });

  it('rejects unknown tool names', () => {
    const database = createDb();
    assert.throws(() => saveToolDescription(database, 'not_a_tool', 'x'), /UNKNOWN_TOOL/);
    assert.throws(() => getToolDescription(database, 'not_a_tool'), /UNKNOWN_TOOL/);
  });

  it('interpolates {{key}} with ticket context and leaves unknown tokens', () => {
    const database = createDb();
    createPromptVariable(database, { key: 'hello', name: 'Hello', source: "return 'world';" });
    createPromptVariable(database, {
      key: 'ticket_id',
      name: 'Ticket',
      source: 'return String(context.ticket && context.ticket.id || "");',
    });
    saveToolDescription(database, 'get_prices', 'Prices {{hello}} #{{ticket_id}} {{missing}}');
    assert.equal(
      resolveToolDescription(database, 'get_prices', '', { id: 42 }),
      'Prices world #42 {{missing}}',
    );
  });

  it('applies overrides through prepareAgentTools and keeps the KB category suffix', () => {
    const database = createDb();
    const category = createKnowledgeCategory(database, { name: 'Прайс', tags: 'цены' });
    const categoryLine = formatKnowledgeCategoriesForTools(database);
    assert.match(categoryLine, new RegExp(String(category.id)));

    saveToolDescription(database, 'search_knowledge', 'Custom search {{missing}}');
    const tools = prepareAgentTools(
      [
        { name: 'search_knowledge', description: 'factory' },
        { name: 'notify_employee', description: 'factory notify' },
      ],
      {
        db: database,
        settings: { disabledAgentTools: { customer: ['notify_employee'], customer_assist: [], kb: [] } },
        agentSlug: 'customer',
        ticket: { id: 7 },
      },
    );
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['search_knowledge'],
    );
    assert.equal(tools[0].description, `Custom search {{missing}} ${categoryLine}`);
  });
});

describe('AI tool descriptions API', { concurrency: false }, () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

  afterEach(async () => {
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
    previousEnv = null;
  });

  async function startServer() {
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
  }

  async function loginEmployee(rights) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
    const login = `td-${suffix}`;
    const password = 'td-pass';
    createEmployeeUser(db, {
      phone: `+99892${suffix}`,
      displayName: 'Tool Desc Tester',
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
    return cookie;
  }

  it('allows read with settings_read and requires settings_edit to save', async () => {
    await startServer();
    const reader = await loginEmployee({});
    const editor = await loginEmployee({ settings_edit: 1 });

    const listed = await request(server, 'GET', '/bot-admin/api/ai/tool-descriptions', {
      headers: { Cookie: reader },
    });
    assert.equal(listed.statusCode, 200);
    const payload = JSON.parse(listed.body);
    const search = payload.tools.find((tool) => tool.name === 'search_knowledge');
    assert.equal(search.is_custom, false);
    assert.equal(search.body, getDefaultToolDescription('search_knowledge'));

    const denied = await request(server, 'PUT', '/bot-admin/api/ai/tool-descriptions/search_knowledge', {
      headers: { Cookie: reader },
      body: { body: 'Nope' },
    });
    assert.equal(denied.statusCode, 403);

    const saved = await request(server, 'PUT', '/bot-admin/api/ai/tool-descriptions/search_knowledge', {
      headers: { Cookie: editor },
      body: { body: 'Custom {{hello}}' },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(JSON.parse(saved.body).tool.body, 'Custom {{hello}}');
    assert.equal(JSON.parse(saved.body).tool.is_custom, true);

    const unknown = await request(server, 'PUT', '/bot-admin/api/ai/tool-descriptions/not_a_tool', {
      headers: { Cookie: editor },
      body: { body: 'x' },
    });
    assert.equal(unknown.statusCode, 404);

    const reset = await request(server, 'DELETE', '/bot-admin/api/ai/tool-descriptions/search_knowledge', {
      headers: { Cookie: editor },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(JSON.parse(reset.body).tool.is_custom, false);
  });
});
