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

  it('auto-stops at the ticket cap and resumes after unmute resets the count', async () => {
    const database = createDb();
    saveAiSettings(database, {
      enabled: true,
      testMode: false,
      customerRepliesPerHour: 0,
      customerRepliesPerTicket: 1,
    });
    const client = { id: 88, phone: '+998909998877' };
    const first = await sendClientReply(database, {
      chatId: 'chat-88',
      ticketId: 88,
      client,
      messageId: 1,
    });
    assert.equal(first.result.handled, true);
    assert.equal(isTicketAiStopped(database, 88), true);
    assert.equal(getCustomerReplyCount(database, 88), 1);

    const blocked = await sendClientReply(database, {
      chatId: 'chat-88',
      ticketId: 88,
      client,
      messageId: 2,
    });
    assert.equal(blocked.result.handled, false);
    assert.equal(blocked.result.reason, 'stopped');
    assert.equal(blocked.runs.n, 0);

    setTicketAiStopped(database, 88, false);
    assert.equal(isTicketAiStopped(database, 88), false);
    assert.equal(getCustomerReplyCount(database, 88), 0);

    const resumed = await sendClientReply(database, {
      chatId: 'chat-88',
      ticketId: 88,
      client,
      messageId: 3,
    });
    assert.equal(resumed.result.handled, true);
    assert.equal(getCustomerReplyCount(database, 88), 1);
  });

  it('treats 0 as unlimited for each customer reply cap independently', async () => {
    const database = createDb();
    saveAiSettings(database, {
      enabled: true,
      testMode: false,
      customerRepliesPerHour: 0,
      customerRepliesPerTicket: 1,
    });
    const client = { id: 55, phone: '+998901110000' };
    const first = await sendClientReply(database, {
      chatId: 'chat-55a',
      ticketId: 551,
      client,
      messageId: 1,
    });
    assert.equal(first.result.handled, true);
    const otherTicket = await sendClientReply(database, {
      chatId: 'chat-55b',
      ticketId: 552,
      client,
      messageId: 2,
    });
    assert.equal(otherTicket.result.handled, true);

    saveAiSettings(database, {
      customerRepliesPerHour: 1,
      customerRepliesPerTicket: 0,
    });
    const clientB = { id: 56, phone: '+998901110001' };
    const hourlyFirst = await sendClientReply(database, {
      chatId: 'chat-56a',
      ticketId: 561,
      client: clientB,
      messageId: 3,
    });
    assert.equal(hourlyFirst.result.handled, true);
    const hourlySecond = await sendClientReply(database, {
      chatId: 'chat-56b',
      ticketId: 562,
      client: clientB,
      messageId: 4,
    });
    assert.equal(hourlySecond.result.handled, false);
    assert.equal(hourlySecond.result.reason, 'rate-limit');
    assert.equal(hourlySecond.runs.n, 0);
  });

  it('does not consume quota when the reply fails to send', async () => {
    const database = createDb();
    saveAiSettings(database, {
      enabled: true,
      testMode: false,
      customerRepliesPerHour: 8,
      customerRepliesPerTicket: 20,
    });
    const client = { id: 44, phone: '+998907776655' };
    const ticket = { id: 44, client_id: 44, client };
    const failed = await sendClientReply(database, {
      chatId: 'chat-44',
      ticketId: 44,
      client,
      messageId: 1,
      onSend: async () => {
        throw new Error('send failed');
      },
    });
    assert.equal(failed.result.handled, false);
    assert.equal(failed.result.reason, 'send-failed');
    assert.equal(failed.runs.n, 1);
    assert.equal(getCustomerReplyCount(database, 44), 0);
    assert.equal(countCustomerUsageSince(database, resolveCustomerUsageKey(ticket, 'chat-44')), 0);
  });

  it('passes the stored customer system prompt into runAgent', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    savePrompt(database, 'customer', 'CUSTOM STORED PROMPT');
    let system: any = null;
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
        runAgent: async (args?: any) => {
          system = args.system;
          assert.equal(args.promptCacheKey, 'customer:42');
          return { content: 'Ответ', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(system, 'CUSTOM STORED PROMPT');
  });

  it('sends exactly the configured number of latest messages', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini', historyLimit: 2 });
    const all = [
      { id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'one' },
      { id: '2', author_entity_type: 'User', message_type: 'Regular', text: 'two' },
      { id: '3', author_entity_type: 'Client', message_type: 'Regular', text: 'three' },
      { id: '4', author_entity_type: 'User', message_type: 'Regular', text: 'four' },
      { id: '5', author_entity_type: 'Client', message_type: 'Regular', text: 'five' },
    ];
    const requested: any[] = [];
    let captured: any = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async (_chatId: any, options: any = {}) => {
          requested.push({ limit: options.limit, offset: options.offset });
          const limit = options.limit || all.length;
          const offset = options.offset || 0;
          const newestFirst = [...all].reverse();
          return {
            total: all.length,
            result: newestFirst.slice(offset, offset + limit).reverse(),
          };
        },
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(requested, [{ limit: 2, offset: 0 }]);
    assert.equal(captured.messages.length, 2);
    assert.deepEqual(
      captured.messages.map((item?: any) => item.content),
      ['four', 'five']
    );
  });

  it('uses only the latest in-period messages from the current ticket', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini', historyLimit: 2 });
    const all = [
      { id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'old-ticket', created_date: 500 },
      { id: '2', author_entity_type: 'User', message_type: 'Regular', text: 'old-reply', created_date: 600 },
      { id: '3', author_entity_type: 'Client', message_type: 'Regular', text: 'current-one', created_date: 1100 },
      { id: '4', author_entity_type: 'User', message_type: 'Regular', text: 'current-two', created_date: 1200 },
      { id: '5', author_entity_type: 'Client', message_type: 'Regular', text: 'current-three', created_date: 1300 },
    ];
    let captured: any = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          created_date: 1000,
          client_id: 7,
          client: { id: 7, phone: '+998901112233' },
        }),
        getTicketMessages: async (_chatId: any, options: any = {}) => {
          const limit = options.limit || all.length;
          const offset = options.offset || 0;
          const newestFirst = [...all].reverse();
          return {
            total: all.length,
            result: newestFirst.slice(offset, offset + limit).reverse(),
          };
        },
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(
      captured.messages.map((item?: any) => item.content),
      ['current-two', 'current-three']
    );
    assert.equal(
      captured.messages.some((item?: any) => String(item.content).includes('old-')),
      false
    );
  });

  it('injects prior ticket summaries as a later user message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    savePrompt(database, 'customer', 'BASE PROMPT');
    upsertTicketSummary(database, {
      ticketId: 10,
      clientId: 7,
      summary: 'Клиент уже спрашивал про оплату.',
      status: 'done',
      periodEnd: 900,
    });
    let captured: any = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          created_date: 1000,
          client_id: 7,
          client: { id: 7, phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 1,
          result: [
            {
              id: '9',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: 'Ещё вопрос',
              created_date: 1100,
            },
          ],
        }),
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(captured.system, 'BASE PROMPT');
    assert.equal(captured.messages[0].role, 'user');
    assert.match(captured.messages[0].content, /Клиент уже спрашивал про оплату/);
    assert.ok(!captured.messages[0].content.includes(knowledgeCategoryContext(database)));
    assert.ok(!String(captured.system).includes('Клиент уже спрашивал про оплату'));
    assert.ok(captured.messages[0].content.length <= SUMMARY_TOKEN_BUDGET * 4 + 8);
    assert.equal(captured.promptCacheKey, 'customer:42');
  });

  it('skips ChatBot messages to prevent loops', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true });
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '11',
      deps: {
        findTicketByChatId: async () => ({ id: 42, status: 'Open', client: { phone: '+99890' } }),
        getTicketMessages: async () => ({
          total: 1,
          result: [{ id: '11', author_entity_type: 'ChatBot', message_type: 'Regular', text: 'бот' }],
        }),
        addTicketMessage: async () => {
          throw new Error('must not reply');
        },
      },
    });
    assert.equal(result.reason, 'bot');
  });

  it('does not fall back to the last client message for an unknown webhook id', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    let replied = false;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: 'staff-new',
      payload: { id: 'staff-new', chat_id: 'chat-42' },
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 1,
          result: [
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит?' },
          ],
        }),
        addTicketMessage: async () => {
          replied = true;
        },
        runAgent: async () => ({ content: 'must not run', steps: 1 }),
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'message-not-found');
    assert.equal(replied, false);
  });
});
