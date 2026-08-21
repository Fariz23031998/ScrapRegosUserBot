import { apiFetch } from "./client";
import type {
  AccountPayment,
  AccountPaymentDirection,
  CatalogCategory,
  PaymentAccount,
  TaskLocation,
} from "../lib/types";

export type FinancePaymentListParams = {
  account_id?: number | string;
  direction?: AccountPaymentDirection | "";
  category_id?: number | string;
  location_id?: number | string;
};

export type CreateFinancePaymentPayload = {
  account_id: number;
  direction: AccountPaymentDirection;
  amount: number;
  currency?: "UZS" | "USD";
  note?: string;
  category_id?: number | null;
  location_id?: number | null;
};

export function listFinanceAccounts() {
  return apiFetch<{ accounts: PaymentAccount[] }>("/bot-admin/api/finances/accounts");
}

export function listFinancePayments(params: FinancePaymentListParams = {}) {
  const search = new URLSearchParams();
  if (params.account_id) search.set("account_id", String(params.account_id));
  if (params.direction) search.set("direction", params.direction);
  if (params.category_id) search.set("category_id", String(params.category_id));
  if (params.location_id) search.set("location_id", String(params.location_id));
  const query = search.toString();
  return apiFetch<{ payments: AccountPayment[] }>(
    `/bot-admin/api/finances/payments${query ? `?${query}` : ""}`,
  );
}

export function createFinancePayment(payload: CreateFinancePaymentPayload) {
  return apiFetch<{ payment: AccountPayment; account: PaymentAccount }>(
    "/bot-admin/api/finances/payments",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function deleteFinancePayment(id: number) {
  return apiFetch<{ ok: boolean; account: PaymentAccount | null }>(
    `/bot-admin/api/finances/payments/${id}`,
    { method: "DELETE" },
  );
}

export function listFinanceCategories() {
  return apiFetch<{ categories: CatalogCategory[] }>("/bot-admin/api/finances/categories");
}

export function listFinanceLocations() {
  return apiFetch<{ locations: TaskLocation[] }>("/bot-admin/api/finances/locations");
}

export function createFinanceCategory(payload: { name: string }) {
  return apiFetch<{ category: CatalogCategory }>("/bot-admin/api/finances/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateFinanceCategory(id: number, payload: { name: string }) {
  return apiFetch<{ category: CatalogCategory }>(`/bot-admin/api/finances/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteFinanceCategory(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/finances/categories/${id}`, { method: "DELETE" });
}
