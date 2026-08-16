const { DEFAULT_HISTORY_LIMIT, SUMMARY_TOKEN_BUDGET, loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText, prependUserContext, buildPromptCacheKey } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { createCustomerTools } = require('./tools/customer');
const { filterEnabledTools } = require('./tools/catalog');
const { isEmployeeClientPhone } = require('./tools/employees');
const { logAdminAudit } = require('../db/admin-audit-logs');
const { CUSTOMER_SYSTEM_PROMPT } = require('./default-prompts');
const { getResolvedPrompt } = require('../db/ai-prompts');
const { getTicketSummary, listClientTicketSummaries } = require('../db/ticket-summaries');
const {
  formatPriorSummariesForPrompt,
  fetchChatMessagesInPeriod,
  resolveTicketClientId,
  resolveTicketMessagePeriod,
} = require('./ticket-period');
const {
  MAX_INLINE_AUDIO,
  MAX_INLINE_IMAGES,
  collectMessageFileIds,
  downloadChatFile,
  fileDisplayName,
  formatFileStub,
  historyHasAudioTranscript,
  historyHasVisionParts,
  isChatAudio,
  isVisionImage,
  messageFileIds,
  toImageUrlPart,
} = require('./chat-media');
const { formatAudioTranscript, transcribeChatAudio } = require('./transcribe');
const { formatImageCaption } = require('./image-caption');
const { extractionsByFileId } = require('../db/chat-file-extractions');
const { knowledgeCategoryContext } = require('../db/knowledge-articles');

const inflightChats = new Set();
const pendingCustomerChats = new Map();
const processedCustomerMessages = new Map();
const PROCESSED_MESSAGE_TTL_MS = 60 * 60 * 1000;

