export type ThemePreference = "light" | "dark" | "system";

export type DateTimeFormatId = "ru-short" | "ru-long" | "iso" | "us";

export const THEME_STORAGE_KEY = "bot_admin_theme";
export const DATETIME_FORMAT_STORAGE_KEY = "bot_admin_datetime_format";

export const DATETIME_FORMAT_OPTIONS: Array<{ id: DateTimeFormatId; label: string; example: string }> = [
  { id: "ru-short", label: "ДД.ММ.ГГГГ ЧЧ:ММ", example: "12.08.2026 20:15" },
  { id: "ru-long", label: "ДД.ММ.ГГГГ ЧЧ:ММ:СС", example: "12.08.2026 20:15:30" },
  { id: "iso", label: "ГГГГ-ММ-ДД ЧЧ:ММ", example: "2026-08-12 20:15" },
  { id: "us", label: "MM/DD/YYYY hh:mm AM/PM", example: "08/12/2026 08:15 PM" },
];

export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* ignore */
  }
  return "system";
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

export function loadDateTimeFormat(): DateTimeFormatId {
  try {
    const raw = localStorage.getItem(DATETIME_FORMAT_STORAGE_KEY);
    if (raw === "ru-short" || raw === "ru-long" || raw === "iso" || raw === "us") return raw;
  } catch {
    /* ignore */
  }
  return "ru-short";
}

export function saveDateTimeFormat(format: DateTimeFormatId): void {
  try {
    localStorage.setItem(DATETIME_FORMAT_STORAGE_KEY, format);
  } catch {
    /* ignore */
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateObject(date: Date, formatId: DateTimeFormatId = loadDateTimeFormat()): string {
  if (Number.isNaN(date.getTime())) return "—";
  const day = pad2(date.getDate());
  const month = pad2(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours24 = date.getHours();
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());

  switch (formatId) {
    case "ru-long":
      return `${day}.${month}.${year} ${pad2(hours24)}:${minutes}:${seconds}`;
    case "iso":
      return `${year}-${month}-${day} ${pad2(hours24)}:${minutes}`;
    case "us": {
      const hours12 = hours24 % 12 || 12;
      const suffix = hours24 >= 12 ? "PM" : "AM";
      return `${month}/${day}/${year} ${pad2(hours12)}:${minutes} ${suffix}`;
    }
    case "ru-short":
    default:
      return `${day}.${month}.${year} ${pad2(hours24)}:${minutes}`;
  }
}
