const { loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText, buildPromptCacheKey } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { createCustomerTools } = require('./tools/customer');
const { filterEnabledTools } = require('./tools/catalog');
const { CUSTOMER_SYSTEM_PROMPT, CUSTOMER_TEST_PROMPT_SUFFIX } = require('./default-prompts');
const { getResolvedPrompt } = require('../db/ai-prompts');
const { historyHasAudioTranscript, historyHasVisionParts } = require('./chat-media');
const { buildUploadedMessageContent, toModelHistory } = require('./chat-uploads');
const {
  getOrCreateCustomerTestSession,
  updateCustomerTestSession,
  listCustomerTestMessages,
  addCustomerTestMessage,
} = require('../db/customer-agent-sessions');

const inflightSessions = new Set();

const CUSTOMER_TEST_SYSTEM_PROMPT = `${CUSTOMER_SYSTEM_PROMPT}
${CUSTOMER_TEST_PROMPT_SUFFIX}`;

function buildCustomerTestSystemPrompt(db) {
  return `${getResolvedPrompt(db, 'customer')}
${CUSTOMER_TEST_PROMPT_SUFFIX}`;
}

function buildSyntheticTicket({ clientPhone } = {}) {
  const phone = String(clientPhone || '').trim() || null;
  return {
    id: null,
    status: 'Open',
    subject: 'Тестовый чат агента поддержки',
    chat_id: null,
    client_id: null,
    client: {
      id: null,
      name: 'Тестовый клиент',
      phone,
    },
  };
}

function applyClientPhone(ticket, clientPhone) {
  const phone = String(clientPhone || '').trim();
  if (!phone || !ticket) return ticket;
  return {
    ...ticket,
    client: {
      ...(ticket.client || {}),
      phone,
    },
  };
}

function mapTestTicketContext(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id ?? null,
    status: ticket.status || null,
    subject: ticket.subject || null,
    chat_id: ticket.chat_id || null,
    client_id: ticket.client_id ?? null,
    client: ticket.client
      ? {
          id: ticket.client.id ?? null,
          name: ticket.client.name || null,
          phone: ticket.client.phone || null,
        }
      : null,
  };
}

function sessionMessagesAsChat(messages) {
  return (messages || []).map((item, index) => ({
    id: String(item.id || index + 1),
    text: item.content,
    display_text: item.content,
    author_entity_type: item.role === 'assistant' ? 'ChatBot' : 'Client',
    message_type: 'Regular',
    created_date: item.created_at || null,
  }));
}

async function resolveTestTicket({ ticketId, clientPhone, deps = {} } = {}) {
  const id = Number(ticketId);
  if (Number.isFinite(id) && id > 0) {
    const findTicket = deps.findTicketById || require('../integrations/regos-crm').findTicketById;
    const ticket = await findTicket(id);
    if (!ticket) {
      throw new Error('TICKET_NOT_FOUND');
    }
    return applyClientPhone(ticket, clientPhone || ticket.client?.phone);
  }
  return buildSyntheticTicket({ clientPhone });
}

function serializeCustomerTestSession(db, session, ticket = null) {
  return {
    session_id: session.id,
    ticket_id: session.ticket_id,
    client_phone: session.client_phone,
    ticket: mapTestTicketContext(ticket),
    messages: listCustomerTestMessages(db, session.id),
  };
}

async function loadCustomerTestSession({
  db,
  userId,
  sessionId,
  ticketId,
  clientPhone,
  reset = false,
  requireTicket = true,
  deps = {},
} = {}) {
  let session = getOrCreateCustomerTestSession(db, {
    sessionId,
    userId,
    ticketId,
    clientPhone,
    reset,
  });
  if (ticketId !== undefined || clientPhone !== undefined) {
    session =
      updateCustomerTestSession(db, session.id, {
        ticketId: ticketId === undefined ? session.ticket_id : ticketId,
        clientPhone: clientPhone === undefined ? session.client_phone : clientPhone,
      }) || session;
  }
  let ticket = null;
  try {
    ticket = await resolveTestTicket({
      ticketId: session.ticket_id,
      clientPhone: session.client_phone,
      deps,
    });
  } catch (error) {
    if (error.message !== 'TICKET_NOT_FOUND' || requireTicket) {
      throw error;
    }
    ticket = buildSyntheticTicket({ clientPhone: session.client_phone });
  }
  return serializeCustomerTestSession(db, session, ticket);
}