function resolveAiAuthorUserId() {
  const raw = Number(process.env.AI_REGOS_AUTHOR_USER_ID);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function processedMessageKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function cleanupProcessedMessages(nowMs = Date.now()) {
  for (const [key, processedAt] of processedCustomerMessages) {
    if (nowMs - processedAt >= PROCESSED_MESSAGE_TTL_MS) {
      processedCustomerMessages.delete(key);
    }
  }
}

function markCustomerMessageProcessed(chatId, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  cleanupProcessedMessages();
  processedCustomerMessages.set(processedMessageKey(chatId, id), Date.now());
}

function isCustomerMessageProcessed(chatId, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  cleanupProcessedMessages();
  return processedCustomerMessages.has(processedMessageKey(chatId, id));
}

function isClientRegularMessage(message) {
  return (
    String(message?.author_entity_type || '') === 'Client' &&
    String(message?.message_type || 'Regular') === 'Regular'
  );
}

function isSystemMessage(message) {
  return String(message?.message_type || '') === 'System';
}

function hasReplyAfterTrigger(messages, trigger, aiAuthorId) {
  if (!trigger?.id) return false;
  const triggerId = String(trigger.id);
  let seenTrigger = false;
  for (const item of messages || []) {
    if (!seenTrigger) {
      if (String(item?.id) === triggerId) seenTrigger = true;
      continue;
    }
    if (String(item?.message_type || 'Regular') !== 'Regular') continue;
    if (String(item?.author_entity_type || '') !== 'User') continue;
    if (aiAuthorId && Number(item?.author_entity_id) !== Number(aiAuthorId)) continue;
    return true;
  }
  return false;
}

function hasUserReplyAfterTrigger(messages, trigger) {
  return hasReplyAfterTrigger(messages, trigger, null);
}

function lastUnansweredClientRegular(messages) {
  const clients = (messages || []).filter(isClientRegularMessage);
  for (let i = clients.length - 1; i >= 0; i -= 1) {
    if (!hasUserReplyAfterTrigger(messages, clients[i])) {
      return clients[i];
    }
  }
  return null;
}

function pickTriggerMessage(messages, messageId, payload) {
  if (messageId) {
    const found = (messages || []).find((item) => String(item.id) === String(messageId));
    if (found) return found;
  }
  if (
    payload &&
    (payload.author_entity_type ||
      payload.text ||
      payload.message_type ||
      (Array.isArray(payload.file_ids) && payload.file_ids.length))
  ) {
    return payload;
  }
  // Webhooks for staff/system messages often omit author fields. Never guess
  // "the last client message" in that case — that re-answers the same question
  // after every AI reply. Preview (no messageId) can still use the latest client.
  if (messageId) return null;
  return (messages || []).filter((item) => String(item.author_entity_type || '') === 'Client').at(-1) || null;
}

function resolveCustomerTrigger(messages, messageId, payload) {
  const trigger = pickTriggerMessage(messages, messageId, payload);
  if (isClientRegularMessage(trigger)) return trigger;
  if (isSystemMessage(trigger) || isSystemMessage(payload)) {
    return lastUnansweredClientRegular(messages) || trigger;
  }
  return trigger;
}

function evaluateCustomerMessageGate({ settings, message, ticket, isEmployeePhone = false, aiStopped = false } = {}) {
  if (!settings?.enabled) return { handle: false, reason: 'disabled' };
  // Per-ticket stop: blocks automatic customer replies only (not employee assist).
  if (aiStopped) return { handle: false, reason: 'stopped' };
  if (String(message?.message_type || 'Regular') !== 'Regular') {
    return { handle: false, reason: 'not-regular' };
  }
  const authorType = String(message?.author_entity_type || '');
  if (authorType === 'ChatBot') return { handle: false, reason: 'bot' };
  if (authorType !== 'Client') return { handle: false, reason: 'not-client' };
  const aiAuthorId = resolveAiAuthorUserId();
  if (aiAuthorId && Number(message?.author_entity_id) === aiAuthorId) {
    return { handle: false, reason: 'own-author' };
  }
  if (String(ticket?.status || '') === 'Closed') return { handle: false, reason: 'closed' };
  if (settings.testMode && !isEmployeePhone) {
    return { handle: false, reason: 'test-mode' };
  }
  return { handle: true, reason: null };
}

function evaluateCustomerMessageGateWithDb(db, { settings, message, ticket } = {}) {
  const { isTicketAiStopped } = require('../db/ticket-ai-state');
  return evaluateCustomerMessageGate({
    settings,
    message,
    ticket,
    isEmployeePhone: isEmployeeClientPhone(db, ticket?.client?.phone),
    aiStopped: isTicketAiStopped(db, ticket?.id),
  });
}

function filesForMessage(item, filesById) {
  return messageFileIds(item)
    .map((id) => filesById.get(id) || { id })
    .filter(Boolean);
}

function formatExtractionExtras(files, extractionsById) {
  if (!extractionsById) return [];
  const extras = [];
  for (const file of files || []) {
    const id = Number(file?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const stored = extractionsById.get(id);
    if (!stored?.text) continue;
    if (stored.kind === 'audio') {
      const line = formatAudioTranscript(stored.text);
      if (line) extras.push(line);
    } else if (stored.kind === 'image') {
      const line = formatImageCaption(stored.text);
      if (line) extras.push(line);
    }
  }
  return extras;
}

function formatMessageText(item, filesById, extractionsById = null) {
  const text = String(item.display_text || item.text || '').trim();
  const files = filesForMessage(item, filesById);
  const stubs = files.map(formatFileStub);
  const extras = formatExtractionExtras(files, extractionsById);
  return [text, ...stubs, ...extras].filter(Boolean).join('\n');
}

function toVisionPlaceholder(file) {
  return {
    type: 'image_url',
    image_url: {
      file_id: file?.id ?? null,
      name: fileDisplayName(file),
      placeholder: true,
    },
  };
}

async function buildTriggerVisionParts(visionFiles, { download, visionMode } = {}) {
  const parts = [];
  if (visionMode === 'placeholder') {
    return visionFiles.map(toVisionPlaceholder);
  }

  for (const file of visionFiles) {
    try {
      const downloaded = await download(file);
      const part = downloaded?.base64 ? toImageUrlPart(downloaded) : null;
      if (part) parts.push(part);
    } catch (error) {
      console.warn('[ai] Failed to download chat image:', error.message || error);
    }
  }
  return parts;
}

function resolveHistoryLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_HISTORY_LIMIT;
}

async function buildTriggerAudioText(audioFiles, { transcribe, transcribeModel, db, ticketId } = {}) {
  const extras = [];
  for (const file of audioFiles) {
    try {
      const result = await transcribe(file, { model: transcribeModel, db, ticketId });
      const line = formatAudioTranscript(result?.text);
      if (line) extras.push(line);
    } catch (error) {
      console.warn('[ai] Failed to transcribe chat audio:', error.message || error);
    }
  }
  return extras.join('\n');
}

function loadMessageExtractions(db, messages, extractionsById) {
  if (extractionsById instanceof Map) return extractionsById;
  if (!db) return new Map();
  try {
    return extractionsByFileId(db, collectMessageFileIds(messages));
  } catch (error) {
    console.warn('[ai] Failed to load chat file extractions:', error.message || error);
    return new Map();
  }
}

async function buildCustomerModelMessages({
  messages,
  trigger,
  filesById = new Map(),
  download = downloadChatFile,
  transcribe = transcribeChatAudio,
  transcribeModel = null,
  visionMode = 'download',
  historyLimit = DEFAULT_HISTORY_LIMIT,
  db = null,
  ticketId = null,
  extractionsById,
} = {}) {
  const limit = resolveHistoryLimit(historyLimit);
  const regular = (messages || [])
    .filter((item) => String(item.message_type || 'Regular') === 'Regular')
    .slice(-limit);
  const cache = loadMessageExtractions(db, regular, extractionsById);

  const history = [];
  for (const item of regular) {
    const role = String(item.author_entity_type || '') === 'Client' ? 'user' : 'assistant';
    const isTrigger = trigger && String(item.id) === String(trigger.id);
    let text = formatMessageText(item, filesById, isTrigger ? null : cache);

    if (isTrigger && role === 'user') {
      if (visionMode !== 'placeholder') {
        const audioFiles = filesForMessage(item, filesById)
          .filter(isChatAudio)
          .slice(0, MAX_INLINE_AUDIO);
        if (audioFiles.length) {
          const transcripts = await buildTriggerAudioText(audioFiles, {
            transcribe,
            transcribeModel,
            db,
            ticketId,
          });
          if (transcripts) text = [text, transcripts].filter(Boolean).join('\n');
        }
      }

      const visionFiles = filesForMessage(item, filesById)
        .filter(isVisionImage)
        .slice(0, MAX_INLINE_IMAGES);
      const parts = await buildTriggerVisionParts(visionFiles, { download, visionMode });
      if (parts.length) {
        history.push({
          role: 'user',
          content: [{ type: 'text', text: text || 'Изображение в сообщении клиента.' }, ...parts],
        });
        continue;
      }
    }

    if (!text) continue;
    history.push({ role, content: text });
  }
  return history;
}

function serializeCustomerTools(tools) {
  return (tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));
}

