import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { DEFAULT_HISTORY_LIMIT, SUMMARY_TOKEN_BUDGET, loadAiSettings, resolveAgentModel } from './settings';
import { prependUserContext } from './run-agent';
import { createCustomerTools } from './tools/customer';
import { prepareAgentTools } from './tools/catalog';
import { getResolvedPrompt } from '../db/ai-prompts';
import { promptContextFromTicket } from '../db/ai-prompt-variables';
import { getTicketSummary, listClientTicketSummaries } from '../db/ticket-summaries';
import { formatPriorSummariesForPrompt, fetchChatMessagesInPeriod, resolveTicketClientId, resolveTicketMessagePeriod } from './ticket-period';
import { MAX_INLINE_AUDIO, MAX_INLINE_IMAGES, collectMessageFileIds, downloadChatFile, fileDisplayName, formatFileStub, isChatAudio, isVisionImage, messageFileIds, toImageUrlPart } from './chat-media';
import { formatAudioTranscript, transcribeChatAudio } from './transcribe';
import { formatImageCaption } from './image-caption';
import { extractionsByFileId } from '../db/chat-file-extractions';
import { evaluateCustomerMessageGateWithDb, resolveCustomerTrigger } from './customer-agent-gates';

function filesForMessage(item?: any, filesById?: any) {
  return messageFileIds(item)
    .map((id?: any) => filesById.get(id) || { id })
    .filter(Boolean);
}

function formatExtractionExtras(files?: any, extractionsById?: any) {
  if (!extractionsById) return [];
  const extras: any[] = [];
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

function formatMessageText(item: any, filesById: any, extractionsById: any = null) {
  const text = String(item.display_text || item.text || '').trim();
  const files = filesForMessage(item, filesById);
  const stubs = files.map(formatFileStub);
  const extras = formatExtractionExtras(files, extractionsById);
  return [text, ...stubs, ...extras].filter(Boolean).join('\n');
}

function toVisionPlaceholder(file?: any) {
  return {
    type: 'image_url',
    image_url: {
      file_id: file?.id ?? null,
      name: fileDisplayName(file),
      placeholder: true,
    },
  };
}

async function buildTriggerVisionParts(visionFiles: any, { download, visionMode }: Unchecked = {}) {
  const parts: any[] = [];
  if (visionMode === 'placeholder') {
    return visionFiles.map(toVisionPlaceholder);
  }

  for (const file of visionFiles) {
    try {
      const downloaded = await download(file);
      const part = downloaded?.base64 ? toImageUrlPart(downloaded) : null;
      if (part) parts.push(part);
    } catch (error: any) {
      console.warn('[ai] Failed to download chat image:', error.message || error);
    }
  }
  return parts;
}

function resolveHistoryLimit(value?: any) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_HISTORY_LIMIT;
}

async function buildTriggerAudioText(audioFiles: any, { transcribe, transcribeModel, db, ticketId }: Unchecked = {}) {
  const extras: any[] = [];
  for (const file of audioFiles) {
    try {
      const result = await transcribe(file, { model: transcribeModel, db, ticketId });
      const line = formatAudioTranscript(result?.text);
      if (line) extras.push(line);
    } catch (error: any) {
      console.warn('[ai] Failed to transcribe chat audio:', error.message || error);
    }
  }
  return extras.join('\n');
}

function loadMessageExtractions(db: Db, messages?: any, extractionsById?: any) {
  if (extractionsById instanceof Map) return extractionsById;
  if (!db) return new Map();
  try {
    return extractionsByFileId(db, collectMessageFileIds(messages));
  } catch (error: any) {
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
}: Unchecked = {}) {
  const limit = resolveHistoryLimit(historyLimit);
  const regular = (messages || [])
    .filter((item?: any) => String(item.message_type || 'Regular') === 'Regular')
    .slice(-limit);
  const cache = loadMessageExtractions(db, regular, extractionsById);

  const history: any[] = [];
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

function serializeCustomerTools(tools?: any) {
  return (tools || []).map((tool?: any) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));
}

function serializePreviewSettings(settings?: any) {
  return {
    enabled: Boolean(settings?.enabled),
    test_mode: Boolean(settings?.testMode),
    provider: settings?.provider || null,
    model: resolveAgentModel(settings, 'customer'),
    history_limit: resolveHistoryLimit(settings?.historyLimit),
  };
}

function buildCustomerSystemPrompt(db: Db, ticket?: any) {
  return getResolvedPrompt(db, 'customer', promptContextFromTicket(ticket));
}

function buildCustomerContextContent(db: Db, ticket: any, { budgetTokens = SUMMARY_TOKEN_BUDGET }: Unchecked = {}) {
  const summaries = listClientTicketSummaries(db, resolveTicketClientId(ticket), {
    excludeTicketId: ticket?.id,
  });
  return formatPriorSummariesForPrompt(summaries, { budgetTokens });
}

async function loadCustomerAgentChatContext({
  chatId,
  messageId,
  payload,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  ticket = null,
  occurredAt = null,
  deps = {},
}: Unchecked = {}) {
  const getTicketMessages = deps.getTicketMessages || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).getTicketMessages;
  const getChatFilesByIds = deps.getChatFilesByIds || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).getChatFilesByIds;
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
  if (
    trigger?.id &&
    !messages.some((item?: any) => String(item.id) === String(trigger.id))
  ) {
    messages = [...messages, trigger];
  }

  const fileIds = collectMessageFileIds(messages);
  const files = fileIds.length ? await getChatFilesByIds(chatId, fileIds) : [];
  const filesById: Map<any, any> = new Map((files || []).map((file?: any) => [Number(file.id), file]));

  return { messages, trigger, filesById, period };
}

function loadPromptSummaries(db: Db, ticket?: any) {
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
}: Unchecked = {}) {
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

async function previewCustomerAgentPrompt({ db, ticketId, messageId, deps = {} }: Unchecked = {}) {
  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const serializedSettings = serializePreviewSettings(settings);
  const findTicket = deps.findTicketById || (require('../integrations/regos-crm') as typeof import('../integrations/regos-crm')).findTicketById;
  const ticket = await findTicket(ticketId);
  if (!ticket) {
    const error = new Error('ticket-not-found');
    error.code = 'ticket-not-found';
    throw error;
  }

  const system = buildCustomerSystemPrompt(db, ticket);
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
    prepareAgentTools(createCustomerTools({ db, ticket, chatId, filesById, deps }), {
      db,
      settings,
      agentSlug: 'customer',
      ticket,
    }).activeTools,
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
    gate: evaluateCustomerMessageGateWithDb(db, {
      settings,
      message: trigger,
      ticket,
      chatId,
    }),
    settings: serializedSettings,
    trigger,
    chatId,
    ticketId: ticket.id,
    summary,
    priorSummaries,
  });
}

export {
  formatMessageText,
  buildCustomerSystemPrompt,
  buildCustomerContextContent,
  buildCustomerModelMessages,
  loadCustomerAgentChatContext,
  previewCustomerAgentPrompt,
};
