import { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  createReportJob,
  getReportJob,
  type CommissionReport,
  type CommissionReportRow,
  type FinanceReport,
  type FinanceReportRow,
  type TechnicianReport,
  type TechnicianReportRow,
} from "../api/reports";
import { useActiveReportJob } from "../contexts/ReportJobViewContext";
import filterFunnelIcon from "../assets/filter-funnel.png";
import EntityCards from "../components/EntityCards";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import SummaryBar, { type SummaryChip } from "../components/SummaryBar";
import { PeriodFilterButton, TicketPeriodModal } from "../components/TicketPeriodModal";
import { formatTechnicianScore } from "../components/CatalogStaffFields";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { formatMoneyLine } from "../lib/money";
import { datetimeLocalToUnix, getTicketPeriodDefaults } from "../lib/ticket-display";

const FILTERS_STORAGE_KEY = "bot-admin.reports.filters";
const DEFAULT_SCORE_PER_TICKET = "0.5";

const REPORT_TABS = [
  { id: "technician", label: "Баллы техника" },
  { id: "commission", label: "Комиссия менеджера" },
  { id: "finance", label: "Финансы" },
] as const;

type ReportTab = (typeof REPORT_TABS)[number]["id"];

type ReportFilters = {
  dateFrom: string;
  dateTo: string;
  minDuration: string;
  withoutDuplicates: boolean;
  duplicateInterval: string;
  scorePerTicket: string;
};

type TechnicianDisplayRow = TechnicianReportRow & {
  ticket_score: number;
  total_score: number;
};

function parseReportTab(value: string | null): ReportTab {
  if (value === "commission" || value === "finance" || value === "technician") return value;
  return "technician";
}

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

function buildPeriodParams(filters: ReportFilters): Record<string, string> {
  const params: Record<string, string> = {};
  const fromUnix = datetimeLocalToUnix(filters.dateFrom);
  const toUnix = datetimeLocalToUnix(filters.dateTo);
  if (fromUnix != null) params.from_date = String(fromUnix);
  if (toUnix != null) params.to_date = String(toUnix);
  return params;
}

function buildTechnicianParams(filters: ReportFilters): Record<string, string> {
  const params = buildPeriodParams(filters);
  if (filters.minDuration) params.minimum_call_duration_seconds = filters.minDuration;
  if (filters.withoutDuplicates) {
    params.without_duplicates = "1";
    params.duplicate_interval_minutes = filters.duplicateInterval;
  }
  return params;
}

