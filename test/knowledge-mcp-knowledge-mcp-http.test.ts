import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { getKnowledgeArticle, listKnowledgeArticles, setKnowledgeArticleLocked } from '../src/db/knowledge-articles';
import { listAdminAuditLogs } from '../src/db/admin-audit-logs';

const MCP_TOKEN = 'test-mcp-token';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-knowledge-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

function request(server: any, method: any, urlPath: any, { headers = {}, body = null }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
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
      (res: any) => {
        const chunks: any[] = [];
        res.on('data', (chunk?: any) => chunks.push(chunk));
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

function mcpRpc(id?: any, method?: any, params?: any) {
  const body = { jsonrpc: '2.0', method };
  if (id !== undefined) (body as any).id = id;
  if (params !== undefined) (body as any).params = params;
  return body;
}

function parseJson(res: any) {
  return JSON.parse(res.body || '{}');
}

function parseToolPayload(res: any) {
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
  let dbPath: any;
  let db: any;
  let server: any;
  let previousEnv: any;
  let imagesDir: any;

  before(() => {
    previousEnv = {
      MCP_TOKEN: process.env.MCP_TOKEN,
      MCP_KNOWLEDGE_READONLY: process.env.MCP_KNOWLEDGE_READONLY,
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      KNOWLEDGE_IMAGES_DIR: process.env.KNOWLEDGE_IMAGES_DIR,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapregos-knowledge-mcp-images-'));
    process.env.KNOWLEDGE_IMAGES_DIR = imagesDir;
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
    }
    if (imagesDir) fs.rmSync(imagesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (server) {
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  after(async () => {
    if (server) {
      await new Promise<any>((resolve?: any) => server.close(resolve));
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) removeDbFiles(dbPath);
  });

  function callMcp(body: any, { token = MCP_TOKEN, headers = {} }: Unchecked = {}) {
    return request(server, 'POST', '/bot-admin/mcp', {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body,
    });
  }

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
