const {
  loadTelegramTicketSettings,
  isTelegramTicketConfigured,
  DEFAULT_SUBJECT,
  MAX_SUBJECT_LENGTH,
} = require('./telegram-ticket-settings');
const { resolveRegosClient } = require('./regos-client-resolve');
const {
  getTelegramTicketSession,
  upsertTelegramTicketSession,
  clearTelegramTicketSession,
} = require('../db/telegram-ticket-sessions');
const {
  RegosCrmError,
  createTicket,
  findTicketById,
  setTicketParticipants,
  normalizeParticipantUserIds,
  addTicketMessage,
  ensureTicketParticipant,
  getTicketMessages,
} = require('../integrations/regos-crm');
const {
  handleCustomerChatMessage,
  markCustomerMessageProcessed,
  resolveAiAuthorUserId,
} = require('../ai/customer-agent');
const { setBotUserRegosClientId } = require('../db/bot-users-db');
const { sendChatActionSafe } = require('./telegram-safe');
const {
  classifyTelegramMedia,
  uploadTelegramAttachments,
} = require('./telegram-ticket-media');

const OPEN_TICKET_STATUSES = new Set(['Open', 'WaitingClient', 'WaitingStaff']);
const SUPPORT_NOT_CONFIGURED_TEXT =
  'Обращения временно недоступны. Отправьте /my_unpaid_orders для проверки заказов.';
const COULD_NOT_CREATE_APPEAL_TEXT =
  'Не удалось создать обращение. Попробуйте позже или отправьте /my_unpaid_orders для проверки заказов.';
const ASK_TEXT_ONLY_TEXT = 'Пожалуйста, опишите вопрос текстом.';
const VIDEO_NOT_SUPPORTED_TEXT =
  'Видео не принимаются. Отправьте фото или голосовое сообщение.';
