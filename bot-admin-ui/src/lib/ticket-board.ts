import type { InfiniteData } from "@tanstack/react-query";
import { TICKET_STATUS_OPTIONS } from "./ticket-display";
import type { Ticket } from "./types";

export const TICKET_BOARD_STATUSES = ["Open", "WaitingStaff", "WaitingClient", "Closed"] as const;

const KNOWN_STATUSES = [
  ...TICKET_BOARD_STATUSES.filter((status) => TICKET_STATUS_OPTIONS.some((option) => option.value === status)),
  ...TICKET_STATUS_OPTIONS.map((option) => option.value).filter(
    (status) => !TICKET_BOARD_STATUSES.includes(status as (typeof TICKET_BOARD_STATUSES)[number]),
  ),
];

export type TicketBoardPage = {
  tickets?: Ticket[];
  total: number;
  page: number;
  active_ticket?: Ticket | null;
};

export function visibleBoardStatuses(statusFilter: string[]): string[] {
  const known = new Set<string>(KNOWN_STATUSES);
  const selected = statusFilter.filter((status) => known.has(status));
  return selected.length ? KNOWN_STATUSES.filter((status) => selected.includes(status)) : [...KNOWN_STATUSES];
}

export function ticketBoardQueryKey(status: string, filters: unknown) {
  return ["tickets", "board", status, filters] as const;
}

function findTicket(data: InfiniteData<TicketBoardPage> | undefined, ticketId: number): Ticket | null {
  for (const page of data?.pages || []) {
    const ticket = (page.tickets || []).find((item) => item.id === ticketId);
    if (ticket) return ticket;
  }
  return null;
}

function withActiveTicketStatus<T extends TicketBoardPage>(
  data: InfiniteData<T> | undefined,
  ticketId: number,
  status: string,
): InfiniteData<T> | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.active_ticket || page.active_ticket.id !== ticketId || page.active_ticket.status === status) {
      return page;
    }
    changed = true;
    return { ...page, active_ticket: { ...page.active_ticket, status } };
  });
  return changed ? { ...data, pages } : data;
}

function patchTickets<T extends TicketBoardPage>(
  data: InfiniteData<T> | undefined,
  ticketId: number,
  status: string,
): InfiniteData<T> | undefined {
  const withStatus = withActiveTicketStatus(data, ticketId, status);
  if (!withStatus) return withStatus;
  let changed = withStatus !== data;
  const pages = withStatus.pages.map((page) => {
    let pageChanged = false;
    const tickets = (page.tickets || []).map((ticket) => {
      if (ticket.id !== ticketId || ticket.status === status) return ticket;
      pageChanged = true;
      return { ...ticket, status };
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, tickets };
  });
  return changed ? { ...withStatus, pages } : withStatus;
}

function removeTicket<T extends TicketBoardPage>(
  data: InfiniteData<T> | undefined,
  ticketId: number,
): InfiniteData<T> | undefined {
  if (!data) return data;
  let removed = false;
  const pages = data.pages.map((page) => {
    const tickets = (page.tickets || []).filter((ticket) => {
      if (ticket.id !== ticketId) return true;
      removed = true;
      return false;
    });
    return tickets.length === (page.tickets || []).length ? page : { ...page, tickets };
  });
  if (!removed) return data;
  return {
    ...data,
    pages: pages.map((page) => ({ ...page, total: Math.max(0, page.total - 1) })),
  };
}

function insertTicketAtTop<T extends TicketBoardPage>(
  data: InfiniteData<T> | undefined,
  ticket: Ticket,
): InfiniteData<T> {
  if (findTicket(data, ticket.id)) {
    return patchTickets(data, ticket.id, String(ticket.status || "")) ?? data!;
  }
  if (!data || data.pages.length === 0) {
    return {
      pages: [{ tickets: [ticket], total: 1, page: 1 } as T],
      pageParams: data?.pageParams?.length ? data.pageParams : [1],
    };
  }
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      tickets: index === 0 ? [ticket, ...(page.tickets || [])] : page.tickets,
      total: page.total + 1,
    })),
  };
}

/**
 * Move a ticket from whichever loaded column holds it into `nextStatus`.
 * Totals on both columns change by one. A missing target cache becomes a one-ticket page.
 */
export function moveTicketBetweenBoardColumns<T extends TicketBoardPage>(
  columns: Record<string, InfiniteData<T> | undefined>,
  ticketId: number,
  nextStatus: string,
): Record<string, InfiniteData<T> | undefined> {
  let sourceStatus: string | null = null;
  let ticket: Ticket | null = null;
  for (const [status, data] of Object.entries(columns)) {
    const found = findTicket(data, ticketId);
    if (!found) continue;
    sourceStatus = status;
    ticket = found;
    break;
  }

  const next: Record<string, InfiniteData<T> | undefined> = { ...columns };
  if (!ticket || !sourceStatus) {
    for (const status of Object.keys(next)) {
      next[status] = withActiveTicketStatus(next[status], ticketId, nextStatus);
    }
    return next;
  }

  if (sourceStatus === nextStatus) {
    next[sourceStatus] = patchTickets(columns[sourceStatus], ticketId, nextStatus);
  } else {
    const moved = { ...ticket, status: nextStatus };
    next[sourceStatus] = removeTicket(columns[sourceStatus], ticketId);
    next[nextStatus] = insertTicketAtTop(columns[nextStatus], moved);
  }

  for (const status of Object.keys(next)) {
    next[status] = withActiveTicketStatus(next[status], ticketId, nextStatus);
  }
  return next;
}
