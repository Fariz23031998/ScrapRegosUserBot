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


describe('employee test agent', () => {
  it('keeps employee sandbox sessions separate from customer ones', async () => {
    const database = createDb();
    const customer = await loadCustomerTestSession({
      db: database,
      userId: 3,
      requireTicket: false,
    });
    const employee = await loadEmployeeTestSession({
      db: database,
      userId: 3,
      requireTicket: false,
    });
    assert.notEqual(customer.session_id, employee.session_id);
  });

  it('simulates reply_to_customer and returns an execution trace', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: false, model: 'gpt-4o-mini' });
    let posted = false;
    const result = await runEmployeeTestAgent({
      db: database,
      userId: 4,
      message: 'Ответь клиенту, что прайс на сайте',
      ticketId: 77,
      deps: {
        findTicketById: async (id?: any) => ({
          id,
          status: 'Open',
          subject: 'Прайс',
          chat_id: 'chat-77',
          client: { name: 'Клиент', phone: '+99890' },
        }),
        getTicketMessages: async () => ({
          result: [{ id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит?' }],
        }),
        getChatFilesByIds: async () => [],
        addTicketMessage: async () => {
          posted = true;
          return { ok: true };
        },
        runAgent: async ({ tools, system, promptCacheKey }: Unchecked) => {
          assert.match(system, /песочница/i);
          assert.match(promptCacheKey, /^employee_test:/);
          const replyTool = tools.find((tool?: any) => tool.name === 'reply_to_customer');
          assert.ok(replyTool);
          const sent = await replyTool.execute({ text: 'Прайс на сайте.' });
          assert.equal(sent.ok, true);
          assert.equal(sent.simulated, true);
          return {
            content: 'Отправил клиенту.',
            steps: 2,
            usage: { prompt_tokens: 11, completion_tokens: 4 },
            trace: [
              {
                step: 1,
                type: 'tool_round',
                assistant_content: null,
                tool_calls: [
                  {
                    id: 'r1',
                    name: 'reply_to_customer',
                    arguments: { text: 'Прайс на сайте.' },
                    result: sent,
                    ok: true,
                    error: null,
                  },
                ],
              },
              { step: 2, type: 'final', content: 'Отправил клиенту.' },
            ],
          };
        },
      },
    });

    assert.equal(posted, false);
    assert.equal(result.reply, 'Отправил клиенту.');
    assert.equal(result.replied_to_customer, true);
    assert.equal(result.customer_reply, 'Прайс на сайте.');
    assert.equal(result.trace[0].tool_calls[0].name, 'reply_to_customer');
    assert.equal(result.steps, 2);
    assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 4 });
    const run = result.messages.find((item?: any) => item.role === 'assistant').run;
    assert.equal(run.replied_to_customer, true);
    assert.match(String(run.messages[0].content), /Обращение #77/);
    assert.match(String(run.messages[0].content), /Клиент: Сколько стоит\?/);
    const reloaded = await loadEmployeeTestSession({
      db: database,
      userId: 4,
      sessionId: result.session_id,
      requireTicket: false,
      deps: {
        findTicketById: async (id?: any) => ({
          id,
          status: 'Open',
          subject: 'Прайс',
          chat_id: 'chat-77',
          client: { name: 'Клиент', phone: '+99890' },
        }),
        getTicketMessages: async () => ({ result: [] }),
        getChatFilesByIds: async () => [],
      },
    });
    assert.match(String(reloaded.messages.at(-1).run.messages[0].content), /Обращение #77/);
  });
});

