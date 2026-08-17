import { apiFetch } from "./client";

export function getExchangeRate() {
  return apiFetch<{ usd_uzs_rate: number }>("/bot-admin/api/settings/exchange-rate");
}

export function saveExchangeRate(usd_uzs_rate: number) {
  return apiFetch<{ usd_uzs_rate: number }>("/bot-admin/api/settings/exchange-rate", {
    method: "PUT",
    body: JSON.stringify({ usd_uzs_rate }),
  });
}
