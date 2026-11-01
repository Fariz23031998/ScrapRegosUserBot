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


describe('webhook customer hook', () => {
  it('schedules the customer agent on ChatMessageAdded when db is present', async () => {
    const database = createDb();
    const scheduled: any[] = [];
    const handled: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      schedule: (task?: any) => scheduled.push(task),
      handleCustomerMessage: async (args?: any) => {
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
    const scheduled: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: {},
      schedule: (task?: any) => scheduled.push(task),
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
    const scheduled: any[] = [];
    const handled: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      schedule: (task?: any) => scheduled.push(task),
      handleCustomerMessage: async (args?: any) => {
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
    const scheduled: any[] = [];
    const summarized: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      findTicket: async (id?: any) => ({
        id,
        status: 'Closed',
        chat_id: 'chat-42',
        created_date: 1000,
        resolved_date: 2000,
        client_id: 7,
      }),
      resolveRecordingCache: async () => null,
      schedule: (task?: any) => scheduled.push(task),
      summarizeClosedTicket: async (args?: any) => {
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
    const scheduled: any[] = [];
    const handler = createRegosTicketWebhookHandler({
      connectedIntegrationId: 'integration-1',
      db: database,
      findTicket: async (id?: any) => ({ id, status: 'Open' }),
      resolveRecordingCache: async () => null,
      schedule: (task?: any) => scheduled.push(task),
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
