// WebGUI/frontend/src/api/http.ts
import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

function getToken(): string {
  return (
    localStorage.getItem("access_token") ||
    sessionStorage.getItem("access_token") ||
    localStorage.getItem("access") ||
    sessionStorage.getItem("access") ||
    localStorage.getItem("token") ||
    sessionStorage.getItem("token") ||
    ""
  );
}

const http = axios.create({
  baseURL: API_BASE,
  withCredentials: false, // you are using JWT in headers, not cookies
});

// ✅ Do NOT attach token for auth endpoints (register/login/refresh)
const PUBLIC_PATHS = [
  "/api/auth/login/",
  "/api/auth/register/",
  "/api/auth/refresh/",
];

http.interceptors.request.use((config) => {
  const url = config.url || "";

  const isPublic = PUBLIC_PATHS.some((p) => url.startsWith(p));
  if (isPublic) {
    if (config.headers) delete (config.headers as any).Authorization;
    return config;
  }

  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    (config.headers as any).Authorization = `Bearer ${token}`;
  }

  return config;
});

export default http;
