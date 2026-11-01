import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import { requireRight } from './bot-admin-auth';
import { enrichTicketsWithLocalData, resolveMissingTicketRecordings, scheduleTicketRecordingDurationBackfill } from './ticket-local-enrichment';
import { listRegosChannelSettings } from '../db/regos-channel-settings';
import { RegosCrmError, DEFAULT_DUPLICATE_INTERVAL_MINUTES, fetchAllTickets, dedupeTickets, summarizeTickets, buildTicketFilters, findLatestTicketForResponsibleUser, postTicketGet } from '../integrations/regos-crm';
import { buildDurationSummary } from './ticket-duration';
import { summarizeByDuration, buildDurationsByTicketId } from '../../public/bot-admin/admin-ticket-summary';
import { resolveSessionRegosUserId, parsePaginationQuery, mapEnrichedActiveTicket } from './bot-admin-shared';
import { seedRecordingUrlCache } from './bot-admin-media';

const INVALID_DURATION_MESSAGE = 'Минимальная длительность должна быть неотрицательной.';

const DEFAULT_TICKET_SORT_ORDER = { column: 'last_update', direction: 'DESC' };

const TICKET_SORT_COLUMNS = new Set([
  'id',
  'client.name',
  'channel_id',
  'status',
  'direction',
  'responsible_user_id',
  'last_update',
  'created_date',
  'sla_breached',
  'rating',
]);

export function parseTicketSortOrder(raw: unknown): { column: string; direction: string } {
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  const trimmed = value.trim();
  if (!trimmed) return { ...DEFAULT_TICKET_SORT_ORDER };
  const splitAt = trimmed.lastIndexOf(':');
  if (splitAt <= 0) return { ...DEFAULT_TICKET_SORT_ORDER };
  const column = trimmed.slice(0, splitAt);
  const direction = trimmed.slice(splitAt + 1).trim().toUpperCase();
  if (!TICKET_SORT_COLUMNS.has(column) || (direction !== 'ASC' && direction !== 'DESC')) {
    return { ...DEFAULT_TICKET_SORT_ORDER };
  }
  return { column, direction };
}

export type TicketListQuery = {
  error?: string;
  page: number;
  limit: number;
  offset: number;
  regosRequest: {
    search?: string;
    filters?: any[];
    sort_orders: { column: string; direction: string }[];
  };
  withoutDuplicates: boolean;
  duplicateIntervalMinutes: number;
  durationFilterActive: boolean;
  minimumCallDuration: number;
};

export function parseTicketListQuery(req: Request): TicketListQuery {
  const { page, limit, offset } = parsePaginationQuery(req);
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const fromDate = String(req.query.from_date || '').trim();
  const toDate = String(req.query.to_date || '').trim();
  const responsibleUserId = String(req.query.responsible_user_id || '').trim();
  const channelId = String(req.query.channel_id || '').trim();
  const minimumCallDurationRaw = String(req.query.minimum_call_duration_seconds || '').trim();
  const durationFilterActive = minimumCallDurationRaw !== '';
  const minimumCallDuration = Number(minimumCallDurationRaw);
  const withoutDuplicates =
    req.query.without_duplicates === '1' || req.query.without_duplicates === 'true';
  let duplicateIntervalMinutes = Number(req.query.duplicate_interval_minutes);
  if (!Number.isFinite(duplicateIntervalMinutes) || duplicateIntervalMinutes < 0) {
    duplicateIntervalMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES;
  }

  const filters = buildTicketFilters({
    status: status || undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    responsibleUserId: responsibleUserId || undefined,
    channelId: channelId || undefined,
  });

  const parsed: TicketListQuery = {
    page,
    limit,
    offset,
    regosRequest: {
      search: q || undefined,
      filters: filters.length ? filters : undefined,
      sort_orders: [parseTicketSortOrder(req.query.sort)],
    },
    withoutDuplicates,
    duplicateIntervalMinutes,
    durationFilterActive,
    minimumCallDuration,
  };

  if (
    durationFilterActive &&
    (!Number.isFinite(minimumCallDuration) || minimumCallDuration < 0)
  ) {
    parsed.error = INVALID_DURATION_MESSAGE;
  }

  return parsed;
}

