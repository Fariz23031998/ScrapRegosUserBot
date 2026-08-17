import { apiFetch } from "./client";
import type { FieldTask, TaskCategory, TaskClient, TaskEmployee } from "../lib/types";

export type TaskListParams = {
  page: number;
  limit: number;
  q?: string;
  status?: string;
  category_id?: string | number;
};

export type TaskPayload = {
  title: string;
  status?: string;
  notes?: string;
  address?: string;
  category_id?: number | null;
  regos_client_id?: number | null;
  client_name?: string | null;
  client_phone?: string | null;
  manager_user_id?: number | null;
  technician_user_id?: number | null;
  devices?: Array<{ device_id: number; action: string; notes?: string }>;
};

export function listTasks(params: TaskListParams) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.category_id) search.set("category_id", String(params.category_id));
  return apiFetch<{ tasks: FieldTask[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/tasks?${search}`,
  );
}

export function getTask(id: number) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${id}`);
}

export function createTask(payload: TaskPayload) {
  return apiFetch<{ task: FieldTask }>("/bot-admin/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTask(id: number, payload: TaskPayload) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteTask(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/tasks/${id}`, { method: "DELETE" });
}

export function listTaskCategories() {
  return apiFetch<{ categories: TaskCategory[] }>("/bot-admin/api/tasks/categories");
}

export function createTaskCategory(payload: { name: string }) {
  return apiFetch<{ category: TaskCategory }>("/bot-admin/api/tasks/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTaskCategory(id: number, payload: { name: string }) {
  return apiFetch<{ category: TaskCategory }>(`/bot-admin/api/tasks/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteTaskCategory(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/tasks/categories/${id}`, { method: "DELETE" });
}

export function listTaskEmployees() {
  return apiFetch<{ employees: TaskEmployee[] }>("/bot-admin/api/tasks/employees");
}

export function searchTaskClients(q: string) {
  return apiFetch<{ clients: TaskClient[] }>(`/bot-admin/api/tasks/clients?q=${encodeURIComponent(q)}`);
}

export function addTaskDevice(
  taskId: number,
  payload: { device_id: number; action: string; notes?: string },
) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/devices`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteTaskDevice(taskId: number, lineId: number) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/devices/${lineId}`, {
    method: "DELETE",
  });
}

export function addTaskService(taskId: number, payload: { service_id: number; notes?: string }) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/services`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteTaskService(taskId: number, lineId: number) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/services/${lineId}`, {
    method: "DELETE",
  });
}
