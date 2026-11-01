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


describe('addTicketMessage', () => {
  let previousToken: any;
  let originalFetch: any;

  before(() => {
    previousToken = process.env.REGOS_INTEGRATION_TOKEN;
    process.env.REGOS_INTEGRATION_TOKEN = 'test-token';
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.REGOS_INTEGRATION_TOKEN;
    else process.env.REGOS_INTEGRATION_TOKEN = previousToken;
  });

  it('rejects empty chat_id and text before calling Regos', async () => {
    let called = false;
    (global as any).fetch = async () => {
      called = true;
      return { ok: true, async json() { return { ok: true, result: { new_id: 'x' } }; } };
    };

    await assert.rejects(
      () => addTicketMessage({ chatId: '', text: 'hi' }),
      (err: Error) => err instanceof RegosCrmError && err.status === 400
    );
    await assert.rejects(
      () => addTicketMessage({ chatId: 'chat-1', text: '   ' }),
      (err: Error) => err instanceof RegosCrmError && err.status === 400
    );
    await assert.rejects(
      () => addTicketMessage({ chatId: 'chat-1', text: '', fileIds: [] }),
      (err: Error) => err instanceof RegosCrmError && err.status === 400
    );
    assert.equal(called, false);
  });

  it('posts ChatMessage/Add with file_ids and no text', async () => {
    let captured: any = null;
    (global as any).fetch = async (url?: any, options?: any) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { ok: true, result: { new_id: 'msg-file-1' } };
        },
      };
    };

    const result = await addTicketMessage({
      chatId: 'chat-uuid-1',
      fileIds: [321, '321', 0],
      authorEntityId: 27,
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'msg-file-1');
    assert.match(captured.url, /\/v1\/ChatMessage\/Add$/);
    assert.deepEqual(captured.body, {
      chat_id: 'chat-uuid-1',
      message_type: 'Regular',
      file_ids: [321],
      author_entity_type: 'User',
      author_entity_id: 27,
    });
    assert.equal(captured.body.text, undefined);
  });

  it('posts ChatMessage/AddFile and returns file_id', async () => {
    let captured: any = null;
    (global as any).fetch = async (url?: any, options?: any) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { ok: true, result: { file_id: 321 } };
        },
      };
    };

    const result = await addChatFile({
      chatId: ' chat-uuid-1 ',
      name: 'photo.png',
      extension: '.PNG',
      data: 'data:image/png;base64,aGVsbG8=',
    });

    assert.equal(result.ok, true);
    assert.equal(result.file_id, 321);
    assert.match(captured.url, /\/v1\/ChatMessage\/AddFile$/);
    assert.deepEqual(captured.body, {
      chat_id: 'chat-uuid-1',
      name: 'photo.png',
      extension: 'png',
      data: 'aGVsbG8=',
    });
  });

  it('posts ChatMessage/Add and returns new_id', async () => {
    let captured: any = null;
    (global as any).fetch = async (url?: any, options?: any) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { ok: true, result: { new_id: 'msg-uuid-1' } };
        },
      };
    };

    const result = await addTicketMessage({
      chatId: ' chat-uuid-1 ',
      text: '  Hello from admin  ',
      authorEntityId: 27,
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'msg-uuid-1');
    assert.match(captured.url, /\/v1\/ChatMessage\/Add$/);
    assert.deepEqual(captured.body, {
      chat_id: 'chat-uuid-1',
      message_type: 'Regular',
      text: 'Hello from admin',
      author_entity_type: 'User',
      author_entity_id: 27,
    });
  });

  it('reads ChatMessage/Add id when new_id is missing', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      async json() {
        return { ok: true, result: { id: 1841 } };
      },
    });

    const result = await addTicketMessage({
      chatId: 'chat-uuid-1',
      fileIds: [99],
      authorEntityId: 27,
    });
    assert.equal(result.id, '1841');
  });
});
