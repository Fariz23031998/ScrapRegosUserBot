import { apiFetch } from "./client";
import type { SessionResponse } from "../lib/types";
import { setStoredSessionToken } from "./session-token";

type AuthOk = { ok: boolean; token?: string };

async function storeAuthToken<T extends AuthOk>(data: T): Promise<T> {
  if (data.token) setStoredSessionToken(data.token);
  return data;
}

export function getSession() {
  return apiFetch<SessionResponse>("/bot-admin/api/session", { skipAuthRedirect: true });
}

export async function login(login: string, password: string) {
  const data = await apiFetch<AuthOk>("/bot-admin/api/login", {
    method: "POST",
    body: JSON.stringify({ login, password }),
    skipAuthRedirect: true,
  });
  return storeAuthToken(data);
}

export async function loginTelegramWebApp(initData: string) {
  const data = await apiFetch<AuthOk>("/bot-admin/api/auth/telegram-webapp", {
    method: "POST",
    body: JSON.stringify({ initData }),
    skipAuthRedirect: true,
  });
  return storeAuthToken(data);
}

export async function logout() {
  try {
    return await apiFetch<{ ok: boolean }>("/bot-admin/api/logout", {
      method: "POST",
      skipAuthRedirect: true,
    });
  } finally {
    setStoredSessionToken(null);
  }
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
