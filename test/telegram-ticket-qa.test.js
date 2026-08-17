const { describe, it, afterEach, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const {
  loadTelegramTicketSettings,
  saveTelegramTicketSettings,
  serializeTelegramTicketSettings,
  isTelegramTicketConfigured,
} = require('../src/bot/telegram-ticket-settings');
const {
  getTelegramTicketSession,
  upsertTelegramTicketSession,
  clearTelegramTicketSession,
  getTelegramTicketSessionByTicketId,
  getTelegramTicketSessionByChatId,
} = require('../src/db/telegram-ticket-sessions');
const {
  createClient,
  findClientByPhone,
  phonesEqual,
} = require('../src/integrations/regos-crm');
const {
  handleCustomerQuestionMessage,
  ensureOpenTicket,
  VIDEO_NOT_SUPPORTED_TEXT,
} = require('../src/bot/customer-question-bot');
const {
  classifyTelegramMedia,
  IMAGE_FALLBACK_TEXT,
  AUDIO_FALLBACK_TEXT,
} = require('../src/bot/telegram-ticket-media');
const { resolveRegosClient } = require('../src/bot/regos-client-resolve');
const {
  ensureCustomerRegosOnStart,
  MSG_CLIENT_FOUND,
  MSG_CLIENT_ALREADY_REGISTERED,
  MSG_CLIENT_CREATED,
  MSG_CLIENT_FALLBACK,
  MSG_CLIENT_FAILED,
  MSG_CLIENT_NOT_REGISTERED,
} = require('../src/bot/customer-start-bot');
const { registerCustomer } = require('../src/db/bot-users-db');
const { markCustomerMessageProcessed, isCustomerMessageProcessed, resetCustomerAgentLocks } = require('../src/ai/customer-agent');

let db = null;
let dbPath = null;

function removeDbFiles(filePath) {
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
    assert.equal(session.telegramId, 111);
    assert.equal(session.ticketId, 55);
    assert.equal(session.chatId, 'chat-55');
    assert.equal(session.clientId, 9);

    upsertTelegramTicketSession(db, {
      telegramId: 111,
      ticketId: 56,
      chatId: 'chat-56',
      clientId: 9,
    });
    assert.equal(getTelegramTicketSession(db, 111).ticketId, 56);

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
    assert.equal(getTelegramTicketSessionByTicketId(db, 77).telegramId, 222);
    assert.equal(getTelegramTicketSessionByChatId(db, 'chat-77').telegramId, 222);
    assert.equal(getTelegramTicketSessionByTicketId(db, 78), null);
    assert.equal(getTelegramTicketSessionByChatId(db, 'chat-missing'), null);
  });
});

