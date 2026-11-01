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

  it('uploads a file then posts ChatMessage/Add with file_ids', async () => {
    let addFileBody: any = null;
    let addBody: any = null;
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
      onAddFile: (body?: any) => {
        addFileBody = body;
      },
      onAdd: (body?: any) => {
        addBody = body;
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('loads the latest ChatMessage page for from_end and older pages by increasing offset', async () => {
    const all = Array.from({ length: 80 }, (_?: any, index?: any) => ({
      id: `msg-${index + 1}`,
      chat_id: 'chat-uuid-42',
      text: `m${index + 1}`,
      created_date: 1000 + index,
    }));
    const requested: any[] = [];
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      messages: all,
      onGetMessages: (body?: any) => requested.push({ limit: body.limit, offset: body.offset }),
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const latest = await getPath(server, '/bot-admin/api/tickets/42/messages?limit=50&from_end=1', {
        Cookie: cookie,
      });
      assert.equal(latest.statusCode, 200);
      const latestBody = JSON.parse(latest.body.toString('utf8'));
      assert.deepEqual(requested, [{ limit: 50, offset: 0 }]);
      assert.equal(latestBody.offset, 0);
      assert.equal(latestBody.next_offset, 50);
      assert.equal(latestBody.has_older, true);
      assert.equal(latestBody.messages.length, 50);
      assert.equal(latestBody.messages[0].id, 'msg-31');
      assert.equal(latestBody.messages.at(-1).id, 'msg-80');

      const older = await getPath(server, '/bot-admin/api/tickets/42/messages?limit=50&offset=50', {
        Cookie: cookie,
      });
      assert.equal(older.statusCode, 200);
      const olderBody = JSON.parse(older.body.toString('utf8'));
      assert.deepEqual(requested[1], { limit: 50, offset: 50 });
      assert.equal(olderBody.has_older, false);
      assert.equal(olderBody.messages[0].id, 'msg-1');
      assert.equal(olderBody.messages.at(-1).id, 'msg-30');
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
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
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/files/321', { Cookie: cookie });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type']), /image\/png/);
      assert.equal(res.body.equals(pngBytes), true);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('follows CDN redirects and maps ogg voice Content-Type', async () => {
    const oggBytes = Buffer.from('OggS-fake-voice');
    const fetched: any[] = [];
    mockRegos({
      ticket: {
        id: 42,
        subject: 'Help',
        status: 'Open',
        chat_id: 'chat-uuid-42',
      },
      files: [
        {
          id: 161871,
          name: 'voice_161871.ogg',
          extension: 'ogg',
          mime_type: 'application/octet-stream',
          media_type: 'voice',
          url: 'https://cdn.example.com/files/161871',
        },
      ],
      cdn: {
        redirectFrom: 'https://cdn.example.com/files/161871',
        url: 'https://cdn.example.com/signed/161871?token=abc',
        body: oggBytes,
        contentType: 'application/octet-stream',
      },
      onCdnFetch: (options?: any) => {
        fetched.push(options);
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { cookie } = await loginWithTicketsRead(server, { regosUserId: 27 });
      const res = await getPath(server, '/bot-admin/api/tickets/42/files/161871', { Cookie: cookie });
      assert.equal(res.statusCode, 200);
      assert.equal(String(res.headers['content-type']), 'audio/ogg');
      assert.equal(res.body.equals(oggBytes), true);
      assert.equal(fetched.some((item?: any) => item.redirected), true);
      assert.equal(fetched.some((item?: any) => !item.redirected), true);
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });

  it('forwards Range requests for chat media seeking', async () => {
    let cdnOptions: any = null;
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
      onCdnFetch: (options?: any) => {
        cdnOptions = options;
      },
    });

    const app = express();
    app.use('/bot-admin', createBotAdminRouter(db));
    const server = await new Promise<any>((resolve?: any) => {
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
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});
