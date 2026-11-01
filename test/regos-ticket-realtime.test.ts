import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { TicketEventHub } from '../src/admin/ticket-events';
import { createRegosTicketWebhookHandler, createRegosTicketWebhookRouter } from '../src/integrations/regos-ticket-webhook';

function request(server: any, method: any, urlPath: any, { headers = {}, body }: Unchecked = {}) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const { port } = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
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
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

function cookieFromResponse(response?: any) {
  return String(response.headers['set-cookie']?.[0] || '').split(';')[0];
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Ignore missing temporary database files.
    }
  }
}

describe('REGOS ticket webhook handler', () => {
  it('publishes supported ticket changes and deduplicates event_id', async () => {
    const published: any[] = [];
    let fetchCount = 0;
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      now: () => 1_720_000_000_000,
      findTicket: async (id?: any) => {
        fetchCount += 1;
        return { id, responsible_user_id: 17 };
      },
      publish: (event?: any) => published.push(event),
    });
    const payload = {
      action: 'HandleWebhook',
      event_id: `ticket-test-${process.pid}-1`,
      occurred_at: '2026-08-09T10:00:00Z',
      connected_integration_id: 'integration-1',
      data: { action: 'TicketResponsibleSet', data: { id: 42 } },
    };

    assert.deepEqual(await handler(payload), { ok: true, message: 'Webhook processed' });
    assert.deepEqual(await handler(payload), {
      ok: true,
      message: 'Event already processed',
      duplicate: true,
    });
    assert.equal(fetchCount, 1);
    assert.deepEqual(published, [
      {
        type: 'ticket_changed',
        ticket_id: 42,
        responsible_user_id: 17,
        source_action: 'TicketResponsibleSet',
        occurred_at: '2026-08-09T10:00:00Z',
      },
    ]);
  });

  it('refreshes recording cache on TicketEdited then publishes duration update', async () => {
    const published: any[] = [];
    const scheduled: any[] = [];
    const dbPath = path.join(os.tmpdir(), `ticket-webhook-rec-${process.pid}-${Date.now()}.db`);
    const db = openDb(dbPath);
    try {
      const handler = createRegosTicketWebhookHandler({
        connectedIntegrationId: 'integration-1',
        db,
        now: () => 1_720_000_000_000,
        findTicket: async (id?: any) => ({
          id,
          responsible_user_id: 3,
          fields: [
            {
              key: 'field_recording_link',
              value: 'http://rofeev.7x.uz/edited.wav',
            },
          ],
        }),
        resolveRecordingCache: async (database: any, ticket: any, options: any = {}) => {
          if (!options.fetchDuration) {
            const { upsertTicketRecording } = (require('../src/db/ticket-recordings') as typeof import('../src/db/ticket-recordings'));
            upsertTicketRecording(database, {
              ticketId: ticket.id,
              recordingUrl: 'http://rofeev.7x.uz/edited.wav',
            });
            return {
              recording_url: 'http://rofeev.7x.uz/edited.wav',
              duration_seconds: null,
            };
          }
          const { upsertTicketRecording } = (require('../src/db/ticket-recordings') as typeof import('../src/db/ticket-recordings'));
          upsertTicketRecording(database, {
            ticketId: ticket.id,
            durationSeconds: 33,
          });
          return {
            recording_url: 'http://rofeev.7x.uz/edited.wav',
            duration_seconds: 33,
          };
        },
        schedule: (task?: any) => scheduled.push(task),
        publish: (event?: any) => published.push(event),
      });

      assert.deepEqual(
        await handler({
          event_id: `ticket-test-${process.pid}-edited`,
          occurred_at: '2026-08-09T11:00:00Z',
          connected_integration_id: 'integration-1',
          data: { action: 'TicketEdited', data: { id: 77 } },
        }),
        { ok: true, message: 'Webhook processed' }
      );

      assert.equal(published.length, 1);
      assert.equal(scheduled.length, 1);
      await scheduled[0]();
      assert.equal(published.length, 2);
      assert.equal(published[1].ticket_id, 77);
      assert.equal(published[1].source_action, 'TicketEdited');

      const { getTicketRecording } = (require('../src/db/ticket-recordings') as typeof import('../src/db/ticket-recordings'));
      assert.equal(getTicketRecording(db, 77)?.duration_seconds, 33);
    } finally {
      db.close();
      removeDbFiles(dbPath);
    }
  });

  it('rejects another integration and ignores unrelated actions', async () => {
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      findTicket: async () => {
        throw new Error('must not fetch');
      },
    });
    assert.equal(
      (await handler({
        connected_integration_id: 'wrong',
        data: { action: 'TicketAdded', data: { id: 1 } },
      })).ok,
      false
    );
    assert.deepEqual(
      await handler({
        connected_integration_id: 'integration-1',
        data: { action: 'ItemAdded', data: { id: 1 } },
      }),
      { ok: true, message: 'Event ignored' }
    );
  });

  it('publishes chat_changed for ChatMessageAdded without fetching tickets', async () => {
    const published: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      now: () => 1_720_000_000_000,
      findTicket: async () => {
        throw new Error('must not fetch');
      },
      publish: (event?: any) => published.push(event),
    });

    assert.deepEqual(
      await handler({
        event_id: `chat-test-${process.pid}-added`,
        occurred_at: '2026-08-12T12:00:00Z',
        connected_integration_id: 'integration-1',
        data: {
          action: 'ChatMessageAdded',
          data: {
            id: 'msg-1',
            chat_id: 'chat-uuid-1',
          },
        },
      }),
      { ok: true, message: 'Webhook processed' }
    );

    assert.deepEqual(published, [
      {
        type: 'chat_changed',
        chat_id: 'chat-uuid-1',
        message_id: 'msg-1',
        source_action: 'ChatMessageAdded',
        occurred_at: '2026-08-12T12:00:00Z',
      },
    ]);
  });

  it('publishes chat_writing for ChatWriting and deduplicates event_id', async () => {
    const published: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      now: () => 1_720_000_000_000,
      findTicket: async () => {
        throw new Error('must not fetch');
      },
      publish: (event?: any) => published.push(event),
    });
    const payload = {
      event_id: `chat-test-${process.pid}-writing`,
      occurred_at: '2026-08-12T12:05:00Z',
      connected_integration_id: 'integration-1',
      data: {
        action: 'ChatWriting',
        data: {
          chat_id: 'chat-uuid-9',
          author_entity_id: 44,
          author_entity_type: 'User',
        },
      },
    };

    assert.deepEqual(await handler(payload), { ok: true, message: 'Webhook processed' });
    assert.deepEqual(await handler(payload), {
      ok: true,
      message: 'Event already processed',
      duplicate: true,
    });
    assert.deepEqual(published, [
      {
        type: 'chat_writing',
        chat_id: 'chat-uuid-9',
        author_entity_id: 44,
        author_entity_type: 'User',
        source_action: 'ChatWriting',
        occurred_at: '2026-08-12T12:05:00Z',
      },
    ]);
  });

  it('publishes chat_changed for ChatAdded using chat id from payload.id', async () => {
    const published: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      now: () => 1_720_000_000_000,
      publish: (event?: any) => published.push(event),
    });

    assert.deepEqual(
      await handler({
        event_id: `chat-test-${process.pid}-chat-added`,
        occurred_at: '2026-08-12T12:10:00Z',
        connected_integration_id: 'integration-1',
        data: {
          action: 'ChatAdded',
          data: { id: 'chat-uuid-new' },
        },
      }),
      { ok: true, message: 'Webhook processed' }
    );

    assert.deepEqual(published, [
      {
        type: 'chat_changed',
        chat_id: 'chat-uuid-new',
        message_id: null,
        source_action: 'ChatAdded',
        occurred_at: '2026-08-12T12:10:00Z',
      },
    ]);
  });

  it('exposes the webhook at POST /api/regos/webhook', async () => {
    let received: any = null;
    const app = express();
    app.use(express.json());
    app.use('/api/regos', createRegosTicketWebhookRouter({
      handler: async (payload?: any) => {
        received = payload;
        return { ok: true };
      },
    }));
    const server = await new Promise<any>((resolve?: any) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const response = await request(server, 'POST', '/api/regos/webhook', {
        headers: { 'Content-Type': 'application/json' },
        body: { action: 'HandleWebhook' },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { ok: true });
      assert.deepEqual(received, { action: 'HandleWebhook' });
    } finally {
      await new Promise<any>((resolve?: any) => server.close(resolve));
    }
  });
});