function serializePreviewSettings(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    test_mode: Boolean(settings?.testMode),
    provider: settings?.provider || null,
    model: resolveAgentModel(settings, 'customer'),
    history_limit: resolveHistoryLimit(settings?.historyLimit),
  };
}

function buildCustomerSystemPrompt(db) {
  return getResolvedPrompt(db, 'customer');
}

function buildCustomerContextContent(db, ticket, { budgetTokens = SUMMARY_TOKEN_BUDGET } = {}) {
  const summaries = listClientTicketSummaries(db, resolveTicketClientId(ticket), {
    excludeTicketId: ticket?.id,
  });
  return [formatPriorSummariesForPrompt(summaries, { budgetTokens }), knowledgeCategoryContext(db)]
    .filter(Boolean)
    .join('\n\n');
}

async function loadCustomerAgentChatContext({
  chatId,
  messageId,
  payload,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  ticket = null,
  occurredAt = null,
  deps = {},
} = {}) {
  const getTicketMessages = deps.getTicketMessages || require('../integrations/regos-crm').getTicketMessages;
  const getChatFilesByIds = deps.getChatFilesByIds || require('../integrations/regos-crm').getChatFilesByIds;
  const fetchMessages = deps.fetchChatMessagesInPeriod || fetchChatMessagesInPeriod;
  const limit = resolveHistoryLimit(historyLimit);
  const period = resolveTicketMessagePeriod(ticket, { occurredAt });

  let messages = await fetchMessages(chatId, {
    from: period.from,
    to: period.to,
    stopAfter: limit,
    getTicketMessages,
  });
  const trigger = resolveCustomerTrigger(messages, messageId, payload);
  if (trigger && !messages.some((item) => String(item.id) === String(trigger.id))) {
    messages = [...messages, trigger];
  }

  const fileIds = collectMessageFileIds(messages);
  const files = fileIds.length ? await getChatFilesByIds(chatId, fileIds) : [];
  const filesById = new Map((files || []).map((file) => [Number(file.id), file]));

  return { messages, trigger, filesById, period };
}

