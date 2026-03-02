// WebGUI/frontend/src/api/client.ts
//
// ✅ Single, consistent client that ALWAYS attaches Authorization
// ✅ Fixes "url must not be empty" by:
//    1) Normalizing VITE_API_BASE_URL (trim, strip trailing slash)
//    2) Allowing either base forms: http://host:8000 OR http://host:8000/api
//    3) Using joinUrl() everywhere (never produces empty URL)
// ✅ Fixes 401 on /bat-review by always using trailing slash (no redirects)

const RAW_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";

// Normalize base: trim + strip trailing slashes
function normalizeBase(u: string): string {
  const x = (u || "").trim();
  return x.replace(/\/+$/, ""); // remove trailing /
}

const API_BASE = normalizeBase(RAW_BASE);

// If user put .../api already, we should not add /api again.
const HAS_API_SUFFIX = /\/api$/i.test(API_BASE);

// Build absolute URL safely.
// - If path already absolute (http/https), return as-is.
// - Ensures exactly one "/" between base and path.
// - If caller passes "/api/..." it will work.
// - If caller passes "/cases/..." we auto-prefix "/api" unless base already ends with "/api".
function joinUrl(path: string): string {
  const p0 = (path || "").trim();
  if (!p0) throw new Error("apiFetch: path is empty");

  // absolute url
  if (/^https?:\/\//i.test(p0)) return p0;

  // ensure leading slash
  const p = p0.startsWith("/") ? p0 : `/${p0}`;

  // If path already starts with /api, don't add /api.
  if (/^\/api(\/|$)/i.test(p)) {
    return `${API_BASE}${p}`;
  }

  // Otherwise, ensure we have /api prefix unless base already ends with /api
  const prefix = HAS_API_SUFFIX ? "" : "/api";
  return `${API_BASE}${prefix}${p}`;
}

type AuthScheme = "Bearer" | "JWT" | "Token";
const AUTH_SCHEME: AuthScheme = "Bearer";

// ---- Token helpers (single source of truth) ----
const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

// Legacy keys you might have used previously in the app:
const LEGACY_ACCESS_KEYS = ["access", "token"] as const;

function readFromStores(key: string): string {
  return localStorage.getItem(key) || sessionStorage.getItem(key) || "";
}

/**
 * Get access token.
 * - Prefer canonical key: access_token
 * - Fallback to legacy keys: access / token
 * - If legacy found, auto-migrate to access_token for future requests
 */
function getAccessToken(): string {
  // 1) Canonical
  const canonical = readFromStores(ACCESS_KEY);
  if (canonical) return canonical;

  // 2) Legacy fallback
  for (const k of LEGACY_ACCESS_KEYS) {
    const legacy = readFromStores(k);
    if (legacy) {
      // migrate to canonical key (keep in same store where found)
      try {
        if (localStorage.getItem(k)) {
          localStorage.setItem(ACCESS_KEY, legacy);
          localStorage.removeItem(k);
        } else if (sessionStorage.getItem(k)) {
          sessionStorage.setItem(ACCESS_KEY, legacy);
          sessionStorage.removeItem(k);
        }
      } catch {
        // ignore migration issues
      }
      return legacy;
    }
  }

  return "";
}

function getAuthScheme(): AuthScheme {
  return AUTH_SCHEME; // SimpleJWT expects Bearer
}

export function authHeaders(): HeadersInit {
  const t = getAccessToken();
  if (!t) return {};
  return { Authorization: `${getAuthScheme()} ${t}` };
}

async function ensureOk(res: Response) {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
}

/**
 * Unified fetch wrapper:
 * - Always attaches Authorization (if present)
 * - Optionally sets JSON content-type via init.json
 * - Uses joinUrl() so URL is never empty
 */
async function apiFetch(
  path: string,
  init: RequestInit & { json?: any } = {}
): Promise<Response> {
  const url = joinUrl(path); // ✅ safe

  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    ...(authHeaders() as Record<string, string>),
  };

  if (init.json !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    init.body = JSON.stringify(init.json);
    delete (init as any).json;
  }

  return fetch(url, {
    redirect: "follow",
    ...init,
    headers,
  });
}

