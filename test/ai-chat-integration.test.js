const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db/partners-db');
const { createEmployeeUser } = require('../src/db/bot-users-db');
const { loadAiSettings, saveAiSettings, serializeAiSettings, resolveAgentModel } = require('../src/ai/settings');
const { CUSTOMER_SYSTEM_PROMPT, CUSTOMER_TEST_PROMPT_SUFFIX, CUSTOMER_ASSIST_PROMPT_SUFFIX, KB_SYSTEM_PROMPT, TICKET_SUMMARY_SYSTEM_PROMPT } = require('../src/ai/default-prompts');
const { getProvider, registerProvider, listProviders } = require('../src/ai/providers/registry');
const { buildChatRequest, normalizeChatContent, normalizeUsage } = require('../src/ai/providers/openai');
const { runAgent, resolveAgentTimeoutMs, prependUserContext, buildPromptCacheKey } = require('../src/ai/run-agent');
const {
  listKnowledgeArticles,
  getKnowledgeArticle,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  createKnowledgeCategory,
  knowledgeCategoryContext,
} = require('../src/db/knowledge-articles');
const {
  listPrompts,
  getResolvedPrompt,
  savePrompt,
  resetPrompt,
  createPrompt,
  updatePrompt,
  setActivePrompt,
  deletePrompt,
  ensureAiPromptsTable,
  DEFAULT_PROMPT_NAME,
} = require('../src/db/ai-prompts');
const { createKnowledgeTools } = require('../src/ai/tools/knowledge');
const { createCustomerTools } = require('../src/ai/tools/customer');
const {
  classifyChatFile,
  downloadChatFile,
  isVisionImage,
  toImageUrlPart,
} = require('../src/ai/chat-media');
const { transcribeChatAudio, clearTranscribeCache } = require('../src/ai/transcribe');
const { captionChatImage, clearCaptionCache } = require('../src/ai/image-caption');
const {
  getChatFileExtraction,
  upsertChatFileExtraction,
} = require('../src/db/chat-file-extractions');
const {
  assertSafeBrowseUrl,
  browseUrl,
  classifyBrowseHost,
  htmlToText,
  parseDuckDuckGoResults,
  unwrapDuckDuckGoUrl,
  webSearch,
} = require('../src/ai/tools/browse');
const { findEmployeesForAgent, isEmployeeClientPhone } = require('../src/ai/tools/employees');

function withoutCategoryContext(messages, db) {
  const line = knowledgeCategoryContext(db);
  if (!Array.isArray(messages) || !messages.length) return messages || [];
  const first = String(messages[0]?.content || '');
  if (first === line || first.includes(line)) return messages.slice(1);
  return messages;
}
const {
  evaluateCustomerMessageGate,
  evaluateCustomerMessageGateWithDb,
  handleCustomerChatMessage,
  previewCustomerAgentPrompt,
  resetCustomerAgentLocks,
} = require('../src/ai/customer-agent');
const { runKbAgent } = require('../src/ai/kb-agent');
const {
  loadCustomerTestSession,
  runCustomerTestAgent,
  resetCustomerTestLocks,
} = require('../src/ai/customer-test-agent');
const {
  loadEmployeeTestSession,
  runEmployeeTestAgent,
  resetEmployeeTestLocks,
} = require('../src/ai/employee-test-agent');
const {
  loadTicketAssistSession,
  runTicketAssistAgent,
  resetTicketAssistLocks,
} = require('../src/ai/customer-assist-agent');
const { createRegosTicketWebhookHandler } = require('../src/integrations/regos-ticket-webhook');
const { upsertTicketSummary } = require('../src/db/ticket-summaries');
const { SUMMARY_TOKEN_BUDGET } = require('../src/ai/settings');
const { ADMIN_PERMISSION_KEYS, RIGHTS } = require('../src/db/user-rights');
const { DEFAULT_RIGHTS } = require('../src/db/bot-users-db');

let db = null;
let dbPath = null;

