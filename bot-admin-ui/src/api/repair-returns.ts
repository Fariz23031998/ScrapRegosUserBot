import { apiFetch } from "./client";
import type { RepairReturnItem } from "../lib/types";

export type RepairReturnListParams = {
  page: number;
  limit: number;
  q?: string;
  status?: "pending" | "returned" | "all";
  location_id?: string | number;
};

export type RepairReturnListResponse = {
  items: RepairReturnItem[];
  total: number;
  page: number;
  limit: number;
  require_serials: boolean;
};

export function listRepairReturns(params: RepairReturnListParams) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.location_id) search.set("location_id", String(params.location_id));
  return apiFetch<RepairReturnListResponse>(`/bot-admin/api/repair-returns?${search}`);
}

export function createRepairReturn(payload: {
  device_line_id: number;
  quantity?: number;
  serial_ids?: number[];
  serial_codes?: string[];
  note?: string;
}) {
  return apiFetch<{ item: RepairReturnItem }>(`/bot-admin/api/repair-returns`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteRepairReturn(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/repair-returns/${id}`, { method: "DELETE" });
}
