import type { Db } from '../types/db';
import type { Unchecked } from '../types/unchecked';
import { listRegosChannelSettings } from '../db/regos-channel-settings';
import { getTicketMessages } from '../integrations/regos-crm';

const LAST_MESSAGE_PAGE_LIMIT = 30;
const LAST_MESSAGE_CONCURRENCY = 5;
const ATTACHMENT_PREVIEW = 'Вложение';

function isSystemMessage(message?: any) {
  return String(message?.message_type || '') === 'System';
}

function messageHasFiles(message?: any) {
  const fileIds = Array.isArray(message?.file_ids) ? message.file_ids : [];
  return fileIds.some((id?: any) => {
    const n = Number(id);
    return Number.isFinite(n) && n > 0;
  });
}

function previewTextFromMessage(message?: any) {
  const text = String(message?.text || '').trim();
  if (text) return text;
  if (messageHasFiles(message)) return ATTACHMENT_PREVIEW;
  return '';
}

/**
 * Newest non-system message from an ascending ChatMessage page.
 * Returns null when only System messages (or empty/blank) are present.
 */
function pickLastNonSystemMessage(messages?: any) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const message = rows[i];
    if (isSystemMessage(message)) continue;
    const text = previewTextFromMessage(message);
    if (!text) continue;
    const created = Number(message?.created_date);
    const preview: {
      text: string;
      created_date?: number;
      author_entity_id?: number | string;
      author_entity_type?: string;
      author_entity_name?: string;
    } = {
      text,
      created_date: Number.isFinite(created) && created > 0 ? created : undefined,
    };
    const authorEntityId = message?.author_entity_id;
    if (authorEntityId != null && authorEntityId !== '') {
      preview.author_entity_id = authorEntityId;
    }
    const authorEntityType =
      message?.author_entity_type != null ? String(message.author_entity_type).trim() : '';
    if (authorEntityType) preview.author_entity_type = authorEntityType;
    const authorEntityName =
      message?.author_entity_name != null ? String(message.author_entity_name).trim() : '';
    if (authorEntityName) preview.author_entity_name = authorEntityName;
    return preview;
  }
  return null;
}

function channelModeById(db: Db) {
  const modeByChannelId: Map<string, string> = new Map();
  for (const setting of listRegosChannelSettings(db) || []) {
    const id = String(setting?.channel_id || '').trim();
    if (!id) continue;
    modeByChannelId.set(id, String(setting?.interaction_mode || '').trim() || 'message_only');
  }
  return modeByChannelId;
}

function isMessageOnlyChannel(channelId: any, modeByChannelId: Map<string, string>) {
  const id = channelId == null ? '' : String(channelId).trim();
  if (!id) return true;
  const mode = modeByChannelId.get(id) || 'message_only';
  return mode === 'message_only';
}

async function mapWithConcurrency(items: any[], concurrency: number, worker: (item: any, index: number) => Promise<void>) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function fetchLastNonSystemPreview(
  chatId: string,
  { getMessages = getTicketMessages }: Unchecked = {}
) {
  const page = await getMessages(chatId, {
    limit: LAST_MESSAGE_PAGE_LIMIT,
    offset: 0,
    includeStaffPrivate: true,
  });
  return pickLastNonSystemMessage(page?.result);
}

/**
 * Attach `last_message` for message_only channel tickets that have a chat_id.
 * Call-channel tickets and failures get `last_message: null`.
 */
async function attachLastMessagesToTickets(
  db: Db,
  tickets?: any,
  { getMessages = getTicketMessages, concurrency = LAST_MESSAGE_CONCURRENCY }: Unchecked = {}
) {
  const rows = Array.isArray(tickets) ? tickets : [];
  if (rows.length === 0) return rows;

  const modeByChannelId = channelModeById(db);
  const eligible: Array<{ ticket: any; chatId: string }> = [];

  for (const ticket of rows) {
    if (!isMessageOnlyChannel(ticket?.channel_id, modeByChannelId)) {
      ticket.last_message = null;
      continue;
    }
    const chatId = ticket?.chat_id != null ? String(ticket.chat_id).trim() : '';
    if (!chatId) {
      ticket.last_message = null;
      continue;
    }
    eligible.push({ ticket, chatId });
  }

  await mapWithConcurrency(eligible, concurrency, async ({ ticket, chatId }) => {
    try {
      ticket.last_message = await fetchLastNonSystemPreview(chatId, { getMessages });
    } catch (error: any) {
      console.warn(
        `[ticket-last-message] Failed for ticket ${ticket?.id} chat ${chatId}:`,
        error?.message || error
      );
      ticket.last_message = null;
    }
  });

  return rows;
}

export {
  ATTACHMENT_PREVIEW,
  LAST_MESSAGE_PAGE_LIMIT,
  LAST_MESSAGE_CONCURRENCY,
  pickLastNonSystemMessage,
  isMessageOnlyChannel,
  attachLastMessagesToTickets,
  fetchLastNonSystemPreview,
};
