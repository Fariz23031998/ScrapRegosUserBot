import { apiFetch } from "./client";
import type { CatalogCategory, CatalogDevice } from "../lib/types";

export type CatalogMoneyPayload = {
  cost_amount: number;
  cost_currency: string;
  price_uzs: number | null;
  price_usd: number | null;
};

export type DevicePayload = {
  name: string;
  description?: string;
  category_id?: number | null;
} & CatalogMoneyPayload;

export function listDevices(params: { page: number; limit: number; q?: string; category_id?: string | number }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.category_id) search.set("category_id", String(params.category_id));
  return apiFetch<{ devices: CatalogDevice[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/devices?${search}`,
  );
}

export function createDevice(payload: DevicePayload) {
  return apiFetch<{ device: CatalogDevice }>("/bot-admin/api/devices", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateDevice(id: number, payload: DevicePayload) {
  return apiFetch<{ device: CatalogDevice }>(`/bot-admin/api/devices/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteDevice(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/devices/${id}`, { method: "DELETE" });
}

export function listDeviceCategories() {
  return apiFetch<{ categories: CatalogCategory[] }>("/bot-admin/api/devices/categories");
}

export function createDeviceCategory(payload: { name: string }) {
  return apiFetch<{ category: CatalogCategory }>("/bot-admin/api/devices/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateDeviceCategory(id: number, payload: { name: string }) {
  return apiFetch<{ category: CatalogCategory }>(`/bot-admin/api/devices/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteDeviceCategory(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/devices/categories/${id}`, { method: "DELETE" });
}

export function uploadDeviceImages(id: number, files: File[]) {
  const body = new FormData();
  for (const file of files) body.append("image", file);
  return apiFetch<{ device: CatalogDevice }>(`/bot-admin/api/devices/${id}/images`, {
    method: "POST",
    body,
  });
}

export function deleteDeviceImage(id: number, imageId: number) {
  return apiFetch<{ device: CatalogDevice }>(`/bot-admin/api/devices/${id}/images/${imageId}`, {
    method: "DELETE",
  });
}
