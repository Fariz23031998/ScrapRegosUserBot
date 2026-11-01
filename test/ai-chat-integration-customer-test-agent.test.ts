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


describe('customer test agent', () => {
  it('exposes ai_customer_test permission and user_rights column', () => {
    const database = createDb();
    assert.ok(RIGHTS.ai_customer_test);
    assert.equal(DEFAULT_RIGHTS.ai_customer_test, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('ai_customer_test'));
    assert.ok(RIGHTS.ai_customer_test_history);
    assert.equal(DEFAULT_RIGHTS.ai_customer_test_history, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('ai_customer_test_history'));
    const cols = database.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col?: any) => col.name === 'ai_customer_test'));
    assert.ok(cols.some((col?: any) => col.name === 'ai_customer_test_history'));
  });

  it('runs a sandbox reply without notifying employees or assigning tickets', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: false, model: 'gpt-4o-mini' });
    let notified = false;
    let assigned = false;
    let closed = false;
    let edited = false;
    let participantsSet = false;
    const result = await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Сколько стоит техподдержка?',
      ticketId: 42,
      clientPhone: '+998901112233',
      deps: {
        findTicketById: async (id?: any) => ({
          id,
          status: 'Open',
          subject: 'Тест',
          client: { name: 'Иван', phone: '+99890' },
        }),
        getTicketMessages: async () => {
          throw new Error('must not load real chat');
        },
        notifyEmployee: async () => {
          notified = true;
          return { ok: true };
        },
        setTicketResponsible: async () => {
          assigned = true;
          return { ok: true };
        },
        setTicketStatus: async () => {
          closed = true;
          return { ok: true };
        },
        editTicket: async () => {
          edited = true;
          return { ok: true };
        },
        setTicketParticipants: async () => {
          participantsSet = true;
          return { ok: true };
        },
        runAgent: async ({ tools, messages }: Unchecked) => {
          const notify = tools.find((tool?: any) => tool.name === 'notify_employee');
          const assign = tools.find((tool?: any) => tool.name === 'assign_responsible');
          const close = tools.find((tool?: any) => tool.name === 'close_ticket');
          const update = tools.find((tool?: any) => tool.name === 'update_ticket');
          const notifyResult = await notify.execute({ employee_id: 7, message: 'Нужен менеджер' });
          const assignResult = await assign.execute({ regos_user_id: 31 });
          const closeResult = await close.execute();
          const updateResult = await update.execute({
            subject: 'Новая тема',
            participant_user_ids: [7],
          });
          assert.equal(notifyResult.ok, true);
          assert.equal(assignResult.ok, true);
          assert.equal(closeResult.ok, true);
          assert.equal(updateResult.ok, true);
          assert.equal(messages.at(-1).content, 'Сколько стоит техподдержка?');
          return {
            content: 'Сейчас посмотрю прайс.',
            steps: 2,
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            trace: [
              {
                step: 1,
                type: 'tool_round',
                assistant_content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    name: 'notify_employee',
                    arguments: { employee_id: 7 },
                    result: { ok: true },
                    ok: true,
                    error: null,
                  },
                ],
              },
              { step: 2, type: 'final', content: 'Сейчас посмотрю прайс.' },
            ],
          };
        },
      },
    });

    assert.equal(notified, false);
    assert.equal(assigned, false);
    assert.equal(closed, false);
    assert.equal(edited, false);
    assert.equal(participantsSet, false);
    assert.equal(result.reply, 'Сейчас посмотрю прайс.');
    assert.equal(result.ticket_id, 42);
    assert.equal(result.client_phone, '+998901112233');
    assert.equal(result.ticket.client.phone, '+998901112233');
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[1].role, 'assistant');
    assert.equal(result.steps, 2);
    assert.equal(result.trace.length, 2);
    assert.equal(result.trace[0].tool_calls[0].name, 'notify_employee');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5 });
  });

  it('stubs group topic sends in the sandbox when the allowlist is configured', async () => {
    const database = createDb();
    saveAiSettings(database, {
      groupChatId: '-1001234567890',
      groupTopics: [{ key: 'urgent', id: 123, name: 'Срочная помощь' }],
    });
    let notifiedGroup = false;
    const result = await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Касса не работает',
      deps: {
        notifyGroupTopic: async () => {
          notifiedGroup = true;
          return { ok: true };
        },
        runAgent: async ({ tools }: Unchecked) => {
          const list = tools.find((tool?: any) => tool.name === 'list_group_topics');
          const send = tools.find((tool?: any) => tool.name === 'send_group_topic_message');
          assert.ok(list);
          assert.ok(send);
          const listed = await list.execute();
          assert.equal(listed.ok, true);
          const sent = await send.execute({ topic_key: 'urgent', message: 'Касса не открывается' });
          assert.equal(sent.ok, true);
          assert.equal(sent.topic_name, 'Тестовая тема');
          return { content: 'Передал в группу.', steps: 1 };
        },
      },
    });
    assert.equal(notifiedGroup, false);
    assert.equal(result.reply, 'Передал в группу.');
  });

  it('loads a real ticket into the sandbox context', async () => {
    const database = createDb();
    const loaded = await loadCustomerTestSession({
      db: database,
      userId: 9,
      ticketId: 610,
      clientPhone: '',
      deps: {
        findTicketById: async (id?: any) => ({
          id,
          status: 'Open',
          subject: 'Доставка',
          chat_id: 'chat-610',
          client: { id: 12, name: 'Иван', phone: '+99890' },
        }),
      },
    });
    assert.equal(loaded.ticket_id, 610);
    assert.equal(loaded.ticket.subject, 'Доставка');
    assert.equal(loaded.ticket.client.phone, '+99890');
  });

  it('uses the stored customer prompt plus test suffix', async () => {
    const database = createDb();
    savePrompt(database, 'customer', 'TEST CUSTOMER PROMPT');
    let captured: any = null;
    await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Привет',
      deps: {
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(captured.system, `TEST CUSTOMER PROMPT\n${CUSTOMER_TEST_PROMPT_SUFFIX}`);
    assert.match(captured.promptCacheKey, /^customer_test:/);
  });

  it('inlines uploaded images in the sandbox customer chat', async () => {
    const database = createDb();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ).toString('base64');
    let captured: any = null;
    const result = await runCustomerTestAgent({
      db: database,
      userId: 4,
      message: '',
      files: [{ name: 'photo.png', extension: 'png', data: png, mime_type: 'image/png' }],
      deps: {
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Вижу фото.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });

    const last = captured.messages.at(-1);
    assert.ok(Array.isArray(last.content));
    assert.equal(last.content[0].type, 'text');
    assert.match(last.content[0].text, /photo\.png/);
    assert.equal(last.content[1].type, 'image_url');
    assert.equal(result.messages[0].files[0].kind, 'image');
    assert.equal(result.reply, 'Вижу фото.');
    const stored = result.messages[1].run.messages.at(-1).content;
    assert.ok(Array.isArray(stored));
    assert.equal(stored[1].image_url.url, '[image]');
  });

  it('persists the model payload and trace so a session reload still has them', async () => {
    const database = createDb();
    savePrompt(database, 'customer', 'TEST CUSTOMER PROMPT');
    const result = await runCustomerTestAgent({
      db: database,
      userId: 8,
      message: 'Привет',
      deps: {
        runAgent: async () => ({
          content: 'Здравствуйте.',
          steps: 1,
          usage: { prompt_tokens: 4, completion_tokens: 2 },
          trace: [{ step: 1, type: 'final', content: 'Здравствуйте.' }],
        }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    const assistant = result.messages.find((item?: any) => item.role === 'assistant');
    assert.ok(assistant.run);
    assert.match(assistant.run.system, /TEST CUSTOMER PROMPT/);
    assert.equal(assistant.run.trace[0].type, 'final');
    assert.ok(assistant.run.tools.some((tool?: any) => tool.name === 'search_knowledge'));
    assert.ok(result.prompt.system.includes('TEST CUSTOMER PROMPT'));

    const loaded = await loadCustomerTestSession({
      db: database,
      userId: 8,
      sessionId: result.session_id,
      requireTicket: false,
    });
    const loadedAssistant = loaded.messages.find((item?: any) => item.role === 'assistant');
    assert.equal(loadedAssistant.run.trace[0].content, 'Здравствуйте.');
    assert.match(loadedAssistant.run.system, /TEST CUSTOMER PROMPT/);
    assert.match(loaded.prompt.system, /TEST CUSTOMER PROMPT/);
  });

  it('lists and deletes own sessions but forbids another user without history access', async () => {
    const database = createDb();
    const owner = await runCustomerTestAgent({
      db: database,
      userId: 11,
      message: 'Сколько стоит лицензия?',
      deps: {
        runAgent: async () => ({ content: 'Ок', steps: 1, trace: [] }),
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    const listed = listCustomerTestSessions(database, { userId: 11, agentKind: 'customer' });
    assert.equal(listed.length, 1);
    assert.match(listed![0]!.title, /лицензия/);
    assert.equal(listed![0]!.id, owner.session_id);

    await assert.rejects(
      () =>
        loadCustomerTestSession({
          db: database,
          userId: 12,
          sessionId: owner.session_id,
          requireTicket: false,
        }),
      { message: 'SESSION_FORBIDDEN' }
    );
    assert.throws(
      () => deleteCustomerTestSession(database, owner.session_id, { userId: 12 }),
      { message: 'SESSION_FORBIDDEN' }
    );
    assert.throws(
      () => listCustomerTestSessions(database, { userId: 12, agentKind: 'customer', allUsers: true }),
      { message: 'SESSION_FORBIDDEN' }
    );

    const allowed = await loadCustomerTestSession({
      db: database,
      userId: 12,
      sessionId: owner.session_id,
      requireTicket: false,
      allowAnyUser: true,
    });
    assert.equal(allowed.session_id, owner.session_id);

    const all = listCustomerTestSessions(database, {
      userId: 12,
      agentKind: 'customer',
      allUsers: true,
      allowAnyUser: true,
    });
    assert.equal(all.some((item?: any) => item.id === owner.session_id), true);

    assert.equal(
      deleteCustomerTestSession(database, owner.session_id, { userId: 12, allowAnyUser: true }),
      true
    );
    assert.equal(
      listCustomerTestSessions(database, { userId: 11, agentKind: 'customer' }).length,
      0
    );
  });

  it('clears own history and can clear every user with allowAnyUser', async () => {
    const database = createDb();
    const deps = {
      runAgent: async () => ({ content: 'Ок', steps: 1, trace: [] }),
      provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
    };
    await runCustomerTestAgent({ db: database, userId: 21, message: 'один', deps });
    await loadCustomerTestSession({
      db: database,
      userId: 21,
      reset: true,
      requireTicket: false,
    });
    await runCustomerTestAgent({ db: database, userId: 21, message: 'два', deps });
    await runCustomerTestAgent({ db: database, userId: 22, message: 'чужой', deps });

    const own = clearCustomerTestSessions(database, { userId: 21, agentKind: 'customer' });
    assert.equal(own.deleted, 2);
    assert.equal(listCustomerTestSessions(database, { userId: 21, agentKind: 'customer' }).length, 0);
    assert.equal(listCustomerTestSessions(database, { userId: 22, agentKind: 'customer' }).length, 1);

    const all = clearCustomerTestSessions(database, {
      userId: 21,
      agentKind: 'customer',
      allUsers: true,
      allowAnyUser: true,
    });
    assert.equal(all.deleted, 1);
    assert.equal(
      listCustomerTestSessions(database, {
        userId: 21,
        agentKind: 'customer',
        allUsers: true,
        allowAnyUser: true,
      }).length,
      0
    );
  });
});
