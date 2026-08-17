const { listOrders } = require('../../db/partners-db');
const { getServicePricesCatalog } = require('../../db/service-prices');
const { listTechnicalSupportPrices, getActiveTechnicalSupportSubscription } = require('../../db/technical-support');
const { findEmployeesForAgent, getEmployeeForAgent } = require('./employees');
const { createKnowledgeTools } = require('./knowledge');
const { factoryToolDescription } = require('./descriptions');
const {
  classifyChatFile,
  collectMessageFileIds,
  compactChatFile,
  downloadChatFile,
  downloadChatFileBytes,
  isChatAudio,
  isVisionImage,
  toImageUrlPart,
} = require('../chat-media');
const { formatAudioTranscript, transcribeChatAudio } = require('../transcribe');
const { listClientTicketSummaries } = require('../../db/ticket-summaries');
const {
  fetchChatMessagesInPeriod,
  resolveTicketClientId,
  resolveTicketMessagePeriod,
} = require('../ticket-period');

function compactPrices(catalog) {
  return {
    title_ru: catalog?.title_ru || null,
    notice_ru: catalog?.notice_ru || null,
    categories: (catalog?.categories || []).map((category) => ({
      name_ru: category.name_ru,
      items: (category.items || []).map((item) => ({
        name_ru: item.name_ru,
        prices: item.prices || {
          fixed: item.price_fixed,
          min5: item.price_min5,
          min30: item.price_min30,
          hour1: item.price_hour1,
          hour2: item.price_hour2,
        },
      })),
    })),
  };
}

const TICKET_STATUS_ALIASES = new Map([
  ['open', 'Open'],
  ['открыт', 'Open'],
  ['closed', 'Closed'],
  ['закрыт', 'Closed'],
  ['waitingclient', 'WaitingClient'],
  ['ожидание клиента', 'WaitingClient'],
  ['waitingstaff', 'WaitingStaff'],
  ['ожидание сотрудника', 'WaitingStaff'],
]);

function normalizeTicketStatusArg(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return TICKET_STATUS_ALIASES.get(raw.toLowerCase()) || null;
}

