import { useMemo } from "react";
import { usePagedInfiniteQuery } from "./usePagedInfiniteQuery";
import { ticketBoardQueryKey, visibleBoardStatuses, type TicketBoardPage } from "../lib/ticket-board";
import type { Ticket } from "../lib/types";

export type TicketBoardColumnState = {
  id: string;
  tickets: Ticket[];
  total: number;
  isLoading: boolean;
  isRefreshing: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  errorMessage?: string;
  fetchNextPage: () => Promise<unknown>;
};

function columnErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : "Не удалось загрузить тикеты.";
}

function useBoardStatusQuery(
  status: string,
  filters: { statuses: string[] },
  enabled: boolean,
  fetchPage: (status: string, page: number, pageSize: number) => Promise<TicketBoardPage>,
) {
  return usePagedInfiniteQuery({
    queryKey: ticketBoardQueryKey(status, filters),
    queryFn: (page, pageSize) => fetchPage(status, page, pageSize),
    getItems: (data) => data.tickets || [],
    getItemId: (ticket) => ticket.id,
    enabled,
  });
}

export function useTicketBoardColumns<TFilters extends { statuses: string[] }>({
  filters,
  enabled,
  fetchPage,
}: {
  filters: TFilters;
  enabled: boolean;
  fetchPage: (status: string, page: number, pageSize: number) => Promise<TicketBoardPage>;
}) {
  const visible = visibleBoardStatuses(filters.statuses);
  const open = useBoardStatusQuery("Open", filters, enabled && visible.includes("Open"), fetchPage);
  const waitingStaff = useBoardStatusQuery(
    "WaitingStaff",
    filters,
    enabled && visible.includes("WaitingStaff"),
    fetchPage,
  );
  const waitingClient = useBoardStatusQuery(
    "WaitingClient",
    filters,
    enabled && visible.includes("WaitingClient"),
    fetchPage,
  );
  const closed = useBoardStatusQuery("Closed", filters, enabled && visible.includes("Closed"), fetchPage);

  return useMemo(() => {
    const queries = { Open: open, WaitingStaff: waitingStaff, WaitingClient: waitingClient, Closed: closed };
    const columns: TicketBoardColumnState[] = visible.map((status) => {
      const query = queries[status as keyof typeof queries];
      return {
        id: status,
        tickets: query.items,
        total: query.total,
        isLoading: query.isPending,
        isRefreshing: query.isFetching && !query.isFetchingNextPage,
        hasNextPage: Boolean(query.hasNextPage),
        isFetchingNextPage: query.isFetchingNextPage,
        errorMessage: columnErrorMessage(query.error),
        fetchNextPage: () => query.fetchNextPage(),
      };
    });
    const activeTicket =
      columns
        .map((column) => queries[column.id as keyof typeof queries]?.data?.pages[0]?.active_ticket)
        .find((ticket) => ticket) ?? null;
    return {
      columns,
      tickets: columns.flatMap((column) => column.tickets),
      activeTicket,
      isRefreshing: columns.some((column) => column.isRefreshing),
      refetch: () => Promise.all(columns.map((column) => queries[column.id as keyof typeof queries]?.refetch())),
    };
    // Depend on page data / fetch flags, not the whole query object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listed below
  }, [
    visible,
    open.items,
    open.total,
    open.isPending,
    open.isFetching,
    open.isFetchingNextPage,
    open.hasNextPage,
    open.error,
    open.data,
    open.fetchNextPage,
    open.refetch,
    waitingStaff.items,
    waitingStaff.total,
    waitingStaff.isPending,
    waitingStaff.isFetching,
    waitingStaff.isFetchingNextPage,
    waitingStaff.hasNextPage,
    waitingStaff.error,
    waitingStaff.data,
    waitingStaff.fetchNextPage,
    waitingStaff.refetch,
    waitingClient.items,
    waitingClient.total,
    waitingClient.isPending,
    waitingClient.isFetching,
    waitingClient.isFetchingNextPage,
    waitingClient.hasNextPage,
    waitingClient.error,
    waitingClient.data,
    waitingClient.fetchNextPage,
    waitingClient.refetch,
    closed.items,
    closed.total,
    closed.isPending,
    closed.isFetching,
    closed.isFetchingNextPage,
    closed.hasNextPage,
    closed.error,
    closed.data,
    closed.fetchNextPage,
    closed.refetch,
  ]);
}
