import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type DateTimeFormatId,
  type ThemePreference,
  loadDateTimeFormat,
  loadThemePreference,
  loadTicketPeriodDays,
  normalizeTicketPeriodDays,
  saveDateTimeFormat,
  saveThemePreference,
  saveTicketPeriodDays,
} from "../lib/ui-preferences";
import { applyTheme } from "../lib/utils";

type UiPreferencesContextValue = {
  theme: ThemePreference;
  dateTimeFormat: DateTimeFormatId;
  ticketPeriodDays: number;
  setTheme: (theme: ThemePreference) => void;
  setDateTimeFormat: (format: DateTimeFormatId) => void;
  setTicketPeriodDays: (days: number) => void;
};

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(loadThemePreference);
  const [dateTimeFormat, setDateTimeFormatState] = useState<DateTimeFormatId>(loadDateTimeFormat);
  const [ticketPeriodDays, setTicketPeriodDaysState] = useState<number>(loadTicketPeriodDays);

  useEffect(() => {
    applyTheme(theme);
    saveThemePreference(theme);
  }, [theme]);

  useEffect(() => {
    saveDateTimeFormat(dateTimeFormat);
  }, [dateTimeFormat]);

  useEffect(() => {
    saveTicketPeriodDays(ticketPeriodDays);
  }, [ticketPeriodDays]);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
  }, []);

  const setDateTimeFormat = useCallback((next: DateTimeFormatId) => {
    setDateTimeFormatState(next);
  }, []);

  const setTicketPeriodDays = useCallback((next: number) => {
    setTicketPeriodDaysState(normalizeTicketPeriodDays(next));
  }, []);

  const value = useMemo(
    () => ({ theme, dateTimeFormat, ticketPeriodDays, setTheme, setDateTimeFormat, setTicketPeriodDays }),
    [theme, dateTimeFormat, ticketPeriodDays, setTheme, setDateTimeFormat, setTicketPeriodDays],
  );

  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences() {
  const value = useContext(UiPreferencesContext);
  if (!value) {
    throw new Error("useUiPreferences must be used within UiPreferencesProvider");
  }
  return value;
}
