// WebGUI/frontend/src/api/http.ts
import { getAccessToken, clearTokens } from "../auth/token";

const API_HOST = import.meta.env.VITE_API_BASE_URL || ""; // e.g. http://localhost:8000
const API_PREFIX = "/api";

type FetchOpts = RequestInit & { json?: any };

export async function apiFetch(path: string, opts: FetchOpts = {}) {
  const token = getAccessToken();

  const headers: Record<string, string> = {
    ...(opts.headers as any),
  };

  // JSON body support
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  // ✅ Attach JWT for ALL API requests
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = `${API_HOST}${API_PREFIX}${path}`; // <-- important

  const res = await fetch(url, {
    ...opts,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });

  // auto logout if token expired/invalid
  if (res.status === 401) {
    clearTokens();
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      typeof data === "string" ? data : data?.detail || "Request failed";
    throw new Error(`${path} (${res.status}): ${msg}`);
  }

  return data;
}