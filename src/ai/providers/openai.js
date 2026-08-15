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

async function chat({ model, messages, tools, signal, reasoningEffort, promptCacheKey } = {}) {
  const { apiKey, baseURL } = getOpenAiConfig();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const request = buildChatRequest({ model, messages, tools, reasoningEffort, promptCacheKey });

  const completion = await client.chat.completions.create(request, signal ? { signal } : undefined);
  const choice = completion.choices?.[0];
  const message = choice?.message || {};
  return {
    content: normalizeChatContent(message.content),
    toolCalls: (message.tool_calls || []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments || '{}',
    })),
    finishReason: choice?.finish_reason || null,
    raw: message,
    usage: normalizeUsage(completion.usage),
  };
}

module.exports = {
  name: 'openai',
  chat,
  getOpenAiConfig,
  buildChatRequest,
  normalizeChatContent,
  normalizePromptCacheKey,
  normalizeUsage,
  isReasoningModel,
  DEFAULT_MAX_COMPLETION_TOKENS,
  MAX_PROMPT_CACHE_KEY_LENGTH,
};
