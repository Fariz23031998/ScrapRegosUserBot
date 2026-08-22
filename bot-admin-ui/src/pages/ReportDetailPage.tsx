import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { listFinanceLocations } from "../api/finances";
import { createReportJob, deleteReportJob, getReportJob, reportJobPath, reportsListPath } from "../api/reports";
import filterFunnelIcon from "../assets/filter-funnel.png";
import LoadingState from "../components/LoadingState";
import Modal from "../components/Modal";
import SummaryBar from "../components/SummaryBar";
import { TicketPeriodModal } from "../components/TicketPeriodModal";
import { useConfirm } from "../contexts/ConfirmContext";
import { useActiveReportJob } from "../contexts/ReportJobViewContext";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { parseDisplayCurrency } from "../lib/money";
import {
  ReportFilterFields,
  ReportResultTables,
  buildCreateParams,
  defaultFilters,
  filtersFromParams,
  filtersHaveAdvancedValues,
  formatReportPeriod,
  loadFilters,
  loadingLabelForType,
  parseReportTab,
  parseScorePerTicket,
  reportSummaryItems,
  reportTypeLabel,
  saveFilters,
} from "./reports-shared";

export default function ReportDetailPage() {
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  useStickyOffsetVar(stickyHeadRef);
  const { ticketPeriodDays } = useUiPreferences();
  const { setJobId: setActiveJobId } = useActiveReportJob();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const jobId = Number(useParams().id);
  const validJobId = Number.isFinite(jobId) && jobId > 0;
  const [filters, setFilters] = useState(() => loadFilters(ticketPeriodDays));
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const hydratedJobId = useRef<number | null>(null);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const jobQuery = useQuery({
    queryKey: ["report-job-status", jobId],
    queryFn: () => getReportJob(jobId),
    enabled: validJobId,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 1000 : false;
    },
  });

  useEffect(() => {
    setActiveJobId(validJobId ? jobId : null);
    return () => setActiveJobId(null);
  }, [jobId, setActiveJobId, validJobId]);

  useEffect(() => {
    const job = jobQuery.data;
    if (!job || hydratedJobId.current === job.id) return;
    hydratedJobId.current = job.id;
    setFilters(filtersFromParams(job.params, ticketPeriodDays));
  }, [jobQuery.data, ticketPeriodDays]);

  const createMutation = useMutation({
    mutationFn: () => {
      const type = parseReportTab(jobQuery.data?.type);
      return createReportJob(type, buildCreateParams(type, filters));
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ["report-jobs"] });
      navigate(reportJobPath(job.id));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteReportJob(jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["report-jobs"] });
      navigate(reportsListPath(parseReportTab(jobQuery.data?.type)));
    },
  });

  async function handleDelete() {
    const job = jobQuery.data;
    if (!job) return;
    const ok = await confirm({
      message: `Удалить отчёт «${reportTypeLabel(job.type)}» (${formatReportPeriod(job.params)})?`,
      variant: "danger",
      confirmLabel: "Удалить",
    });
    if (ok) deleteMutation.mutate();
  }

  const job = jobQuery.data;
  const tab = parseReportTab(job?.type);
  const scorePerTicket = parseScorePerTicket(filters.scorePerTicket);
  const isBuilding =
    jobQuery.isPending || job?.status === "pending" || job?.status === "running" || createMutation.isPending;
  const isRefreshing = jobQuery.isFetching || createMutation.isPending;
  const filtersActive = filtersHaveAdvancedValues(filters, tab, ticketPeriodDays);
  const showTicketFilters = tab === "technician";
  const showFinanceFilters = tab === "finance";
  const displayCurrency = parseDisplayCurrency(filters.currency);
  const locationsQuery = useQuery({
    queryKey: ["finance-locations"],
    queryFn: listFinanceLocations,
    enabled: showFinanceFilters,
  });
  const locations = locationsQuery.data?.locations || [];
  const notFound = !validJobId || (jobQuery.error instanceof ApiError && jobQuery.error.status === 404);
  const errorMessage =
    job?.status === "failed"
      ? job.error_message || "Не удалось построить отчёт."
      : createMutation.error instanceof Error
        ? createMutation.error.message
        : deleteMutation.error instanceof Error
          ? deleteMutation.error.message
          : notFound
          ? "Отчёт не найден."
          : jobQuery.error instanceof Error
            ? jobQuery.error.message
            : null;
  const loadingLabel = loadingLabelForType(tab);
  const summaryItems = job && !isBuilding ? reportSummaryItems(job, scorePerTicket, displayCurrency) : undefined;

  if (notFound && !jobQuery.isPending) {
    return (
      <section className="card tickets-page page--reports page--report-detail">
        <div className="ticket-detail-header">
          <div className="ticket-detail-header__title-row">
            <Link to={reportsListPath()} className="ticket-detail-header__back" aria-label="К списку отчётов" title="К списку отчётов">
              <ArrowLeft size={18} aria-hidden="true" />
            </Link>
            <div className="ticket-detail-header__heading">
              <h1>Отчёт</h1>
            </div>
          </div>
        </div>
        <p className="message error">{errorMessage || "Отчёт не найден."}</p>
      </section>
    );
  }

  return (
    <section className="card tickets-page page--reports page--report-detail">
      {errorMessage ? <p className="message error">{errorMessage}</p> : null}

      <div className="tickets-sticky-head" ref={stickyHeadRef}>
        <div className="ticket-detail-header">
          <div className="ticket-detail-header__title-row">
            <Link
              to={reportsListPath(job ? parseReportTab(job.type) : undefined)}
              className="ticket-detail-header__back"
              aria-label="К списку отчётов"
              title="К списку отчётов"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </Link>
            <div className="ticket-detail-header__heading">
              <h1>{job ? reportTypeLabel(job.type) : "Отчёт"}</h1>
              {job ? <p className="muted-copy ticket-detail-header__period">{formatReportPeriod(job.params)}</p> : null}
            </div>
            {job ? (
              <button
                type="button"
                className="btn-danger btn-icon ticket-detail-header__edit"
                aria-label="Удалить"
                title="Удалить"
                disabled={deleteMutation.isPending}
                onClick={() => void handleDelete()}
              >
                <Trash2 size={18} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <SummaryBar placeholder={isBuilding ? loadingLabel : undefined} items={summaryItems} />

        <form
          className="ticket-filters"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
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
              onRefresh={() => createMutation.mutate()}
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
            createMutation.mutate();
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
              className="btn-secondary btn-icon"
              aria-label="Обновить"
              title="Обновить"
              onClick={() => createMutation.mutate()}
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
            <button type="submit" className="btn-primary" disabled={createMutation.isPending}>
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
        {isBuilding || !job ? (
          <LoadingState message={loadingLabel} />
        ) : (
          <ReportResultTables
            job={job}
            scorePerTicket={scorePerTicket}
            compact={compact}
            displayCurrency={displayCurrency}
          />
        )}
      </div>
    </section>
  );
}
