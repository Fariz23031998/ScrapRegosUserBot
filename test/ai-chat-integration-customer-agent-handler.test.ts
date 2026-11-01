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

  it('does not reply when disabled', async () => {
    const database = createDb();
    let replied = false;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-1',
      messageId: '1',
      deps: {
        addTicketMessage: async () => {
          replied = true;
        },
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(replied, false);
  });

  it('does not reply when the trigger text is ignored', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, ignoredCustomerMessages: ['/start'] });
    let replied = false;
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
          total: 1,
          result: [{ id: '9', author_entity_type: 'Client', message_type: 'Regular', text: '/start' }],
        }),
        addTicketMessage: async () => {
          replied = true;
        },
        runAgent: async () => {
          ran = true;
          return { content: 'unused', steps: 1 };
        },
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'ignored-message');
    assert.equal(replied, false);
    assert.equal(ran, false);
  });

  it('does not reply to a system notice remapped to an ignored client greeting', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, ignoredCustomerMessages: ['/start'] });
    let replied = false;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: 'sys-phone',
      payload: {
        id: 'sys-phone',
        chat_id: 'chat-42',
        message_type: 'System',
        text: 'Запросили у клиента номер телефона',
      },
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async () => ({
          total: 2,
          result: [
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: '/start' },
            {
              id: 'sys-phone',
              message_type: 'System',
              text: 'Запросили у клиента номер телефона',
            },
          ],
        }),
        addTicketMessage: async () => {
          replied = true;
        },
        runAgent: async () => ({ content: 'unused', steps: 1 }),
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'ignored-message');
    assert.equal(replied, false);
  });

  it('replies as a linked REGOS user for an allowed client message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const sent: any[] = [];
    const participants: any[] = [];
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
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит?' },
          ],
        }),
        ensureTicketParticipant: async (ticketId?: any, userId?: any) => {
          participants.push({ ticketId, userId });
          return { ok: true };
        },
        addTicketMessage: async (payload?: any) => {
          sent.push(payload);
          return { ok: true, id: '10' };
        },
        runAgent: async () => ({ content: 'Сейчас уточню по прайсу.', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].authorEntityType, 'User');
    assert.equal(sent[0].authorEntityId, aiAuthorId);
    assert.equal(sent[0].text, 'Сейчас уточню по прайсу.');
    assert.deepEqual(participants, [{ ticketId: 42, userId: aiAuthorId }]);
  });

  it('passes the configured max chain of action into runAgent', async () => {
    const database = createDb();
    saveAiSettings(database, {
      enabled: true,
      testMode: false,
      model: 'gpt-4o-mini',
      agentMaxSteps: { customer: 4 },
    });
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
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит?' },
          ],
        }),
        addTicketMessage: async () => ({ ok: true, id: '10' }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Сейчас уточню по прайсу.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(captured.maxSteps, 4);
  });

  it('forceHandle still respects test mode for non-employee clients', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: true, model: 'gpt-4o-mini' });
    const sent: any[] = [];
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      messageId: '9',
      forceHandle: true,
      payload: {
        id: '9',
        text: 'Сколько стоит?',
        author_entity_type: 'Client',
        message_type: 'Regular',
      },
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998909999999' },
        }),
        getTicketMessages: async () => ({
          total: 1,
          result: [
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит?' },
          ],
        }),
        addTicketMessage: async (payload?: any) => {
          sent.push(payload);
          return { ok: true, id: '10' };
        },
        runAgent: async () => ({ content: 'should not run', steps: 1 }),
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'test-mode');
    assert.equal(sent.length, 0);
  });

  it('closes the ticket only after the reply is posted', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const order: any[] = [];
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
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Спасибо, всё понятно' },
          ],
        }),
        addTicketMessage: async () => {
          order.push('send');
          return { ok: true, id: '10' };
        },
        setTicketStatus: async (ticketId?: any, status?: any) => {
          order.push(`close:${ticketId}:${status}`);
          return { ok: true };
        },
        runAgent: async ({ tools }: Unchecked) => {
          const close = tools.find((tool?: any) => tool.name === 'close_ticket');
          const closeResult = await close.execute();
          assert.equal(closeResult.ok, true);
          assert.equal(closeResult.status, 'Closed');
          assert.deepEqual(order, []);
          return { content: 'Рад помочь. Обращение закрываю.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.closed, true);
    assert.deepEqual(order, ['send', 'close:42:Closed']);
  });

  it('does not close the ticket when the reply fails to send', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    let closed = false;
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
            { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Спасибо' },
          ],
        }),
        addTicketMessage: async () => {
          throw new Error('send failed');
        },
        setTicketStatus: async () => {
          closed = true;
          return { ok: true };
        },
        runAgent: async ({ tools }: Unchecked) => {
          const closeResult = await tools.find((tool?: any) => tool.name === 'close_ticket').execute();
          assert.equal(closeResult.ok, true);
          return { content: 'Готово.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'send-failed');
    assert.equal(closed, false);
  });

  it('skips the 9th hourly reply for the same client across tickets', async () => {
    const database = createDb();
    saveAiSettings(database, {
      enabled: true,
      testMode: false,
      customerRepliesPerHour: 8,
      customerRepliesPerTicket: 0,
    });
    const client = { id: 77, phone: '+998901112233' };
    for (let i = 1; i <= 8; i += 1) {
      const ticketId = i <= 4 ? 101 : 102;
      const chatId = ticketId === 101 ? 'chat-101' : 'chat-102';
      const { result, runs } = await sendClientReply(database, {
        chatId,
        ticketId,
        client,
        messageId: 1000 + i,
      });
      assert.equal(result.handled, true, `reply ${i} should send`);
      assert.equal(runs.n, 1);
    }
    const ninth = await sendClientReply(database, {
      chatId: 'chat-102',
      ticketId: 102,
      client,
      messageId: 2009,
    });
    assert.equal(ninth.result.handled, false);
    assert.equal(ninth.result.reason, 'rate-limit');
    assert.equal(ninth.runs.n, 0);
  });
});
