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


describe('AI settings', () => {
  it('defaults to disabled OpenAI gpt-4o-mini and persists toggles', () => {
    const database = createDb();
    const initial = loadAiSettings(database);
    assert.equal(initial.enabled, false);
    assert.equal(initial.testMode, false);
    assert.equal(initial.provider, 'openai');
    assert.equal(initial.model, 'gpt-4o-mini');
    assert.equal(initial.historyLimit, 30);
    assert.equal(initial.customerRepliesPerHour, 8);
    assert.equal(initial.customerRepliesPerTicket, 20);

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
    assert.equal(serializeAiSettings(saved).customer_replies_per_hour, 8);
    assert.equal(serializeAiSettings(saved).customer_replies_per_ticket, 20);
    assert.equal(serializeAiSettings(saved).customer_replies_per_hour_min, 0);
    assert.equal(serializeAiSettings(saved).customer_replies_per_hour_max, 500);
    assert.equal(serializeAiSettings(saved).models.includes('gpt-4o'), true);
    assert.ok(serializeAiSettings(saved).models.includes('gpt-5'));
    assert.ok(serializeAiSettings(saved).transcribe_models.includes('whisper-1'));
    assert.equal(initial.transcribeModel, 'gpt-4o-transcribe');
    assert.equal(initial.reasoningEffort, '');
    assert.deepEqual(initial.agentModels, {
      customer: '',
      customer_assist: '',
      kb: '',
      ops: '',
      ticket_summary: '',
    });
    assert.deepEqual(initial.agentMaxSteps, {
      customer: '',
      customer_assist: '',
      kb: '',
      ops: '',
      ticket_summary: '',
    });
    assert.equal(resolveAgentMaxSteps(initial, 'customer'), 8);
    assert.equal(resolveAgentMaxSteps(initial, 'ops'), 8);
    assert.equal(serializeAiSettings(saved).agent_max_steps_default, 8);
    assert.equal(serializeAiSettings(saved).agent_max_steps_min, 1);
    assert.equal(serializeAiSettings(saved).agent_max_steps_max, 50);
    assert.equal(initial.groupChatId, '');
    assert.deepEqual(initial.groupTopics, []);
    assert.deepEqual(initial.ignoredCustomerMessages, []);
    assert.equal(serializeAiSettings(saved).group_chat_id, '');
    assert.deepEqual(serializeAiSettings(saved).group_topics, []);
    assert.equal(serializeAiSettings(saved).group_topics_max, 30);
    assert.deepEqual(serializeAiSettings(saved).ignored_customer_messages, []);
    assert.equal(serializeAiSettings(saved).ignored_customer_messages_max, 50);
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

  it('persists customer reply caps and treats 0 as unlimited', () => {
    const database = createDb();
    const saved = saveAiSettings(database, {
      customerRepliesPerHour: 0,
      customerRepliesPerTicket: 3,
    });
    assert.equal(saved.customerRepliesPerHour, 0);
    assert.equal(saved.customerRepliesPerTicket, 3);
    assert.equal(serializeAiSettings(saved).customer_replies_per_hour, 0);
    assert.equal(serializeAiSettings(saved).customer_replies_per_ticket, 3);
    saveAiSettings(database, { enabled: true });
    assert.equal(loadAiSettings(database).customerRepliesPerHour, 0);
    assert.equal(loadAiSettings(database).customerRepliesPerTicket, 3);
  });

  it('rejects an out-of-range customer reply cap', () => {
    const database = createDb();
    assert.throws(
      () => saveAiSettings(database, { customerRepliesPerHour: -1 }),
      /INVALID_AI_CUSTOMER_REPLY_LIMIT/
    );
    assert.throws(
      () => saveAiSettings(database, { customerRepliesPerTicket: 501 }),
      /INVALID_AI_CUSTOMER_REPLY_LIMIT/
    );
    assert.throws(
      () => saveAiSettings(database, { customerRepliesPerHour: 1.5 }),
      /INVALID_AI_CUSTOMER_REPLY_LIMIT/
    );
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

  it('persists per-agent max steps and resolves the default', () => {
    const database = createDb();
    const saved = saveAiSettings(database, {
      agentMaxSteps: { customer: 12, kb: 3 },
    });
    assert.equal(saved.agentMaxSteps.customer, 12);
    assert.equal(saved.agentMaxSteps.kb, 3);
    assert.equal(saved.agentMaxSteps.ops, '');
    assert.equal(resolveAgentMaxSteps(saved, 'customer'), 12);
    assert.equal(resolveAgentMaxSteps(saved, 'kb'), 3);
    assert.equal(resolveAgentMaxSteps(saved, 'ops'), 8);
    assert.equal(resolveAgentMaxSteps(saved, 'ticket_summary'), 8);
    const serialized = serializeAiSettings(saved);
    assert.equal(serialized.agent_max_steps.customer, 12);
    assert.equal(serialized.agent_max_steps.kb, 3);
    assert.equal(serialized.agent_max_steps.ops, '');
    assert.equal(serialized.agent_max_steps_default, 8);

    saveAiSettings(database, { enabled: true });
    const reloaded = loadAiSettings(database);
    assert.equal(reloaded.agentMaxSteps.customer, 12);
    assert.equal(reloaded.agentMaxSteps.kb, 3);
    assert.equal(reloaded.agentMaxSteps.ops, '');
  });

  it('rejects invalid per-agent max steps', () => {
    const database = createDb();
    assert.throws(() => saveAiSettings(database, { agentMaxSteps: { customer: 0 } }), /INVALID_AI_AGENT_MAX_STEPS/);
    assert.throws(() => saveAiSettings(database, { agentMaxSteps: { kb: 51 } }), /INVALID_AI_AGENT_MAX_STEPS/);
    assert.throws(() => saveAiSettings(database, { agentMaxSteps: { ops: 1.5 } }), /INVALID_AI_AGENT_MAX_STEPS/);
    assert.throws(() => saveAiSettings(database, { agentMaxSteps: { customer: 'many' } }), /INVALID_AI_AGENT_MAX_STEPS/);
    assert.throws(() => saveAiSettings(database, { agentMaxSteps: [] }), /INVALID_AI_AGENT_MAX_STEPS/);
  });

  it('rejects invalid transcribe model and reasoning effort', () => {
    const database = createDb();
    assert.throws(
      () => saveAiSettings(database, { transcribeModel: 'x'.repeat(81) }),
      /INVALID_AI_TRANSCRIBE_MODEL/
    );
    assert.throws(() => saveAiSettings(database, { reasoningEffort: 'max' }), /INVALID_AI_REASONING_EFFORT/);
  });

  it('persists ignored customer messages', () => {
    const database = createDb();
    const saved = saveAiSettings(database, {
      ignoredCustomerMessages: [' /start ', '/START', '', 'Спасибо'],
    });
    assert.deepEqual(saved.ignoredCustomerMessages, ['/start', 'Спасибо']);
    const serialized = serializeAiSettings(saved);
    assert.deepEqual(serialized.ignored_customer_messages, ['/start', 'Спасибо']);
    assert.equal(serialized.ignored_customer_messages_max, 50);

    saveAiSettings(database, { enabled: true });
    assert.deepEqual(loadAiSettings(database).ignoredCustomerMessages, ['/start', 'Спасибо']);

    saveAiSettings(database, { ignoredCustomerMessages: [] });
    assert.deepEqual(loadAiSettings(database).ignoredCustomerMessages, []);
  });

  it('rejects invalid ignored customer messages', () => {
    const database = createDb();
    assert.throws(
      () => saveAiSettings(database, { ignoredCustomerMessages: { text: '/start' } }),
      /INVALID_AI_IGNORED_CUSTOMER_MESSAGES/
    );
    assert.throws(
      () => saveAiSettings(database, { ignoredCustomerMessages: ['a'.repeat(201)] }),
      /INVALID_AI_IGNORED_CUSTOMER_MESSAGES/
    );
    assert.throws(
      () => saveAiSettings(database, { ignoredCustomerMessages: Array.from({ length: 51 }, (_?: any, i?: any) => `msg-${i}`) }),
      /INVALID_AI_IGNORED_CUSTOMER_MESSAGES/
    );
  });
});

describe('AI prompts', () => {
  it('resolves defaults, saves, and resets', () => {
    const database = createDb();
    const listed = listPrompts(database);
    assert.equal(listed.length, 5);
    const customerType = listed.find((item?: any) => item.slug === 'customer');
    assert.equal(customerType!.active_id, null);
    assert.equal(customerType!.prompts[0].is_default, true);
    assert.equal(customerType!.prompts[0].is_active, true);
    assert.equal(customerType!.prompts[0].name, DEFAULT_PROMPT_NAME);
    assert.equal(listed!.find((item?: any) => item.slug === 'customer_assist')!.title, 'Агент поддержки (сотрудник)');
    assert.equal(listed!.find((item?: any) => item.slug === 'kb')!.title, 'База знаний');
    assert.equal(listed!.find((item?: any) => item.slug === 'ops')!.title, 'Задачи');
    assert.equal(listed!.find((item?: any) => item.slug === 'ticket_summary')!.title, 'Сводка обращения');
    assert.equal(getResolvedPrompt(database, 'ticket_summary'), TICKET_SUMMARY_SYSTEM_PROMPT);
    assert.equal(getResolvedPrompt(database, 'customer'), CUSTOMER_SYSTEM_PROMPT);
    assert.equal(getResolvedPrompt(database, 'customer_assist'), CUSTOMER_ASSIST_PROMPT_SUFFIX);
    assert.equal(getResolvedPrompt(database, 'kb'), KB_SYSTEM_PROMPT);
    assert.equal(getResolvedPrompt(database, 'ops'), OPS_SYSTEM_PROMPT);

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
    const afterDelete = listPrompts(database).find((item?: any) => item.slug === 'customer');
    assert.equal(afterDelete!.active_id, null);
    assert.equal(afterDelete!.prompts.length, 1);
    assert.equal(afterDelete!.prompts[0].is_default, true);

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
    const listed = listPrompts(database).find((item?: any) => item.slug === 'customer');
    assert.equal(listed!.prompts.length, 2);
    assert.equal(listed!.prompts[1].is_active, true);
    assert.equal(listed!.prompts[1].body, 'Старый сохранённый промпт');
    assert.equal(getResolvedPrompt(database, 'kb'), KB_SYSTEM_PROMPT);
  });
});
