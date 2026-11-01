import type { Unchecked } from '../types/unchecked';
import { RegosCrmError, parseRegosCreatedId, postRegos, postRegosMutation, postChatMessageGet } from './regos-crm-http';

const DEFAULT_CHAT_MESSAGE_LIMIT = 50;

function sortChatMessagesAscending(messages?: any) {
  return [...(messages || [])].sort((a?: any, b?: any) => {
    const dateA = Number(a?.created_date) || 0;
    const dateB = Number(b?.created_date) || 0;
    if (dateA !== dateB) return dateA - dateB;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

/**
 * Load chat messages for a ticket chat UUID (ChatMessage/Get).
 * The API page is newest-first (offset 0 = latest messages). This helper then
 * sorts that page by created_date ascending for chat-style display.
 */
async function getTicketMessages(
  chatId: any,
  { limit = DEFAULT_CHAT_MESSAGE_LIMIT, offset = 0, includeStaffPrivate = true }: Unchecked = {}
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

async function fetchTicketPeriodMessages(chatId: any, options: any = {}) {
  const { fetchChatMessagesInPeriod } = (require('../ai/ticket-period') as typeof import('../ai/ticket-period'));
  return fetchChatMessagesInPeriod(chatId, {
    ...options,
    getTicketMessages: options.getTicketMessages || getTicketMessages,
  });
}

function stripBase64Prefix(value?: any) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  if (/^data:/i.test(raw) && comma >= 0) {
    return raw.slice(comma + 1).replace(/\s+/g, '');
  }
  return raw.replace(/\s+/g, '');
}

function normalizeFileIds(ids?: any) {
  const unique: any[] = [];
  const seen: Set<any> = new Set();
  for (const raw of ids || []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function mapRegosFile(file?: any) {
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
}: Unchecked = {}) {
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

  const request: Unchecked = {
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
async function getFilesByIds(ids?: any) {
  const uniqueIds = normalizeFileIds(ids);
  if (!uniqueIds.length) return [];

  const found: Map<any, any> = new Map();

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

  return uniqueIds.map((id?: any) => found.get(id)).filter(Boolean);
}

/**
 * Load chat-attached files (ChatMessage/GetFiles) with message context.
 * Chat system-folder files are often invisible to File/Get.
 */
async function getChatMessageFiles(
  chatId: any,
  { limit = 100, offset = 0, includeStaffPrivate = true }: Unchecked = {}
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
  chatId: any,
  ids: any,
  { includeStaffPrivate = true, maxPages = 20 }: Unchecked = {}
) {
  const uniqueIds = normalizeFileIds(ids);
  if (!uniqueIds.length) return [];

  const chat = String(chatId || '').trim();
  const wanted: Set<any> = new Set(uniqueIds);
  const found: Map<any, any> = new Map();

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

  const missing = uniqueIds.filter((id?: any) => !found.has(id));
  if (missing.length) {
    const fallback = await getFilesByIds(missing);
    for (const file of fallback) {
      found.set(file.id, file);
    }
  }

  return uniqueIds.map((id?: any) => found.get(id)).filter(Boolean);
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
}: Unchecked = {}) {
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

  const request: Unchecked = {
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
      id: parseRegosCreatedId(data.result),
      result: data.result,
    };
  } catch (error: any) {
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

export {
  DEFAULT_CHAT_MESSAGE_LIMIT,
  sortChatMessagesAscending,
  getTicketMessages,
  fetchTicketPeriodMessages,
  addChatFile,
  getFilesByIds,
  getChatMessageFiles,
  getChatFilesByIds,
  addTicketMessage,
};
