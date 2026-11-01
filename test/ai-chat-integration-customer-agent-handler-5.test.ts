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

  it('reuses cached image and audio extractions in older history', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    upsertChatFileExtraction(database, { fileId: 201, kind: 'audio', text: 'старое голосовое' });
    upsertChatFileExtraction(database, { fileId: 101, kind: 'image', text: 'скрин ошибки' });
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
              text: '',
              file_ids: [201],
            },
            {
              id: '2',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              file_ids: [101],
            },
            {
              id: '3',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: 'ещё вопрос',
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
          },
          {
            id: 101,
            name: 'shot.png',
            extension: 'png',
            mime_type: 'image/png',
          },
        ],
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Понял.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.match(captured.messages[0].content, /\[аудио: old\.ogg #201\]/);
    assert.match(captured.messages[0].content, /Расшифровка: старое голосовое/);
    assert.match(captured.messages[1].content, /\[изображение: shot\.png #101\]/);
    assert.match(captured.messages[1].content, /Описание: скрин ошибки/);
    assert.match(captured.messages[2].content, /ещё вопрос/);
  });
});

describe('customer message claims', () => {
  const {
    claimCustomerMessage,
    isCustomerMessageClaimed,
    releaseCustomerMessageClaim,
    claimCustomerChat,
    releaseCustomerChat,
  } = (require('../src/db/customer-message-claims') as typeof import('../src/db/customer-message-claims'));

  it('lets only the first claim win and can be released', () => {
    const database = createDb();
    assert.equal(claimCustomerMessage(database, 'chat-1', '9'), true);
    assert.equal(claimCustomerMessage(database, 'chat-1', '9'), false);
    assert.equal(isCustomerMessageClaimed(database, 'chat-1', '9'), true);
    assert.equal(releaseCustomerMessageClaim(database, 'chat-1', '9'), true);
    assert.equal(isCustomerMessageClaimed(database, 'chat-1', '9'), false);
    assert.equal(claimCustomerMessage(database, 'chat-1', '9'), true);
  });

  it('lets only one process lock a chat at a time', () => {
    const database = createDb();
    assert.equal(claimCustomerChat(database, 'chat-1'), true);
    assert.equal(claimCustomerChat(database, 'chat-1'), false);
    assert.equal(releaseCustomerChat(database, 'chat-1'), true);
    assert.equal(claimCustomerChat(database, 'chat-1'), true);
  });
});

