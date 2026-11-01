import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import { getTicketRecordingsByIds } from '../db/ticket-recordings';
import { DEFAULT_DUPLICATE_INTERVAL_MINUTES, dedupeTickets, summarizeTickets } from '../integrations/regos-crm';
import { getTicketRecordingUrl } from './ticket-recording';

function classifyTicketsForDuration(tickets: any, channelSettings: any, db: Db | null = null) {
  const modeByChannelId: Map<any, any> = new Map(
    (channelSettings || []).map((setting?: any) => [
      String(setting.channel_id),
      String(setting.interaction_mode || ''),
    ])
  );
  const messageTickets: any[] = [];
  const calls: any[] = [];
  const recordingsById = db
    ? getTicketRecordingsByIds(
        db,
        (tickets || []).map((ticket?: any) => ticket?.id)
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

function buildDurationSummary(tickets: any, channelSettings: any, db: Db | null = null) {
  const { messageTickets, calls } = classifyTicketsForDuration(tickets, channelSettings, db);
  return {
    base: summarizeTickets(messageTickets.map((item?: any) => item.ticket)),
    calls: calls.map((item?: any) => ({
      id: item.ticket.id,
      slaBreached: Boolean(item.ticket.sla_breached),
      rated: item.ticket.rating != null,
      hasRecording: item.hasRecording,
      duration_seconds: item.durationSeconds,
    })),
  };
}

function callPassesDurationFilter(call?: any, threshold?: any) {
  if (!call?.hasRecording) return false;
  const duration = Number(call.durationSeconds);
  const limit = Number(threshold);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(limit) || duration <= limit) return false;
  return true;
}

function responsibleUserId(ticket?: any) {
  const id = Number(ticket?.responsible_user_id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function bumpCount(map?: any, key?: any) {
  map.set(key, (map.get(key) || 0) + 1);
}

function ticketIdKey(ticket?: any) {
  const id = Number(ticket?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function positiveCallDuration(call?: any) {
  const duration = Number(call?.durationSeconds);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function addDuration(map?: any, key?: any, seconds?: any) {
  const duration = Number(seconds) || 0;
  if (duration <= 0) return;
  map.set(key, (map.get(key) || 0) + duration);
}

function countTicketsByResponsible(
  tickets: any,
  {
    withoutDuplicates = false,
    duplicateIntervalMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES,
    minimumCallDuration = null,
    channelSettings = [],
    db = null,
  }: Unchecked = {}
) {
  let list = Array.isArray(tickets) ? tickets : [];
  if (withoutDuplicates) {
    list = dedupeTickets(list, duplicateIntervalMinutes);
  }

  const classified = classifyTicketsForDuration(list, channelSettings, db);
  const durationFilterActive = minimumCallDuration != null && minimumCallDuration !== '';
  const threshold = Number(minimumCallDuration);
  const countedCalls = durationFilterActive
    ? classified.calls.filter((item?: any) => callPassesDurationFilter(item, threshold))
    : classified.calls;
  const counted = durationFilterActive
    ? [
        ...classified.messageTickets.map((item?: any) => item.ticket),
        ...countedCalls.map((item?: any) => item.ticket),
      ]
    : list;
  const durationByTicketId: Map<any, any> = new Map();
  for (const call of countedCalls) {
    const id = ticketIdKey(call?.ticket);
    const duration = positiveCallDuration(call);
    if (id == null || duration <= 0) continue;
    durationByTicketId.set(id, (durationByTicketId.get(id) || 0) + duration);
  }

  const byResponsible: Map<any, any> = new Map();
  const durationByResponsible: Map<any, any> = new Map();
  let unassigned = 0;
  let unassignedDurationSeconds = 0;
  for (const ticket of counted) {
    const id = responsibleUserId(ticket);
    const ticketId = ticketIdKey(ticket);
    const duration = ticketId == null ? 0 : Number(durationByTicketId.get(ticketId)) || 0;
    if (id == null) {
      unassigned += 1;
      unassignedDurationSeconds += duration;
      continue;
    }
    bumpCount(byResponsible, id);
    addDuration(durationByResponsible, id, duration);
  }

  return {
    byResponsible,
    durationByResponsible,
    unassigned,
    unassignedDurationSeconds,
    total: counted.length,
  };
}

export { classifyTicketsForDuration, buildDurationSummary, countTicketsByResponsible };
