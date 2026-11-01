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

  it('forces reasoning_effort none for gpt-5.6 function tools on chat completions', () => {
    const tool = {
      name: 'search_tasks',
      description: 'Search tasks',
      parameters: { type: 'object', properties: {} },
    };
    const blocked = buildChatRequest({
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      reasoningEffort: 'high',
    });
    assert.equal(blocked.reasoning_effort, 'none');
    assert.equal(blocked.tools.length, 1);

    const terra = buildChatRequest({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      reasoningEffort: 'low',
    });
    assert.equal(terra.reasoning_effort, 'none');

    const withoutTools = buildChatRequest({
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
    });
    assert.equal(withoutTools.reasoning_effort, 'low');

    const olderGpt5 = buildChatRequest({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      reasoningEffort: 'medium',
    });
    assert.equal(olderGpt5.reasoning_effort, 'medium');
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
    assert.equal((second as any).cached, true);
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
    assert.equal(getChatFileExtraction(database, 9)!.text, 'hello sqlite');
    assert.equal(getChatFileExtraction(database, 9)!.kind, 'audio');
    assert.equal(getChatFileExtraction(database, 9)!.ticket_id, 42);

    clearTranscribeCache();
    const second = await transcribeChatAudio(file, {
      db: database,
      transcribeImpl: async () => {
        calls += 1;
        return 'ignored';
      },
    });
    assert.equal(second.text, 'hello sqlite');
    assert.equal((second as any).cached, true);
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
    assert.equal(getChatFileExtraction(database, 101)!.kind, 'image');
    assert.equal(getChatFileExtraction(database, 101)!.ticket_id, 42);

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
    assert.equal((second as any).cached, true);
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
    assert.ok(found.articles.some((article?: any) => article.id === created!.id));

    const tools = createKnowledgeTools({ db: database, write: true });
    const search = tools.find((tool?: any) => tool.name === 'search_knowledge');
    const searchResult = await search!.execute({ query: 'прайс' });
    assert.ok(searchResult.articles.length > 0);

    const category = createKnowledgeCategory(database, { name: 'Прайс', tags: 'цены' });
    const listCategories = tools.find((tool?: any) => tool.name === 'list_knowledge_categories');
    const listed = await listCategories!.execute();
    assert.ok(listed.categories.some((item?: any) => item.id === category!.id && item.name === 'Прайс'));

    const filtered = await search!.execute({ query: 'прайс', category_id: category!.id });
    assert.equal(filtered.category_id, category!.id);

    const createCategory = tools.find((tool?: any) => tool.name === 'create_category');
    const createdCategory = await createCategory!.execute({ name: 'Поддержка', tags: 'help' });
    assert.equal(createdCategory.name, 'Поддержка');

    const updated = updateKnowledgeArticle(database, created!.id, { title: 'Обновлено', body: created!.body });
    assert.equal(updated!.title, 'Обновлено');
    assert.equal(deleteKnowledgeArticle(database, created!.id), true);
    assert.equal(getKnowledgeArticle(database, created!.id), null);
  });

  it('hides unconfirmed articles from agent search and get tools', async () => {
    const database = createDb();
    const draft = createKnowledgeArticle(database, {
      title: 'Unconfirmed xyzzykbdraft article',
      body: 'This xyzzykbdraft body must stay hidden from agents.',
      tags: 'xyzzykbdraft',
    });
    const tools = createKnowledgeTools({ db: database, write: true });
    const search = tools.find((tool?: any) => tool.name === 'search_knowledge');
    const get = tools.find((tool?: any) => tool.name === 'get_article');

    const hiddenSearch = await search!.execute({ query: 'xyzzykbdraft' });
    assert.ok(!hiddenSearch.articles.some((article?: any) => article.id === draft!.id));
    const hiddenGet = await get!.execute({ id: draft!.id });
    assert.equal(hiddenGet.ok, false);
    assert.equal(hiddenGet.error, 'not_found');

    setKnowledgeArticleConfirmed(database, draft!.id, true);
    const visibleSearch = await search!.execute({ query: 'xyzzykbdraft' });
    assert.ok(visibleSearch.articles.some((article?: any) => article.id === draft!.id));
    const visibleGet = await get!.execute({ id: draft!.id });
    assert.equal(visibleGet.id, draft!.id);
    assert.equal(visibleGet.is_confirmed, true);
  });

  it('passes the stored KB system prompt into runAgent', async () => {
    const database = createDb();
    savePrompt(database, 'kb', 'KB STORED PROMPT');
    let captured: any = null;
    const result = await runKbAgent({
      db: database,
      userId: 1,
      message: 'Найди статью про прайс',
      deps: {
        runAgent: async (args?: any) => {
          captured = args;
          return { content: 'Нашёл.', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(captured.system, 'KB STORED PROMPT');
    assert.equal(captured.messages[0].content, 'Найди статью про прайс');
    assert.equal(captured.promptCacheKey, `kb:${result.session_id}`);
    assert.equal(result.reply, 'Нашёл.');
  });

  it('shows live categories in knowledge tool schemas, not user messages', async () => {
    const database = createDb();
    const prices = createKnowledgeCategory(database, { name: 'Прайс', tags: 'цены' });
    const line = knowledgeCategoryContext(database);
    assert.match(line, new RegExp(`${prices!.id} Прайс`));

    const tools = createKnowledgeTools({ db: database, write: true });
    const search = tools.find((tool?: any) => tool.name === 'search_knowledge');
    assert.match(search!.description, new RegExp(`${prices!.id} Прайс`));
    assert.match(search!.parameters.properties.category_id.description, new RegExp(`${prices!.id} Прайс`));
    assert.match(
      tools!.find((tool?: any) => tool.name === 'create_article').description,
      new RegExp(`${prices!.id} Прайс`)
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
    assert.equal(preview.messages[0].content, 'Сколько стоит?');
    assert.ok(!preview.messages.some((item?: any) => String(item.content).includes(line)));

    let capturedKb: any = null;
    await runKbAgent({
      db: database,
      userId: 1,
      message: 'Найди прайс',
      deps: {
        runAgent: async (args?: any) => {
          capturedKb = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(capturedKb.messages[0].content, 'Найди прайс');
    assert.ok(!capturedKb.messages.some((item?: any) => String(item.content).includes(line)));

    let capturedTest: any = null;
    await runCustomerTestAgent({
      db: database,
      userId: 1,
      message: 'Привет',
      deps: {
        runAgent: async (args?: any) => {
          capturedTest = args;
          return { content: 'Ок', steps: 1 };
        },
        provider: { async chat() { return { content: 'unused', toolCalls: [] }; } },
      },
    });
    assert.equal(capturedTest.messages[0].content, 'Привет');
    assert.ok(!capturedTest.messages.some((item?: any) => String(item.content).includes(line)));
  });

  it('inlines uploaded images for the latest KB message', async () => {
    const database = createDb();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ).toString('base64');
    let captured: any = null;
    const result = await runKbAgent({
      db: database,
      userId: 3,
      message: 'Что на скрине?',
      files: [{ name: 'screen.png', extension: 'png', data: png, mime_type: 'image/png' }],
      deps: {
        runAgent: async (args?: any) => {
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
    assert.equal(result!.messages[0]!.files[0].name, 'screen.png');
    assert.equal(result!.messages[0]!.files[0].kind, 'image');
    assert.match(result!.messages[0]!.files[0].data_url, /^data:image\/png;base64,/);
  });

  it('transcribes uploaded audio for the latest KB message', async () => {
    const database = createDb();
    let captured: any = null;
    await runKbAgent({
      db: database,
      userId: 3,
      message: 'Что сказал клиент?',
      files: [{ name: 'voice.ogg', extension: 'ogg', data: Buffer.from('ogg').toString('base64'), mime_type: 'audio/ogg' }],
      deps: {
        transcribeChatAudio: async () => ({ text: 'касса не печатает' }),
        runAgent: async (args?: any) => {
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
