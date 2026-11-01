import type { Unchecked } from '../types/unchecked';
import { RegosCrmError, PAGE_LIMIT, parseRegosCreatedId, postRegosMutation, postTicketGet, postUserGet, postChannelGet, postChatGet, requirePositiveId } from './regos-crm-http';

const DEFAULT_DUPLICATE_INTERVAL_MINUTES = 10;

/**
 * Ensure a Regos user is among ticket staff participants (Ticket/SetParticipants, append).
 */
async function ensureTicketParticipant(ticketId?: any, userId?: any) {
  const id = Number(ticketId);
  const uid = Number(userId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(uid) || uid <= 0) {
    throw new RegosCrmError('Некорректный ticket id или user id для участников.', {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  return setTicketParticipants(id, [uid], { replaceMode: false });
}

/**
 * Normalize a participant_user_ids payload into unique positive integers.
 */
function normalizeParticipantUserIds(value?: any) {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const ids: any[] = [];
  const seen: Set<any> = new Set();
  for (const item of list) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function participantUserIdsEqual(a?: any, b?: any) {
  const left = [...normalizeParticipantUserIds(a)].sort((x?: any, y?: any) => x - y);
  const right = [...normalizeParticipantUserIds(b)].sort((x?: any, y?: any) => x - y);
  if (left.length !== right.length) return false;
  return left.every((id?: any, index?: any) => id === right[index]);
}

/**
 * Replace or append CRM ticket staff participants (Ticket/SetParticipants).
 * replace_mode true replaces the list; false appends the provided users.
 */
async function setTicketParticipants(ticketId: any, participantUserIds: any, { replaceMode = true }: Unchecked = {}) {
  const id = requirePositiveId(ticketId, 'id');
  const ids = normalizeParticipantUserIds(participantUserIds);
  const data = await postRegosMutation('Ticket/SetParticipants', {
    id,
    participant_user_ids: ids,
    replace_mode: Boolean(replaceMode),
  });
  return data.result;
}

function isTicketStaffParticipant(ticket?: any, userId?: any) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0 || !ticket) return false;
  if (Number(ticket.responsible_user_id) === uid) return true;
  const participants = Array.isArray(ticket.participant_user_ids)
    ? ticket.participant_user_ids
    : [];
  return participants.some((id?: any) => Number(id) === uid);
}

async function fetchAllTickets(request: any = {}) {
  const all: any[] = [];
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

async function fetchAllUsers({ activeOnly = true, search }: Unchecked = {}) {
  const all: any[] = [];
  let offset = 0;
  const filters: any[] = [];
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

async function fetchAllChannels({ activeOnly = false, search }: Unchecked = {}) {
  const all: any[] = [];
  let offset = 0;
  const filters: any[] = [];
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

function normalizeTicketDirection(value: any, { optional = false }: Unchecked = {}) {
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

function normalizeTicketSubject(value?: any) {
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

async function createTicket(input: any = {}) {
  const request: Unchecked = {
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

async function editTicket(ticketId: any, changes: any = {}) {
  const request: Unchecked = { id: requirePositiveId(ticketId, 'id') };
  if (Object.hasOwn(changes, 'subject')) {
    request.subject = normalizeTicketSubject(changes.subject);
  }
  if (Object.hasOwn(changes, 'description')) {
    request.description = String(changes.description ?? '').trim();
  }
  if (Object.hasOwn(changes, 'direction')) {
    request.direction = normalizeTicketDirection(changes.direction);
  }
  const editableKeys = Object.keys(request).filter((key?: any) => key !== 'id');
  if (editableKeys.length === 0) return { changed: false, result: null };
  const data = await postRegosMutation('Ticket/Edit', request);
  return { changed: true, result: data.result };
}

async function setTicketStatus(ticketId?: any, status?: any) {
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

async function setTicketResponsible(ticketId?: any, responsibleUserId?: any) {
  const data = await postRegosMutation('Ticket/SetResponsible', {
    id: requirePositiveId(ticketId, 'id'),
    responsible_user_id: requirePositiveId(responsibleUserId, 'responsible_user_id'),
  });
  return data.result;
}

function mapRegosChannelSummary(channel: any = {}) {
  return {
    id: channel.id,
    name: channel.name || null,
    active: channel.active !== false,
  };
}

/**
 * Keep one ticket per same-client cluster created within the given window.
 * Walks chronologically per client and drops tickets within the window of the last kept one.
 */
function dedupeTickets(tickets: any, windowMinutes: any = DEFAULT_DUPLICATE_INTERVAL_MINUTES) {
  const windowSeconds = Math.max(0, Number(windowMinutes) || 0) * 60;
  const byClient: Map<any, any> = new Map();

  for (const ticket of tickets) {
    const list = byClient.get(ticket.client_id) || [];
    list.push(ticket);
    byClient.set(ticket.client_id, list);
  }

  const kept: any[] = [];

  for (const group of byClient.values()) {
    group.sort((a?: any, b?: any) => {
      if (a.created_date !== b.created_date) {
        return a.created_date - b.created_date;
      }
      return a.id - b.id;
    });

    let lastKept: any = null;
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

  kept.sort((a?: any, b?: any) => {
    const updateA = Number(a.last_update || a.created_date) || 0;
    const updateB = Number(b.last_update || b.created_date) || 0;
    if (updateA !== updateB) {
      return updateB - updateA;
    }
    return b.id - a.id;
  });

  return kept;
}

function summarizeTickets(tickets?: any) {
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

const TICKET_STATUSES = ['Open', 'Closed', 'WaitingClient', 'WaitingStaff'];

function parseTicketStatuses(status?: any) {
  const raw = Array.isArray(status) ? status : String(status || '').split(',');
  const allowed: Set<any> = new Set(TICKET_STATUSES);
  return [...new Set(raw.map((item?: any) => String(item || '').trim()).filter((item?: any) => allowed.has(item)))];
}

function parseTicketFilterIds(value?: any) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((item?: any) => String(item || '').trim()).filter(Boolean))];
}

function pushTicketIdFilter(filters?: any, field?: any, value?: any) {
  const ids = parseTicketFilterIds(value);
  if (ids.length === 1) {
    filters.push({ Field: field, Operator: 'equal', Value: ids[0] });
  } else if (ids.length > 1) {
    filters.push({ Field: field, Operator: 'in', Value: ids.join(',') });
  }
}

function buildTicketFilters({ status, fromDate, toDate, responsibleUserId, channelId }: Unchecked = {}) {
  const filters: any[] = [];
  const statuses = parseTicketStatuses(status);

  if (statuses.length === 1) {
    filters.push({ Field: 'status', Operator: 'equal', Value: statuses[0] });
  } else if (statuses.length > 1) {
    filters.push({ Field: 'status', Operator: 'in', Value: statuses.join(',') });
  }
  if (fromDate != null && fromDate !== '') {
    filters.push({ Field: 'from_date', Operator: 'equal', Value: String(fromDate) });
  }
  if (toDate != null && toDate !== '') {
    filters.push({ Field: 'to_date', Operator: 'equal', Value: String(toDate) });
  }
  pushTicketIdFilter(filters, 'responsible_user_id', responsibleUserId);
  pushTicketIdFilter(filters, 'channel_id', channelId);

  return filters;
}

/**
 * Latest ticket for a responsible user by created_date DESC (ignores list filters).
 */
async function findLatestTicketForResponsibleUser(responsibleUserId?: any) {
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

async function findTicketById(ticketId?: any) {
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

async function findTicketByChatId(chatId?: any) {
  const id = String(chatId || '').trim();
  if (!id) return null;

  // Ticket/Get has no chat_id filter; Chat/Get returns the linked Ticket entity_id.
  const page = await postChatGet({
    filters: [{ Field: 'id', Operator: 'equal', Value: id }],
    limit: 1,
    offset: 0,
  });
  const chat =
    (page.result || []).find((row?: any) => String(row?.id || '').trim() === id) || page.result[0] || null;
  if (!chat || String(chat.entity_type || '') !== 'Ticket') {
    return null;
  }

  return findTicketById(chat.entity_id);
}

async function fetchTicketsByClientId(clientId?: any) {
  const id = Number(clientId);
  if (!Number.isFinite(id) || id <= 0) return [];
  return fetchAllTickets({
    filters: [{ Field: 'client_id', Operator: 'equal', Value: String(id) }],
  });
}

/** Active when the latest ticket is Open or WaitingStaff. */
const ACTIVE_TICKET_STATUSES: Set<any> = new Set(['Open', 'WaitingStaff']);

function resolveActiveTicket(ticket?: any) {
  if (!ticket || !ACTIVE_TICKET_STATUSES.has(ticket.status)) {
    return null;
  }
  return ticket;
}

function mapActiveTicket(ticket?: any) {
  if (!ticket) return null;
  const mapped: Unchecked = {
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

export {
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  ensureTicketParticipant,
  setTicketParticipants,
  normalizeParticipantUserIds,
  participantUserIdsEqual,
  isTicketStaffParticipant,
  fetchAllTickets,
  fetchAllUsers,
  fetchAllChannels,
  createTicket,
  editTicket,
  setTicketStatus,
  setTicketResponsible,
  mapRegosChannelSummary,
  dedupeTickets,
  summarizeTickets,
  buildTicketFilters,
  findLatestTicketForResponsibleUser,
  findTicketById,
  findTicketByChatId,
  fetchTicketsByClientId,
  resolveActiveTicket,
  mapActiveTicket,
};
