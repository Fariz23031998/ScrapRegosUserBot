import { ColumnDef } from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { listTicketRating, type TicketRatingEmployee } from "../api/tickets";
import filterFunnelIcon from "../assets/filter-funnel.png";
import EntityCards from "../components/EntityCards";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import SummaryBar from "../components/SummaryBar";
import { PeriodFilterButton, TicketPeriodModal } from "../components/TicketPeriodModal";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { datetimeLocalToUnix, formatCallDuration, getTicketPeriodDefaults } from "../lib/ticket-display";
import { formatAmount } from "../lib/utils";

const FILTERS_STORAGE_KEY = "bot-admin.rating.filters";

type RatingFilters = {
  dateFrom: string;
  dateTo: string;
  minDuration: string;
  withoutDuplicates: boolean;
  duplicateInterval: string;
};

function defaultFilters(periodDays?: number): RatingFilters {
  const period = getTicketPeriodDefaults(periodDays);
  return {
    dateFrom: period.from,
    dateTo: period.to,
    minDuration: "",
    withoutDuplicates: false,
    duplicateInterval: "10",
  };
}

function loadFilters(periodDays?: number): RatingFilters {
  const base = defaultFilters(periodDays);
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return base;
    return {
      ...base,
      withoutDuplicates: Boolean(parsed.withoutDuplicates),
      minDuration:
        parsed.minimumCallDuration != null && parsed.minimumCallDuration !== ""
          ? String(parsed.minimumCallDuration)
          : typeof parsed.minDuration === "string"
            ? parsed.minDuration
            : base.minDuration,
      duplicateInterval:
        typeof parsed.duplicateInterval === "string" ? parsed.duplicateInterval : base.duplicateInterval,
      dateFrom: typeof parsed.dateFrom === "string" ? parsed.dateFrom : base.dateFrom,
      dateTo: typeof parsed.dateTo === "string" ? parsed.dateTo : base.dateTo,
    };
  } catch {
    return base;
  }
}

function saveFilters(filters: RatingFilters) {
  try {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        withoutDuplicates: filters.withoutDuplicates,
        minimumCallDuration: filters.minDuration,
        duplicateInterval: filters.duplicateInterval,
      }),
    );
  } catch {
    /* ignore */
  }
}

function filtersHaveAdvancedValues(filters: RatingFilters, periodDays?: number) {
  const defaults = defaultFilters(periodDays);
  return (
    filters.dateFrom !== defaults.dateFrom ||
    filters.dateTo !== defaults.dateTo ||
    Boolean(filters.minDuration) ||
    filters.withoutDuplicates
  );
}

function buildRatingParams(filters: RatingFilters): Record<string, string> {
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

type RatingFilterFieldsProps = {
  filters: RatingFilters;
  setFilters: (next: RatingFilters) => void;
  onOpenPeriod: () => void;
  showActions?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
};

function RatingFilterFields({
  filters,
  setFilters,
  onOpenPeriod,
  showActions = false,
  onRefresh,
  refreshing,
}: RatingFilterFieldsProps) {
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

export default function RatingPage() {
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

  const ratingQuery = useQuery({
    queryKey: ["tickets-rating", appliedFilters],
    queryFn: () => listTicketRating(buildRatingParams(appliedFilters)),
  });

  const summary = ratingQuery.data?.summary ?? null;
  const employees = ratingQuery.data?.employees || [];
  const summaryPending = ratingQuery.isFetching && !summary;
  const filtersActive = filtersHaveAdvancedValues(appliedFilters, ticketPeriodDays);

  const columns = useMemo<ColumnDef<TicketRatingEmployee>[]>(
    () => [
      {
        id: "row_num",
        header: "№",
        enableSorting: false,
        cell: ({ row }) => row.index + 1,
      },
      {
        id: "name",
        header: "Сотрудник",
        accessorKey: "name",
      },
      {
        id: "count",
        header: "Тикетов",
        accessorKey: "count",
      },
      {
        id: "call_duration",
        header: "Длительность",
        accessorFn: (row) => row.call_duration_seconds || 0,
        cell: ({ getValue }) => formatCallDuration(Number(getValue() || 0)),
      },
      {
        id: "orders_amount",
        header: "Сумма заказов",
        accessorFn: (row) => row.orders_amount || 0,
        cell: ({ getValue }) => formatAmount(Number(getValue() || 0)),
      },
      {
        id: "orders_paid_amount",
        header: "Оплачено",
        accessorFn: (row) => row.orders_paid_amount || 0,
        cell: ({ getValue }) => formatAmount(Number(getValue() || 0)),
      },
      {
        id: "slaBreached",
        header: "SLA нарушен",
        accessorKey: "slaBreached",
      },
      {
        id: "rated",
        header: "С оценкой",
        accessorKey: "rated",
      },
    ],
    [],
  );

  function applyFilters() {
    setAppliedFilters(filters);
  }

  return (
    <section className="card tickets-page page--rating">
      {ratingQuery.error ? <p className="message error">{(ratingQuery.error as Error).message}</p> : null}

      <div className="tickets-sticky-head" ref={stickyHeadRef}>
        <SummaryBar
          placeholder={summaryPending ? "Расчёт итогов по длительности звонков…" : undefined}
          items={
            summary
              ? [
                  { label: "тикетов", value: summary.count, tone: "neutral", valueFirst: true },
                  {
                    label: "длительность",
                    value: formatCallDuration(summary.call_duration_seconds ?? 0),
                  },
                  {
                    label: "сумма заказов",
                    value: formatAmount(summary.orders_amount ?? 0),
                    tone: "info",
                  },
                  {
                    label: "оплачено",
                    value: formatAmount(summary.orders_paid_amount ?? 0),
                    tone: "ok",
                  },
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
            <RatingFilterFields
              filters={filters}
              setFilters={setFilters}
              onOpenPeriod={() => setPeriodOpen(true)}
              showActions
              onRefresh={() => void ratingQuery.refetch()}
              refreshing={ratingQuery.isFetching}
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
            <RatingFilterFields
              filters={filters}
              setFilters={setFilters}
              onOpenPeriod={() => setPeriodOpen(true)}
            />
          </div>
          <div className="ticket-filters-modal__actions">
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
        {compact ? (
          <EntityCards
            items={employees}
            isLoading={ratingQuery.isPending}
            emptyMessage="Нет тикетов за выбранный период."
            getKey={(row) => (row.user_id == null ? "unassigned" : String(row.user_id))}
            getTitle={(row, index) => `${index + 1}. ${row.name}`}
            getFields={(row) => [
              { label: "Тикетов", value: row.count },
              { label: "Длительность", value: formatCallDuration(row.call_duration_seconds || 0) },
              { label: "Сумма заказов", value: formatAmount(row.orders_amount || 0) },
              { label: "Оплачено", value: formatAmount(row.orders_paid_amount || 0) },
              { label: "SLA нарушен", value: row.slaBreached },
              { label: "С оценкой", value: row.rated },
            ]}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.rating.employees"
            data={employees}
            columns={columns}
            columnMenuSort
            isLoading={ratingQuery.isPending}
            emptyMessage="Нет тикетов за выбранный период."
            getRowId={(row) => (row.user_id == null ? "unassigned" : String(row.user_id))}
          />
        )}
      </div>
    </section>
  );
}
