import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { listOrders } from '../../db/partners-db';
import { getServicePricesCatalog } from '../../db/service-prices';
import { listTechnicalSupportPrices, getActiveTechnicalSupportSubscription } from '../../db/technical-support';
import { findEmployeesForAgent } from './employees';
import { customerTicketTools } from './customer-ticket-tools';
import { createKnowledgeTools } from './knowledge';
import { factoryToolDescription } from './descriptions';
import { classifyChatFile, collectMessageFileIds, compactChatFile, downloadChatFile, downloadChatFileBytes, isChatAudio, isVisionImage, toImageUrlPart } from '../chat-media';
import { formatAudioTranscript, transcribeChatAudio } from '../transcribe';
import { listClientTicketSummaries } from '../../db/ticket-summaries';
import { fetchChatMessagesInPeriod, resolveTicketClientId, resolveTicketMessagePeriod } from '../ticket-period';
function compactPrices(catalog?: any) {
  return {
    title_ru: catalog?.title_ru || null,
    notice_ru: catalog?.notice_ru || null,
    categories: (catalog?.categories || []).map((category?: any) => ({
      name_ru: category.name_ru,
      items: (category.items || []).map((item?: any) => ({
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

function resolveAiAuthorUserIdFromEnv() {
  const raw = Number(process.env.AI_REGOS_AUTHOR_USER_ID);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function formatChatMessage(message?: any, filesById?: any) {
  const fileIds = collectMessageFileIds([message]);
  const files = fileIds
    .map((id?: any) => compactChatFile(filesById?.get(id) || { id }))
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
}: Unchecked = {}) {
  const searchUser = deps.searchUser || ((query?: any) => (require('../../bot/search-user') as typeof import('../../bot/search-user')).searchUser(query, db));
  const searchFirmAdmin =
    deps.searchFirmAdmin || ((query?: any) => (require('../../bot/search-user') as typeof import('../../bot/search-user')).searchFirmAdmin(query, db));
  const getTicketMessages = deps.getTicketMessages || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).getTicketMessages;
  const fetchMessages = deps.fetchChatMessagesInPeriod || fetchChatMessagesInPeriod;
  const setTicketResponsible =
    deps.setTicketResponsible || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).setTicketResponsible;
  const setTicketStatus = deps.setTicketStatus || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).setTicketStatus;
  const editTicket = deps.editTicket || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).editTicket;
  const setTicketParticipants =
    deps.setTicketParticipants || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).setTicketParticipants;
  const resolveAiAuthorUserId =
    typeof deps.resolveAiAuthorUserId === 'function' ? deps.resolveAiAuthorUserId : resolveAiAuthorUserIdFromEnv;
  const onTicketClose = typeof deps.onTicketClose === 'function' ? deps.onTicketClose : null;
  const getChatFilesByIds = deps.getChatFilesByIds || (require('../../integrations/regos-crm') as typeof import('../../integrations/regos-crm')).getChatFilesByIds;
  const download = deps.downloadChatFile || downloadChatFile;
  const downloadBytes = deps.downloadChatFileBytes || downloadChatFileBytes;
  const transcribe = deps.transcribeChatAudio || transcribeChatAudio;
  const transcribeModel = deps.transcribeModel || null;
  const notifyEmployee =
    deps.notifyEmployee || ((args?: any) => (require('./notify-employee') as typeof import('./notify-employee')).notifyEmployee(db, args));
  const listGroupTopics =
    deps.listGroupTopics || (() => (require('./notify-group') as typeof import('./notify-group')).listAgentGroupTopics(db));
  const notifyGroupTopic =
    deps.notifyGroupTopic || ((args?: any) => (require('./notify-group') as typeof import('./notify-group')).notifyGroupTopic(db, args));

  async function lookupClientFirm(text?: any) {
    try {
      const userResult = await searchUser(text);
      if (userResult && userResult.ok !== false && (userResult.found || userResult.result || userResult.message)) {
        return userResult;
      }
    } catch (error: any) {
      if (!error) return { ok: false, error: 'search_failed' };
    }
    try {
      return await searchFirmAdmin(text);
    } catch (error: any) {
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
      execute: async ({ query, include_other_tickets }: Unchecked = {}) => {
        const period = resolveTicketMessagePeriod(ticket);
        const pages: any[] = [];
        if (chatId) {
          const messages = await fetchMessages(chatId, {
            from: period.from,
            to: period.to,
            stopAfter: 40,
            getTicketMessages,
          });
          pages.push(...messages);
        }
        const resolved: Map<any, any> = new Map(filesById);
        const missingIds = collectMessageFileIds(pages).filter((id?: any) => !resolved.has(id));
        if (missingIds.length && chatId) {
          const fetched = await getChatFilesByIds(chatId, missingIds);
          for (const file of fetched || []) {
            resolved.set(Number(file.id), file);
          }
        }
        const needle = String(query || '').trim().toLowerCase();
        const messages = pages
          .map((message?: any) => formatChatMessage(message, resolved))
          .filter((message?: any) => {
            if (!needle) return true;
            const haystack = [
              message.text,
              ...(message.files || []).map((file?: any) => file.name),
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(needle);
          });
        const result: Unchecked = { messages: messages.slice(-40) };
        if (include_other_tickets) {
          const summaries = listClientTicketSummaries(db, resolveTicketClientId(ticket), {
            excludeTicketId: ticket?.id,
          }).filter((item?: any) => {
            if (!needle) return true;
            return String(item.summary || '').toLowerCase().includes(needle);
          });
          result.other_ticket_summaries = summaries.map((item?: any) => ({
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
      execute: async ({ query, client_phone }: Unchecked = {}) => {
        const phone = client_phone || ticket?.client?.phone || null;
        const result = listOrders(db, {
          query,
          clientPhone: phone,
          limit: 10,
        });
        return {
          total: result.total,
          orders: (result.orders || []).map((order?: any) => ({
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
      execute: async ({ query }: Unchecked) => {
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
      execute: async ({ include_support }: Unchecked = {}) => {
        const catalog = compactPrices(getServicePricesCatalog(db));
        const supportPrices = listTechnicalSupportPrices(db);
        let subscription: any = null;
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
      execute: async ({ query, job_title }: Unchecked = {}) => ({
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
      execute: async ({ employee_id, message }: Unchecked) =>
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
      execute: async ({ topic_key, message }: Unchecked) =>
        notifyGroupTopic({
          topicKey: topic_key,
          message,
          ticketId: ticket?.id ?? null,
          client: ticket?.client || null,
        }),
    },
    ...customerTicketTools({
      db,
      ticket,
      setTicketResponsible,
      setTicketStatus,
      editTicket,
      setTicketParticipants,
      resolveAiAuthorUserId,
      onTicketClose,
    }),
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
      execute: async ({ file_id }: Unchecked = {}) => {
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
      execute: async ({ file_id }: Unchecked = {}) => {
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

export { createCustomerTools, compactPrices };
