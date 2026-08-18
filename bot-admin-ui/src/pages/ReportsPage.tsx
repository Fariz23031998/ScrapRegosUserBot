import { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getStaffReport, type StaffReportRow } from "../api/reports";
import filterFunnelIcon from "../assets/filter-funnel.png";
import EntityCards from "../components/EntityCards";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import SummaryBar from "../components/SummaryBar";
import { PeriodFilterButton, TicketPeriodModal } from "../components/TicketPeriodModal";
import { formatTechnicianScore } from "../components/CatalogStaffFields";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { formatMoneyLine } from "../lib/money";
import { datetimeLocalToUnix, getTicketPeriodDefaults } from "../lib/ticket-display";

const FILTERS_STORAGE_KEY = "bot-admin.reports.filters";
const DEFAULT_SCORE_PER_TICKET = "0.5";

type ReportFilters = {
  dateFrom: string;
  dateTo: string;
  minDuration: string;
  withoutDuplicates: boolean;
  duplicateInterval: string;
  scorePerTicket: string;
};

type DisplayRow = StaffReportRow & {
  ticket_score: number;
  total_score: number;
};

function defaultFilters(periodDays?: number): ReportFilters {
  const period = getTicketPeriodDefaults(periodDays);
  return {
    dateFrom: period.from,
    dateTo: period.to,
    minDuration: "",
    withoutDuplicates: false,
    duplicateInterval: "10",
    scorePerTicket: DEFAULT_SCORE_PER_TICKET,
  };
}

function loadFilters(periodDays?: number): ReportFilters {
  const base = defaultFilters(periodDays);
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return base;
    return {
      ...base,
      withoutDuplicates: Boolean(parsed.withoutDuplicates),
      minDuration: typeof parsed.minDuration === "string" ? parsed.minDuration : base.minDuration,
      duplicateInterval:
        typeof parsed.duplicateInterval === "string" ? parsed.duplicateInterval : base.duplicateInterval,
      scorePerTicket:
        parsed.scorePerTicket != null && parsed.scorePerTicket !== ""
          ? String(parsed.scorePerTicket)
          : base.scorePerTicket,
    };
  } catch {
    return base;
  }
}

function saveFilters(filters: ReportFilters) {
  try {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({
        withoutDuplicates: filters.withoutDuplicates,
        minDuration: filters.minDuration,
        duplicateInterval: filters.duplicateInterval,
        scorePerTicket: filters.scorePerTicket,
      }),
    );
  } catch {
    /* ignore */
  }
}

