import { apiFetch } from "./client";

export type StaffReportRow = {
  user_id: number;
  name: string;
  manager_task_count: number;
  commission_uzs: number;
  commission_usd: number;
  technician_task_count: number;
  technician_task_score: number;
  ticket_count: number;
};

export type StaffReportTotals = {
  manager_task_count: number;
  commission_uzs: number;
  commission_usd: number;
  technician_task_count: number;
  technician_task_score: number;
  ticket_count: number;
};

export type StaffReport = {
  rows: StaffReportRow[];
  totals: StaffReportTotals;
  unassigned_ticket_count: number;
};

export type StaffReportParams = {
  from_date?: string;
  to_date?: string;
  without_duplicates?: string;
  duplicate_interval_minutes?: string;
  minimum_call_duration_seconds?: string;
};

export function getStaffReport(params: StaffReportParams) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return apiFetch<StaffReport>(`/bot-admin/api/reports/staff${query ? `?${query}` : ""}`);
}
