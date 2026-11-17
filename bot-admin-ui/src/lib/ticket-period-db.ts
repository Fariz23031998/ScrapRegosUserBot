import { getTicketPeriodDefaults, getTodayPeriodDefaults } from "./ticket-display";
import { loadTicketPeriodDays, normalizeTicketPeriodDays } from "./ui-preferences";

const DB_NAME = "bot-admin-ticket-period";
const STORE_NAME = "period";
const DB_VERSION = 1;
const TICKETS_PERIOD_KEY = "tickets";

export type TicketPeriodPreset = "preference" | "today" | "custom";

/** Relative presets recompute against "today" on each restore. */
export type StoredTicketPeriod =
  | { mode: "preference" }
  | { mode: "today" }
  | { mode: "absolute"; dateFrom: string; dateTo: string };

export type ResolvedTicketPeriod = {
  dateFrom: string;
  dateTo: string;
  mode: "preference" | "today" | "absolute";
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open ticket period IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    let result: T | undefined;

    request.onerror = () => reject(request.error ?? new Error("Ticket period IndexedDB request failed"));
    request.onsuccess = () => {
      result = request.result as T;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result as T);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Ticket period IndexedDB transaction failed"));
    };
  });
}

/** Full calendar-day window matching the default period length (00:00 … 23:59). */
export function isPreferenceShapedPeriod(dateFrom: string, dateTo: string, days?: number): boolean {
  const periodDays = normalizeTicketPeriodDays(days ?? loadTicketPeriodDays());
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return false;
  if (from.getHours() !== 0 || from.getMinutes() !== 0) return false;
  if (to.getHours() !== 23 || to.getMinutes() !== 59) return false;
  const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  const spanDays = Math.round((toDay - fromDay) / 86_400_000) + 1;
  return spanDays === periodDays;
}

function parseStoredPeriod(raw: unknown): StoredTicketPeriod | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { mode?: unknown; dateFrom?: unknown; dateTo?: unknown };
  if (value.mode === "preference" || value.mode === "today") {
    return { mode: value.mode };
  }
  if (typeof value.dateFrom === "string" && typeof value.dateTo === "string") {
    // Legacy absolute rows, or explicit absolute mode.
    if (
      value.mode === "absolute" ||
      value.mode == null ||
      value.mode === "" ||
      value.mode === "custom"
    ) {
      // Preference-shaped legacy ranges roll with "Период тикетов по умолчанию".
      if (isPreferenceShapedPeriod(value.dateFrom, value.dateTo)) {
        return { mode: "preference" };
      }
      return { mode: "absolute", dateFrom: value.dateFrom, dateTo: value.dateTo };
    }
  }
  return null;
}

export function resolveTicketPeriod(
  stored: StoredTicketPeriod | null,
  periodDays?: number,
): ResolvedTicketPeriod | null {
  if (!stored) return null;
  if (stored.mode === "preference") {
    const period = getTicketPeriodDefaults(periodDays);
    return { mode: "preference", dateFrom: period.from, dateTo: period.to };
  }
  if (stored.mode === "today") {
    const period = getTodayPeriodDefaults();
    return { mode: "today", dateFrom: period.from, dateTo: period.to };
  }
  return { mode: "absolute", dateFrom: stored.dateFrom, dateTo: stored.dateTo };
}

export function periodToStore(
  dateFrom: string,
  dateTo: string,
  preset: TicketPeriodPreset = "custom",
  periodDays?: number,
): StoredTicketPeriod {
  if (preset === "preference") return { mode: "preference" };
  if (preset === "today") return { mode: "today" };
  if (!dateFrom && !dateTo) return { mode: "absolute", dateFrom: "", dateTo: "" };
  if (isPreferenceShapedPeriod(dateFrom, dateTo, periodDays)) {
    const current = getTicketPeriodDefaults(periodDays);
    if (dateFrom === current.from && dateTo === current.to) {
      return { mode: "preference" };
    }
  }
  return { mode: "absolute", dateFrom, dateTo };
}

export async function getTicketsPagePeriod(): Promise<StoredTicketPeriod | null> {
  const row = await withStore("readonly", (store) => store.get(TICKETS_PERIOD_KEY));
  return parseStoredPeriod((row as { key: string; value: unknown } | undefined)?.value);
}

export async function saveTicketsPagePeriod(period: StoredTicketPeriod): Promise<void> {
  await withStore("readwrite", (store) => store.put({ key: TICKETS_PERIOD_KEY, value: period }));
}