function parseScorePerTicket(value: string): number {
  const n = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function buildReportParams(filters: ReportFilters): Record<string, string> {
  const params: Record<string, string> = {};
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

function filtersHaveAdvancedValues(filters: ReportFilters, periodDays?: number) {
  const defaults = defaultFilters(periodDays);
  return (
    filters.dateFrom !== defaults.dateFrom ||
    filters.dateTo !== defaults.dateTo ||
    Boolean(filters.minDuration) ||
    filters.withoutDuplicates ||
    filters.scorePerTicket !== defaults.scorePerTicket
  );
}

function DualMoney({ uzs, usd }: { uzs: number; usd: number }) {
  return (
    <div>
      {formatMoneyLine(uzs, "UZS")}
      <div className="muted-copy">{formatMoneyLine(usd, "USD")}</div>
    </div>
  );
}

type ReportFilterFieldsProps = {
  filters: ReportFilters;
  setFilters: (next: ReportFilters) => void;
  onOpenPeriod: () => void;
  showActions?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
};

function ReportFilterFields({
  filters,
  setFilters,
  onOpenPeriod,
  showActions = false,
  onRefresh,
  refreshing,
}: ReportFilterFieldsProps) {
  return (
    <>
      <label className="ticket-filters__field ticket-filters__field--period">
        <span>Период</span>
        <PeriodFilterButton dateFrom={filters.dateFrom} dateTo={filters.dateTo} onClick={onOpenPeriod} />
      </label>
      <label className="ticket-filters__field">
        <span>Мин. длительность (с)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={filters.minDuration}
          onChange={(event) => setFilters({ ...filters, minDuration: event.target.value })}
          placeholder="Не учитывать"
        />
      </label>
      <label className="ticket-filters__field ticket-filters__field--checkbox">
        <span>Без дубликатов</span>
        <input
          type="checkbox"
          checked={filters.withoutDuplicates}
          onChange={(event) => setFilters({ ...filters, withoutDuplicates: event.target.checked })}
        />
      </label>
      {filters.withoutDuplicates ? (
        <label className="ticket-filters__field">
          <span>Интервал (мин)</span>
          <select
            value={filters.duplicateInterval}
            onChange={(event) => setFilters({ ...filters, duplicateInterval: event.target.value })}
          >
            {[5, 10, 15, 30, 60].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="ticket-filters__field">
        <span>Баллы за тикет</span>
        <input
          type="number"
          min={0}
          step="any"
          value={filters.scorePerTicket}
          onChange={(event) => setFilters({ ...filters, scorePerTicket: event.target.value })}
        />
      </label>
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

export default function ReportsPage() {
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  useStickyOffsetVar(stickyHeadRef);
  const { ticketPeriodDays } = useUiPreferences();
  const [filters, setFilters] = useState(() => loadFilters(ticketPeriodDays));
  const [appliedFilters, setAppliedFilters] = useState(() => loadFilters(ticketPeriodDays));
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const params = useMemo(() => buildReportParams(appliedFilters), [appliedFilters]);
  const reportQuery = useQuery({
    queryKey: ["staff-report", params],
    queryFn: () => getStaffReport(params),
  });

  const scorePerTicket = parseScorePerTicket(appliedFilters.scorePerTicket);
  const rows = useMemo<DisplayRow[]>(() => {
    return (reportQuery.data?.rows || []).map((row) => {
      const ticketScore = row.ticket_count * scorePerTicket;
      return {
        ...row,
        ticket_score: ticketScore,
        total_score: row.technician_task_score + ticketScore,
      };
    });
  }, [reportQuery.data?.rows, scorePerTicket]);

  const totals = reportQuery.data?.totals;
  const unassignedTicketCount = reportQuery.data?.unassigned_ticket_count || 0;
  const totalTicketScore = (totals?.ticket_count || 0) * scorePerTicket;
  const totalScore = (totals?.technician_task_score || 0) + totalTicketScore;
  const filtersActive = filtersHaveAdvancedValues(filters, ticketPeriodDays);

  function applyFilters() {
    setAppliedFilters(filters);
  }

  const columns = useMemo<ColumnDef<DisplayRow>[]>(
    () => [
      { id: "name", header: "Сотрудник", accessorKey: "name" },
      {
        id: "manager_task_count",
        header: "Задач (менеджер)",
        accessorKey: "manager_task_count",
      },
      {
        id: "commission",
        header: "Комиссия",
        cell: ({ row }) => <DualMoney uzs={row.original.commission_uzs} usd={row.original.commission_usd} />,
      },
      {
        id: "technician_task_count",
        header: "Задач (техник)",
        accessorKey: "technician_task_count",
      },
      {
        id: "technician_task_score",
        header: "Баллы с задач",
        accessorFn: (row) => formatTechnicianScore(row.technician_task_score),
      },
      {
        id: "ticket_count",
        header: "Тикетов",
        accessorKey: "ticket_count",
      },
      {
        id: "ticket_score",
        header: "Баллы с тикетов",
        accessorFn: (row) => formatTechnicianScore(row.ticket_score),
      },
      {
        id: "total_score",
        header: "Всего баллов",
        accessorFn: (row) => formatTechnicianScore(row.total_score),
      },
    ],
    [],
  );

  return (
    <section className="card tickets-page">
      {reportQuery.error ? <p className="message error">{(reportQuery.error as Error).message}</p> : null}

      <div className="tickets-sticky-head" ref={stickyHeadRef}>
        <SummaryBar
          placeholder={reportQuery.isPending ? "Загрузка отчёта…" : undefined}
          items={
            reportQuery.isPending
              ? undefined
              : [
                  { label: "задач менеджером", value: totals?.manager_task_count ?? 0, valueFirst: true },
                  {
                    label: "комиссия",
                    value: formatMoneyLine(totals?.commission_uzs ?? 0, "UZS"),
                    tone: "ok",
                  },
                  { label: "задач техником", value: totals?.technician_task_count ?? 0 },
                  { label: "тикетов", value: totals?.ticket_count ?? 0 },
                  { label: "баллов", value: formatTechnicianScore(totalScore), tone: "info" },
                  ...(unassignedTicketCount
                    ? [{ label: "без сотрудника", value: unassignedTicketCount, tone: "muted" as const }]
                    : []),
                ]
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
            <ReportFilterFields
              filters={filters}
              setFilters={setFilters}
              onOpenPeriod={() => setPeriodOpen(true)}
              showActions
              onRefresh={() => void reportQuery.refetch()}
              refreshing={reportQuery.isFetching}
            />
          </div>
          {compact ? (
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
            </div>
          ) : null}
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
            <ReportFilterFields
              filters={filters}
              setFilters={setFilters}
              onOpenPeriod={() => setPeriodOpen(true)}
            />
          </div>
          <div className="ticket-filters-modal__actions">
            <button
              type="button"
              className="btn-secondary btn-icon"
              aria-label="Обновить"
              title="Обновить"
              onClick={() => void reportQuery.refetch()}
              disabled={reportQuery.isFetching}
            >
              <RefreshCw size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setFilters(defaultFilters(ticketPeriodDays))}
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

      <div className="ticket-table-section">
        {reportQuery.isPending ? (
          <LoadingState message="Загрузка отчёта…" />
        ) : compact ? (
          <EntityCards
            items={rows}
            emptyMessage="Нет данных за выбранный период."
            getKey={(row) => String(row.user_id)}
            getTitle={(row) => row.name}
            getFields={(row) => [
              { label: "Задач (менеджер)", value: row.manager_task_count },
              { label: "Комиссия", value: <DualMoney uzs={row.commission_uzs} usd={row.commission_usd} /> },
              { label: "Задач (техник)", value: row.technician_task_count },
              { label: "Баллы с задач", value: formatTechnicianScore(row.technician_task_score) },
              { label: "Тикетов", value: row.ticket_count },
              { label: "Баллы с тикетов", value: formatTechnicianScore(row.ticket_score) },
              { label: "Всего баллов", value: formatTechnicianScore(row.total_score) },
            ]}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.reports"
            data={rows}
            columns={columns}
            emptyMessage="Нет данных за выбранный период."
            getRowId={(row) => String(row.user_id)}
          />
        )}
      </div>
    </section>
  );
}