function resolveAiAuthorUserIdFromEnv() {
  const raw = Number(process.env.AI_REGOS_AUTHOR_USER_ID);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function collectPositiveIds(value) {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function resolveRegosUserId(db, { employeeId, regosUserId } = {}) {
  let id = Number(regosUserId);
  if (!Number.isFinite(id) || id <= 0) {
    const employee = getEmployeeForAgent(db, employeeId);
    id = Number(employee?.regos_user_id);
  }
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resolveParticipantUserIds(db, { participant_employee_ids, participant_user_ids } = {}) {
  const ids = collectPositiveIds(participant_user_ids);
  const seen = new Set(ids);
  for (const employeeId of collectPositiveIds(participant_employee_ids)) {
    const regosId = resolveRegosUserId(db, { employeeId });
    if (!regosId) {
      return { error: 'missing_regos_user_id', employee_id: employeeId };
    }
    if (!seen.has(regosId)) {
      seen.add(regosId);
      ids.push(regosId);
    }
  }
  return { ids };
}

function formatChatMessage(message, filesById) {
  const fileIds = collectMessageFileIds([message]);
  const files = fileIds
    .map((id) => compactChatFile(filesById?.get(id) || { id }))
    .filter(Boolean);
  return {
    id: message.id,
    text: message.display_text || message.text || '',
    author_entity_type: message.author_entity_type || null,
    created_date: message.created_date ?? null,
    file_ids: fileIds,
    files,
  };
}

function createCustomerTools({
  db,
  ticket,
  chatId,
  filesById = new Map(),
  deps = {},
} = {}) {
  const searchUser = deps.searchUser || ((query) => require('../../bot/search-user').searchUser(query, db));
  const searchFirmAdmin =
    deps.searchFirmAdmin || ((query) => require('../../bot/search-user').searchFirmAdmin(query, db));
  const getTicketMessages = deps.getTicketMessages || require('../../integrations/regos-crm').getTicketMessages;
  const fetchMessages = deps.fetchChatMessagesInPeriod || fetchChatMessagesInPeriod;
  const setTicketResponsible =
    deps.setTicketResponsible || require('../../integrations/regos-crm').setTicketResponsible;
  const setTicketStatus = deps.setTicketStatus || require('../../integrations/regos-crm').setTicketStatus;
  const editTicket = deps.editTicket || require('../../integrations/regos-crm').editTicket;
  const setTicketParticipants =
    deps.setTicketParticipants || require('../../integrations/regos-crm').setTicketParticipants;
  const resolveAiAuthorUserId =
    typeof deps.resolveAiAuthorUserId === 'function' ? deps.resolveAiAuthorUserId : resolveAiAuthorUserIdFromEnv;
  const onTicketClose = typeof deps.onTicketClose === 'function' ? deps.onTicketClose : null;
  const getChatFilesByIds = deps.getChatFilesByIds || require('../../integrations/regos-crm').getChatFilesByIds;
  const download = deps.downloadChatFile || downloadChatFile;
  const downloadBytes = deps.downloadChatFileBytes || downloadChatFileBytes;
  const transcribe = deps.transcribeChatAudio || transcribeChatAudio;
  const transcribeModel = deps.transcribeModel || null;
  const notifyEmployee =
    deps.notifyEmployee || ((args) => require('./notify-employee').notifyEmployee(db, args));
  const listGroupTopics =
    deps.listGroupTopics || (() => require('./notify-group').listAgentGroupTopics(db));
  const notifyGroupTopic =
    deps.notifyGroupTopic || ((args) => require('./notify-group').notifyGroupTopic(db, args));

  async function lookupClientFirm(text) {
    try {
      const userResult = await searchUser(text);
      if (userResult && userResult.ok !== false && (userResult.found || userResult.result || userResult.message)) {
        return userResult;
      }
    } catch (error) {
      if (!error) return { ok: false, error: 'search_failed' };
    }
    try {
      return await searchFirmAdmin(text);
    } catch (error) {
      return { ok: false, error: error.message || 'search_failed' };
    }
  }

  const tools = createKnowledgeTools({ db, write: false, deps });

  tools.push(
    {
      name: 'search_chat_history',
      description: factoryToolDescription('search_chat_history'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional text filter' },
          include_other_tickets: { type: 'boolean' },
        },
      },
      execute: async ({ query, include_other_tickets } = {}) => {
        const period = resolveTicketMessagePeriod(ticket);
        const pages = [];
        if (chatId) {
          const messages = await fetchMessages(chatId, {
            from: period.from,
            to: period.to,
            stopAfter: 40,
            getTicketMessages,
          });
          pages.push(...messages);
        }
        const resolved = new Map(filesById);
        const missingIds = collectMessageFileIds(pages).filter((id) => !resolved.has(id));
        if (missingIds.length && chatId) {
          const fetched = await getChatFilesByIds(chatId, missingIds);
          for (const file of fetched || []) {
            resolved.set(Number(file.id), file);
          }
        }
        const needle = String(query || '').trim().toLowerCase();
        const messages = pages
          .map((message) => formatChatMessage(message, resolved))
          .filter((message) => {
            if (!needle) return true;
            const haystack = [
              message.text,
              ...(message.files || []).map((file) => file.name),
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(needle);
          });
        const result = { messages: messages.slice(-40) };
        if (include_other_tickets) {
          const summaries = listClientTicketSummaries(db, resolveTicketClientId(ticket), {
            excludeTicketId: ticket?.id,
          }).filter((item) => {
            if (!needle) return true;
            return String(item.summary || '').toLowerCase().includes(needle);
          });
          result.other_ticket_summaries = summaries.map((item) => ({
            ticket_id: item.ticket_id,
            summary: item.summary,
            period_start: item.period_start,
            period_end: item.period_end,
          }));
        }
        return result;
      },
    },
    {
      name: 'search_orders',
      description: factoryToolDescription('search_orders'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          client_phone: { type: 'string' },
        },
      },
      execute: async ({ query, client_phone } = {}) => {
        const phone = client_phone || ticket?.client?.phone || null;
        const result = listOrders(db, {
          query,
          clientPhone: phone,
          limit: 10,
        });
        return {
          total: result.total,
          orders: (result.orders || []).map((order) => ({
            id: order.id,
            status: order.status,
            amount: order.amount,
            currency: order.currency,
            client_phone: order.client_phone,
            payment_provider: order.payment_provider,
            created_at: order.created_at,
            ticket_id: order.ticket_id ?? null,
          })),
        };
      },
    },
    {
      name: 'search_client',
      description: factoryToolDescription('search_client'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      execute: async ({ query }) => {
        const text = String(query || ticket?.client?.phone || '').trim();
        if (!text) return { ok: false, error: 'empty_query' };
        return lookupClientFirm(text);
      },
    },
    {
      name: 'get_client_firm',
      description: factoryToolDescription('get_client_firm'),
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        const phone = String(ticket?.client?.phone || '').trim();
        if (!phone) return { ok: false, error: 'missing_phone' };
        const result = await lookupClientFirm(phone);
        if (result && typeof result === 'object') {
          return { ...result, phone };
        }
        return { ok: false, error: 'search_failed', phone };
      },
    },
    {
      name: 'get_prices',
      description: factoryToolDescription('get_prices'),
      parameters: {
        type: 'object',
        properties: {
          include_support: { type: 'boolean' },
        },
      },
      execute: async ({ include_support } = {}) => {
        const catalog = compactPrices(getServicePricesCatalog(db));
        const supportPrices = listTechnicalSupportPrices(db);
        let subscription = null;
        if (include_support !== false && ticket?.client?.phone) {
          subscription = getActiveTechnicalSupportSubscription(db, ticket.client.phone);
        }
        return { catalog, support_prices: supportPrices, technical_support: subscription };
      },
    },
    {
      name: 'get_employee',
      description: factoryToolDescription('get_employee'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          job_title: { type: 'string' },
        },
      },
      execute: async ({ query, job_title } = {}) => ({
        employees: findEmployeesForAgent(db, { query, jobTitle: job_title }),
      }),
    },
    {
      name: 'notify_employee',
      description: factoryToolDescription('notify_employee'),
      parameters: {
        type: 'object',
        properties: {
          employee_id: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['employee_id', 'message'],
      },
      execute: async ({ employee_id, message }) =>
        notifyEmployee({
          employeeId: employee_id,
          message,
          ticketId: ticket?.id ?? null,
          client: ticket?.client || null,
        }),
    },
    {
      name: 'list_group_topics',
      description: factoryToolDescription('list_group_topics'),
      parameters: { type: 'object', properties: {} },
      execute: async () => listGroupTopics(),
    },
    {
      name: 'send_group_topic_message',
      description: factoryToolDescription('send_group_topic_message'),
      parameters: {
        type: 'object',
        properties: {
          topic_key: { type: 'string', description: 'Topic key from list_group_topics' },
          message: { type: 'string' },
        },
        required: ['topic_key', 'message'],
      },
      execute: async ({ topic_key, message }) =>
        notifyGroupTopic({
          topicKey: topic_key,
          message,
          ticketId: ticket?.id ?? null,
          client: ticket?.client || null,
        }),
    },
    {
      name: 'assign_responsible',
      description: factoryToolDescription('assign_responsible'),
      parameters: {
        type: 'object',
        properties: {
          employee_id: { type: 'number' },
          regos_user_id: { type: 'number' },
        },
      },
      execute: async ({ employee_id, regos_user_id } = {}) => {
        let regosUserId = Number(regos_user_id);
        if (!Number.isFinite(regosUserId) || regosUserId <= 0) {
          const employee = getEmployeeForAgent(db, employee_id);
          regosUserId = Number(employee?.regos_user_id);
        }
        if (!Number.isFinite(regosUserId) || regosUserId <= 0) {
          return { ok: false, error: 'missing_regos_user_id' };
        }
        if (!ticket?.id) return { ok: false, error: 'missing_ticket' };
        await setTicketResponsible(ticket.id, regosUserId);
        return { ok: true, responsible_user_id: regosUserId };
      },
    },
    {
      name: 'close_ticket',
      description: factoryToolDescription('close_ticket'),
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        if (!ticket?.id) return { ok: false, error: 'missing_ticket' };
        if (String(ticket.status || '') === 'Closed') return { ok: true, already_closed: true };
        if (onTicketClose) {
          onTicketClose();
          return { ok: true, status: 'Closed' };
        }
        await setTicketStatus(ticket.id, 'Closed');
        return { ok: true, status: 'Closed' };
      },
    },
    {
      name: 'update_ticket',
      description: factoryToolDescription('update_ticket'),
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Ticket subject, max 300 characters' },
          description: { type: 'string', description: 'Ticket description' },
          status: {
            type: 'string',
            description:
              'Open, WaitingClient, WaitingStaff, or Closed. Russian labels (Открыт, Ожидание клиента, Ожидание сотрудника, Закрыт) are also accepted.',
          },
          employee_id: { type: 'number', description: 'Bot employee id; resolved to REGOS user via get_employee' },
          responsible_user_id: { type: 'number', description: 'REGOS user id for the responsible' },
          participant_employee_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'Bot employee ids; replaces the participant list after resolving to REGOS users',
          },
          participant_user_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'REGOS user ids; replaces the participant list',
          },
        },
      },
      execute: async (args = {}) => {
        if (!ticket?.id) return { ok: false, error: 'missing_ticket' };
        const input = args && typeof args === 'object' ? args : {};
        const hasSubject = Object.hasOwn(input, 'subject');
        const hasDescription = Object.hasOwn(input, 'description');
        const hasStatus = Object.hasOwn(input, 'status');
        const hasResponsible =
          Object.hasOwn(input, 'employee_id') ||
          Object.hasOwn(input, 'responsible_user_id') ||
          Object.hasOwn(input, 'regos_user_id');
        const hasParticipants =
          Object.hasOwn(input, 'participant_employee_ids') || Object.hasOwn(input, 'participant_user_ids');
        if (!hasSubject && !hasDescription && !hasStatus && !hasResponsible && !hasParticipants) {
          return { ok: false, error: 'no_fields' };
        }

        let status = null;
        if (hasStatus) {
          status = normalizeTicketStatusArg(input.status);
          if (!status) return { ok: false, error: 'invalid_status' };
        }

        let responsibleUserId = null;
        if (hasResponsible) {
          responsibleUserId = resolveRegosUserId(db, {
            employeeId: input.employee_id,
            regosUserId: input.responsible_user_id ?? input.regos_user_id,
          });
          if (!responsibleUserId) return { ok: false, error: 'missing_regos_user_id' };
        }

        let participantIds = null;
        if (hasParticipants) {
          const resolved = resolveParticipantUserIds(db, input);
          if (resolved.error) {
            return { ok: false, error: resolved.error, employee_id: resolved.employee_id };
          }
          participantIds = [...resolved.ids];
          const aiAuthorId = resolveAiAuthorUserId();
          if (aiAuthorId && !participantIds.includes(aiAuthorId)) participantIds.push(aiAuthorId);
        }

        try {
          const changed = {};
          if (hasSubject || hasDescription) {
            const scalarChanges = {};
            if (hasSubject) scalarChanges.subject = input.subject;
            if (hasDescription) scalarChanges.description = input.description;
            await editTicket(ticket.id, scalarChanges);
            if (hasSubject) changed.subject = String(input.subject ?? '').trim();
            if (hasDescription) changed.description = String(input.description ?? '').trim();
          }
          if (hasResponsible) {
            await setTicketResponsible(ticket.id, responsibleUserId);
            changed.responsible_user_id = responsibleUserId;
          }
          if (hasStatus) {
            if (status === 'Closed' && String(ticket.status || '') === 'Closed') {
              changed.status = 'Closed';
            } else if (status === 'Closed' && onTicketClose) {
              onTicketClose();
              changed.status = 'Closed';
            } else {
              await setTicketStatus(ticket.id, status);
              changed.status = status;
            }
          }
          if (hasParticipants) {
            await setTicketParticipants(ticket.id, participantIds, { replaceMode: true });
            changed.participant_user_ids = participantIds;
          }
          return { ok: true, changed };
        } catch (error) {
          return { ok: false, error: error.message || 'update_failed' };
        }
      },
    },
    {
      name: 'read_chat_image',
      description: factoryToolDescription('read_chat_image'),
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: ['integer', 'number', 'string'],
            description: 'Chat file id from history or search_chat_history',
          },
        },
        required: ['file_id'],
      },
      execute: async ({ file_id } = {}) => {
        const id = Number(file_id);
        if (!Number.isFinite(id) || id <= 0) {
          return { ok: false, error: 'invalid_file_id' };
        }
        let file = filesById.get(id);
        if (!file && chatId) {
          const fetched = await getChatFilesByIds(chatId, [id]);
          file = fetched?.[0] || null;
          if (file) filesById.set(Number(file.id), file);
        }
        if (!file) return { ok: false, error: 'not_found' };
        if (!isVisionImage(file)) {
          return {
            ok: false,
            error: 'not_an_image',
            kind: classifyChatFile(file),
            file: compactChatFile(file),
          };
        }
        const downloaded = await download(file);
        if (!downloaded?.base64) {
          return {
            ok: false,
            error: downloaded?.reason || 'download_failed',
            file: compactChatFile(file),
          };
        }
        const part = toImageUrlPart(downloaded);
        return {
          ok: true,
          file: compactChatFile(file),
          _visionParts: part ? [part] : [],
        };
      },
    },
    {
      name: 'transcribe_chat_audio',
      description: factoryToolDescription('transcribe_chat_audio'),
      parameters: {
        type: 'object',
        properties: {
          file_id: {
            type: ['integer', 'number', 'string'],
            description: 'Chat file id from history or search_chat_history',
          },
        },
        required: ['file_id'],
      },
      execute: async ({ file_id } = {}) => {
        const id = Number(file_id);
        if (!Number.isFinite(id) || id <= 0) {
          return { ok: false, error: 'invalid_file_id' };
        }
        let file = filesById.get(id);
        if (!file && chatId) {
          const fetched = await getChatFilesByIds(chatId, [id]);
          file = fetched?.[0] || null;
          if (file) filesById.set(Number(file.id), file);
        }
        if (!file) return { ok: false, error: 'not_found' };
        if (!isChatAudio(file)) {
          return {
            ok: false,
            error: 'not_audio',
            kind: classifyChatFile(file),
            file: compactChatFile(file),
          };
        }
        const result = await transcribe(file, {
          model: transcribeModel,
          downloadBytes,
          db,
          ticketId: ticket?.id ?? null,
          source: 'tool',
        });
        if (!result?.text) {
          return {
            ok: false,
            error: result?.reason || 'transcribe_failed',
            file: compactChatFile(file),
          };
        }
        return {
          ok: true,
          text: result.text,
          file: compactChatFile(file),
        };
      },
    }
  );

  return tools;
}

module.exports = {
  createCustomerTools,
  compactPrices,
};