describe('TicketEventHub', () => {
  it('delivers events in order and unsubscribes cleanly', async () => {
    const hub = new TicketEventHub();
    const received: any[] = [];
    let resolveDelivered: any;
    const delivered = new Promise<any>((resolve?: any) => {
      resolveDelivered = resolve;
    });
    const unsubscribe = hub.subscribe(async (event?: any) => {
      received.push(event);
      if (received.length === 2) resolveDelivered();
    });

    hub.publish({ type: 'ticket_changed', ticket_id: 1 });
    hub.publish({ type: 'ticket_changed', ticket_id: 2 });
    await delivered;
    assert.deepEqual(received.map((event?: any) => event.ticket_id), [1, 2]);
    assert.equal(hub.subscriberCount(), 1);
    unsubscribe();
    assert.equal(hub.subscriberCount(), 0);
  });
});

describe('active ticket HTTP endpoint', () => {
  let dbPath: any;
  let db: any;
  let server: any;
  let originalFetch: any;
  let previousEnv: any;

  before(async () => {
    previousEnv = {
      BOT_ADMIN_LOGIN: process.env.BOT_ADMIN_LOGIN,
      BOT_ADMIN_PASSWORD: process.env.BOT_ADMIN_PASSWORD,
      REGOS_INTEGRATION_TOKEN: process.env.REGOS_INTEGRATION_TOKEN,
    };
    process.env.BOT_ADMIN_LOGIN = 'admin';
    process.env.BOT_ADMIN_PASSWORD = 'test-password';
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    originalFetch = global.fetch;
    dbPath = path.join(os.tmpdir(), `ticket-realtime-${process.pid}-${Date.now()}.db`);
    db = openDb(dbPath);
    const app = express();
    app.use(express.json());
    app.use('/bot-admin', createBotAdminRouter(db));
    server = await new Promise<any>((resolve?: any) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
  });

  after(async () => {
    global.fetch = originalFetch;
    await new Promise<any>((resolve?: any) => server.close(resolve));
    db.close();
    removeDbFiles(dbPath);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value as any;
    }
  });

  it('requires ticket read access and returns the session REGOS active ticket', async () => {
    const { createEmployeeUser, setBotUserRegosLink } = (require('../src/db/bot-users-db') as typeof import('../src/db/bot-users-db'));

    const unauthorized = await request(server, 'GET', '/bot-admin/api/tickets/active');
    assert.equal(unauthorized.statusCode, 401);

    const employee = createEmployeeUser(db, {
      phone: '+998901112233',
      displayName: 'Ticket Agent',
      adminLogin: 'ticket-agent',
      password: 'agent-pass',
      rights: { tickets_read: 1 },
    });
    setBotUserRegosLink(db, employee.id, {
      regosUserId: 7,
      regosLogin: 'agent7',
      regosFullName: 'Ticket Agent',
    });

    const login = await request(server, 'POST', '/bot-admin/api/login', {
      headers: { 'Content-Type': 'application/json' },
      body: { login: 'ticket-agent', password: 'agent-pass' },
    });
    const cookie = cookieFromResponse(login);
    assert.ok(cookie);

    (global as any).fetch = async (_url?: any, options?: any) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.filters[0].Value, '7');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            result: [
              {
                id: 91,
                status: 'Open',
                subject: 'Live ticket',
                responsible_user_id: 7,
                created_date: 1_720_000_000,
              },
            ],
          };
        },
      };
    };

    // Query filter must not override the session-linked REGOS user.
    const response = await request(
      server,
      'GET',
      '/bot-admin/api/tickets/active?responsible_user_id=99',
      { headers: { Cookie: cookie, Accept: 'application/json' } }
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      active_ticket: {
        id: 91,
        subject: 'Live ticket',
        status: 'Open',
        client: null,
        created_date: 1_720_000_000,
        responsible_user_id: 7,
        local: {
          unpaid_orders: { count: 0, total_amount: 0, orders: [] },
          technical_support: { status: 'none', ends_at: null, starts_at: null },
          firms: [],
        },
      },
      active_ticket_user_id: 7,
    });

    const passwordLogin = await request(server, 'POST', '/bot-admin/api/login', {
      headers: { 'Content-Type': 'application/json' },
      body: { login: 'admin', password: 'test-password' },
    });
    const passwordCookie = cookieFromResponse(passwordLogin);
    assert.ok(passwordCookie);

    const noRegos = await request(server, 'GET', '/bot-admin/api/tickets/active?responsible_user_id=7', {
      headers: { Cookie: passwordCookie, Accept: 'application/json' },
    });
    assert.equal(noRegos.statusCode, 200);
    assert.deepEqual(JSON.parse(noRegos.body), {
      active_ticket: null,
      active_ticket_user_id: null,
    });
  });
});
