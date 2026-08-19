import { apiFetch } from "./client";
import type { PaymentAccount, PaymentType, SettingsLocation } from "../lib/types";

export function getExchangeRate() {
  return apiFetch<{ usd_uzs_rate: number }>("/bot-admin/api/settings/exchange-rate");
}

export function saveExchangeRate(usd_uzs_rate: number) {
  return apiFetch<{ usd_uzs_rate: number }>("/bot-admin/api/settings/exchange-rate", {
    method: "PUT",
    body: JSON.stringify({ usd_uzs_rate }),
  });
}

export function listSettingsLocations() {
  return apiFetch<{ locations: SettingsLocation[] }>("/bot-admin/api/settings/locations");
}

export function createSettingsLocation(payload: { name: string; allowed_user_ids: number[] }) {
  return apiFetch<{ location: SettingsLocation }>("/bot-admin/api/settings/locations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateSettingsLocation(
  id: number,
  payload: { name: string; allowed_user_ids: number[] },
) {
  return apiFetch<{ location: SettingsLocation }>(`/bot-admin/api/settings/locations/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteSettingsLocation(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/settings/locations/${id}`, { method: "DELETE" });
}

export function listSettingsAccounts() {
  return apiFetch<{ accounts: PaymentAccount[] }>("/bot-admin/api/settings/accounts");
}

export function createSettingsAccount(payload: { name: string; currency: "UZS" | "USD" }) {
  return apiFetch<{ account: PaymentAccount }>("/bot-admin/api/settings/accounts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateSettingsAccount(id: number, payload: { name: string; currency: "UZS" | "USD" }) {
  return apiFetch<{ account: PaymentAccount }>(`/bot-admin/api/settings/accounts/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteSettingsAccount(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/settings/accounts/${id}`, { method: "DELETE" });
}

export function listPaymentTypes() {
  return apiFetch<{ payment_types: PaymentType[] }>("/bot-admin/api/settings/payment-types");
}

export function createPaymentType(payload: { name: string; account_id: number }) {
  return apiFetch<{ payment_type: PaymentType }>("/bot-admin/api/settings/payment-types", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updatePaymentType(id: number, payload: { name: string; account_id: number }) {
  return apiFetch<{ payment_type: PaymentType }>(`/bot-admin/api/settings/payment-types/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deletePaymentType(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/settings/payment-types/${id}`, { method: "DELETE" });
}

export type RepairReturnSettings = {
  require_serials: boolean;
};

export function getRepairReturnSettings() {
  return apiFetch<RepairReturnSettings>("/bot-admin/api/settings/repair-returns");
}

export function saveRepairReturnSettings(payload: RepairReturnSettings) {
  return apiFetch<RepairReturnSettings>("/bot-admin/api/settings/repair-returns", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}
