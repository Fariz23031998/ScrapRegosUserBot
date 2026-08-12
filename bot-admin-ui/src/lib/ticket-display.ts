import type { Ticket, TicketFirmLink, TicketLocalData } from "./types";
import { formatDateObject } from "./ui-preferences";

export const STATUS_LABELS: Record<string, string> = {
  Open: "Открыт",
  Closed: "Закрыт",
  WaitingClient: "Ожидание клиента",
  WaitingStaff: "Ожидание сотрудника",
};

export const DIRECTION_LABELS: Record<string, string> = {
  Inbound: "Входящий",
  Outbound: "Исходящий",
};

export const FIRM_TYPE_LABELS: Record<string, string> = {
  partner: "Partner",
  vcr1_partner: "VCR",
  vcr1_license: "VCR лицензия",
  license: "Лицензия",
  rpos_client: "RPOS клиент",
  rpos_account: "RPOS аккаунт",
};

export function statusLabel(status: unknown): string {
  const key = String(status || "");
  return STATUS_LABELS[key] || key || "—";
}

export function directionLabel(direction: unknown): string {
  const key = String(direction || "");
  return DIRECTION_LABELS[key] || key || "—";
}

export function firmTypeLabel(type: unknown): string {
  const key = String(type || "");
  return FIRM_TYPE_LABELS[key] || key || "—";
}

export function statusBadgeClass(status: unknown): string {
  switch (status) {
    case "Open":
      return "ticket-status ticket-status--open";
    case "Closed":
      return "ticket-status ticket-status--closed";
    case "WaitingClient":
      return "ticket-status ticket-status--waiting-client";
    case "WaitingStaff":
      return "ticket-status ticket-status--waiting-staff";
    default:
      return "ticket-status";
  }
}

export function formatUnix(seconds: unknown): string {
  if (seconds == null || seconds === 0) return "—";
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDateObject(date);
}

export function formatShortDate(iso: unknown): string {
  if (!iso) return "—";
  const date = new Date(String(iso));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatCallDuration(totalSeconds: unknown): string {
  const seconds = Math.max(0, Math.round(Number(totalSeconds)));
  if (!Number.isFinite(seconds)) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(remainder)}`
    : `${minutes}:${pad2(remainder)}`;
}

export function formatMoneyAmount(amount: unknown): string {
  return (Number(amount) || 0).toLocaleString("ru-RU");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDatetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function getTodayPeriodDefaults(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
  return { from: toDatetimeLocalValue(from), to: toDatetimeLocalValue(to) };
}

export function datetimeLocalToUnix(value: unknown): number | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

export function getTicketClientId(ticket: Ticket): number | null {
  const id = Number(ticket.client_id ?? ticket.client?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function getCachedRecording(ticket: Ticket) {
  return ticket.local?.recording || null;
}

export function getCachedRecordingDuration(ticket: Ticket): number | null {
  const duration = Number(getCachedRecording(ticket)?.duration_seconds);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function getRecordingUrl(ticket: Ticket): string | null {
  const cachedUrl = String(getCachedRecording(ticket)?.url || "").trim();
  if (/^https?:\/\//i.test(cachedUrl)) return cachedUrl;

  const fields = Array.isArray(ticket.fields) ? ticket.fields : [];
  const recordingField = fields.find((field) => {
    const key = String(field?.key || "").trim().toLowerCase();
    const name = String(field?.name || "").trim().toLowerCase();
    return key === "field_recording_link" || name === "ссылка на запись";
  });
  const value = String(recordingField?.value || "").trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

export function hasTicketRecording(ticket: Ticket): boolean {
  return Boolean(getRecordingUrl(ticket));
}

export function collectUnpaidClientPhones(ticket: Ticket): string[] {
  const unpaid = ticket.local?.unpaid_orders;
  const phones: string[] = [];
  const seen = new Set<string>();

  function pushPhone(value: unknown) {
    const phone = String(value || "").trim();
    if (!phone) return;
    const key = phone.replace(/\D/g, "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    phones.push(phone);
  }

  for (const order of unpaid?.orders || []) {
    pushPhone(order.client_phone);
  }
  if (!phones.length) {
    pushPhone(ticket.client?.phone);
    for (const firm of ticket.local?.firms || []) {
      pushPhone(firm.firm_phone);
    }
  }
  return phones;
}

export function unpaidOrdersHref(ticket: Ticket): string | null {
  const unpaid = ticket.local?.unpaid_orders;
  const firmPhones = (ticket.local?.firms || []).map((firm) => firm.firm_phone).filter(Boolean);
  const hasLookupPhone = Boolean(ticket.client?.phone || firmPhones.length);
  if (!unpaid || unpaid.count === 0) {
    return hasLookupPhone ? null : null;
  }
  const clientPhones = collectUnpaidClientPhones(ticket);
  const params = new URLSearchParams({ status: "pending" });
  if (clientPhones.length) {
    params.set("client", clientPhones.join(","));
  }
  return `/orders?${params.toString()}`;
}

export function unpaidOrdersLabel(ticket: Ticket): string | null {
  const unpaid = ticket.local?.unpaid_orders;
  if (!unpaid || unpaid.count === 0) return null;
  return `${unpaid.count} · ${formatMoneyAmount(unpaid.total_amount)}`;
}

export function hasLookupPhone(ticket: Ticket): boolean {
  const firmPhones = (ticket.local?.firms || []).map((firm) => firm.firm_phone).filter(Boolean);
  return Boolean(ticket.client?.phone || firmPhones.length);
}

export function technicalSupportDisplay(ticket: Ticket): {
  kind: "none" | "missing" | "inactive" | "active" | "expired";
  dateLabel?: string;
} {
  const ts = ticket.local?.technical_support;
  if (!hasLookupPhone(ticket)) return { kind: "missing" };
  if (!ts || ts.status === "none") return { kind: "none" };
  const dateLabel = formatShortDate(ts.ends_at);
  if (ts.status === "active") return { kind: "active", dateLabel };
  return { kind: "expired", dateLabel };
}

export function firmButtonLabel(firm: TicketFirmLink): string {
  return firm.firm_name || `${firmTypeLabel(firm.firm_type)} #${firm.firm_record_id}`;
}

