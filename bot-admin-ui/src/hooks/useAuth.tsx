import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getSession, loginTelegramWebApp } from "../api/auth";
import { ApiError } from "../api/client";
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
  refreshSession: () => Promise<void>;
  clearSession: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function telegramWebApp() {
  return typeof window === "undefined" ? undefined : window.Telegram?.WebApp;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [permissions, setPermissions] = useState<Permissions>({});
  const [isLoading, setIsLoading] = useState(true);
  const [webAppDenied, setWebAppDenied] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setActor(null);
    setProfile(null);
    setPermissions({});
  }, []);

  const refreshSession = useCallback(async () => {
    setIsLoading(true);
    try {
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
            clearSession();
            return;
          }
        }
      }

      const data = await getSession();
      setWebAppDenied(null);
      setActor(data.actor);
      setProfile(data.profile);
      setPermissions(data.permissions || {});
    } catch {
      clearSession();
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
