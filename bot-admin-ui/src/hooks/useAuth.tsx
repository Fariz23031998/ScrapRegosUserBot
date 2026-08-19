import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getSession, loginTelegramWebApp } from "../api/auth";
import { ApiError } from "../api/client";
import { setStoredSessionToken } from "../api/session-token";
import type { Permissions, SessionActor, SessionProfile } from "../lib/types";
import { firstAllowedPath, hasPermission } from "../lib/permissions";

type AuthContextValue = {
  actor: SessionActor | null;
  profile: SessionProfile | null;
  permissions: Permissions;
  isAuthenticated: boolean;
  isLoading: boolean;
  webAppDenied: string | null;
  hasPermission: (key: string) => boolean;
  firstAllowedPath: string | null;
  refreshSession: () => Promise<boolean>;
  clearSession: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function telegramWebApp() {
  return typeof window === "undefined" ? undefined : window.Telegram?.WebApp;
}

async function maybeWaitForTelegramInitData() {
  if (telegramWebApp()?.initData?.trim()) return;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  if (!/Telegram/i.test(ua)) return;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (telegramWebApp()?.initData?.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [permissions, setPermissions] = useState<Permissions>({});
  const [isLoading, setIsLoading] = useState(true);
  const [webAppDenied, setWebAppDenied] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setStoredSessionToken(null);
    setActor(null);
    setProfile(null);
    setPermissions({});
  }, []);

  const refreshSession = useCallback(async () => {
    setIsLoading(true);
    try {
      await maybeWaitForTelegramInitData();
      const webApp = telegramWebApp();
      const initData = webApp?.initData?.trim();
      if (initData) {
        webApp?.ready?.();
        webApp?.expand?.();
        try {
          await loginTelegramWebApp(initData);
          setWebAppDenied(null);
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            setWebAppDenied(err.message || "Доступ запрещён. Нет права на открытие админ-панели.");
          }
        }
      }

      const data = await getSession();
      setWebAppDenied(null);
      setActor(data.actor);
      setProfile(data.profile);
      setPermissions(data.permissions || {});
      return true;
    } catch {
      clearSession();
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      actor,
      profile,
      permissions,
      isAuthenticated: Boolean(actor),
      isLoading,
      webAppDenied,
      hasPermission: (key: string) => hasPermission(permissions, key),
      firstAllowedPath: firstAllowedPath(permissions),
      refreshSession,
      clearSession,
    }),
    [actor, profile, permissions, isLoading, webAppDenied, refreshSession, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
