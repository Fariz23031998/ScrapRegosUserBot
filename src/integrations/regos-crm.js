const DEFAULT_API_TARGET = 'https://integration.regos.uz';
const PAGE_LIMIT = 100;
const DEFAULT_DUPLICATE_INTERVAL_MINUTES = 10;

class RegosCrmError extends Error {
  constructor(message, { code = 'REGOS_ERROR', status = 502 } = {}) {
    super(message);
    this.name = 'RegosCrmError';
    this.code = code;
    this.status = status;
  }
}

function getIntegrationToken() {
  const token = String(process.env.REGOS_INTEGRATION_TOKEN || '').trim();
  if (!token) {
    throw new RegosCrmError(
      'REGOS_INTEGRATION_TOKEN не задан. Укажите токен в .env и перезапустите сервер.',
      { code: 'TOKEN_MISSING', status: 503 }
    );
  }
  return token;
}

function getApiTarget() {
  const base = String(process.env.REGOS_API_TARGET || '').trim();
  return (base || DEFAULT_API_TARGET).replace(/\/$/, '');
}

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
  };
  const bearer = String(process.env.REGOS_BEARER_TOKEN || '').trim();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return headers;
}

async function postRegosRaw(endpoint, request) {
  const token = getIntegrationToken();
  const url = `${getApiTarget()}/gateway/out/${token}/v1/${endpoint}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(request ?? {}),
    });
  } catch (error) {
    throw new RegosCrmError(
      `Не удалось связаться с REGOS API: ${error.message || error}`,
      { code: 'NETWORK', status: 502 }
    );
  }

  if (!response.ok) {
    throw new RegosCrmError(`REGOS API вернул код статуса ${response.status}`, {
      code: 'HTTP_STATUS',
      status: 502,
    });
  }

  const data = await response.json().catch(() => ({}));

  if (!data.ok) {
    const err = data.result && typeof data.result === 'object' ? data.result : {};
    const code = err.error || 'Unknown';
    const desc = err.description || 'Unknown error';
    throw new RegosCrmError(`Ошибка REGOS API: ${code} - ${desc}`, {
      code: 'API_ERROR',
      status: 502,
    });
  }

  return data;
}

async function postRegos(endpoint, request) {
  const data = await postRegosRaw(endpoint, request);

  if (!Array.isArray(data.result)) {
    throw new RegosCrmError(
      `Некорректный ответ REGOS API ${endpoint}: ожидался массив`,
      { code: 'BAD_RESPONSE', status: 502 }
    );
  }

  return {
    ok: true,
    result: data.result,
    next_offset: data.next_offset ?? 0,
    total: data.total ?? data.result.length,
  };
}

/** For Regos mutators that return an object result (e.g. `{ new_id }`). */
async function postRegosMutation(endpoint, request) {
  const data = await postRegosRaw(endpoint, request);

  if (data.result == null || typeof data.result !== 'object' || Array.isArray(data.result)) {
    throw new RegosCrmError(
      `Некорректный ответ REGOS API ${endpoint}: ожидался объект`,
      { code: 'BAD_RESPONSE', status: 502 }
    );
  }

  return {
    ok: true,
    result: data.result,
  };
}

async function postTicketGet(request) {
  return postRegos('Ticket/Get', request);
}

async function postUserGet(request = {}) {
  return postRegos('User/Get', request);
}

async function postChannelGet(request = {}) {
  return postRegos('Channel/Get', request);
}

async function postChatGet(request = {}) {
  return postRegos('Chat/Get', request);
}

async function postChatMessageGet(request = {}) {
  return postRegos('ChatMessage/Get', request);
}

const DEFAULT_CHAT_MESSAGE_LIMIT = 50;

function sortChatMessagesAscending(messages) {
  return [...(messages || [])].sort((a, b) => {
    const dateA = Number(a?.created_date) || 0;
    const dateB = Number(b?.created_date) || 0;
    if (dateA !== dateB) return dateA - dateB;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

/**
 * Load chat messages for a ticket chat UUID (ChatMessage/Get).
 * Always returns messages sorted by created_date ascending for chat-style display.
 */
async function getTicketMessages(
  chatId,
  { limit = DEFAULT_CHAT_MESSAGE_LIMIT, offset = 0, includeStaffPrivate = true } = {}
) {
  const id = String(chatId || '').trim();
  if (!id) {
    return { ok: true, result: [], next_offset: 0, total: 0, offset: 0 };
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || DEFAULT_CHAT_MESSAGE_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const page = await postChatMessageGet({
    filters: [{ Field: 'chat_id', Operator: 'equal', Value: id }],
    limit: safeLimit,
    offset: safeOffset,
    include_staff_private: Boolean(includeStaffPrivate),
  });

  return {
    ok: true,
    result: sortChatMessagesAscending(page.result),
    next_offset: page.next_offset ?? safeOffset + page.result.length,
    total: page.total ?? page.result.length,
    offset: safeOffset,
  };
}

/**
 * Send a text message to a ticket chat (ChatMessage/Add).
 * For Ticket-linked chats Regos requires a linked-entity participant author;
 * pass authorEntityId (Regos User id) of the staff member sending the reply.
 */
async function addTicketMessage({
  chatId,
  text,
  messageType = 'Regular',
  replyId,
  fileIds,
  authorEntityId,
  authorEntityType = 'User',
} = {}) {
  const id = String(chatId || '').trim();
  if (!id) {
    throw new RegosCrmError('Не указан chat_id.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const messageText = String(text || '').trim();
  if (!messageText) {
    throw new RegosCrmError('Текст сообщения не может быть пустым.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const request = {
    chat_id: id,
    message_type: messageType || 'Regular',
    text: messageText,
  };
  if (replyId != null && String(replyId).trim()) {
    request.reply_id = String(replyId).trim();
  }
  if (Array.isArray(fileIds) && fileIds.length > 0) {
    request.file_ids = fileIds;
  }

  const authorId = Number(authorEntityId);
  if (Number.isFinite(authorId) && authorId > 0) {
    request.author_entity_type = authorEntityType || 'User';
    request.author_entity_id = authorId;
  }

  try {
    const data = await postRegosMutation('ChatMessage/Add', request);
    return {
      ok: true,
      id: data.result.new_id != null ? String(data.result.new_id) : null,
      result: data.result,
    };
  } catch (error) {
    if (
      error instanceof RegosCrmError &&
      /1007|linked-entity participants|недостаточно привилегий/i.test(error.message)
    ) {
      throw new RegosCrmError(
        'REGOS отклонил отправку: интеграция не может писать в чат тикета от своего имени. ' +
          'Нужен связанный пользователь REGOS у сотрудника (author), право chat_manage_all (688) ' +
          'у интеграции, и этот пользователь должен быть участником/ответственным тикета ' +
          '(как при ответе в regos.online). ' +
          `Исходная ошибка: ${error.message}`,
        { code: error.code || 'API_ERROR', status: error.status || 502 }
      );
    }
    throw error;
  }
}

/**
 * Ensure a Regos user is among ticket staff participants (Ticket/SetParticipants, append).
 */
async function ensureTicketParticipant(ticketId, userId) {
  const id = Number(ticketId);
  const uid = Number(userId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(uid) || uid <= 0) {
    throw new RegosCrmError('Некорректный ticket id или user id для участников.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  return postRegosMutation('Ticket/SetParticipants', {
    id,
    participant_user_ids: [uid],
    replace_mode: false,
  });
}

function isTicketStaffParticipant(ticket, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0 || !ticket) return false;
  if (Number(ticket.responsible_user_id) === uid) return true;
  const participants = Array.isArray(ticket.participant_user_ids)
    ? ticket.participant_user_ids
    : [];
  return participants.some((id) => Number(id) === uid);
}

async function fetchAllTickets(request = {}) {
  const all = [];
  let offset = 0;

  for (;;) {
    const page = await postTicketGet({
      ...request,
      limit: PAGE_LIMIT,
      offset,
    });
    all.push(...page.result);
    if (page.result.length === 0 || all.length >= page.total) {
      break;
    }
    offset += page.result.length;
  }

  return all;
}

async function fetchAllUsers({ activeOnly = true, search } = {}) {
  const all = [];
  let offset = 0;
  const filters = [];
  if (activeOnly) {
    filters.push({ Field: 'active', Operator: 'equal', Value: 'true' });
  }

  for (;;) {
    const page = await postUserGet({
      limit: PAGE_LIMIT,
      offset,
      ...(filters.length ? { filters } : {}),
      ...(search ? { search: String(search) } : {}),
      sort_orders: [{ column: 'first_name', direction: 'ASC' }],
    });
    all.push(...page.result);
    if (page.result.length === 0 || all.length >= page.total) {
      break;
    }
    offset += page.result.length;
  }

  return all;
}

async function fetchAllChannels({ activeOnly = false, search } = {}) {
  const all = [];
  let offset = 0;
  const filters = [];
  if (activeOnly) {
    filters.push({ Field: 'active', Operator: 'equal', Value: 'true' });
  }

  for (;;) {
    const page = await postChannelGet({
      limit: PAGE_LIMIT,
      offset,
      ...(filters.length ? { filters } : {}),
      ...(search ? { search: String(search) } : {}),
    });
    all.push(...page.result);
    if (page.result.length === 0 || all.length >= page.total) {
      break;
    }
    offset += page.result.length;
  }

  return all;
}

function mapRegosChannelSummary(channel = {}) {
  return {
    id: channel.id,
    name: channel.name || null,
    active: channel.active !== false,
  };
}

function splitPhoneList(value) {
  if (value == null || value === '') return [];
  return String(value)
    .split(/[,;|/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function collectRegosUserPhones(user = {}) {
  const phones = [];
  for (const value of [user.main_phone, user.phones]) {
    phones.push(...splitPhoneList(value));
  }
  return phones;
}

function mapRegosUserSummary(user = {}) {
  const fullName =
    user.full_name ||
    [user.last_name, user.first_name, user.middle_name].filter(Boolean).join(' ').trim() ||
    null;
  return {
    id: user.id,
    login: user.login || null,
    full_name: fullName,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    main_phone: user.main_phone || null,
    phones: user.phones || null,
    active: user.active !== false,
  };
}

function phonesEqual(left, right) {
  const a = String(left || '').replace(/\D/g, '');
  const b = String(right || '').replace(/\D/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  const aTail = a.slice(-9);
  const bTail = b.slice(-9);
  return aTail.length >= 9 && aTail === bTail;
}

function regosUserMatchesPhone(user, phone) {
  return collectRegosUserPhones(user).some((candidate) => phonesEqual(candidate, phone));
}

/**
 * Find REGOS users whose main_phone/phones match the given phone.
 */
function findRegosUsersByPhone(regosUsers, phone) {
  if (!phone) return [];
  return (regosUsers || []).filter((user) => regosUserMatchesPhone(user, phone));
}

/**
 * Match one bot phone against REGOS users.
 * Returns unique match, none, or ambiguous (multiple).
 */
function matchPhoneToRegosUser(phone, regosUsers, { excludeRegosIds = new Set() } = {}) {
  const matches = findRegosUsersByPhone(regosUsers, phone).filter(
    (user) => !excludeRegosIds.has(Number(user.id))
  );
  if (matches.length === 1) {
    return { status: 'matched', user: matches[0], candidates: matches };
  }
  if (matches.length === 0) {
    return { status: 'none', user: null, candidates: [] };
  }
  return { status: 'ambiguous', user: null, candidates: matches };
}

/**
 * Auto-match bot users to REGOS users by phone.
 * Only unique phone matches are linked; already-linked bot users are skipped unless force.
 */
function planRegosLinksByPhone(botUsers, regosUsers, { force = false } = {}) {
  const usedRegosIds = new Set();
  for (const botUser of botUsers || []) {
    if (botUser.regos_user_id != null && !force) {
      usedRegosIds.add(Number(botUser.regos_user_id));
    }
  }

  const results = [];
  for (const botUser of botUsers || []) {
    if (botUser.regos_user_id != null && !force) {
      results.push({
        botUserId: botUser.id,
        status: 'already_linked',
        regosUser: null,
        candidates: [],
      });
      continue;
    }

    const match = matchPhoneToRegosUser(botUser.phone, regosUsers, {
      excludeRegosIds: usedRegosIds,
    });
    if (match.status === 'matched') {
      usedRegosIds.add(Number(match.user.id));
    }
    results.push({
      botUserId: botUser.id,
      status: match.status,
      regosUser: match.user,
      candidates: match.candidates,
    });
  }
  return results;
}

/**
 * Keep one ticket per same-client cluster created within the given window.
 * Walks chronologically per client and drops tickets within the window of the last kept one.
 */
function dedupeTickets(tickets, windowMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES) {
  const windowSeconds = Math.max(0, Number(windowMinutes) || 0) * 60;
  const byClient = new Map();

  for (const ticket of tickets) {
    const list = byClient.get(ticket.client_id) || [];
    list.push(ticket);
    byClient.set(ticket.client_id, list);
  }

  const kept = [];

  for (const group of byClient.values()) {
    group.sort((a, b) => {
      if (a.created_date !== b.created_date) {
        return a.created_date - b.created_date;
      }
      return a.id - b.id;
    });

    let lastKept = null;
    for (const ticket of group) {
      if (
        lastKept != null &&
        ticket.created_date - lastKept.created_date <= windowSeconds
      ) {
        continue;
      }
      kept.push(ticket);
      lastKept = ticket;
    }
  }

  kept.sort((a, b) => {
    if (a.created_date !== b.created_date) {
      return b.created_date - a.created_date;
    }
    return b.id - a.id;
  });

  return kept;
}

function summarizeTickets(tickets) {
  let slaBreached = 0;
  let rated = 0;

  for (const ticket of tickets) {
    if (ticket.sla_breached) slaBreached += 1;
    if (ticket.rating != null) rated += 1;
  }

  return {
    count: tickets.length,
    slaBreached,
    rated,
  };
}

function buildTicketFilters({ status, fromDate, toDate, responsibleUserId, channelId } = {}) {
  const filters = [];

  if (status) {
    filters.push({ Field: 'status', Operator: 'equal', Value: String(status) });
  }
  if (fromDate != null && fromDate !== '') {
    filters.push({ Field: 'from_date', Operator: 'equal', Value: String(fromDate) });
  }
  if (toDate != null && toDate !== '') {
    filters.push({ Field: 'to_date', Operator: 'equal', Value: String(toDate) });
  }
  if (responsibleUserId != null && responsibleUserId !== '') {
    filters.push({
      Field: 'responsible_user_id',
      Operator: 'equal',
      Value: String(responsibleUserId),
    });
  }
  if (channelId != null && channelId !== '') {
    filters.push({
      Field: 'channel_id',
      Operator: 'equal',
      Value: String(channelId),
    });
  }

  return filters;
}

/**
 * Latest ticket for a responsible user by created_date DESC (ignores list filters).
 */
async function findLatestTicketForResponsibleUser(responsibleUserId) {
  if (responsibleUserId == null || responsibleUserId === '') {
    return null;
  }
  const filters = buildTicketFilters({ responsibleUserId });
  const page = await postTicketGet({
    filters,
    sort_orders: [{ column: 'created_date', direction: 'DESC' }],
    limit: 1,
    offset: 0,
  });
  return page.result[0] || null;
}

async function findTicketById(ticketId) {
  const id = Number(ticketId);
  if (!Number.isFinite(id)) {
    return null;
  }
  const page = await postTicketGet({
    filters: [{ Field: 'id', Operator: 'equal', Value: String(id) }],
    limit: 1,
    offset: 0,
  });
  return page.result[0] || null;
}

/** Active when the latest ticket is Open or WaitingStaff. */
const ACTIVE_TICKET_STATUSES = new Set(['Open', 'WaitingStaff']);

function resolveActiveTicket(ticket) {
  if (!ticket || !ACTIVE_TICKET_STATUSES.has(ticket.status)) {
    return null;
  }
  return ticket;
}

function mapActiveTicket(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    subject: ticket.subject || null,
    status: ticket.status || null,
    client: ticket.client || null,
    created_date: ticket.created_date ?? null,
    responsible_user_id: ticket.responsible_user_id ?? null,
  };
}

module.exports = {
  RegosCrmError,
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  DEFAULT_CHAT_MESSAGE_LIMIT,
  postTicketGet,
  postUserGet,
  postChannelGet,
  postChatGet,
  postChatMessageGet,
  getTicketMessages,
  addTicketMessage,
  ensureTicketParticipant,
  isTicketStaffParticipant,
  sortChatMessagesAscending,
  fetchAllTickets,
  fetchAllUsers,
  fetchAllChannels,
  mapRegosChannelSummary,
  collectRegosUserPhones,
  mapRegosUserSummary,
  findRegosUsersByPhone,
  matchPhoneToRegosUser,
  planRegosLinksByPhone,
  dedupeTickets,
  summarizeTickets,
  buildTicketFilters,
  findLatestTicketForResponsibleUser,
  findTicketById,
  resolveActiveTicket,
  mapActiveTicket,
};
