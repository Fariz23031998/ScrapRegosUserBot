import { ColumnDef, type SortingState } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Check, Columns3, Menu, Plus, RefreshCw, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createOrder } from "../api/admin";
import {
  createTicket,
  getClient,
  getFirm,
  linkClientFirm,
  listTicketChannels,
  listTicketSummary,
  listTickets,
  listTicketUsers,
  type TicketSummaryCounts,
  searchFirms,
  searchTicketClients,
  ticketRecordingUrl,
  unlinkClientFirm,
  updateClient,
  updateTicket,
} from "../api/tickets";
import filterFunnelIcon from "../assets/filter-funnel.png";
import CheckboxSelect from "../components/CheckboxSelect";
import EntityAvatar from "../components/EntityAvatar";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import Modal from "../components/Modal";
import SearchField from "../components/SearchField";
import PhoneCopyButton from "../components/PhoneCopyButton";
import SimpleTable from "../components/SimpleTable";
import SummaryBar from "../components/SummaryBar";
import TicketBoard from "../components/TicketBoard";
import TicketCards, { TicketRecordingControl } from "../components/TicketCards";
import TicketParticipantsPicker from "../components/TicketParticipantsPicker";
import { PeriodFilterButton, TicketPeriodModal } from "../components/TicketPeriodModal";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useTicketBoardColumns } from "../hooks/useTicketBoardColumns";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import { useTicketRecordingDurations } from "../hooks/useTicketListDurations";
import { useTicketEvents } from "../hooks/useTicketEvents";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { useAdminShell } from "../lib/admin-shell";
import {
  moveTicketBetweenBoardColumns,
  TICKET_BOARD_STATUSES,
  ticketBoardQueryKey,
} from "../lib/ticket-board";
import {
  channelDisplayName,
  datetimeLocalToUnix,
  directionLabel,
  firmButtonLabel,
  firmTypeLabel,
  formatUnix,
  getCachedRecordingDuration,
  getTicketClientId,
  getTicketPeriodDefaults,
  hasLookupPhone,
  statusBadgeClass,
  statusLabel,
  TICKET_STATUS_OPTIONS,
  parseTicketIds,
  parseTicketStatuses,
  technicalSupportDisplay,
  unpaidOrdersHref,
  unpaidOrdersLabel,
  userDisplayName,
} from "../lib/ticket-display";
import type { FirmSearchResult, Ticket, TicketFirmLink } from "../lib/types";
import { sanitizeTelegramHtml } from "../lib/utils";

const FILTERS_STORAGE_KEY = "bot-admin.tickets.filters";
const TICKET_VIEW_STORAGE_KEY = "bot-admin.tickets.view";

type TicketListView = "table" | "cards";

function loadTicketListView(): TicketListView {
  try {
    return localStorage.getItem(TICKET_VIEW_STORAGE_KEY) === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}

function saveTicketListView(view: TicketListView) {
  try {
    localStorage.setItem(TICKET_VIEW_STORAGE_KEY, view);
  } catch {
    /* ignore */
  }
}

type TicketListPage = {
  tickets?: Ticket[];
  total: number;
  page: number;
  summary?: TicketSummaryCounts | null;
  active_ticket?: Ticket | null;
};

function patchTicketStatusInPages(
  data: InfiniteData<TicketListPage> | undefined,
  ticketId: number,
  status: string,
): InfiniteData<TicketListPage> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      tickets: (page.tickets || []).map((ticket) => (ticket.id === ticketId ? { ...ticket, status } : ticket)),
      active_ticket:
        page.active_ticket && page.active_ticket.id === ticketId
          ? { ...page.active_ticket, status }
          : page.active_ticket,
    })),
  };
}

type TicketFilters = {
  search: string;
  statuses: string[];
  users: string[];
  channels: string[];
  dateFrom: string;
  dateTo: string;
  minDuration: string;
  withoutDuplicates: boolean;
  duplicateInterval: string;
};

function defaultFilters(periodDays?: number): TicketFilters {
  const period = getTicketPeriodDefaults(periodDays);
  return {
    search: "",
    statuses: [],
    users: [],
    channels: [],
    dateFrom: period.from,
    dateTo: period.to,
    minDuration: "",
    withoutDuplicates: false,
    duplicateInterval: "10",
  };
}

type LoadedFilters = {
  filters: TicketFilters;
  fromStorage: boolean;
};

function loadFilters(periodDays?: number): LoadedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { filters: defaultFilters(periodDays), fromStorage: false };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return { filters: defaultFilters(periodDays), fromStorage: false };
    }
    const base = defaultFilters(periodDays);
    return {
      fromStorage: true,
      filters: {
        ...base,
        statuses: parseTicketStatuses(parsed.statuses ?? parsed.status),
        // Empty list is a valid persisted choice ("Все") — do not treat it as missing.
        users: parseTicketIds(parsed.responsibleUserId ?? parsed.user),
        channels: parseTicketIds(parsed.channelId ?? parsed.channel),
        withoutDuplicates: Boolean(parsed.withoutDuplicates),
        minDuration:
          parsed.minimumCallDuration != null && parsed.minimumCallDuration !== ""
            ? String(parsed.minimumCallDuration)
            : typeof parsed.minDuration === "string"
              ? parsed.minDuration
              : base.minDuration,
        duplicateInterval:
          typeof parsed.duplicateInterval === "string" ? parsed.duplicateInterval : base.duplicateInterval,
      },
    };
  } catch {
    return { filters: defaultFilters(periodDays), fromStorage: false };
  }
}

function saveFilters(filters: TicketFilters) {
  try {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({
        status: filters.statuses,
        responsibleUserId: filters.users,
        channelId: filters.channels,
        withoutDuplicates: filters.withoutDuplicates,
        minimumCallDuration: filters.minDuration,
      }),
    );
  } catch {
    /* ignore */
  }
}

const TICKET_SORT_FIELDS: Record<string, string> = {
  id: "id",
  client: "client.name",
  channel: "channel_id",
  status: "status",
  direction: "direction",
  responsible: "responsible_user_id",
  updated: "last_update",
  created: "created_date",
  sla: "sla_breached",
  rating: "rating",
};

function ticketSortQuery(sorting: SortingState): string {
  const primary = sorting.find((item) => TICKET_SORT_FIELDS[item.id]);
  if (!primary) return "";
  return `${TICKET_SORT_FIELDS[primary.id]}:${primary.desc ? "desc" : "asc"}`;
}

