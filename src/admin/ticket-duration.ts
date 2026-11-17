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

function emptyTicketSummaryCounts() {
  return { count: 0, slaBreached: 0, rated: 0, call_duration_seconds: 0 };
}

function bumpTicketSummaryCounts(
  summary: { count: number; slaBreached: number; rated: number; call_duration_seconds: number },
  ticket?: any,
  durationSeconds = 0
) {
  summary.count += 1;
  if (ticket?.sla_breached) summary.slaBreached += 1;
  if (ticket?.rating != null) summary.rated += 1;
  summary.call_duration_seconds += Number(durationSeconds) || 0;
}

/**
 * Apply optional dedupe + min call-duration filters and return the tickets that count.
 * Duration filter matches summarizeByDuration: message tickets always count; call tickets
 * only when recording duration is strictly greater than the threshold.
 */
function listCountedTickets(
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
  if (!durationFilterActive) {
    return { counted: list, countedCalls: classified.calls };
  }

  const threshold = Number(minimumCallDuration);
  const countedCalls = classified.calls.filter((item?: any) =>
    callPassesDurationFilter(item, threshold)
  );
  return {
    counted: [
      ...classified.messageTickets.map((item?: any) => item.ticket),
      ...countedCalls.map((item?: any) => item.ticket),
    ],
    countedCalls,
  };
}

function summarizeTicketsByResponsible(tickets: any, countedCalls: any = []) {
  type EmployeeRow = {
    user_id: number | null;
    name: string;
    count: number;
    slaBreached: number;
    rated: number;
    call_duration_seconds: number;
  };
  const durationByTicketId: Map<number, number> = new Map();
  for (const call of countedCalls || []) {
    const id = ticketIdKey(call?.ticket);
    const duration = positiveCallDuration(call);
    if (id == null || duration <= 0) continue;
    durationByTicketId.set(id, (durationByTicketId.get(id) || 0) + duration);
  }

  const byResponsible: Map<number, EmployeeRow> = new Map();
  const unassigned: EmployeeRow = {
    user_id: null,
    name: 'Без ответственного',
    ...emptyTicketSummaryCounts(),
  };
  let hasUnassigned = false;

  for (const ticket of tickets || []) {
    const id = responsibleUserId(ticket);
    const ticketId = ticketIdKey(ticket);
    const duration = ticketId == null ? 0 : Number(durationByTicketId.get(ticketId)) || 0;
    if (id == null) {
      bumpTicketSummaryCounts(unassigned, ticket, duration);
      hasUnassigned = true;
      continue;
    }
    let row = byResponsible.get(id);
    if (!row) {
      const fromTicket = String(ticket?.responsible_name || '').trim();
      row = {
        user_id: id,
        name: fromTicket || `Пользователь #${id}`,
        ...emptyTicketSummaryCounts(),
      };
      byResponsible.set(id, row);
    } else if (row.name.startsWith('Пользователь #')) {
      const fromTicket = String(ticket?.responsible_name || '').trim();
      if (fromTicket) row.name = fromTicket;
    }
    bumpTicketSummaryCounts(row, ticket, duration);
  }

  const employees = [...byResponsible.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.name).localeCompare(String(b.name), 'ru');
  });
  if (hasUnassigned) employees.push(unassigned);

  const summary = emptyTicketSummaryCounts();
  for (const row of employees) {
    summary.count += row.count;
    summary.slaBreached += row.slaBreached;
    summary.rated += row.rated;
    summary.call_duration_seconds += row.call_duration_seconds;
  }

  return { summary, employees };
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
  const { counted, countedCalls } = listCountedTickets(tickets, {
    withoutDuplicates,
    duplicateIntervalMinutes,
    minimumCallDuration,
    channelSettings,
    db,
  });

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

export {
  classifyTicketsForDuration,
  buildDurationSummary,
  listCountedTickets,
  summarizeTicketsByResponsible,
  countTicketsByResponsible,
};
