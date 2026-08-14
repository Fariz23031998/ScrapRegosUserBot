const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createEmployeeUser } = require('../src/db/bot-users-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');

const { openDb } = require('../src/db/partners-db');
const {
  deleteTicketSummary,
  getTicketSummary,
  hasSuccessfulTicketSummary,
  listClientTicketSummaries,
  saveTicketSummaryText,
  upsertTicketSummary,
} = require('../src/db/ticket-summaries');
const {
  appendPriorTicketSummaries,
  estimateTokens,
  fetchChatMessagesInPeriod,
  formatPriorSummariesForPrompt,
  isMessageInTicketPeriod,
  resolveTicketMessagePeriod,
} = require('../src/ai/ticket-period');
const {
  EMPTY_SUMMARY,
  shouldSummarizeClosedTicket,
  summarizeClosedTicket,
} = require('../src/ai/ticket-summary-agent');
const { transcribeChatAudio, clearTranscribeCache } = require('../src/ai/transcribe');
const { captionChatImage, clearCaptionCache } = require('../src/ai/image-caption');
const { createCustomerTools } = require('../src/ai/tools/customer');
const { SUMMARY_TOKEN_BUDGET } = require('../src/ai/settings');

let db = null;
let dbPath = null;

function removeDbFiles(filePath) {
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

describe('ticket period helpers', () => {
  it('uses created_date through resolved_date', () => {
    assert.deepEqual(
      resolveTicketMessagePeriod({ created_date: 1000, resolved_date: 2000 }),
      { from: 1000, to: 2000 }
    );
    assert.equal(isMessageInTicketPeriod({ created_date: 999 }, { from: 1000, to: 2000 }), false);
    assert.equal(isMessageInTicketPeriod({ created_date: 1500 }, { from: 1000, to: 2000 }), true);
    assert.equal(isMessageInTicketPeriod({ created_date: 2001 }, { from: 1000, to: 2000 }), false);
  });

  it('pages newest-first until the ticket window is covered', async () => {
    const all = [
      { id: '1', created_date: 100, text: 'old' },
      { id: '2', created_date: 1100, text: 'keep-1' },
      { id: '3', created_date: 1200, text: 'keep-2' },
      { id: '4', created_date: 1300, text: 'keep-3' },
    ];
    const requested = [];
    const messages = await fetchChatMessagesInPeriod('chat-1', {
      from: 1000,
      to: 2000,
      stopAfter: 2,
      getTicketMessages: async (_chatId, options = {}) => {
        requested.push({ limit: options.limit, offset: options.offset });
        const limit = options.limit || all.length;
        const offset = options.offset || 0;
        const newestFirst = [...all].reverse();
        return {
          total: all.length,
          result: newestFirst.slice(offset, offset + limit).reverse(),
        };
      },
    });
    assert.deepEqual(requested, [{ limit: 2, offset: 0 }]);
    assert.deepEqual(
      messages.map((item) => item.id),
      ['3', '4']
    );
  });
});

describe('prior summary token budget', () => {
  it('drops oldest summaries and truncates the last one to the budget', () => {
    const summaries = [
      { ticket_id: 3, summary: 'C'.repeat(40) },
      { ticket_id: 2, summary: 'B'.repeat(40) },
      { ticket_id: 1, summary: 'A'.repeat(40) },
    ];
    const block = formatPriorSummariesForPrompt(summaries, {
      systemText: 'SYS',
      budgetTokens: 30,
    });
    assert.match(block, /#3:/);
    assert.ok(estimateTokens(`SYS\n\n${block}`) <= 32);
    assert.ok(!block.includes('#1:'));
  });

  it('keeps system plus summaries under the default budget', () => {
    const system = 'BASE';
    const next = appendPriorTicketSummaries(system, [
      { ticket_id: 9, summary: 'Кратко: касса не печатала чеки.' },
    ]);
    assert.match(next, /BASE/);
    assert.match(next, /касса не печатала чеки/);
    assert.ok(estimateTokens(next) <= SUMMARY_TOKEN_BUDGET);
  });
});

describe('ticket summary agent', () => {
  it('summarizes in-period messages and stores the result', async () => {
    const database = createDb();
    const result = await summarizeClosedTicket({
      db: database,
      ticket: {
        id: 42,
        chat_id: 'chat-42',
        client_id: 7,
        created_date: 1000,
        resolved_date: 2000,
        status: 'Closed',
      },
      deps: {
        getTicketMessages: async () => ({
          total: 3,
          result: [
            { id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'old', created_date: 100 },
            { id: '2', author_entity_type: 'Client', message_type: 'Regular', text: 'Касса сломалась', created_date: 1100 },
            { id: '3', author_entity_type: 'User', message_type: 'Regular', text: 'Перезапустили', created_date: 1200 },
          ],
        }),
        runAgent: async ({ messages }) => {
          assert.match(messages[0].content, /Касса сломалась/);
          assert.equal(messages[0].content.includes('old'), false);
          return { content: 'Клиент чинил кассу, перезапустили.', steps: 1 };
        },
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.summary.summary, 'Клиент чинил кассу, перезапустили.');
    assert.equal(result.summary.message_count, 2);
    assert.equal(hasSuccessfulTicketSummary(database, 42), true);
    assert.equal(getTicketSummary(database, 42).client_id, 7);
  });

  it('includes transcribed voice notes in the summary transcript', async () => {
    const database = createDb();
    let captured = null;
    const result = await summarizeClosedTicket({
      db: database,
      ticket: {
        id: 42,
        chat_id: 'chat-42',
        client_id: 7,
        created_date: 1000,
        resolved_date: 2000,
        status: 'Closed',
      },
      deps: {
        getTicketMessages: async () => ({
          total: 1,
          result: [
            {
              id: '2',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              file_ids: [202],
              created_date: 1100,
            },
          ],
        }),
        getChatFilesByIds: async () => [
          {
            id: 202,
            name: 'voice.ogg',
            extension: 'ogg',
            mime_type: 'audio/ogg',
            media_type: 'voice',
            url: 'https://files.example/voice.ogg',
          },
        ],
        transcribeChatAudio: async () => ({ text: 'касса сломалась' }),
        runAgent: async ({ messages, model }) => {
          captured = { messages, model };
          return { content: 'Клиент прислал голосовое про кассу.', steps: 1 };
        },
      },
    });
    assert.equal(result.skipped, false);
    assert.match(captured.messages[0].content, /\[аудио: voice\.ogg #202\]/);
    assert.match(captured.messages[0].content, /Расшифровка: касса сломалась/);
    assert.equal(captured.model, 'gpt-4o-mini');
  });

  it('includes image captions in the summary transcript', async () => {
    const database = createDb();
    let captured = null;
    const result = await summarizeClosedTicket({
      db: database,
      ticket: {
        id: 42,
        chat_id: 'chat-42',
        client_id: 7,
        created_date: 1000,
        resolved_date: 2000,
        status: 'Closed',
      },
      deps: {
        getTicketMessages: async () => ({
          total: 1,
          result: [
            {
              id: '2',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              file_ids: [101],
              created_date: 1100,
            },
          ],
        }),
        getChatFilesByIds: async () => [
          {
            id: 101,
            name: 'shot.png',
            extension: 'png',
            mime_type: 'image/png',
            media_type: 'image',
            url: 'https://files.example/shot.png',
          },
        ],
        captionChatImage: async () => ({ text: 'ошибка на экране кассы' }),
        runAgent: async ({ messages }) => {
          captured = messages;
          return { content: 'Клиент прислал скрин ошибки кассы.', steps: 1 };
        },
      },
    });
    assert.equal(result.skipped, false);
    assert.match(captured[0].content, /\[изображение: shot\.png #101\]/);
    assert.match(captured[0].content, /Описание: ошибка на экране кассы/);
  });

  it('reuses cached audio and image extractions instead of extracting again', async () => {
    const database = createDb();
    let transcribeCalls = 0;
    let captionCalls = 0;
    let captured = null;
    const ticket = {
      id: 42,
      chat_id: 'chat-42',
      client_id: 7,
      created_date: 1000,
      resolved_date: 2000,
      status: 'Closed',
    };
    const deps = {
      getTicketMessages: async () => ({
        total: 1,
        result: [
          {
            id: '2',
            author_entity_type: 'Client',
            message_type: 'Regular',
            text: '',
            file_ids: [101, 202],
            created_date: 1100,
          },
        ],
      }),
      getChatFilesByIds: async () => [
        {
          id: 101,
          name: 'shot.png',
          extension: 'png',
          mime_type: 'image/png',
          media_type: 'image',
          url: 'https://files.example/shot.png',
        },
        {
          id: 202,
          name: 'voice.ogg',
          extension: 'ogg',
          mime_type: 'audio/ogg',
          media_type: 'voice',
          data: Buffer.from('ogg').toString('base64'),
        },
      ],
      transcribeChatAudio: (file, options) =>
        transcribeChatAudio(file, {
          ...options,
          transcribeImpl: async () => {
            transcribeCalls += 1;
            return 'касса сломалась';
          },
        }),
      captionChatImage: (file, options) =>
        captionChatImage(file, {
          ...options,
          download: async () => ({ mime: 'image/png', base64: 'abc', bytes: 3 }),
          captionImpl: async () => {
            captionCalls += 1;
            return 'ошибка на экране кассы';
          },
        }),
      runAgent: async ({ messages }) => {
        captured = messages;
        return { content: 'Клиент прислал голосовое и скрин.', steps: 1 };
      },
    };

    const first = await summarizeClosedTicket({ db: database, ticket, deps });
    assert.equal(first.skipped, false);
    assert.match(captured[0].content, /Расшифровка: касса сломалась/);
    assert.match(captured[0].content, /Описание: ошибка на экране кассы/);
    assert.equal(transcribeCalls, 1);
    assert.equal(captionCalls, 1);

    deleteTicketSummary(database, 42);
    clearTranscribeCache();
    clearCaptionCache();

    const second = await summarizeClosedTicket({ db: database, ticket, deps });
    assert.equal(second.skipped, false);
    assert.match(captured[0].content, /Расшифровка: касса сломалась/);
    assert.match(captured[0].content, /Описание: ошибка на экране кассы/);
    assert.equal(transcribeCalls, 1);
    assert.equal(captionCalls, 1);
  });

  it('does not regenerate a successful summary', async () => {
    const database = createDb();
    upsertTicketSummary(database, {
      ticketId: 42,
      clientId: 7,
      summary: 'Уже готово',
      status: 'done',
    });
    let ran = false;
    const result = await summarizeClosedTicket({
      db: database,
      ticket: { id: 42, chat_id: 'chat-42', client_id: 7 },
      deps: {
        runAgent: async () => {
          ran = true;
          return { content: 'new', steps: 1 };
        },
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already-done');
    assert.equal(ran, false);
    assert.equal(getTicketSummary(database, 42).summary, 'Уже готово');
  });

  it('retries after an error and stores an empty-period summary without the model', async () => {
    const database = createDb();
    upsertTicketSummary(database, {
      ticketId: 42,
      clientId: 7,
      summary: '',
      status: 'error',
      error: 'boom',
    });
    let ran = false;
    const result = await summarizeClosedTicket({
      db: database,
      ticket: {
        id: 42,
        chat_id: 'chat-42',
        client_id: 7,
        created_date: 1000,
        resolved_date: 2000,
      },
      deps: {
        getTicketMessages: async () => ({ total: 0, result: [] }),
        runAgent: async () => {
          ran = true;
          return { content: 'should not run', steps: 1 };
        },
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(ran, false);
    assert.equal(result.summary.summary, EMPTY_SUMMARY);
    assert.equal(result.summary.status, 'done');
  });

  it('detects close webhook actions', () => {
    assert.equal(shouldSummarizeClosedTicket('TicketClosed', { status: 'Open' }), true);
    assert.equal(shouldSummarizeClosedTicket('TicketStatusSet', { status: 'Closed' }), true);
    assert.equal(shouldSummarizeClosedTicket('TicketStatusSet', { status: 'Open' }), false);
    assert.equal(shouldSummarizeClosedTicket('TicketAdded', { status: 'Closed' }), false);
  });
});

describe('search_chat_history tool', () => {
  it('returns current-period messages and stored summaries for other tickets', async () => {
    const database = createDb();
    upsertTicketSummary(database, {
      ticketId: 10,
      clientId: 7,
      summary: 'Старое обращение про фискализацию.',
      status: 'done',
      periodEnd: 800,
    });
    const tools = createCustomerTools({
      db: database,
      ticket: { id: 42, client_id: 7, created_date: 1000, resolved_date: 2000 },
      chatId: 'chat-42',
      deps: {
        getTicketMessages: async () => ({
          total: 2,
          result: [
            { id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'old', created_date: 100 },
            { id: '2', author_entity_type: 'Client', message_type: 'Regular', text: 'now', created_date: 1100 },
          ],
        }),
      },
    });
    const tool = tools.find((item) => item.name === 'search_chat_history');
    const result = await tool.execute({ include_other_tickets: true });
    assert.deepEqual(
      result.messages.map((item) => item.text),
      ['now']
    );
    assert.equal(result.other_ticket_summaries[0].ticket_id, 10);
    assert.match(result.other_ticket_summaries[0].summary, /фискализацию/);
    assert.equal(listClientTicketSummaries(database, 7, { excludeTicketId: 42 }).length, 1);
  });
});

describe('ticket summary store', () => {
  it('saves edited text and deletes the stored summary', () => {
    const database = createDb();
    upsertTicketSummary(database, {
      ticketId: 42,
      clientId: 7,
      summary: 'Старая сводка',
      status: 'error',
      error: 'boom',
    });
    const saved = saveTicketSummaryText(database, 42, '  Исправленная сводка  ');
    assert.equal(saved.summary, 'Исправленная сводка');
    assert.equal(saved.status, 'done');
    assert.equal(saved.error, null);
    assert.equal(saved.client_id, 7);

    assert.throws(() => saveTicketSummaryText(database, 42, '   '), /INVALID_SUMMARY/);

    const deleted = deleteTicketSummary(database, 42);
    assert.equal(deleted.summary, 'Исправленная сводка');
    assert.equal(getTicketSummary(database, 42), null);
    assert.equal(deleteTicketSummary(database, 42), null);
  });
});

describe('ticket summary admin API', () => {
  const previousEnv = {
    BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
    BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  };
  let originalFetch;

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
      else process.env[key] = value;
    }
  });

  function cookieFromSetCookie(setCookie) {
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) return null;
    return String(raw).split(';')[0];
  }

  function request(server, method, urlPath, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
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
      if (payload) req.end(payload);
      else req.end();
    });
  }

  async function withServer(database, fn) {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(database));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      return await fn(server);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function loginAsAdmin(server) {
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
    await withServer(database, async (server) => {
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
    await withServer(database, async (server) => {
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
