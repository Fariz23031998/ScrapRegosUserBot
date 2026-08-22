import { toDatetimeLocalInput } from "./utils";

export function toDatetimeLocalMinutes(value: unknown): string {
  const full = toDatetimeLocalInput(value);
  return full ? full.slice(0, 16) : "";
}

export function parseDatetimeLocal(value: string): Date | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addMinutesToDatetimeLocal(value: string, minutes: number): string {
  const date = parseDatetimeLocal(value);
  if (!date || !Number.isFinite(minutes)) return "";
  date.setMinutes(date.getMinutes() + minutes);
  return toDatetimeLocalMinutes(date);
}

export function datetimeLocalDiffMinutes(start: string, finish: string): number | null {
  const from = parseDatetimeLocal(start);
  const to = parseDatetimeLocal(finish);
  if (!from || !to) return null;
  const diff = Math.round((to.getTime() - from.getTime()) / 60_000);
  return Number.isFinite(diff) ? diff : null;
}

export function parseDurationMinutes(hours: string, minutes: string): number | null {
  const hoursRaw = String(hours || "").trim();
  const minutesRaw = String(minutes || "").trim();
  if (!hoursRaw && !minutesRaw) return null;
  const hoursValue = hoursRaw ? Number(hoursRaw) : 0;
  const minutesValue = minutesRaw ? Number(minutesRaw) : 0;
  if (!Number.isFinite(hoursValue) || !Number.isFinite(minutesValue) || hoursValue < 0 || minutesValue < 0) {
    return null;
  }
  return Math.round(hoursValue * 60 + minutesValue);
}

export function formatDurationParts(totalMinutes: number | null): { hours: string; minutes: string } {
  if (totalMinutes == null || !Number.isFinite(totalMinutes) || totalMinutes < 0) {
    return { hours: "", minutes: "" };
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  return { hours: String(hours), minutes: String(minutes) };
}

export function sanitizeDurationHours(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const next = Number(raw);
  if (!Number.isFinite(next) || next < 0) return "";
  return String(Math.min(999, Math.floor(next)));
}

export function sanitizeDurationMinutes(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const next = Number(raw);
  if (!Number.isFinite(next) || next < 0) return "";
  return String(Math.min(59, Math.floor(next)));
}
