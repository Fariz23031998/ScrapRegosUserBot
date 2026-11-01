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

  it('replies to the client greeting when the webhook is a ticket-created system notice', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const sent: any[] = [];
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: 'sys-created',
      payload: {
        id: 'sys-created',
        chat_id: 'chat-42',
        message_type: 'System',
        action_code: 'TicketCreated',
      },
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
              id: '9',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: 'Assalomu aleykum',
            },
            {
              id: 'sys-created',
              message_type: 'System',
              action_code: 'TicketCreated',
              text: null,
            },
            {
              id: 'sys-notice',
              message_type: 'System',
              action_code: 'StaffNoticeAdded',
              text: 'Fariz Xuramov\nhttps://sb.regos.uz/Partners/View/954',
            },
          ],
        }),
        addTicketMessage: async (payload?: any) => {
          sent.push(payload);
          return { ok: true };
        },
        runAgent: async () => ({ content: 'Ваалейкум ассалом!', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Ваалейкум ассалом!');
  });

  it('does not reply to a system notice after a staff message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    let replied = false;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: 'sys-status',
      payload: { id: 'sys-status', message_type: 'System', action_code: 'TicketStatusSet' },
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 3,
          result: [
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' },
            {
              id: '10',
              author_entity_type: 'User',
              author_entity_id: 7,
              message_type: 'Regular',
              text: 'Сейчас помогу',
            },
            { id: 'sys-status', message_type: 'System', action_code: 'TicketStatusSet' },
          ],
        }),
        addTicketMessage: async () => {
          replied = true;
        },
        runAgent: async () => ({ content: 'must not run', steps: 1 }),
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'not-regular');
    assert.equal(replied, false);
  });

  it('does not reply to a system notice after an AI reply', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    let replied = false;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: 'sys-notice',
      payload: { id: 'sys-notice', message_type: 'System', action_code: 'StaffNoticeAdded' },
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 3,
          result: [
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' },
            {
              id: '10',
              author_entity_type: 'User',
              author_entity_id: aiAuthorId,
              message_type: 'Regular',
              text: 'Здравствуйте',
            },
            { id: 'sys-notice', message_type: 'System', action_code: 'StaffNoticeAdded' },
          ],
        }),
        addTicketMessage: async () => {
          replied = true;
        },
        runAgent: async () => ({ content: 'must not run', steps: 1 }),
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'not-regular');
    assert.equal(replied, false);
  });

  it('does not reply twice to the same client message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const sent: any[] = [];
    const deps = withWriteDeps({
      findTicketByChatId: async () => ({
        id: 42,
        status: 'Open',
        client: { phone: '+998901112233' },
      }),
      getTicketMessages: async () => ({
        total: 1,
        result: [{ id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' }],
      }),
      addTicketMessage: async (payload?: any) => {
        sent.push(payload);
        return { ok: true };
      },
      runAgent: async () => ({ content: 'Ответ', steps: 1 }),
      provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
    });
    const first = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps,
    });
    const second = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps,
    });
    assert.equal(first.handled, true);
    assert.equal(second.handled, false);
    assert.equal(second.reason, 'already-processed');
    assert.equal(sent.length, 1);
  });

  it('skips a second process after in-memory locks are cleared', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const sent: any[] = [];
    let runs = 0;
    const deps = withWriteDeps({
      findTicketByChatId: async () => ({
        id: 42,
        status: 'Open',
        client: { phone: '+998901112233' },
      }),
      getTicketMessages: async () => ({
        total: 1,
        result: [{ id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' }],
      }),
      addTicketMessage: async (payload?: any) => {
        sent.push(payload);
        return { ok: true };
      },
      runAgent: async () => {
        runs += 1;
        return { content: 'Ответ', steps: 1 };
      },
      provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
    });
    const first = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps,
    });
    resetCustomerAgentLocks();
    const second = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps,
    });
    assert.equal(first.handled, true);
    assert.equal(second.handled, false);
    assert.equal(second.reason, 'already-processed');
    assert.equal(sent.length, 1);
    assert.equal(runs, 1);
  });

  it('resolves a voice payload without id to the REGOS message with the same file', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const sent: any[] = [];
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: null,
      payload: {
        author_entity_type: 'Client',
        message_type: 'Regular',
        file_ids: [1841],
      },
      forceHandle: true,
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
              id: 'voice-1',
              author_entity_type: 'Client',
              message_type: 'Regular',
              file_ids: [1841],
            },
          ],
        }),
        getChatFilesByIds: async () => [
          { id: 1841, name: 'voice.ogg', extension: 'ogg', mime_type: 'audio/ogg' },
        ],
        transcribeChatAudio: async () => ({ text: 'салом' }),
        addTicketMessage: async (payload?: any) => {
          sent.push(payload);
          return { ok: true };
        },
        runAgent: async () => ({ content: 'Жавоб', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(sent.length, 1);

    resetCustomerAgentLocks();
    const second = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: 'voice-1',
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
              id: 'voice-1',
              author_entity_type: 'Client',
              message_type: 'Regular',
              file_ids: [1841],
            },
          ],
        }),
        getChatFilesByIds: async () => [],
        addTicketMessage: async (payload?: any) => {
          sent.push(payload);
          return { ok: true };
        },
        runAgent: async () => ({ content: 'Иккинчи жавоб', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(second.handled, false);
    assert.equal(second.reason, 'already-processed');
    assert.equal(sent.length, 1);
  });

  it('retries after a failed send because the claim is released', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const sent: any[] = [];
    let shouldFail = true;
    let runs = 0;
    const deps = withWriteDeps({
      findTicketByChatId: async () => ({
        id: 42,
        status: 'Open',
        client: { phone: '+998901112233' },
      }),
      getTicketMessages: async () => ({
        total: 1,
        result: [{ id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Привет' }],
      }),
      addTicketMessage: async (payload?: any) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('send failed');
        }
        sent.push(payload);
        return { ok: true };
      },
      runAgent: async () => {
        runs += 1;
        return { content: 'Ответ', steps: 1 };
      },
      provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
    });
    const failed = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps,
    });
    resetCustomerAgentLocks();
    const retry = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      deps,
    });
    assert.equal(failed.handled, false);
    assert.equal(failed.reason, 'send-failed');
    assert.equal(retry.handled, true);
    assert.equal(sent.length, 1);
    assert.equal(runs, 2);
  });
});