function loadPromptSummaries(db, ticket) {
  return {
    summary: getTicketSummary(db, ticket?.id),
    prior_summaries: listClientTicketSummaries(db, resolveTicketClientId(ticket), {
      excludeTicketId: ticket?.id,
    }),
  };
}

function buildPreviewResult({
  system,
  messages = [],
  tools = [],
  gate,
  settings,
  trigger = null,
  chatId = null,
  ticketId = null,
  summary = null,
  priorSummaries = [],
} = {}) {
  return {
    system: system || '',
    messages,
    tools,
    gate: gate || { handle: false, reason: null },
    settings,
    trigger_message_id: trigger?.id ?? null,
    chat_id: chatId,
    ticket_id: ticketId,
    summary: summary || null,
    prior_summaries: Array.isArray(priorSummaries) ? priorSummaries : [],
  };
}

async function previewCustomerAgentPrompt({ db, ticketId, messageId, deps = {} } = {}) {
  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const serializedSettings = serializePreviewSettings(settings);
  const findTicket = deps.findTicketById || require('../integrations/regos-crm').findTicketById;
  const ticket = await findTicket(ticketId);
  if (!ticket) {
    const error = new Error('ticket-not-found');
    error.code = 'ticket-not-found';
    throw error;
  }

  const system = buildCustomerSystemPrompt(db);
  const context = buildCustomerContextContent(db, ticket);
  const { summary, prior_summaries: priorSummaries } = loadPromptSummaries(db, ticket);
  const chatId = ticket.chat_id != null ? String(ticket.chat_id).trim() : '';
  if (!chatId) {
    return buildPreviewResult({
      system,
      gate: { handle: false, reason: 'no-chat' },
      settings: serializedSettings,
      ticketId: ticket.id,
      summary,
      priorSummaries,
    });
  }

  const { messages, trigger, filesById } = await loadCustomerAgentChatContext({
    chatId,
    messageId,
    historyLimit: settings.historyLimit,
    ticket,
    deps,
  });
  const tools = serializeCustomerTools(
    filterEnabledTools(createCustomerTools({ db, ticket, chatId, filesById, deps }), settings.disabledTools),
  );
  if (!trigger) {
    return buildPreviewResult({
      system,
      tools,
      gate: { handle: false, reason: 'message-not-found' },
      settings: serializedSettings,
      chatId,
      ticketId: ticket.id,
      summary,
      priorSummaries,
    });
  }

  const history = await buildCustomerModelMessages({
    messages,
    trigger,
    filesById,
    visionMode: 'placeholder',
    historyLimit: settings.historyLimit,
    db,
    ticketId: ticket.id,
  });
  return buildPreviewResult({
    system,
    messages: prependUserContext(history, context),
    tools,
    gate: evaluateCustomerMessageGateWithDb(db, { settings, message: trigger, ticket }),
    settings: serializedSettings,
    trigger,
    chatId,
    ticketId: ticket.id,
    summary,
    priorSummaries,
  });
}

