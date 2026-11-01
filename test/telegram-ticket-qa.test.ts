import { describe, it, afterEach, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { loadTelegramTicketSettings, saveTelegramTicketSettings, serializeTelegramTicketSettings, isTelegramTicketConfigured } from '../src/bot/telegram-ticket-settings';
import { getTelegramTicketSession, upsertTelegramTicketSession, clearTelegramTicketSession, getTelegramTicketSessionByTicketId, getTelegramTicketSessionByChatId } from '../src/db/telegram-ticket-sessions';
import { createClient, findClientByPhone, phonesEqual } from '../src/integrations/regos-crm';
import { handleCustomerQuestionMessage, ensureOpenTicket, VIDEO_NOT_SUPPORTED_TEXT } from '../src/bot/customer-question-bot';
import { classifyTelegramMedia, IMAGE_FALLBACK_TEXT, AUDIO_FALLBACK_TEXT } from '../src/bot/telegram-ticket-media';
import { resolveRegosClient } from '../src/bot/regos-client-resolve';
import { ensureCustomerRegosOnStart, MSG_CLIENT_FOUND, MSG_CLIENT_ALREADY_REGISTERED, MSG_CLIENT_CREATED, MSG_CLIENT_FALLBACK, MSG_CLIENT_FAILED, MSG_CLIENT_NOT_REGISTERED } from '../src/bot/customer-start-bot';
import { registerCustomer } from '../src/db/bot-users-db';
import { markCustomerMessageProcessed, isCustomerMessageProcessed, resetCustomerAgentLocks } from '../src/ai/customer-agent';

let db: any = null;
let dbPath: any = null;

function removeDbFiles(filePath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${filePath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

function createDb() {
  dbPath = path.join(
    os.tmpdir(),
    `scrapregos-telegram-tickets-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  resetCustomerAgentLocks();
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});


describe('telegram ticket settings', () => {
  it('loads defaults and persists settings', () => {
    createDb();
    const defaults = loadTelegramTicketSettings(db);
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.channelId, null);
    assert.equal(defaults.direction, 'Inbound');
    assert.equal(defaults.subject, 'Вопрос из Telegram');
    assert.deepEqual(defaults.participantUserIds, []);

    const saved = saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      direction: 'Outbound',
      responsibleUserId: 7,
      participantUserIds: [7, 9, 7],
      subject: 'Поддержка Telegram',
      fallbackClientId: 100,
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.channelId, 22);
    assert.equal(saved.direction, 'Outbound');
    assert.deepEqual(saved.participantUserIds, [7, 9]);
    assert.equal(saved.fallbackClientId, 100);
    assert.equal(isTelegramTicketConfigured(saved), true);

    const reloaded = loadTelegramTicketSettings(db);
    assert.deepEqual(serializeTelegramTicketSettings(reloaded), {
      enabled: true,
      channel_id: 22,
      direction: 'Outbound',
      responsible_user_id: 7,
      participant_user_ids: [7, 9],
      subject: 'Поддержка Telegram',
      fallback_client_id: 100,
    });
  });

  it('requires channel when enabled and validates direction', () => {
    createDb();
    assert.throws(
      () => saveTelegramTicketSettings(db, { enabled: true, channelId: null }),
      /TELEGRAM_TICKET_CHANNEL_REQUIRED/
    );
    assert.throws(
      () => saveTelegramTicketSettings(db, { enabled: false, direction: 'Sideways' }),
      /INVALID_TELEGRAM_TICKET_DIRECTION/
    );
  });
});

describe('telegram ticket sessions', () => {
  it('upserts and clears session mapping', () => {
    createDb();
    assert.equal(getTelegramTicketSession(db, 111), null);

    const session = upsertTelegramTicketSession(db, {
      telegramId: 111,
      ticketId: 55,
      chatId: 'chat-55',
      clientId: 9,
    });
    assert.equal(session!.telegramId, 111);
    assert.equal(session!.ticketId, 55);
    assert.equal(session!.chatId, 'chat-55');
    assert.equal(session!.clientId, 9);

    upsertTelegramTicketSession(db, {
      telegramId: 111,
      ticketId: 56,
      chatId: 'chat-56',
      clientId: 9,
    });
    assert.equal(getTelegramTicketSession(db, 111)!.ticketId, 56);

    assert.equal(clearTelegramTicketSession(db, 111), true);
    assert.equal(getTelegramTicketSession(db, 111), null);
  });

  it('looks up a session by ticket id or chat id', () => {
    createDb();
    upsertTelegramTicketSession(db, {
      telegramId: 222,
      ticketId: 77,
      chatId: 'chat-77',
      clientId: 3,
    });
    assert.equal(getTelegramTicketSessionByTicketId(db, 77)!.telegramId, 222);
    assert.equal(getTelegramTicketSessionByChatId(db, 'chat-77')!.telegramId, 222);
    assert.equal(getTelegramTicketSessionByTicketId(db, 78), null);
    assert.equal(getTelegramTicketSessionByChatId(db, 'chat-missing'), null);
  });
});

describe('REGOS client phone helpers', () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.REGOS_INTEGRATION_TOKEN;
  const originalTarget = process.env.REGOS_API_TARGET;
  let calls: any;
  let responses: any;

  before(() => {
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    process.env.REGOS_API_TARGET = 'https://regos.test';
  });

  after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.REGOS_INTEGRATION_TOKEN;
    else process.env.REGOS_INTEGRATION_TOKEN = originalToken;
    if (originalTarget === undefined) delete process.env.REGOS_API_TARGET;
    else process.env.REGOS_API_TARGET = originalTarget;
  });

  beforeEach(() => {
    calls = [];
    responses = [];
    (global as any).fetch = async (url?: any, options?: any) => {
      calls.push({ url, body: JSON.parse(options.body || '{}') });
      const data = responses.shift() || { ok: true, result: [] };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    };
  });

  it('phonesEqual matches local tails', () => {
    assert.equal(phonesEqual('+998901112233', '901112233'), true);
    assert.equal(phonesEqual('998901112233', '998901112244'), false);
  });

  it('findClientByPhone returns unique match', async () => {
    responses.push({
      ok: true,
      result: [
        { id: 1, phone: '+998901112233', name: 'A' },
        { id: 2, phone: '901119999', name: 'B' },
      ],
      total: 2,
    });
    const match = await findClientByPhone('901112233');
    assert.equal(match.status, 'matched');
    assert.equal(match.client.id, 1);
  });

  it('findClientByPhone returns none when no phone match', async () => {
    responses.push({
      ok: true,
      result: [{ id: 1, phone: '111', name: 'A' }],
      total: 1,
    });
    const match = await findClientByPhone('901112233');
    assert.equal(match.status, 'none');
  });

  it('createClient posts Client/Add and returns new_id', async () => {
    responses.push({ ok: true, result: { new_id: 321 } });
    const created = await createClient({ name: 'Telegram User', phone: '998901112233' });
    assert.equal(created.id, 321);
    assert.match(calls[0].url, /Client\/Add/);
    assert.equal(calls[0].body.name, 'Telegram User');
    assert.equal(calls[0].body.phone, '998901112233');
  });
});

describe('resolveRegosClient', () => {
  it('uses phone match, then create, then fallback', async () => {
    const phoneMatch = await resolveRegosClient({
      phone: '99890',
      displayName: 'A',
      settings: {},
      deps: {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 5, phone: '99890' },
        }),
      },
    });
    assert.equal(phoneMatch.source, 'phone');
    assert.equal(phoneMatch.client.id, 5);

    const created = await resolveRegosClient({
      phone: '99890',
      displayName: 'A',
      settings: {},
      deps: {
        findClientByPhone: async () => ({ status: 'none', client: null, candidates: [] }),
        createClient: async () => ({ id: 44 }),
        getClientById: async (id?: any) => ({ id, name: 'A' }),
      },
    });
    assert.equal(created.source, 'created');
    assert.equal(created.client.id, 44);

    const fallback = await resolveRegosClient({
      phone: '99890',
      displayName: 'A',
      settings: { fallbackClientId: 99 },
      deps: {
        findClientByPhone: async () => ({ status: 'none', client: null, candidates: [] }),
        createClient: async () => {
          throw new Error('no Client/Add');
        },
        getClientById: async (id?: any) => ({ id, name: 'Fallback' }),
      },
    });
    assert.equal(fallback.source, 'fallback');
    assert.equal(fallback.client.id, 99);
  });

  it('prefers stored client id when still valid', async () => {
    let findCalled = false;
    const stored = await resolveRegosClient({
      phone: '99890',
      storedClientId: 15,
      settings: {},
      deps: {
        getClientById: async (id?: any) => ({ id, name: 'Stored' }),
        findClientByPhone: async () => {
          findCalled = true;
          return { status: 'none', client: null, candidates: [] };
        },
      },
    });
    assert.equal(stored.source, 'stored');
    assert.equal(stored.client.id, 15);
    assert.equal(findCalled, false);
  });
});

describe('ensureCustomerRegosOnStart', () => {
  it('sends found message and stores regos_client_id on phone match', async () => {
    createDb();
    const user = registerCustomer(db, {
      telegramId: 9001,
      phone: '998901110001',
      firstName: 'Test',
    });
    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
    };
    let readyPhone: any = null;
    const result = await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9001 }, from: { id: 9001, first_name: 'Test' } },
      botUser: user,
      db,
      onReady: async (u?: any) => {
        readyPhone = u.phone;
      },
      deps: {
        loadTelegramTicketSettings: () => ({ fallbackClientId: null }),
        resolveRegosClient: async () => ({
          client: { id: 77, phone: '998901110001' },
          source: 'phone',
        }),
      },
    });
    assert.equal(result.source, 'phone');
    assert.equal(sent[0].text, MSG_CLIENT_FOUND);
    assert.equal(readyPhone, '998901110001');
    assert.equal(result.botUser.regos_client_id, 77);
  });

  it('sends already-registered message on returning /start', async () => {
    createDb();
    const user = registerCustomer(db, {
      telegramId: 9005,
      phone: '998901110005',
      firstName: 'Test',
    });
    const sent: any[] = [];
    const bot = {
      sendMessage: async (_chatId?: any, text?: any) => {
        sent.push(text);
      },
    };
    const result = await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9005 }, from: { id: 9005, first_name: 'Test' } },
      botUser: user,
      db,
      alreadyRegistered: true,
      onReady: async () => {},
      deps: {
        loadTelegramTicketSettings: () => ({ fallbackClientId: null }),
        resolveRegosClient: async () => ({
          client: { id: 77, phone: '998901110005' },
          source: 'stored',
        }),
      },
    });
    assert.equal(sent[0], MSG_CLIENT_ALREADY_REGISTERED);
    assert.equal(result.botUser.regos_client_id, 77);
  });

  it('sends created message after Client/Add', async () => {
    createDb();
    const user = registerCustomer(db, {
      telegramId: 9002,
      phone: '998901110002',
    });
    const sent: any[] = [];
    const bot = {
      sendMessage: async (_chatId?: any, text?: any) => {
        sent.push(text);
      },
    };
    let createCalled = false;
    await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9002 }, from: { id: 9002 } },
      botUser: user,
      db,
      onReady: async () => {},
      deps: {
        loadTelegramTicketSettings: () => ({}),
        resolveRegosClient: async () => {
          createCalled = true;
          return { client: { id: 88 }, source: 'created' };
        },
      },
    });
    assert.equal(createCalled, true);
    assert.equal(sent[0], MSG_CLIENT_CREATED);
  });

  it('sends fallback message when create fails and fallback is used', async () => {
    createDb();
    const user = registerCustomer(db, {
      telegramId: 9003,
      phone: '998901110003',
    });
    const sent: any[] = [];
    const bot = {
      sendMessage: async (_chatId?: any, text?: any) => {
        sent.push(text);
      },
    };
    await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9003 }, from: { id: 9003 } },
      botUser: user,
      db,
      onReady: async () => {},
      deps: {
        loadTelegramTicketSettings: () => ({ fallbackClientId: 55 }),
        resolveRegosClient: async () => ({ client: { id: 55 }, source: 'fallback' }),
      },
    });
    assert.equal(sent[0], MSG_CLIENT_FALLBACK);
  });

  it('asks for phone when customer is not registered', async () => {
    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any, options?: any) => {
        sent.push({ chatId, text, options });
      },
    };
    let readyCalled = false;
    const result = await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9000 }, from: { id: 9000 } },
      botUser: { id: 1, telegram_id: 9000 },
      db: {},
      onReady: async () => {
        readyCalled = true;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(sent[0].text, MSG_CLIENT_NOT_REGISTERED);
    assert.equal(
      sent[0].options.reply_markup.keyboard[0][0].request_contact,
      true
    );
    assert.equal(readyCalled, false);
  });

  it('sends failed message when resolve returns none', async () => {
    createDb();
    const user = registerCustomer(db, {
      telegramId: 9004,
      phone: '998901110004',
    });
    const sent: any[] = [];
    let readyCalled = false;
    const bot = {
      sendMessage: async (_chatId?: any, text?: any) => {
        sent.push(text);
      },
    };
    await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9004 }, from: { id: 9004 } },
      botUser: user,
      db,
      onReady: async () => {
        readyCalled = true;
      },
      deps: {
        loadTelegramTicketSettings: () => ({}),
        resolveRegosClient: async () => ({ client: null, source: 'none' }),
      },
    });
    assert.equal(sent[0], MSG_CLIENT_FAILED);
    assert.equal(readyCalled, true);
  });
});
