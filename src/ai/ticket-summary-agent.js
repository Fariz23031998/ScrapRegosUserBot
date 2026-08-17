const { loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText, buildPromptCacheKey } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { TICKET_SUMMARY_SYSTEM_PROMPT } = require('./default-prompts');
const { getResolvedPrompt } = require('../db/ai-prompts');
const { promptContextFromTicket } = require('../db/ai-prompt-variables');
const {
  hasSuccessfulTicketSummary,
  upsertTicketSummary,
} = require('../db/ticket-summaries');
const {
  fetchChatMessagesInPeriod,
  isRegularChatMessage,
  resolveTicketClientId,
  resolveTicketMessagePeriod,
} = require('./ticket-period');
const {
  MAX_SUMMARY_AUDIO,
  MAX_SUMMARY_IMAGES,
  collectMessageFileIds,
  formatFileStub,
  isChatAudio,
  isVisionImage,
  messageFileIds,
} = require('./chat-media');
const { formatAudioTranscript, transcribeChatAudio } = require('./transcribe');
const { captionChatImage, formatImageCaption } = require('./image-caption');
const { extractionsByFileId } = require('../db/chat-file-extractions');

const MAX_TRANSCRIPT_CHARS = 24_000;
const CHUNK_CHARS = 8_000;
const EMPTY_SUMMARY = 'В периоде обращения нет сообщений для сводки.';

function authorLabel(item) {
  const type = String(item?.author_entity_type || '');
  if (type === 'Client') return 'Клиент';
  if (type === 'ChatBot') return 'Бот';
  if (type === 'User') return 'Сотрудник';
  return type || 'Система';
}

function formatTranscriptLine(item) {
  const text = String(item?.display_text || item?.text || '').trim();
  if (!text) return '';
  return `${authorLabel(item)}: ${text}`;
}

function filesForMessage(item, filesById) {
  return messageFileIds(item)
    .map((id) => filesById.get(id))
    .filter(Boolean);
}

