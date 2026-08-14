const express = require('express');
const { findTicketById } = require('./regos-crm');
const { ticketEventHub } = require('../admin/ticket-events');
const { resolveTicketRecordingCache } = require('../admin/ticket-recording');

const WEBHOOK_EVENT_TTL_MS = 60 * 60 * 1000;
const TICKET_WEBHOOK_ACTIONS = new Set([
  'TicketAdded',
  'TicketEdited',
  'TicketResponsibleSet',
  'TicketParticipantsSet',
  'TicketStatusSet',
  'TicketClosed',
]);

const CHAT_WRITING_ACTION = 'ChatWriting';
const CHAT_WEBHOOK_ACTIONS = new Set([
  'ChatAdded',
  'ChatEdited',
  'ChatParticipantsSet',
  'ChatParticipantsRemoved',
  'ChatMessageAdded',
  'ChatMessageEdited',
  'ChatMessageDeleted',
  'ChatMessageRead',
  CHAT_WRITING_ACTION,
]);

const CHAT_ID_FROM_ID_ACTIONS = new Set([
  'ChatAdded',
  'ChatEdited',
  'ChatParticipantsSet',
  'ChatParticipantsRemoved',
]);

const CHAT_MESSAGE_ID_ACTIONS = new Set([
  'ChatMessageAdded',
  'ChatMessageEdited',
  'ChatMessageDeleted',
]);

const processedWebhookEvents = new Map();

function cleanupProcessedEvents(nowMs) {
  for (const [eventId, processedAt] of processedWebhookEvents) {
    if (nowMs - processedAt >= WEBHOOK_EVENT_TTL_MS) {
      processedWebhookEvents.delete(eventId);
    }
  }
}

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseChatId(value) {
  const chatId = String(value ?? '').trim();
  return chatId || null;
}