function auditAiEvent(db, { ticketId, action, summary, details }) {
  if (!db) return;
  try {
    logAdminAudit(db, {
      entityType: 'ticket',
      entityId: ticketId ?? null,
      action,
      summary,
      details,
      actor: null,
    });
  } catch (error) {
    console.error('[ai] Failed to write audit log:', error);
  }
}

async function handleCustomerChatMessage({
  db,
  chatId,
  messageId,
  payload,
  deps = {},
} = {}) {
  const id = String(chatId || '').trim();
  if (!id) return { handled: false, reason: 'no-chat' };
  if (inflightChats.has(id)) {
    if (isClientRegularMessage(payload) || isSystemMessage(payload)) {
      pendingCustomerChats.set(id, { messageId, payload });
    }
    return { handled: false, reason: 'busy' };
  }

  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const model = resolveAgentModel(settings, 'customer');
  if (!settings.enabled) {
    console.info('[ai] skip customer message: disabled');
    return { handled: false, reason: 'disabled' };
  }

  inflightChats.add(id);
  try {
    const findTicket = deps.findTicketByChatId || require('../integrations/regos-crm').findTicketByChatId;
    const addTicketMessage = deps.addTicketMessage || require('../integrations/regos-crm').addTicketMessage;
    const ensureParticipant =
      deps.ensureTicketParticipant || require('../integrations/regos-crm').ensureTicketParticipant;
    const isParticipant =
      deps.isTicketStaffParticipant || require('../integrations/regos-crm').isTicketStaffParticipant;
    const download = deps.downloadChatFile || downloadChatFile;
    const transcribeFn = deps.transcribeChatAudio || transcribeChatAudio;
    const run = deps.runAgent || runAgent;
    const provider = deps.provider || getProvider(settings.provider);

    const ticket = await findTicket(id);
    if (!ticket) return { handled: false, reason: 'ticket-not-found' };
    const transcribe = (file, options = {}) =>
      transcribeFn(file, { db, ticketId: ticket.id, source: 'transcribe', ...options });

    const { messages, trigger, filesById } = await loadCustomerAgentChatContext({
      chatId: id,
      messageId,
      payload,
      historyLimit: settings.historyLimit,
      ticket,
      deps,
    });
    if (!trigger) return { handled: false, reason: 'message-not-found' };
    if (isCustomerMessageProcessed(id, trigger.id)) {
      return { handled: false, reason: 'already-processed' };
    }

    const gate = evaluateCustomerMessageGateWithDb(db, { settings, message: trigger, ticket });
    if (!gate.handle) {
      console.info(`[ai] skip customer message: ${gate.reason} chat=${id} ticket=${ticket.id}`);
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI пропустил тикет #${ticket.id}: ${gate.reason}`,
        details: { reason: gate.reason, model },
      });
      return { handled: false, reason: gate.reason };
    }

    const authorEntityId = resolveAiAuthorUserId();
    if (!authorEntityId) {
      console.warn(
        '[ai] skip customer message: AI_REGOS_AUTHOR_USER_ID is not set. ' +
          'REGOS requires a linked User who is a ticket participant.'
      );
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI пропустил тикет #${ticket.id}: no-author`,
        details: { reason: 'no-author', model },
      });
      return { handled: false, reason: 'no-author' };
    }

    if (!isParticipant(ticket, authorEntityId)) {
      try {
        await ensureParticipant(ticket.id, authorEntityId);
      } catch (error) {
        console.error(
          `[ai] could not add AI author ${authorEntityId} to ticket ${ticket.id}:`,
          error
        );
        auditAiEvent(db, {
          ticketId: ticket.id,
          action: 'ai_skip',
          summary: `AI пропустил тикет #${ticket.id}: not-participant`,
          details: { reason: 'not-participant', model },
        });
        return { handled: false, reason: 'not-participant' };
      }
    }

    if (hasReplyAfterTrigger(messages, trigger, authorEntityId)) {
      markCustomerMessageProcessed(id, trigger.id);
      console.info(`[ai] skip customer message: already-replied chat=${id} ticket=${ticket.id}`);
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI пропустил тикет #${ticket.id}: already-replied`,
        details: { reason: 'already-replied', model },
      });
      return { handled: false, reason: 'already-replied' };
    }

    const history = await buildCustomerModelMessages({
      messages,
      trigger,
      filesById,
      download,
      transcribe,
      transcribeModel: settings.transcribeModel,
      historyLimit: settings.historyLimit,
      db,
      ticketId: ticket.id,
    });
    if (!history.length) return { handled: false, reason: 'empty-history' };

    let closeRequested = false;
    const setTicketStatus =
      deps.setTicketStatus || require('../integrations/regos-crm').setTicketStatus;

    const result = await run({
      provider,
      providerName: settings.provider,
      model,
      system: buildCustomerSystemPrompt(db),
      messages: prependUserContext(history, buildCustomerContextContent(db, ticket)),
      promptCacheKey: buildPromptCacheKey('customer', ticket.id),
      tools: filterEnabledTools(
        createCustomerTools({
          db,
          ticket,
          chatId: id,
          filesById,
          deps: {
            ...deps,
            transcribeModel: settings.transcribeModel,
            onTicketClose: () => {
              closeRequested = true;
            },
          },
        }),
        settings.disabledTools,
      ),
      reasoningEffort: settings.reasoningEffort,
      hasVision: historyHasVisionParts(history),
      hasAudio: historyHasAudioTranscript(history),
    });

    const reply = truncateText(result.content);
    if (!reply) return { handled: false, reason: 'empty-reply' };

    try {
      await addTicketMessage({
        chatId: id,
        text: reply,
        authorEntityType: 'User',
        authorEntityId,
      });
    } catch (error) {
      console.error(`[ai] failed to send reply to ticket ${ticket.id}:`, error);
      auditAiEvent(db, {
        ticketId: ticket.id,
        action: 'ai_skip',
        summary: `AI не смог отправить ответ в тикет #${ticket.id}`,
        details: { reason: 'send-failed', model },
      });
      return { handled: false, reason: 'send-failed' };
    }

    let closed = false;
    if (closeRequested) {
      try {
        await setTicketStatus(ticket.id, 'Closed');
        closed = true;
      } catch (error) {
        console.error(`[ai] failed to close ticket ${ticket.id}:`, error);
        auditAiEvent(db, {
          ticketId: ticket.id,
          action: 'ai_skip',
          summary: `AI не смог закрыть тикет #${ticket.id}`,
          details: { reason: 'close-failed', model },
        });
      }
    }

    markCustomerMessageProcessed(id, trigger.id);
    auditAiEvent(db, {
      ticketId: ticket.id,
      action: 'ai_reply',
      summary: closed
        ? `AI ответил и закрыл тикет #${ticket.id}`
        : `AI ответил в тикет #${ticket.id}`,
      details: { model, provider: settings.provider, steps: result.steps, closed },
    });
    return { handled: true, reason: null, reply, closed };
  } finally {
    inflightChats.delete(id);
    const pending = pendingCustomerChats.get(id);
    if (pending) {
      pendingCustomerChats.delete(id);
      setImmediate(() => {
        handleCustomerChatMessage({
          db,
          chatId: id,
          messageId: pending.messageId,
          payload: pending.payload,
          deps,
        }).catch((error) => {
          console.error('[ai] customer agent failed', error);
        });
      });
    }
  }
}

function resetCustomerAgentLocks() {
  inflightChats.clear();
  pendingCustomerChats.clear();
  processedCustomerMessages.clear();
}

module.exports = {
  CUSTOMER_SYSTEM_PROMPT,
  evaluateCustomerMessageGate,
  evaluateCustomerMessageGateWithDb,
  handleCustomerChatMessage,
  previewCustomerAgentPrompt,
  buildCustomerSystemPrompt,
  buildCustomerContextContent,
  buildCustomerModelMessages,
  loadCustomerAgentChatContext,
  formatMessageText,
  resetCustomerAgentLocks,
  resolveAiAuthorUserId,
};
