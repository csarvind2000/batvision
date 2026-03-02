// WebGUI/frontend/src/auth/token.ts

const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

export function getAccessToken(): string {
  return (
    localStorage.getItem(ACCESS_KEY) ||
    sessionStorage.getItem(ACCESS_KEY) ||
    ""
  );
}

export function getRefreshToken(): string {
  return (
    localStorage.getItem(REFRESH_KEY) ||
    sessionStorage.getItem(REFRESH_KEY) ||
    ""
  );
}

export function setTokens(access: string, refresh?: string, rememberMe: boolean = true) {
  const store = rememberMe ? localStorage : sessionStorage;
  const other = rememberMe ? sessionStorage : localStorage;

  store.setItem(ACCESS_KEY, access);
  if (refresh) store.setItem(REFRESH_KEY, refresh);

  // prevent stale tokens
  other.removeItem(ACCESS_KEY);
  other.removeItem(REFRESH_KEY);
}

export function setAccessToken(access: string) {
  // update wherever the refresh token currently lives; else localStorage
  if (sessionStorage.getItem(REFRESH_KEY)) {
    sessionStorage.setItem(ACCESS_KEY, access);
  } else if (localStorage.getItem(REFRESH_KEY)) {
    localStorage.setItem(ACCESS_KEY, access);
  } else {
    localStorage.setItem(ACCESS_KEY, access);
  }
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}

export function hasToken() {
  return !!getAccessToken();
}