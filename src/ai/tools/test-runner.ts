import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { isKnownAgentTool, listAgentToolCatalog } from './catalog';
import { getDefaultToolDescription } from './descriptions';
import { getStoredToolDescription } from '../../db/ai-tool-descriptions';
import { createKnowledgeTools } from './knowledge';
import { createCustomerTools } from './customer';
import { createOpsTools } from './ops';
import { createReplyToCustomerTool } from '../customer-assist-agent';

const TICKET_REQUIRED_TOOLS: Set<any> = new Set([
  'search_chat_history',
  'read_chat_image',
  'transcribe_chat_audio',
  'get_client_firm',
  'assign_responsible',
  'close_ticket',
  'update_ticket',
  'reply_to_customer',
]);

function toolRequiresTicket(name?: any) {
  return TICKET_REQUIRED_TOOLS.has(String(name || ''));
}

function buildAgentTools({ db, ticket = null, chatId = null, filesById = new Map(), deps = {} }: Unchecked = {}) {
  const byName: Map<any, any> = new Map();

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

  const { createSearchToolsTool } = (require('./search-tools') as typeof import('./search-tools'));
  if (!byName.has('search_tools')) {
    const search = createSearchToolsTool({
      agentSlug: 'customer',
      getToolPool: () => [...byName.values()],
    });
    byName.set(search.name, search);
  }

  return [...byName.values()];
}

function listToolSchemas({ db = null, deps = {} }: Unchecked = {}) {
  const catalogByName: Map<any, any> = new Map(listAgentToolCatalog().map((tool?: any) => [tool.name, tool]));
  const tools = buildAgentTools({ db, deps });
  return tools
    .filter((tool?: any) => isKnownAgentTool(tool.name))
    .map((tool?: any) => {
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
    .sort((a?: any, b?: any) => String(a.name).localeCompare(String(b.name)));
}

async function resolveTicketContext({ ticketId, deps = {} }: Unchecked = {}) {
  const id = Number(ticketId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'ticket_required', message: 'Укажите ID обращения.' };
  }

  const findTicket = deps.findTicketById || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).findTicketById;
  const ticket = await findTicket(id);
  if (!ticket?.id) {
    return { ok: false, error: 'ticket_not_found', message: 'Обращение не найдено.' };
  }

  const chatId = String(ticket.chat_id || '').trim() || null;
  return { ok: true, ticket, chatId, filesById: new Map() };
}

async function runAgentToolTest({ db, toolName, args = {}, ticketId = null, deps = {} }: Unchecked = {}) {
  const name = String(toolName || '').trim();
  if (!isKnownAgentTool(name)) {
    return { ok: false, error: 'unknown_tool', message: 'Неизвестный инструмент.' };
  }

  let ticket: any = null;
  let chatId: any = null;
  let filesById: Map<any, any> = new Map();

  if (toolRequiresTicket(name) || ticketId != null && String(ticketId).trim() !== '') {
    if (toolRequiresTicket(name) && (ticketId == null || String(ticketId).trim() === '')) {
      return { ok: false, error: 'ticket_required', message: 'Для этого инструмента нужен ID обращения.' };
    }
    if (ticketId != null && String(ticketId).trim() !== '') {
      const context = await resolveTicketContext({ ticketId, deps });
      if (!context.ok) return context;
      ticket = context.ticket;
      chatId = context.chatId;
      filesById = context.filesById!;
    }
  }

  const tools = buildAgentTools({ db, ticket, chatId, filesById, deps });
  const tool = tools.find((item?: any) => item.name === name);
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
  } catch (error: any) {
    return {
      ok: false,
      error: 'execute_failed',
      message: error?.message || 'Ошибка выполнения инструмента.',
      tool: name,
      duration_ms: Date.now() - started,
    };
  }
}

export {
  TICKET_REQUIRED_TOOLS,
  toolRequiresTicket,
  buildAgentTools,
  listToolSchemas,
  runAgentToolTest,
};
