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
import { createEmployeeUser, setBotUserRegosLink } from '../src/db/bot-users-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { RegosCrmError, addTicketMessage, addChatFile } from '../src/integrations/regos-crm';
import { formatSystemChatMessage, enrichChatMessages } from '../src/admin/chat-system-message';
import { mockRegos } from './ticket-chat-send-helpers';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-chat-send-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
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


describe('POST /bot-admin/api/tickets/:id/messages', () => {
  let dbPath: any;
  let db: any;
  let previousEnv: any;
  let originalFetch: any;

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
      else process.env[key] = value as any;
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

  function postJson(server: any, urlPath: any, body: any, headers: any = {}) {
    return new Promise<any>((resolve?: any, reject?: any) => {
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
      req.end(payload);
    });
  }

  function getPath(server: any, urlPath: any, headers: any = {}) {
    return new Promise<any>((resolve?: any, reject?: any) => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
          headers,
        },
        (res: any) => {
          const chunks: any[] = [];
          res.on('data', (chunk?: any) => chunks.push(chunk));
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

  function cookieFromSetCookie(headerValue?: any) {
    const raw = headerValue;
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/,(?=\s*[^;=]+=)/);
    const match = list
      .map((part?: any) => String(part).trim())
      .find((part?: any) => part.startsWith('bot_admin_session='));
    return match ? match.split(';')[0] : null;
  }


  async function loginWithTicketsRead(server: any, { regosUserId = 27 }: Unchecked = {}) {
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
    let addBody: any = null;
    let setParticipantsBody: any = null;
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
      onAdd: (body?: any) => {
        addBody = body;
      },
      onSetParticipants: (body?: any) => {
        setParticipantsBody = body;
      },
      onSetResponsible: () => {
        setResponsibleCalled = true;
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('assigns the sender as responsible when the ticket has none', async () => {
    const callOrder: any[] = [];
    let setResponsibleBody: any = null;
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
      onSetResponsible: (body?: any) => {
        callOrder.push('Ticket/SetResponsible');
        setResponsibleBody = body;
      },
      onAdd: () => {
        callOrder.push('ChatMessage/Add');
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('rejects empty text and tickets without chat', async () => {
    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
