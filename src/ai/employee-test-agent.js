const { loadAiSettings, resolveAgentModel } = require('./settings');
const { runAgent, truncateText, prependUserContext, buildPromptCacheKey } = require('./run-agent');
const { getProvider } = require('./providers/registry');
const { EMPLOYEE_TEST_PROMPT_SUFFIX } = require('./default-prompts');
const { historyHasAudioTranscript, historyHasVisionParts } = require('./chat-media');
const { buildUploadedMessageContent, toModelHistory } = require('./chat-uploads');
const { loadCustomerAgentChatContext } = require('./customer-agent');
const { factoryToolDescription } = require('./tools/descriptions');
const {
  buildCustomerAssistSystemPrompt,
  buildCustomerAssistContextContent,
  formatTicketChatSnapshot,
} = require('./customer-assist-agent');
const {
  buildSyntheticTicket,
  resolveTestTicket,
  sessionMessagesAsChat,
  serializeAgentTools,
  buildTestAgentRunSnapshot,
  createCustomerTestSandboxTools,
  serializeCustomerTestSession,
} = require('./customer-test-agent');
const {
  getOrCreateCustomerTestSession,
  updateCustomerTestSession,
  listCustomerTestMessages,
  addCustomerTestMessage,
} = require('../db/customer-agent-sessions');

const inflightSessions = new Set();

function buildEmployeeTestSystemPrompt(db, ticket) {
  return `${buildCustomerAssistSystemPrompt(db, ticket)}
${EMPLOYEE_TEST_PROMPT_SUFFIX}`;
}

function createSimulatedReplyToCustomerTool({ onSent } = {}) {
  return {
    name: 'reply_to_customer',
    description: factoryToolDescription('reply_to_customer'),
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

function buildEmployeeTestPrompt(db, ticket, { sessionId, deps = {} } = {}) {
  const settings = (deps.loadAiSettings || loadAiSettings)(db);
  const tools = createCustomerTestSandboxTools({
    db,
    ticket,
    sessionId,
    chatId: ticket?.chat_id || (sessionId ? `employee-test:${sessionId}` : 'employee-test:preview'),
    deps,
    extraTools: [createSimulatedReplyToCustomerTool()],
    agentSlug: 'customer_assist',
  });
  return {
    system: buildEmployeeTestSystemPrompt(db, ticket),
    tools: serializeAgentTools(tools),
    model: resolveAgentModel(settings, 'customer_assist'),
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
  allowAnyUser = false,
  deps = {},
} = {}) {
  let session = getOrCreateCustomerTestSession(db, {
    sessionId,
    userId,
    ticketId,
    clientPhone,
    agentKind: 'employee',
    reset,
    allowAnyUser,
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
  return serializeCustomerTestSession(db, session, ticket, {
    prompt: buildEmployeeTestPrompt(db, ticket, { sessionId: session.id, deps }),
  });
}

async function runEmployeeTestAgent({
  db,
  userId,
  sessionId,
  message,
  files = [],
  ticketId,
  clientPhone,
  allowAnyUser = false,
  deps = {},
  onDelta,
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
    allowAnyUser,
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
    const system = buildEmployeeTestSystemPrompt(db, ticket);
    const modelMessages = prependUserContext(
      history,
      buildCustomerAssistContextContent(db, { ticket, chatSnapshot })
    );
    const tools = createCustomerTestSandboxTools({
      db,
      ticket,
      sessionId: session.id,
      chatId,
      filesById,
      deps: { ...deps, transcribeModel: settings.transcribeModel },
      extraTools: [
        createSimulatedReplyToCustomerTool({
          onSent: (reply) => {
            repliedToCustomer = true;
            customerReply = reply;
          },
        }),
      ],
      agentSlug: 'customer_assist',
    });

    const result = await run({
      provider,
      providerName: settings.provider,
      model: resolveAgentModel(settings, 'customer_assist'),
      system,
      messages: modelMessages,
      promptCacheKey: buildPromptCacheKey('employee_test', session.id),
      reasoningEffort: settings.reasoningEffort,
      hasVision: historyHasVisionParts(history),
      hasAudio: historyHasAudioTranscript(history),
      tools,
      onDelta,
    });

    const reply = truncateText(result.content) || 'Готово.';
    const snapshot = buildTestAgentRunSnapshot({
      system,
      messages: modelMessages,
      tools,
      result,
      extra: {
        replied_to_customer: repliedToCustomer,
        customer_reply: customerReply,
      },
    });
    addCustomerTestMessage(db, session.id, { role: 'assistant', content: reply, run: snapshot });
    return {
      ...serializeCustomerTestSession(db, session, ticket, {
        prompt: {
          system,
          tools: serializeAgentTools(tools),
          model: resolveAgentModel(settings, 'customer_assist'),
        },
      }),
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
  buildEmployeeTestPrompt,
  loadEmployeeTestSession,
  runEmployeeTestAgent,
  resetEmployeeTestLocks,
};
