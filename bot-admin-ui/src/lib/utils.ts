import { formatDateObject, loadThemePreference, type ThemePreference } from "./ui-preferences";

const NAV_VISIBLE_KEY = "bot_admin_nav_visible";

export function loadNavVisible(): boolean {
  try {
    const raw = localStorage.getItem(NAV_VISIBLE_KEY);
    if (raw === "false") return false;
  } catch {
    /* ignore */
  }
  return true;
}

export function saveNavVisible(visible: boolean): void {
  try {
    localStorage.setItem(NAV_VISIBLE_KEY, visible ? "true" : "false");
  } catch {
    /* ignore */
  }
}

export function applyTheme(pref: ThemePreference = loadThemePreference()): void {
  const dark =
    pref === "dark" ||
    (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = dark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDateTime(value: unknown): string {
  if (!value) return "—";
  const raw = String(value);
  const date = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.includes("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return raw;
  return formatDateObject(date);
}

export function formatAmount(amount: unknown): string {
  if (amount == null) return "—";
  return `${Number(amount).toLocaleString("ru-RU")} сум`;
}

export function matchesSearch(query: string, ...fields: Array<string | number | null | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return fields.some((field) => String(field ?? "").toLowerCase().includes(normalized));
}

export function phonesEqual(left: unknown, right: unknown): boolean {
  const a = String(left ?? "").replace(/\D/g, "");
  const b = String(right ?? "").replace(/\D/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  const aTail = a.slice(-9);
  const bTail = b.slice(-9);
  return aTail.length >= 9 && aTail === bTail;
}

export function canonicalizeUzbekPhone(phone: unknown): string | null {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 9 && digits.startsWith("9")) digits = `998${digits}`;
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;
  return null;
}

export function formatUzbekPhone(phone: unknown): string {
  const canonical = canonicalizeUzbekPhone(phone);
  const digits = canonical ? canonical.slice(1) : String(phone ?? "").replace(/\D/g, "");
  const match = /^998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  if (!match) return String(phone ?? "").trim() || "—";
  const [, code, first, second, third] = match;
  return `+998 ${code} ${first}-${second}-${third}`;
}
