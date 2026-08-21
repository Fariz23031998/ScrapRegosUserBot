import { ColumnDef } from "@tanstack/react-table";
import { Check, RefreshCw } from "lucide-react";
import {
  type CommissionReport,
  type CommissionReportRow,
  type FinanceReport,
  type FinanceReportRow,
  type ReportJob,
  type ReportJobStatus,
  type ReportType,
  type StoredReportParams,
  type TechnicianReport,
  type TechnicianReportRow,
} from "../api/reports";
import { formatTechnicianScore } from "../components/CatalogStaffFields";
import EntityCards from "../components/EntityCards";
import SimpleTable from "../components/SimpleTable";
import { PeriodFilterButton } from "../components/TicketPeriodModal";
import { formatMoneyLine } from "../lib/money";
import { datetimeLocalToUnix, getTicketPeriodDefaults, toDatetimeLocalValue } from "../lib/ticket-display";

export const FILTERS_STORAGE_KEY = "bot-admin.reports.filters";
export const DEFAULT_SCORE_PER_TICKET = "0.5";

export const REPORT_TABS = [
  { id: "technician", label: "Баллы техника" },
  { id: "commission", label: "Комиссия менеджера" },
  { id: "finance", label: "Финансы" },
] as const;

export type ReportTab = (typeof REPORT_TABS)[number]["id"];

export type ReportFilters = {
  dateFrom: string;
  dateTo: string;
  minDuration: string;
  withoutDuplicates: boolean;
  duplicateInterval: string;
  scorePerTicket: string;
};

export type TechnicianDisplayRow = TechnicianReportRow & {
  ticket_score: number;
  total_score: number;
};

const REPORT_STATUS_LABELS: Record<ReportJobStatus, string> = {
  pending: "Формируется",
  running: "Формируется",
  ready: "Готов",
  failed: "Ошибка",
};

export function parseReportTab(value: string | null | undefined): ReportTab {
  if (value === "commission" || value === "finance" || value === "technician") return value;
  return "technician";
}

export function reportTypeLabel(type: string | null | undefined): string {
  return REPORT_TABS.find((item) => item.id === type)?.label || type || "Отчёт";
}

export function reportStatusLabel(status: string | null | undefined): string {
  if (status === "pending" || status === "running" || status === "ready" || status === "failed") {
    return REPORT_STATUS_LABELS[status];
  }
  return status || "—";
}

export function formatReportPeriod(params?: StoredReportParams | null): string {
  const fmt = (unix: number | null | undefined) => {
    if (unix == null) return null;
    const date = new Date(Number(unix) * 1000);
    if (Number.isNaN(date.getTime())) return null;
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  };
  const from = fmt(params?.from_date);
  const to = fmt(params?.to_date);
  if (from && to) return `${from} – ${to}`;
  if (from) return `с ${from}`;
  if (to) return `по ${to}`;
  return "весь период";
}

