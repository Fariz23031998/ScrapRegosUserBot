import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { replaceRegosChannelSettings } from '../src/db/regos-channel-settings';
import {
  ATTACHMENT_PREVIEW,
  pickLastNonSystemMessage,
  attachLastMessagesToTickets,
} from '../src/admin/ticket-last-message';
import { parseTicketListQuery } from '../src/admin/bot-admin-routes-tickets';

let db: any = null;
let dbPath: any = null;

function removeDbFiles(filePath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${filePath}${suffix}`);
    } catch {
      // Ignore missing temporary files.
    }
  }
}

function createDb() {
  dbPath = path.join(
    os.tmpdir(),
    `scrapregos-ticket-last-message-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});

describe('pickLastNonSystemMessage', () => {
  it('returns the newest non-system message text', () => {
    const picked = pickLastNonSystemMessage([
      { id: 1, message_type: 'Regular', text: 'first', created_date: 100 },
      { id: 2, message_type: 'System', text: 'ticket closed', created_date: 200 },
      { id: 3, message_type: 'Regular', text: 'latest client', created_date: 300 },
    ]);
    assert.deepEqual(picked, { text: 'latest client', created_date: 300 });
  });

  it('skips trailing system messages', () => {
    const picked = pickLastNonSystemMessage([
      { id: 1, message_type: 'Regular', text: 'hello', created_date: 10 },
      { id: 2, message_type: 'System', text: 'status changed', created_date: 20 },
      { id: 3, message_type: 'System', text: 'closed', created_date: 30 },
    ]);
    assert.deepEqual(picked, { text: 'hello', created_date: 10 });
  });

  it('returns null when only system messages exist', () => {
    assert.equal(
      pickLastNonSystemMessage([
        { id: 1, message_type: 'System', text: 'created', created_date: 1 },
        { id: 2, message_type: 'System', text: 'closed', created_date: 2 },
      ]),
      null
    );
  });

  it('uses attachment placeholder when text is empty but files exist', () => {
    const picked = pickLastNonSystemMessage([
      {
        id: 1,
        message_type: 'Regular',
        text: '  ',
        file_ids: [42],
        created_date: 50,
      },
    ]);
    assert.deepEqual(picked, { text: ATTACHMENT_PREVIEW, created_date: 50 });
  });

  it('skips blank non-system messages without files', () => {
    assert.equal(
      pickLastNonSystemMessage([
        { id: 1, message_type: 'Regular', text: '  ', created_date: 1 },
        { id: 2, message_type: 'Private', text: '', created_date: 2 },
      ]),
      null
    );
  });
});

describe('attachLastMessagesToTickets', () => {
  it('attaches previews only for message_only channels with chat_id', async () => {
    createDb();
    replaceRegosChannelSettings(db, [
      { channel_id: '1', channel_name: 'Telegram', interaction_mode: 'message_only' },
      { channel_id: '2', channel_name: 'Phone', interaction_mode: 'call' },
    ]);

    const calls: string[] = [];
    const getMessages = async (chatId: string) => {
      calls.push(chatId);
      return {
        result: [
          { id: 1, message_type: 'System', text: 'created', created_date: 1 },
          { id: 2, message_type: 'Regular', text: `msg for ${chatId}`, created_date: 2 },
        ],
      };
    };

    const tickets = [
      { id: 10, channel_id: 1, chat_id: 'chat-a' },
      { id: 11, channel_id: 2, chat_id: 'chat-b' },
      { id: 12, channel_id: 1, chat_id: '' },
      { id: 13, channel_id: 99, chat_id: 'chat-c' },
    ];

    await attachLastMessagesToTickets(db, tickets, { getMessages, concurrency: 2 });

    assert.deepEqual(tickets[0].last_message, { text: 'msg for chat-a', created_date: 2 });
    assert.equal(tickets[1].last_message, null);
    assert.equal(tickets[2].last_message, null);
    // Unconfigured channel defaults to message_only
    assert.deepEqual(tickets[3].last_message, { text: 'msg for chat-c', created_date: 2 });
    assert.deepEqual(calls.sort(), ['chat-a', 'chat-c']);
  });

  it('leaves last_message null when chat fetch fails', async () => {
    createDb();
    replaceRegosChannelSettings(db, [
      { channel_id: '1', channel_name: 'Telegram', interaction_mode: 'message_only' },
    ]);

    const tickets = [{ id: 20, channel_id: 1, chat_id: 'chat-fail' }];
    await attachLastMessagesToTickets(db, tickets, {
      getMessages: async () => {
        throw new Error('crm down');
      },
    });
    assert.equal(tickets[0].last_message, null);
  });
});

describe('parseTicketListQuery include_last_message', () => {
  it('parses include_last_message flag', () => {
    assert.equal(parseTicketListQuery({ query: {} } as any).includeLastMessage, false);
    assert.equal(
      parseTicketListQuery({ query: { include_last_message: '1' } } as any).includeLastMessage,
      true
    );
    assert.equal(
      parseTicketListQuery({ query: { include_last_message: 'true' } } as any).includeLastMessage,
      true
    );
  });
});
