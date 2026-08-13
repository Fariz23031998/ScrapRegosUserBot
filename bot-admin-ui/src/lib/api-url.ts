export function getApiBaseUrl() {
  return String(import.meta.env.VITE_API_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

export function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;

  // Vite dev must stay same-origin so the proxy can attach the session cookie.
  // Cross-origin calls to :3000 from :5301 drop SameSite=Lax cookies.
  if (import.meta.env.DEV) return normalized;

  const base = getApiBaseUrl();
  return base ? `${base}${normalized}` : normalized;
}