function buildListParams(
  page: number,
  limit: number,
  filters: TicketFilters,
  sort = "",
): Record<string, string> {
  const params: Record<string, string> = {
    page: String(page),
    limit: String(limit),
  };
  if (sort) params.sort = sort;
  if (filters.search) params.q = filters.search;
  if (filters.statuses.length) params.status = filters.statuses.join(",");
  if (filters.users.length) params.responsible_user_id = filters.users.join(",");
  if (filters.channels.length) params.channel_id = filters.channels.join(",");
  const fromUnix = datetimeLocalToUnix(filters.dateFrom);
  const toUnix = datetimeLocalToUnix(filters.dateTo);
  if (fromUnix != null) params.from_date = String(fromUnix);
  if (toUnix != null) params.to_date = String(toUnix);
  if (filters.minDuration) params.minimum_call_duration_seconds = filters.minDuration;
  if (filters.withoutDuplicates) {
    params.without_duplicates = "1";
    params.duplicate_interval_minutes = filters.duplicateInterval;
  }
  return params;
}

function buildSummaryParams(filters: TicketFilters): Record<string, string> {
  const params = buildListParams(1, 25, filters);
  delete params.page;
  delete params.limit;
  delete params.sort;
  return params;
}

function readEmbeddedSummary(summary: TicketListPage["summary"]): TicketSummaryCounts | null {
  if (!summary || summary.count == null) return null;
  return {
    count: summary.count,
    slaBreached: summary.slaBreached ?? 0,
    rated: summary.rated ?? 0,
  };
}

function regosUserLabel(user: { full_name?: string | null; login?: string | null; id: number }) {
  return user.full_name || user.login || `Пользователь #${user.id}`;
}

function filtersHaveAdvancedValues(filters: TicketFilters, periodDays?: number) {
  const defaults = defaultFilters(periodDays);
  return (
    Boolean(filters.statuses.length) ||
    Boolean(filters.users.length) ||
    Boolean(filters.channels.length) ||
    filters.dateFrom !== defaults.dateFrom ||
    filters.dateTo !== defaults.dateTo ||
    Boolean(filters.minDuration) ||
    filters.withoutDuplicates
  );
}

