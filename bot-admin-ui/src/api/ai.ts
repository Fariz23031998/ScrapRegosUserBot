import { apiFetch } from "./client";
import type {
  AiGroupTopic,
  AiPrompt,
  AiPromptSlug,
  AiPromptType,
  AiPromptVariable,
  AiSettings,
  AiToolAgentSlug,
  AiToolDescription,
  AiToolSchema,
  AiToolTestResult,
  CustomerTestSession,
  KnowledgeArticle,
  KnowledgeCategory,
  KnowledgeChatMessage,
  TestAgentSessionSummary,
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
  customer_replies_per_hour?: number;
  customer_replies_per_ticket?: number;
  group_chat_id?: string;
  group_topics?: AiGroupTopic[];
  disabled_tools?: string[];
  disabled_agent_tools?: Partial<Record<AiToolAgentSlug, string[]>>;
  ignored_customer_messages?: string[];
  openai_api_key?: string;
  openai_base_url?: string;
  gemini_api_key?: string;
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

export function listAiTools() {
  return apiFetch<{ tools: AiToolSchema[] }>("/bot-admin/api/settings/ai/tools");
}

export function testAiTool(payload: {
  tool_name: string;
  arguments?: Record<string, unknown>;
  ticket_id?: number | string | null;
}) {
  return apiFetch<AiToolTestResult>("/bot-admin/api/settings/ai/tools/test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
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

export function getAiPromptVariables() {
  return apiFetch<{ variables: AiPromptVariable[] }>("/bot-admin/api/ai/prompt-variables");
}

export function createAiPromptVariable(payload: { key: string; name: string; source: string }) {
  return apiFetch<{ variable: AiPromptVariable }>("/bot-admin/api/ai/prompt-variables", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function saveAiPromptVariable(
  id: number,
  payload: { key: string; name: string; source: string },
) {
  return apiFetch<{ variable: AiPromptVariable }>(`/bot-admin/api/ai/prompt-variables/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteAiPromptVariable(id: number) {
  return apiFetch<{ ok: boolean; variable: AiPromptVariable }>(`/bot-admin/api/ai/prompt-variables/${id}`, {
    method: "DELETE",
  });
}

export function testAiPromptVariable(payload: {
  id?: number;
  source: string;
  context?: { ticket?: unknown; client?: unknown };
}) {
  const path =
    payload.id != null
      ? `/bot-admin/api/ai/prompt-variables/${payload.id}/test`
      : "/bot-admin/api/ai/prompt-variables/test";
  return apiFetch<{ value?: string; error?: string }>(path, {
    method: "POST",
    body: JSON.stringify({ source: payload.source, context: payload.context || {} }),
  });
}

export function getAiToolDescriptions() {
  return apiFetch<{ tools: AiToolDescription[] }>("/bot-admin/api/ai/tool-descriptions");
}

export function saveAiToolDescription(name: string, body: string) {
  return apiFetch<{ tool: AiToolDescription }>(
    `/bot-admin/api/ai/tool-descriptions/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: JSON.stringify({ body }),
    },
  );
}

export function resetAiToolDescription(name: string) {
  return apiFetch<{ ok: boolean; tool: AiToolDescription }>(
    `/bot-admin/api/ai/tool-descriptions/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export function listKnowledgeArticles(params: {
  page: number;
  limit: number;
  q?: string;
  categoryId?: number | "none";
}) {
  const search = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.q) search.set("q", params.q);
  if (params.categoryId === "none") search.set("category_id", "none");
  else if (params.categoryId != null) search.set("category_id", String(params.categoryId));
  return apiFetch<{ articles: KnowledgeArticle[]; total: number; page: number; limit: number }>(
    `/bot-admin/api/knowledge/articles?${search}`,
  );
}

export function createKnowledgeArticle(payload: {
  title: string;
  body: string;
  tags?: string;
  category_id?: number | null;
}) {
  return apiFetch<{ article: KnowledgeArticle }>("/bot-admin/api/knowledge/articles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateKnowledgeArticle(
  id: number,
  payload: { title: string; body: string; tags?: string; category_id?: number | null },
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

export function listKnowledgeCategories() {
  return apiFetch<{ categories: KnowledgeCategory[] }>("/bot-admin/api/knowledge/categories");
}

export function createKnowledgeCategory(payload: { name: string; tags?: string }) {
  return apiFetch<{ category: KnowledgeCategory }>("/bot-admin/api/knowledge/categories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateKnowledgeCategory(id: number, payload: { name: string; tags?: string }) {
  return apiFetch<{ category: KnowledgeCategory }>(`/bot-admin/api/knowledge/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteKnowledgeCategory(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/knowledge/categories/${id}`, { method: "DELETE" });
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

export function getCustomerTestSession(sessionId?: number) {
  const query = sessionId ? `?session_id=${sessionId}` : "";
  return apiFetch<CustomerTestSession>(`/bot-admin/api/ai/customer-test-session${query}`);
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

export function getEmployeeTestSession(sessionId?: number) {
  const query = sessionId ? `?session_id=${sessionId}` : "";
  return apiFetch<CustomerTestSession>(`/bot-admin/api/ai/employee-test-session${query}`);
}

export function saveEmployeeTestSession(payload: {
  session_id?: number;
  ticket_id?: number | string | null;
  client_phone?: string | null;
  reset?: boolean;
}) {
  return apiFetch<CustomerTestSession>("/bot-admin/api/ai/employee-test-session", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendEmployeeTestChat(payload: {
  session_id?: number;
  message: string;
  files?: Array<{ name: string; extension: string; data: string }>;
  ticket_id?: number | string | null;
  client_phone?: string | null;
}) {
  return apiFetch<CustomerTestSession>("/bot-admin/api/ai/employee-test-chat", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listTestAgentSessions(agentKind: "customer" | "employee", allUsers = false) {
  const params = new URLSearchParams({ agent_kind: agentKind });
  if (allUsers) params.set("all", "1");
  return apiFetch<{ sessions: TestAgentSessionSummary[]; all_users: boolean }>(
    `/bot-admin/api/ai/test-sessions?${params.toString()}`,
  );
}

export function deleteTestAgentSession(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/ai/test-sessions/${id}`, {
    method: "DELETE",
  });
}

export function clearTestAgentSessions(payload: { agent_kind: "customer" | "employee"; all?: boolean }) {
  return apiFetch<{ ok: boolean; deleted: number }>("/bot-admin/api/ai/test-sessions/clear", {
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
