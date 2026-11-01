import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { isEmployeeClientPhone } from './tools/employees';

function resolveAiAuthorUserId() {
  const raw = Number(process.env.AI_REGOS_AUTHOR_USER_ID);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function isClientRegularMessage(message?: any) {
  return (
    String(message?.author_entity_type || '') === 'Client' &&
    String(message?.message_type || 'Regular') === 'Regular'
  );
}

function isSystemMessage(message?: any) {
  return String(message?.message_type || '') === 'System';
}

function hasReplyAfterTrigger(messages?: any, trigger?: any, aiAuthorId?: any) {
  if (!trigger?.id) return false;
  const triggerId = String(trigger.id);
  let seenTrigger = false;
  for (const item of messages || []) {
    if (!seenTrigger) {
      if (String(item?.id) === triggerId) seenTrigger = true;
      continue;
    }
    if (String(item?.message_type || 'Regular') !== 'Regular') continue;
    if (String(item?.author_entity_type || '') !== 'User') continue;
    if (aiAuthorId && Number(item?.author_entity_id) !== Number(aiAuthorId)) continue;
    return true;
  }
  return false;
}

function hasUserReplyAfterTrigger(messages?: any, trigger?: any) {
  return hasReplyAfterTrigger(messages, trigger, null);
}

function lastUnansweredClientRegular(messages?: any) {
  const clients = (messages || []).filter(isClientRegularMessage);
  for (let i = clients.length - 1; i >= 0; i -= 1) {
    if (!hasUserReplyAfterTrigger(messages, clients[i])) {
      return clients[i];
    }
  }
  return null;
}

function payloadLooksLikeMessage(payload?: any) {
  return Boolean(
    payload &&
      (payload.author_entity_type ||
        payload.text ||
        payload.message_type ||
        (Array.isArray(payload.file_ids) && payload.file_ids.length))
  );
}

function findMessageByFileIds(messages?: any, fileIds?: any) {
  const wanted: Set<any> = new Set((Array.isArray(fileIds) ? fileIds : []).map((id?: any) => String(id)));
  if (!wanted.size) return null;
  const matches = (messages || []).filter((item?: any) => {
    const ids = Array.isArray(item?.file_ids) ? item.file_ids : [];
    return ids.some((id?: any) => wanted.has(String(id)));
  });
  return matches.at(-1) || null;
}

function pickTriggerMessage(messages?: any, messageId?: any, payload?: any) {
  if (messageId) {
    const found = (messages || []).find((item?: any) => String(item.id) === String(messageId));
    if (found) return found;
  }
  if (payloadLooksLikeMessage(payload)) {
    if (payload.id) {
      const found = (messages || []).find((item?: any) => String(item.id) === String(payload.id));
      if (found) return found;
    }
    const byFiles = findMessageByFileIds(messages, payload.file_ids);
    if (byFiles) return byFiles;
    if (payload.id) return payload;
    return (messages || []).filter(isClientRegularMessage).at(-1) || payload;
  }
  // Webhooks for staff/system messages often omit author fields. Never guess
  // "the last client message" in that case — that re-answers the same question
  // after every AI reply. Preview (no messageId) can still use the latest client.
  if (messageId) return null;
  return (messages || []).filter((item?: any) => String(item.author_entity_type || '') === 'Client').at(-1) || null;
}

function resolveCustomerTrigger(messages?: any, messageId?: any, payload?: any) {
  const trigger = pickTriggerMessage(messages, messageId, payload);
  if (isClientRegularMessage(trigger)) return trigger;
  if (isSystemMessage(trigger) || isSystemMessage(payload)) {
    return lastUnansweredClientRegular(messages) || trigger;
  }
  return trigger;
}

function isIgnoredCustomerMessage(text?: any, list?: any) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  const items = Array.isArray(list) ? list : [];
  return items.some((item?: any) => String(item || '').trim().toLowerCase() === normalized);
}

function evaluateCustomerMessageGate({ settings, message, ticket, isEmployeePhone = false, aiStopped = false }: Unchecked = {}) {
  if (!settings?.enabled) return { handle: false, reason: 'disabled' };
  // Per-ticket stop: blocks automatic customer replies only (not employee assist).
  if (aiStopped) return { handle: false, reason: 'stopped' };
  if (String(message?.message_type || 'Regular') !== 'Regular') {
    return { handle: false, reason: 'not-regular' };
  }
  const authorType = String(message?.author_entity_type || '');
  if (authorType === 'ChatBot') return { handle: false, reason: 'bot' };
  if (authorType !== 'Client') return { handle: false, reason: 'not-client' };
  const aiAuthorId = resolveAiAuthorUserId();
  if (aiAuthorId && Number(message?.author_entity_id) === aiAuthorId) {
    return { handle: false, reason: 'own-author' };
  }
  if (String(ticket?.status || '') === 'Closed') return { handle: false, reason: 'closed' };
  if (settings.testMode && !isEmployeePhone) {
    return { handle: false, reason: 'test-mode' };
  }
  const triggerText = message?.display_text || message?.text;
  if (isIgnoredCustomerMessage(triggerText, settings.ignoredCustomerMessages)) {
    return { handle: false, reason: 'ignored-message' };
  }
  return { handle: true, reason: null };
}

function evaluateCustomerReplyQuota(db: Db, { settings, ticket, chatId }: Unchecked = {}) {
  if (!db) return { handle: true, reason: null };
  const perTicket = Number(settings?.customerRepliesPerTicket);
  if (Number.isInteger(perTicket) && perTicket > 0) {
    const { getCustomerReplyCount } = (require('../db/ticket-ai-state') as typeof import('../db/ticket-ai-state'));
    if (getCustomerReplyCount(db, ticket?.id) >= perTicket) {
      return { handle: false, reason: 'ticket-cap' };
    }
  }
  const perHour = Number(settings?.customerRepliesPerHour);
  if (Number.isInteger(perHour) && perHour > 0) {
    const { countCustomerUsageSince, resolveCustomerUsageKey } = (require('../db/ai-customer-usage') as typeof import('../db/ai-customer-usage'));
    const clientKey = resolveCustomerUsageKey(ticket, chatId);
    if (countCustomerUsageSince(db, clientKey) >= perHour) {
      return { handle: false, reason: 'rate-limit' };
    }
  }
  return { handle: true, reason: null };
}

function evaluateCustomerMessageGateWithDb(db: Db, { settings, message, ticket, chatId }: Unchecked = {}) {
  const { isTicketAiStopped } = (require('../db/ticket-ai-state') as typeof import('../db/ticket-ai-state'));
  const gate = evaluateCustomerMessageGate({
    settings,
    message,
    ticket,
    isEmployeePhone: isEmployeeClientPhone(db, ticket?.client?.phone),
    aiStopped: isTicketAiStopped(db, ticket?.id),
  });
  if (!gate.handle) return gate;
  return evaluateCustomerReplyQuota(db, {
    settings,
    ticket,
    chatId: chatId || ticket?.chat_id,
  });
}

export {
  resolveAiAuthorUserId,
  isClientRegularMessage,
  isSystemMessage,
  hasReplyAfterTrigger,
  pickTriggerMessage,
  resolveCustomerTrigger,
  isIgnoredCustomerMessage,
  evaluateCustomerMessageGate,
  evaluateCustomerReplyQuota,
  evaluateCustomerMessageGateWithDb,
};
