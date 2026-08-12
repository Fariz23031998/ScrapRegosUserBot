import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type DateTimeFormatId,
  type ThemePreference,
  loadDateTimeFormat,
  loadThemePreference,
  saveDateTimeFormat,
  saveThemePreference,
} from "../lib/ui-preferences";
import { applyTheme } from "../lib/utils";

type UiPreferencesContextValue = {
  theme: ThemePreference;
  dateTimeFormat: DateTimeFormatId;
  setTheme: (theme: ThemePreference) => void;
  setDateTimeFormat: (format: DateTimeFormatId) => void;
};

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(loadThemePreference);
  const [dateTimeFormat, setDateTimeFormatState] = useState<DateTimeFormatId>(loadDateTimeFormat);

  useEffect(() => {
    applyTheme(theme);
    saveThemePreference(theme);
  }, [theme]);

  useEffect(() => {
    saveDateTimeFormat(dateTimeFormat);
  }, [dateTimeFormat]);

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

  const value = useMemo(
    () => ({ theme, dateTimeFormat, setTheme, setDateTimeFormat }),
    [theme, dateTimeFormat, setTheme, setDateTimeFormat],
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