function TicketViewSwitch({
  view,
  onChange,
}: {
  view: TicketListView;
  onChange: (view: TicketListView) => void;
}) {
  return (
    <div className="ticket-view-switch role-tabs" role="tablist" aria-label="Вид списка тикетов">
      <button
        type="button"
        className={`role-tab${view === "table" ? " role-tab--active" : ""}`}
        role="tab"
        aria-label="Таблица"
        title="Таблица"
        aria-selected={view === "table"}
        onClick={() => onChange("table")}
      >
        <Table2 size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`role-tab${view === "cards" ? " role-tab--active" : ""}`}
        role="tab"
        aria-label="Карточки"
        title="Карточки"
        aria-selected={view === "cards"}
        onClick={() => onChange("cards")}
      >
        <Columns3 size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

type TicketFilterFieldsProps = {
  filters: TicketFilters;
  setFilters: (next: TicketFilters) => void;
  users: Array<{ id: number; full_name?: string | null; login?: string | null }>;
  channels: Array<{ id: number; name?: string }>;
  onOpenPeriod: () => void;
  showActions?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
};

function TicketFilterFields({
  filters,
  setFilters,
  users,
  channels,
  onOpenPeriod,
  showActions = false,
  onRefresh,
  refreshing,
}: TicketFilterFieldsProps) {
  return (
    <>
      <CheckboxSelect
        label="Статус"
        values={filters.statuses}
        options={TICKET_STATUS_OPTIONS}
        onChange={(statuses) => setFilters({ ...filters, statuses })}
      />
      <CheckboxSelect
        label="Ответственный"
        values={filters.users}
        options={users.map((user) => ({
          value: String(user.id),
          label: regosUserLabel(user),
        }))}
        onChange={(nextUsers) => setFilters({ ...filters, users: nextUsers })}
      />
      <CheckboxSelect
        label="Канал"
        values={filters.channels}
        options={channels.map((channel) => ({
          value: String(channel.id),
          label: channel.name || `ID ${channel.id}`,
        }))}
        onChange={(nextChannels) => setFilters({ ...filters, channels: nextChannels })}
      />
      <label className="ticket-filters__field ticket-filters__field--period">
        <span>Период</span>
        <PeriodFilterButton
          dateFrom={filters.dateFrom}
          dateTo={filters.dateTo}
          onClick={onOpenPeriod}
        />
      </label>
      <label className="ticket-filters__field">
        <span>Мин. длительность (с)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={filters.minDuration}
          onChange={(e) => setFilters({ ...filters, minDuration: e.target.value })}
          placeholder="Не учитывать"
        />
      </label>
      <label className="ticket-filters__field ticket-filters__field--checkbox">
        <span>Без дубликатов</span>
        <input
          type="checkbox"
          checked={filters.withoutDuplicates}
          onChange={(e) => setFilters({ ...filters, withoutDuplicates: e.target.checked })}
        />
      </label>
      {filters.withoutDuplicates ? (
        <label className="ticket-filters__field">
          <span>Интервал (мин)</span>
          <select
            value={filters.duplicateInterval}
            onChange={(e) => setFilters({ ...filters, duplicateInterval: e.target.value })}
          >
            {[5, 10, 15, 30, 60].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {showActions ? (
        <div className="ticket-filters__actions">
          <button
            type="button"
            className="btn-secondary btn-icon"
            aria-label="Обновить"
            title="Обновить"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
          <button type="submit" className="btn-primary btn-icon" aria-label="Применить" title="Применить">
            <Check size={18} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}

export default function TicketsPage() {
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const { toggleNav } = useAdminShell();
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  useStickyOffsetVar(stickyHeadRef);
  const { hasPermission, actor } = useAuth();
  const { dateTimeFormat, ticketPeriodDays } = useUiPreferences();
  const queryClient = useQueryClient();
  const [filterBootstrap] = useState(() => loadFilters(ticketPeriodDays));
  const [ticketView, setTicketView] = useState<TicketListView>(loadTicketListView);
  const [filters, setFilters] = useState(filterBootstrap.filters);
  const [appliedFilters, setAppliedFilters] = useState(filterBootstrap.filters);
  const [ticketSorting, setTicketSorting] = useState<SortingState>([]);
  const ticketSort = useMemo(() => ticketSortQuery(ticketSorting), [ticketSorting]);
  const listScope = useMemo(() => ({ ...appliedFilters, sort: ticketSort }), [appliedFilters, ticketSort]);
  const handleTicketSortingChange = useCallback((sorting: SortingState) => {
    setTicketSorting(sorting);
  }, []);
  // Only auto-default Ответственный when nothing was persisted yet (matches legacy admin UI).
  const [filtersReady, setFiltersReady] = useState(filterBootstrap.fromStorage);
  const [successMessage, setSuccessMessage] = useState("");
  const [boardError, setBoardError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [clientQuery, setClientQuery] = useState("");
  const [selectedClient, setSelectedClient] = useState<{
    id: number;
    name?: string;
    phone?: string;
    email?: string;
  } | null>(null);
  const [createError, setCreateError] = useState("");

  const [recordingTicket, setRecordingTicket] = useState<Ticket | null>(null);
  const [clientEditId, setClientEditId] = useState<number | null>(null);
  const [firmDetail, setFirmDetail] = useState<{
    type: string;
    recordId: string;
    title: string;
    message?: string | null;
  } | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);

  useTicketEvents(hasPermission("tickets_read"));

  const canEditClients = hasPermission("clients_edit");
  const canLinkClientFirms = hasPermission("clients_link_firm");
  const canEditTickets = hasPermission("tickets_edit");
  const canEditClosedTickets = hasPermission("tickets_edit_closed");

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  useEffect(() => {
    if (filtersReady) return;
    if (actor?.regosUserId != null) {
      const user = String(actor.regosUserId);
      setFilters((current) => ({ ...current, users: [user] }));
      setAppliedFilters((current) => ({ ...current, users: [user] }));
    }
    setFiltersReady(true);
  }, [actor?.regosUserId, filtersReady]);

  const usersQuery = useQuery({ queryKey: ["ticket-users"], queryFn: listTicketUsers });
  const channelsQuery = useQuery({ queryKey: ["ticket-channels"], queryFn: listTicketChannels });
  const clientsQuery = useQuery({
    queryKey: ["ticket-clients", clientQuery],
    queryFn: () => searchTicketClients(clientQuery),
    enabled: clientQuery.trim().length >= 2,
  });

  const ticketsQuery = usePagedInfiniteQuery({
    queryKey: ["tickets", listScope],
    queryFn: (page, pageSize) => listTickets(buildListParams(page, pageSize, appliedFilters, ticketSort)),
    getItems: (data) => data.tickets || [],
    getItemId: (ticket) => ticket.id,
    enabled: filtersReady && ticketView !== "cards",
    keepPrevious: true,
  });
  const board = useTicketBoardColumns({
    filters: listScope,
    enabled: filtersReady && ticketView === "cards",
    fetchPage: (status, page, pageSize) =>
      listTickets(buildListParams(page, pageSize, { ...appliedFilters, statuses: [status] }, ticketSort)),
  });

  const userNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const user of usersQuery.data?.users || []) {
      map[String(user.id)] = regosUserLabel(user);
    }
    return map;
  }, [usersQuery.data?.users]);

  const channelNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const channel of channelsQuery.data?.channels || []) {
      map[String(channel.id)] = channel.name || `Канал #${channel.id}`;
    }
    return map;
  }, [channelsQuery.data?.channels]);

  const tickets = ticketsQuery.items;
  const total = ticketsQuery.total;
  const firstPage = ticketsQuery.data?.pages[0];
  const cardView = ticketView === "cards";
  const activeTicket = (cardView ? board.activeTicket : firstPage?.active_ticket) || null;
  const recordingDurations = useTicketRecordingDurations(cardView ? board.tickets : tickets);
  const embeddedSummary = cardView ? null : readEmbeddedSummary(firstPage?.summary);
  const firstPageReady = Boolean(ticketsQuery.data?.pages.length);
  const summaryQuery = useQuery({
    queryKey: ["tickets-summary", appliedFilters],
    queryFn: () => listTicketSummary(buildSummaryParams(appliedFilters)),
    enabled: filtersReady && (cardView || (firstPageReady && !embeddedSummary)),
  });
  const summary = embeddedSummary ?? summaryQuery.data?.summary ?? null;
  const summaryPending = !summary && !summaryQuery.isError && (cardView || !ticketsQuery.isError);
  const listRefreshing = cardView
    ? board.isRefreshing
    : ticketsQuery.isFetching && !ticketsQuery.isFetchingNextPage;

  function readBoardColumns() {
    const columns: Record<string, InfiniteData<TicketListPage> | undefined> = {};
    for (const status of TICKET_BOARD_STATUSES) {
      columns[status] = queryClient.getQueryData<InfiniteData<TicketListPage>>(
        ticketBoardQueryKey(status, listScope),
      );
    }
    return columns;
  }

  function writeBoardColumns(
    current: Record<string, InfiniteData<TicketListPage> | undefined>,
    moved: Record<string, InfiniteData<TicketListPage> | undefined>,
  ) {
    for (const status of TICKET_BOARD_STATUSES) {
      if (moved[status] === current[status]) continue;
      queryClient.setQueryData(ticketBoardQueryKey(status, listScope), moved[status]);
    }
  }

  function refreshTicketList() {
    if (cardView) {
      void board.refetch();
      void summaryQuery.refetch();
      return;
    }
    void ticketsQuery.refetch();
    if (!embeddedSummary) void summaryQuery.refetch();
  }

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => updateTicket(id, { status }),
    onMutate: async ({ id, status }) => {
      setBoardError("");
      await queryClient.cancelQueries({ queryKey: ["tickets", listScope] });
      await Promise.all(
        TICKET_BOARD_STATUSES.map((columnStatus) =>
          queryClient.cancelQueries({ queryKey: ticketBoardQueryKey(columnStatus, listScope) }),
        ),
      );
      const previous = queryClient.getQueryData<InfiniteData<TicketListPage>>(["tickets", listScope]);
      const previousBoard = readBoardColumns();
      queryClient.setQueryData<InfiniteData<TicketListPage>>(["tickets", listScope], (current) =>
        patchTicketStatusInPages(current, id, status),
      );
      writeBoardColumns(previousBoard, moveTicketBetweenBoardColumns(previousBoard, id, status));
      return { previous, previousBoard };
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["tickets", listScope], context.previous);
      }
      if (context?.previousBoard) {
        for (const status of TICKET_BOARD_STATUSES) {
          const key = ticketBoardQueryKey(status, listScope);
          const previousColumn = context.previousBoard[status];
          if (previousColumn === undefined) {
            queryClient.removeQueries({ queryKey: key, exact: true });
          } else {
            queryClient.setQueryData(key, previousColumn);
          }
        }
      }
      setBoardError(error.message || "Не удалось изменить статус.");
    },
    onSuccess: (data, { id }) => {
      const nextStatus = data.ticket?.status;
      if (!nextStatus) return;
      queryClient.setQueryData<InfiniteData<TicketListPage>>(["tickets", listScope], (current) =>
        patchTicketStatusInPages(current, id, String(nextStatus)),
      );
      const currentBoard = readBoardColumns();
      writeBoardColumns(currentBoard, moveTicketBetweenBoardColumns(currentBoard, id, String(nextStatus)));
    },
  });

  const createMutation = useMutation({
    mutationFn: createTicket,
    onSuccess: (data) => {
      setCreateOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      navigate(`/tickets/${data.ticket.id}`);
    },
    onError: (error: Error) => setCreateError(error.message),
  });

  const columns = useMemo<ColumnDef<Ticket>[]>(
    () => [
      { id: "id", header: "ID", accessorKey: "id" },
      {
        id: "subject",
        header: "Тема",
        accessorKey: "subject",
        enableSorting: false,
        cell: ({ getValue }) => getValue() || "—",
      },
      {
        id: "client",
        header: "Клиент",
        accessorFn: (row) => row.client?.name || row.client_name || "",
        cell: ({ row }) => {
          const client = row.original.client;
          const name = client?.name || "—";
          const phone = client?.phone || row.original.client_phone || "";
          const clientId = getTicketClientId(row.original);
          const hasClient = Boolean(clientId || client?.name);
          const canOpenClient = Boolean(clientId && (canEditClients || canLinkClientFirms));
          const avatar = <EntityAvatar src={client?.photo_url} name={client?.name || name} size="sm" />;
          return (
            <span className="ticket-client-cell">
              {hasClient ? (
                canOpenClient ? (
                  <button
                    type="button"
                    className="ticket-client-avatar-btn"
                    aria-label={`Редактировать клиента ${name}`}
                    title="Редактировать клиента"
                    onClick={(event) => {
                      event.stopPropagation();
                      setClientEditId(clientId);
                    }}
                  >
                    {avatar}
                  </button>
                ) : (
                  <span className="ticket-client-avatar-static">{avatar}</span>
                )
              ) : null}
              <span className="ticket-client-name">{name}</span>
              {phone ? <PhoneCopyButton phone={phone} /> : null}
            </span>
          );
        },
      },
      {
        id: "unpaid",
        header: "Неоплаченные",
        enableSorting: false,
        cell: ({ row }) => {
          const ticket = row.original;
          if (!hasLookupPhone(ticket)) return "—";
          const label = unpaidOrdersLabel(ticket);
          if (!label) return <span className="badge badge--muted">Нет</span>;
          const href = unpaidOrdersHref(ticket);
          return href ? (
            <Link to={href} onClick={(event) => event.stopPropagation()} className="ticket-unpaid-link">
              {label}
            </Link>
          ) : (
            label
          );
        },
      },
      {
        id: "ts",
        header: "ТП",
        enableSorting: false,
        cell: ({ row }) => {
          const display = technicalSupportDisplay(row.original);
          if (display.kind === "missing") return "—";
          if (display.kind === "none") return <span className="badge badge--muted">Нет</span>;
          if (display.kind === "active") {
            return (
              <span className="badge badge--ok" title={`Действует до ${display.dateLabel}`}>
                До {display.dateLabel}
              </span>
            );
          }
          return (
            <span className="badge badge--warn" title={`Истекла ${display.dateLabel}`}>
              Истекла {display.dateLabel}
            </span>
          );
        },
      },
      {
        id: "firms",
        header: "Фирмы",
        enableSorting: false,
        cell: ({ row }) => {
          const firms = row.original.local?.firms || [];
          if (!firms.length) return "—";
          return (
            <div className="ticket-firms-cell">
              {firms.map((firm) => (
                <button
                  key={firm.id}
                  type="button"
                  className="ticket-firm-open"
                  title={firmButtonLabel(firm)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFirmDetail({
                      type: firm.firm_type,
                      recordId: String(firm.firm_record_id),
                      title: firmButtonLabel(firm),
                      message: firm.firm_message || null,
                    });
                  }}
                >
                  {firmButtonLabel(firm)}
                </button>
              ))}
            </div>
          );
        },
      },
      {
        id: "channel",
        header: "Канал",
        accessorFn: (row) => row.channel_id ?? null,
        cell: ({ row }) => channelDisplayName(row.original.channel_id, channelNames),
      },
      {
        id: "status",
        header: "Статус",
        accessorFn: (row) => row.status || "",
        cell: ({ row }) => (
          <span className={statusBadgeClass(row.original.status)}>{statusLabel(row.original.status)}</span>
        ),
      },
      {
        id: "direction",
        header: "Направление",
        accessorFn: (row) => row.direction || "",
        cell: ({ row }) => directionLabel(row.original.direction),
      },
      {
        id: "responsible",
        header: "Ответственный",
        accessorFn: (row) => row.responsible_user_id ?? null,
        cell: ({ row }) => userDisplayName(row.original.responsible_user_id, userNames),
      },
      {
        id: "updated",
        header: "Обновлён",
        accessorFn: (row) => row.last_update ?? null,
        cell: ({ row }) => formatUnix(row.original.last_update),
      },
      {
        id: "created",
        header: "Создан",
        accessorFn: (row) => row.created_date ?? null,
        cell: ({ row }) => formatUnix(row.original.created_date),
      },
      {
        id: "recording",
        header: "Запись",
        enableSorting: false,
        cell: ({ row }) => {
          const ticket = row.original;
          const cached = getCachedRecordingDuration(ticket);
          const probed = recordingDurations[String(ticket.id)];
          return (
            <TicketRecordingControl
              ticket={ticket}
              duration={cached ?? probed}
              onOpen={setRecordingTicket}
            />
          );
        },
      },
      {
        id: "sla",
        header: "SLA нарушен",
        accessorFn: (row) => Boolean(row.sla_breached),
        cell: ({ row }) =>
          row.original.sla_breached ? (
            <span className="badge badge--warn">Да</span>
          ) : (
            <span className="badge badge--muted">Нет</span>
          ),
      },
      {
        id: "rating",
        header: "Оценка",
        accessorFn: (row) => row.rating ?? null,
        cell: ({ row }) => (row.original.rating != null ? row.original.rating : "—"),
      },
    ],
    [canEditClients, canLinkClientFirms, channelNames, dateTimeFormat, recordingDurations, userNames],
  );

  function applyFilters() {
    setAppliedFilters(filters);
  }

  const users = usersQuery.data?.users || [];
  const channels = channelsQuery.data?.channels || [];
  const filtersActive = filtersHaveAdvancedValues(appliedFilters, ticketPeriodDays);
  const ticketsEmptyMessage =
    appliedFilters.search ||
    appliedFilters.statuses.length ||
    appliedFilters.users.length ||
    appliedFilters.channels.length ||
    appliedFilters.dateFrom ||
    appliedFilters.dateTo
      ? "Ничего не найдено. Измените фильтры."
      : "Тикетов пока нет.";

  return (
    <section className="card tickets-page">
      {activeTicket ? (
        <ActiveTicketBanner
          ticket={activeTicket}
          onOpen={() => navigate(`/tickets/${activeTicket.id}`)}
          onCreateOrder={() => setOrderOpen(true)}
        />
      ) : null}

      {ticketView !== "cards" && ticketsQuery.error ? (
        <p className="message error">{(ticketsQuery.error as Error).message}</p>
      ) : null}
      {boardError ? <p className="message error">{boardError}</p> : null}
      {successMessage ? <p className="message success">{successMessage}</p> : null}

      <div className="tickets-sticky-head" ref={stickyHeadRef}>
        <SummaryBar
          placeholder={summaryPending ? "Расчёт итогов по длительности звонков…" : undefined}
          items={
            summary
              ? [
                  { label: "тикетов", value: summary.count, tone: "neutral", valueFirst: true },
                  { label: "SLA нарушен", value: summary.slaBreached, tone: "danger" },
                  { label: "С оценкой", value: summary.rated, tone: "ok" },
                ]
              : undefined
          }
        />

        <form
          className="ticket-filters"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          <div className="ticket-filters__row ticket-filters__row--desktop">
            <TicketFilterFields
              filters={filters}
              setFilters={setFilters}
              users={users}
              channels={channels}
              onOpenPeriod={() => setPeriodOpen(true)}
              showActions
              onRefresh={refreshTicketList}
              refreshing={listRefreshing}
            />
          </div>

          <div className="ticket-filters__row ticket-filters__row--search">
            <button
              type="button"
              className={`ticket-filters__open-btn${filtersActive ? " ticket-filters__open-btn--active" : ""}`}
              aria-label="Фильтры"
              title="Фильтры"
              onClick={() => setFiltersModalOpen(true)}
            >
              <img
                src={filterFunnelIcon}
                alt=""
                className="ticket-filters__open-icon"
                width={26}
                height={26}
                draggable={false}
              />
              {filtersActive ? <span className="ticket-filters__open-dot" aria-hidden="true" /> : null}
            </button>
            <label className="ticket-filters__search">
              <SearchField
                value={filters.search}
                onChange={(value) => {
                  setFilters((current) => ({ ...current, search: value }));
                  setAppliedFilters((current) => ({ ...current, search: value }));
                }}
                placeholder="Тема, клиент, телефон"
                className="ticket-filters__search-box"
              />
            </label>
            <TicketViewSwitch
              view={ticketView}
              onChange={(next) => {
                setTicketView(next);
                saveTicketListView(next);
              }}
            />
          </div>
        </form>
      </div>

      <Modal
        open={filtersModalOpen}
        title="Фильтры"
        size="sheet"
        onClose={() => setFiltersModalOpen(false)}
      >
        <form
          className="ticket-filters-modal"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
            setFiltersModalOpen(false);
          }}
        >
          <div className="ticket-filters-modal__fields">
            <TicketFilterFields
              filters={filters}
              setFilters={setFilters}
              users={users}
              channels={channels}
              onOpenPeriod={() => setPeriodOpen(true)}
            />
          </div>
          <div className="ticket-filters-modal__actions">
            <button
              type="button"
              className="btn-secondary btn-icon"
              aria-label="Обновить"
              title="Обновить"
              onClick={refreshTicketList}
              disabled={listRefreshing}
            >
              <RefreshCw size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                const next = defaultFilters(ticketPeriodDays);
                setFilters((current) => ({ ...next, search: current.search, users: current.users }));
              }}
            >
              Сбросить
            </button>
            <button type="submit" className="btn-primary">
              Применить
            </button>
          </div>
        </form>
      </Modal>

      <TicketPeriodModal
        open={periodOpen}
        dateFrom={filters.dateFrom}
        dateTo={filters.dateTo}
        onClose={() => setPeriodOpen(false)}
        onApply={(dateFrom, dateTo) => setFilters((current) => ({ ...current, dateFrom, dateTo }))}
      />

      <div className={`ticket-table-section${ticketView === "cards" ? " ticket-table-section--board" : ""}`}>
        {ticketView === "cards" ? (
          <TicketBoard
            columns={board.columns}
            emptyMessage={ticketsEmptyMessage}
            userNames={userNames}
            canEditTickets={canEditTickets}
            canEditClosedTickets={canEditClosedTickets}
            busyTicketId={statusMutation.isPending ? statusMutation.variables?.id ?? null : null}
            recordingDurations={recordingDurations}
            onNearEnd={(status) => {
              const column = board.columns.find((item) => item.id === status);
              if (column?.hasNextPage && !column.isFetchingNextPage) {
                void column.fetchNextPage();
              }
            }}
            onOpenTicket={(ticket) => navigate(`/tickets/${ticket.id}`)}
            onOpenRecording={setRecordingTicket}
            onStatusChange={(ticket, status) => {
              if (!canEditTickets) return;
              if (String(ticket.status || "") === "Closed" && !canEditClosedTickets) return;
              statusMutation.mutate({ id: ticket.id, status });
            }}
          />
        ) : compact ? (
          <TicketCards
            tickets={tickets}
            isLoading={ticketsQuery.isPending}
            emptyMessage={ticketsEmptyMessage}
            userNames={userNames}
            channelNames={channelNames}
            recordingDurations={recordingDurations}
            canEditClients={canEditClients}
            canLinkClientFirms={canLinkClientFirms}
            onOpenTicket={(ticket) => navigate(`/tickets/${ticket.id}`)}
            onEditClient={setClientEditId}
            onOpenFirm={(firm) =>
              setFirmDetail({
                type: firm.firm_type,
                recordId: String(firm.firm_record_id),
                title: firmButtonLabel(firm),
                message: firm.firm_message || null,
              })
            }
            onOpenRecording={setRecordingTicket}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.tickets"
            data={tickets}
            columns={columns}
            isLoading={ticketsQuery.isPending}
            serverSideSearch
            columnMenuSort
            manualSorting
            onSortingChange={handleTicketSortingChange}
            emptyMessage={ticketsEmptyMessage}
            getRowId={(row) => String(row.id)}
            onRowClick={(row) => navigate(`/tickets/${row.id}`)}
          />
        )}
        {ticketView === "cards" ? null : (
          <InfiniteScrollSentinel
            loaded={tickets.length}
            total={total}
            hasNextPage={Boolean(ticketsQuery.hasNextPage)}
            isFetchingNextPage={ticketsQuery.isFetchingNextPage}
            fetchNextPage={ticketsQuery.fetchNextPage}
          />
        )}
      </div>

      <CreateTicketModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        channels={channelsQuery.data?.channels || []}
        users={usersQuery.data?.users || []}
        actorRegosUserId={actor?.regosUserId}
        clientQuery={clientQuery}
        onClientQueryChange={setClientQuery}
        clients={clientsQuery.data?.clients || []}
        selectedClient={selectedClient}
        onSelectClient={setSelectedClient}
        error={createError}
        pending={createMutation.isPending}
        onSubmit={(payload) => createMutation.mutate(payload)}
      />

      <RecordingModal ticket={recordingTicket} onClose={() => setRecordingTicket(null)} />

      {(canEditClients || canLinkClientFirms) && clientEditId ? (
        <ClientEditModal
          clientId={clientEditId}
          canEditClients={canEditClients}
          canLinkClientFirms={canLinkClientFirms}
          onClose={() => setClientEditId(null)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["tickets"] })}
        />
      ) : null}

      {firmDetail ? (
        <FirmDetailModal
          firmType={firmDetail.type}
          recordId={firmDetail.recordId}
          title={firmDetail.title}
          cachedMessage={firmDetail.message}
          onClose={() => setFirmDetail(null)}
        />
      ) : null}

      {orderOpen && activeTicket ? (
        <CreateOrderModal
          ticket={activeTicket}
          open={orderOpen}
          onClose={() => setOrderOpen(false)}
          onSuccess={(message) => {
            setOrderOpen(false);
            setSuccessMessage(message);
            void queryClient.invalidateQueries({ queryKey: ["tickets"] });
          }}
        />
      ) : null}

      <div className="tickets-fab-dock">
        <button
          type="button"
          className="tickets-fab tickets-fab--nav"
          aria-label="Меню"
          title="Меню"
          onClick={toggleNav}
        >
          <Menu size={22} aria-hidden="true" />
        </button>
        {hasPermission("tickets_create") ? (
          <button
            type="button"
            className="tickets-fab"
            aria-label="Создать тикет"
            title="Создать тикет"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={24} aria-hidden="true" strokeWidth={2.5} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ActiveTicketBanner({
  ticket,
  onOpen,
  onCreateOrder,
}: {
  ticket: Ticket;
  onOpen: () => void;
  onCreateOrder: () => void;
}) {
  const clientParts = [ticket.client?.name, ticket.client?.phone].filter(Boolean);
  const clientText = clientParts.length ? clientParts.join(" · ") : "—";
  const title = `#${ticket.id} — ${ticket.subject || "Без темы"}`;

  return (
    <div className="active-ticket-banner">
      <button type="button" className="active-ticket__open" onClick={onOpen}>
        <span className="active-ticket__label">Текущий активный тикет:</span>
        <span className="active-ticket__title">{title}</span>
        <span className="active-ticket__meta">
          {clientText} · {formatUnix(ticket.created_date)}
        </span>
      </button>
      <div className="active-ticket__extras">
        <span className="active-ticket__extra">
          <span className="active-ticket__extra-label">Неоплаченные:</span>{" "}
          {hasLookupPhone(ticket) ? (
            unpaidOrdersLabel(ticket) ? (
              unpaidOrdersHref(ticket) ? (
                <Link to={unpaidOrdersHref(ticket)!} className="ticket-unpaid-link">
                  {unpaidOrdersLabel(ticket)}
                </Link>
              ) : (
                unpaidOrdersLabel(ticket)
              )
            ) : (
              <span className="badge badge--muted">Нет</span>
            )
          ) : (
            "—"
          )}
        </span>
        <span className="active-ticket__extra">
          <span className="active-ticket__extra-label">ТП:</span>{" "}
          {(() => {
            const display = technicalSupportDisplay(ticket);
            if (display.kind === "missing") return "—";
            if (display.kind === "none") return <span className="badge badge--muted">Нет</span>;
            if (display.kind === "active") {
              return (
                <span className="badge badge--ok" title={`Действует до ${display.dateLabel}`}>
                  До {display.dateLabel}
                </span>
              );
            }
            return (
              <span className="badge badge--warn" title={`Истекла ${display.dateLabel}`}>
                Истекла {display.dateLabel}
              </span>
            );
          })()}
        </span>
        <span className="active-ticket__actions">
          <button type="button" className="btn-primary btn-sm" onClick={onCreateOrder}>
            Создать заказ
          </button>
        </span>
      </div>
    </div>
  );
}

function RecordingModal({ ticket, onClose }: { ticket: Ticket | null; onClose: () => void }) {
  const playerRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!ticket && playerRef.current) {
      playerRef.current.pause();
      playerRef.current.removeAttribute("src");
      playerRef.current.load();
    }
  }, [ticket]);

  useEffect(() => {
    const player = playerRef.current;
    if (!ticket || !player) return;
    const attempt = player.play();
    if (attempt) void attempt.catch(() => {});
  }, [ticket]);

  return (
    <Modal title="Запись звонка" open={Boolean(ticket)} onClose={onClose}>
      {ticket ? (
        <>
          <p className="ticket-recording-modal__ticket">
            Тикет #{ticket.id} — {ticket.subject || "Без темы"}
          </p>
          <audio
            ref={playerRef}
            className="ticket-recording-modal__player"
            controls
            autoPlay
            preload="metadata"
            crossOrigin="use-credentials"
            src={ticketRecordingUrl(ticket.id)}
          >
            Ваш браузер не поддерживает воспроизведение аудио.
          </audio>
        </>
      ) : null}
    </Modal>
  );
}

