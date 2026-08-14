const { isReasoningModel } = require('../settings');

const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
const ALLOWED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];

function getOpenAiConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseURL = String(process.env.OPENAI_BASE_URL || '').trim() || undefined;
  return { apiKey, baseURL };
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

function buildChatRequest({ model, messages, tools, reasoningEffort } = {}) {
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
  return request;
}

async function chat({ model, messages, tools, signal, reasoningEffort } = {}) {
  const { apiKey, baseURL } = getOpenAiConfig();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const request = buildChatRequest({ model, messages, tools, reasoningEffort });

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
  };
}

module.exports = {
  name: 'openai',
  chat,
  getOpenAiConfig,
  buildChatRequest,
  normalizeChatContent,
  isReasoningModel,
  DEFAULT_MAX_COMPLETION_TOKENS,
};
