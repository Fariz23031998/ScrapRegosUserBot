const { isReasoningModel } = require('../settings');
const { resolveOpenAiConfig } = require('../provider-secrets');

const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

function getOpenAiConfig() {
  return resolveOpenAiConfig();
}

function toOpenAiTools(tools) {
  return (tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

function normalizeChatContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' || typeof part?.text === 'string') return part.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizePromptCacheKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return key.length > MAX_PROMPT_CACHE_KEY_LENGTH ? key.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH) : key;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const details =
    raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
      ? raw.prompt_tokens_details
      : {};
  const usage = {
    prompt_tokens: Number(raw.prompt_tokens) || 0,
    completion_tokens: Number(raw.completion_tokens) || 0,
    cached_tokens: Number(details.cached_tokens) || 0,
  };
  if (details.cache_write_tokens != null && details.cache_write_tokens !== '') {
    usage.cache_write_tokens = Number(details.cache_write_tokens) || 0;
  }
  return usage;
}

function buildChatRequest({ model, messages, tools, reasoningEffort, promptCacheKey } = {}) {
  const request = {
    model,
    messages,
  };
  if (tools && tools.length > 0) {
    request.tools = toOpenAiTools(tools);
    request.tool_choice = 'auto';
  }
  if (isReasoningModel(model)) {
    request.max_completion_tokens = DEFAULT_MAX_COMPLETION_TOKENS;
    const effort = String(reasoningEffort || '')
      .trim()
      .toLowerCase();
    if (ALLOWED_REASONING_EFFORTS.includes(effort)) {
      request.reasoning_effort = effort;
    }
  }
  const cacheKey = normalizePromptCacheKey(promptCacheKey);
  if (cacheKey) {
    request.prompt_cache_key = cacheKey;
  }
  return request;
}

function mapToolCalls(toolCalls) {
  return (toolCalls || []).map((call) => ({
    id: call.id,
    name: call.function?.name || call.name,
    arguments: call.function?.arguments || call.arguments || '{}',
  }));
}

function toRawAssistantMessage({ content, toolCalls, role = 'assistant' } = {}) {
  const message = {
    role,
    content: content || (toolCalls?.length ? null : ''),
  };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments || '{}',
      },
    }));
  }
  return message;
}

async function consumeChatStream(stream, { onDelta } = {}) {
  let content = '';
  let finishReason = null;
  let role = 'assistant';
  let usage = null;
  let sawToolCalls = false;
  const toolCallsByIndex = new Map();

  for await (const chunk of stream) {
    if (chunk?.usage) usage = normalizeUsage(chunk.usage);
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    finishReason = choice.finish_reason || finishReason;
    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    const parts = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    if (parts.length) {
      sawToolCalls = true;
      for (const part of parts) {
        const index = Number.isInteger(part.index) ? part.index : 0;
        const current = toolCallsByIndex.get(index) || { id: '', name: '', arguments: '' };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        toolCallsByIndex.set(index, current);
      }
    }
    const piece = normalizeChatContent(delta.content);
    if (!piece) continue;
    content += piece;
    if (typeof onDelta === 'function' && !sawToolCalls) await onDelta(piece);
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => call)
    .filter((call) => call.id || call.name);
  return {
    content,
    toolCalls,
    finishReason,
    raw: toRawAssistantMessage({ content, toolCalls, role }),
    usage,
  };
}

function completionFromMessage(choice, usage) {
  const message = choice?.message || {};
  const toolCalls = mapToolCalls(message.tool_calls);
  return {
    content: normalizeChatContent(message.content),
    toolCalls,
    finishReason: choice?.finish_reason || null,
    raw: message,
    usage: normalizeUsage(usage),
  };
}

async function completeChat(client, { request, signal, onDelta } = {}) {
  const options = signal ? { signal } : undefined;
  if (typeof onDelta === 'function') {
    const stream = await client.chat.completions.create(
      { ...request, stream: true, stream_options: { include_usage: true } },
      options
    );
    return consumeChatStream(stream, { onDelta });
  }
  const completion = await client.chat.completions.create(request, options);
  return completionFromMessage(completion.choices?.[0], completion.usage);
}

async function chat({ model, messages, tools, signal, reasoningEffort, promptCacheKey, onDelta } = {}) {
  const { apiKey, baseURL } = getOpenAiConfig();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const request = buildChatRequest({ model, messages, tools, reasoningEffort, promptCacheKey });
  return completeChat(client, { request, signal, onDelta });
}

module.exports = {
  name: 'openai',
  chat,
  completeChat,
  consumeChatStream,
  getOpenAiConfig,
  buildChatRequest,
  normalizeChatContent,
  normalizePromptCacheKey,
  normalizeUsage,
  isReasoningModel,
  DEFAULT_MAX_COMPLETION_TOKENS,
  MAX_PROMPT_CACHE_KEY_LENGTH,
};