describe('customer agent prompt preview', () => {
  const ticket = {
    id: 42,
    chat_id: 'chat-42',
    status: 'Open',
    created_date: 1000,
    client_id: 7,
    client: { id: 7, phone: '+998901112233' },
  };

  function previewDeps(overrides: any = {}) {
    return {
      findTicketById: async () => ticket,
      getTicketMessages: async () => ({
        total: 2,
        result: [
          { id: '8', author_entity_type: 'User', message_type: 'Regular', text: 'Здравствуйте', created_date: 1100 },
          { id: '9', author_entity_type: 'Client', message_type: 'Regular', text: 'Сколько стоит?', created_date: 1200 },
        ],
      }),
      getChatFilesByIds: async () => [],
      downloadChatFile: async () => {
        throw new Error('preview must not download images');
      },
      ...overrides,
    };
  }

  it('exposes tickets_ai_prompt permission and user_rights column', () => {
    const database = createDb();
    assert.ok(RIGHTS.tickets_ai_prompt);
    assert.equal(DEFAULT_RIGHTS.tickets_ai_prompt, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('tickets_ai_prompt'));
    const cols = database.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col?: any) => col.name === 'tickets_ai_prompt'));
  });

  it('returns the assembled first-step payload without calling the model', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    savePrompt(database, 'customer', 'CUSTOM PREVIEW PROMPT');
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: previewDeps(),
    });
    assert.equal(preview.system, 'CUSTOM PREVIEW PROMPT');
    assert.equal(preview.ticket_id, 42);
    assert.equal(preview.chat_id, 'chat-42');
    assert.equal(preview.trigger_message_id, '9');
    assert.equal(preview.gate.handle, true);
    assert.equal(preview.settings.model, 'gpt-4o-mini');
    assert.equal(preview.settings.history_limit, 30);
    assert.deepEqual(
      preview.messages.map((item?: any) => item.role),
      ['assistant', 'user']
    );
    assert.equal(preview.messages[0].content, 'Здравствуйте');
    assert.equal(preview.messages[1].content, 'Сколько стоит?');
    const toolNames = preview.tools.map((tool?: any) => tool.name);
    assert.ok(toolNames.includes('search_knowledge'));
    assert.ok(toolNames.includes('search_chat_history'));
    assert.ok(toolNames.includes('read_chat_image'));
    assert.ok(toolNames.includes('transcribe_chat_audio'));
    assert.ok(toolNames.includes('update_ticket'));
    assert.equal(
      preview.tools.every((tool?: any) => tool.execute == null),
      true
    );
  });

  it('still returns the assembled prompt when the gate would skip', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: false, testMode: false, model: 'gpt-4o-mini' });
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: previewDeps(),
    });
    assert.equal(preview.gate.handle, false);
    assert.equal(preview.gate.reason, 'disabled');
    assert.equal(preview.system, CUSTOMER_SYSTEM_PROMPT);
    assert.equal(preview.messages.length, 2);
    assert.equal(preview.messages[0].content, 'Здравствуйте');
    assert.ok(preview.tools.length > 0);
  });

  it('defaults the trigger to the last client message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: previewDeps({
        getTicketMessages: async () => ({
          total: 3,
          result: [
            { id: '1', author_entity_type: 'Client', message_type: 'Regular', text: 'первое', created_date: 1100 },
            { id: '2', author_entity_type: 'User', message_type: 'Regular', text: 'ответ', created_date: 1200 },
            { id: '3', author_entity_type: 'Client', message_type: 'Regular', text: 'второе', created_date: 1300 },
          ],
        }),
      }),
    });
    assert.equal(preview.trigger_message_id, '3');
    assert.equal(preview.messages.at(-1).content, 'второе');
  });

  it('uses image placeholders and does not download files', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    let downloaded = false;
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      messageId: '9',
      deps: previewDeps({
        getTicketMessages: async () => ({
          total: 1,
          result: [
            {
              id: '9',
              author_entity_type: 'Client',
              message_type: 'Regular',
              text: '',
              created_date: 1200,
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
        downloadChatFile: async () => {
          downloaded = true;
          throw new Error('preview must not download images');
        },
      }),
    });
    assert.equal(downloaded, false);
    const last = preview.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.ok(Array.isArray(last.content));
    assert.equal(last.content[0].type, 'text');
    assert.match(last.content[0].text, /screenshot\.png/);
    assert.equal(last.content[1].type, 'image_url');
    assert.equal(last.content[1].image_url.placeholder, true);
    assert.equal(last.content[1].image_url.file_id, 101);
    assert.equal(last.content[1].image_url.name, 'screenshot.png');
  });

  it('returns no-chat without loading messages', async () => {
    const database = createDb();
    let loadedMessages = false;
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: previewDeps({
        findTicketById: async () => ({ id: 42, status: 'Open' }),
        getTicketMessages: async () => {
          loadedMessages = true;
          return { total: 0, result: [] };
        },
      }),
    });
    assert.equal(preview.gate.reason, 'no-chat');
    assert.equal(preview.messages.length, 0);
    assert.equal(loadedMessages, false);
  });

  it('includes prior ticket summaries as a later user message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    upsertTicketSummary(database, {
      ticketId: 11,
      clientId: 7,
      summary: 'Ранее чинили кассу.',
      status: 'done',
      periodEnd: 800,
    });
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: previewDeps(),
    });
    assert.equal(preview.system.includes('Ранее чинили кассу'), false);
    assert.equal(preview.messages[0].role, 'user');
    assert.match(preview.messages[0].content, /Ранее чинили кассу/);
    assert.ok(!preview.messages[0].content.includes(knowledgeCategoryContext(database)));
    assert.equal(preview.messages.length, 3);
    assert.equal(preview.summary, null);
    assert.equal(preview.prior_summaries.length, 1);
    assert.equal(preview.prior_summaries[0].ticket_id, 11);
    assert.match(preview.prior_summaries[0].summary, /кассу/);
  });

  it('includes the current ticket summary in the preview payload', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    upsertTicketSummary(database, {
      ticketId: 42,
      clientId: 7,
      summary: 'Текущее обращение про тариф.',
      status: 'done',
    });
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: previewDeps(),
    });
    assert.equal(preview.summary.ticket_id, 42);
    assert.match(preview.summary.summary, /тариф/);
    assert.equal(preview.system.includes('Текущее обращение про тариф'), false);
  });
});
