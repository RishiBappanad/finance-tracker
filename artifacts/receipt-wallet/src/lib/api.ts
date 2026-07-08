// API base URL — empty in production (same origin), localhost in dev
export const API_BASE = import.meta.env.DEV ? "http://localhost:5001" : "";

const TOKEN_KEY = "auth_token";

/**
 * Fetch wrapper that automatically includes the auth token.
 * Use this for all raw fetch calls (pages that don't use generated hooks).
 */
export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}