function removeDbFiles(filePath) {
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

describe('AI settings', () => {
  it('defaults to disabled OpenAI gpt-4o-mini and persists toggles', () => {
    const database = createDb();
    const initial = loadAiSettings(database);
    assert.equal(initial.enabled, false);
    assert.equal(initial.testMode, false);
    assert.equal(initial.provider, 'openai');
    assert.equal(initial.model, 'gpt-4o-mini');
    assert.equal(initial.historyLimit, 30);

    const saved = saveAiSettings(database, {
      enabled: true,
      testMode: true,
      model: 'gpt-4o',
      historyLimit: 12,
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.testMode, true);
    assert.equal(saved.model, 'gpt-4o');
    assert.equal(saved.historyLimit, 12);
    assert.equal(loadAiSettings(database).model, 'gpt-4o');
    assert.equal(loadAiSettings(database).historyLimit, 12);
    assert.equal(serializeAiSettings(saved).history_limit, 12);
    assert.equal(serializeAiSettings(saved).models.includes('gpt-4o'), true);
    assert.ok(serializeAiSettings(saved).models.includes('gpt-5'));
    assert.ok(serializeAiSettings(saved).transcribe_models.includes('whisper-1'));
    assert.equal(initial.transcribeModel, 'gpt-4o-transcribe');
    assert.equal(initial.reasoningEffort, '');
    assert.deepEqual(initial.agentModels, {
      customer: '',
      customer_assist: '',
      kb: '',
      ticket_summary: '',
    });
    assert.equal(initial.groupChatId, '');
    assert.deepEqual(initial.groupTopics, []);
    assert.equal(serializeAiSettings(saved).group_chat_id, '');
    assert.deepEqual(serializeAiSettings(saved).group_topics, []);
    assert.equal(serializeAiSettings(saved).group_topics_max, 30);
  });

  it('persists group chat id and topic allowlist', () => {
    const database = createDb();
    const saved = saveAiSettings(database, {
      groupChatId: '-1001234567890',
      groupTopics: [
        { key: 'Urgent', id: '123', name: 'Срочная помощь', when: 'клиент не может работать' },
        { key: 'kkm', id: 456, name: 'KKM' },
        { key: '', id: '', name: '', when: '' },
      ],
    });
    assert.equal(saved.groupChatId, '-1001234567890');
    assert.deepEqual(saved.groupTopics, [
      { key: 'urgent', id: 123, name: 'Срочная помощь', when: 'клиент не может работать' },
      { key: 'kkm', id: 456, name: 'KKM', when: '' },
    ]);
    const serialized = serializeAiSettings(saved);
    assert.equal(serialized.group_chat_id, '-1001234567890');
    assert.equal(serialized.group_topics[0].key, 'urgent');
    assert.equal(serialized.group_topics[0].id, 123);

    saveAiSettings(database, { enabled: true });
    assert.equal(loadAiSettings(database).groupChatId, '-1001234567890');
    assert.equal(loadAiSettings(database).groupTopics.length, 2);

    saveAiSettings(database, { groupChatId: '', groupTopics: [] });
    assert.equal(loadAiSettings(database).groupChatId, '');
    assert.deepEqual(loadAiSettings(database).groupTopics, []);
  });

  it('rejects invalid group chat id and topics', () => {
    const database = createDb();
    assert.throws(() => saveAiSettings(database, { groupChatId: '-100abc' }), /INVALID_AI_GROUP_CHAT_ID/);
    assert.throws(
      () => saveAiSettings(database, { groupTopics: [{ key: 'urgent', id: 1, name: '' }] }),
      /INVALID_AI_GROUP_TOPICS/
    );
    assert.throws(
      () =>
        saveAiSettings(database, {
          groupTopics: [
            { key: 'Urgent', id: 1, name: 'A' },
            { key: 'urgent', id: 2, name: 'B' },
          ],
        }),
      /INVALID_AI_GROUP_TOPICS/
    );
    assert.throws(
      () => saveAiSettings(database, { groupTopics: [{ key: 'bad-key', id: 1, name: 'A' }] }),
      /INVALID_AI_GROUP_TOPICS/
    );
    assert.throws(
      () => saveAiSettings(database, { groupTopics: [{ key: 'urgent', id: 0, name: 'A' }] }),
      /INVALID_AI_GROUP_TOPICS/
    );
  });

  it('rejects unknown providers', () => {
    const database = createDb();
    assert.throws(() => saveAiSettings(database, { provider: 'anthropic' }), /INVALID_AI_PROVIDER/);
  });

  it('rejects an out-of-range history limit', () => {
    const database = createDb();
    assert.throws(() => saveAiSettings(database, { historyLimit: 0 }), /INVALID_AI_HISTORY_LIMIT/);
    assert.throws(() => saveAiSettings(database, { historyLimit: 101 }), /INVALID_AI_HISTORY_LIMIT/);
    assert.throws(() => saveAiSettings(database, { historyLimit: 1.5 }), /INVALID_AI_HISTORY_LIMIT/);
  });

  it('persists per-agent models, transcribe model, and reasoning effort', () => {
    const database = createDb();
    const saved = saveAiSettings(database, {
      model: 'gpt-4o-mini',
      agentModels: { customer: 'gpt-5.6-terra', kb: 'gpt-5-mini' },
      transcribeModel: 'whisper-1',
      reasoningEffort: 'low',
    });
    assert.equal(saved.agentModels.customer, 'gpt-5.6-terra');
    assert.equal(saved.agentModels.kb, 'gpt-5-mini');
    assert.equal(saved.agentModels.customer_assist, '');
    assert.equal(saved.transcribeModel, 'whisper-1');
    assert.equal(saved.reasoningEffort, 'low');
    assert.equal(resolveAgentModel(saved, 'customer'), 'gpt-5.6-terra');
    assert.equal(resolveAgentModel(saved, 'ticket_summary'), 'gpt-4o-mini');
    const serialized = serializeAiSettings(saved);
    assert.equal(serialized.agent_models.customer, 'gpt-5.6-terra');
    assert.equal(serialized.transcribe_model, 'whisper-1');
    assert.equal(serialized.reasoning_effort, 'low');
  });

  it('rejects invalid transcribe model and reasoning effort', () => {
    const database = createDb();
    assert.throws(
      () => saveAiSettings(database, { transcribeModel: 'x'.repeat(81) }),
      /INVALID_AI_TRANSCRIBE_MODEL/
    );
    assert.throws(() => saveAiSettings(database, { reasoningEffort: 'max' }), /INVALID_AI_REASONING_EFFORT/);
  });
});

describe('AI prompts', () => {
  it('resolves defaults, saves, and resets', () => {
    const database = createDb();
    const listed = listPrompts(database);
    assert.equal(listed.length, 4);
    const customerType = listed.find((item) => item.slug === 'customer');
    assert.equal(customerType.active_id, null);
    assert.equal(customerType.prompts[0].is_default, true);
    assert.equal(customerType.prompts[0].is_active, true);
    assert.equal(customerType.prompts[0].name, DEFAULT_PROMPT_NAME);
    assert.equal(listed.find((item) => item.slug === 'customer_assist').title, 'Агент поддержки (сотрудник)');
    assert.equal(listed.find((item) => item.slug === 'kb').title, 'База знаний');
    assert.equal(listed.find((item) => item.slug === 'ticket_summary').title, 'Сводка обращения');
    assert.equal(getResolvedPrompt(database, 'ticket_summary'), TICKET_SUMMARY_SYSTEM_PROMPT);
    assert.equal(getResolvedPrompt(database, 'customer'), CUSTOMER_SYSTEM_PROMPT);
    assert.equal(getResolvedPrompt(database, 'customer_assist'), CUSTOMER_ASSIST_PROMPT_SUFFIX);
    assert.equal(getResolvedPrompt(database, 'kb'), KB_SYSTEM_PROMPT);

    const saved = savePrompt(database, 'customer', 'Новый промпт поддержки');
    assert.equal(saved.is_default, false);
    assert.equal(saved.is_active, true);
    assert.equal(saved.body, 'Новый промпт поддержки');
    assert.equal(getResolvedPrompt(database, 'customer'), 'Новый промпт поддержки');

    const reset = resetPrompt(database, 'customer');
    assert.equal(reset.is_default, true);
    assert.equal(getResolvedPrompt(database, 'customer'), CUSTOMER_SYSTEM_PROMPT);

    assert.throws(() => savePrompt(database, 'other', 'x'), /INVALID_PROMPT_SLUG/);
    assert.throws(() => savePrompt(database, 'kb', '   '), /INVALID_PROMPT_BODY/);
  });

  it('stores multiple prompts per type and uses the active one', () => {
    const database = createDb();
    const first = createPrompt(database, {
      type: 'customer',
      name: 'Короткий',
      body: 'Короткий промпт поддержки',
    });
    const second = createPrompt(database, {
      type: 'kb',
      name: 'База знаний v2',
      body: 'Другой промпт базы знаний',
    });
    assert.equal(first.is_active, false);
    assert.equal(getResolvedPrompt(database, 'customer'), CUSTOMER_SYSTEM_PROMPT);

    const activated = setActivePrompt(database, 'customer', first.id);
    assert.equal(activated.is_active, true);
    assert.equal(getResolvedPrompt(database, 'customer'), 'Короткий промпт поддержки');
    assert.equal(getResolvedPrompt(database, 'kb'), KB_SYSTEM_PROMPT);

    setActivePrompt(database, 'kb', second.id);
    assert.equal(getResolvedPrompt(database, 'kb'), 'Другой промпт базы знаний');

    const renamed = updatePrompt(database, first.id, {
      name: 'Короткий v2',
      body: 'Обновлённый короткий промпт',
    });
    assert.equal(renamed.name, 'Короткий v2');
    assert.equal(getResolvedPrompt(database, 'customer'), 'Обновлённый короткий промпт');

    deletePrompt(database, first.id);
    assert.equal(getResolvedPrompt(database, 'customer'), CUSTOMER_SYSTEM_PROMPT);
    const afterDelete = listPrompts(database).find((item) => item.slug === 'customer');
    assert.equal(afterDelete.active_id, null);
    assert.equal(afterDelete.prompts.length, 1);
    assert.equal(afterDelete.prompts[0].is_default, true);

    assert.throws(() => createPrompt(database, { type: 'customer', name: '  ', body: 'x' }), /INVALID_PROMPT_NAME/);
    assert.throws(() => setActivePrompt(database, 'customer', second.id), /PROMPT_NOT_FOUND/);
  });

  it('migrates a legacy one-prompt-per-type table', () => {
    const database = createDb();
    database.exec('DROP TABLE IF EXISTS ai_prompt_active');
    database.exec('DROP TABLE IF EXISTS ai_prompts');
    database.exec(`
      CREATE TABLE ai_prompts (
        slug TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    database.prepare('INSERT INTO ai_prompts (slug, body) VALUES (?, ?)').run('customer', 'Старый сохранённый промпт');
    ensureAiPromptsTable(database);

    assert.equal(getResolvedPrompt(database, 'customer'), 'Старый сохранённый промпт');
    const listed = listPrompts(database).find((item) => item.slug === 'customer');
    assert.equal(listed.prompts.length, 2);
    assert.equal(listed.prompts[1].is_active, true);
    assert.equal(listed.prompts[1].body, 'Старый сохранённый промпт');
    assert.equal(getResolvedPrompt(database, 'kb'), KB_SYSTEM_PROMPT);
  });
});

describe('provider registry and runAgent', () => {
  it('exposes openai and can switch via registerProvider', () => {
    assert.ok(listProviders().includes('openai'));
    const fake = {
      name: 'fake',
      async chat() {
        return { content: 'ok', toolCalls: [] };
      },
    };
    registerProvider('fake', fake);
    assert.equal(getProvider('fake'), fake);
  });

  it('runs a tool-call loop then returns the model reply', async () => {
    let step = 0;
    const provider = {
      async chat({ tools }) {
        step += 1;
        if (step === 1) {
          assert.equal(tools[0].name, 'ping');
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'ping', arguments: '{"value":"hi"}' }],
            raw: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ping', arguments: '{"value":"hi"}' } }],
            },
          };
        }
        return { content: 'pong:hi', toolCalls: [] };
      },
    };

    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      system: 'test',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [
        {
          name: 'ping',
          description: 'Ping',
          parameters: { type: 'object', properties: { value: { type: 'string' } } },
          execute: async ({ value }) => ({ echo: value }),
        },
      ],
    });
    assert.equal(result.content, 'pong:hi');
    assert.equal(result.steps, 2);
    assert.equal(result.trace.length, 2);
    assert.equal(result.trace[0].type, 'tool_round');
    assert.equal(result.trace[0].tool_calls[0].name, 'ping');
    assert.deepEqual(result.trace[0].tool_calls[0].arguments, { value: 'hi' });
    assert.equal(result.trace[0].tool_calls[0].ok, true);
    assert.deepEqual(result.trace[0].tool_calls[0].result, { echo: 'hi' });
    assert.equal(result.trace[1].type, 'final');
    assert.equal(result.trace[1].content, 'pong:hi');
  });

  it('marks unknown and failed tools in the execution trace', async () => {
    let step = 0;
    const provider = {
      async chat() {
        step += 1;
        if (step === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'call-missing', name: 'missing', arguments: '{}' },
              { id: 'call-fail', name: 'fail', arguments: '{}' },
            ],
          };
        }
        return { content: 'done', toolCalls: [] };
      },
    };
    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'fail',
          description: 'Fail',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            throw new Error('boom');
          },
        },
      ],
    });
    assert.equal(result.trace[0].tool_calls[0].ok, false);
    assert.match(String(result.trace[0].tool_calls[0].error), /unknown_tool:missing/);
    assert.equal(result.trace[0].tool_calls[1].ok, false);
    assert.equal(result.trace[0].tool_calls[1].error, 'boom');
    assert.equal(result.trace[1].type, 'final');
  });

  it('forwards promptCacheKey and returns usage from the last chat call', async () => {
    const keys = [];
    const provider = {
      async chat({ promptCacheKey }) {
        keys.push(promptCacheKey);
        return {
          content: 'ok',
          toolCalls: [],
          usage: { prompt_tokens: 1200, completion_tokens: 20, cached_tokens: 1024 },
        };
      },
    };
    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      promptCacheKey: 'customer:42',
    });
    assert.deepEqual(keys, ['customer:42']);
    assert.deepEqual(result.usage, {
      prompt_tokens: 1200,
      completion_tokens: 20,
      cached_tokens: 1024,
    });
    assert.deepEqual(prependUserContext([{ role: 'user', content: 'hi' }], 'context'), [
      { role: 'user', content: 'context' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(buildPromptCacheKey('customer', 42), 'customer:42');
    assert.equal(buildPromptCacheKey('ticket_summary'), 'ticket_summary');
  });

  it('injects tool vision parts as a follow-up user message', async () => {
    let step = 0;
    let secondMessages = null;
    const imagePart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aaa' },
    };
    const provider = {
      async chat({ messages }) {
        step += 1;
        if (step === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-img', name: 'read_chat_image', arguments: '{"file_id":123}' }],
            raw: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-img',
                  type: 'function',
                  function: { name: 'read_chat_image', arguments: '{"file_id":123}' },
                },
              ],
            },
          };
        }
        secondMessages = messages;
        return { content: 'Вижу скриншот.', toolCalls: [] };
      },
    };

    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'посмотри старый скрин' }],
      tools: [
        {
          name: 'read_chat_image',
          execute: async () => ({
            ok: true,
            file: { id: 123, name: 'shot.png', kind: 'image' },
            _visionParts: [imagePart],
          }),
        },
      ],
    });
    assert.equal(result.content, 'Вижу скриншот.');
    const toolMsg = secondMessages.find((message) => message.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(JSON.parse(toolMsg.content).ok, true);
    assert.equal(JSON.parse(toolMsg.content)._visionParts, undefined);
    const visionMsg = secondMessages.find(
      (message) => message.role === 'user' && Array.isArray(message.content)
    );
    assert.ok(visionMsg);
    assert.equal(visionMsg.content[0].type, 'text');
    assert.deepEqual(visionMsg.content[1], imagePart);
  });
});

describe('customer message gate', () => {
  const clientMessage = { author_entity_type: 'Client', message_type: 'Regular', text: 'hello' };

  it('skips when disabled, bot, staff, or closed', () => {
    assert.equal(
      evaluateCustomerMessageGate({ settings: { enabled: false }, message: clientMessage }).reason,
      'disabled'
    );
    assert.equal(
      evaluateCustomerMessageGate({
        settings: { enabled: true },
        message: { ...clientMessage, author_entity_type: 'ChatBot' },
      }).reason,
      'bot'
    );
    assert.equal(
      evaluateCustomerMessageGate({
        settings: { enabled: true },
        message: { ...clientMessage, author_entity_type: 'User' },
      }).reason,
      'not-client'
    );
    assert.equal(
      evaluateCustomerMessageGate({
        settings: { enabled: true },
        message: clientMessage,
        ticket: { status: 'Closed' },
      }).reason,
      'closed'
    );
    assert.equal(
      evaluateCustomerMessageGate({
        settings: { enabled: true },
        message: clientMessage,
        ticket: { id: 1, status: 'Open' },
        aiStopped: true,
      }).reason,
      'stopped'
    );
  });

  it('in test mode only allows employee phone numbers', () => {
    const database = createDb();
    createEmployeeUser(database, { phone: '+998901112233', displayName: 'Tester' });
    const settings = { enabled: true, testMode: true };

    assert.equal(
      evaluateCustomerMessageGateWithDb(database, {
        settings,
        message: clientMessage,
        ticket: { client: { phone: '+998909999999' } },
      }).reason,
      'test-mode'
    );
    assert.equal(
      evaluateCustomerMessageGateWithDb(database, {
        settings,
        message: clientMessage,
        ticket: { client: { phone: '998901112233' } },
      }).handle,
      true
    );
    assert.equal(isEmployeeClientPhone(database, '90 111 22 33'), true);
  });
});

describe('customer agent handler', () => {
  const aiAuthorId = 31;
  let previousAuthor;

  before(() => {
    previousAuthor = process.env.AI_REGOS_AUTHOR_USER_ID;
    process.env.AI_REGOS_AUTHOR_USER_ID = String(aiAuthorId);
  });

  after(() => {
    if (previousAuthor === undefined) delete process.env.AI_REGOS_AUTHOR_USER_ID;
    else process.env.AI_REGOS_AUTHOR_USER_ID = previousAuthor;
  });

  function withWriteDeps(deps) {
    return {
      ensureTicketParticipant: async () => ({ ok: true }),
      ...deps,
    };
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

  it('replies as a linked REGOS user for an allowed client message', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const sent = [];
    const participants = [];
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
        ensureTicketParticipant: async (ticketId, userId) => {
          participants.push({ ticketId, userId });
          return { ok: true };
        },
        addTicketMessage: async (payload) => {
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

  it('closes the ticket only after the reply is posted', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const order = [];
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
        setTicketStatus: async (ticketId, status) => {
          order.push(`close:${ticketId}:${status}`);
          return { ok: true };
        },
        runAgent: async ({ tools }) => {
          const close = tools.find((tool) => tool.name === 'close_ticket');
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
        runAgent: async ({ tools }) => {
          const closeResult = await tools.find((tool) => tool.name === 'close_ticket').execute();
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

  it('passes the stored customer system prompt into runAgent', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    savePrompt(database, 'customer', 'CUSTOM STORED PROMPT');
    let system = null;
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
        runAgent: async (args) => {
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
    const requested = [];
    let captured = null;
    const result = await handleCustomerChatMessage({
      db: database,
      chatId: 'chat-42',
      deps: withWriteDeps({
        findTicketByChatId: async () => ({
          id: 42,
          status: 'Open',
          client: { phone: '+998901112233' },
        }),
        getTicketMessages: async (_chatId, options = {}) => {
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
        runAgent: async (args) => {
          captured = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(requested, [{ limit: 2, offset: 0 }]);
    const history = withoutCategoryContext(captured.messages, database);
    assert.equal(captured.messages[0].content, knowledgeCategoryContext(database));
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((item) => item.content),
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
    let captured = null;
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
        getTicketMessages: async (_chatId, options = {}) => {
          const limit = options.limit || all.length;
          const offset = options.offset || 0;
          const newestFirst = [...all].reverse();
          return {
            total: all.length,
            result: newestFirst.slice(offset, offset + limit).reverse(),
          };
        },
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args) => {
          captured = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(
      withoutCategoryContext(captured.messages, database).map((item) => item.content),
      ['current-two', 'current-three']
    );
    assert.equal(
      captured.messages.some((item) => String(item.content).includes('old-')),
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
    let captured = null;
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
        runAgent: async (args) => {
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
    assert.ok(captured.messages[0].content.includes(knowledgeCategoryContext(database)));
    assert.ok(!String(captured.system).includes('Клиент уже спрашивал про оплату'));
    const summaryOnly = captured.messages[0].content.replace(`\n\n${knowledgeCategoryContext(database)}`, '');
    assert.ok(summaryOnly.length <= SUMMARY_TOKEN_BUDGET * 4 + 8);
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

  it('replies to the client greeting when the webhook is a ticket-created system notice', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false });
    const sent = [];
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
        addTicketMessage: async (payload) => {
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
    const sent = [];
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
      addTicketMessage: async (payload) => {
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
    let captured = null;
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
        runAgent: async (args) => {
          captured = args;
          return { content: 'Вижу ошибку на скриншоте.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(captured.hasVision, true);
    assert.ok(captured.tools.some((tool) => tool.name === 'read_chat_image'));
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
    let captured = null;
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
        runAgent: async (args) => {
          captured = args;
          return { content: 'Понял.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    const history = withoutCategoryContext(captured.messages, database);
    assert.equal(history.length, 3);
    assert.equal(typeof history[0].content, 'string');
    assert.match(history[0].content, /\[изображение: old\.png #201\]/);
    assert.equal(typeof history[2].content, 'string');
    assert.match(history[2].content, /\[аудио: voice\.ogg #202\]/);
    assert.equal(history[2].content.includes('Расшифровка:'), false);
    assert.equal(
      captured.messages.some((message) => Array.isArray(message.content)),
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
    const transcribed = [];
    let captured = null;
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
        transcribeChatAudio: async (file) => {
          transcribed.push(file.id);
          return { text: `текст ${file.id}` };
        },
        addTicketMessage: async () => ({ ok: true }),
        runAgent: async (args) => {
          captured = args;
          return { content: 'Понял голосовое.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(transcribed, [202]);
    const history = withoutCategoryContext(captured.messages, database);
    assert.match(history[0].content, /\[аудио: old\.ogg #201\]/);
    assert.equal(history[0].content.includes('Расшифровка:'), false);
    assert.match(history[1].content, /\[аудио: voice\.ogg #202\]/);
    assert.match(history[1].content, /Расшифровка: текст 202/);
    assert.equal(captured.hasAudio, true);
    assert.equal(captured.model, 'gpt-5-mini');
    assert.ok(captured.tools.some((tool) => tool.name === 'transcribe_chat_audio'));
  });

  it('reuses cached image and audio extractions in older history', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    upsertChatFileExtraction(database, { fileId: 201, kind: 'audio', text: 'старое голосовое' });
    upsertChatFileExtraction(database, { fileId: 101, kind: 'image', text: 'скрин ошибки' });
    let captured = null;
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
        runAgent: async (args) => {
          captured = args;
          return { content: 'Понял.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      }),
    });
    assert.equal(result.handled, true);
    const history = withoutCategoryContext(captured.messages, database);
    assert.match(history[0].content, /\[аудио: old\.ogg #201\]/);
    assert.match(history[0].content, /Расшифровка: старое голосовое/);
    assert.match(history[1].content, /\[изображение: shot\.png #101\]/);
    assert.match(history[1].content, /Описание: скрин ошибки/);
    assert.match(history[2].content, /ещё вопрос/);
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

  function previewDeps(overrides = {}) {
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
    assert.ok(cols.some((col) => col.name === 'tickets_ai_prompt'));
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
      preview.messages.map((item) => item.role),
      ['user', 'assistant', 'user']
    );
    assert.equal(preview.messages[0].content, knowledgeCategoryContext(database));
    assert.equal(preview.messages[2].content, 'Сколько стоит?');
    const toolNames = preview.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('search_knowledge'));
    assert.ok(toolNames.includes('search_chat_history'));
    assert.ok(toolNames.includes('read_chat_image'));
    assert.ok(toolNames.includes('transcribe_chat_audio'));
    assert.equal(
      preview.tools.every((tool) => tool.execute == null),
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
    assert.equal(preview.messages.length, 3);
    assert.equal(preview.messages[0].content, knowledgeCategoryContext(database));
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
    assert.ok(preview.messages[0].content.includes(knowledgeCategoryContext(database)));
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

describe('chat media helpers', () => {
  it('classifies vision-safe images and skips svg/audio/video', () => {
    assert.equal(isVisionImage({ name: 'a.png', mime_type: 'image/png' }), true);
    assert.equal(isVisionImage({ name: 'a.svg', mime_type: 'image/svg+xml' }), false);
    assert.equal(classifyChatFile({ name: 'clip.mp4', media_type: 'video' }), 'video');
    assert.equal(classifyChatFile({ name: 'note.ogg', mime_type: 'audio/ogg' }), 'audio');
    const part = toImageUrlPart({ mime: 'image/jpeg', base64: 'abc' });
    assert.equal(part.type, 'image_url');
    assert.equal(part.image_url.url, 'data:image/jpeg;base64,abc');
  });

  it('skips unsafe or oversized downloads', async () => {
    const unsafe = await downloadChatFile({ url: 'file:///etc/passwd' });
    assert.equal(unsafe.skipped, true);
    assert.equal(unsafe.reason, 'unsafe_url');

    const oversized = await downloadChatFile(
      { url: 'https://files.example/big.png', mime_type: 'image/png' },
      {
        fetchImpl: async () => ({
          ok: true,
          headers: { get: (name) => (name === 'content-length' ? String(9 * 1024 * 1024) : null) },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
        }),
      }
    );
    assert.equal(oversized.skipped, true);
    assert.equal(oversized.reason, 'too_large');
  });
});

describe('read_chat_image tool', () => {
  it('rejects audio/video and returns vision parts for images', async () => {
    const database = createDb();
    const filesById = new Map([
      [
        1,
        {
          id: 1,
          name: 'shot.png',
          extension: 'png',
          mime_type: 'image/png',
          url: 'https://files.example/shot.png',
        },
      ],
      [
        2,
        {
          id: 2,
          name: 'clip.mp4',
          extension: 'mp4',
          mime_type: 'video/mp4',
          media_type: 'video',
          url: 'https://files.example/clip.mp4',
        },
      ],
    ]);
    const tools = createCustomerTools({
      db: database,
      chatId: 'chat-1',
      filesById,
      deps: {
        downloadChatFile: async () => ({ mime: 'image/png', base64: 'abc' }),
      },
    });
    const readImage = tools.find((tool) => tool.name === 'read_chat_image');
    const video = await readImage.execute({ file_id: 2 });
    assert.equal(video.ok, false);
    assert.equal(video.error, 'not_an_image');
    assert.equal(video.kind, 'video');

    const image = await readImage.execute({ file_id: 1 });
    assert.equal(image.ok, true);
    assert.equal(image.file.id, 1);
    assert.equal(image._visionParts[0].type, 'image_url');
  });
});

describe('close_ticket tool', () => {
  it('rejects a missing ticket, closes an open ticket, and no-ops when already closed', async () => {
    const database = createDb();
    const missing = createCustomerTools({ db: database }).find((tool) => tool.name === 'close_ticket');
    assert.deepEqual(await missing.execute(), { ok: false, error: 'missing_ticket' });

    let closed = null;
    const closer = createCustomerTools({
      db: database,
      ticket: { id: 42, status: 'Open' },
      deps: {
        setTicketStatus: async (ticketId, status) => {
          closed = { ticketId, status };
          return { ok: true };
        },
      },
    }).find((tool) => tool.name === 'close_ticket');
    assert.deepEqual(await closer.execute(), { ok: true, status: 'Closed' });
    assert.deepEqual(closed, { ticketId: 42, status: 'Closed' });

    closed = 'unchanged';
    const already = createCustomerTools({
      db: database,
      ticket: { id: 42, status: 'Closed' },
      deps: {
        setTicketStatus: async () => {
          closed = 'called';
          return { ok: true };
        },
      },
    }).find((tool) => tool.name === 'close_ticket');
    assert.deepEqual(await already.execute(), { ok: true, already_closed: true });
    assert.equal(closed, 'unchanged');
  });
});

describe('transcribe_chat_audio tool', () => {
  it('rejects images and returns transcript text for audio', async () => {
    const database = createDb();
    const filesById = new Map([
      [
        1,
        {
          id: 1,
          name: 'shot.png',
          extension: 'png',
          mime_type: 'image/png',
          url: 'https://files.example/shot.png',
        },
      ],
      [
        2,
        {
          id: 2,
          name: 'voice.ogg',
          extension: 'ogg',
          mime_type: 'audio/ogg',
          media_type: 'voice',
          url: 'https://files.example/voice.ogg',
        },
      ],
    ]);
    const tools = createCustomerTools({
      db: database,
      chatId: 'chat-1',
      filesById,
      deps: {
        transcribeChatAudio: async (file) => ({ text: `hello ${file.id}` }),
      },
    });
    const transcribe = tools.find((tool) => tool.name === 'transcribe_chat_audio');
    const image = await transcribe.execute({ file_id: 1 });
    assert.equal(image.ok, false);
    assert.equal(image.error, 'not_audio');
    assert.equal(image.kind, 'image');

    const audio = await transcribe.execute({ file_id: 2 });
    assert.equal(audio.ok, true);
    assert.equal(audio.text, 'hello 2');
    assert.equal(audio.file.id, 2);
  });
});

describe('openai gpt-5 request shape', () => {
  it('adds max_completion_tokens and reasoning_effort for GPT-5', () => {
    const gpt4 = buildChatRequest({ model: 'gpt-4o-mini', messages: [], reasoningEffort: 'low' });
    assert.equal(gpt4.max_completion_tokens, undefined);
    assert.equal(gpt4.reasoning_effort, undefined);
    assert.equal(gpt4.temperature, undefined);

    const gpt5 = buildChatRequest({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
      promptCacheKey: 'customer:42',
    });
    assert.equal(gpt5.max_completion_tokens, 4096);
    assert.equal(gpt5.reasoning_effort, 'low');
    assert.equal(gpt5.temperature, undefined);
    assert.equal(gpt5.prompt_cache_key, 'customer:42');
    assert.equal(buildChatRequest({ model: 'gpt-4o-mini', messages: [] }).prompt_cache_key, undefined);
    assert.deepEqual(
      normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 1920, cache_write_tokens: 80 },
      }),
      { prompt_tokens: 2000, completion_tokens: 50, cached_tokens: 1920, cache_write_tokens: 80 }
    );
    assert.equal(normalizeUsage(null), null);
  });

  it('normalizes array content parts', () => {
    assert.equal(normalizeChatContent([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]), 'A\nB');
    assert.equal(resolveAgentTimeoutMs('gpt-5'), 90_000);
    assert.equal(resolveAgentTimeoutMs('gpt-4o-mini'), 45_000);
    assert.equal(resolveAgentTimeoutMs('gpt-4o-mini', { hasAudio: true }), 90_000);
  });
});

describe('audio transcription helper', () => {
  it('caches transcripts by file id and size', async () => {
    let calls = 0;
    const file = { id: 9, name: 'voice.ogg', data: Buffer.from('abc').toString('base64') };
    const first = await transcribeChatAudio(file, {
      transcribeImpl: async () => {
        calls += 1;
        return 'hello';
      },
    });
    const second = await transcribeChatAudio(file, {
      transcribeImpl: async () => {
        calls += 1;
        return 'ignored';
      },
    });
    assert.equal(first.text, 'hello');
    assert.equal(second.text, 'hello');
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
  });

  it('persists transcripts in sqlite and reuses them after memory cache is cleared', async () => {
    const database = createDb();
    let calls = 0;
    const file = {
      id: 9,
      name: 'voice.ogg',
      mime_type: 'audio/ogg',
      data: Buffer.from('abc').toString('base64'),
    };
    const first = await transcribeChatAudio(file, {
      db: database,
      ticketId: 42,
      transcribeImpl: async () => {
        calls += 1;
        return 'hello sqlite';
      },
    });
    assert.equal(first.text, 'hello sqlite');
    assert.equal(getChatFileExtraction(database, 9).text, 'hello sqlite');
    assert.equal(getChatFileExtraction(database, 9).kind, 'audio');
    assert.equal(getChatFileExtraction(database, 9).ticket_id, 42);

    clearTranscribeCache();
    const second = await transcribeChatAudio(file, {
      db: database,
      transcribeImpl: async () => {
        calls += 1;
        return 'ignored';
      },
    });
    assert.equal(second.text, 'hello sqlite');
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
  });

  it('does not persist transcripts without a file id', async () => {
    const database = createDb();
    const file = { name: 'voice.ogg', data: Buffer.from('abc').toString('base64') };
    await transcribeChatAudio(file, {
      db: database,
      transcribeImpl: async () => 'hello',
    });
    const count = database.prepare('SELECT COUNT(*) AS n FROM ai_chat_file_extractions').get().n;
    assert.equal(count, 0);
  });
});

describe('image caption helper', () => {
  it('persists captions in sqlite and reuses them after memory cache is cleared', async () => {
    const database = createDb();
    let calls = 0;
    let downloads = 0;
    const file = {
      id: 101,
      name: 'shot.png',
      extension: 'png',
      mime_type: 'image/png',
    };
    const first = await captionChatImage(file, {
      db: database,
      ticketId: 42,
      download: async () => {
        downloads += 1;
        return { mime: 'image/png', base64: 'abc', bytes: 3 };
      },
      captionImpl: async () => {
        calls += 1;
        return 'ошибка на экране кассы';
      },
    });
    assert.equal(first.text, 'ошибка на экране кассы');
    assert.equal(getChatFileExtraction(database, 101).kind, 'image');
    assert.equal(getChatFileExtraction(database, 101).ticket_id, 42);

    clearCaptionCache();
    const second = await captionChatImage(file, {
      db: database,
      download: async () => {
        downloads += 1;
        throw new Error('should not download');
      },
      captionImpl: async () => {
        calls += 1;
        return 'ignored';
      },
    });
    assert.equal(second.text, 'ошибка на экране кассы');
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    assert.equal(downloads, 1);
  });

  it('does not persist captions without a file id', async () => {
    const database = createDb();
    await captionChatImage(
      { name: 'shot.png', extension: 'png', mime_type: 'image/png' },
      {
        db: database,
        download: async () => ({ mime: 'image/png', base64: 'abc', bytes: 3 }),
        captionImpl: async () => 'скрин',
      }
    );
    const count = database.prepare('SELECT COUNT(*) AS n FROM ai_chat_file_extractions').get().n;
    assert.equal(count, 0);
  });
});

describe('knowledge base', () => {
  it('seeds articles, searches, updates, and deletes', async () => {
    const database = createDb();
    const seeded = listKnowledgeArticles(database);
    assert.ok(seeded.articles.length >= 2);
    const created = createKnowledgeArticle(database, {
      title: 'Тестовая статья',
      body: 'Как передать менеджеру по продажам заявку на тариф.',
      tags: 'продажи',
    });
    const found = listKnowledgeArticles(database, { query: 'менеджеру по продажам' });
    assert.ok(found.articles.some((article) => article.id === created.id));

    const tools = createKnowledgeTools({ db: database, write: true });
    const search = tools.find((tool) => tool.name === 'search_knowledge');
    const searchResult = await search.execute({ query: 'прайс' });
    assert.ok(searchResult.articles.length > 0);

    const category = createKnowledgeCategory(database, { name: 'Прайс', tags: 'цены' });
    const listCategories = tools.find((tool) => tool.name === 'list_knowledge_categories');
    const listed = await listCategories.execute();
    assert.ok(listed.categories.some((item) => item.id === category.id && item.name === 'Прайс'));

    const filtered = await search.execute({ query: 'прайс', category_id: category.id });
    assert.equal(filtered.category_id, category.id);

    const createCategory = tools.find((tool) => tool.name === 'create_category');
    const createdCategory = await createCategory.execute({ name: 'Поддержка', tags: 'help' });
    assert.equal(createdCategory.name, 'Поддержка');

    const updated = updateKnowledgeArticle(database, created.id, { title: 'Обновлено', body: created.body });
    assert.equal(updated.title, 'Обновлено');
    assert.equal(deleteKnowledgeArticle(database, created.id), true);
    assert.equal(getKnowledgeArticle(database, created.id), null);
  });

  it('passes the stored KB system prompt into runAgent', async () => {
    const database = createDb();
    savePrompt(database, 'kb', 'KB STORED PROMPT');
    let captured = null;
    const result = await runKbAgent({
      db: database,
      userId: 1,
      message: 'Найди статью про прайс',
      deps: {
        runAgent: async (args) => {
          captured = args;
          return { content: 'Нашёл.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(captured.system, 'KB STORED PROMPT');
    assert.equal(captured.messages[0].content, knowledgeCategoryContext(database));
    assert.equal(captured.promptCacheKey, `kb:${result.session_id}`);
    assert.equal(result.reply, 'Нашёл.');
  });

  it('shows live categories in search schema and agent context before tools run', async () => {
    const database = createDb();
    const prices = createKnowledgeCategory(database, { name: 'Прайс', tags: 'цены' });
    const line = knowledgeCategoryContext(database);
    assert.match(line, new RegExp(`${prices.id} Прайс`));

    const tools = createKnowledgeTools({ db: database, write: true });
    const search = tools.find((tool) => tool.name === 'search_knowledge');
    assert.match(search.description, new RegExp(`${prices.id} Прайс`));
    assert.match(search.parameters.properties.category_id.description, new RegExp(`${prices.id} Прайс`));
    assert.match(
      tools.find((tool) => tool.name === 'create_article').description,
      new RegExp(`${prices.id} Прайс`)
    );

    saveAiSettings(database, { enabled: true, testMode: false, model: 'gpt-4o-mini' });
    const preview = await previewCustomerAgentPrompt({
      db: database,
      ticketId: 42,
      deps: {
        findTicketById: async () => ({
          id: 42,
          chat_id: 'chat-42',
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
              text: 'Сколько стоит?',
              created_date: 1200,
            },
          ],
        }),
        getChatFilesByIds: async () => [],
      },
    });
    assert.equal(preview.messages[0].content, line);

    let capturedKb = null;
    await runKbAgent({
      db: database,
      userId: 1,
      message: 'Найди прайс',
      deps: {
        runAgent: async (args) => {
          capturedKb = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(capturedKb.messages[0].content, line);

    let capturedTest = null;
    await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Привет',
      deps: {
        runAgent: async (args) => {
          capturedTest = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(capturedTest.messages[0].content, line);
  });

  it('inlines uploaded images for the latest KB message', async () => {
    const database = createDb();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ).toString('base64');
    let captured = null;
    const result = await runKbAgent({
      db: database,
      userId: 3,
      message: 'Что на скрине?',
      files: [{ name: 'screen.png', extension: 'png', data: png, mime_type: 'image/png' }],
      deps: {
        runAgent: async (args) => {
          captured = args;
          return { content: 'На скрине ошибка.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });

    const last = captured.messages.at(-1);
    assert.ok(Array.isArray(last.content));
    assert.equal(last.content[0].type, 'text');
    assert.match(last.content[0].text, /screen\.png/);
    assert.equal(last.content[1].type, 'image_url');
    assert.match(last.content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(result.messages[0].files[0].name, 'screen.png');
    assert.equal(result.messages[0].files[0].kind, 'image');
    assert.match(result.messages[0].files[0].data_url, /^data:image\/png;base64,/);
  });

  it('transcribes uploaded audio for the latest KB message', async () => {
    const database = createDb();
    let captured = null;
    await runKbAgent({
      db: database,
      userId: 3,
      message: 'Что сказал клиент?',
      files: [{ name: 'voice.ogg', extension: 'ogg', data: Buffer.from('ogg').toString('base64'), mime_type: 'audio/ogg' }],
      deps: {
        transcribeChatAudio: async () => ({ text: 'касса не печатает' }),
        runAgent: async (args) => {
          captured = args;
          return { content: 'Клиент жалуется на кассу.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    const last = captured.messages.at(-1);
    assert.equal(typeof last.content, 'string');
    assert.match(last.content, /\[аудио: voice\.ogg\]/);
    assert.match(last.content, /Расшифровка: касса не печатает/);
    assert.equal(captured.model, 'gpt-4o-mini');
    assert.equal(captured.hasAudio, true);
  });
});

describe('AI browse tools', () => {
  const previousBrowseEnabled = process.env.AI_BROWSE_ENABLED;

  afterEach(() => {
    if (previousBrowseEnabled == null) delete process.env.AI_BROWSE_ENABLED;
    else process.env.AI_BROWSE_ENABLED = previousBrowseEnabled;
  });

  it('rejects SSRF and non-http URLs', () => {
    assert.throws(() => assertSafeBrowseUrl('http://127.0.0.1/'), /BLOCKED_URL/);
    assert.throws(() => assertSafeBrowseUrl('http://localhost/secret'), /BLOCKED_URL/);
    assert.throws(() => assertSafeBrowseUrl('http://192.168.1.10/'), /BLOCKED_URL/);
    assert.throws(() => assertSafeBrowseUrl('http://[::1]/'), /BLOCKED_URL/);
    assert.throws(() => assertSafeBrowseUrl('file:///etc/passwd'), /INVALID_URL/);
    assert.throws(() => assertSafeBrowseUrl('ftp://example.com'), /INVALID_URL/);
    assert.equal(assertSafeBrowseUrl('https://regos.uz/ru/price').hostname, 'regos.uz');
  });

  it('classifies portal vs public hosts and strips HTML', () => {
    assert.equal(classifyBrowseHost('sb.regos.uz'), 'regos');
    assert.equal(classifyBrowseHost('vcr1.regos.uz'), 'regos');
    assert.equal(classifyBrowseHost('my.easytrade.uz'), 'regos');
    assert.equal(classifyBrowseHost('api.chayxanshik.uz'), 'rpos');
    assert.equal(classifyBrowseHost('regos.uz'), 'public');

    const parsed = htmlToText(
      '<html><head><title>Docs</title><style>h1{}</style></head><body><script>secret()</script><p>Hello&nbsp;world</p></body></html>'
    );
    assert.equal(parsed.title, 'Docs');
    assert.match(parsed.text, /Hello world/);
    assert.doesNotMatch(parsed.text, /secret/);
  });

  it('fetches public pages via native fetch and portal pages via session GET', async () => {
    const publicPage = await browseUrl('https://example.com/docs', {
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url: String(url),
        async text() {
          return '<html><head><title>Docs</title></head><body><p>Public text</p></body></html>';
        },
      }),
    });
    assert.equal(publicPage.ok, true);
    assert.equal(publicPage.source, 'public');
    assert.equal(publicPage.title, 'Docs');
    assert.match(publicPage.text, /Public text/);

    let requested = null;
    const portalPage = await browseUrl('https://sb.regos.uz/Partners/Index', {
      getConfiguredAccounts: () => ['BUKHARA'],
      withRegosSession: async (account, fn) => {
        assert.equal(account, 'BUKHARA');
        return fn({
          get: async (url) => {
            requested = url;
            return {
              ok: () => true,
              status: () => 200,
              url: () => url,
              async text() {
                return '<html><title>Partners</title><body>Partner list</body></html>';
              },
            };
          },
        });
      },
    });
    assert.equal(requested, 'https://sb.regos.uz/Partners/Index');
    assert.equal(portalPage.source, 'regos');
    assert.equal(portalPage.title, 'Partners');
    assert.match(portalPage.text, /Partner list/);

    const blocked = await browseUrl('http://127.0.0.1/admin');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'blocked_url');
  });

  it('parses DuckDuckGo HTML search results', async () => {
    assert.equal(
      unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fregos.uz%2Fru%2Fprice'),
      'https://regos.uz/ru/price'
    );
    const parsed = parseDuckDuckGoResults(`
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fregos.uz%2Fru%2Fprice">REGOS price</a>
      <a class="result__snippet">Official tariff page</a>
      <a class="result__a" href="https://rofeev.uz/docs">Docs</a>
    `);
    assert.equal(parsed[0].url, 'https://regos.uz/ru/price');
    assert.equal(parsed[0].title, 'REGOS price');
    assert.equal(parsed[1].url, 'https://rofeev.uz/docs');

    const searched = await webSearch('regos tariff', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://html.duckduckgo.com/html/?q=regos+tariff',
        async text() {
          return '<a class="result__a" href="https://regos.uz/ru/price">REGOS price</a>';
        },
      }),
    });
    assert.equal(searched.ok, true);
    assert.equal(searched.results[0].title, 'REGOS price');
  });

  it('exposes browse tools on customer and KB agents', () => {
    delete process.env.AI_BROWSE_ENABLED;
    const database = createDb();
    const kb = createKnowledgeTools({ db: database, write: false });
    const customer = createCustomerTools({ db: database });
    assert.ok(kb.some((tool) => tool.name === 'web_search'));
    assert.ok(kb.some((tool) => tool.name === 'browse_url'));
    assert.ok(customer.some((tool) => tool.name === 'web_search'));
    assert.ok(customer.some((tool) => tool.name === 'browse_url'));

    process.env.AI_BROWSE_ENABLED = '0';
    const disabled = createKnowledgeTools({ db: database, write: false });
    assert.equal(disabled.some((tool) => tool.name === 'web_search'), false);
    assert.equal(disabled.some((tool) => tool.name === 'browse_url'), false);
  });
});

describe('employee lookup', () => {
  it('matches job title and description', () => {
    const database = createDb();
    createEmployeeUser(database, {
      phone: '+998901110001',
      displayName: 'Алишер',
      jobTitle: 'Менеджер по продажам',
      description: 'Коммерческие вопросы и тарифы. Рабочие часы 9-18.',
    });
    createEmployeeUser(database, {
      phone: '+998901110002',
      displayName: 'Дилшод',
      jobTitle: 'Техподдержка',
      description: 'Только технические вопросы.',
    });

    const sales = findEmployeesForAgent(database, { jobTitle: 'менеджер по продажам' });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].display_name, 'Алишер');
    assert.match(sales[0].description, /тарифы/);

    const byQuery = findEmployeesForAgent(database, { query: 'технические' });
    assert.equal(byQuery.length, 1);
    assert.equal(byQuery[0].display_name, 'Дилшод');
  });
});

describe('notify group topic', () => {
  const {
    loadAgentGroupConfig,
    listAgentGroupTopics,
    notifyGroupTopic,
  } = require('../src/ai/tools/notify-group');

  function configureGroup(database) {
    return saveAiSettings(database, {
      groupChatId: '-1001234567890',
      groupTopics: [
        { key: 'urgent', id: 123, name: 'Срочная помощь', when: 'клиент не может работать' },
        { key: 'kkm', id: 456, name: 'KKM' },
      ],
    });
  }

  it('returns null config but still exposes group tools', async () => {
    const database = createDb();
    assert.equal(loadAgentGroupConfig(database), null);
    const tools = createCustomerTools({ db: database });
    const list = tools.find((tool) => tool.name === 'list_group_topics');
    const send = tools.find((tool) => tool.name === 'send_group_topic_message');
    assert.ok(list);
    assert.ok(send);
    const listed = await list.execute();
    assert.equal(listed.ok, false);
    assert.equal(listed.error, 'not_configured');
    const sent = await send.execute({ topic_key: 'urgent', message: 'hello' });
    assert.equal(sent.ok, false);
    assert.equal(sent.error, 'not_configured');
  });

  it('lists allowlisted topics without thread ids', async () => {
    const database = createDb();
    configureGroup(database);
    const listed = listAgentGroupTopics(database);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.topics, [
      { key: 'urgent', name: 'Срочная помощь', when: 'клиент не может работать' },
      { key: 'kkm', name: 'KKM', when: null },
    ]);
    const tools = createCustomerTools({ db: database });
    const list = tools.find((tool) => tool.name === 'list_group_topics');
    const result = await list.execute();
    assert.equal(result.topics.some((topic) => 'id' in topic), false);
  });

  it('sends to the topic thread and rejects unknown or empty payloads', async () => {
    const database = createDb();
    configureGroup(database);
    const sent = [];
    const ok = await notifyGroupTopic(database, {
      topicKey: 'Urgent',
      message: 'Касса не открывается',
      ticketId: 42,
      sendTelegram: async (chatId, body, options) => {
        sent.push({ chatId, body, options });
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.topic_key, 'urgent');
    assert.equal(ok.topic_name, 'Срочная помощь');
    assert.equal(sent[0].chatId, '-1001234567890');
    assert.equal(sent[0].options.message_thread_id, 123);
    assert.match(sent[0].body, /Касса не открывается/);
    assert.match(sent[0].body, /тикет #42/);

    const unknown = await notifyGroupTopic(database, {
      topicKey: 'missing',
      message: 'hello',
      sendTelegram: async () => {
        throw new Error('must not send');
      },
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'unknown_topic');

    const empty = await notifyGroupTopic(database, {
      topicKey: 'kkm',
      message: '   ',
      sendTelegram: async () => {
        throw new Error('must not send');
      },
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, 'empty_message');
  });
});

describe('customer test agent', () => {
  it('exposes ai_customer_test permission and user_rights column', () => {
    const database = createDb();
    assert.ok(RIGHTS.ai_customer_test);
    assert.equal(DEFAULT_RIGHTS.ai_customer_test, 0);
    assert.ok(ADMIN_PERMISSION_KEYS.includes('ai_customer_test'));
    const cols = database.prepare('PRAGMA table_info(user_rights)').all();
    assert.ok(cols.some((col) => col.name === 'ai_customer_test'));
  });

  it('runs a sandbox reply without notifying employees or assigning tickets', async () => {
    const database = createDb();
    saveAiSettings(database, { enabled: false, model: 'gpt-4o-mini' });
    let notified = false;
    let assigned = false;
    let closed = false;
    const result = await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Сколько стоит техподдержка?',
      ticketId: 42,
      clientPhone: '+998901112233',
      deps: {
        findTicketById: async (id) => ({
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
        runAgent: async ({ tools, messages }) => {
          const notify = tools.find((tool) => tool.name === 'notify_employee');
          const assign = tools.find((tool) => tool.name === 'assign_responsible');
          const close = tools.find((tool) => tool.name === 'close_ticket');
          const notifyResult = await notify.execute({ employee_id: 7, message: 'Нужен менеджер' });
          const assignResult = await assign.execute({ regos_user_id: 31 });
          const closeResult = await close.execute();
          assert.equal(notifyResult.ok, true);
          assert.equal(assignResult.ok, true);
          assert.equal(closeResult.ok, true);
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
        runAgent: async ({ tools }) => {
          const list = tools.find((tool) => tool.name === 'list_group_topics');
          const send = tools.find((tool) => tool.name === 'send_group_topic_message');
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
        findTicketById: async (id) => ({
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
    let captured = null;
    await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Привет',
      deps: {
        runAgent: async (args) => {
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
    let captured = null;
    const result = await runCustomerTestAgent({
      db: database,
      userId: 4,
      message: '',
      files: [{ name: 'photo.png', extension: 'png', data: png, mime_type: 'image/png' }],
      deps: {
        runAgent: async (args) => {
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
  });
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
        findTicketById: async (id) => ({
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
        runAgent: async ({ tools, system, promptCacheKey }) => {
          assert.match(system, /песочница/i);
          assert.match(promptCacheKey, /^employee_test:/);
          const replyTool = tools.find((tool) => tool.name === 'reply_to_customer');
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
  });
});

describe('ticket AI assist agent', () => {
  function assistTicket(overrides = {}) {
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

  function assistDeps(overrides = {}) {
    return {
      findTicketById: async (id) => assistTicket({ id: Number(id) }),
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
    let captured = null;
    const result = await runTicketAssistAgent({
      db: database,
      userId: 7,
      ticketId: 42,
      message: 'Назови цену 450 тысяч и предложи акцию',
      deps: {
        ...assistDeps(),
        runAgent: async (args) => {
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
    assert.ok(captured.messages[0].content.includes(knowledgeCategoryContext(database)));
    assert.equal(captured.messages.at(-1).content, 'Назови цену 450 тысяч и предложи акцию');
    assert.equal(captured.promptCacheKey, 'customer_assist:42');
    assert.ok(captured.tools.some((tool) => tool.name === 'reply_to_customer'));
    assert.ok(captured.tools.some((tool) => tool.name === 'notify_employee'));
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
    const posted = [];
    try {
      const result = await runTicketAssistAgent({
        db: database,
        userId: 3,
        ticketId: 42,
        message: 'Ответь клиенту, что лицензия 450 000 сум',
        deps: {
          ...assistDeps({
            addTicketMessage: async (payload) => {
              posted.push(payload);
              return { ok: true, id: 'sent-1' };
            },
          }),
          runAgent: async ({ tools }) => {
            const replyTool = tools.find((tool) => tool.name === 'reply_to_customer');
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
});

describe('webhook customer hook', () => {
  it('schedules the customer agent on ChatMessageAdded when db is present', async () => {
    const database = createDb();
    const scheduled = [];
    const handled = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      schedule: (task) => scheduled.push(task),
      handleCustomerMessage: async (args) => {
        handled.push(args);
        return { handled: false, reason: 'disabled' };
      },
      publish: () => {},
    });

    await handler({
      event_id: `ai-hook-${process.pid}`,
      occurred_at: '2026-08-13T10:00:00Z',
      connected_integration_id: 'integration-1',
      data: {
        action: 'ChatMessageAdded',
        data: { id: 'msg-9', chat_id: 'chat-uuid-9', author_entity_type: 'Client' },
      },
    });

    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(handled[0].chatId, 'chat-uuid-9');
    assert.equal(handled[0].messageId, 'msg-9');
  });

  it('does not schedule the customer agent for staff ChatMessageAdded events', async () => {
    const scheduled = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: {},
      schedule: (task) => scheduled.push(task),
      handleCustomerMessage: async () => {
        throw new Error('must not run');
      },
      publish: () => {},
    });

    await handler({
      event_id: `ai-hook-user-${process.pid}`,
      occurred_at: '2026-08-13T10:00:00Z',
      connected_integration_id: 'integration-1',
      data: {
        action: 'ChatMessageAdded',
        data: {
          id: 'msg-10',
          chat_id: 'chat-uuid-9',
          author_entity_type: 'User',
          author_entity_id: 7,
        },
      },
    });

    assert.equal(scheduled.length, 0);
  });

  it('schedules the customer agent for system ChatMessageAdded events', async () => {
    const database = createDb();
    const scheduled = [];
    const handled = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      schedule: (task) => scheduled.push(task),
      handleCustomerMessage: async (args) => {
        handled.push(args);
        return { handled: false, reason: 'not-regular' };
      },
      publish: () => {},
    });

    await handler({
      event_id: `ai-hook-system-${process.pid}`,
      occurred_at: '2026-08-14T03:32:00Z',
      connected_integration_id: 'integration-1',
      data: {
        action: 'ChatMessageAdded',
        data: {
          id: 'sys-created',
          chat_id: 'chat-uuid-9',
          message_type: 'System',
          action_code: 'TicketCreated',
        },
      },
    });

    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(handled[0].chatId, 'chat-uuid-9');
    assert.equal(handled[0].messageId, 'sys-created');
    assert.equal(handled[0].payload.message_type, 'System');
  });

  it('schedules ticket summarization when a ticket is closed', async () => {
    const database = createDb();
    const scheduled = [];
    const summarized = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      findTicket: async (id) => ({
        id,
        status: 'Closed',
        chat_id: 'chat-42',
        created_date: 1000,
        resolved_date: 2000,
        client_id: 7,
      }),
      resolveRecordingCache: async () => null,
      schedule: (task) => scheduled.push(task),
      summarizeClosedTicket: async (args) => {
        summarized.push(args);
        return { skipped: false };
      },
      publish: () => {},
    });

    await handler({
      event_id: `ai-summary-closed-${process.pid}`,
      occurred_at: '2026-08-13T10:00:00Z',
      connected_integration_id: 'integration-1',
      data: { action: 'TicketClosed', data: { id: 42 } },
    });

    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.equal(summarized[0].ticket.id, 42);
    assert.equal(summarized[0].occurredAt, '2026-08-13T10:00:00Z');
  });

  it('does not summarize an open TicketStatusSet event', async () => {
    const database = createDb();
    const scheduled = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      findTicket: async (id) => ({ id, status: 'Open' }),
      resolveRecordingCache: async () => null,
      schedule: (task) => scheduled.push(task),
      summarizeClosedTicket: async () => {
        throw new Error('must not summarize');
      },
      publish: () => {},
    });

    await handler({
      event_id: `ai-summary-open-${process.pid}`,
      occurred_at: '2026-08-13T10:00:00Z',
      connected_integration_id: 'integration-1',
      data: { action: 'TicketStatusSet', data: { id: 42 } },
    });

    assert.equal(scheduled.length, 0);
  });
});