function FirmDetailModal({
  firmType,
  recordId,
  title,
  cachedMessage,
  onClose,
}: {
  firmType: string;
  recordId: string;
  title: string;
  cachedMessage?: string | null;
  onClose: () => void;
}) {
  const firmQuery = useQuery({
    queryKey: ["firm-detail", firmType, recordId],
    queryFn: () => getFirm(firmType, recordId),
    enabled: Boolean(firmType && recordId),
    retry: false,
  });

  const firm = firmQuery.data?.firm as { clientName?: string; message?: string } | undefined;
  const message = firm?.message || cachedMessage || null;
  const showError = Boolean(firmQuery.error) && !message;

  return (
    <Modal title={firm?.clientName || title} open onClose={onClose} size="wide">
      {firmQuery.isLoading && !message ? <p>Загрузка…</p> : null}
      {showError ? <p className="message error">{(firmQuery.error as Error).message}</p> : null}
      {message ? (
        <div
          className="firm-detail-message"
          dangerouslySetInnerHTML={{ __html: sanitizeTelegramHtml(message) }}
        />
      ) : null}
      {!firmQuery.isLoading && !message && !showError ? (
        <p className="firm-search-status">Нет данных.</p>
      ) : null}
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}

function ClientEditModal({
  clientId,
  canEditClients,
  canLinkClientFirms,
  onClose,
  onSaved,
}: {
  clientId: number;
  canEditClients: boolean;
  canLinkClientFirms: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const [firmQuery, setFirmQuery] = useState("");
  const [linkedFirms, setLinkedFirms] = useState<TicketFirmLink[]>([]);

  const clientQuery = useQuery({
    queryKey: ["client-edit", clientId],
    queryFn: () => getClient(clientId),
  });

  const firmSearchQuery = useQuery({
    queryKey: ["client-firm-search", firmQuery],
    queryFn: () => searchFirms(firmQuery),
    enabled: firmQuery.trim().length > 0,
  });

  useEffect(() => {
    if (clientQuery.data?.firms) {
      setLinkedFirms(clientQuery.data.firms);
    }
  }, [clientQuery.data?.firms]);

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => updateClient(clientId, payload),
    onSuccess: () => {
      void clientQuery.refetch();
      onSaved();
    },
    onError: (err: Error) => setError(err.message),
  });

  const linkMutation = useMutation({
    mutationFn: (firm: FirmSearchResult) =>
      linkClientFirm(clientId, {
        type: firm.type,
        recordId: firm.recordId,
        clientName: firm.clientName,
        phone: firm.phone,
        message: firm.message,
      }),
    onSuccess: (data) => {
      setLinkedFirms((current) => [data.firm, ...current.filter((row) => row.id !== data.firm.id)]);
      setFirmQuery("");
    },
    onError: (err: Error) => setError(err.message),
  });

  const unlinkMutation = useMutation({
    mutationFn: (linkId: number) => unlinkClientFirm(clientId, linkId),
    onSuccess: (_data, linkId) => {
      setLinkedFirms((current) => current.filter((firm) => firm.id !== linkId));
    },
    onError: (err: Error) => setError(err.message),
  });

  const client = clientQuery.data?.client;

  return (
    <Modal title="Клиент" open onClose={onClose} size="wide">
      {error ? <p className="message error">{error}</p> : null}
      {clientQuery.isLoading ? <p>Загрузка…</p> : null}
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEditClients) return;
          const form = new FormData(event.currentTarget);
          saveMutation.mutate({
            name: form.get("name"),
            phone: form.get("phone"),
            email: form.get("email"),
            external_id: form.get("external_id"),
            description: form.get("description"),
          });
        }}
      >
        {canEditClients ? (
          <>
            <label>
              Имя
              <input name="name" defaultValue={String(client?.name || "")} maxLength={200} />
            </label>
            <label>
              Телефон
              <input name="phone" defaultValue={String(client?.phone || "")} maxLength={50} />
            </label>
            <label>
              Email
              <input name="email" type="email" defaultValue={String(client?.email || "")} maxLength={150} />
            </label>
            <label>
              Внешний ID
              <input name="external_id" defaultValue={String(client?.external_id || "")} maxLength={150} />
            </label>
            <label>
              Комментарий
              <textarea name="description" rows={4} defaultValue={String(client?.description || "")} />
            </label>
          </>
        ) : null}

        {canLinkClientFirms ? (
          <div className="client-edit-firms">
            <div className="field">
              <span>Связанные фирмы</span>
              <div className="client-linked-firms">
                {linkedFirms.map((firm) => (
                  <div key={firm.id} className="client-linked-firm">
                    <div className="client-linked-firm__body">
                      <strong>{firm.firm_name || `Запись #${firm.firm_record_id}`}</strong>
                      <span className="client-linked-firm__meta">
                        {[firmTypeLabel(firm.firm_type), firm.firm_phone].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={unlinkMutation.isPending}
                      onClick={() => unlinkMutation.mutate(firm.id)}
                    >
                      Отвязать
                    </button>
                  </div>
                ))}
              </div>
              {!linkedFirms.length ? <p className="firm-search-status">Нет связанных фирм.</p> : null}
            </div>
            <div className="field">
              <span>Добавить фирму</span>
              <div className="firm-search-row">
                <input
                  value={firmQuery}
                  onChange={(e) => setFirmQuery(e.target.value)}
                  placeholder="Имя, компания, телефон, лицензия…"
                />
                <button type="button" className="btn-secondary btn-sm" onClick={() => void firmSearchQuery.refetch()}>
                  Найти
                </button>
              </div>
              {(firmSearchQuery.data?.results || []).map((firm, index) => (
                <button
                  key={`${firm.type}-${firm.recordId}-${index}`}
                  type="button"
                  className="firm-search-result"
                  onClick={() => linkMutation.mutate(firm)}
                >
                  <strong>{firm.clientName || "Без названия"}</strong>
                  <span className="firm-search-result__meta">
                    {[firmTypeLabel(firm.type), firm.phone].filter(Boolean).join(" · ") || firm.type || "—"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Закрыть
          </button>
          {canEditClients ? (
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
              Сохранить
            </button>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}

function CreateOrderModal({
  ticket,
  open,
  onClose,
  onSuccess,
}: {
  ticket: Ticket;
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [error, setError] = useState("");
  const [firmQuery, setFirmQuery] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [selectedFirm, setSelectedFirm] = useState<FirmSearchResult | null>(null);
  const [autoSelectFirm, setAutoSelectFirm] = useState(true);
  const [phoneLookupDone, setPhoneLookupDone] = useState(false);
  const defaultPhone = ticket.client?.phone || "";

  const clientId = getTicketClientId(ticket);
  const linkedClientQuery = useQuery({
    queryKey: ["order-linked-firms", clientId],
    queryFn: () => getClient(clientId!),
    enabled: open && clientId != null,
  });

  const linkedFirmsReady = clientId == null || linkedClientQuery.isFetched;
  const hasLinkedFirm = Boolean(linkedClientQuery.data?.firms?.length);
  const phoneLookupQuery = useQuery({
    queryKey: ["order-firm-phone-lookup", defaultPhone.trim()],
    queryFn: () => searchFirms(defaultPhone.trim()),
    enabled:
      open &&
      autoSelectFirm &&
      !selectedFirm &&
      !phoneLookupDone &&
      linkedFirmsReady &&
      !hasLinkedFirm &&
      defaultPhone.trim().length >= 7,
  });

  const firmSearchQuery = useQuery({
    queryKey: ["order-firm-search", searchQ],
    queryFn: () => searchFirms(searchQ),
    enabled: open && searchQ.trim().length > 0,
  });

  useEffect(() => {
    if (!open) {
      setFirmQuery("");
      setSearchQ("");
      setSelectedFirm(null);
      setAutoSelectFirm(true);
      setPhoneLookupDone(false);
      setError("");
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !autoSelectFirm || selectedFirm) return;
    const link = linkedClientQuery.data?.firms?.[0];
    if (!link) return;
    setSelectedFirm({
      type: link.firm_type,
      recordId: link.firm_record_id,
      clientName: link.firm_name,
      phone: link.firm_phone,
      message: link.firm_message,
    });
    setPhoneLookupDone(true);
  }, [autoSelectFirm, linkedClientQuery.data?.firms, open, selectedFirm]);

  useEffect(() => {
    if (!open || !autoSelectFirm || selectedFirm || !phoneLookupQuery.isFetched) return;
    const firm = phoneLookupQuery.data?.results?.[0] || null;
    if (firm) {
      setSelectedFirm(firm);
      setFirmQuery(defaultPhone.trim());
    }
    setPhoneLookupDone(true);
  }, [
    autoSelectFirm,
    defaultPhone,
    open,
    phoneLookupQuery.data?.results,
    phoneLookupQuery.isFetched,
    selectedFirm,
  ]);

  function clearSelectedFirm() {
    setSelectedFirm(null);
    setAutoSelectFirm(false);
    setPhoneLookupDone(true);
  }

  const orderMutation = useMutation({
    mutationFn: createOrder,
    onSuccess: (data) => {
      onSuccess(
        data.payment_page_url
          ? `Заказ ${data.order.id} создан. Страница оплаты: ${data.payment_page_url}`
          : `Заказ ${data.order.id} создан.`,
      );
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal title="Создать заказ услуги" open={open} onClose={onClose} size="wide">
      {error ? <p className="message error">{error}</p> : null}
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const payload: Record<string, unknown> = {
            amount: form.get("amount"),
            client_phone: form.get("client_phone"),
            additional_phone: form.get("additional_phone") || undefined,
            ticket_id: ticket.id,
            client_id: clientId,
          };
          if (selectedFirm) {
            payload.client_name = selectedFirm.clientName || undefined;
            payload.client_type = selectedFirm.type || undefined;
            payload.record_id = selectedFirm.recordId ?? undefined;
            payload.firm_message = selectedFirm.message || undefined;
            payload.firm_phone = selectedFirm.phone || undefined;
          } else {
            payload.client_name = ticket.client?.name || undefined;
          }
          orderMutation.mutate(payload);
        }}
      >
        <div className="field">
          <span>
            Данные фирмы <span className="field-hint">(необязательно)</span>
          </span>
          <div className="firm-search-row">
            <input
              value={firmQuery}
              onChange={(e) => setFirmQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setSearchQ(firmQuery.trim());
                }
              }}
              placeholder="Имя, компания, телефон, лицензия…"
            />
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setSearchQ(firmQuery.trim())}
              disabled={firmSearchQuery.isFetching}
            >
              Найти
            </button>
          </div>
          {phoneLookupQuery.isFetching ? (
            <p className="firm-search-status">Подбор фирмы по телефону…</p>
          ) : null}
          {firmSearchQuery.isFetching ? <p className="firm-search-status">Поиск…</p> : null}
          {!firmSearchQuery.isFetching && searchQ && !(firmSearchQuery.data?.results || []).length ? (
            <p className="firm-search-status">Ничего не найдено.</p>
          ) : null}
          {(firmSearchQuery.data?.results || []).map((firm, index) => (
            <button
              key={`${firm.type}-${firm.recordId}-${index}`}
              type="button"
              className="firm-search-result"
              onClick={() => setSelectedFirm(firm)}
            >
              <strong>{firm.clientName || "Без названия"}</strong>
              <span className="firm-search-result__meta">
                {[firmTypeLabel(firm.type), firm.phone].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
          {selectedFirm ? (
            <div className="firm-selected">
              <div className="firm-selected__body">
                <strong>{selectedFirm.clientName || "Без названия"}</strong>
                <span>
                  {firmTypeLabel(selectedFirm.type)}
                  {selectedFirm.phone ? ` · ${selectedFirm.phone}` : ""}
                </span>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={clearSelectedFirm}>
                Сбросить
              </button>
              </div>
          ) : null}
        </div>
        <label>
          Сумма (сум)
          <input name="amount" type="number" min={1} step={1} required placeholder="Например, 150000" />
        </label>
        <label>
          Телефон клиента
          <input
            name="client_phone"
            type="tel"
            required
            defaultValue={selectedFirm?.phone || defaultPhone}
            key={selectedFirm?.phone || defaultPhone}
          />
        </label>
        <label>
          Дополнительный телефон
          <input name="additional_phone" type="tel" placeholder="Оставьте пустым, чтобы пропустить" />
        </label>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={orderMutation.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={orderMutation.isPending}>
            {orderMutation.isPending ? "Создание…" : "Создать"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateTicketModal({
  open,
  onClose,
  channels,
  users,
  actorRegosUserId,
  clientQuery,
  onClientQueryChange,
  clients,
  selectedClient,
  onSelectClient,
  error,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  channels: Array<{ id: number; name?: string }>;
  users: Array<{ id: number; full_name?: string | null; login?: string | null }>;
  actorRegosUserId?: number;
  clientQuery: string;
  onClientQueryChange: (value: string) => void;
  clients: Array<{ id: number; name?: string; phone?: string; email?: string }>;
  selectedClient: { id: number; name?: string; phone?: string; email?: string } | null;
  onSelectClient: (client: { id: number; name?: string; phone?: string; email?: string } | null) => void;
  error: string;
  pending: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [participantIds, setParticipantIds] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    setParticipantIds(actorRegosUserId ? [actorRegosUserId] : []);
  }, [open, actorRegosUserId]);

  return (
    <Modal title="Новый тикет" open={open} onClose={onClose} size="wide">
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedClient) return;
          const form = new FormData(event.currentTarget);
          onSubmit({
            client_id: selectedClient.id,
            channel_id: Number(form.get("channel_id")),
            responsible_user_id: form.get("responsible_user_id")
              ? Number(form.get("responsible_user_id"))
              : undefined,
            direction: form.get("direction"),
            subject: form.get("subject"),
            description: form.get("description"),
            participant_user_ids: participantIds,
          });
        }}
      >
        <div className="field">
          <span>Клиент REGOS</span>
          <div className="firm-search-row">
            <input
              value={clientQuery}
              onChange={(e) => onClientQueryChange(e.target.value)}
              placeholder="Имя, телефон или email"
            />
          </div>
          {clientQuery.trim().length >= 2 && !clients.length ? (
            <p className="firm-search-status">Клиенты не найдены.</p>
          ) : null}
          <div className="firm-search-results">
            {clients.map((client) => (
              <button
                key={client.id}
                type="button"
                className="firm-search-result"
                onClick={() => onSelectClient(client)}
              >
                <strong>{client.name || `Клиент #${client.id}`}</strong>
                <span className="firm-search-result__meta">
                  {[client.phone, client.email].filter(Boolean).join(" · ") || `ID ${client.id}`}
                </span>
              </button>
            ))}
          </div>
          {selectedClient ? (
            <div className="firm-selected">
              <div className="firm-selected__body">
                <strong>{selectedClient.name || `Клиент #${selectedClient.id}`}</strong>
                <span>
                  {[selectedClient.phone, selectedClient.email].filter(Boolean).join(" · ") ||
                    `ID ${selectedClient.id}`}
                </span>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={() => onSelectClient(null)}>
                Изменить
              </button>
            </div>
          ) : null}
        </div>
        <label>
          Канал
          <select name="channel_id" required defaultValue="">
            <option value="">Выберите канал</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ответственный
          <select name="responsible_user_id" defaultValue={actorRegosUserId ? String(actorRegosUserId) : ""}>
            <option value="">Автоматически</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.full_name || user.login || `ID ${user.id}`}
              </option>
            ))}
          </select>
        </label>
        <TicketParticipantsPicker
          users={users}
          value={participantIds}
          onChange={setParticipantIds}
          disabled={pending}
        />
        <label>
          Направление
          <select name="direction" defaultValue="Inbound">
            <option value="Inbound">Входящий</option>
            <option value="Outbound">Исходящий</option>
          </select>
        </label>
        <label>
          Тема
          <input name="subject" required maxLength={300} />
        </label>
        <label>
          Описание
          <textarea name="description" rows={5} />
        </label>
        {error ? <p className="message error">{error}</p> : null}
        {!selectedClient && clientQuery.trim().length >= 2 ? (
          <p className="message error">Выберите клиента REGOS.</p>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={pending || !selectedClient}>
            Создать
          </button>
        </div>
      </form>
    </Modal>
  );
}
