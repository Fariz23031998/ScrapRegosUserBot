import { apiFetch } from "./client";
import type { AccountPayment, AccountPaymentDirection, PaymentAccount } from "../lib/types";

export type FinancePaymentListParams = {
  account_id?: number | string;
  direction?: AccountPaymentDirection | "";
};

export type CreateFinancePaymentPayload = {
  account_id: number;
  direction: AccountPaymentDirection;
  amount: number;
  currency?: "UZS" | "USD";
  note?: string;
};

export function listFinanceAccounts() {
  return apiFetch<{ accounts: PaymentAccount[] }>("/bot-admin/api/finances/accounts");
}

export function listFinancePayments(params: FinancePaymentListParams = {}) {
  const search = new URLSearchParams();
  if (params.account_id) search.set("account_id", String(params.account_id));
  if (params.direction) search.set("direction", params.direction);
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
