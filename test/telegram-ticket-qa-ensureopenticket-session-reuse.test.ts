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
        findTicketById: async (id?: any) =>
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

    let createdPayload: any = null;
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
        findTicketById: async (id?: any) => {
          if (id === 10) return { id: 10, status: 'Closed', chat_id: 'chat-10', client_id: 3 };
          if (id === 77) return { id: 77, status: 'Open', chat_id: 'chat-77', client_id: 3 };
          return null;
        },
        createTicket: async (payload?: any) => {
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
    assert.equal(getTelegramTicketSession(db, 42)!.ticketId, 77);
  });
});
