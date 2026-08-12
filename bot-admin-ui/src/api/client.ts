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

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { skipAuthRedirect, ...init } = options;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });

  const data = await response.json().catch(() => ({} as T));

  if (response.status === 401 && !skipAuthRedirect) {
    const loginPath = `${import.meta.env.BASE_URL}login`.replace(/\/+/g, "/");
    window.location.href = loginPath.startsWith("/") ? loginPath : `/${loginPath}`;
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
