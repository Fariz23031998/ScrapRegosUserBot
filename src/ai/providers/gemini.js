const { resolveGeminiConfig } = require('../provider-secrets');
const { buildChatRequest, completeChat } = require('./openai');

async function chat({ model, messages, tools, signal, reasoningEffort, promptCacheKey, onDelta } = {}) {
  const { apiKey, baseURL } = resolveGeminiConfig();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const request = buildChatRequest({ model, messages, tools, reasoningEffort, promptCacheKey });
  return completeChat(client, { request, signal, onDelta });
}

module.exports = {
  name: 'gemini',
  chat,
};