function parseOptionalMessageId(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function resolveOccurredAt(webhookData, nowMs) {
  return typeof webhookData.occurred_at === 'string' && webhookData.occurred_at.trim()
    ? webhookData.occurred_at.trim()
    : new Date(nowMs).toISOString();
}

function beginEventProcessing(webhookData, nowMs) {
  cleanupProcessedEvents(nowMs);
  const eventId = String(webhookData.event_id || '').trim();
  if (eventId && processedWebhookEvents.has(eventId)) {
    return { duplicate: true, eventId };
  }
  if (eventId) {
    processedWebhookEvents.set(eventId, nowMs);
  }
  return { duplicate: false, eventId };
}

function defaultHandleCustomerMessage(args) {
  const { handleCustomerChatMessage } = require('../ai/customer-agent');
  return handleCustomerChatMessage(args);
}

function defaultSummarizeClosedTicket(args) {
  const { summarizeClosedTicket } = require('../ai/ticket-summary-agent');
  return summarizeClosedTicket(args);
}

function ticketWasClosed(eventAction, ticket) {
  const { shouldSummarizeClosedTicket } = require('../ai/ticket-summary-agent');
  return shouldSummarizeClosedTicket(eventAction, ticket);
}

function createRegosTicketWebhookHandler({
  connectedIntegrationId = process.env.REGOS_INTEGRATION_TOKEN,
  findTicket = findTicketById,
  publish = (event) => ticketEventHub.publish(event),
  now = () => Date.now(),
  db = null,
  resolveRecordingCache = resolveTicketRecordingCache,
  handleCustomerMessage = defaultHandleCustomerMessage,
  summarizeClosedTicket = defaultSummarizeClosedTicket,
  schedule = (task) => {
    setImmediate(task);
  },
} = {}) {
  const expectedIntegrationId = String(connectedIntegrationId || '').trim();

  async function handleTicketWebhook(webhookData, eventAction) {
    const ticketId = parsePositiveId(webhookData.data?.data?.id);
    if (ticketId == null) {
      return { ok: false, error: 'Missing ticket id' };
    }

    const nowMs = now();
    const { duplicate, eventId } = beginEventProcessing(webhookData, nowMs);
    if (duplicate) {
      return { ok: true, message: 'Event already processed', duplicate: true };
    }

    try {
      const ticket = await findTicket(ticketId);
      const occurredAt = resolveOccurredAt(webhookData, nowMs);

      let recording = null;
      if (db) {
        // Upsert URL first so SSE clients can play immediately; duration may follow async.
        recording = await resolveRecordingCache(db, ticket, { fetchDuration: false });
      }

      publish({
        type: 'ticket_changed',
        ticket_id: ticketId,
        responsible_user_id: ticket?.responsible_user_id ?? null,
        source_action: eventAction,
        occurred_at: occurredAt,
      });

      if (db && ticket && typeof summarizeClosedTicket === 'function') {
        if (ticketWasClosed(eventAction, ticket)) {
          schedule(() => {
            Promise.resolve(
              summarizeClosedTicket({
                db,
                ticket,
                occurredAt,
                now: nowMs,
              })
            ).catch((error) => {
              console.error(`[ai] ticket summary failed for #${ticketId}:`, error);
            });
          });
        }
      }

      if (
        db &&
        recording?.recording_url &&
        recording.duration_seconds == null
      ) {
        schedule(() =>
          (async () => {
            try {
              const updated = await resolveRecordingCache(db, ticket, { fetchDuration: true });
              if (updated?.duration_seconds == null) return;
              publish({
                type: 'ticket_changed',
                ticket_id: ticketId,
                responsible_user_id: ticket?.responsible_user_id ?? null,
                source_action: eventAction,
                occurred_at: occurredAt,
              });
            } catch (error) {
              console.error(
                `[regos-webhook] Failed to refresh recording duration for ticket ${ticketId}:`,
                error
              );
            }
          })()
        );
      }

      return { ok: true, message: 'Webhook processed' };
    } catch (error) {
      if (eventId) {
        processedWebhookEvents.delete(eventId);
      }
      console.error(`[regos-webhook] Failed to process ${eventAction} for ticket ${ticketId}:`, error);
      return { ok: false, error: 'Failed to process webhook' };
    }
  }

  function handleChatWebhook(webhookData, eventAction) {
    const payload = webhookData.data?.data;
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Missing chat event data' };
    }

    const chatId = CHAT_ID_FROM_ID_ACTIONS.has(eventAction)
      ? parseChatId(payload.id)
      : parseChatId(payload.chat_id);
    if (!chatId) {
      return { ok: false, error: 'Missing chat id' };
    }

    const nowMs = now();
    const { duplicate } = beginEventProcessing(webhookData, nowMs);
    if (duplicate) {
      return { ok: true, message: 'Event already processed', duplicate: true };
    }

    const occurredAt = resolveOccurredAt(webhookData, nowMs);
    if (eventAction === CHAT_WRITING_ACTION) {
      publish({
        type: 'chat_writing',
        chat_id: chatId,
        author_entity_id: payload.author_entity_id ?? null,
        author_entity_type: payload.author_entity_type ?? null,
        source_action: eventAction,
        occurred_at: occurredAt,
      });
    } else {
      publish({
        type: 'chat_changed',
        chat_id: chatId,
        message_id: CHAT_MESSAGE_ID_ACTIONS.has(eventAction)
          ? parseOptionalMessageId(payload.id)
          : null,
        source_action: eventAction,
        occurred_at: occurredAt,
      });
    }

    if (eventAction === 'ChatMessageAdded' && db && typeof handleCustomerMessage === 'function') {
      const authorType = String(payload.author_entity_type || '');
      const messageType = payload.message_type != null ? String(payload.message_type) : '';
      const isSystem = messageType === 'System';
      const knownStaffOrBot = Boolean(authorType) && authorType !== 'Client' && !isSystem;
      const knownOtherType = Boolean(messageType) && messageType !== 'Regular' && !isSystem;
      if (!knownStaffOrBot && !knownOtherType) {
        const messageId = parseOptionalMessageId(payload.id);
        schedule(() => {
          Promise.resolve(
            handleCustomerMessage({
              db,
              chatId,
              messageId,
              payload,
            })
          ).catch((error) => {
            console.error('[ai] customer agent failed', error);
          });
        });
      }
    }

    return { ok: true, message: 'Webhook processed' };
  }

  return async function handleRegosTicketWebhook(webhookData) {
    if (!webhookData || typeof webhookData !== 'object') {
      return { ok: false, error: 'Invalid webhook payload' };
    }
    if (!expectedIntegrationId) {
      console.error('[regos-webhook] REGOS_INTEGRATION_TOKEN is not configured');
      return { ok: false, error: 'Webhook integration is not configured' };
    }

    const receivedIntegrationId = String(webhookData.connected_integration_id || '').trim();
    if (!receivedIntegrationId || receivedIntegrationId !== expectedIntegrationId) {
      console.warn('[regos-webhook] Rejected webhook with unknown connected_integration_id');
      return { ok: false, error: 'Unknown connected_integration_id' };
    }

    const eventAction = String(webhookData.data?.action || '').trim();
    if (TICKET_WEBHOOK_ACTIONS.has(eventAction)) {
      return handleTicketWebhook(webhookData, eventAction);
    }
    if (CHAT_WEBHOOK_ACTIONS.has(eventAction)) {
      return handleChatWebhook(webhookData, eventAction);
    }
    return { ok: true, message: 'Event ignored' };
  };
}

function createRegosTicketWebhookRouter({
  handler = createRegosTicketWebhookHandler(),
} = {}) {
  const router = express.Router();
  router.post('/webhook', async (req, res) => {
    const result = await handler(req.body);
    return res.json(result);
  });
  return router;
}

module.exports = {
  WEBHOOK_EVENT_TTL_MS,
  TICKET_WEBHOOK_ACTIONS,
  CHAT_WEBHOOK_ACTIONS,
  createRegosTicketWebhookHandler,
  createRegosTicketWebhookRouter,
};