function fileIdOf(file) {
  const id = Number(file?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cachedExtractionText(file, extractionsById, kind) {
  const id = fileIdOf(file);
  if (!id || !extractionsById) return '';
  const stored = extractionsById.get(id);
  if (!stored || stored.kind !== kind || !stored.text) return '';
  return stored.text;
}

function rememberExtraction(extractionsById, file, kind, text) {
  const id = fileIdOf(file);
  const value = String(text || '').trim();
  if (!id || !value || !extractionsById) return;
  extractionsById.set(id, { file_id: id, kind, text: value });
}

async function extractUncachedMedia(file, {
  kind,
  extractionsById,
  extract,
  extractModel,
  format,
  warnLabel,
}) {
  const cached = cachedExtractionText(file, extractionsById, kind);
  if (cached) return { line: format(cached), extracted: false };
  if (!extract) return { line: '', extracted: false };
  try {
    const result = await extract(file, { model: extractModel });
    const line = format(result?.text);
    if (line) rememberExtraction(extractionsById, file, kind, result.text);
    return { line, extracted: true };
  } catch (error) {
    console.warn(`[ai] Failed to ${warnLabel}:`, error.message || error);
    return { line: '', extracted: true };
  }
}

function loadExtractionMap(db, messages, extractionsById) {
  if (extractionsById instanceof Map) return extractionsById;
  if (!db) return new Map();
  try {
    return extractionsByFileId(db, collectMessageFileIds(messages));
  } catch (error) {
    console.warn('[ai] Failed to load chat file extractions:', error.message || error);
    return new Map();
  }
}

async function buildTranscriptLines(
  messages,
  {
    db = null,
    filesById = new Map(),
    extractionsById,
    transcribe,
    transcribeModel,
    caption,
    captionModel,
  } = {}
) {
  const cache = loadExtractionMap(db, messages, extractionsById);
  const lines = [];
  let audioCount = 0;
  let imageCount = 0;
  for (const item of messages || []) {
    if (!isRegularChatMessage(item)) continue;
    const text = String(item?.display_text || item?.text || '').trim();
    const files = filesForMessage(item, filesById);
    const stubs = files.map(formatFileStub);
    const extras = [];
    for (const file of files.filter(isChatAudio)) {
      const cached = cachedExtractionText(file, cache, 'audio');
      if (cached) {
        extras.push(formatAudioTranscript(cached));
        continue;
      }
      if (audioCount >= MAX_SUMMARY_AUDIO) continue;
      audioCount += 1;
      const extracted = await extractUncachedMedia(file, {
        kind: 'audio',
        extractionsById: cache,
        extract: transcribe,
        extractModel: transcribeModel,
        format: formatAudioTranscript,
        warnLabel: 'transcribe summary audio',
      });
      if (extracted.line) extras.push(extracted.line);
    }
    for (const file of files.filter(isVisionImage)) {
      const cached = cachedExtractionText(file, cache, 'image');
      if (cached) {
        extras.push(formatImageCaption(cached));
        continue;
      }
      if (imageCount >= MAX_SUMMARY_IMAGES) continue;
      imageCount += 1;
      const extracted = await extractUncachedMedia(file, {
        kind: 'image',
        extractionsById: cache,
        extract: caption,
        extractModel: captionModel,
        format: formatImageCaption,
        warnLabel: 'caption summary image',
      });
      if (extracted.line) extras.push(extracted.line);
    }
    const body = [text, ...stubs, ...extras].filter(Boolean).join('\n');
    if (!body) continue;
    lines.push(`${authorLabel(item)}: ${body}`);
  }
  return lines;
}

function chunkLines(lines, maxChars = CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const nextSize = size + line.length + (current.length ? 1 : 0);
    if (current.length && nextSize > maxChars) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

function shouldSummarizeClosedTicket(eventAction, ticket) {
  if (eventAction === 'TicketClosed') return true;
  return eventAction === 'TicketStatusSet' && String(ticket?.status || '') === 'Closed';
}

async function summarizeTranscript({
  db,
  chunks,
  settings,
  run,
  provider,
  model,
  ticket,
} = {}) {
  const system = getResolvedPrompt(db, 'ticket_summary', promptContextFromTicket(ticket));
  const resolvedModel = model || resolveAgentModel(settings, 'ticket_summary');
  const promptCacheKey = buildPromptCacheKey('ticket_summary');
  if (chunks.length <= 1) {
    const result = await run({
      provider,
      providerName: settings.provider,
      model: resolvedModel,
      system,
      messages: [{ role: 'user', content: chunks[0] || 'Сообщений нет.' }],
      tools: [],
      reasoningEffort: settings.reasoningEffort,
      promptCacheKey,
    });
    return truncateText(result.content, 4000);
  }

  const partials = [];
  for (const [index, chunk] of chunks.entries()) {
    const result = await run({
      provider,
      providerName: settings.provider,
      model: resolvedModel,
      system,
      messages: [
        {
          role: 'user',
          content: `Часть ${index + 1} из ${chunks.length}. Кратко перескажи только эту часть переписки:\n${chunk}`,
        },
      ],
      tools: [],
      reasoningEffort: settings.reasoningEffort,
      promptCacheKey,
    });
    const partial = truncateText(result.content, 2000);
    if (partial) partials.push(partial);
  }

  const result = await run({
    provider,
    providerName: settings.provider,
    model: resolvedModel,
    system,
    messages: [
      {
        role: 'user',
        content: `Объедини промежуточные сводки в одну краткую сводку обращения:\n${partials.join('\n\n')}`,
      },
    ],
    tools: [],
    reasoningEffort: settings.reasoningEffort,
    promptCacheKey,
  });
  return truncateText(result.content, 4000);
}

async function summarizeClosedTicket({ db, ticket, occurredAt, now, deps = {} } = {}) {
  if (!db || !ticket?.id) return { skipped: true, reason: 'missing-ticket' };
  if (hasSuccessfulTicketSummary(db, ticket.id)) {
    return { skipped: true, reason: 'already-done' };
  }

  const findTicket = deps.findTicketById || require('../integrations/regos-crm').findTicketById;
  const resolved = deps.ticket || ticket || (await findTicket(ticket.id));
  if (!resolved?.id) return { skipped: true, reason: 'ticket-not-found' };

  const chatId = String(resolved.chat_id || ticket.chat_id || '').trim();
  const period = resolveTicketMessagePeriod(resolved, { now, occurredAt });
  const clientId = resolveTicketClientId(resolved);
  const loadSettings = deps.loadAiSettings || loadAiSettings;
  const settings = loadSettings(db);
  const model = resolveAgentModel(settings, 'ticket_summary');

  const persist = (patch) =>
    upsertTicketSummary(db, {
      ticketId: resolved.id,
      clientId,
      chatId,
      periodStart: period.from,
      periodEnd: period.to,
      model,
      provider: settings.provider,
      ...patch,
    });

  try {
    let messages = [];
    if (chatId) {
      const fetchMessages = deps.fetchChatMessagesInPeriod || fetchChatMessagesInPeriod;
      messages = await fetchMessages(chatId, {
        from: period.from,
        to: period.to,
        getTicketMessages: deps.getTicketMessages,
      });
    }

    const fileIds = collectMessageFileIds(messages);
    let filesById = new Map();
    if (fileIds.length && chatId) {
      const getChatFilesByIds =
        deps.getChatFilesByIds || require('../integrations/regos-crm').getChatFilesByIds;
      const files = await getChatFilesByIds(chatId, fileIds);
      filesById = new Map((files || []).map((file) => [Number(file.id), file]));
    }

    const transcribeFn = deps.transcribeChatAudio || transcribeChatAudio;
    const captionFn = deps.captionChatImage || captionChatImage;
    const transcribe = (file, options = {}) =>
      transcribeFn(file, {
        db,
        ticketId: resolved.id,
        source: 'transcribe',
        ...options,
      });
    const caption = (file, options = {}) =>
      captionFn(file, {
        db,
        ticketId: resolved.id,
        source: 'caption',
        providerName: settings.provider,
        ...options,
      });
    const lines = await buildTranscriptLines(messages, {
      db,
      filesById,
      transcribe,
      transcribeModel: settings.transcribeModel,
      caption,
      captionModel: model,
    });
    if (!lines.length) {
      return {
        skipped: false,
        summary: persist({
          summary: EMPTY_SUMMARY,
          messageCount: 0,
          status: 'done',
          error: null,
        }),
      };
    }

    const chunks = chunkLines(
      lines,
      lines.join('\n').length > MAX_TRANSCRIPT_CHARS ? CHUNK_CHARS : MAX_TRANSCRIPT_CHARS
    );
    const run = deps.runAgent || runAgent;
    const provider = deps.provider || getProvider(settings.provider);
    const content = await summarizeTranscript({ db, chunks, settings, run, provider, model, ticket: resolved });
    const summary = String(content || '').trim() || EMPTY_SUMMARY;
    return {
      skipped: false,
      summary: persist({
        summary,
        messageCount: lines.length,
        status: 'done',
        error: null,
      }),
    };
  } catch (error) {
    const saved = persist({
      summary: '',
      messageCount: 0,
      status: 'error',
      error: error.message || 'summary_failed',
    });
    return { skipped: false, error: error.message || 'summary_failed', summary: saved };
  }
}

module.exports = {
  TICKET_SUMMARY_SYSTEM_PROMPT,
  EMPTY_SUMMARY,
  shouldSummarizeClosedTicket,
  summarizeClosedTicket,
  formatTranscriptLine,
  buildTranscriptLines,
};
