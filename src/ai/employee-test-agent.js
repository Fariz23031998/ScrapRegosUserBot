const { loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText, prependUserContext, buildPromptCacheKey } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { createCustomerTools } = require('./tools/customer');
const { filterEnabledTools } = require('./tools/catalog');
const { EMPLOYEE_TEST_PROMPT_SUFFIX } = require('./default-prompts');
const { historyHasAudioTranscript, historyHasVisionParts } = require('./chat-media');
const { buildUploadedMessageContent, toModelHistory } = require('./chat-uploads');
const {
  loadCustomerAgentChatContext,
} = require('./customer-agent');
const {
  buildCustomerAssistSystemPrompt,
  buildCustomerAssistContextContent,
  formatTicketChatSnapshot,
} = require('./customer-assist-agent');
const {
  buildSyntheticTicket,
  mapTestTicketContext,
  resolveTestTicket,
  sessionMessagesAsChat,
  serializeCustomerTestSession,
} = require('./customer-test-agent');
const {
  getOrCreateCustomerTestSession,
  updateCustomerTestSession,
  listCustomerTestMessages,
  addCustomerTestMessage,
} = require('../db/customer-agent-sessions');

const inflightSessions = new Set();

function buildEmployeeTestSystemPrompt(db) {
  return `${buildCustomerAssistSystemPrompt(db)}
${EMPLOYEE_TEST_PROMPT_SUFFIX}`;
}

function createSimulatedReplyToCustomerTool({ onSent } = {}) {
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
      onSent?.(reply);
      return { ok: true, sent: true, simulated: true };
    },
  };
}

async function loadEmployeeTestSession({
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
    agentKind: 'employee',
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
      subject: 'Тестовый чат агента сотрудника',
      deps,
    });
  } catch (error) {
    if (error.message !== 'TICKET_NOT_FOUND' || requireTicket) {
      throw error;
    }
    ticket = buildSyntheticTicket({
      clientPhone: session.client_phone,
      subject: 'Тестовый чат агента сотрудника',
    });
  }
  return serializeCustomerTestSession(db, session, ticket);
}

async function runEmployeeTestAgent({
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
    agentKind: 'employee',
  });
  if (ticketId !== undefined || clientPhone !== undefined) {
    session =
      updateCustomerTestSession(db, session.id, {
        ticketId: ticketId === undefined ? session.ticket_id : ticketId,
        clientPhone: clientPhone === undefined ? session.client_phone : clientPhone,
      }) || session;
  }

  const lockKey = `employee:${session.id}`;
  if (inflightSessions.has(lockKey)) {
    throw new Error('SESSION_BUSY');
  }
  inflightSessions.add(lockKey);

  try {
    const ticket = await resolveTestTicket({
      ticketId: session.ticket_id,
      clientPhone: session.client_phone,
      subject: 'Тестовый чат агента сотрудника',
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
    const sandboxChatId = `employee-test:${session.id}`;
    const chatId = ticket?.chat_id || sandboxChatId;

    let filesById = new Map();
    let chatSnapshot = '';
    if (ticket?.chat_id) {
      const context = await loadCustomerAgentChatContext({
        chatId: String(ticket.chat_id),
        historyLimit: settings.historyLimit,
        ticket,
        deps,
      });
      filesById = context.filesById || new Map();
      chatSnapshot = formatTicketChatSnapshot(context.messages, filesById);
    } else {
      chatSnapshot = formatTicketChatSnapshot(
        sessionMessagesAsChat(listCustomerTestMessages(db, session.id)),
        filesById
      );
    }

    let repliedToCustomer = false;
    let customerReply = null;

    const result = await run({
      provider,
      providerName: settings.provider,
      model: resolveAgentModel(settings, 'customer_assist'),
      system: buildEmployeeTestSystemPrompt(db),
      messages: prependUserContext(
        history,
        buildCustomerAssistContextContent(db, { ticket, chatSnapshot })
      ),
      promptCacheKey: buildPromptCacheKey('employee_test', session.id),
      reasoningEffort: settings.reasoningEffort,
      hasVision: historyHasVisionParts(history),
      hasAudio: historyHasAudioTranscript(history),
      tools: filterEnabledTools(
        [
          ...createCustomerTools({
            db,
            ticket,
            chatId,
            filesById,
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
              setTicketStatus: async (id, status) => ({
                ok: true,
                ticket_id: id,
                status,
              }),
            },
          }),
          createSimulatedReplyToCustomerTool({
            onSent: (reply) => {
              repliedToCustomer = true;
              customerReply = reply;
            },
          }),
        ],
        settings.disabledTools
      ),
    });

    const reply = truncateText(result.content) || 'Готово.';
    addCustomerTestMessage(db, session.id, { role: 'assistant', content: reply });
    return {
      ...serializeCustomerTestSession(db, session, ticket),
      reply,
      replied_to_customer: repliedToCustomer,
      customer_reply: customerReply,
      steps: result.steps ?? null,
      usage: result.usage ?? null,
      stopped: result.stopped ?? null,
      trace: Array.isArray(result.trace) ? result.trace : [],
    };
  } finally {
    inflightSessions.delete(lockKey);
  }
}

function resetEmployeeTestLocks() {
  inflightSessions.clear();
}

module.exports = {
  EMPLOYEE_TEST_PROMPT_SUFFIX,
  buildEmployeeTestSystemPrompt,
  createSimulatedReplyToCustomerTool,
  loadEmployeeTestSession,
  runEmployeeTestAgent,
  resetEmployeeTestLocks,
};
