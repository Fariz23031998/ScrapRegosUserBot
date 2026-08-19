const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createLocation } = require('../src/db/locations');
const { listAdminAuditLogs } = require('../src/db/admin-audit-logs');
const { getDevice } = require('../src/db/devices');

const MCP_TOKEN = 'test-ops-mcp-token';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ops-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function mcpRpc(id, method, params) {
  const body = { jsonrpc: '2.0', method };
  if (id !== undefined) body.id = id;
  if (params !== undefined) body.params = params;
  return body;
}

function parseJson(res) {
  return JSON.parse(res.body || '{}');
}

function parseToolPayload(res) {
  const rpc = parseJson(res);
  assert.ok(rpc.result, 'expected JSON-RPC result');
  assert.ok(Array.isArray(rpc.result.content));
  assert.equal(rpc.result.content[0]?.type, 'text');
  return {
    rpc,
    isError: Boolean(rpc.result.isError),
    data: JSON.parse(rpc.result.content[0].text),
  };
}

describe('ops MCP HTTP', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;
  let location;

  before(() => {
    previousEnv = {
      MCP_TOKEN: process.env.MCP_TOKEN,
      MCP_OPS_READONLY: process.env.MCP_OPS_READONLY,
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
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

    process.env.MCP_TOKEN = MCP_TOKEN;
    delete process.env.MCP_OPS_READONLY;
    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    const employee = createEmployeeUser(db, { phone: '+998901000041', displayName: 'Монтёр' });
    location = createLocation(db, { name: 'Филиал MCP', allowed_user_ids: [employee.id] });
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const httpServer = http.createServer(app);
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer));
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
  });

  function callMcp(body, { token = MCP_TOKEN, headers = {} } = {}) {
    return request(server, 'POST', '/bot-admin/mcp/ops', {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body,
    });
  }

  it('returns 503 when MCP_TOKEN is unset', async () => {
    delete process.env.MCP_TOKEN;
    const res = await callMcp(mcpRpc(1, 'initialize', { protocolVersion: '2025-03-26' }), {
      token: MCP_TOKEN,
    });
    assert.equal(res.statusCode, 503);
  });

  it('returns 401 without a token', async () => {
    const res = await callMcp(mcpRpc(1, 'initialize', { protocolVersion: '2025-03-26' }), {
      token: '',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 405 for GET', async () => {
    const res = await request(server, 'GET', '/bot-admin/mcp/ops', {
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
    });
    assert.equal(res.statusCode, 405);
  });

  it('initializes as scrapregos-ops and lists write tools', async () => {
    const init = await callMcp(
      mcpRpc(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      })
    );
    assert.equal(init.statusCode, 200);
    assert.equal(parseJson(init).result.serverInfo?.name, 'scrapregos-ops');

    const listed = await callMcp(mcpRpc(2, 'tools/list', {}));
    const names = parseJson(listed).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('devices_search'));
    assert.ok(names.includes('devices_create'));
    assert.ok(names.includes('tasks_create'));
    assert.ok(names.includes('tasks_create_payment'));
    assert.ok(names.includes('repair_returns_search'));
    assert.ok(names.includes('repair_returns_create'));
  });

  it('omits write tools when MCP_OPS_READONLY=1', async () => {
    process.env.MCP_OPS_READONLY = '1';
    const listed = await callMcp(mcpRpc(1, 'tools/list', {}));
    const names = parseJson(listed).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('devices_search'));
    assert.ok(names.includes('tasks_get'));
    assert.ok(names.includes('repair_returns_search'));
    assert.ok(!names.includes('devices_create'));
    assert.ok(!names.includes('tasks_create'));
    assert.ok(!names.includes('repair_returns_create'));
  });

  it('rejects writes when read-only', async () => {
    process.env.MCP_OPS_READONLY = '1';
    const res = await callMcp(
      mcpRpc(1, 'tools/call', {
        name: 'devices_create',
        arguments: { name: 'Запрещено', price_uzs: 1 },
      })
    );
    const payload = parseToolPayload(res);
    assert.equal(payload.isError, true);
    assert.match(payload.data.error, /read-only/i);
  });

  it('creates a device and a task, then audits the write', async () => {
    const deviceRes = await callMcp(
      mcpRpc(1, 'tools/call', {
        name: 'devices_create',
        arguments: { name: 'Принтер MCP', price_uzs: 500000 },
      })
    );
    const devicePayload = parseToolPayload(deviceRes);
    assert.equal(devicePayload.isError, false);
    assert.equal(devicePayload.data.name, 'Принтер MCP');
    assert.ok(getDevice(db, devicePayload.data.id));

    const taskRes = await callMcp(
      mcpRpc(2, 'tools/call', {
        name: 'tasks_create',
        arguments: { title: 'Задача MCP', location_id: location.id, action: 'install' },
      })
    );
    const taskPayload = parseToolPayload(taskRes);
    assert.equal(taskPayload.isError, false);
    assert.equal(taskPayload.data.title, 'Задача MCP');

    const audit = listAdminAuditLogs(db, { query: 'Принтер MCP', limit: 5 });
    assert.ok(audit.logs.some((row) => row.actor_type === 'mcp' && String(row.summary || '').includes('Принтер MCP')));
  });
});
