const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const { getKnowledgeArticle, listKnowledgeArticles, setKnowledgeArticleLocked } = require('../src/db/knowledge-articles');
const { listAdminAuditLogs } = require('../src/db/admin-audit-logs');

const MCP_TOKEN = 'test-mcp-token';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-knowledge-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('knowledge MCP HTTP', () => {
  let dbPath;
  let db;
  let server;
  let previousEnv;

  before(() => {
    previousEnv = {
      MCP_TOKEN: process.env.MCP_TOKEN,
      MCP_KNOWLEDGE_READONLY: process.env.MCP_KNOWLEDGE_READONLY,
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

    dbPath = makeTempDbPath();
    db = openDb(dbPath);
    process.env.MCP_TOKEN = MCP_TOKEN;
    delete process.env.MCP_KNOWLEDGE_READONLY;

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
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
    return request(server, 'POST', '/bot-admin/mcp', {
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
    assert.equal(parseJson(res).message, 'MCP is not configured.');
  });

  it('returns 401 without a token', async () => {
    const res = await callMcp(mcpRpc(1, 'initialize', { protocolVersion: '2025-03-26' }), {
      token: '',
    });
    assert.equal(res.statusCode, 401);
    assert.equal(parseJson(res).message, 'Unauthorized.');
  });

  it('returns 401 with a wrong token', async () => {
    const res = await callMcp(mcpRpc(1, 'initialize', { protocolVersion: '2025-03-26' }), {
      token: 'wrong-token',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 405 for GET and DELETE', async () => {
    const getRes = await request(server, 'GET', '/bot-admin/mcp', {
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
    });
    assert.equal(getRes.statusCode, 405);
    const deleteRes = await request(server, 'DELETE', '/bot-admin/mcp', {
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
    });
    assert.equal(deleteRes.statusCode, 405);
  });

  it('initializes and lists write tools', async () => {
    const init = await callMcp(
      mcpRpc(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      })
    );
    assert.equal(init.statusCode, 200);
    const initBody = parseJson(init);
    assert.equal(initBody.result.protocolVersion, '2025-03-26');
    assert.equal(initBody.result.serverInfo?.name, 'scrapregos-knowledge');
    assert.ok(initBody.result.capabilities?.tools);

    const listed = await callMcp(mcpRpc(2, 'tools/list', {}));
    assert.equal(listed.statusCode, 200);
    const names = parseJson(listed).result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'knowledge_search',
      'knowledge_get',
      'knowledge_create',
      'knowledge_update',
      'knowledge_delete',
    ]);
  });

  it('omits write tools when MCP_KNOWLEDGE_READONLY=1', async () => {
    process.env.MCP_KNOWLEDGE_READONLY = '1';
    const listed = await callMcp(mcpRpc(1, 'tools/list', {}));
    assert.equal(listed.statusCode, 200);
    const names = parseJson(listed).result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['knowledge_search', 'knowledge_get']);
  });

  it('searches, creates, and gets articles', async () => {
    const search = await callMcp(
      mcpRpc(1, 'tools/call', {
        name: 'knowledge_search',
        arguments: { query: 'прайс' },
      })
    );
    assert.equal(search.statusCode, 200);
    const searchPayload = parseToolPayload(search);
    assert.equal(searchPayload.isError, false);
    assert.equal(searchPayload.data.query_used, 'прайс');
    assert.ok(searchPayload.data.articles.some((article) => /прайс/i.test(article.title)));

    const create = await callMcp(
      mcpRpc(2, 'tools/call', {
        name: 'knowledge_create',
        arguments: {
          title: 'MCP unique test article',
          body: 'Created via MCP HTTP endpoint.',
          tags: 'mcp, test',
        },
      })
    );
    assert.equal(create.statusCode, 200);
    const created = parseToolPayload(create);
    assert.equal(created.isError, false);
    assert.ok(created.data.article.id);
    assert.equal(created.data.article.title, 'MCP unique test article');
    assert.equal(getKnowledgeArticle(db, created.data.article.id)?.title, 'MCP unique test article');

    const audit = listAdminAuditLogs(db, { query: 'MCP unique test article', limit: 5 });
    assert.ok(audit.logs.some((row) => row.actor_type === 'mcp' && row.actor_name === 'MCP'));

    const got = await callMcp(
      mcpRpc(3, 'tools/call', {
        name: 'knowledge_get',
        arguments: { id: created.data.article.id },
      })
    );
    assert.equal(got.statusCode, 200);
    const gotPayload = parseToolPayload(got);
    assert.equal(gotPayload.isError, false);
    assert.equal(gotPayload.data.article.id, created.data.article.id);
    assert.match(gotPayload.data.article.body, /MCP HTTP endpoint/);

    const roundTripSearch = await callMcp(
      mcpRpc(4, 'tools/call', {
        name: 'knowledge_search',
        arguments: { query: 'MCP unique test article' },
      })
    );
    const roundTrip = parseToolPayload(roundTripSearch);
    assert.ok(roundTrip.data.articles.some((article) => article.id === created.data.article.id));
  });

  it('rejects update and delete of locked articles', async () => {
    const create = await callMcp(
      mcpRpc(1, 'tools/call', {
        name: 'knowledge_create',
        arguments: {
          title: 'Locked MCP article',
          body: 'Cannot change while locked.',
          tags: 'locked',
        },
      })
    );
    const created = parseToolPayload(create);
    assert.equal(created.isError, false);
    setKnowledgeArticleLocked(db, created.data.article.id, true);

    const update = await callMcp(
      mcpRpc(2, 'tools/call', {
        name: 'knowledge_update',
        arguments: { id: created.data.article.id, title: 'Should fail' },
      })
    );
    const updatePayload = parseToolPayload(update);
    assert.equal(updatePayload.isError, true);
    assert.match(String(updatePayload.data.error || ''), /locked/i);

    const remove = await callMcp(
      mcpRpc(3, 'tools/call', {
        name: 'knowledge_delete',
        arguments: { id: created.data.article.id },
      })
    );
    const removePayload = parseToolPayload(remove);
    assert.equal(removePayload.isError, true);
    assert.match(String(removePayload.data.error || ''), /locked/i);
    assert.equal(getKnowledgeArticle(db, created.data.article.id)?.title, 'Locked MCP article');
  });

  it('rejects create when readonly', async () => {
    process.env.MCP_KNOWLEDGE_READONLY = '1';
    const beforeCount = listKnowledgeArticles(db, { limit: 200 }).total;
    const create = await callMcp(
      mcpRpc(1, 'tools/call', {
        name: 'knowledge_create',
        arguments: {
          title: 'Should not persist',
          body: 'Readonly MCP must reject writes.',
          tags: 'readonly',
        },
      })
    );
    assert.equal(create.statusCode, 200);
    const payload = parseToolPayload(create);
    assert.equal(payload.isError, true);
    assert.match(String(payload.data.error || ''), /read-only/i);
    assert.equal(listKnowledgeArticles(db, { limit: 200 }).total, beforeCount);
  });

  it('accepts X-MCP-Token and ping', async () => {
    const ping = await callMcp(mcpRpc(1, 'ping', {}), {
      token: '',
      headers: { 'X-MCP-Token': MCP_TOKEN },
    });
    assert.equal(ping.statusCode, 200);
    assert.deepEqual(parseJson(ping).result, {});
  });
});
