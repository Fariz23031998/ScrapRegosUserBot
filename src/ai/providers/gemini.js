const { resolveGeminiConfig } = require('../provider-secrets');
const {
  buildChatRequest,
  normalizeChatContent,
  normalizeUsage,
} = require('./openai');

async function chat({ model, messages, tools, signal, reasoningEffort, promptCacheKey } = {}) {
  const { apiKey, baseURL } = resolveGeminiConfig();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
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
  name: 'gemini',
  chat,
};
