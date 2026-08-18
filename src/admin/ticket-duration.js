const { getTicketRecordingsByIds } = require('../db/ticket-recordings');
const {
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  dedupeTickets,
  summarizeTickets,
} = require('../integrations/regos-crm');
const { getTicketRecordingUrl } = require('./ticket-recording');

function classifyTicketsForDuration(tickets, channelSettings, db = null) {
  const modeByChannelId = new Map(
    (channelSettings || []).map((setting) => [
      String(setting.channel_id),
      String(setting.interaction_mode || ''),
    ])
  );
  const messageTickets = [];
  const calls = [];
  const recordingsById = db
    ? getTicketRecordingsByIds(
        db,
        (tickets || []).map((ticket) => ticket?.id)
      )
    : new Map();

  for (const ticket of tickets || []) {
    const channelId = ticket?.channel_id == null ? '' : String(ticket.channel_id);
    const channelMode = modeByChannelId.get(channelId) || null;
    const ticketId = Number(ticket?.id);
    const recording =
      Number.isInteger(ticketId) && ticketId > 0 ? recordingsById.get(ticketId) : null;
    const hasRecording = Boolean(getTicketRecordingUrl(ticket) || recording?.recording_url);
    const isCallTicket =
      channelMode === 'call' || (channelMode !== 'message_only' && hasRecording);
    const cachedDuration = Number(recording?.duration_seconds);
    const durationSeconds =
      Number.isFinite(cachedDuration) && cachedDuration > 0 ? cachedDuration : null;
    if (!isCallTicket) {
      messageTickets.push({ ticket, hasRecording, durationSeconds });
      continue;
    }
    calls.push({ ticket, hasRecording, durationSeconds });
  }

  return { messageTickets, calls };
}

function buildDurationSummary(tickets, channelSettings, db = null) {
  const { messageTickets, calls } = classifyTicketsForDuration(tickets, channelSettings, db);
  return {
    base: summarizeTickets(messageTickets.map((item) => item.ticket)),
    calls: calls.map((item) => ({
      id: item.ticket.id,
      slaBreached: Boolean(item.ticket.sla_breached),
      rated: item.ticket.rating != null,
      hasRecording: item.hasRecording,
      duration_seconds: item.durationSeconds,
    })),
  };
}

function callPassesDurationFilter(call, threshold) {
  if (!call?.hasRecording) return false;
  const duration = Number(call.durationSeconds);
  const limit = Number(threshold);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(limit) || duration <= limit) return false;
  return true;
}

function responsibleUserId(ticket) {
  const id = Number(ticket?.responsible_user_id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function bumpCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function countTicketsByResponsible(
  tickets,
  {
    withoutDuplicates = false,
    duplicateIntervalMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES,
    minimumCallDuration = null,
    channelSettings = [],
    db = null,
  } = {}
) {
  let list = Array.isArray(tickets) ? tickets : [];
  if (withoutDuplicates) {
    list = dedupeTickets(list, duplicateIntervalMinutes);
  }

  const durationFilterActive = minimumCallDuration != null && minimumCallDuration !== '';
  const threshold = Number(minimumCallDuration);
  let counted = list;
  if (durationFilterActive) {
    const classified = classifyTicketsForDuration(list, channelSettings, db);
    counted = [
      ...classified.messageTickets.map((item) => item.ticket),
      ...classified.calls
        .filter((item) => callPassesDurationFilter(item, threshold))
        .map((item) => item.ticket),
    ];
  }

  const byResponsible = new Map();
  let unassigned = 0;
  for (const ticket of counted) {
    const id = responsibleUserId(ticket);
    if (id == null) {
      unassigned += 1;
      continue;
    }
    bumpCount(byResponsible, id);
  }

  return {
    byResponsible,
    unassigned,
    total: counted.length,
  };
}

module.exports = {
  classifyTicketsForDuration,
  buildDurationSummary,
  countTicketsByResponsible,
};