function filtersHaveAdvancedValues(filters: ReportFilters, tab: ReportTab, periodDays?: number) {
  const defaults = defaultFilters(periodDays);
  const periodChanged = filters.dateFrom !== defaults.dateFrom || filters.dateTo !== defaults.dateTo;
  if (tab !== "technician") return periodChanged;
  return (
    periodChanged ||
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
  showTicketFilters: boolean;
  showActions?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
};

function ReportFilterFields({
  filters,
  setFilters,
  onOpenPeriod,
  showTicketFilters,
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
      {showTicketFilters ? (
        <>
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
        </>
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

export default function ReportsPage() {
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  useStickyOffsetVar(stickyHeadRef);
  const { ticketPeriodDays } = useUiPreferences();
  const { setJobId: setActiveJobId } = useActiveReportJob();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseReportTab(searchParams.get("tab"));
  const urlJobId = Number(searchParams.get("job"));
  const hasUrlJob = Number.isFinite(urlJobId) && urlJobId > 0;
  const [filters, setFilters] = useState(() => loadFilters(ticketPeriodDays));
  const [appliedFilters, setAppliedFilters] = useState(() => loadFilters(ticketPeriodDays));
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  function setTab(next: ReportTab) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    nextParams.delete("job");
    setSearchParams(nextParams, { replace: true });
  }

  function clearJobParam() {
    if (!searchParams.get("job")) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("job");
    setSearchParams(nextParams, { replace: true });
  }

  const periodParams = useMemo(() => buildPeriodParams(appliedFilters), [appliedFilters]);
  const technicianParams = useMemo(() => buildTechnicianParams(appliedFilters), [appliedFilters]);
  const createParams = tab === "technician" ? technicianParams : periodParams;
  const createQuery = useQuery({
    queryKey: ["report-job-create", tab, createParams],
    queryFn: () => createReportJob(tab, createParams),
    enabled: !hasUrlJob,
    staleTime: Infinity,
    refetchOnMount: false,
  });
  const jobId = hasUrlJob ? urlJobId : createQuery.data?.id ?? null;
  const jobQuery = useQuery({
    queryKey: ["report-job-status", jobId],
    queryFn: () => getReportJob(jobId as number),
    enabled: jobId != null,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 1000 : false;
    },
  });

  useEffect(() => {
    setActiveJobId(jobId);
    return () => setActiveJobId(null);
  }, [jobId, setActiveJobId]);

  useEffect(() => {
    const jobType = jobQuery.data?.type;
    if (!hasUrlJob || !jobType || jobType === tab) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", jobType);
    setSearchParams(nextParams, { replace: true });
  }, [hasUrlJob, jobQuery.data?.type, tab, searchParams, setSearchParams]);

  useEffect(() => {
    if (!hasUrlJob || !jobQuery.isError) return;
    if (jobQuery.error instanceof ApiError && jobQuery.error.status === 404) {
      clearJobParam();
    }
  }, [hasUrlJob, jobQuery.error, jobQuery.isError, searchParams, setSearchParams]);

  const technicianReport =
    tab === "technician" && jobQuery.data?.status === "ready"
      ? (jobQuery.data.result as TechnicianReport | null)
      : null;
  const commissionReport =
    tab === "commission" && jobQuery.data?.status === "ready"
      ? (jobQuery.data.result as CommissionReport | null)
      : null;
  const financeReport =
    tab === "finance" && jobQuery.data?.status === "ready"
      ? (jobQuery.data.result as FinanceReport | null)
      : null;

  const isBuilding =
    (!hasUrlJob && (createQuery.isPending || createQuery.isFetching)) ||
    (jobId != null &&
      (jobQuery.isPending ||
        jobQuery.data?.status === "pending" ||
        jobQuery.data?.status === "running"));
  const isRefreshing = createQuery.isFetching || jobQuery.isFetching;
  const errorMessage =
    jobQuery.data?.status === "failed"
      ? jobQuery.data.error_message || "Не удалось построить отчёт."
      : createQuery.error instanceof Error
        ? createQuery.error.message
        : jobQuery.error instanceof ApiError && jobQuery.error.status === 404
          ? null
          : jobQuery.error instanceof Error
            ? jobQuery.error.message
            : null;

  const scorePerTicket = parseScorePerTicket(appliedFilters.scorePerTicket);
  const technicianRows = useMemo<TechnicianDisplayRow[]>(() => {
    return (technicianReport?.rows || []).map((row) => {
      const ticketScore = row.ticket_count * scorePerTicket;
      return {
        ...row,
        ticket_score: ticketScore,
        total_score: row.technician_task_score + ticketScore,
      };
    });
  }, [technicianReport?.rows, scorePerTicket]);

  const technicianTotals = technicianReport?.totals;
  const unassignedTicketCount = technicianReport?.unassigned_ticket_count || 0;
  const totalTicketScore = (technicianTotals?.ticket_count || 0) * scorePerTicket;
  const totalScore = (technicianTotals?.technician_task_score || 0) + totalTicketScore;
  const filtersActive = filtersHaveAdvancedValues(filters, tab, ticketPeriodDays);
  const showTicketFilters = tab === "technician";

  function applyFilters() {
    setAppliedFilters(filters);
    clearJobParam();
  }

  function refreshReport() {
    if (hasUrlJob) {
      clearJobParam();
      return;
    }
    void createQuery.refetch();
  }

  const technicianColumns = useMemo<ColumnDef<TechnicianDisplayRow>[]>(
    () => [
      { id: "name", header: "Сотрудник", accessorKey: "name" },
      { id: "technician_task_count", header: "Задач", accessorKey: "technician_task_count" },
      {
        id: "technician_task_score",
        header: "Баллы с задач",
        accessorFn: (row) => formatTechnicianScore(row.technician_task_score),
      },
      { id: "ticket_count", header: "Тикетов", accessorKey: "ticket_count" },
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

  const commissionColumns = useMemo<ColumnDef<CommissionReportRow>[]>(
    () => [
      { id: "name", header: "Сотрудник", accessorKey: "name" },
      { id: "manager_task_count", header: "Задач", accessorKey: "manager_task_count" },
      {
        id: "commission",
        header: "Комиссия",
        cell: ({ row }) => <DualMoney uzs={row.original.commission_uzs} usd={row.original.commission_usd} />,
      },
    ],
    [],
  );

  const financeColumns = useMemo<ColumnDef<FinanceReportRow>[]>(
    () => [
      { id: "name", header: "Филиал", accessorKey: "name" },
      { id: "task_count", header: "Задач", accessorKey: "task_count" },
      {
        id: "net_revenue",
        header: "Выручка",
        cell: ({ row }) => <DualMoney uzs={row.original.net_revenue_uzs} usd={row.original.net_revenue_usd} />,
      },
      {
        id: "refund",
        header: "Возвраты",
        cell: ({ row }) => <DualMoney uzs={row.original.refund_uzs} usd={row.original.refund_usd} />,
      },
      {
        id: "cost",
        header: "Себестоимость",
        cell: ({ row }) => <DualMoney uzs={row.original.cost_uzs} usd={row.original.cost_usd} />,
      },
      {
        id: "profit",
        header: "Прибыль",
        cell: ({ row }) => <DualMoney uzs={row.original.profit_uzs} usd={row.original.profit_usd} />,
      },
      {
        id: "paid",
        header: "Оплачено",
        cell: ({ row }) => <DualMoney uzs={row.original.paid_uzs} usd={row.original.paid_usd} />,
      },
      {
        id: "refunded_cash",
        header: "Возврат денег",
        cell: ({ row }) => <DualMoney uzs={row.original.refunded_cash_uzs} usd={row.original.refunded_cash_usd} />,
      },
      {
        id: "due",
        header: "К оплате",
        cell: ({ row }) => <DualMoney uzs={row.original.due_uzs} usd={row.original.due_usd} />,
      },
    ],
    [],
  );

  const loadingLabel =
    tab === "technician"
      ? "Формирование отчёта по баллам…"
      : tab === "commission"
        ? "Формирование отчёта по комиссии…"
        : "Формирование финансового отчёта…";

  const summaryItems: SummaryChip[] | undefined = isBuilding
    ? undefined
    : tab === "technician"
      ? [
          { label: "задач", value: technicianTotals?.technician_task_count ?? 0, valueFirst: true },
          { label: "тикетов", value: technicianTotals?.ticket_count ?? 0 },
          { label: "баллов", value: formatTechnicianScore(totalScore), tone: "info" },
          ...(unassignedTicketCount
            ? [{ label: "без сотрудника", value: unassignedTicketCount, tone: "muted" as const }]
            : []),
        ]
      : tab === "commission"
        ? [
            {
              label: "задач",
              value: commissionReport?.totals.manager_task_count ?? 0,
              valueFirst: true,
            },
            {
              label: "комиссия",
              value: formatMoneyLine(commissionReport?.totals.commission_uzs ?? 0, "UZS"),
              tone: "ok",
            },
          ]
        : [
            {
              label: "выручка",
              value: formatMoneyLine(financeReport?.totals.net_revenue_uzs ?? 0, "UZS"),
              tone: "ok",
            },
            {
              label: "себестоимость",
              value: formatMoneyLine(financeReport?.totals.cost_uzs ?? 0, "UZS"),
            },
            {
              label: "прибыль",
              value: formatMoneyLine(financeReport?.totals.profit_uzs ?? 0, "UZS"),
              tone: "info",
            },
            {
              label: "оплачено",
              value: formatMoneyLine(financeReport?.totals.paid_uzs ?? 0, "UZS"),
            },
            {
              label: "к оплате",
              value: formatMoneyLine(financeReport?.totals.due_uzs ?? 0, "UZS"),
            },
          ];

  return (
    <section className="card tickets-page">
      {errorMessage ? <p className="message error">{errorMessage}</p> : null}

      <div className="tickets-sticky-head" ref={stickyHeadRef}>
        <div className="card-toolbar">
          <div className="role-tabs" role="tablist" aria-label="Типы отчётов">
            {REPORT_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`role-tab${tab === item.id ? " role-tab--active" : ""}`}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <SummaryBar placeholder={isBuilding ? loadingLabel : undefined} items={summaryItems} />

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
              showTicketFilters={showTicketFilters}
              showActions
              onRefresh={refreshReport}
              refreshing={isRefreshing}
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

      <Modal open={filtersModalOpen} title="Фильтры" size="sheet" onClose={() => setFiltersModalOpen(false)}>
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
              showTicketFilters={showTicketFilters}
            />
          </div>
          <div className="ticket-filters-modal__actions">
            <button
              type="button"
              className="btn-secondary btn-icon"
              aria-label="Обновить"
              title="Обновить"
              onClick={refreshReport}
              disabled={isRefreshing}
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
        {isBuilding ? (
          <LoadingState message={loadingLabel} />
        ) : tab === "technician" ? (
          compact ? (
            <EntityCards
              items={technicianRows}
              emptyMessage="Нет данных за выбранный период."
              getKey={(row) => String(row.user_id)}
              getTitle={(row) => row.name}
              getFields={(row) => [
                { label: "Задач", value: row.technician_task_count },
                { label: "Баллы с задач", value: formatTechnicianScore(row.technician_task_score) },
                { label: "Тикетов", value: row.ticket_count },
                { label: "Баллы с тикетов", value: formatTechnicianScore(row.ticket_score) },
                { label: "Всего баллов", value: formatTechnicianScore(row.total_score) },
              ]}
            />
          ) : (
            <SimpleTable
              tableKey="bot-admin.reports.technician"
              data={technicianRows}
              columns={technicianColumns}
              emptyMessage="Нет данных за выбранный период."
              getRowId={(row) => String(row.user_id)}
            />
          )
        ) : tab === "commission" ? (
          compact ? (
            <EntityCards
              items={commissionReport?.rows || []}
              emptyMessage="Нет данных за выбранный период."
              getKey={(row) => String(row.user_id)}
              getTitle={(row) => row.name}
              getFields={(row) => [
                { label: "Задач", value: row.manager_task_count },
                { label: "Комиссия", value: <DualMoney uzs={row.commission_uzs} usd={row.commission_usd} /> },
              ]}
            />
          ) : (
            <SimpleTable
              tableKey="bot-admin.reports.commission"
              data={commissionReport?.rows || []}
              columns={commissionColumns}
              emptyMessage="Нет данных за выбранный период."
              getRowId={(row) => String(row.user_id)}
            />
          )
        ) : compact ? (
          <EntityCards
            items={financeReport?.rows || []}
            emptyMessage="Нет данных за выбранный период."
            getKey={(row) => String(row.location_id ?? "none")}
            getTitle={(row) => row.name}
            getFields={(row) => [
              { label: "Задач", value: row.task_count },
              { label: "Выручка", value: <DualMoney uzs={row.net_revenue_uzs} usd={row.net_revenue_usd} /> },
              { label: "Возвраты", value: <DualMoney uzs={row.refund_uzs} usd={row.refund_usd} /> },
              { label: "Себестоимость", value: <DualMoney uzs={row.cost_uzs} usd={row.cost_usd} /> },
              { label: "Прибыль", value: <DualMoney uzs={row.profit_uzs} usd={row.profit_usd} /> },
              { label: "Оплачено", value: <DualMoney uzs={row.paid_uzs} usd={row.paid_usd} /> },
              { label: "Возврат денег", value: <DualMoney uzs={row.refunded_cash_uzs} usd={row.refunded_cash_usd} /> },
              { label: "К оплате", value: <DualMoney uzs={row.due_uzs} usd={row.due_usd} /> },
            ]}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.reports.finance"
            data={financeReport?.rows || []}
            columns={financeColumns}
            emptyMessage="Нет данных за выбранный период."
            getRowId={(row) => String(row.location_id ?? "none")}
          />
        )}
      </div>
    </section>
  );
}
