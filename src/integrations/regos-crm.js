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

async function postClientGet(request = {}) {
  return postRegos('Client/Get', request);
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

function stripBase64Prefix(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  if (/^data:/i.test(raw) && comma >= 0) {
    return raw.slice(comma + 1).replace(/\s+/g, '');
  }
  return raw.replace(/\s+/g, '');
}

function normalizeFileIds(ids) {
  const unique = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function mapRegosFile(file) {
  if (!file || file.id == null) return null;
  const id = Number(file.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const extension =
    file.extension != null ? String(file.extension).trim().replace(/^\./, '') : '';
  return {
    id,
    name: file.name != null ? String(file.name) : null,
    extension: extension || null,
    mime_type: file.mime_type != null ? String(file.mime_type) : null,
    media_type: file.media_type != null ? String(file.media_type) : null,
    size: file.size != null ? Number(file.size) : null,
    url: file.url != null ? String(file.url).trim() : null,
    width: file.width != null ? Number(file.width) : null,
    height: file.height != null ? Number(file.height) : null,
  };
}

/**
 * Upload a file into a chat folder (ChatMessage/AddFile) before ChatMessage/Add.
 */
async function addChatFile({
  chatId,
  name,
  extension,
  data,
  width,
  height,
  durationMs,
} = {}) {
  const id = String(chatId || '').trim();
  if (!id) {
    throw new RegosCrmError('Не указан chat_id.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const fileName = String(name || '').trim();
  if (!fileName) {
    throw new RegosCrmError('Не указано имя файла.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  if (fileName.length > 200) {
    throw new RegosCrmError('Имя файла слишком длинное.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const ext = String(extension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  if (!ext || ext.length > 10) {
    throw new RegosCrmError('Укажите корректное расширение файла.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const payload = stripBase64Prefix(data);
  if (!payload) {
    throw new RegosCrmError('Файл пустой или повреждён.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const request = {
    chat_id: id,
    name: fileName,
    extension: ext,
    data: payload,
  };
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (
    Number.isFinite(safeWidth) &&
    Number.isFinite(safeHeight) &&
    safeWidth > 0 &&
    safeHeight > 0
  ) {
    request.width = Math.round(safeWidth);
    request.height = Math.round(safeHeight);
  }
  const duration = Number(durationMs);
  if (Number.isFinite(duration) && duration >= 0) {
    request.duration_ms = Math.round(duration);
  }

  const result = await postRegosMutation('ChatMessage/AddFile', request);
  const fileId = Number(result.result.file_id);
  return {
    ok: true,
    file_id: Number.isFinite(fileId) && fileId > 0 ? fileId : null,
    result: result.result,
  };
}

/**
 * Load file metadata (File/Get) for generic file storage.
 */
async function getFilesByIds(ids) {
  const uniqueIds = normalizeFileIds(ids);
  if (!uniqueIds.length) return [];

  const found = new Map();

  if (uniqueIds.length > 1) {
    try {
      const page = await postRegos('File/Get', {
        ids: uniqueIds,
        limit: uniqueIds.length,
        offset: 0,
      });
      for (const row of page.result) {
        const file = mapRegosFile(row);
        if (file) found.set(file.id, file);
      }
    } catch {
      // Fall through to per-id lookup.
    }
  }

  for (const id of uniqueIds) {
    if (found.has(id)) continue;
    const single = await postRegos('File/Get', {
      filters: [{ Field: 'id', Operator: 'equal', Value: String(id) }],
      limit: 1,
      offset: 0,
    });
    const file = mapRegosFile(single.result[0]);
    if (file) found.set(file.id, file);
  }

  return uniqueIds.map((id) => found.get(id)).filter(Boolean);
}

/**
 * Load chat-attached files (ChatMessage/GetFiles) with message context.
 * Chat system-folder files are often invisible to File/Get.
 */
async function getChatMessageFiles(
  chatId,
  { limit = 100, offset = 0, includeStaffPrivate = true } = {}
) {
  const id = String(chatId || '').trim();
  if (!id) {
    return { ok: true, result: [], next_offset: 0, total: 0 };
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);

  return postRegos('ChatMessage/GetFiles', {
    filters: [{ Field: 'chat_id', Operator: 'equal', Value: id }],
    limit: safeLimit,
    offset: safeOffset,
    include_staff_private: Boolean(includeStaffPrivate),
  });
}

async function getChatFilesByIds(
  chatId,
  ids,
  { includeStaffPrivate = true, maxPages = 20 } = {}
) {
  const uniqueIds = normalizeFileIds(ids);
  if (!uniqueIds.length) return [];

  const chat = String(chatId || '').trim();
  const wanted = new Set(uniqueIds);
  const found = new Map();

  if (chat) {
    let offset = 0;
    const limit = 100;
    for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
      const page = await getChatMessageFiles(chat, {
        limit,
        offset,
        includeStaffPrivate,
      });
      for (const row of page.result) {
        const file = mapRegosFile(row?.file);
        if (file && wanted.has(file.id)) {
          found.set(file.id, file);
        }
      }
      if (found.size >= wanted.size) break;
      if (!page.result.length || page.result.length < limit) break;
      offset += page.result.length;
      if (typeof page.total === 'number' && offset >= page.total) break;
    }
  }

  const missing = uniqueIds.filter((id) => !found.has(id));
  if (missing.length) {
    const fallback = await getFilesByIds(missing);
    for (const file of fallback) {
      found.set(file.id, file);
    }
  }

  return uniqueIds.map((id) => found.get(id)).filter(Boolean);
}

/**
 * Send a text and/or file message to a ticket chat (ChatMessage/Add).
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
  const attachedIds = normalizeFileIds(fileIds);
  if (!messageText && attachedIds.length === 0) {
    throw new RegosCrmError('Текст сообщения не может быть пустым.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  const request = {
    chat_id: id,
    message_type: messageType || 'Regular',
  };
  if (messageText) {
    request.text = messageText;
  }
  if (replyId != null && String(replyId).trim()) {
    request.reply_id = String(replyId).trim();
  }
  if (attachedIds.length > 0) {
    request.file_ids = attachedIds;
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

async function searchClients(search, { limit = 20 } = {}) {
  const query = String(search || '').trim();
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const page = await postClientGet({
    limit: safeLimit,
    offset: 0,
    ...(query ? { search: query } : {}),
  });
  return page.result;
}

async function getClientById(clientId) {
  const id = requirePositiveId(clientId, 'id');
  const page = await postClientGet({ ids: [id], limit: 1, offset: 0 });
  const client = (page.result || []).find((row) => Number(row?.id) === id);
  return client || null;
}

function normalizeOptionalClientString(value, { max, field } = {}) {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (text.length > max) {
    throw new RegosCrmError(`Поле ${field} не должно превышать ${max} символов.`, {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  return text;
}

async function editClient(clientId, changes = {}) {
  const request = { id: requirePositiveId(clientId, 'id') };
  if (Object.hasOwn(changes, 'name')) {
    request.name = normalizeOptionalClientString(changes.name, { max: 200, field: 'name' });
  }
  if (Object.hasOwn(changes, 'phone')) {
    request.phone = normalizeOptionalClientString(changes.phone, { max: 50, field: 'phone' });
  }
  if (Object.hasOwn(changes, 'email')) {
    request.email = normalizeOptionalClientString(changes.email, { max: 150, field: 'email' });
  }
  if (Object.hasOwn(changes, 'description')) {
    request.description = normalizeOptionalClientString(changes.description, {
      max: 4000,
      field: 'description',
    });
  }
  if (Object.hasOwn(changes, 'external_id')) {
    request.external_id = normalizeOptionalClientString(changes.external_id, {
      max: 150,
      field: 'external_id',
    });
  }

  const editableKeys = Object.keys(request).filter((key) => key !== 'id');
  if (editableKeys.length === 0) {
    return { changed: false, result: null };
  }

  const data = await postRegosMutation('Client/Edit', request);
  return { changed: true, result: data.result };
}

function requirePositiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RegosCrmError(`Поле ${field} должно быть положительным целым числом.`, {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  return id;
}

function normalizeTicketDirection(value, { optional = false } = {}) {
  if (value == null || value === '') return optional ? undefined : 'Inbound';
  const direction = String(value);
  if (!['Inbound', 'Outbound'].includes(direction)) {
    throw new RegosCrmError('Направление должно быть Inbound или Outbound.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  return direction;
}

function normalizeTicketSubject(value) {
  if (value == null) return undefined;
  const subject = String(value).trim();
  if (subject.length > 300) {
    throw new RegosCrmError('Тема тикета не должна превышать 300 символов.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  return subject;
}

async function createTicket(input = {}) {
  const request = {
    client_id: requirePositiveId(input.client_id, 'client_id'),
    channel_id: requirePositiveId(input.channel_id, 'channel_id'),
    direction: normalizeTicketDirection(input.direction),
  };
  const subject = normalizeTicketSubject(input.subject);
  if (subject !== undefined) request.subject = subject;
  if (input.description != null) request.description = String(input.description).trim();
  if (input.responsible_user_id != null && input.responsible_user_id !== '') {
    request.responsible_user_id = requirePositiveId(
      input.responsible_user_id,
      'responsible_user_id'
    );
  }

  const data = await postRegosMutation('Ticket/Add', request);
  const id = Number(data.result.new_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RegosCrmError('REGOS не вернул идентификатор созданного тикета.', {
      code: 'BAD_RESPONSE',
      status: 502,
    });
  }
  return { id, result: data.result };
}

async function editTicket(ticketId, changes = {}) {
  const request = { id: requirePositiveId(ticketId, 'id') };
  if (Object.hasOwn(changes, 'subject')) {
    request.subject = normalizeTicketSubject(changes.subject);
  }
  if (Object.hasOwn(changes, 'description')) {
    request.description = String(changes.description ?? '').trim();
  }
  if (Object.hasOwn(changes, 'direction')) {
    request.direction = normalizeTicketDirection(changes.direction);
  }
  const editableKeys = Object.keys(request).filter((key) => key !== 'id');
  if (editableKeys.length === 0) return { changed: false, result: null };
  const data = await postRegosMutation('Ticket/Edit', request);
  return { changed: true, result: data.result };
}

async function setTicketStatus(ticketId, status) {
  const normalized = String(status || '');
  if (!['Open', 'Closed', 'WaitingClient', 'WaitingStaff'].includes(normalized)) {
    throw new RegosCrmError('Указан некорректный статус тикета.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }
  const data = await postRegosMutation('Ticket/SetStatus', {
    id: requirePositiveId(ticketId, 'id'),
    status: normalized,
  });
  return data.result;
}

async function setTicketResponsible(ticketId, responsibleUserId) {
  const data = await postRegosMutation('Ticket/SetResponsible', {
    id: requirePositiveId(ticketId, 'id'),
    responsible_user_id: requirePositiveId(responsibleUserId, 'responsible_user_id'),
  });
  return data.result;
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
  const mapped = {
    id: ticket.id,
    subject: ticket.subject || null,
    status: ticket.status || null,
    client: ticket.client || null,
    created_date: ticket.created_date ?? null,
    responsible_user_id: ticket.responsible_user_id ?? null,
  };
  if (ticket.local) {
    mapped.local = {
      unpaid_orders: ticket.local.unpaid_orders || {
        count: 0,
        total_amount: 0,
        orders: [],
      },
      technical_support: ticket.local.technical_support || {
        status: 'none',
        ends_at: null,
        starts_at: null,
      },
      firms: Array.isArray(ticket.local.firms) ? ticket.local.firms : [],
    };
  }
  return mapped;
}

module.exports = {
  RegosCrmError,
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  DEFAULT_CHAT_MESSAGE_LIMIT,
  postTicketGet,
  postUserGet,
  postChannelGet,
  postClientGet,
  postChatGet,
  postChatMessageGet,
  getTicketMessages,
  addTicketMessage,
  addChatFile,
  getFilesByIds,
  getChatMessageFiles,
  getChatFilesByIds,
  ensureTicketParticipant,
  isTicketStaffParticipant,
  sortChatMessagesAscending,
  fetchAllTickets,
  fetchAllUsers,
  fetchAllChannels,
  searchClients,
  getClientById,
  editClient,
  createTicket,
  editTicket,
  setTicketStatus,
  setTicketResponsible,
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