function applyDuplicateFilter(tickets: any[], query: TicketListQuery) {
  if (!query.withoutDuplicates) return tickets;
  return dedupeTickets(tickets, query.duplicateIntervalMinutes);
}

function summarizeFilteredTickets(db: Db, tickets: any[], query: TicketListQuery) {
  if (!query.durationFilterActive) return summarizeTickets(tickets);
  const durationSummary = buildDurationSummary(tickets, listRegosChannelSettings(db), db);
  return summarizeByDuration(
    durationSummary,
    buildDurationsByTicketId(durationSummary),
    query.minimumCallDuration
  );
}

export async function loadTicketSummary(db: Db, query: TicketListQuery) {
  const tickets = applyDuplicateFilter(await fetchAllTickets(query.regosRequest), query);
  return summarizeFilteredTickets(db, tickets, query);
}

async function enrichTicketPage(
  db: Db,
  recordingUrlCache: Map<any, any>,
  cacheTicketRecordingUrl: (ticket?: any) => any,
  rows: any[]
) {
  const pageTickets = enrichTicketsWithLocalData(db, rows);
  // Keep list responses fast: sync missing URLs only, never download audio here.
  await resolveMissingTicketRecordings(db, pageTickets, { fetchDuration: false });
  for (const ticket of pageTickets) {
    const href = ticket?.local?.recording?.url;
    if (href) {
      seedRecordingUrlCache(recordingUrlCache, ticket.id, href);
    } else {
      cacheTicketRecordingUrl(ticket);
    }
  }
  // Warm duration cache after the response path; cooldown skips repeated failures.
  scheduleTicketRecordingDurationBackfill(db, pageTickets);
  return pageTickets;
}

export function registerBotAdminTicketsCollectionRoutes(router: any, deps: { db: Db; recordingUrlCache: Map<any, any>; cacheTicketRecordingUrl: (ticket?: any) => any }) {
  const { db, recordingUrlCache, cacheTicketRecordingUrl } = deps;
  router.get('/api/tickets', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const query = parseTicketListQuery(req);
      if (query.error) {
        return res.status(400).json({ message: query.error });
      }

      // Active ticket is always for the session REGOS user, not the list filter.
      const activeForUserId = resolveSessionRegosUserId(db, req) || null;
      const activeTicketPromise = activeForUserId
        ? findLatestTicketForResponsibleUser(activeForUserId).then((latest?: any) =>
            mapEnrichedActiveTicket(db, latest)
          )
        : Promise.resolve(null);

      if (!query.withoutDuplicates) {
        const [pageResult, activeTicket] = await Promise.all([
          postTicketGet({
            ...query.regosRequest,
            limit: query.limit,
            offset: query.offset,
          }),
          activeTicketPromise,
        ]);
        const pageTickets = await enrichTicketPage(
          db,
          recordingUrlCache,
          cacheTicketRecordingUrl,
          pageResult.result
        );
        return res.json({
          tickets: pageTickets,
          total: pageResult.total,
          page: query.page,
          limit: query.limit,
          active_ticket: activeTicket,
          active_ticket_user_id: activeForUserId ? Number(activeForUserId) : null,
        });
      }

      let [tickets, activeTicket] = await Promise.all([
        fetchAllTickets(query.regosRequest),
        activeTicketPromise,
      ]);
      tickets = applyDuplicateFilter(tickets, query);
      const summary = summarizeFilteredTickets(db, tickets, query);
      const total = tickets.length;
      const totalPages = Math.max(1, Math.ceil(total / query.limit) || 1);
      let page = query.page;
      if (page > totalPages) page = totalPages;
      const safeOffset = (page - 1) * query.limit;
      const pageTickets = await enrichTicketPage(
        db,
        recordingUrlCache,
        cacheTicketRecordingUrl,
        tickets.slice(safeOffset, safeOffset + query.limit)
      );

      return res.json({
        tickets: pageTickets,
        total,
        page,
        limit: query.limit,
        summary,
        active_ticket: activeTicket,
        active_ticket_user_id: activeForUserId ? Number(activeForUserId) : null,
      });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('List tickets error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить тикеты.' });
    }
  });

}
