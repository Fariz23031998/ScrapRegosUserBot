const { listOrders } = require('../../db/partners-db');
const { getServicePricesCatalog } = require('../../db/service-prices');
const { listTechnicalSupportPrices, getActiveTechnicalSupportSubscription } = require('../../db/technical-support');
const { findEmployeesForAgent, getEmployeeForAgent } = require('./employees');
const { createKnowledgeTools } = require('./knowledge');
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

  const tools = createKnowledgeTools({ db, write: false, deps });

  tools.push(
    {
      name: 'search_chat_history',
      description:
        'Read recent messages from the current ticket period. Set include_other_tickets=true to also return saved summaries of earlier tickets for this client.',
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
      description: 'Search local payment orders by client phone or free text.',
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
      description: 'Look up a client/firm in billing portals by phone, login, INN, or name.',
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
        try {
          const userResult = await searchUser(text);
          if (userResult && userResult.ok !== false && (userResult.found || userResult.result || userResult.message)) {
            return userResult;
          }
        } catch (error) {
          // Fall through to firm search.
          if (!error) return { ok: false, error: 'search_failed' };
        }
        try {
          return await searchFirmAdmin(text);
        } catch (error) {
          return { ok: false, error: error.message || 'search_failed' };
        }
      },
    },
    {
      name: 'get_prices',
      description: 'Load the service price catalog and technical-support subscription prices. Optionally include the client TP subscription.',
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
      description:
        'Find an employee by name, phone, or job title (for example «менеджер по продажам»). Returns description and whether they can be notified in Telegram.',
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
      description:
        'Send a Telegram message to an employee, for example to forward a customer request to a sales manager. Use get_employee first.',
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
        }),
    },
    {
      name: 'list_group_topics',
      description:
        'List internal Telegram group topics the agent may post to. Use this to pick a topic_key before send_group_topic_message.',
      parameters: { type: 'object', properties: {} },
      execute: async () => listGroupTopics(),
    },
    {
      name: 'send_group_topic_message',
      description:
        'Post a message to an internal staff Telegram group topic (urgent help, KKM, new clients, field visits). Do not use this instead of answering the client. Call list_group_topics first if you are unsure which topic_key to use.',
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
        }),
    },
    {
      name: 'assign_responsible',
      description: 'Assign a REGOS user as the ticket responsible. The employee must have regos_user_id.',
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
      name: 'read_chat_image',
      description:
        'Load a chat image by file_id so you can see it. Use for older screenshots listed as [изображение: … #id]. Does not work for audio or video.',
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
      description:
        'Transcribe a chat voice or audio file by file_id. Use for older voice notes listed as [аудио: … #id]. Does not work for images or video.',
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
