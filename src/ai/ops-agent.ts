import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { loadAiSettings, resolveAgentModel, resolveAgentMaxSteps } from './settings';
import { runAgent, truncateText, buildPromptCacheKey } from './run-agent';
import { getProvider } from './providers/registry';
import { createOpsTools } from './tools/ops';
import { prepareAgentTools } from './tools/catalog';
import { getOrCreateOpsSession, listOpsSessionMessages, addOpsSessionMessage } from '../db/ops-agent-sessions';
import { OPS_SYSTEM_PROMPT } from './default-prompts';
import { getResolvedPrompt } from '../db/ai-prompts';
import { historyHasAudioTranscript, historyHasVisionParts } from './chat-media';
import { buildUploadedMessageContent, toModelHistory } from './chat-uploads';

function serializePreviewTools(tools?: any) {
  return (tools || []).map((tool?: any) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));
}

function assembleOpsPrompt({
  db,
  userId,
  session,
  settings,
  write = true,
  viewer = { seeAll: true, userId: null },
  permissions = null,
  deps = {},
  history,
}: Unchecked = {}) {
  const modelHistory = history || toModelHistory(listOpsSessionMessages(db, session.id));
  const tools = prepareAgentTools(createOpsTools({ db, userId, viewer, permissions, write, deps }), {
    db,
    settings,
    agentSlug: 'ops',
  });
  return {
    system: getResolvedPrompt(db, 'ops'),
    messages: modelHistory,
    tools: tools.activeTools,
    toolPool: tools.toolPool,
    history: modelHistory,
  };
}

function previewOpsAgentPrompt({
  db,
  userId,
  sessionId,
  write = true,
  viewer = { seeAll: true, userId: null },
  permissions = null,
  deps = {},
}: Unchecked = {}) {
  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const session = getOrCreateOpsSession(db, { sessionId, userId });
  const assembled = assembleOpsPrompt({
    db,
    userId,
    session,
    settings,
    write,
    viewer,
    permissions,
    deps,
  });
  return {
    system: assembled.system,
    messages: assembled.messages,
    tools: serializePreviewTools(assembled.tools),
    settings: {
      enabled: Boolean(settings.enabled),
      test_mode: Boolean(settings.testMode),
      provider: settings.provider || null,
      model: resolveAgentModel(settings, 'ops'),
    },
    session_id: session!.id,
  };
}

async function runOpsAgent({
  db,
  userId,
  sessionId,
  message,
  files = [],
  write = true,
  viewer = { seeAll: true, userId: null },
  permissions = null,
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
  const session = getOrCreateOpsSession(db, { sessionId, userId });
  addOpsSessionMessage(db, session!.id, {
    role: 'user',
    content: text,
    attachments: uploads,
  });

  const lastUserContent = await buildUploadedMessageContent(text, uploads, {
    transcribe: deps.transcribeChatAudio,
    transcribeModel: settings.transcribeModel,
  });
  const history = toModelHistory(listOpsSessionMessages(db, session!.id), { lastUserContent });
  const assembled = assembleOpsPrompt({
    db,
    userId,
    session,
    settings,
    write,
    viewer,
    permissions,
    deps,
    history,
  });

  const run = deps.runAgent || runAgent;
  const provider = deps.provider || getProvider(settings.provider);
  const result = await run({
    provider,
    providerName: settings.provider,
    model: resolveAgentModel(settings, 'ops'),
    system: assembled.system,
    messages: assembled.messages,
    promptCacheKey: buildPromptCacheKey('ops', session!.id),
    tools: assembled.tools,
    toolPool: assembled.toolPool,
    reasoningEffort: settings.reasoningEffort,
    hasVision: historyHasVisionParts(assembled.history),
    hasAudio: historyHasAudioTranscript(assembled.history),
    maxSteps: resolveAgentMaxSteps(settings, 'ops'),
    onDelta,
  });

  const reply = truncateText(result.content) || 'Готово.';
  addOpsSessionMessage(db, session!.id, { role: 'assistant', content: reply });
  return {
    session_id: session!.id,
    reply,
    messages: listOpsSessionMessages(db, session!.id),
  };
}

export { OPS_SYSTEM_PROMPT, previewOpsAgentPrompt, runOpsAgent };
