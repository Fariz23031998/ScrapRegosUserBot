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
      async chat({ tools }: Unchecked) {
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
          execute: async ({ value }: Unchecked) => ({ echo: value }),
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
    const keys: any[] = [];
    const provider = {
      async chat({ promptCacheKey }: Unchecked) {
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
    let secondMessages: any = null;
    const imagePart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aaa' },
    };
    const provider = {
      async chat({ messages }: Unchecked) {
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
    const toolMsg = secondMessages.find((message?: any) => message.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(JSON.parse(toolMsg.content).ok, true);
    assert.equal(JSON.parse(toolMsg.content)._visionParts, undefined);
    const visionMsg = secondMessages.find(
      (message?: any) => message.role === 'user' && Array.isArray(message.content)
    );
    assert.ok(visionMsg);
    assert.equal(visionMsg.content[0].type, 'text');
    assert.deepEqual(visionMsg.content[1], imagePart);
  });

  it('forwards onDelta into provider.chat', async () => {
    const seen: any[] = [];
    const provider = {
      async chat({ onDelta }: Unchecked) {
        assert.equal(typeof onDelta, 'function');
        onDelta('Hel');
        onDelta('lo');
        return { content: 'Hello', toolCalls: [] };
      },
    };
    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (text?: any) => seen.push(text),
    });
    assert.equal(result.content, 'Hello');
    assert.deepEqual(seen, ['Hel', 'lo']);
  });

  it('stops the tool loop at maxSteps', async () => {
    let chats = 0;
    const provider = {
      async chat() {
        chats += 1;
        return {
          content: '',
          toolCalls: [{ id: `call-${chats}`, name: 'ping', arguments: '{}' }],
        };
      },
    };
    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'loop' }],
      maxSteps: 2,
      tools: [{ name: 'ping', execute: async () => ({ ok: true }) }],
    });
    assert.equal(chats, 2);
    assert.equal(result.content, '');
    assert.equal(result.steps, 2);
    assert.equal(result.stopped, 'max_steps');
  });

  it('applies the abort timeout per LLM step', async () => {
    const sleep = (ms: any, signal: AbortSignal) =>
      new Promise<any>((resolve?: any, reject?: any) => {
        const timer = setTimeout(resolve, ms);
        if (!signal) return;
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });

    let step = 0;
    const provider = {
      async chat({ signal }: { signal: AbortSignal }) {
        step += 1;
        await sleep(80, signal);
        if (step === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'ping', arguments: '{}' }],
          };
        }
        return { content: 'done', toolCalls: [] };
      },
    };

    const result = await runAgent({
      provider,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'loop' }],
      timeoutMs: 120,
      tools: [{ name: 'ping', execute: async () => ({ ok: true }) }],
    });
    assert.equal(result.content, 'done');
    assert.equal(result.steps, 2);
  });

  it('maps a provider abort to AI_TIMEOUT', async () => {
    const provider = {
      async chat({ signal }: { signal: AbortSignal }) {
        await new Promise<any>((_?: any, reject?: any) => {
          const timer = setTimeout(() => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, 30);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        });
      },
    };
    await assert.rejects(
      () =>
        runAgent({
          provider,
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          timeoutMs: 1000,
        }),
      /AI_TIMEOUT/
    );
  });
});

describe('openai chat stream reader', () => {
  async function* chunks(items?: any) {
    for (const item of items) yield item;
  }

  it('emits content deltas and returns the assembled reply', async () => {
    const seen: any[] = [];
    const result = await consumeChatStream(
      chunks([
        { choices: [{ delta: { role: 'assistant', content: 'При' } }] },
        { choices: [{ delta: { content: 'вет' }, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
      ]),
      { onDelta: (text?: any) => seen.push(text) }
    );
    assert.equal(result.content, 'Привет');
    assert.deepEqual(seen, ['При', 'вет']);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 });
  });

  it('does not emit onDelta when the stream contains tool calls', async () => {
    const seen: any[] = [];
    const result = await consumeChatStream(
      chunks([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'search_tasks', arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
      ]),
      { onDelta: (text?: any) => seen.push(text) }
    );
    assert.deepEqual(seen, []);
    assert.equal(result.content, '');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'search_tasks');
    assert.equal(result.toolCalls[0].arguments, '{"q":"x"}');
  });
});
