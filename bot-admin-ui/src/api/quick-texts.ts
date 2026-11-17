import { apiFetch } from "./client";
import type { EmployeeQuickText, EmployeeQuickTextKind } from "../lib/types";

function basePath(kind: EmployeeQuickTextKind): string {
  return kind === "ai_assist_prompt"
    ? "/bot-admin/api/me/ai-assist-prompts"
    : "/bot-admin/api/me/chat-snippets";
}

export function listQuickTexts(kind: EmployeeQuickTextKind) {
  return apiFetch<{ items: EmployeeQuickText[] }>(basePath(kind));
}

export function createQuickText(
  kind: EmployeeQuickTextKind,
  payload: { title?: string | null; body: string },
) {
  return apiFetch<{ item: EmployeeQuickText }>(basePath(kind), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateQuickText(
  kind: EmployeeQuickTextKind,
  id: number,
  payload: { title?: string | null; body: string },
) {
  return apiFetch<{ item: EmployeeQuickText }>(`${basePath(kind)}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteQuickText(kind: EmployeeQuickTextKind, id: number) {
  return apiFetch<{ ok: boolean }>(`${basePath(kind)}/${id}`, {
    method: "DELETE",
  });
}

export function insertQuickTextIntoCompose(current: string, body: string): string {
  const next = String(body || "");
  if (!next) return current;
  const trimmed = current.trim();
  if (!trimmed) return next;
  return `${current.replace(/\s+$/, "")}\n${next}`;
}
