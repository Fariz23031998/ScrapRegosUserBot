const { isKnownAgentTool, listAgentToolCatalog } = require('./catalog');
const { getDefaultToolDescription } = require('./descriptions');
const { getStoredToolDescription } = require('../../db/ai-tool-descriptions');
const { createKnowledgeTools } = require('./knowledge');
const { createCustomerTools } = require('./customer');
const { createOpsTools } = require('./ops');
const { createReplyToCustomerTool } = require('../customer-assist-agent');

const TICKET_REQUIRED_TOOLS = new Set([
  'search_chat_history',
  'read_chat_image',
  'transcribe_chat_audio',
  'get_client_firm',
  'assign_responsible',
  'close_ticket',
  'update_ticket',
  'reply_to_customer',
]);

function toolRequiresTicket(name) {
  return TICKET_REQUIRED_TOOLS.has(String(name || ''));
}

function buildAgentTools({ db, ticket = null, chatId = null, filesById = new Map(), deps = {} } = {}) {
  const byName = new Map();

  for (const tool of createCustomerTools({ db, ticket, chatId, filesById, deps })) {
    byName.set(tool.name, tool);
  }
  // Prefer writable KB tools so create/update/delete are available in the test console.
  for (const tool of createKnowledgeTools({ db, write: true, deps })) {
    byName.set(tool.name, tool);
  }
  for (const tool of createOpsTools({ db, write: true, viewer: { seeAll: true, userId: null }, deps })) {
    byName.set(tool.name, tool);
  }

  const reply = createReplyToCustomerTool({ ticket, chatId, deps });
  byName.set(reply.name, reply);

  return [...byName.values()];
}

function listToolSchemas({ db = null, deps = {} } = {}) {
  const catalogByName = new Map(listAgentToolCatalog().map((tool) => [tool.name, tool]));
  const tools = buildAgentTools({ db, deps });
  return tools
    .filter((tool) => isKnownAgentTool(tool.name))
    .map((tool) => {
      const meta = catalogByName.get(tool.name) || {};
      const stored = db ? getStoredToolDescription(db, tool.name) : '';
      return {
        name: tool.name,
        title: meta.title || tool.name,
        description: stored || getDefaultToolDescription(tool.name) || tool.description || '',
        agents: meta.agents || [],
        parameters: tool.parameters || { type: 'object', properties: {} },
        requires_ticket: toolRequiresTicket(tool.name),
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function resolveTicketContext({ ticketId, deps = {} } = {}) {
  const id = Number(ticketId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'ticket_required', message: 'Укажите ID обращения.' };
  }

  const findTicket = deps.findTicketById || require('../../integrations/regos-crm').findTicketById;
  const ticket = await findTicket(id);
  if (!ticket?.id) {
    return { ok: false, error: 'ticket_not_found', message: 'Обращение не найдено.' };
  }

  const chatId = String(ticket.chat_id || '').trim() || null;
  return { ok: true, ticket, chatId, filesById: new Map() };
}

async function runAgentToolTest({ db, toolName, args = {}, ticketId = null, deps = {} } = {}) {
  const name = String(toolName || '').trim();
  if (!isKnownAgentTool(name)) {
    return { ok: false, error: 'unknown_tool', message: 'Неизвестный инструмент.' };
  }

  let ticket = null;
  let chatId = null;
  let filesById = new Map();

  if (toolRequiresTicket(name) || ticketId != null && String(ticketId).trim() !== '') {
    if (toolRequiresTicket(name) && (ticketId == null || String(ticketId).trim() === '')) {
      return { ok: false, error: 'ticket_required', message: 'Для этого инструмента нужен ID обращения.' };
    }
    if (ticketId != null && String(ticketId).trim() !== '') {
      const context = await resolveTicketContext({ ticketId, deps });
      if (!context.ok) return context;
      ticket = context.ticket;
      chatId = context.chatId;
      filesById = context.filesById;
    }
  }

  const tools = buildAgentTools({ db, ticket, chatId, filesById, deps });
  const tool = tools.find((item) => item.name === name);
  if (!tool?.execute) {
    return { ok: false, error: 'tool_unavailable', message: 'Инструмент недоступен для запуска.' };
  }

  const started = Date.now();
  try {
    const result = await tool.execute(args && typeof args === 'object' ? args : {});
    return {
      ok: true,
      tool: name,
      result,
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      error: 'execute_failed',
      message: error?.message || 'Ошибка выполнения инструмента.',
      tool: name,
      duration_ms: Date.now() - started,
    };
  }
}

module.exports = {
  TICKET_REQUIRED_TOOLS,
  toolRequiresTicket,
  buildAgentTools,
  listToolSchemas,
  runAgentToolTest,
};
