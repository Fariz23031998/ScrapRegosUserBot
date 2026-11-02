import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type DateTimeFormatId,
  type PhoneAction,
  type ThemePreference,
  loadDateTimeFormat,
  loadPhoneAction,
  loadThemePreference,
  loadTicketPeriodDays,
  normalizeTicketPeriodDays,
  saveDateTimeFormat,
  savePhoneAction,
  saveThemePreference,
  saveTicketPeriodDays,
} from "../lib/ui-preferences";
import { applyTheme } from "../lib/utils";

type UiPreferencesContextValue = {
  theme: ThemePreference;
  dateTimeFormat: DateTimeFormatId;
  ticketPeriodDays: number;
  phoneAction: PhoneAction;
  setTheme: (theme: ThemePreference) => void;
  setDateTimeFormat: (format: DateTimeFormatId) => void;
  setTicketPeriodDays: (days: number) => void;
  setPhoneAction: (action: PhoneAction) => void;
};

const UiPreferencesContext = createContext<UiPreferencesContextValue | null>(null);

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(loadThemePreference);
  const [dateTimeFormat, setDateTimeFormatState] = useState<DateTimeFormatId>(loadDateTimeFormat);
  const [ticketPeriodDays, setTicketPeriodDaysState] = useState<number>(loadTicketPeriodDays);
  const [phoneAction, setPhoneActionState] = useState<PhoneAction>(loadPhoneAction);

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
    savePhoneAction(phoneAction);
  }, [phoneAction]);

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

  const setPhoneAction = useCallback((next: PhoneAction) => {
    setPhoneActionState(next);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      dateTimeFormat,
      ticketPeriodDays,
      phoneAction,
      setTheme,
      setDateTimeFormat,
      setTicketPeriodDays,
      setPhoneAction,
    }),
    [theme, dateTimeFormat, ticketPeriodDays, phoneAction, setTheme, setDateTimeFormat, setTicketPeriodDays, setPhoneAction],
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
