import { apiUrl } from "../lib/api-url";
import { apiFetch } from "./client";

export type ReportType = "technician" | "commission" | "finance";

export type ReportPeriodParams = {
  from_date?: string;
  to_date?: string;
};

export type TechnicianReportParams = ReportPeriodParams & {
  without_duplicates?: string;
  duplicate_interval_minutes?: string;
  minimum_call_duration_seconds?: string;
};

export type ReportJobParams = TechnicianReportParams;

export type TechnicianReportRow = {
  user_id: number;
  name: string;
  technician_task_count: number;
  technician_task_score: number;
  ticket_count: number;
};

export type TechnicianReportTotals = {
  technician_task_count: number;
  technician_task_score: number;
  ticket_count: number;
};

export type TechnicianReport = {
  rows: TechnicianReportRow[];
  totals: TechnicianReportTotals;
  unassigned_ticket_count: number;
};

export type CommissionReportRow = {
  user_id: number;
  name: string;
  manager_task_count: number;
  commission_uzs: number;
  commission_usd: number;
};

export type CommissionReportTotals = {
  manager_task_count: number;
  commission_uzs: number;
  commission_usd: number;
};

export type CommissionReport = {
  rows: CommissionReportRow[];
  totals: CommissionReportTotals;
};

export type FinanceReportRow = {
  location_id: number | null;
  name: string;
  task_count: number;
  revenue_uzs: number;
  revenue_usd: number;
  refund_uzs: number;
  refund_usd: number;
  net_revenue_uzs: number;
  net_revenue_usd: number;
  cost_uzs: number;
  cost_usd: number;
  profit_uzs: number;
  profit_usd: number;
  paid_uzs: number;
  paid_usd: number;
  refunded_cash_uzs: number;
  refunded_cash_usd: number;
  due_uzs: number;
  due_usd: number;
};

export type FinanceReportTotals = Omit<FinanceReportRow, "location_id" | "name">;

export type FinanceReport = {
  rows: FinanceReportRow[];
  totals: FinanceReportTotals;
};

export type ReportResult = TechnicianReport | CommissionReport | FinanceReport;

export type ReportJobStatus = "pending" | "running" | "ready" | "failed";

export type StoredReportParams = {
  from_date?: number | null;
  to_date?: number | null;
  without_duplicates?: boolean;
  duplicate_interval_minutes?: number;
  minimum_call_duration_seconds?: number | null;
};

export type ReportJob<T extends ReportResult = ReportResult> = {
  id: number;
  type: ReportType;
  status: ReportJobStatus;
  params?: StoredReportParams;
  error_message?: string | null;
  result?: T | null;
  created_at?: number;
  updated_at?: number;
};

export type ReportJobListPage = {
  jobs: ReportJob[];
  total: number;
  page: number;
  limit: number;
};

export function reportJobPath(id: number) {
  return `/reports/${id}`;
}

export function reportsListPath(type?: ReportType) {
  return type ? `/reports?tab=${encodeURIComponent(type)}` : "/reports";
}

export function createReportJob(type: ReportType, params: ReportJobParams) {
  return apiFetch<ReportJob>(`/bot-admin/api/reports/${type}`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function listReportJobs(params: { page: number; limit: number; type?: ReportType }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.type) search.set("type", params.type);
  return apiFetch<ReportJobListPage>(`/bot-admin/api/reports/jobs?${search}`);
}

export function getReportJob(id: number) {
  return apiFetch<ReportJob>(`/bot-admin/api/reports/jobs/${encodeURIComponent(String(id))}`);
}

export function deleteReportJob(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/reports/jobs/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
  });
}

export function reportEventsUrl() {
  return apiUrl("/bot-admin/api/reports/events");
}