describe('REGOS client phone helpers', () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.REGOS_INTEGRATION_TOKEN;
  const originalTarget = process.env.REGOS_API_TARGET;
  let calls;
  let responses;

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
    global.fetch = async (url, options) => {
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
        getClientById: async (id) => ({ id, name: 'A' }),
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
        getClientById: async (id) => ({ id, name: 'Fallback' }),
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
        getClientById: async (id) => ({ id, name: 'Stored' }),
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
    const sent = [];
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    let readyPhone = null;
    const result = await ensureCustomerRegosOnStart({
      bot,
      msg: { chat: { id: 9001 }, from: { id: 9001, first_name: 'Test' } },
      botUser: user,
      db,
      onReady: async (u) => {
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
    const sent = [];
    const bot = {
      sendMessage: async (_chatId, text) => {
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
    const sent = [];
    const bot = {
      sendMessage: async (_chatId, text) => {
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
    const sent = [];
    const bot = {
      sendMessage: async (_chatId, text) => {
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
    const sent = [];
    const bot = {
      sendMessage: async (chatId, text, options) => {
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
    const sent = [];
    let readyCalled = false;
    const bot = {
      sendMessage: async (_chatId, text) => {
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

describe('ensureOpenTicket session reuse', () => {
  it('reuses open session ticket and creates a new one after close', async () => {
    createDb();
    upsertTelegramTicketSession(db, {
      telegramId: 42,
      ticketId: 10,
      chatId: 'chat-10',
      clientId: 3,
    });

    const reused = await ensureOpenTicket({
      db,
      telegramId: 42,
      client: { id: 3 },
      questionText: 'help',
      settings: { channelId: 1, direction: 'Inbound', subject: 'Q' },
      deps: {
        findTicketById: async (id) =>
          id === 10
            ? { id: 10, status: 'Open', chat_id: 'chat-10', client_id: 3 }
            : null,
      },
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.ticket.id, 10);

    upsertTelegramTicketSession(db, {
      telegramId: 42,
      ticketId: 10,
      chatId: 'chat-10',
      clientId: 3,
    });

    let createdPayload = null;
    const created = await ensureOpenTicket({
      db,
      telegramId: 42,
      client: { id: 3 },
      questionText: 'again',
      settings: {
        channelId: 22,
        direction: 'Inbound',
        subject: 'Вопрос из Telegram',
        participantUserIds: [8],
      },
      deps: {
        findTicketById: async (id) => {
          if (id === 10) return { id: 10, status: 'Closed', chat_id: 'chat-10', client_id: 3 };
          if (id === 77) return { id: 77, status: 'Open', chat_id: 'chat-77', client_id: 3 };
          return null;
        },
        createTicket: async (payload) => {
          createdPayload = payload;
          return { id: 77 };
        },
        setTicketParticipants: async () => ({}),
        resolveAiAuthorUserId: () => 8,
      },
    });
    assert.equal(created.reused, false);
    assert.equal(created.ticket.id, 77);
    assert.equal(createdPayload.channel_id, 22);
    assert.equal(getTelegramTicketSession(db, 42).ticketId, 77);
  });
});

describe('handleCustomerQuestionMessage', () => {
  it('returns false when telegram tickets are disabled', async () => {
    createDb();
    const sent = [];
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const consumed = await handleCustomerQuestionMessage(
      bot,
      { chat: { id: 1 }, from: { id: 1 }, text: 'Как оплатить?' },
      { phone: '998901112233' },
      db,
      {
        loadTelegramTicketSettings: () => ({
          enabled: false,
          channelId: null,
        }),
      }
    );
    assert.equal(consumed, false);
    assert.equal(sent.length, 0);
  });

  it('creates ticket, posts question, sends AI reply, and marks message processed', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      direction: 'Inbound',
      subject: 'Вопрос из Telegram',
      participantUserIds: [],
    });

    const sent = [];
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      bot,
      {
        chat: { id: 500 },
        from: { id: 500, first_name: 'Ivan' },
        text: 'Не работает касса',
      },
      { phone: '998901112233' },
      db,
      {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 9, phone: '998901112233', name: 'Ivan' },
        }),
        createTicket: async () => ({ id: 88 }),
        findTicketById: async () => ({
          id: 88,
          status: 'Open',
          chat_id: 'chat-88',
          client_id: 9,
        }),
        setTicketParticipants: async () => ({}),
        addTicketMessage: async () => ({ ok: true, id: 'msg-1', result: { new_id: 'msg-1' } }),
        handleCustomerChatMessage: async () => ({
          handled: true,
          reply: 'Проверьте соединение с интернетом.',
          closed: false,
        }),
        resolveAiAuthorUserId: () => 31,
      }
    );

    assert.equal(consumed, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Проверьте соединение с интернетом.');
    assert.equal(getTelegramTicketSession(db, 500).ticketId, 88);
    assert.equal(isCustomerMessageProcessed('chat-88', 'msg-1'), true);
  });

  it('does not persist a claim when the agent is busy', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent = [];
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    await handleCustomerQuestionMessage(
      bot,
      { chat: { id: 504 }, from: { id: 504 }, text: 'Голосовое ещё одно' },
      { phone: '998901112233' },
      db,
      {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 9, phone: '998901112233' },
        }),
        createTicket: async () => ({ id: 93 }),
        findTicketById: async () => ({
          id: 93,
          status: 'Open',
          chat_id: 'chat-93',
          client_id: 9,
        }),
        setTicketParticipants: async () => ({}),
        addTicketMessage: async () => ({ ok: true, id: 'msg-busy' }),
        handleCustomerChatMessage: async () => ({ handled: false, reason: 'busy' }),
        resolveAiAuthorUserId: () => 31,
      }
    );

    assert.equal(sent.length, 0);
    assert.equal(isCustomerMessageProcessed('chat-93', 'msg-busy'), false);
    assert.equal(isCustomerMessageProcessed('chat-93', 'msg-busy', db), false);
  });

  it('does not send the AI reply again when the agent already delivered it to Telegram', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent = [];
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    await handleCustomerQuestionMessage(
      bot,
      { chat: { id: 505 }, from: { id: 505 }, text: 'Нужна касса' },
      { phone: '998901112233' },
      db,
      {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 9, phone: '998901112233' },
        }),
        createTicket: async () => ({ id: 94 }),
        findTicketById: async () => ({
          id: 94,
          status: 'Open',
          chat_id: 'chat-94',
          client_id: 9,
        }),
        setTicketParticipants: async () => ({}),
        addTicketMessage: async () => ({ ok: true, id: 'msg-3' }),
        handleCustomerChatMessage: async () => ({
          handled: true,
          reply: 'Уже отправил в Telegram.',
          telegram_sent: true,
        }),
        resolveAiAuthorUserId: () => 31,
      }
    );

    assert.equal(sent.length, 0);
  });

  it('does not send a ticket confirmation when AI does not reply', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent = [];
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    await handleCustomerQuestionMessage(
      bot,
      { chat: { id: 501 }, from: { id: 501 }, text: 'Нужна помощь' },
      { phone: '998901112233' },
      db,
      {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 9, phone: '998901112233' },
        }),
        createTicket: async () => ({ id: 91 }),
        findTicketById: async () => ({
          id: 91,
          status: 'Open',
          chat_id: 'chat-91',
          client_id: 9,
        }),
        setTicketParticipants: async () => ({}),
        addTicketMessage: async () => ({ ok: true, id: 'msg-2' }),
        handleCustomerChatMessage: async () => ({ handled: false, reason: 'disabled' }),
        resolveAiAuthorUserId: () => 31,
      }
    );

    assert.equal(sent.length, 0);
  });

  it('uploads a photo with caption and runs the agent with file_ids', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent = [];
    const uploaded = [];
    const posted = [];
    let agentPayload = null;
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      bot,
      {
        chat: { id: 502 },
        from: { id: 502, first_name: 'Ivan' },
        caption: 'Сломалась касса',
        photo: [
          { file_id: 'small', width: 90, height: 90, file_size: 1200 },
          { file_id: 'big', width: 1280, height: 720, file_size: 80_000 },
        ],
      },
      { phone: '998901112233' },
      db,
      {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 9, phone: '998901112233' },
        }),
        createTicket: async () => ({ id: 92 }),
        findTicketById: async () => ({
          id: 92,
          status: 'Open',
          chat_id: 'chat-92',
          client_id: 9,
        }),
        setTicketParticipants: async () => ({}),
        downloadTelegramFile: async (attachment) => {
          assert.equal(attachment.fileId, 'big');
          assert.equal(attachment.kind, 'image');
          return Buffer.from('fake-jpeg');
        },
        addChatFile: async (payload) => {
          uploaded.push(payload);
          return { ok: true, file_id: 77 };
        },
        addTicketMessage: async (payload) => {
          posted.push(payload);
          return { ok: true, id: 'msg-photo' };
        },
        handleCustomerChatMessage: async (args) => {
          agentPayload = args.payload;
          return { handled: true, reply: 'На скрине ошибка соединения.' };
        },
        resolveAiAuthorUserId: () => 31,
      }
    );

    assert.equal(consumed, true);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].name, 'photo.jpg');
    assert.equal(uploaded[0].extension, 'jpg');
    assert.equal(uploaded[0].chatId, 'chat-92');
    assert.equal(posted[0].text, 'Сломалась касса');
    assert.deepEqual(posted[0].fileIds, [77]);
    assert.deepEqual(agentPayload.file_ids, [77]);
    assert.equal(agentPayload.text, 'Сломалась касса');
    assert.equal(sent[0].text, 'На скрине ошибка соединения.');
  });

  it('uploads a voice note without text and runs the agent', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent = [];
    const uploaded = [];
    const posted = [];
    let agentPayload = null;
    let ticketDescription = null;
    const bot = {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      bot,
      {
        chat: { id: 503 },
        from: { id: 503 },
        voice: {
          file_id: 'voice-1',
          duration: 4,
          mime_type: 'audio/ogg',
          file_size: 3200,
        },
      },
      { phone: '998901112233' },
      db,
      {
        findClientByPhone: async () => ({
          status: 'matched',
          client: { id: 9, phone: '998901112233' },
        }),
        createTicket: async (payload) => {
          ticketDescription = payload.description;
          return { id: 93 };
        },
        findTicketById: async () => ({
          id: 93,
          status: 'Open',
          chat_id: 'chat-93',
          client_id: 9,
        }),
        setTicketParticipants: async () => ({}),
        downloadTelegramFile: async (attachment) => {
          assert.equal(attachment.fileId, 'voice-1');
          assert.equal(attachment.kind, 'audio');
          return Buffer.from('fake-ogg');
        },
        addChatFile: async (payload) => {
          uploaded.push(payload);
          return { ok: true, file_id: 88 };
        },
        addTicketMessage: async (payload) => {
          posted.push(payload);
          return { ok: true, id: 'msg-voice' };
        },
        handleCustomerChatMessage: async (args) => {
          agentPayload = args.payload;
          return { handled: true, reply: 'Услышал вопрос по кассе.' };
        },
        resolveAiAuthorUserId: () => 31,
      }
    );

    assert.equal(consumed, true);
    assert.equal(ticketDescription, AUDIO_FALLBACK_TEXT);
    assert.equal(uploaded[0].name, 'voice.ogg');
    assert.equal(uploaded[0].extension, 'ogg');
    assert.equal(posted[0].text, '');
    assert.deepEqual(posted[0].fileIds, [88]);
    assert.deepEqual(agentPayload.file_ids, [88]);
    assert.equal(agentPayload.text, AUDIO_FALLBACK_TEXT);
    assert.equal(sent[0].text, 'Услышал вопрос по кассе.');
  });

  it('rejects video and video_note without creating a ticket', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    for (const extra of [{ video: { file_id: 'vid' } }, { video_note: { file_id: 'round' } }]) {
      const sent = [];
      let created = false;
      let uploaded = false;
      const bot = {
        sendMessage: async (_chatId, text) => {
          sent.push(text);
        },
      };
      const consumed = await handleCustomerQuestionMessage(
        bot,
        { chat: { id: 504 }, from: { id: 504 }, ...extra },
        { phone: '998901112233' },
        db,
        {
          createTicket: async () => {
            created = true;
            return { id: 1 };
          },
          addChatFile: async () => {
            uploaded = true;
            return { ok: true, file_id: 1 };
          },
        }
      );
      assert.equal(consumed, true);
      assert.equal(sent[0], VIDEO_NOT_SUPPORTED_TEXT);
      assert.equal(created, false);
      assert.equal(uploaded, false);
    }
  });
});