export function defaultFilters(periodDays?: number): ReportFilters {
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

export function loadFilters(periodDays?: number): ReportFilters {
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

export function saveFilters(filters: ReportFilters) {
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

export function parseScorePerTicket(value: string): number {
  const n = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function unixToDatetimeLocal(unix: number | null | undefined): string {
  if (unix == null) return "";
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return toDatetimeLocalValue(date);
}

export function filtersFromParams(params: StoredReportParams | undefined, periodDays?: number): ReportFilters {
  const base = loadFilters(periodDays);
  return {
    ...base,
    dateFrom: unixToDatetimeLocal(params?.from_date) || base.dateFrom,
    dateTo: unixToDatetimeLocal(params?.to_date) || base.dateTo,
    minDuration:
      params?.minimum_call_duration_seconds != null && params.minimum_call_duration_seconds !== undefined
        ? String(params.minimum_call_duration_seconds)
        : "",
    withoutDuplicates: Boolean(params?.without_duplicates),
    duplicateInterval:
      params?.duplicate_interval_minutes != null ? String(params.duplicate_interval_minutes) : base.duplicateInterval,
  };
}

export function buildPeriodParams(filters: ReportFilters): Record<string, string> {
  const params: Record<string, string> = {};
  const fromUnix = datetimeLocalToUnix(filters.dateFrom);
  const toUnix = datetimeLocalToUnix(filters.dateTo);
  if (fromUnix != null) params.from_date = String(fromUnix);
  if (toUnix != null) params.to_date = String(toUnix);
  return params;
}

export function buildTechnicianParams(filters: ReportFilters): Record<string, string> {
  const params = buildPeriodParams(filters);
  if (filters.minDuration) params.minimum_call_duration_seconds = filters.minDuration;
  if (filters.withoutDuplicates) {
    params.without_duplicates = "1";
    params.duplicate_interval_minutes = filters.duplicateInterval;
  }
  return params;
}

export function buildCreateParams(tab: ReportTab, filters: ReportFilters): Record<string, string> {
  return tab === "technician" ? buildTechnicianParams(filters) : buildPeriodParams(filters);
}

export function filtersHaveAdvancedValues(filters: ReportFilters, tab: ReportTab, periodDays?: number) {
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

export function DualMoney({ uzs, usd }: { uzs: number; usd: number }) {
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
  applyLabel?: string;
};

export function ReportFilterFields({
  filters,
  setFilters,
  onOpenPeriod,
  showTicketFilters,
  showActions = false,
  onRefresh,
  refreshing,
  applyLabel = "Применить",
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
          {onRefresh ? (
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
          ) : null}
          <button type="submit" className="btn-primary btn-icon" aria-label={applyLabel} title={applyLabel} disabled={refreshing}>
            <Check size={18} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}

export function ReportTypeTabs({
  tab,
  onChange,
}: {
  tab: ReportTab;
  onChange: (next: ReportTab) => void;
}) {
  return (
    <div className="role-tabs" role="tablist" aria-label="Типы отчётов">
      {REPORT_TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`role-tab${tab === item.id ? " role-tab--active" : ""}`}
          role="tab"
          aria-selected={tab === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function technicianDisplayRows(
  report: TechnicianReport | null | undefined,
  scorePerTicket: number,
): TechnicianDisplayRow[] {
  return (report?.rows || []).map((row) => {
    const ticketScore = row.ticket_count * scorePerTicket;
    return {
      ...row,
      ticket_score: ticketScore,
      total_score: row.technician_task_score + ticketScore,
    };
  });
}

export function loadingLabelForType(type: ReportType | ReportTab): string {
  if (type === "technician") return "Формирование отчёта по баллам…";
  if (type === "commission") return "Формирование отчёта по комиссии…";
  return "Формирование финансового отчёта…";
}

export function ReportResultTables({
  job,
  scorePerTicket,
  compact,
}: {
  job: ReportJob;
  scorePerTicket: number;
  compact: boolean;
}) {
  const tab = parseReportTab(job.type);
  const technicianReport = tab === "technician" && job.status === "ready" ? (job.result as TechnicianReport | null) : null;
  const commissionReport = tab === "commission" && job.status === "ready" ? (job.result as CommissionReport | null) : null;
  const financeReport = tab === "finance" && job.status === "ready" ? (job.result as FinanceReport | null) : null;
  const technicianRows = technicianDisplayRows(technicianReport, scorePerTicket);

  const technicianColumns: ColumnDef<TechnicianDisplayRow>[] = [
    { id: "id", header: "ID", accessorKey: "user_id" },
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
  ];

  const commissionColumns: ColumnDef<CommissionReportRow>[] = [
    { id: "id", header: "ID", accessorKey: "user_id" },
    { id: "name", header: "Сотрудник", accessorKey: "name" },
    { id: "manager_task_count", header: "Задач", accessorKey: "manager_task_count" },
    {
      id: "commission",
      header: "Комиссия",
      cell: ({ row }) => <DualMoney uzs={row.original.commission_uzs} usd={row.original.commission_usd} />,
    },
  ];

  const financeColumns: ColumnDef<FinanceReportRow>[] = [
    { id: "id", header: "ID", accessorFn: (row) => row.location_id ?? "—" },
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
  ];

  if (tab === "technician") {
    return compact ? (
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
    );
  }

  if (tab === "commission") {
    return compact ? (
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
    );
  }

  return compact ? (
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
  );
}

export function reportSummaryItems(job: ReportJob, scorePerTicket: number) {
  const tab = parseReportTab(job.type);
  if (job.status !== "ready") return undefined;
  const technicianReport = tab === "technician" ? (job.result as TechnicianReport | null) : null;
  const commissionReport = tab === "commission" ? (job.result as CommissionReport | null) : null;
  const financeReport = tab === "finance" ? (job.result as FinanceReport | null) : null;
  const technicianTotals = technicianReport?.totals;
  const unassignedTicketCount = technicianReport?.unassigned_ticket_count || 0;
  const totalTicketScore = (technicianTotals?.ticket_count || 0) * scorePerTicket;
  const totalScore = (technicianTotals?.technician_task_score || 0) + totalTicketScore;

  if (tab === "technician") {
    return [
      { label: "задач", value: technicianTotals?.technician_task_count ?? 0, valueFirst: true as const },
      { label: "тикетов", value: technicianTotals?.ticket_count ?? 0 },
      { label: "баллов", value: formatTechnicianScore(totalScore), tone: "info" as const },
      ...(unassignedTicketCount
        ? [{ label: "без сотрудника", value: unassignedTicketCount, tone: "muted" as const }]
        : []),
    ];
  }
  if (tab === "commission") {
    return [
      {
        label: "задач",
        value: commissionReport?.totals.manager_task_count ?? 0,
        valueFirst: true as const,
      },
      {
        label: "комиссия",
        value: formatMoneyLine(commissionReport?.totals.commission_uzs ?? 0, "UZS"),
        tone: "ok" as const,
      },
    ];
  }
  return [
    {
      label: "выручка",
      value: formatMoneyLine(financeReport?.totals.net_revenue_uzs ?? 0, "UZS"),
      tone: "ok" as const,
    },
    {
      label: "себестоимость",
      value: formatMoneyLine(financeReport?.totals.cost_uzs ?? 0, "UZS"),
    },
    {
      label: "прибыль",
      value: formatMoneyLine(financeReport?.totals.profit_uzs ?? 0, "UZS"),
      tone: "info" as const,
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
}
