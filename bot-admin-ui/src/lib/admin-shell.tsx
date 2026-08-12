import { createContext, useContext, type ReactNode } from "react";

export type AdminShellContextValue = {
  navVisible: boolean;
  toggleNav: () => void;
  setNavVisible: (visible: boolean | ((current: boolean) => boolean)) => void;
};

const AdminShellContext = createContext<AdminShellContextValue | null>(null);

export function AdminShellProvider({
  value,
  children,
}: {
  value: AdminShellContextValue;
  children: ReactNode;
}) {
  return <AdminShellContext.Provider value={value}>{children}</AdminShellContext.Provider>;
}

export function useAdminShell(): AdminShellContextValue {
  const ctx = useContext(AdminShellContext);
  if (!ctx) {
    throw new Error("useAdminShell must be used within AdminShellProvider");
  }
  return ctx;
}
