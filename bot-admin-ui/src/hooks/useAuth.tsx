import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getSession } from "../api/auth";
import type { Permissions, SessionActor, SessionProfile } from "../lib/types";
import { firstAllowedPath, hasPermission } from "../lib/permissions";

type AuthContextValue = {
  actor: SessionActor | null;
  profile: SessionProfile | null;
  permissions: Permissions;
  isAuthenticated: boolean;
  isLoading: boolean;
  hasPermission: (key: string) => boolean;
  firstAllowedPath: string | null;
  refreshSession: () => Promise<void>;
  clearSession: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [permissions, setPermissions] = useState<Permissions>({});
  const [isLoading, setIsLoading] = useState(true);

  const clearSession = useCallback(() => {
    setActor(null);
    setProfile(null);
    setPermissions({});
  }, []);

  const refreshSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getSession();
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
      hasPermission: (key: string) => hasPermission(permissions, key),
      firstAllowedPath: firstAllowedPath(permissions),
      refreshSession,
      clearSession,
    }),
    [actor, profile, permissions, isLoading, refreshSession, clearSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
