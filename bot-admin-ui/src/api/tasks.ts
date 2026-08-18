import { apiFetch } from "./client";
import type {
  FieldTask,
  PaymentType,
  TaskCategory,
  TaskClient,
  TaskEmployee,
  TaskLocation,
} from "../lib/types";

export type TaskListParams = {
  page: number;
  limit: number;
  q?: string;
  status?: string;
  category_id?: string | number;
  location_id?: string | number;
};

export type TaskPayload = {
  title: string;
  status?: string;
  action?: string;
  notes?: string;
  address?: string;
  category_id?: number | null;
  location_id?: number | null;
  regos_client_id?: number | null;
  client_name?: string | null;
  client_phone?: string | null;
  manager_user_id?: number | null;
  technician_user_id?: number | null;
  currency?: "UZS" | "USD" | null;
  devices?: Array<{ device_id: number; action: string; notes?: string; quantity?: number }>;
};

export function listTasks(params: TaskListParams) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.category_id) search.set("category_id", String(params.category_id));
  if (params.location_id) search.set("location_id", String(params.location_id));
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

export function listTaskLocations() {
  return apiFetch<{ locations: TaskLocation[] }>("/bot-admin/api/tasks/locations");
}

export function listTaskEmployees() {
  return apiFetch<{ employees: TaskEmployee[] }>("/bot-admin/api/tasks/employees");
}

export function searchTaskClients(q: string) {
  return apiFetch<{ clients: TaskClient[] }>(`/bot-admin/api/tasks/clients?q=${encodeURIComponent(q)}`);
}

export function addTaskDevice(
  taskId: number,
  payload: { device_id: number; action?: string; notes?: string; quantity?: number },
) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/devices`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTaskDevice(
  taskId: number,
  lineId: number,
  payload: { quantity: number },
) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/devices/${lineId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteTaskDevice(taskId: number, lineId: number) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/devices/${lineId}`, {
    method: "DELETE",
  });
}

export function addTaskService(
  taskId: number,
  payload: { service_id: number; notes?: string; quantity?: number },
) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/services`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTaskService(
  taskId: number,
  lineId: number,
  payload: { quantity: number },
) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/services/${lineId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteTaskService(taskId: number, lineId: number) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/services/${lineId}`, {
    method: "DELETE",
  });
}

export type TaskDiscountPayload = {
  scope?: "all" | "selected";
  lines?: Array<{ kind: "device" | "service"; id: number }>;
  type?: "percent" | "amount" | "none";
  value?: number;
  currency?: "UZS" | "USD";
  clear?: boolean;
};

export function applyTaskDiscount(taskId: number, payload: TaskDiscountPayload) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/discount`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export type TaskPaymentPayload = {
  payment_type_id: number;
  amount: number;
  currency?: "UZS" | "USD";
  note?: string;
};

export function listTaskPaymentTypes() {
  return apiFetch<{ payment_types: PaymentType[] }>("/bot-admin/api/tasks/payment-types");
}

export function createTaskPayment(taskId: number, payload: TaskPaymentPayload) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/payments`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteTaskPayment(taskId: number, paymentId: number) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/payments/${paymentId}`, {
    method: "DELETE",
  });
}

export type TaskRefundPayload = {
  kind: "device" | "service";
  line_id: number;
  quantity: number;
  payment_type_id: number;
  amount: number;
  currency?: "UZS" | "USD";
  note?: string;
};

export function createTaskRefund(taskId: number, payload: TaskRefundPayload) {
  return apiFetch<{ task: FieldTask }>(`/bot-admin/api/tasks/${taskId}/refunds`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
