import type { Unchecked } from '../src/types/unchecked';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser, setBotUserRegosLink, DEFAULT_RIGHTS } from '../src/db/bot-users-db';
import { loadAiSettings, saveAiSettings, serializeAiSettings, resolveAgentModel, resolveAgentMaxSteps, SUMMARY_TOKEN_BUDGET } from '../src/ai/settings';
import { CUSTOMER_SYSTEM_PROMPT, CUSTOMER_TEST_PROMPT_SUFFIX, CUSTOMER_ASSIST_PROMPT_SUFFIX, KB_SYSTEM_PROMPT, OPS_SYSTEM_PROMPT, TICKET_SUMMARY_SYSTEM_PROMPT } from '../src/ai/default-prompts';
import { getProvider, registerProvider, listProviders } from '../src/ai/providers/registry';
import { buildChatRequest, consumeChatStream, normalizeChatContent, normalizeUsage } from '../src/ai/providers/openai';
import { runAgent, resolveAgentTimeoutMs, prependUserContext, buildPromptCacheKey } from '../src/ai/run-agent';
import { listKnowledgeArticles, getKnowledgeArticle, createKnowledgeArticle, updateKnowledgeArticle, deleteKnowledgeArticle, createKnowledgeCategory, knowledgeCategoryContext, setKnowledgeArticleConfirmed } from '../src/db/knowledge-articles';
import { listPrompts, getResolvedPrompt, savePrompt, resetPrompt, createPrompt, updatePrompt, setActivePrompt, deletePrompt, ensureAiPromptsTable, DEFAULT_PROMPT_NAME } from '../src/db/ai-prompts';
import { createKnowledgeTools } from '../src/ai/tools/knowledge';
import { createCustomerTools } from '../src/ai/tools/customer';
import { classifyChatFile, downloadChatFile, isVisionImage, toImageUrlPart } from '../src/ai/chat-media';
import { transcribeChatAudio, clearTranscribeCache } from '../src/ai/transcribe';
import { parseChatUploadFiles, toPublicAttachments } from '../src/ai/chat-uploads';
import { captionChatImage, clearCaptionCache } from '../src/ai/image-caption';
import { getChatFileExtraction, upsertChatFileExtraction } from '../src/db/chat-file-extractions';
import { assertSafeBrowseUrl, browseUrl, classifyBrowseHost, htmlToText, parseDuckDuckGoResults, unwrapDuckDuckGoUrl, webSearch } from '../src/ai/tools/browse';
import { findEmployeesForAgent, isEmployeeClientPhone } from '../src/ai/tools/employees';
import { evaluateCustomerMessageGate, evaluateCustomerMessageGateWithDb, handleCustomerChatMessage, previewCustomerAgentPrompt, resetCustomerAgentLocks, pickTriggerMessage } from '../src/ai/customer-agent';
import { runKbAgent } from '../src/ai/kb-agent';
import { loadCustomerTestSession, runCustomerTestAgent, resetCustomerTestLocks } from '../src/ai/customer-test-agent';
import { loadEmployeeTestSession, runEmployeeTestAgent, resetEmployeeTestLocks } from '../src/ai/employee-test-agent';
import { loadTicketAssistSession, runTicketAssistAgent, previewTicketAssistPrompt, resetTicketAssistLocks } from '../src/ai/customer-assist-agent';
import { upsertTelegramTicketSession } from '../src/db/telegram-ticket-sessions';
import { createRegosTicketWebhookHandler } from '../src/integrations/regos-ticket-webhook';
import { upsertTicketSummary } from '../src/db/ticket-summaries';
import { setTicketAiStopped, getCustomerReplyCount, isTicketAiStopped, incrementCustomerReplyCount } from '../src/db/ticket-ai-state';
import { countCustomerUsageSince, resolveCustomerUsageKey, recordCustomerUsage } from '../src/db/ai-customer-usage';
import { ADMIN_PERMISSION_KEYS, RIGHTS } from '../src/db/user-rights';
import { listCustomerTestSessions, deleteCustomerTestSession, clearCustomerTestSessions } from '../src/db/customer-agent-sessions';

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
    `scrapregos-ai-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  resetCustomerAgentLocks();
  resetCustomerTestLocks();
  resetEmployeeTestLocks();
  resetTicketAssistLocks();
  clearTranscribeCache();
  clearCaptionCache();
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});


describe('customer agent handler', () => {
  const aiAuthorId = 31;
  let previousAuthor: any;

  before(() => {
    previousAuthor = process.env.AI_REGOS_AUTHOR_USER_ID;
    process.env.AI_REGOS_AUTHOR_USER_ID = String(aiAuthorId);
  });

  after(() => {
    if (previousAuthor === undefined) delete process.env.AI_REGOS_AUTHOR_USER_ID;
    else process.env.AI_REGOS_AUTHOR_USER_ID = previousAuthor;
  });

  function withWriteDeps(deps?: any) {
    return {
      ensureTicketParticipant: async () => ({ ok: true }),
      ...deps,
    };
  }

  async function sendClientReply(database: any, { chatId, ticketId, client, messageId, text = 'Вопрос', onSend }: Unchecked = {}) {
    const runs = { n: 0 };
    const result = await handleCustomerChatMessage({
      db: database,
      chatId,
      messageId: String(messageId),
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: ticketId,
          status: 'Open',
          chat_id: chatId,
          client_id: client.id,
          client,
        }),
        getTicketMessages: async () => ({
          total: 1,
          result: [
            {
              id: String(messageId),
              author_entity_type: 'Client',
              message_type: 'Regular',
              text,
            },
          ],
        }),
        addTicketMessage: async (payload?: any) => {
          if (onSend) return onSend(payload);
          return { ok: true, id: `ai-${messageId}` };
        },
        runAgent: async () => {
          runs.n += 1;
          return { content: 'Ответ агента.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    return { result, runs };
  }

  it('sends the REGOS reply to the linked Telegram session', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    upsertTelegramTicketSession(database, {
      telegramId: 9001,
      ticketId: 42,
      chatId: 'chat-42',
      clientId: 7,
    });
    const telegram: any[] = [];
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 1,
          result: [{ id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' }],
        }),
        addTicketMessage: async () => ({ ok: true }),
        sendTelegramCustomerReply: async (telegramId?: any, text?: any) => {
          telegram.push({ telegramId, text });
        },
        runAgent: async () => ({ content: 'Ответ в Telegram', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.telegram_sent, true);
    assert.deepEqual(telegram, [{ telegramId: 9001, text: 'Ответ в Telegram' }]);
  });

  it('skips a client message that already has an AI reply after it', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    let ran = false;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 2,
          result: [
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' },
            {
              id: '10',
              author_entity_type: 'User',
              author_entity_id: aiAuthorId,
              message_type: 'Regular',
              text: 'Уже ответил',
            },
          ],
        }),
        addTicketMessage: async () => {
          throw new Error('must not reply');
        },
        runAgent: async () => {
          ran = true;
          return { content: 'unused', steps: 1 };
        },
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'already-replied');
    assert.equal(ran, false);
  });

  it('skips send when AI_REGOS_AUTHOR_USER_ID is unset', async () => {
    const previous = process.env.AI_REGOS_AUTHOR_USER_ID;
    delete process.env.AI_REGOS_AUTHOR_USER_ID;
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    let ran = false;
    try {
      const result = await handleCustomerChatMessage({
        db: database,
        chatId: 'chat-42',
        messageId: '9',
        deps: withWriteDeps({
          findTicketByChatId: async () => ({
            id: 42,
            status: 'Open',
            client: { phone: '+998901112233' },
          }),
          getTicketMessages: async () => ({
            total: 1,
            result: [{ id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' }],
          }),
          addTicketMessage: async () => {
            throw new Error('must not send');
          },
          runAgent: async () => {
            ran = true;
            return { content: 'unused', steps: 1 };
          },
        }),
      });
      assert.equal(result.handled, false);
      assert.equal(result.reason, 'no-author');
      assert.equal(ran, false);
    } finally {
      process.env.AI_REGOS_AUTHOR_USER_ID = previous;
    }
  });

  it('handles an image-only client message and inlines trigger vision parts', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    let captured: any = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 1,
          result: [
            {
              id: '9',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              file_ids: [101],
            },
          ],
        }),
        getChatFilesByIds: async () => [
          {
            id: 101,
            name: 'screenshot.png',
            extension: 'png',
            mime_type: 'image/png',
            media_type: 'image',
            url: 'https://files.example/101.png',
          },
        ],
        downloadChatFile: async () => ({ mime: 'image/png', base64: png.toString('base64') }),
        addTicketMessage: async () => ({ ok: true, id: '10' }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Вижу ошибку на скриншоте.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(captured.hasVision, true);
    assert.ok(captured.tools.some((tool?: any) => tool.name === 'read_chat_image'));
    const last = captured.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.ok(Array.isArray(last.content));
    assert.equal(last.content[0].type, 'text');
    assert.match(last.content[0].text, /screenshot\.png/);
    assert.equal(last.content[1].type, 'image_url');
    assert.match(last.content[1].image_url.url, /^data:image\/png;base64,/);
  });

  it('stubs older images and non-image files instead of inlining them', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const png = Buffer.from('aaa', 'base64');
    let captured: any = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '3',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 3,
          result: [
            {
              id: '1',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: 'раньше',
              file_ids: [201],
            },
            {
              id: '2',
              author_entity_type: 'User',
              message_type: 'Regular',
              text: 'ок',
            },
            {
              id: '3',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: 'и голосовое',
              file_ids: [202],
            },
          ],
        }),
        getChatFilesByIds: async () => [
          {
            id: 201,
            name: 'old.png',
            extension: 'png',
            mime_type: 'image/png',
            url: 'https://files.example/old.png',
          },
          {
            id: 202,
            name: 'voice.ogg',
            extension: 'ogg',
            mime_type: 'audio/ogg',
            media_type: 'voice',
            url: 'https://files.example/voice.ogg',
          },
        ],
        downloadChatFile: async () => ({ mime: 'image/png', base64: png.toString('base64') }),
        transcribeChatAudio: async () => ({ skipped: true, reason: 'test' }),
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Понял.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(captured.messages.length, 3);
    assert.equal(typeof captured.messages[0].content, 'string');
    assert.match(captured.messages[0].content, /\[изображение: old\.png #201\]/);
    assert.equal(typeof captured.messages[2].content, 'string');
    assert.match(captured.messages[2].content, /\[аудио: voice\.ogg #202\]/);
    assert.equal(captured.messages[2].content.includes('Расшифровка:'), false);
    assert.equal(
      captured.messages.some((message?: any) => Array.isArray(message.content)),
      false
    );
  });

  it('transcribes trigger voice and leaves older audio as a stub', async () => {
    const database = createDb();
    saveAiSettings(database, {
      enabled: true,
      testMode: false,
      model: 'gpt-4o-mini',
      agentModels: { customer: 'gpt-5-mini' },
    });
    const transcribed: any[] = [];
    let captured: any = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '3',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 2,
          result: [
            {
              id: '1',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              file_ids: [201],
            },
            {
              id: '3',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              file_ids: [202],
            },
          ],
        }),
        getChatFilesByIds: async () => [
          {
            id: 201,
            name: 'old.ogg',
            extension: 'ogg',
            mime_type: 'audio/ogg',
            media_type: 'voice',
            url: 'https://files.example/old.ogg',
          },
          {
            id: 202,
            name: 'voice.ogg',
            extension: 'ogg',
            mime_type: 'audio/ogg',
            media_type: 'voice',
            url: 'https://files.example/voice.ogg',
          },
        ],
        transcribeChatAudio: async (file?: any) => {
          transcribed.push(file.id);
          return { text: `текст ${file.id}` };
        },
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Понял голосовое.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(transcribed, [202]);
    assert.match(captured.messages[0].content, /\[аудио: old\.ogg #201\]/);
    assert.equal(captured.messages[0].content.includes('Расшифровка:'), false);
    assert.match(captured.messages[1].content, /\[аудио: voice\.ogg #202\]/);
    assert.match(captured.messages[1].content, /Расшифровка: текст 202/);
    assert.equal(captured.hasAudio, true);
    assert.equal(captured.model, 'gpt-5-mini');
    assert.ok(captured.tools.some((tool?: any) => tool.name === 'transcribe_chat_audio'));
  });
});
