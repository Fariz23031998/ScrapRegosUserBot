import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { listFinanceLocations } from "../api/finances";
import { createReportJob, deleteReportJob, listReportJobs, reportJobPath, type ReportJob } from "../api/reports";
import filterFunnelIcon from "../assets/filter-funnel.png";
import EntityCards from "../components/EntityCards";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import { TicketPeriodModal } from "../components/TicketPeriodModal";
import { useConfirm } from "../contexts/ConfirmContext";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { formatUnix } from "../lib/ticket-display";
import {
  ReportFilterFields,
  ReportTypeTabs,
  buildCreateParams,
  defaultFilters,
  filtersHaveAdvancedValues,
  formatReportPeriod,
  loadFilters,
  parseReportTab,
  reportStatusLabel,
  reportTypeLabel,
  saveFilters,
  type ReportTab,
} from "./reports-shared";

export default function ReportsPage() {
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  useStickyOffsetVar(stickyHeadRef);
  const { ticketPeriodDays } = useUiPreferences();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseReportTab(searchParams.get("tab"));
  const urlJobId = Number(searchParams.get("job"));
  const [filters, setFilters] = useState(() => loadFilters(ticketPeriodDays));
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const jobsQuery = usePagedInfiniteQuery({
    queryKey: ["report-jobs", tab],
    queryFn: (page, pageSize) => listReportJobs({ page, limit: pageSize, type: tab }),
    getItems: (data) => data.jobs || [],
    getItemId: (job) => job.id,
  });

  const createMutation = useMutation({
    mutationFn: ({ type, params }: { type: ReportTab; params: Record<string, string> }) =>
      createReportJob(type, params),
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ["report-jobs"] });
      navigate(reportJobPath(job.id));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteReportJob,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["report-jobs"] });
    },
  });

  async function handleDelete(job: ReportJob) {
    const ok = await confirm({
      message: `Удалить отчёт «${reportTypeLabel(job.type)}» (${formatReportPeriod(job.params)})?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate(job.id);
  }

  function reportActions(job: ReportJob): ReactNode {
    return (
      <button
        type="button"
        className="btn-danger btn-icon btn-sm"
        aria-label="Удалить"
        title="Удалить"
        disabled={deleteMutation.isPending}
        onClick={(event) => {
          event.stopPropagation();
          void handleDelete(job);
        }}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    );
  }

  function setTab(next: ReportTab) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    nextParams.delete("job");
    setSearchParams(nextParams, { replace: true });
  }

  function createFromFilters() {
    createMutation.mutate({ type: tab, params: buildCreateParams(tab, filters) });
  }

  const filtersActive = filtersHaveAdvancedValues(filters, tab, ticketPeriodDays);
  const showTicketFilters = tab === "technician";
  const showFinanceFilters = tab === "finance";
  const locationsQuery = useQuery({
    queryKey: ["finance-locations"],
    queryFn: listFinanceLocations,
    enabled: showFinanceFilters,
  });
  const locations = locationsQuery.data?.locations || [];
  const jobs = jobsQuery.items;
  const isCreating = createMutation.isPending;
  const errorMessage =
    createMutation.error instanceof Error
      ? createMutation.error.message
      : deleteMutation.error instanceof Error
        ? deleteMutation.error.message
        : null;

  const columns = useMemo<ColumnDef<ReportJob>[]>(
    () => [
      { id: "id", header: "ID", accessorKey: "id" },
      {
        id: "period",
        header: "Период",
        accessorFn: (row) => formatReportPeriod(row.params),
      },
      {
        id: "status",
        header: "Статус",
        accessorFn: (row) => reportStatusLabel(row.status),
      },
      {
        id: "created_at",
        header: "Создан",
        accessorFn: (row) => formatUnix(row.created_at),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="cell-actions" onClick={(event) => event.stopPropagation()}>
            {reportActions(row.original)}
          </div>
        ),
      },
    ],
    [deleteMutation.isPending],
  );

  if (Number.isFinite(urlJobId) && urlJobId > 0) {
    return <Navigate to={reportJobPath(urlJobId)} replace />;
  }

  return (
    <section className="card tickets-page page--reports">
      {errorMessage ? <p className="message error">{errorMessage}</p> : null}

      <div className="tickets-sticky-head" ref={stickyHeadRef}>
        <div className="card-toolbar">
          <ReportTypeTabs tab={tab} onChange={setTab} />
        </div>

        <form
          className="ticket-filters"
          onSubmit={(event) => {
            event.preventDefault();
            createFromFilters();
          }}
        >
          <div className="ticket-filters__row ticket-filters__row--desktop">
            <ReportFilterFields
              filters={filters}
              setFilters={setFilters}
              onOpenPeriod={() => setPeriodOpen(true)}
              showTicketFilters={showTicketFilters}
              showFinanceFilters={showFinanceFilters}
              locations={locations}
              showActions
              onRefresh={() => void jobsQuery.refetch()}
              refreshing={isCreating || jobsQuery.isFetching}
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
            createFromFilters();
            setFiltersModalOpen(false);
          }}
        >
          <div className="ticket-filters-modal__fields">
            <ReportFilterFields
              filters={filters}
              setFilters={setFilters}
              onOpenPeriod={() => setPeriodOpen(true)}
              showTicketFilters={showTicketFilters}
              showFinanceFilters={showFinanceFilters}
              locations={locations}
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
            <button type="submit" className="btn-primary" disabled={isCreating}>
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
            items={jobs}
            isLoading={jobsQuery.isPending}
            emptyMessage="Отчётов пока нет."
            getKey={(job) => String(job.id)}
            getTitle={(job) => formatReportPeriod(job.params)}
            getFields={(job) => [
              { label: "Статус", value: reportStatusLabel(job.status) },
              { label: "Создан", value: formatUnix(job.created_at) },
            ]}
            getActions={(job) => reportActions(job)}
            onOpen={(job) => navigate(reportJobPath(job.id))}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.reports.list"
            data={jobs}
            columns={columns}
            isLoading={jobsQuery.isPending}
            emptyMessage="Отчётов пока нет."
            getRowId={(row) => String(row.id)}
            onRowClick={(job) => navigate(reportJobPath(job.id))}
          />
        )}
        <InfiniteScrollSentinel
          loaded={jobs.length}
          total={jobsQuery.total}
          hasNextPage={Boolean(jobsQuery.hasNextPage)}
          isFetchingNextPage={jobsQuery.isFetchingNextPage}
          fetchNextPage={jobsQuery.fetchNextPage}
        />
      </div>
    </section>
  );
}
