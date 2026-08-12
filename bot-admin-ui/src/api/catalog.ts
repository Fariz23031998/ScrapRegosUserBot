import { apiFetch } from "./client";
import type { PriceCatalog, TechnicalSupportSubscription } from "../lib/types";

export function getPrices() {
  return apiFetch<{ catalog: PriceCatalog }>("/bot-admin/api/prices");
}

export function savePrices(catalog: PriceCatalog) {
  return apiFetch<{ catalog: PriceCatalog }>("/bot-admin/api/prices", {
    method: "PUT",
    body: JSON.stringify({ catalog }),
  });
}

export function getTechnicalSupportPrices() {
  return apiFetch<{ prices: Record<string, number> }>("/bot-admin/api/technical-support/prices");
}

export function saveTechnicalSupportPrices(prices: Record<string, number>) {
  return apiFetch<{ prices: Record<string, number> }>("/bot-admin/api/technical-support/prices", {
    method: "PUT",
    body: JSON.stringify({ prices }),
  });
}

export function listTechnicalSupportSubscriptions(params: { page: number; limit: number; q?: string; status?: string }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  return apiFetch<{ subscriptions: TechnicalSupportSubscription[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/technical-support/subscriptions?${search}`,
  );
}

export function createTechnicalSupportSubscription(payload: Record<string, unknown>) {
  return apiFetch<{ subscription: TechnicalSupportSubscription }>("/bot-admin/api/technical-support/subscriptions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTechnicalSupportSubscription(id: number, payload: Record<string, unknown>) {
  return apiFetch<{ subscription: TechnicalSupportSubscription }>(
    `/bot-admin/api/technical-support/subscriptions/${id}`,
    { method: "PUT", body: JSON.stringify(payload) },
  );
}

export function deactivateTechnicalSupportSubscription(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/technical-support/subscriptions/${id}/deactivate`, {
    method: "POST",
  });
}

export function deleteTechnicalSupportSubscription(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/technical-support/subscriptions/${id}`, {
    method: "DELETE",
  });
}
