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
      fetchImpl: async (url?: any) => ({
        ok: true,
        status: 200,
        url: String(url),
        async text() {
          return '<html><head><title>Docs</title></head><body><p>Public text</p></body></html>';
        },
      }),
    });
    assert.equal(publicPage.ok, true);
    assert.equal((publicPage as any).source, 'public');
    assert.equal((publicPage as any).title, 'Docs');
    assert.match((publicPage as any).text, /Public text/);

    let requested: any = null;
    const portalPage = await browseUrl('https://sb.regos.uz/Partners/Index', {
      getConfiguredAccounts: () => ['BUKHARA'],
      withRegosSession: async (account?: any, fn?: any) => {
        assert.equal(account, 'BUKHARA');
        return fn({
          get: async (url?: any) => {
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
    assert.equal((portalPage as any).source, 'regos');
    assert.equal((portalPage as any).title, 'Partners');
    assert.match((portalPage as any).text, /Partner list/);

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
    assert.equal(searched!.results![0].title, 'REGOS price');
  });

  it('exposes browse tools on customer and KB agents', () => {
    delete process.env.AI_BROWSE_ENABLED;
    const database = createDb();
    const kb = createKnowledgeTools({ db: database, write: false });
    const customer = createCustomerTools({ db: database });
    assert.ok(kb.some((tool?: any) => tool.name === 'web_search'));
    assert.ok(kb.some((tool?: any) => tool.name === 'browse_url'));
    assert.ok(customer.some((tool?: any) => tool.name === 'web_search'));
    assert.ok(customer.some((tool?: any) => tool.name === 'browse_url'));

    process.env.AI_BROWSE_ENABLED = '0';
    const disabled = createKnowledgeTools({ db: database, write: false });
    assert.equal(disabled.some((tool?: any) => tool.name === 'web_search'), false);
    assert.equal(disabled.some((tool?: any) => tool.name === 'browse_url'), false);
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
    assert.equal(sales![0]!.display_name, 'Алишер');
    assert.match(sales![0]!.description, /тарифы/);

    const byQuery = findEmployeesForAgent(database, { query: 'технические' });
    assert.equal(byQuery.length, 1);
    assert.equal(byQuery![0]!.display_name, 'Дилшод');
  });
});

describe('notify group topic', () => {
  const {
    loadAgentGroupConfig,
    listAgentGroupTopics,
    notifyGroupTopic,
  } = (require('../src/ai/tools/notify-group') as typeof import('../src/ai/tools/notify-group'));

  function configureGroup(database?: any) {
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
    const list = tools.find((tool?: any) => tool.name === 'list_group_topics');
    const send = tools.find((tool?: any) => tool.name === 'send_group_topic_message');
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
    const list = tools.find((tool?: any) => tool.name === 'list_group_topics');
    const result = await list!.execute();
    assert.equal(result.topics.some((topic?: any) => 'id' in topic), false);
  });

  it('sends to the topic thread and rejects unknown or empty payloads', async () => {
    const database = createDb();
    configureGroup(database);
    const sent: any[] = [];
    const ok = await notifyGroupTopic(database, {
      topicKey: 'Urgent',
      message: 'Касса не открывается',
      ticketId: 42,
      sendTelegram: async (chatId?: any, body?: any, options?: any) => {
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
