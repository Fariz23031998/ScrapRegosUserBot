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

function createRegosTicketWebhookHandler({
  connectedIntegrationId = process.env.REGOS_INTEGRATION_TOKEN,
  findTicket = findTicketById,
  publish = (event) => ticketEventHub.publish(event),
  now = () => Date.now(),
  db = null,
  resolveRecordingCache = resolveTicketRecordingCache,
  schedule = (task) => {
    setImmediate(task);
  },
} = {}) {
  const expectedIntegrationId = String(connectedIntegrationId || '').trim();

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
    if (!TICKET_WEBHOOK_ACTIONS.has(eventAction)) {
      return { ok: true, message: 'Event ignored' };
    }

    const ticketId = parsePositiveId(webhookData.data?.data?.id);
    if (ticketId == null) {
      return { ok: false, error: 'Missing ticket id' };
    }

    const nowMs = now();
    cleanupProcessedEvents(nowMs);
    const eventId = String(webhookData.event_id || '').trim();
    if (eventId && processedWebhookEvents.has(eventId)) {
      return { ok: true, message: 'Event already processed', duplicate: true };
    }
    if (eventId) {
      processedWebhookEvents.set(eventId, nowMs);
    }

    try {
      const ticket = await findTicket(ticketId);
      const occurredAt =
        typeof webhookData.occurred_at === 'string' && webhookData.occurred_at.trim()
          ? webhookData.occurred_at.trim()
          : new Date(nowMs).toISOString();

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
  createRegosTicketWebhookHandler,
  createRegosTicketWebhookRouter,
};