export function userDisplayName(
  userId: unknown,
  userNames: Record<string, string>,
): string {
  if (userId == null || userId === "") return "—";
  const key = String(userId);
  return userNames[key] || `Пользователь #${key}`;
}

export function channelDisplayName(
  channelId: unknown,
  channelNames: Record<string, string>,
): string {
  if (channelId == null || channelId === "") return "—";
  const key = String(channelId);
  return channelNames[key] || `Канал #${key}`;
}

const recordingDurationCache = new Map<string, number>();
const recordingDurationPromises = new Map<string, Promise<number | null>>();

export function loadRecordingDuration(ticketId: number): Promise<number | null> {
  const key = String(ticketId);
  const cached = recordingDurationCache.get(key);
  if (cached != null) return Promise.resolve(cached);
  const pending = recordingDurationPromises.get(key);
  if (pending) return pending;

  const promise = new Promise<number | null>((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";
    const timeout = window.setTimeout(() => finish(null), 15_000);

    function finish(duration: number | null) {
      window.clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
      if (duration != null && Number.isFinite(duration)) {
        recordingDurationCache.set(key, duration);
        resolve(duration);
      } else {
        resolve(null);
      }
    }

    function onLoaded() {
      const duration = Number(audio.duration);
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    }

    function onError() {
      finish(null);
    }

    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.src = `/bot-admin/api/tickets/${encodeURIComponent(key)}/recording`;
  }).finally(() => {
    recordingDurationPromises.delete(key);
  });

  recordingDurationPromises.set(key, promise);
  return promise;
}

export function seedRecordingDurationCache(ticketId: number, duration: number) {
  if (Number.isFinite(duration) && duration > 0) {
    recordingDurationCache.set(String(ticketId), duration);
  }
}

export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

export type DurationSummary = {
  base?: { count?: number; slaBreached?: number; rated?: number };
  calls?: Array<{
    id?: number;
    hasRecording?: boolean;
    duration_seconds?: number;
    slaBreached?: boolean;
    rated?: boolean;
  }>;
};

export function getTicketLocal(ticket: Ticket): TicketLocalData | undefined {
  return ticket.local;
}
