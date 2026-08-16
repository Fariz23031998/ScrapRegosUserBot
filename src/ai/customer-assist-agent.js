const { loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText, prependUserContext, buildPromptCacheKey } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { createCustomerTools } = require('./tools/customer');
const { filterEnabledTools } = require('./tools/catalog');
const { CUSTOMER_SYSTEM_PROMPT, CUSTOMER_ASSIST_PROMPT_SUFFIX } = require('./default-prompts');
const { getResolvedPrompt } = require('../db/ai-prompts');
const { listClientTicketSummaries } = require('../db/ticket-summaries');
const { knowledgeCategoryContext } = require('../db/knowledge-articles');
const { formatPriorSummariesForPrompt, resolveTicketClientId } = require('./ticket-period');
const { historyHasAudioTranscript, historyHasVisionParts } = require('./chat-media');
const { buildUploadedMessageContent, toModelHistory } = require('./chat-uploads');
const {
  loadCustomerAgentChatContext,
  formatMessageText,
  resolveAiAuthorUserId,
} = require('./customer-agent');
const {
  getOrCreateTicketAssistSession,
  listTicketAssistMessages,
  addTicketAssistMessage,
} = require('../db/ticket-assist-sessions');

const inflightSessions = new Set();

const CUSTOMER_ASSIST_SYSTEM_PROMPT = `${CUSTOMER_SYSTEM_PROMPT}
${CUSTOMER_ASSIST_PROMPT_SUFFIX}`;

function authorLabel(item) {
  const type = String(item?.author_entity_type || '');
  if (type === 'Client') return 'Клиент';
  if (type === 'ChatBot') return 'Бот';
  if (type === 'User') return 'Сотрудник';
  return type || 'Система';
}

function formatTicketChatSnapshot(messages, filesById) {
  const lines = [];
  for (const item of messages || []) {
    if (String(item.message_type || 'Regular') !== 'Regular') continue;
    const text = formatMessageText(item, filesById);
    if (!text) continue;
    lines.push(`${authorLabel(item)}: ${text}`);
  }
  return lines.join('\n');
}

function formatTicketMeta(ticket) {
  if (!ticket?.id) return '';
  const client = ticket.client || {};
  return [
    `Обращение #${ticket.id}.`,
    `Статус: ${ticket.status || '—'}.`,
    `Тема: ${ticket.subject || '—'}.`,
    `Клиент: ${client.name || '—'} (${client.phone || '—'}).`,
  ].join(' ');
}

function buildCustomerAssistSystemPrompt(db) {
  return [getResolvedPrompt(db, 'customer'), getResolvedPrompt(db, 'customer_assist')]
    .filter(Boolean)
    .join('\n\n');
}

function buildCustomerAssistContextContent(db, { ticket, chatSnapshot } = {}) {
  const parts = [];
  const meta = formatTicketMeta(ticket);
  if (meta) parts.push(meta);
  const summaries = formatPriorSummariesForPrompt(
    listClientTicketSummaries(db, resolveTicketClientId(ticket), { excludeTicketId: ticket?.id })
  );
  if (summaries) parts.push(summaries);
  if (chatSnapshot) {
    parts.push(`Текущая переписка обращения (клиент видит только её):\n${chatSnapshot}`);
  }
  parts.push(knowledgeCategoryContext(db));
  return parts.filter(Boolean).join('\n\n');
}

function serializeTicketAssistSession(db, session, extra = {}) {
  return {
    session_id: session.id,
    ticket_id: session.ticket_id,
    messages: listTicketAssistMessages(db, session.id),
    ...extra,
  };
}

async function loadTicketAssistSession({ db, userId, ticketId, sessionId, reset = false, deps = {} } = {}) {
  const findTicket = deps.findTicketById || require('../integrations/regos-crm').findTicketById;
  const ticket = await findTicket(ticketId);
  if (!ticket) {
    throw new Error('TICKET_NOT_FOUND');
  }
  const session = getOrCreateTicketAssistSession(db, {
    sessionId,
    userId,
    ticketId: ticket.id,
    reset,
  });
  return serializeTicketAssistSession(db, session);
}

