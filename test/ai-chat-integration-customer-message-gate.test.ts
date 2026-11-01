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

  it('skips listed customer messages and still handles other text', () => {
    const settings = { enabled: true, ignoredCustomerMessages: ['/start'] };
    assert.equal(
      evaluateCustomerMessageGate({
        settings,
        message: { ...clientMessage, text: ' /START ' },
      }).reason,
      'ignored-message'
    );
    assert.equal(
      evaluateCustomerMessageGate({
        settings,
        message: { ...clientMessage, text: '', display_text: '/start' },
      }).reason,
      'ignored-message'
    );
    assert.equal(
      evaluateCustomerMessageGate({
        settings,
        message: { ...clientMessage, text: 'Сколько стоит?' },
      }).handle,
      true
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

  it('skips when the ticket reply cap is already reached', () => {
    const database = createDb();
    incrementCustomerReplyCount(database, 7);
    const settings = { enabled: true, customerRepliesPerTicket: 1, customerRepliesPerHour: 0 };
    assert.equal(
      evaluateCustomerMessageGateWithDb(database, {
        settings,
        message: clientMessage,
        ticket: { id: 7, status: 'Open', client_id: 15 },
      }).reason,
      'ticket-cap'
    );
  });

  it('skips when the hourly client cap is already reached', () => {
    const database = createDb();
    const ticket = { id: 8, status: 'Open', client_id: 22 };
    const settings = { enabled: true, customerRepliesPerTicket: 0, customerRepliesPerHour: 2 };
    recordCustomerUsage(database, {
      ticketId: 8,
      clientKey: resolveCustomerUsageKey(ticket, 'chat-8'),
    });
    recordCustomerUsage(database, {
      ticketId: 9,
      clientKey: resolveCustomerUsageKey(ticket, 'chat-8'),
    });
    assert.equal(
      evaluateCustomerMessageGateWithDb(database, {
        settings,
        message: clientMessage,
        ticket,
        chatId: 'chat-8',
      }).reason,
      'rate-limit'
    );
  });
});
