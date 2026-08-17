import { apiFetch } from "./client";
import type { SessionResponse } from "../lib/types";

export function getSession() {
  return apiFetch<SessionResponse>("/bot-admin/api/session", { skipAuthRedirect: true });
}

export function login(login: string, password: string) {
  return apiFetch<{ ok: boolean }>("/bot-admin/api/login", {
    method: "POST",
    body: JSON.stringify({ login, password }),
    skipAuthRedirect: true,
  });
}

export function loginTelegramWebApp(initData: string) {
  return apiFetch<{ ok: boolean }>("/bot-admin/api/auth/telegram-webapp", {
    method: "POST",
    body: JSON.stringify({ initData }),
    skipAuthRedirect: true,
  });
}

export function logout() {
  return apiFetch<{ ok: boolean }>("/bot-admin/api/logout", { method: "POST", skipAuthRedirect: true });
}

export function updateAccount(payload: {
  display_name?: string | null;
  login?: string;
  new_password?: string;
  current_password?: string;
}) {
  return apiFetch<{
    ok: boolean;
    message?: string;
    profile?: { login?: string | null; displayName?: string | null; canChangeCredentials?: boolean };
  }>("/bot-admin/api/account", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
