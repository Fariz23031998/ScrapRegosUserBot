import type { Unchecked } from '../../types/unchecked';
import { resolveGeminiConfig } from '../provider-secrets';
import { buildChatRequest, completeChat } from './openai';

async function chat({ model, messages, tools, signal, reasoningEffort, promptCacheKey, onDelta }: Unchecked = {}) {
  const { apiKey, baseURL } = resolveGeminiConfig();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const request = buildChatRequest({ model, messages, tools, reasoningEffort, promptCacheKey });
  return completeChat(client, { request, signal, onDelta });
}

const name = 'gemini';

export { name, chat };
