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
    (markCustomerMessageProcessed as any)('chat-x', '42');
    assert.equal((isCustomerMessageProcessed as any)('chat-x', '42'), true);
    assert.equal((isCustomerMessageProcessed as any)('chat-x', '43'), false);
  });

  it('persists telegram-handled marks in sqlite for the webhook process', () => {
    const database = createDb();
    markCustomerMessageProcessed('chat-x', '42', database);
    resetCustomerAgentLocks();
    assert.equal((isCustomerMessageProcessed as any)('chat-x', '42'), false);
    assert.equal(isCustomerMessageProcessed('chat-x', '42', database), true);
    assert.equal(isCustomerMessageProcessed('chat-x', '43', database), false);
  });
});
