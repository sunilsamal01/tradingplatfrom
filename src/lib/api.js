// Production note: Vite inlines VITE_API_URL at *build* time, so a split
// deployment (frontend and backend as separate Railway services) needs it in
// the build environment, not just at runtime. When it is missing the SPA falls
// back to its own origin and `/api/*` returns the SPA's index.html instead of
// JSON, which the UI reports as "Backend unreachable".
const DEFAULT_BASE = import.meta.env.DEV
  ? "http://localhost:5000/api"
  : `${window.location.origin}/api`;
const BASE = (import.meta.env.VITE_API_URL || DEFAULT_BASE).replace(/\/$/, "");

let accessToken = null;
export const setAccessToken = (t) => { accessToken = t || null; };
export const clearAccessToken = () => { accessToken = null; };
export const getAccessToken = () => accessToken;

let healthCache = { at: 0, up: false };
export async function isBackendUp() {
  const now = Date.now();
  if (now - healthCache.at < 30000) return healthCache.up;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${BASE}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    healthCache = { at: now, up: r.ok };
    return r.ok;
  } catch { healthCache = { at: now, up: false }; return false; }
}

function normalizeError(status, body) {
  return {
    message: body?.message || `Request failed (${status})`,
    code: body?.code || `HTTP_${status}`,
    status,
    errors: body?.errors,
    retryAfterSeconds: body?.retryAfterSeconds,
  };
}

/**
 * Refresh the session exactly once at a time. Concurrent 401s (parallel
 * requests, React StrictMode double-effects) share the same promise so the
 * server-side refresh-token rotation is never raced by a second, stale call.
 * Resolves to: "refreshed" | "unauthorized" (session truly dead) | "error"
 * (network hiccup — must NOT log the user out).
 */
let refreshInFlight = null;
function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const rf = await fetch(`${BASE}/auth/refresh`, { method: "POST", credentials: "include", signal: ctrl.signal });
        clearTimeout(t);
        const rj = await rf.json().catch(() => null);
        if (rf.ok) {
          // Cookies are fresh now; use the body token when present so the
          // retry (and subsequent calls) authenticate via Authorization too.
          const nt = rj?.data?.accessToken || rj?.data?.token;
          if (nt) setAccessToken(nt);
          return "refreshed";
        }
        return rf.status === 401 || rf.status === 403 ? "unauthorized" : "error";
      } catch {
        return "error";
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

async function request(method, path, body, opts = {}) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctrl.signal,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(opts.headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 && !opts._retried && !opts.noRetry) {
      const rs = await refreshSession();
      if (rs === "refreshed") {
        return request(method, path, body, { ...opts, _retried: true });
      }
      if (rs === "unauthorized") {
        clearAccessToken();
        window.dispatchEvent(new CustomEvent("auth:logout"));
      }
      // "error" = transient network failure during refresh: keep the current
      // session state, just fail this request. Never sign the user out for it.
    }
    if (!res.ok) throw normalizeError(res.status, data);
    return data?.data !== undefined ? data.data : data;
  } catch (e) {
    if (e?.status) throw e;
    throw { message: e?.name === "AbortError" ? "Request timed out" : "Backend unreachable", code: "NETWORK_ERROR", status: 0 };
  } finally { clearTimeout(timeout); }
}

export const api = {
  get: (p, o) => request("GET", p, undefined, o),
  post: (p, b, o) => request("POST", p, b, o),
  patch: (p, b, o) => request("PATCH", p, b, o),
  put: (p, b, o) => request("PUT", p, b, o),
  del: (p, o) => request("DELETE", p, undefined, o),
  base: BASE,
};
export default api;
