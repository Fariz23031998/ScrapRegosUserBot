import { describe, it, afterEach, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { loadTelegramTicketSettings, saveTelegramTicketSettings, serializeTelegramTicketSettings, isTelegramTicketConfigured } from '../src/bot/telegram-ticket-settings';
import { getTelegramTicketSession, upsertTelegramTicketSession, clearTelegramTicketSession, getTelegramTicketSessionByTicketId, getTelegramTicketSessionByChatId } from '../src/db/telegram-ticket-sessions';
import { createClient, findClientByPhone, phonesEqual } from '../src/integrations/regos-crm';
import { handleCustomerQuestionMessage, ensureOpenTicket } from '../src/bot/customer-question-bot';
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


describe('handleCustomerQuestionMessage', () => {
  it('returns false when telegram tickets are disabled', async () => {
    createDb();
    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
    };
    const consumed = await handleCustomerQuestionMessage(
      (bot as any),
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

    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      (bot as any),
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
    assert.equal(getTelegramTicketSession(db, 500)!.ticketId, 88);
    assert.equal((isCustomerMessageProcessed as any)('chat-88', 'msg-1'), true);
  });

  it('does not persist a claim when the agent is busy', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    await handleCustomerQuestionMessage(
      (bot as any),
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
    assert.equal((isCustomerMessageProcessed as any)('chat-93', 'msg-busy'), false);
    assert.equal(isCustomerMessageProcessed('chat-93', 'msg-busy', db), false);
  });

  it('does not send the AI reply again when the agent already delivered it to Telegram', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    await handleCustomerQuestionMessage(
      (bot as any),
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

    const sent: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    await handleCustomerQuestionMessage(
      (bot as any),
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

    const sent: any[] = [];
    const uploaded: any[] = [];
    const posted: any[] = [];
    let agentPayload: any = null;
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      (bot as any),
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
        downloadTelegramFile: async (attachment?: any) => {
          assert.equal(attachment.fileId, 'big');
          assert.equal(attachment.kind, 'image');
          return Buffer.from('fake-jpeg');
        },
        addChatFile: async (payload?: any) => {
          uploaded.push(payload);
          return { ok: true, file_id: 77 };
        },
        addTicketMessage: async (payload?: any) => {
          posted.push(payload);
          return { ok: true, id: 'msg-photo' };
        },
        handleCustomerChatMessage: async (args?: any) => {
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

    const sent: any[] = [];
    const uploaded: any[] = [];
    const posted: any[] = [];
    let agentPayload: any = null;
    let ticketDescription: any = null;
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      (bot as any),
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
        createTicket: async (payload?: any) => {
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
        downloadTelegramFile: async (attachment?: any) => {
          assert.equal(attachment.fileId, 'voice-1');
          assert.equal(attachment.kind, 'audio');
          return Buffer.from('fake-ogg');
        },
        addChatFile: async (payload?: any) => {
          uploaded.push(payload);
          return { ok: true, file_id: 88 };
        },
        addTicketMessage: async (payload?: any) => {
          posted.push(payload);
          return { ok: true, id: 'msg-voice' };
        },
        handleCustomerChatMessage: async (args?: any) => {
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

  it('accepts video and enqueues timeline processing', async () => {
    createDb();
    saveTelegramTicketSettings(db, {
      enabled: true,
      channelId: 22,
      subject: 'Вопрос из Telegram',
    });

    const sent: any[] = [];
    const uploaded: any[] = [];
    const enqueued: any[] = [];
    const bot = {
      sendMessage: async (chatId?: any, text?: any) => {
        sent.push({ chatId, text });
      },
      sendChatAction: async () => {},
    };

    const consumed = await handleCustomerQuestionMessage(
      (bot as any),
      {
        chat: { id: 504 },
        from: { id: 504 },
        caption: 'ошибка на экране',
        video: {
          file_id: 'vid-1',
          duration: 8,
          mime_type: 'video/mp4',
          file_size: 5000,
        },
      },
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
        downloadTelegramFile: async (attachment?: any) => {
          assert.equal(attachment.fileId, 'vid-1');
          assert.equal(attachment.kind, 'video');
          return Buffer.from('fake-mp4');
        },
        addChatFile: async (payload?: any) => {
          uploaded.push(payload);
          return { ok: true, file_id: 101 };
        },
        addTicketMessage: async () => ({ ok: true, id: 'msg-video' }),
        handleCustomerChatMessage: async () => ({
          handled: true,
          reply: 'Смотрю ваше видео.',
        }),
        resolveAiAuthorUserId: () => 31,
        getVideoTimelineWorker: () => ({
          enqueue: (fileId?: any, meta?: any) => {
            enqueued.push({ fileId, meta });
            return { file_id: fileId, status: 'pending' };
          },
        }),
      }
    );

    assert.equal(consumed, true);
    assert.equal(uploaded[0].name, 'video.mp4');
    assert.equal(uploaded[0].extension, 'mp4');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].fileId, 101);
    assert.equal(enqueued[0].meta.ticketId, 94);
    assert.equal(sent[0].text, 'Смотрю ваше видео.');
  });
});
