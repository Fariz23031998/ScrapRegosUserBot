const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { openDb } = require('../src/db/partners-db');
const { createEmployeeUser, setBotUserRegosLink } = require('../src/db/bot-users-db');
const { createBotAdminRouter } = require('../src/admin/bot-admin');
const {
  RegosCrmError,
  addTicketMessage,
} = require('../src/integrations/regos-crm');

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-chat-send-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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

describe('addTicketMessage', () => {
  let previousToken;
  let originalFetch;

  before(() => {
    previousToken = process.env.REGOS_INTEGRATION_TOKEN;
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.REGOS_INTEGRATION_TOKEN;
    else process.env.REGOS_INTEGRATION_TOKEN = previousToken;
  });

  it('rejects empty chat_id and text before calling Regos', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, async json() { return { ok: true, result: { new_id: 'x' } }; } };
    };

    await assert.rejects(
      () => addTicketMessage({ chatId: '', text: 'hi' }),
      (err) => err instanceof RegosCrmError && err.status === 400
    );
    await assert.rejects(
      () => addTicketMessage({ chatId: 'chat-1', text: '   ' }),
      (err) => err instanceof RegosCrmError && err.status === 400
    );
    assert.equal(called, false);
  });

  it('posts ChatMessage/Add and returns new_id', async () => {
    let captured = null;
    global.fetch = async (url, options) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { ok: true, result: { new_id: 'msg-uuid-1' } };
        },
      };
    };

    const result = await addTicketMessage({
      chatId: ' chat-uuid-1 ',
      text: '  Hello from admin  ',
      authorEntityId: 27,
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'msg-uuid-1');
    assert.match(captured.url, /\/v1\/ChatMessage\/Add$/);
    assert.deepEqual(captured.body, {
      chat_id: 'chat-uuid-1',
      message_type: 'Regular',
      text: 'Hello from admin',
      author_entity_type: 'User',
      author_entity_id: 27,
    });
  });
});

describe('POST /bot-admin/api/tickets/:id/messages', () => {
  let dbPath;
  let db;
  let previousEnv;
  let originalFetch;

  before(() => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      REGOS_INTEGRATION_TOKEN: process.env.REGOS_INTEGRATION_TOKEN,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
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

  function mockRegos({ ticket, addResult, addError, onAdd, onSetParticipants } = {}) {
    global.fetch = async (url, options) => {
      const endpoint = String(url).split('/v1/')[1] || '';
      const body = options?.body ? JSON.parse(options.body) : {};

      if (endpoint === 'Ticket/Get') {
        const rows = ticket ? [ticket] : [];
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              result: rows,
              next_offset: rows.length,
              total: rows.length,
            };
          },
        };
      }

      if (endpoint === 'Ticket/SetParticipants') {
        if (onSetParticipants) onSetParticipants(body);
        return {
          ok: true,
          async json() {
            return { ok: true, result: { row_affected: 1, ids: [ticket?.id].filter(Boolean) } };
          },
        };
      }

      if (endpoint === 'ChatMessage/Add') {
        if (onAdd) onAdd(body);
        if (addError) {
          return {
            ok: true,
            async json() {
              return {
                ok: false,
                result: {
                  error: addError.code || '1220',
                  description: addError.description || 'Chat is closed',
                },
              };
            },
          };
        }
        assert.equal(body.chat_id, ticket.chat_id);
        assert.ok(String(body.text || '').trim());
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              result: addResult || { new_id: 'created-msg-1' },
            };
          },
        };
      }

      throw new Error(`Unexpected Regos endpoint: ${endpoint}`);
    };
  }

  async function loginWithTicketsRead(server, { regosUserId = 27 } = {}) {
    const employee = createEmployeeUser(db, {
      phone: '+998905551199',
      displayName: 'Ticket Sender',
      rights: { tickets_read: 1 },
      adminLogin: 'ticket.sender',
      password: 'panel-secret',
      telegramId: 777001,
    });
    if (regosUserId != null) {
      setBotUserRegosLink(db, employee.id, {
        regosUserId,
        regosLogin: 'ticket.sender',
        regosFullName: 'Ticket Sender',
      });
    }
    const loginRes = await postJson(server, '/bot-admin/api/login', {
      login: 'ticket.sender',
      password: 'panel-secret',
    });
    assert.equal(loginRes.statusCode, 200);
    const cookie = cookieFromSetCookie(loginRes.headers['set-cookie']);
    assert.ok(cookie);
    return { cookie, employee, regosUserId };
  }

  it('sends a message as the linked Regos user', async () => {
    let addBody = null;
    let setParticipantsBody = null;
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
        responsible_user_id: 99,
        participant_user_ids: [99],
      },
      addResult: { new_id: 'msg-42' },
      onAdd: (body) => {
        addBody = body;
      },
      onSetParticipants: (body) => {
        setParticipantsBody = body;
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await postJson(
        server,
        '/bot-admin/api/tickets/42/messages',
        { text: 'Ответ сотруднику' },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 201);
      assert.deepEqual(JSON.parse(res.body), {
        id: 'msg-42',
        chat_id: 'chat-uuid-42',
        author_entity_id: 27,
      });
      assert.deepEqual(setParticipantsBody, {
        id: 42,
        participant_user_ids: [27],
        replace_mode: false,
      });
      assert.equal(addBody.author_entity_type, 'User');
      assert.equal(addBody.author_entity_id, 27);
      assert.equal(addBody.text, 'Ответ сотруднику');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('skips SetParticipants when user is already a ticket participant', async () => {
    let setParticipantsCalled = false;
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
        responsible_user_id: 27,
        participant_user_ids: [27],
      },
      addResult: { new_id: 'msg-42' },
      onSetParticipants: () => {
        setParticipantsCalled = true;
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await postJson(
        server,
        '/bot-admin/api/tickets/42/messages',
        { text: 'Уже участник' },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 201);
      assert.equal(setParticipantsCalled, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects send when employee has no Regos link', async () => {
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: null });
      const res = await postJson(
        server,
        '/bot-admin/api/tickets/42/messages',
        { text: 'hello' },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).message, /REGOS/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects empty text and tickets without chat', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });

      mockRegos({
        ticket: {
          id: 7,
          subject: 'No chat',
          status: 'Open',
          chat_id: 'chat-uuid-7',
          responsible_user_id: 27,
        },
      });
      const empty = await postJson(
        server,
        '/bot-admin/api/tickets/7/messages',
        { text: '   ' },
        { Cookie: cookie }
      );
      assert.equal(empty.statusCode, 400);
      assert.match(JSON.parse(empty.body).message, /текст/i);

      mockRegos({
        ticket: {
          id: 8,
          subject: 'Missing chat',
          status: 'Open',
          chat_id: null,
        },
      });
      const noChat = await postJson(
        server,
        '/bot-admin/api/tickets/8/messages',
        { text: 'hello' },
        { Cookie: cookie }
      );
      assert.equal(noChat.statusCode, 400);
      assert.match(JSON.parse(noChat.body).message, /чат/i);

      mockRegos({ ticket: null });
      const missing = await postJson(
        server,
        '/bot-admin/api/tickets/999/messages',
        { text: 'hello' },
        { Cookie: cookie }
      );
      assert.equal(missing.statusCode, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
