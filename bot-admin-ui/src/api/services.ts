import { apiFetch } from "./client";
import type { CatalogCategory, CatalogService } from "../lib/types";
import type { CatalogMoneyPayload } from "./devices";

export type ServicePayload = {
  name: string;
  description?: string;
  category_id?: number | null;
} & CatalogMoneyPayload;

export function listServices(params: { page: number; limit: number; q?: string; category_id?: string | number }) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.category_id) search.set("category_id", String(params.category_id));
  return apiFetch<{ services: CatalogService[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/services?${search}`,
  );
}

export function createService(payload: ServicePayload) {
  return apiFetch<{ service: CatalogService }>("/bot-admin/api/services", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateService(id: number, payload: ServicePayload) {
  return apiFetch<{ service: CatalogService }>(`/bot-admin/api/services/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteService(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/services/${id}`, { method: "DELETE" });
}

export function listServiceCategories() {
  return apiFetch<{ categories: CatalogCategory[] }>("/bot-admin/api/services/categories");
}

export function createServiceCategory(payload: { name: string }) {
  return apiFetch<{ category: CatalogCategory }>("/bot-admin/api/services/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateServiceCategory(id: number, payload: { name: string }) {
  return apiFetch<{ category: CatalogCategory }>(`/bot-admin/api/services/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteServiceCategory(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/services/categories/${id}`, { method: "DELETE" });
}

export function uploadServiceImages(id: number, files: File[]) {
  const body = new FormData();
  for (const file of files) body.append("image", file);
  return apiFetch<{ service: CatalogService }>(`/bot-admin/api/services/${id}/images`, {
    method: "POST",
    body,
  });
}

export function deleteServiceImage(id: number, imageId: number) {
  return apiFetch<{ service: CatalogService }>(`/bot-admin/api/services/${id}/images/${imageId}`, {
    method: "DELETE",
  });
}