/** Call from console to verify storage + base */
export function debugAuth() {
  const token = getAccessToken();
  return {
    RAW_BASE,
    API_BASE,
    HAS_API_SUFFIX,
    hasToken: !!token,
    tokenPreview: token ? `${token.slice(0, 12)}...${token.slice(-8)}` : "",
    inLocalCanonical: !!localStorage.getItem(ACCESS_KEY),
    inSessionCanonical: !!sessionStorage.getItem(ACCESS_KEY),
    inLocalLegacy: LEGACY_ACCESS_KEYS.some((k) => !!localStorage.getItem(k)),
    inSessionLegacy: LEGACY_ACCESS_KEYS.some((k) => !!sessionStorage.getItem(k)),
  };
}

/** Store tokens in ONE place depending on rememberMe */
function saveTokens(access: string, refresh: string | undefined, rememberMe: boolean) {
  const store = rememberMe ? localStorage : sessionStorage;
  const other = rememberMe ? sessionStorage : localStorage;

  store.setItem(ACCESS_KEY, access);
  if (refresh) store.setItem(REFRESH_KEY, refresh);

  other.removeItem(ACCESS_KEY);
  other.removeItem(REFRESH_KEY);

  for (const k of LEGACY_ACCESS_KEYS) {
    store.removeItem(k);
    other.removeItem(k);
  }
}

// -------------------- AUTH --------------------

export type LoginResponse = { access: string; refresh?: string };

/**
 * POST /api/auth/login/
 * Body: { username, password }
 * Response: { access, refresh }
 */
export async function apiLogin(username: string, password: string, rememberMe: boolean) {
  const res = await fetch(joinUrl("/api/auth/login/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username.trim(), password }),
  });

  await ensureOk(res);
  const data = (await res.json()) as LoginResponse;

  if (!data?.access) throw new Error("Login response missing access token");
  saveTokens(data.access, data.refresh, rememberMe);

  return data;
}

export function apiLogout() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);

  for (const k of LEGACY_ACCESS_KEYS) {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  }
}

export function hasAuthToken(): boolean {
  return !!getAccessToken();
}

// -------------------- CASES --------------------

export async function apiListCases() {
  const res = await apiFetch(`/cases/`, { method: "GET" }); // ✅ no /api here; apiFetch will add it
  await ensureOk(res);
  return res.json();
}

export async function apiUploadOneCase(files: File[], subjectId: string) {
  const fd = new FormData();
  fd.append("subject_id", subjectId);

  (files as any[]).forEach((f) => {
    const rel = (f as any).webkitRelativePath || "";
    const name = rel && rel.length > 0 ? rel : f.name;
    fd.append("files", f, name);
  });

  const res = await apiFetch(`/cases/upload/`, {
    method: "POST",
    body: fd,
  });

  await ensureOk(res);
  return res.json();
}

export async function apiTriggerProcessing(caseIds: (string | number)[]) {
  const res = await apiFetch(`/cases/process/`, {
    method: "POST",
    json: { case_ids: caseIds.map(String) },
  });

  await ensureOk(res);
  return res.json();
}

export async function apiGetCaseStatus(caseId: string | number) {
  const res = await apiFetch(`/cases/${caseId}/status/`, { method: "GET" });
  await ensureOk(res);
  return res.json();
}

export async function apiDeleteCases(ids: (string | number)[]) {
  const res = await apiFetch(`/cases/delete/`, {
    method: "POST",
    json: { ids: ids.map((x) => Number(x)) },
  });

  await ensureOk(res);
  return res.json().catch(() => ({}));
}

// -------------------- BAT REVIEW --------------------

export async function apiBatReview(caseId: string | number) {
  // ✅ trailing slash
  const res = await apiFetch(`/cases/${caseId}/bat-review/`, { method: "GET" });
  await ensureOk(res);
  return res.json();
}

// --- BAT Review: Save Annotation ---

export type MaskType = "binary" | "c3" | "c4";

export type SaveBatAnnotationRequest = {
  mask_type: MaskType;     // "binary" | "c3" | "c4"
  filename: string;        // e.g. "PD001_c4_edited.nii.gz"
  edited_mask_b64: string; // base64 of nifti bytes (NO data: prefix)
};

export async function apiSaveBatAnnotation(caseId: number, body: SaveBatAnnotationRequest) {
  // ✅ build URL safely; always absolute; never empty
  const res = await apiFetch(`/cases/${caseId}/bat-review/save-annotation/`, {
    method: "POST",
    json: body,
  });

  if (!res.ok) {
    let msg = `Save annotation failed (${res.status})`;
    try {
      const j = await res.json();
      msg = j?.detail || j?.error || msg;
    } catch {}
    throw new Error(msg);
  }

  return res.json();
}