describe('ticket AI assist agent', () => {
  function assistTicket(overrides: any = {}) {
    return {
      id: 42,
      status: 'Open',
      subject: 'Прайс',
      chat_id: 'chat-42',
      client: { id: 12, name: 'Иван', phone: '+99890' },
      participant_user_ids: [99],
      ...overrides,
    };
  }

  function assistDeps(overrides: any = {}) {
    return {
      findTicketById: async (id?: any) => assistTicket({ id: Number(id) }),
      getTicketMessages: async () => ({
        result: [
          { id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит лицензия?' },
          { id: '2', author_entity_type: 'User', message_type: 'Regular', text: 'Сейчас уточню' },
        ],
      }),
      getChatFilesByIds: async () => [],
      addTicketMessage: async () => {
        throw new Error('must not post to ticket chat');
      },
      ensureTicketParticipant: async () => {
        throw new Error('must not add participant');
      },
      isTicketStaffParticipant: () => true,
      notifyEmployee: async () => ({ ok: true }),
      setTicketResponsible: async () => ({ ok: true }),
      ...overrides,
    };
  }

  it('creates a per-user ticket session and injects chat history into the prompt', async () => {
    const database = createDb();
    savePrompt(database, 'customer', 'ASSIST CUSTOMER PROMPT');
    savePrompt(database, 'customer_assist', 'ASSIST STAFF SUFFIX');
    let captured: any = null;
    const result = await runTicketAssistAgent({
      db: database,
      userId: 7,
      ticketId: 42,
      message: 'Назови цену 450 тысяч и предложи акцию',
      deps: {
        ...assistDeps(),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Отправлю клиенту про 450 тысяч.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });

    assert.equal(result.ticket_id, 42);
    assert.equal(result.replied_to_customer, false);
    assert.equal(result.customer_reply, null);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Назови цену 450 тысяч и предложи акцию');
    assert.equal(result.messages[1].role, 'assistant');
    assert.match(captured.system, /ASSIST CUSTOMER PROMPT/);
    assert.match(captured.system, /ASSIST STAFF SUFFIX/);
    assert.ok(!captured.system.includes(CUSTOMER_ASSIST_PROMPT_SUFFIX));
    assert.equal(captured.system.includes('Обращение #42'), false);
    assert.equal(captured.messages[0].role, 'user');
    assert.match(captured.messages[0].content, /Обращение #42/);
    assert.match(captured.messages[0].content, /Клиент: Сколько стоит лицензия\?/);
    assert.match(captured.messages[0].content, /Сотрудник: Сейчас уточню/);
    assert.ok(!captured.messages[0].content.includes(knowledgeCategoryContext(database)));
    assert.equal(captured.messages.at(-1).content, 'Назови цену 450 тысяч и предложи акцию');
    assert.equal(captured.promptCacheKey, 'customer_assist:42');
    assert.ok(captured.tools.some((tool?: any) => tool.name === 'reply_to_customer'));
    assert.ok(captured.tools.some((tool?: any) => tool.name === 'notify_employee'));
  });

  it('does not write assist replies to the ticket chat unless reply_to_customer is used', async () => {
    const database = createDb();
    let posted = 0;
    await runTicketAssistAgent({
      db: database,
      userId: 3,
      ticketId: 42,
      message: 'Что хочет клиент?',
      deps: {
        ...assistDeps({
          addTicketMessage: async () => {
            posted += 1;
            return { ok: true };
          },
        }),
        runAgent: async () => ({ content: 'Клиент спрашивает цену лицензии.', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(posted, 0);
  });

  it('posts to the customer chat as the AI author when reply_to_customer is used', async () => {
    const database = createDb();
    const previousAuthor = process.env.AI_REGOS_AUTHOR_USER_ID;
    process.env.AI_REGOS_AUTHOR_USER_ID = '99';
    const posted: any[] = [];
    try {
      const result = await runTicketAssistAgent({
        db: database,
        userId: 3,
        ticketId: 42,
        message: 'Ответь клиенту, что лицензия 450 000 сум',
        deps: {
          ...assistDeps({
            addTicketMessage: async (payload?: any) => {
              posted.push(payload);
              return { ok: true, id: 'sent-1' };
            },
          }),
          runAgent: async ({ tools }: Unchecked) => {
            const replyTool = tools.find((tool?: any) => tool.name === 'reply_to_customer');
            const sent = await replyTool.execute({ text: 'Лицензия стоит 450 000 сум.' });
            assert.equal(sent.ok, true);
            return { content: 'Отправил клиенту.', steps: 2 };
          },
          provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
        },
      });

      assert.equal(result.replied_to_customer, true);
      assert.equal(result.customer_reply, 'Лицензия стоит 450 000 сум.');
      assert.equal(result.reply, 'Отправил клиенту.');
      assert.equal(posted.length, 1);
      assert.equal(posted[0].chatId, 'chat-42');
      assert.equal(posted[0].text, 'Лицензия стоит 450 000 сум.');
      assert.equal(posted[0].authorEntityType, 'User');
      assert.equal(posted[0].authorEntityId, 99);
    } finally {
      if (previousAuthor === undefined) delete process.env.AI_REGOS_AUTHOR_USER_ID;
      else process.env.AI_REGOS_AUTHOR_USER_ID = previousAuthor;
    }
  });

  it('loads or resets the assist session without calling the model', async () => {
    const database = createDb();
    await runTicketAssistAgent({
      db: database,
      userId: 8,
      ticketId: 42,
      message: 'Первая подсказка',
      deps: {
        ...assistDeps(),
        runAgent: async () => ({ content: 'Понял.', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    const loaded = await loadTicketAssistSession({
      db: database,
      userId: 8,
      ticketId: 42,
      deps: assistDeps(),
    });
    assert.equal(loaded.messages.length, 2);
    const reset = await loadTicketAssistSession({
      db: database,
      userId: 8,
      ticketId: 42,
      reset: true,
      deps: assistDeps(),
    });
    assert.equal(reset.messages.length, 0);
    assert.notEqual(reset.session_id, loaded.session_id);
  });

  it('previews the employee assist prompt without calling the model', async () => {
    const database = createDb();
    savePrompt(database, 'customer', 'ASSIST CUSTOMER PROMPT');
    savePrompt(database, 'customer_assist', 'ASSIST STAFF SUFFIX');
    await runTicketAssistAgent({
      db: database,
      userId: 8,
      ticketId: 42,
      message: 'Назови цену',
      deps: {
        ...assistDeps(),
        runAgent: async () => ({ content: 'Понял.', steps: 1 }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    const preview = await previewTicketAssistPrompt({
      db: database,
      userId: 8,
      ticketId: 42,
      deps: assistDeps(),
    });
    assert.match(preview.system, /ASSIST CUSTOMER PROMPT/);
    assert.match(preview.system, /ASSIST STAFF SUFFIX/);
    assert.equal(preview.ticket_id, 42);
    assert.equal(preview.chat_id, 'chat-42');
    assert.match(preview.messages[0].content, /Обращение #42/);
    assert.equal(preview.messages.at(-2).content, 'Назови цену');
    assert.equal(preview.messages.at(-1).content, 'Понял.');
    assert.ok(preview.tools.some((tool?: any) => tool.name === 'reply_to_customer'));
    assert.equal(preview.tools.every((tool?: any) => tool.execute == null), true);
  });
});