const MEDIA_UPLOAD_FAILED_TEXT =
  'Не удалось загрузить файл. Попробуйте ещё раз или отправьте текст.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSubject(text, fallback = DEFAULT_SUBJECT) {
  const subject = String(text || '').trim() || fallback;
  if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  return `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
}

function resolveAiAuthorId(deps = {}) {
  if (typeof deps.resolveAiAuthorUserId === 'function') {
    return deps.resolveAiAuthorUserId();
  }
  return resolveAiAuthorUserId();
}

function buildParticipantIds(settings, deps = {}) {
  const ids = normalizeParticipantUserIds(settings.participantUserIds || []);
  const aiAuthorId = resolveAiAuthorId(deps);
  if (aiAuthorId && !ids.includes(aiAuthorId)) {
    ids.push(aiAuthorId);
  }
  return ids;
}

async function waitForTicketChat(ticketId, { findTicket, retries = 5, delayMs = 400 } = {}) {
  const find = findTicket || findTicketById;
  let ticket = await find(ticketId);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (ticket?.chat_id) return ticket;
    await sleep(delayMs);
    ticket = await find(ticketId);
  }
  return ticket;
}

async function resolvePostedMessageId({ chatId, postedId, fileIds, deps = {} } = {}) {
  if (postedId) return String(postedId);
  const getMessages = deps.getTicketMessages || getTicketMessages;
  try {
    const page = await getMessages(chatId, { limit: 10 });
    const list = Array.isArray(page?.result) ? page.result : [];
    const wanted = new Set((Array.isArray(fileIds) ? fileIds : []).map((id) => String(id)));
    const clients = list.filter((item) => String(item?.author_entity_type || '') === 'Client');
    if (wanted.size) {
      const match = [...clients].reverse().find((item) =>
        (Array.isArray(item.file_ids) ? item.file_ids : []).some((id) => wanted.has(String(id)))
      );
      if (match?.id != null) return String(match.id);
    }
    const last = clients.at(-1);
    return last?.id != null ? String(last.id) : null;
  } catch (error) {
    console.warn('[telegram-ticket] could not resolve posted message id:', error?.message || error);
    return null;
  }
}

async function postCustomerQuestionMessage({
  chatId,
  clientId,
  text,
  fileIds,
  deps = {},
}) {
  const addMessage = deps.addTicketMessage || addTicketMessage;
  const attachedIds = Array.isArray(fileIds) ? fileIds : [];
  try {
    const posted = await addMessage({
      chatId,
      text,
      fileIds: attachedIds,
      messageType: 'Regular',
      authorEntityType: 'Client',
      authorEntityId: clientId,
    });
    return { ...posted, asClient: true };
  } catch (error) {
    console.warn(
      '[telegram-ticket] Client author rejected, posting as User:',
      error?.message || error
    );
    const aiAuthorId = resolveAiAuthorId(deps);
    const fallbackText = String(text || '').trim()
      ? `Сообщение из Telegram:\n${text}`
      : 'Сообщение из Telegram';
    const posted = await addMessage({
      chatId,
      text: fallbackText,
      fileIds: attachedIds,
      messageType: 'Regular',
      authorEntityType: 'User',
      authorEntityId: aiAuthorId || undefined,
    });
    return { ...posted, asClient: false };
  }
}

async function ensureOpenTicket({
  db,
  telegramId,
  client,
  questionText,
  settings,
  deps = {},
}) {
  const findTicket = deps.findTicketById || findTicketById;
  const create = deps.createTicket || createTicket;
  const setParticipants = deps.setTicketParticipants || setTicketParticipants;
  const ensureParticipant = deps.ensureTicketParticipant || ensureTicketParticipant;

  const session = getTelegramTicketSession(db, telegramId);
  if (session?.ticketId) {
    const existing = await findTicket(session.ticketId);
    if (existing && OPEN_TICKET_STATUSES.has(String(existing.status || ''))) {
      const chatId = existing.chat_id || session.chatId;
      if (chatId) {
        upsertTelegramTicketSession(db, {
          telegramId,
          ticketId: existing.id,
          chatId,
          clientId: existing.client_id ?? client.id,
        });
        return { ticket: { ...existing, chat_id: chatId }, reused: true };
      }
    }
    clearTelegramTicketSession(db, telegramId);
  }

  const subject = settings.subject || DEFAULT_SUBJECT;
  const created = await create({
    client_id: client.id,
    channel_id: settings.channelId,
    direction: settings.direction || 'Inbound',
    subject,
    description: String(questionText || '').trim(),
    responsible_user_id: settings.responsibleUserId || undefined,
  });

  const participantIds = buildParticipantIds(settings, deps);
  if (participantIds.length) {
    try {
      await setParticipants(created.id, participantIds, { replaceMode: true });
    } catch (error) {
      console.warn('[telegram-ticket] setParticipants failed:', error?.message || error);
      for (const userId of participantIds) {
        try {
          await ensureParticipant(created.id, userId);
        } catch (inner) {
          console.warn(
            `[telegram-ticket] ensureParticipant ${userId} failed:`,
            inner?.message || inner
          );
        }
      }
    }
  }

  const ticket = await waitForTicketChat(created.id, { findTicket: findTicket });
  if (!ticket?.chat_id) {
    throw new RegosCrmError('Тикет создан, но чат ещё не готов.', {
      code: 'CHAT_NOT_READY',
      status: 502,
    });
  }

  upsertTelegramTicketSession(db, {
    telegramId,
    ticketId: ticket.id,
    chatId: ticket.chat_id,
    clientId: ticket.client_id ?? client.id,
  });

  return { ticket, reused: false };
}

/**
 * Handle a support question from a registered Telegram customer.
 * Returns true when the message was consumed (including error replies).
 */
async function handleCustomerQuestionMessage(bot, msg, botUser, db, deps = {}) {
  const media = classifyTelegramMedia(msg);
  if (media.status === 'empty') {
    return false;
  }

  const loadSettings = deps.loadTelegramTicketSettings || loadTelegramTicketSettings;
  const settings = loadSettings(db);

  if (!settings.enabled) {
    return false;
  }
  if (media.status === 'video') {
    await bot.sendMessage(msg.chat.id, VIDEO_NOT_SUPPORTED_TEXT);
    return true;
  }
  if (media.status === 'unsupported') {
    await bot.sendMessage(msg.chat.id, ASK_TEXT_ONLY_TEXT);
    return true;
  }
  if (!isTelegramTicketConfigured(settings)) {
    await bot.sendMessage(msg.chat.id, SUPPORT_NOT_CONFIGURED_TEXT);
    return true;
  }

  const text = media.text || '';
  const questionText = text || media.fallbackText || 'Сообщение из Telegram';

  await sendChatActionSafe(bot, msg.chat.id);

  try {
    const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim();
    const { client } = await resolveRegosClient({
      phone: botUser.phone,
      displayName: displayName || botUser.phone,
      settings,
      storedClientId: botUser.regos_client_id,
      deps,
    });
    if (!client?.id) {
      await bot.sendMessage(msg.chat.id, COULD_NOT_CREATE_APPEAL_TEXT);
      return true;
    }
    if (botUser.id && Number(botUser.regos_client_id) !== Number(client.id)) {
      try {
        const setClientId = deps.setBotUserRegosClientId || setBotUserRegosClientId;
        setClientId(db, botUser.id, client.id);
      } catch (error) {
        console.warn('[telegram-ticket] setBotUserRegosClientId failed:', error?.message || error);
      }
    }

    const { ticket } = await ensureOpenTicket({
      db,
      telegramId: msg.from.id,
      client,
      questionText,
      settings,
      deps,
    });

    let fileIds = [];
    if (media.attachments?.length) {
      try {
        const upload = deps.uploadTelegramAttachments || uploadTelegramAttachments;
        fileIds = await upload({
          bot,
          chatId: ticket.chat_id,
          attachments: media.attachments,
          deps,
        });
        if (!fileIds.length) {
          throw new Error('no-file-ids');
        }
      } catch (error) {
        console.error('[telegram-ticket] media upload failed:', error);
        await bot.sendMessage(msg.chat.id, MEDIA_UPLOAD_FAILED_TEXT);
        return true;
      }
    }

    const posted = await postCustomerQuestionMessage({
      chatId: ticket.chat_id,
      clientId: client.id,
      text,
      fileIds,
      deps,
    });

    const messageId = await resolvePostedMessageId({
      chatId: ticket.chat_id,
      postedId: posted?.id || null,
      fileIds,
      deps,
    });
    const markProcessed = deps.markCustomerMessageProcessed || markCustomerMessageProcessed;

    const runAgent = deps.handleCustomerChatMessage || handleCustomerChatMessage;
    let agentResult = null;
    try {
      agentResult = await runAgent({
        db,
        chatId: ticket.chat_id,
        messageId,
        forceHandle: true,
        payload: {
          id: messageId,
          text: text || questionText,
          display_text: text || questionText,
          author_entity_type: 'Client',
          author_entity_id: client.id,
          message_type: 'Regular',
          file_ids: fileIds,
        },
        deps: {
          ...deps,
          findTicketByChatId:
            deps.findTicketByChatId ||
            (async () => ({
              ...ticket,
              client: ticket.client || client,
            })),
        },
      });
    } catch (error) {
      console.error('[telegram-ticket] customer agent failed:', error);
    }

    if (messageId && agentResult?.handled) {
      markProcessed(ticket.chat_id, messageId, db);
    }

    if (agentResult?.handled && agentResult.reply && !agentResult.telegram_sent) {
      await bot.sendMessage(msg.chat.id, agentResult.reply);
    } else if (agentResult && !agentResult.handled) {
      console.info(
        `[telegram-ticket] customer agent skipped: ${agentResult.reason} ticket=${ticket.id}`
      );
    }

    if (agentResult?.closed) {
      clearTelegramTicketSession(db, msg.from.id);
    }

    return true;
  } catch (error) {
    console.error('[telegram-ticket] handleCustomerQuestionMessage failed:', error);
    await bot.sendMessage(msg.chat.id, COULD_NOT_CREATE_APPEAL_TEXT);
    return true;
  }
}

module.exports = {
  handleCustomerQuestionMessage,
  resolveRegosClient,
  ensureOpenTicket,
  postCustomerQuestionMessage,
  resolvePostedMessageId,
  waitForTicketChat,
  buildParticipantIds,
  OPEN_TICKET_STATUSES,
  SUPPORT_NOT_CONFIGURED_TEXT,
  COULD_NOT_CREATE_APPEAL_TEXT,
  ASK_TEXT_ONLY_TEXT,
  VIDEO_NOT_SUPPORTED_TEXT,
  MEDIA_UPLOAD_FAILED_TEXT,
  trimSubject,
};