function createReplyToCustomerTool({ ticket, chatId, deps = {}, onSent } = {}) {
  const addTicketMessage = deps.addTicketMessage || require('../integrations/regos-crm').addTicketMessage;
  const ensureParticipant =
    deps.ensureTicketParticipant || require('../integrations/regos-crm').ensureTicketParticipant;
  const isParticipant =
    deps.isTicketStaffParticipant || require('../integrations/regos-crm').isTicketStaffParticipant;

  return {
    name: 'reply_to_customer',
    description:
      'Post a message to the customer in the ticket chat. Use when the employee asked you to answer the client or gave enough guidance to send a customer-facing reply. Do not call this for private notes to the employee.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message the customer will see' },
      },
      required: ['text'],
    },
    execute: async ({ text } = {}) => {
      const reply = truncateText(text);
      if (!reply) return { ok: false, error: 'empty_text' };
      const id = String(chatId || ticket?.chat_id || '').trim();
      if (!id) return { ok: false, error: 'no-chat' };
      const authorEntityId = resolveAiAuthorUserId();
      if (!authorEntityId) return { ok: false, error: 'no-author' };
      if (!ticket?.id) return { ok: false, error: 'missing_ticket' };

      if (!isParticipant(ticket, authorEntityId)) {
        try {
          await ensureParticipant(ticket.id, authorEntityId);
        } catch (error) {
          return { ok: false, error: error.message || 'not-participant' };
        }
      }

      try {
        await addTicketMessage({
          chatId: id,
          text: reply,
          authorEntityType: 'User',
          authorEntityId,
        });
      } catch (error) {
        return { ok: false, error: error.message || 'send-failed' };
      }

      onSent?.(reply);
      return { ok: true, sent: true };
    },
  };
}

async function runTicketAssistAgent({
  db,
  userId,
  ticketId,
  sessionId,
  message,
  files = [],
  deps = {},
} = {}) {
  const text = String(message || '').trim();
  const uploads = Array.isArray(files) ? files : [];
  if (!text && uploads.length === 0) {
    throw new Error('EMPTY_MESSAGE');
  }

  const findTicket = deps.findTicketById || require('../integrations/regos-crm').findTicketById;
  const ticket = await findTicket(ticketId);
  if (!ticket) {
    throw new Error('TICKET_NOT_FOUND');
  }

  const session = getOrCreateTicketAssistSession(db, {
    sessionId,
    userId,
    ticketId: ticket.id,
  });
  const lockKey = String(session.id);
  if (inflightSessions.has(lockKey)) {
    throw new Error('SESSION_BUSY');
  }
  inflightSessions.add(lockKey);

  try {
    addTicketAssistMessage(db, session.id, {
      role: 'user',
      content: text,
      attachments: uploads,
    });

    const loadSettings = deps.loadAiSettings || loadAiSettings;
    const settings = loadSettings(db);
    const lastUserContent = await buildUploadedMessageContent(text, uploads, {
      transcribe: deps.transcribeChatAudio,
      transcribeModel: settings.transcribeModel,
    });
    const history = toModelHistory(listTicketAssistMessages(db, session.id), { lastUserContent });

    const run = deps.runAgent || runAgent;
    const provider = deps.provider || getProvider(settings.provider);
    const chatId = ticket.chat_id != null ? String(ticket.chat_id).trim() : '';

    let filesById = new Map();
    let chatSnapshot = '';
    if (chatId) {
      const context = await loadCustomerAgentChatContext({
        chatId,
        historyLimit: settings.historyLimit,
        ticket,
        deps,
      });
      filesById = context.filesById || new Map();
      chatSnapshot = formatTicketChatSnapshot(context.messages, filesById);
    }

    let repliedToCustomer = false;
    let customerReply = null;
    const tools = filterEnabledTools(
      [
        ...createCustomerTools({
          db,
          ticket,
          chatId,
          filesById,
          deps: { ...deps, transcribeModel: settings.transcribeModel },
        }),
        createReplyToCustomerTool({
          ticket,
          chatId,
          deps,
          onSent: (reply) => {
            repliedToCustomer = true;
            customerReply = reply;
          },
        }),
      ],
      settings.disabledAgentTools,
      'customer_assist',
    );

    const result = await run({
      provider,
      providerName: settings.provider,
      model: resolveAgentModel(settings, 'customer_assist'),
      system: buildCustomerAssistSystemPrompt(db),
      messages: prependUserContext(
        history,
        buildCustomerAssistContextContent(db, { ticket, chatSnapshot }),
      ),
      promptCacheKey: buildPromptCacheKey('customer_assist', ticket.id),
      tools,
      reasoningEffort: settings.reasoningEffort,
      hasVision: historyHasVisionParts(history),
      hasAudio: historyHasAudioTranscript(history),
    });

    const reply = truncateText(result.content) || 'Готово.';
    addTicketAssistMessage(db, session.id, { role: 'assistant', content: reply });
    return serializeTicketAssistSession(db, session, {
      reply,
      replied_to_customer: repliedToCustomer,
      customer_reply: customerReply,
    });
  } finally {
    inflightSessions.delete(lockKey);
  }
}

function resetTicketAssistLocks() {
  inflightSessions.clear();
}

module.exports = {
  CUSTOMER_ASSIST_SYSTEM_PROMPT,
  CUSTOMER_ASSIST_PROMPT_SUFFIX,
  buildCustomerAssistSystemPrompt,
  buildCustomerAssistContextContent,
  createReplyToCustomerTool,
  formatTicketChatSnapshot,
  loadTicketAssistSession,
  runTicketAssistAgent,
  resetTicketAssistLocks,
};
