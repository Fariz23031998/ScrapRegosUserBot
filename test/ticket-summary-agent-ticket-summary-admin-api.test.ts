import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { createEmployeeUser } from '../src/db/bot-users-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { openDb } from '../src/db/partners-db';
import { deleteTicketSummary, getTicketSummary, hasSuccessfulTicketSummary, listClientTicketSummaries, saveTicketSummaryText, upsertTicketSummary } from '../src/db/ticket-summaries';
import { appendPriorTicketSummaries, estimateTokens, fetchChatMessagesInPeriod, formatPriorSummariesForPrompt, isMessageInTicketPeriod, resolveTicketMessagePeriod } from '../src/ai/ticket-period';
import { EMPTY_SUMMARY, shouldSummarizeClosedTicket, summarizeClosedTicket } from '../src/ai/ticket-summary-agent';
import { transcribeChatAudio, clearTranscribeCache } from '../src/ai/transcribe';
import { captionChatImage, clearCaptionCache } from '../src/ai/image-caption';
import { createCustomerTools } from '../src/ai/tools/customer';
import { SUMMARY_TOKEN_BUDGET } from '../src/ai/settings';

let db: any = null;
let dbPath: any = null;

function removeDbFiles(filePath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${filePath}${suffix}`);
    } catch {
      // Ignore missing temporary files.
    }
  }
}

function createDb() {
  dbPath = path.join(
    os.tmpdir(),
    `scrapregos-summary-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  clearTranscribeCache();
  clearCaptionCache();
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});


describe('ticket summary admin API', () => {
  const previousEnv = {
    BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
    BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };
  let originalFetch: any;

  before(() => {
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('summary API tests must not call Regos');
    };
  });

  after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
    }
  });

  function cookieFromSetCookie(setCookie?: any) {
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) return null;
    return String(raw).split(';')[0];
  }

  function request(server: any, method: any, urlPath: any, { headers = {}, body = null }: Unchecked = {}) {
    return new Promise<any>((resolve?: any, reject?: any) => {
      const { port } = server.address();
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
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
      if (payload) req.end(payload);
      else req.end();
    });
  }

  async function withServer(database?: any, fn?: any) {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(database));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      return await fn(server);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  }

  async function loginAsAdmin(server?: any) {
    const res = await request(server, 'POST', '/bot-admin/api/login', {
      body: { login: 'admin', password: 'test-password' },
    });
    assert.equal(res.statusCode, 200);
    const cookie = cookieFromSetCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
  }

  it('creates, updates, and deletes a ticket summary', async () => {
    const database = createDb();
    await withServer(database, async (server?: any) => {
      const cookie = await loginAsAdmin(server);
      const created = await request(server, 'PUT', '/bot-admin/api/tickets/42/summary', {
        headers: { Cookie: cookie },
        body: { summary: '  Клиент спрашивал про кассу.  ', client_id: 7, chat_id: 'chat-42' },
      });
      assert.equal(created.statusCode, 200);
      const createdBody = JSON.parse(created.body);
      assert.equal(createdBody.summary.ticket_id, 42);
      assert.equal(createdBody.summary.summary, 'Клиент спрашивал про кассу.');
      assert.equal(createdBody.summary.status, 'done');
      assert.equal(createdBody.summary.client_id, 7);
      assert.equal(createdBody.summary.chat_id, 'chat-42');

      const empty = await request(server, 'PUT', '/bot-admin/api/tickets/42/summary', {
        headers: { Cookie: cookie },
        body: { summary: '   ' },
      });
      assert.equal(empty.statusCode, 400);

      const updated = await request(server, 'PUT', '/bot-admin/api/tickets/42/summary', {
        headers: { Cookie: cookie },
        body: { summary: 'Кассу починили.' },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(JSON.parse(updated.body).summary.summary, 'Кассу починили.');

      const deleted = await request(server, 'DELETE', '/bot-admin/api/tickets/42/summary', {
        headers: { Cookie: cookie },
      });
      assert.equal(deleted.statusCode, 200);
      assert.equal(getTicketSummary(database, 42), null);

      const missing = await request(server, 'DELETE', '/bot-admin/api/tickets/42/summary', {
        headers: { Cookie: cookie },
      });
      assert.equal(missing.statusCode, 404);
    });
  });

  it('rejects summary edits without tickets_ai_prompt', async () => {
    const database = createDb();
    createEmployeeUser(database, {
      phone: '+998905551188',
      displayName: 'No Prompt',
      rights: { tickets_read: 1 },
      adminLogin: 'no.prompt',
      password: 'panel-secret',
      telegramId: 777002,
    });
    await withServer(database, async (server?: any) => {
      const login = await request(server, 'POST', '/bot-admin/api/login', {
        body: { login: 'no.prompt', password: 'panel-secret' },
      });
      assert.equal(login.statusCode, 200);
      const cookie = cookieFromSetCookie(login.headers['set-cookie']);
      const res = await request(server, 'PUT', '/bot-admin/api/tickets/42/summary', {
        headers: { Cookie: cookie },
        body: { summary: 'Нельзя' },
      });
      assert.equal(res.statusCode, 403);
    });
  });
});
