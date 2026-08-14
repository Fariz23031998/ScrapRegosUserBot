import { apiFetch } from "./client";
import type {
  AiGroupTopic,
  AiPrompt,
  AiPromptSlug,
  AiPromptType,
  AiSettings,
  CustomerTestSession,
  KnowledgeArticle,
  KnowledgeChatMessage,
  TicketAiAssistSession,
} from "../lib/types";

export function getAiSettings() {
  return apiFetch<AiSettings>("/bot-admin/api/settings/ai");
}

export function saveAiSettings(payload: {
  enabled: boolean;
  test_mode: boolean;
  provider?: string;
  model: string;
  agent_models?: Partial<Record<AiPromptSlug, string>>;
  transcribe_model?: string;
  reasoning_effort?: string;
  history_limit: number;
  group_chat_id?: string;
  group_topics?: AiGroupTopic[];
  disabled_tools?: string[];
}) {
  return apiFetch<AiSettings>("/bot-admin/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function testAiGroupTopic(payload: { topic_key: string; message: string }) {
  return apiFetch<{ ok: boolean; topic_key: string; topic_name: string }>(
    "/bot-admin/api/settings/ai/group-test",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function getAiPrompts() {
  return apiFetch<{ types: AiPromptType[] }>("/bot-admin/api/ai/prompts");
}

export function createAiPrompt(payload: { type: AiPromptSlug; name: string; body: string }) {
  return apiFetch<{ prompt: AiPrompt }>("/bot-admin/api/ai/prompts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function saveAiPrompt(id: number, payload: { name: string; body: string }) {
  return apiFetch<{ prompt: AiPrompt }>(`/bot-admin/api/ai/prompts/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function activateAiPrompt(payload: { type: AiPromptSlug; prompt_id: number | null }) {
  return apiFetch<{ prompt: AiPrompt }>("/bot-admin/api/ai/prompts/active", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteAiPrompt(id: number) {
  return apiFetch<{ ok: boolean; prompt: AiPrompt }>(`/bot-admin/api/ai/prompts/${id}`, {
    method: "DELETE",
  });
}

export function listKnowledgeArticles(q?: string) {
  const search = q ? `?q=${encodeURIComponent(q)}` : "";
  return apiFetch<{ articles: KnowledgeArticle[] }>(`/bot-admin/api/knowledge/articles${search}`);
}

export function createKnowledgeArticle(payload: { title: string; body: string; tags?: string }) {
  return apiFetch<{ article: KnowledgeArticle }>("/bot-admin/api/knowledge/articles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateKnowledgeArticle(
  id: number,
  payload: { title: string; body: string; tags?: string },
) {
  return apiFetch<{ article: KnowledgeArticle }>(`/bot-admin/api/knowledge/articles/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteKnowledgeArticle(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/knowledge/articles/${id}`, { method: "DELETE" });
}

export function lockKnowledgeArticle(id: number) {
  return apiFetch<{ article: KnowledgeArticle }>(`/bot-admin/api/knowledge/articles/${id}/lock`, {
    method: "POST",
  });
}

export function unlockKnowledgeArticle(id: number) {
  return apiFetch<{ article: KnowledgeArticle }>(`/bot-admin/api/knowledge/articles/${id}/unlock`, {
    method: "POST",
  });
}

export function getKbSession() {
  return apiFetch<{ session_id: number; messages: KnowledgeChatMessage[] }>("/bot-admin/api/ai/kb-session");
}

export function resetKbSession(payload?: { session_id?: number }) {
  return apiFetch<{ session_id: number; messages: KnowledgeChatMessage[] }>("/bot-admin/api/ai/kb-session", {
    method: "POST",
    body: JSON.stringify({ ...payload, reset: true }),
  });
}

export function sendKbChat(payload: {
  session_id?: number;
  message: string;
  files?: Array<{ name: string; extension: string; data: string }>;
}) {
  return apiFetch<{ session_id: number; reply: string; messages: KnowledgeChatMessage[] }>(
    "/bot-admin/api/ai/kb-chat",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function getCustomerTestSession() {
  return apiFetch<CustomerTestSession>("/bot-admin/api/ai/customer-test-session");
}

export function saveCustomerTestSession(payload: {
  session_id?: number;
  ticket_id?: number | string | null;
  client_phone?: string | null;
  reset?: boolean;
}) {
  return apiFetch<CustomerTestSession>("/bot-admin/api/ai/customer-test-session", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendCustomerTestChat(payload: {
  session_id?: number;
  message: string;
  files?: Array<{ name: string; extension: string; data: string }>;
  ticket_id?: number | string | null;
  client_phone?: string | null;
}) {
  return apiFetch<CustomerTestSession>("/bot-admin/api/ai/customer-test-chat", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getTicketAiAssistSession(ticketId: number) {
  return apiFetch<TicketAiAssistSession>(`/bot-admin/api/tickets/${ticketId}/ai-assist`);
}

export function resetTicketAiAssistSession(ticketId: number, payload?: { session_id?: number }) {
  return apiFetch<TicketAiAssistSession>(`/bot-admin/api/tickets/${ticketId}/ai-assist`, {
    method: "POST",
    body: JSON.stringify({ ...payload, reset: true }),
  });
}

export function sendTicketAiAssistChat(
  ticketId: number,
  payload: {
    session_id?: number;
    message: string;
    files?: Array<{ name: string; extension: string; data: string }>;
  },
) {
  return apiFetch<TicketAiAssistSession>(`/bot-admin/api/tickets/${ticketId}/ai-assist-chat`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
