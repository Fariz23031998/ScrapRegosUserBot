const TOKEN_KEY = "bot_admin_session_token";

export function getStoredSessionToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredSessionToken(token: string | null | undefined) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode / quota
  }
}

/** For <audio>/<img> media that cannot send Authorization after the cookie expires. */
export function withSessionAccessToken(url: string): string {
  const token = getStoredSessionToken();
  if (!token) return url;
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}access_token=${encodeURIComponent(token)}`;
}