describe('classifyTelegramMedia', () => {
  it('accepts photos, voice, and image/audio documents', () => {
    const photo = classifyTelegramMedia({
      caption: 'скрин',
      photo: [{ file_id: 'p1', width: 100, height: 80 }],
    });
    assert.equal(photo.status, 'media');
    assert.equal(photo.text, 'скрин');
    assert.equal(photo.attachments[0].kind, 'image');
    assert.equal(photo.fallbackText, IMAGE_FALLBACK_TEXT);

    const voice = classifyTelegramMedia({ voice: { file_id: 'v1', duration: 2 } });
    assert.equal(voice.status, 'media');
    assert.equal(voice.attachments[0].kind, 'audio');
    assert.equal(voice.text, '');

    const imageDoc = classifyTelegramMedia({
      document: { file_id: 'd1', file_name: 'shot.png', mime_type: 'image/png' },
    });
    assert.equal(imageDoc.status, 'media');
    assert.equal(imageDoc.attachments[0].kind, 'image');

    const audioDoc = classifyTelegramMedia({
      document: { file_id: 'd2', file_name: 'note.ogg', mime_type: 'audio/ogg' },
    });
    assert.equal(audioDoc.status, 'media');
    assert.equal(audioDoc.attachments[0].kind, 'audio');
  });

  it('rejects video, animation, stickers, and other files', () => {
    assert.equal(classifyTelegramMedia({ video: { file_id: 'x' } }).status, 'video');
    assert.equal(classifyTelegramMedia({ video_note: { file_id: 'x' } }).status, 'video');
    assert.equal(classifyTelegramMedia({ animation: { file_id: 'x' } }).status, 'video');
    assert.equal(
      classifyTelegramMedia({
        document: { file_id: 'x', file_name: 'clip.mp4', mime_type: 'video/mp4' },
      }).status,
      'video'
    );
    assert.equal(classifyTelegramMedia({ sticker: { file_id: 's' } }).status, 'unsupported');
    assert.equal(
      classifyTelegramMedia({
        document: { file_id: 'x', file_name: 'file.pdf', mime_type: 'application/pdf' },
      }).status,
      'unsupported'
    );
    assert.equal(classifyTelegramMedia({}).status, 'empty');
  });
});

describe('processed message skip for webhook', () => {
  it('marks telegram-handled messages so webhook path can skip', () => {
    resetCustomerAgentLocks();
    markCustomerMessageProcessed('chat-x', '42');
    assert.equal(isCustomerMessageProcessed('chat-x', '42'), true);
    assert.equal(isCustomerMessageProcessed('chat-x', '43'), false);
  });

  it('persists telegram-handled marks in sqlite for the webhook process', () => {
    const database = createDb();
    markCustomerMessageProcessed('chat-x', '42', database);
    resetCustomerAgentLocks();
    assert.equal(isCustomerMessageProcessed('chat-x', '42'), false);
    assert.equal(isCustomerMessageProcessed('chat-x', '42', database), true);
    assert.equal(isCustomerMessageProcessed('chat-x', '43', database), false);
  });
});
