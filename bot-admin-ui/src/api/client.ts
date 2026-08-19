import { apiUrl } from "../lib/api-url";
import { getStoredSessionToken, setStoredSessionToken } from "./session-token";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type ApiFetchOptions = RequestInit & {
  skipAuthRedirect?: boolean;
};

function authHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const sessionToken = getStoredSessionToken();
  if (sessionToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }
  return headers;
}

function redirectToLogin() {
  setStoredSessionToken(null);
  const loginPath = `${import.meta.env.BASE_URL}login`.replace(/\/+/g, "/");
  window.location.href = loginPath.startsWith("/") ? loginPath : `/${loginPath}`;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { skipAuthRedirect, ...init } = options;
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: authHeaders(init),
  });

  const data = await response.json().catch(() => ({} as T));

  if (response.status === 401 && !skipAuthRedirect) {
    redirectToLogin();
    throw new ApiError("Требуется вход в систему.", 401);
  }

  if (response.status === 403) {
    throw new ApiError((data as { message?: string }).message || "Нет доступа.", 403);
  }

  if (!response.ok) {
    throw new ApiError((data as { message?: string }).message || "Ошибка запроса", response.status);
  }

  return data as T;
}

export type AgentChatStreamHandlers = {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  skipAuthRedirect?: boolean;
};

function parseSseFrame(frame: string): Record<string, unknown> | null {
  const dataLine = frame
    .split("\n")
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const raw = dataLine.replace(/^data:\s?/, "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function applySseEvent<T>(
  event: Record<string, unknown>,
  onDelta: ((text: string) => void) | undefined,
): { done?: T; error?: string } {
  if (event.type === "delta" && typeof event.text === "string" && event.text) onDelta?.(event.text);
  if (event.type === "done") {
    const { type: _type, ...rest } = event;
    return { done: rest as T };
  }
  if (event.type === "error") {
    return { error: String(event.message || "Не удалось получить ответ агента.") };
  }
  return {};
}

export async function streamAgentChat<T>(
  path: string,
  body: unknown,
  handlers: AgentChatStreamHandlers = {},
): Promise<T> {
  const { onDelta, signal, skipAuthRedirect } = handlers;
  const response = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "include",
    signal,
    headers: authHeaders({
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    }),
    body: JSON.stringify(body),
  });

  if (response.status === 401 && !skipAuthRedirect) {
    redirectToLogin();
    throw new ApiError("Требуется вход в систему.", 401);
  }

  const contentType = String(response.headers.get("content-type") || "");
  if (!contentType.includes("text/event-stream")) {
    const data = await response.json().catch(() => ({} as { message?: string }));
    if (response.status === 403) {
      throw new ApiError(data.message || "Нет доступа.", 403);
    }
    if (!response.ok) {
      throw new ApiError(data.message || "Ошибка запроса", response.status);
    }
    return data as T;
  }

  if (!response.ok) {
    throw new ApiError("Ошибка запроса", response.status);
  }

  if (!response.body) {
    throw new ApiError("Пустой ответ агента.", 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: T | null = null;

  const handleFrame = (frame: string) => {
    const event = parseSseFrame(frame);
    if (!event) return;
    const next = applySseEvent<T>(event, onDelta);
    if (next.error) throw new ApiError(next.error, 500);
    if (next.done) donePayload = next.done;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) handleFrame(frame);
    if (done) break;
  }

  if (buffer.trim()) handleFrame(buffer);

  if (!donePayload) {
    throw new ApiError("Пустой ответ агента.", 500);
  }
  return donePayload;
}