async function runCustomerTestAgent({
  db,
  userId,
  sessionId,
  message,
  files = [],
  ticketId,
  clientPhone,
  deps = {},
} = {}) {
  const text = String(message || '').trim();
  const uploads = Array.isArray(files) ? files : [];
  if (!text && uploads.length === 0) {
    throw new Error('EMPTY_MESSAGE');
  }

  let session = getOrCreateCustomerTestSession(db, {
    sessionId,
    userId,
    ticketId,
    clientPhone,
  });
  if (ticketId !== undefined || clientPhone !== undefined) {
    session =
      updateCustomerTestSession(db, session.id, {
        ticketId: ticketId === undefined ? session.ticket_id : ticketId,
        clientPhone: clientPhone === undefined ? session.client_phone : clientPhone,
      }) || session;
  }

  const lockKey = String(session.id);
  if (inflightSessions.has(lockKey)) {
    throw new Error('SESSION_BUSY');
  }
  inflightSessions.add(lockKey);

  try {
    const ticket = await resolveTestTicket({
      ticketId: session.ticket_id,
      clientPhone: session.client_phone,
      deps,
    });
    addCustomerTestMessage(db, session.id, {
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
    const history = toModelHistory(listCustomerTestMessages(db, session.id), { lastUserContent });

    const run = deps.runAgent || runAgent;
    const provider = deps.provider || getProvider(settings.provider);
    const realGetTicketMessages =
      deps.getTicketMessages || require('../integrations/regos-crm').getTicketMessages;
    const sandboxChatId = `test:${session.id}`;
    const chatId = ticket?.chat_id || sandboxChatId;

    const result = await run({
      provider,
      providerName: settings.provider,
      model: resolveAgentModel(settings, 'customer'),
      system: buildCustomerTestSystemPrompt(db),
      messages: history,
      promptCacheKey: buildPromptCacheKey('customer_test', session.id),
      reasoningEffort: settings.reasoningEffort,
      hasVision: historyHasVisionParts(history),
      hasAudio: historyHasAudioTranscript(history),
      tools: filterEnabledTools(
        createCustomerTools({
          db,
          ticket,
          chatId,
          deps: {
            ...deps,
            transcribeModel: settings.transcribeModel,
            getTicketMessages: async (requestedChatId, options) => {
              if (ticket?.chat_id && String(requestedChatId) === String(ticket.chat_id)) {
                return realGetTicketMessages(requestedChatId, options);
              }
              const messages = listCustomerTestMessages(db, session.id);
              return {
                ok: true,
                result: sessionMessagesAsChat(messages),
                total: messages.length,
              };
            },
            notifyEmployee: async (args) => ({
              ok: true,
              employee_id: args.employeeId ?? args.employee_id ?? null,
              display_name: 'Тестовый сотрудник',
              ticket_id: ticket?.id ?? null,
            }),
            notifyGroupTopic: async (args) => ({
              ok: true,
              topic_key: args.topicKey ?? args.topic_key ?? null,
              topic_name: 'Тестовая тема',
              ticket_id: ticket?.id ?? null,
            }),
            setTicketResponsible: async (id, regosUserId) => ({
              ok: true,
              ticket_id: id,
              responsible_user_id: regosUserId,
            }),
          },
        }),
        settings.disabledTools,
      ),
    });

    const reply = truncateText(result.content) || 'Готово.';
    addCustomerTestMessage(db, session.id, { role: 'assistant', content: reply });
    return {
      ...serializeCustomerTestSession(db, session, ticket),
      reply,
    };
  } finally {
    inflightSessions.delete(lockKey);
  }
}

function resetCustomerTestLocks() {
  inflightSessions.clear();
}

module.exports = {
  CUSTOMER_TEST_SYSTEM_PROMPT,
  buildCustomerTestSystemPrompt,
  buildSyntheticTicket,
  mapTestTicketContext,
  loadCustomerTestSession,
  runCustomerTestAgent,
  resetCustomerTestLocks,
};
