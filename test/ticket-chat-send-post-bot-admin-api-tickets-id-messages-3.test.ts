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
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const missing = await getPath(server, '/bot-admin/api/tickets/42/files/999', { Cookie: cookie });
      assert.equal(missing.statusCode, 404);
      const invalid = await getPath(server, '/bot-admin/api/tickets/42/files/abc', { Cookie: cookie });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
          id: 'sys-edited',
          chat_id: 'chat-uuid-42',
          message_type: 'System',
          action_code: 'TicketEdited',
          action_payload: JSON.stringify({ id: 42 }),
          text: null,
          created_date: 1767225850,
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
    const server = await new Promise<any>((resolve?: any) => {
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
      assert.equal(
        data.messages.some((message?: any) => message.action_code === 'TicketEdited'),
        false
      );
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
