const { loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { createKnowledgeTools } = require('./tools/knowledge');
const { filterEnabledTools } = require('./tools/catalog');
const {
  getOrCreateKbSession,
  listKbSessionMessages,
  addKbSessionMessage,
} = require('../db/knowledge-articles');
const { KB_SYSTEM_PROMPT } = require('./default-prompts');
const { getResolvedPrompt } = require('../db/ai-prompts');
const { historyHasAudioTranscript, historyHasVisionParts } = require('./chat-media');
const { buildUploadedMessageContent, toModelHistory } = require('./chat-uploads');

async function runKbAgent({
  db,
  userId,
  sessionId,
  message,
  files = [],
  canWrite = true,
  deps = {},
} = {}) {
  const text = String(message || '').trim();
  const uploads = Array.isArray(files) ? files : [];
  if (!text && uploads.length === 0) {
    throw new Error('EMPTY_MESSAGE');
  }

  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const session = getOrCreateKbSession(db, { sessionId, userId });
  addKbSessionMessage(db, session.id, {
    role: 'user',
    content: text,
    attachments: uploads,
  });

  const lastUserContent = await buildUploadedMessageContent(text, uploads, {
    transcribe: deps.transcribeChatAudio,
    transcribeModel: settings.transcribeModel,
  });
  const history = toModelHistory(listKbSessionMessages(db, session.id), { lastUserContent });

  const run = deps.runAgent || runAgent;
  const provider = deps.provider || getProvider(settings.provider);
  const result = await run({
    provider,
    providerName: settings.provider,
    model: resolveAgentModel(settings, 'kb'),
    system: getResolvedPrompt(db, 'kb'),
    messages: history,
    tools: filterEnabledTools(
      createKnowledgeTools({ db, userId, write: canWrite, deps }),
      settings.disabledTools,
    ),
    reasoningEffort: settings.reasoningEffort,
    hasVision: historyHasVisionParts(history),
    hasAudio: historyHasAudioTranscript(history),
  });

  const reply = truncateText(result.content) || 'Готово.';
  addKbSessionMessage(db, session.id, { role: 'assistant', content: reply });
  return {
    session_id: session.id,
    reply,
    messages: listKbSessionMessages(db, session.id),
  };
}

module.exports = {
  KB_SYSTEM_PROMPT,
  runKbAgent,
};
