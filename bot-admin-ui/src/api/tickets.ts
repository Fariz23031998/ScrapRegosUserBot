import { apiUrl } from "../lib/api-url";
import { apiFetch } from "./client";
import type {
  Ticket,
  TicketDetail,
  ChatMessage,
  ChatMessagesPage,
  ChatUploadFile,
  ChannelSetting,
  RegosTicketUser,
  FirmSearchResult,
  TicketFirmLink,
  TicketAiPrompt,
  TicketChatSummary,
} from "../lib/types";

export function listTickets(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return apiFetch<{
    tickets: Ticket[];
    total: number;
    page: number;
    limit: number;
    summary?: unknown;
    duration_summary?: unknown;
    active_ticket?: Ticket | null;
  }>(`/bot-admin/api/tickets?${search}`);
}

export function getTicket(id: number) {
  return apiFetch<{ ticket: TicketDetail }>(`/bot-admin/api/tickets/${id}`);
}

export function getTicketAiPrompt(id: number, params?: { message_id?: number | string }) {
  const search = new URLSearchParams();
  if (params?.message_id != null && String(params.message_id).trim()) {
    search.set("message_id", String(params.message_id));
  }
  const query = search.toString();
  return apiFetch<TicketAiPrompt>(`/bot-admin/api/tickets/${id}/ai-prompt${query ? `?${query}` : ""}`);
}

export function saveTicketSummary(
  id: number,
  payload: { summary: string; client_id?: number | null; chat_id?: string | null },
) {
  return apiFetch<{ summary: TicketChatSummary }>(`/bot-admin/api/tickets/${id}/summary`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteTicketSummary(id: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/tickets/${id}/summary`, { method: "DELETE" });
}

export function createTicket(payload: Record<string, unknown>) {
  return apiFetch<{ ticket: Ticket }>("/bot-admin/api/tickets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTicket(id: number, payload: Record<string, unknown>) {
  return apiFetch<{ ticket: TicketDetail }>(`/bot-admin/api/tickets/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function listTicketUsers() {
  return apiFetch<{ users: RegosTicketUser[] }>("/bot-admin/api/tickets/users");
}

export function listTicketChannels() {
  return apiFetch<{ channels: Array<{ id: number; name?: string }> }>("/bot-admin/api/tickets/channels");
}

export function searchTicketClients(q: string) {
  return apiFetch<{ clients: Array<{ id: number; name?: string; phone?: string }> }>(
    `/bot-admin/api/tickets/clients?q=${encodeURIComponent(q)}`,
  );
}

export function getTicketMessages(id: number, params: { limit: number; offset?: number; from_end?: boolean }) {
  const search = new URLSearchParams({ limit: String(params.limit) });
  if (params.offset != null) search.set("offset", String(params.offset));
  if (params.from_end) search.set("from_end", "1");
  return apiFetch<ChatMessagesPage>(`/bot-admin/api/tickets/${id}/messages?${search}`);
}

export function sendTicketMessage(
  id: number,
  payload: { text?: string; files?: ChatUploadFile[]; file_ids?: number[] },
) {
  return apiFetch<{ id?: number | string; chat_id?: string; file_ids?: number[]; message?: ChatMessage }>(
    `/bot-admin/api/tickets/${id}/messages`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function getClient(id: number) {
  return apiFetch<{ client: Record<string, unknown>; firms?: TicketFirmLink[] }>(
    `/bot-admin/api/clients/${id}`,
  );
}

export function updateClient(id: number, payload: Record<string, unknown>) {
  return apiFetch<{ client: Record<string, unknown>; firms?: TicketFirmLink[] }>(
    `/bot-admin/api/clients/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function searchFirms(q: string) {
  return apiFetch<{ found?: boolean; results: FirmSearchResult[] }>(
    `/bot-admin/api/firm-search?q=${encodeURIComponent(q)}`,
  );
}

export function linkClientFirm(clientId: number, payload: Record<string, unknown>) {
  return apiFetch<{ firm: TicketFirmLink }>(`/bot-admin/api/clients/${clientId}/firms`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function unlinkClientFirm(clientId: number, linkId: number) {
  return apiFetch<{ ok: boolean }>(`/bot-admin/api/clients/${clientId}/firms/${linkId}`, {
    method: "DELETE",
  });
}

export function getFirm(type: string, recordId: string) {
  return apiFetch<{ firm: Record<string, unknown> }>(
    `/bot-admin/api/firms/${encodeURIComponent(type)}/${encodeURIComponent(recordId)}`,
  );
}

export function getChannelSettings() {
  return apiFetch<{ channels: ChannelSetting[] }>("/bot-admin/api/settings/channels");
}

export function saveChannelSettings(channels: Array<{ id: number; interaction_mode: string }>) {
  return apiFetch<{ channels: ChannelSetting[] }>("/bot-admin/api/settings/channels", {
    method: "PUT",
    body: JSON.stringify({ channels }),
  });
}

export function ticketRecordingUrl(id: number) {
  return apiUrl(`/bot-admin/api/tickets/${encodeURIComponent(String(id))}/recording`);
}

export function ticketFileUrl(ticketId: number | string, fileId: number | string) {
  return apiUrl(
    `/bot-admin/api/tickets/${encodeURIComponent(String(ticketId))}/files/${encodeURIComponent(String(fileId))}`,
  );
}

export function ticketEventsUrl() {
  return apiUrl("/bot-admin/api/tickets/events");
}
