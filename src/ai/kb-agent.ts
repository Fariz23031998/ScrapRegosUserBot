import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { loadAiSettings, resolveAgentModel, resolveAgentMaxSteps } from './settings';
import { runAgent, truncateText, buildPromptCacheKey } from './run-agent';
import { getProvider } from './providers/registry';
import { createKnowledgeTools } from './tools/knowledge';
import { prepareAgentTools } from './tools/catalog';
import { getOrCreateKbSession, listKbSessionMessages, addKbSessionMessage } from '../db/knowledge-articles';
import { KB_SYSTEM_PROMPT } from './default-prompts';
import { getResolvedPrompt } from '../db/ai-prompts';
import { historyHasAudioTranscript, historyHasVisionParts } from './chat-media';
import { buildUploadedMessageContent, toModelHistory } from './chat-uploads';

async function runKbAgent({
  db,
  userId,
  sessionId,
  message,
  files = [],
  canWrite = true,
  deps = {},
  onDelta,
}: Unchecked = {}) {
  const text = String(message || '').trim();
  const uploads = Array.isArray(files) ? files : [];
  if (!text && uploads.length === 0) {
    throw new Error('EMPTY_MESSAGE');
  }

  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const session = getOrCreateKbSession(db, { sessionId, userId });
  addKbSessionMessage(db, session!.id, {
    role: 'user',
    content: text,
    attachments: uploads,
  });

  const lastUserContent = await buildUploadedMessageContent(text, uploads, {
    transcribe: deps.transcribeChatAudio,
    transcribeModel: settings.transcribeModel,
  });
  const history = toModelHistory(listKbSessionMessages(db, session!.id), { lastUserContent });

  const run = deps.runAgent || runAgent;
  const provider = deps.provider || getProvider(settings.provider);
  const tools = prepareAgentTools(createKnowledgeTools({ db, userId, write: canWrite, deps }), {
      db,
      settings,
      agentSlug: 'kb',
    });
  const result = await run({
    provider,
    providerName: settings.provider,
    model: resolveAgentModel(settings, 'kb'),
    system: getResolvedPrompt(db, 'kb'),
    messages: history,
    promptCacheKey: buildPromptCacheKey('kb', session!.id),
    tools: tools.activeTools,
    toolPool: tools.toolPool,
    reasoningEffort: settings.reasoningEffort,
    hasVision: historyHasVisionParts(history),
    hasAudio: historyHasAudioTranscript(history),
    maxSteps: resolveAgentMaxSteps(settings, 'kb'),
    onDelta,
  });

  const reply = truncateText(result.content) || 'Готово.';
  addKbSessionMessage(db, session!.id, { role: 'assistant', content: reply });
  return {
    session_id: session!.id,
    reply,
    messages: listKbSessionMessages(db, session!.id),
  };
}

export { KB_SYSTEM_PROMPT, runKbAgent };
