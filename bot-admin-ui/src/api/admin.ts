import { apiFetch } from "./client";
import type { BotUser, Order, OrderLog, OrderSummary, AdminLog, RightMeta, RegosUser } from "../lib/types";

export function getRightsMeta() {
  return apiFetch<{ rights: RightMeta[] }>("/bot-admin/rights-meta");
}

export function listUsers(params: { page: number; limit: number; q?: string; role?: string }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.role) search.set("role", params.role);
  return apiFetch<{ users: BotUser[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/users?${search}`,
  );
}

export function listRegosUsers() {
  return apiFetch<{ users: RegosUser[] }>("/bot-admin/api/regos-users");
}

export function createUser(payload: Record<string, unknown>) {
  return apiFetch<{ user: BotUser }>("/bot-admin/api/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateUser(id: number, payload: Record<string, unknown>) {
  return apiFetch<{ user: BotUser }>(`/bot-admin/api/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteUser(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/users/${id}`, { method: "DELETE" });
}

export function promoteUser(id: number, payload: Record<string, unknown>) {
  return apiFetch<{ user: BotUser }>(`/bot-admin/api/users/${id}/promote`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteRegosLink(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/users/${id}/regos-link`, { method: "DELETE" });
}

export function regosAutoLink() {
  return apiFetch<{ linked: number }>("/bot-admin/api/users/regos-auto-link", { method: "POST" });
}

export function listOrders(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return apiFetch<{
    orders: Order[];
    total: number;
    page: number;
    limit: number;
    summary?: OrderSummary;
  }>(`/bot-admin/api/orders?${search}`);
}

export function listOrderEmployees() {
  return apiFetch<{
    employees: Array<{ telegram_id: number; display_name?: string | null; phone?: string | null }>;
  }>("/bot-admin/api/orders/employees");
}

export function deleteOrder(id: string) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/orders/${encodeURIComponent(id)}/delete`, {
    method: "POST",
  });
}

export function deleteCashOrder(id: string) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/orders/${encodeURIComponent(id)}/delete-cash`, {
    method: "POST",
  });
}

export function markPaidCash(id: string) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/orders/${encodeURIComponent(id)}/paid-cash`, {
    method: "POST",
  });
}

export function renotifyOrder(id: string) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/orders/${encodeURIComponent(id)}/renotify`, {
    method: "POST",
  });
}

export function createOrder(payload: Record<string, unknown>) {
  return apiFetch<{ order: Order; payment_page_url?: string }>("/bot-admin/api/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listOrderLogs(params: { page: number; limit: number; q?: string }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  return apiFetch<{ logs: OrderLog[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/order-logs?${search}`,
  );
}

export function listAdminLogs(params: { page: number; limit: number; q?: string }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  return apiFetch<{ logs: AdminLog[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/logs?${search}`,
  );
}
