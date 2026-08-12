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
  addChatFile,
} = require('../src/integrations/regos-crm');
const {
  formatSystemChatMessage,
  enrichChatMessages,
} = require('../src/admin/chat-system-message');

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
    await assert.rejects(
      () => addTicketMessage({ chatId: 'chat-1', text: '', fileIds: [] }),
      (err) => err instanceof RegosCrmError && err.status === 400
    );
    assert.equal(called, false);
  });

  it('posts ChatMessage/Add with file_ids and no text', async () => {
    let captured = null;
    global.fetch = async (url, options) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { ok: true, result: { new_id: 'msg-file-1' } };
        },
      };
    };

    const result = await addTicketMessage({
      chatId: 'chat-uuid-1',
      fileIds: [321, '321', 0],
      authorEntityId: 27,
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'msg-file-1');
    assert.match(captured.url, /\/v1\/ChatMessage\/Add$/);
    assert.deepEqual(captured.body, {
      chat_id: 'chat-uuid-1',
      message_type: 'Regular',
      file_ids: [321],
      author_entity_type: 'User',
      author_entity_id: 27,
    });
    assert.equal(captured.body.text, undefined);
  });

  it('posts ChatMessage/AddFile and returns file_id', async () => {
    let captured = null;
    global.fetch = async (url, options) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { ok: true, result: { file_id: 321 } };
        },
      };
    };

    const result = await addChatFile({
      chatId: ' chat-uuid-1 ',
      name: 'photo.png',
      extension: '.PNG',
      data: 'data:image/png;base64,aGVsbG8=',
    });

    assert.equal(result.ok, true);
    assert.equal(result.file_id, 321);
    assert.match(captured.url, /\/v1\/ChatMessage\/AddFile$/);
    assert.deepEqual(captured.body, {
      chat_id: 'chat-uuid-1',
      name: 'photo.png',
      extension: 'png',
      data: 'aGVsbG8=',
    });
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

  function getPath(server, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        }
      );
      req.on('error', reject);
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

  function mockRegos({
    ticket,
    addResult,
    addError,
    setResponsibleError,
    onAdd,
    onAddFile,
    onSetParticipants,
    onSetResponsible,
    messages,
    files,
    chatFiles,
    users,
    cdn,
    onCdnFetch,
  } = {}) {
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (cdn && urlStr === cdn.url) {
        if (onCdnFetch) onCdnFetch(options);
        const range = options?.headers?.Range || options?.headers?.range || '';
        if (range && cdn.rangeBody != null) {
          return new Response(cdn.rangeBody, {
            status: 206,
            headers: {
              'content-type': cdn.contentType || 'application/octet-stream',
              'content-range': cdn.contentRange || 'bytes 0-4/10',
              'accept-ranges': 'bytes',
            },
          });
        }
        return new Response(cdn.body, {
          status: 200,
          headers: {
            'content-type': cdn.contentType || 'application/octet-stream',
            'accept-ranges': 'bytes',
          },
        });
      }
      const endpoint = urlStr.split('/v1/')[1] || '';
      const body = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : {};

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

      if (endpoint === 'Ticket/SetResponsible') {
        if (onSetResponsible) onSetResponsible(body);
        if (setResponsibleError) {
          return {
            ok: true,
            async json() {
              return {
                ok: false,
                result: {
                  error: setResponsibleError.code || 'PermissionDenied',
                  description: setResponsibleError.description || 'Not allowed',
                },
              };
            },
          };
        }
        return {
          ok: true,
          async json() {
            return { ok: true, result: { row_affected: 1, ids: [ticket?.id].filter(Boolean) } };
          },
        };
      }

      if (endpoint === 'ChatMessage/AddFile') {
        if (onAddFile) onAddFile(body);
        return {
          ok: true,
          async json() {
            return { ok: true, result: { file_id: 321 } };
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
        assert.ok(
          String(body.text || '').trim() || (Array.isArray(body.file_ids) && body.file_ids.length)
        );
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

      if (endpoint === 'ChatMessage/Get') {
        const rows = messages || [];
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

      if (endpoint === 'User/Get') {
        const rows = users || [];
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

      if (endpoint === 'ChatMessage/GetFiles') {
        const source = chatFiles || files || [];
        const rows = source.map((item) => (item?.file ? item : { file: item }));
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

      if (endpoint === 'File/Get') {
        const rows = files || [];
        const filter = Array.isArray(body.filters) ? body.filters[0] : null;
        const filterId = filter?.Value != null ? Number(filter.Value) : null;
        const filtered =
          Number.isFinite(filterId) && filterId > 0
            ? rows.filter((row) => Number(row.id) === filterId)
            : rows;
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              result: filtered,
              next_offset: filtered.length,
              total: filtered.length,
            };
          },
        };
      }

      throw new Error(`Unexpected Regos endpoint: ${endpoint || urlStr}`);
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
    let setResponsibleCalled = false;
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
      onSetResponsible: () => {
        setResponsibleCalled = true;
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
      assert.equal(setResponsibleCalled, false);
      assert.equal(addBody.author_entity_type, 'User');
      assert.equal(addBody.author_entity_id, 27);
      assert.equal(addBody.text, 'Ответ сотруднику');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('assigns the sender as responsible when the ticket has none', async () => {
    const callOrder = [];
    let setResponsibleBody = null;
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Unassigned',
        status: 'Open',
        chat_id: 'chat-uuid-42',
        responsible_user_id: null,
        participant_user_ids: [],
      },
      addResult: { new_id: 'msg-unassigned' },
      onSetParticipants: () => {
        callOrder.push('Ticket/SetParticipants');
      },
      onSetResponsible: (body) => {
        callOrder.push('Ticket/SetResponsible');
        setResponsibleBody = body;
      },
      onAdd: () => {
        callOrder.push('ChatMessage/Add');
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
        { text: 'Первый ответ' },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 201);
      assert.deepEqual(setResponsibleBody, {
        id: 42,
        responsible_user_id: 27,
      });
      assert.deepEqual(callOrder, [
        'Ticket/SetParticipants',
        'Ticket/SetResponsible',
        'ChatMessage/Add',
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not send a message when SetResponsible fails', async () => {
    let addCalled = false;
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Unassigned',
        status: 'Closed',
        chat_id: 'chat-uuid-42',
        responsible_user_id: 0,
        participant_user_ids: [27],
      },
      setResponsibleError: {
        code: 'TicketClosed',
        description: 'Cannot assign closed ticket',
      },
      onAdd: () => {
        addCalled = true;
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
        { text: 'Не должно отправиться' },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 502);
      assert.match(JSON.parse(res.body).message, /TicketClosed|Cannot assign/i);
      assert.equal(addCalled, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('skips SetParticipants when user is already a ticket participant', async () => {
    let setParticipantsCalled = false;
    let setResponsibleCalled = false;
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
      onSetResponsible: () => {
        setResponsibleCalled = true;
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
      assert.equal(setResponsibleCalled, false);
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

  it('uploads a file then posts ChatMessage/Add with file_ids', async () => {
    let addFileBody = null;
    let addBody = null;
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
        responsible_user_id: 27,
        participant_user_ids: [27],
      },
      addResult: { new_id: 'msg-file-42' },
      onAddFile: (body) => {
        addFileBody = body;
      },
      onAdd: (body) => {
        addBody = body;
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
        {
          files: [{ name: 'photo.png', extension: 'png', data: Buffer.from('hello').toString('base64') }],
        },
        { Cookie: cookie }
      );
      assert.equal(res.statusCode, 201);
      assert.deepEqual(JSON.parse(res.body), {
        id: 'msg-file-42',
        chat_id: 'chat-uuid-42',
        author_entity_id: 27,
        file_ids: [321],
      });
      assert.equal(addFileBody.chat_id, 'chat-uuid-42');
      assert.equal(addFileBody.name, 'photo.png');
      assert.equal(addFileBody.extension, 'png');
      assert.equal(addFileBody.data, Buffer.from('hello').toString('base64'));
      assert.equal(addBody.text, undefined);
      assert.deepEqual(addBody.file_ids, [321]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('enriches GET messages with ChatMessage/GetFiles metadata', async () => {
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      messages: [
        {
          id: 'msg-1',
          chat_id: 'chat-uuid-42',
          text: 'see photo',
          file_ids: [321],
          created_date: 1767225600,
        },
      ],
      chatFiles: [
        {
          message_id: 'msg-1',
          file: {
            id: 321,
            name: 'photo.png',
            extension: 'png',
            mime_type: 'image/png',
            media_type: 'Image',
            url: 'https://cdn.example.com/files/321?token=secret',
          },
        },
      ],
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/messages?limit=50&offset=0', {
        Cookie: cookie,
      });
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body.toString('utf8'));
      assert.equal(data.chat_id, 'chat-uuid-42');
      assert.equal(data.messages.length, 1);
      assert.deepEqual(data.messages[0].files, [
        {
          id: 321,
          name: 'photo.png',
          extension: 'png',
          mime_type: 'image/png',
          media_type: 'Image',
        },
      ]);
      assert.equal(data.messages[0].files[0].url, undefined);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('proxies chat file bytes from File/Get url', async () => {
    const pngBytes = Buffer.from('fake-png-bytes');
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      files: [
        {
          id: 321,
          name: 'photo.png',
          extension: 'png',
          mime_type: 'image/png',
          media_type: 'image',
          url: 'https://cdn.example.com/files/321',
        },
      ],
      cdn: {
        url: 'https://cdn.example.com/files/321',
        body: pngBytes,
        contentType: 'image/png',
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/files/321', { Cookie: cookie });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type']), /image\/png/);
      assert.equal(res.body.equals(pngBytes), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('forwards Range requests for chat media seeking', async () => {
    let cdnOptions = null;
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      files: [
        {
          id: 555,
          name: 'clip.mp4',
          extension: 'mp4',
          mime_type: 'video/mp4',
          media_type: 'video',
          url: 'https://cdn.example.com/files/555',
        },
      ],
      cdn: {
        url: 'https://cdn.example.com/files/555',
        body: Buffer.from('full-video'),
        rangeBody: Buffer.from('bytes'),
        contentType: 'video/mp4',
        contentRange: 'bytes 0-4/10',
      },
      onCdnFetch: (options) => {
        cdnOptions = options;
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/files/555', {
        Cookie: cookie,
        Range: 'bytes=0-4',
      });
      assert.equal(res.statusCode, 206);
      assert.equal(cdnOptions.headers.Range, 'bytes=0-4');
      assert.match(String(res.headers['content-type']), /video\/mp4/);
      assert.equal(res.body.toString('utf8'), 'bytes');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('enriches GET messages with audio and video metadata', async () => {
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      messages: [
        {
          id: 'msg-2',
          chat_id: 'chat-uuid-42',
          text: 'voice',
          file_ids: [501],
          created_date: 1767225601,
        },
        {
          id: 'msg-3',
          chat_id: 'chat-uuid-42',
          text: 'clip',
          file_ids: [502],
          created_date: 1767225602,
        },
      ],
      chatFiles: [
        {
          message_id: 'msg-2',
          file: {
            id: 501,
            name: 'voice.ogg',
            extension: 'ogg',
            mime_type: 'audio/ogg',
            media_type: 'Audio',
            url: 'https://cdn.example.com/files/501',
          },
        },
        {
          message_id: 'msg-3',
          file: {
            id: 502,
            name: 'clip.mp4',
            extension: 'mp4',
            mime_type: 'video/mp4',
            media_type: 'Video',
            url: 'https://cdn.example.com/files/502',
          },
        },
      ],
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/messages?limit=50&offset=0', {
        Cookie: cookie,
      });
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body.toString('utf8'));
      assert.equal(data.messages.length, 2);
      assert.equal(data.messages[0].files[0].media_type, 'Audio');
      assert.equal(data.messages[1].files[0].media_type, 'Video');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects missing chat files', async () => {
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      files: [],
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const missing = await getPath(server, '/bot-admin/api/tickets/42/files/999', { Cookie: cookie });
      assert.equal(missing.statusCode, 404);
      const invalid = await getPath(server, '/bot-admin/api/tickets/42/files/abc', { Cookie: cookie });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('enriches GET messages with display_text for system events', async () => {
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      users: [{ id: 22, full_name: 'Mamatkulov Firuz', login: 'firuz' }],
      messages: [
        {
          id: 'sys-created',
          chat_id: 'chat-uuid-42',
          message_type: 'System',
          action_code: 'TicketCreated',
          action_payload: JSON.stringify({
            id: 42,
            direction: 'Inbound',
            subject: 'xonturayev',
            status: 'Open',
          }),
          text: null,
          created_date: 1767225600,
        },
        {
          id: 'sys-closed',
          chat_id: 'chat-uuid-42',
          message_type: 'System',
          action_code: 'TicketClosed',
          action_payload: JSON.stringify({
            id: 42,
            old_status: 'WaitingStaff',
            status: 'Closed',
          }),
          text: null,
          created_date: 1767225700,
        },
        {
          id: 'sys-responsible',
          chat_id: 'chat-uuid-42',
          message_type: 'System',
          action_code: 'TicketResponsibleSet',
          action_payload: JSON.stringify({
            id: 42,
            old_responsible_user_id: null,
            responsible_user_id: 22,
          }),
          text: null,
          created_date: 1767225800,
        },
        {
          id: 'sys-unknown',
          chat_id: 'chat-uuid-42',
          message_type: 'System',
          action_code: 'SomeFutureAction',
          action_payload: '{}',
          text: null,
          created_date: 1767225900,
        },
      ],
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/messages?limit=50&offset=0', {
        Cookie: cookie,
      });
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body.toString('utf8'));
      assert.equal(data.messages.length, 4);
      assert.equal(
        data.messages[0].display_text,
        'Создано обращение xonturayev (Входящий, Открыт)'
      );
      assert.equal(data.messages[1].display_text, 'Обращение #42 закрыто (Закрыт)');
      assert.equal(
        data.messages[2].display_text,
        'Изменен ответственный обращения #42 Не назначен -> Mamatkulov Firuz'
      );
      assert.equal(data.messages[3].display_text, 'SomeFutureAction');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('chat-system-message', () => {
  it('formats TicketCreated, TicketClosed and TicketResponsibleSet payloads', () => {
    const userNames = { 22: 'Mamatkulov Firuz' };

    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketCreated',
          action_payload: JSON.stringify({
            id: 10854,
            direction: 'Inbound',
            subject: 'xonturayev',
            status: 'Open',
          }),
        },
        { ticketId: 10854, userNames }
      ),
      'Создано обращение xonturayev (Входящий, Открыт)'
    );

    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketClosed',
          action_payload: JSON.stringify({
            id: 10854,
            old_status: 'WaitingStaff',
            status: 'Closed',
          }),
        },
        { ticketId: 10854, userNames }
      ),
      'Обращение #10854 закрыто (Закрыт)'
    );

    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketResponsibleSet',
          action_payload: JSON.stringify({
            id: 10854,
            old_responsible_user_id: null,
            responsible_user_id: 22,
          }),
        },
        { ticketId: 10854, userNames }
      ),
      'Изменен ответственный обращения #10854 Не назначен -> Mamatkulov Firuz'
    );
  });

  it('prefers message.text and returns null for regular messages', () => {
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'StaffNoticeAdded',
          action_payload: JSON.stringify({ text: 'ignored' }),
          text: 'Запросили у клиента номер телефона.',
        },
        {}
      ),
      'Запросили у клиента номер телефона.'
    );

    assert.equal(formatSystemChatMessage({ message_type: 'Regular', text: 'hello' }, {}), null);

    const enriched = enrichChatMessages(
      [{ message_type: 'Regular', text: 'hello' }],
      { ticketId: 1, userNames: {} }
    );
    assert.equal(enriched[0].display_text, undefined);
  });

  it('falls back to action_code for unknown system events', () => {
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'SomeFutureAction',
          action_payload: '{}',
        },
        {}
      ),
      'SomeFutureAction'
    );
  });
});
