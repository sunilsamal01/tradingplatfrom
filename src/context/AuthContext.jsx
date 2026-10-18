import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { api, setAccessToken, clearAccessToken, isBackendUp } from "../lib/api.js";
import { firebaseConfigured, firebaseEmailLogin, firebaseGoogleLogin, firebaseSendLoginLink, firebaseCompleteLoginLink } from "../lib/firebaseClient.js";

export const AuthContext = createContext(null);
const mockUser = (email, extra = {}) => ({ id: "demo-1", name: extra.name || "Demo Trader", email: email || "demo@desk.com", role: "user", plan: "FREE", emailVerified: false, ...extra });

// Offline demo mode.
//
// When the API cannot be reached this fabricates a signed-in "Demo Trader" and
// remembers it in localStorage, so the UI can be explored without a backend.
// It MUST NOT run in a production build: silently reporting a session that does
// not exist hides real failures, and on a payments platform it is worse than an
// error - the user believes they are authenticated and can be walked through
// checkout, wallet and account actions that can never succeed. Production must
// always reflect the real session, so this is dev-only.
const OFFLINE_DEMO = import.meta.env.DEV;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backendUp, setBackendUp] = useState(false);

  useEffect(() => {
    (async () => {
      const up = await Promise.race([
        isBackendUp().catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 1500)),
      ]);
      setBackendUp(up);
      if (up) {
        try { const me = await api.get("/auth/me"); setAccessToken(me?.accessToken || null); setUser(me?.user || me); } catch { /* stay logged out */ }
      }
      const saved = localStorage.getItem("slt_demo_user");
      if (!up) {
        // Dev only: honour a stored demo identity. In production a stale key is
        // cleared instead, so a previous demo login can never leak into a real
        // session.
        if (OFFLINE_DEMO && saved) { try { setUser(JSON.parse(saved)); } catch { /* ignore */ } }
        else if (!OFFLINE_DEMO) localStorage.removeItem("slt_demo_user");
      }
      setLoading(false);
    })();
    const onLogout = () => { setUser(null); localStorage.removeItem("slt_demo_user"); };
    window.addEventListener("auth:logout", onLogout);
    return () => window.removeEventListener("auth:logout", onLogout);
  }, []);

  const persistDemo = (u) => { setUser(u); localStorage.setItem("slt_demo_user", JSON.stringify(u)); };

  const login = useCallback(async (email, password) => {
    try {
      // Firebase owns the consumer password check when configured. If it fails
      // (e.g. staff accounts that only exist backend-side), fall back to the
      // backend's local password login before giving up.
      let idToken = null;
      if (firebaseConfigured) {
        try { idToken = await firebaseEmailLogin(email, password); }
        catch {
          const d = await api.post("/auth/login", { email, password });
          if (d?.accessToken || d?.token) setAccessToken(d.accessToken || d.token);
          if (d?.user) setUser(d.user);
          localStorage.removeItem("slt_demo_user");
          return { ok: true, user: d?.user || null };
        }
      }
      const d = await api.post("/auth/login", idToken ? { idToken } : { email, password });
      if (d?.accessToken || d?.token) setAccessToken(d.accessToken || d.token);
      if (d?.user) setUser(d.user);
      localStorage.removeItem("slt_demo_user");
      return { ok: true, user: d?.user || null };
    }
    catch (e) { if (OFFLINE_DEMO && e?.status === 0) { const u = mockUser(email); persistDemo(u); return { ok: true, offline: true, user: u }; } throw e; }
  }, []);

  const register = useCallback(async (name, email, password) => {
    try {
      const parts = String(name || "").trim().split(/\s+/);
      const firstName = parts[0] || "Trader";
      const lastName = parts.slice(1).join(" ");
      // Backend creates the Firebase user itself, then issues a 6-digit OTP.
      const d = await api.post("/auth/register", { firstName, lastName: lastName || undefined, email, password });
      if (d?.accessToken || d?.token) setAccessToken(d.accessToken || d.token);
      if (d?.user) { setUser(d.user); return { ok: true, user: d.user, needsOTP: !!d.needsOTP }; }
      return { ok: true, needsOTP: true };
    }
    catch (e) { if (OFFLINE_DEMO && e?.status === 0) { const u = mockUser(email, { name }); persistDemo(u); return { ok: true, offline: true, user: u }; } throw e; }
  }, []);

  const verifyOTP = useCallback(async (email, otp) => {
    try { const d = await api.post("/auth/verify-otp", { email, otp }); if (d?.accessToken) setAccessToken(d.accessToken); if (d?.user) setUser(d.user); return { ok: true }; }
    catch (e) { if (OFFLINE_DEMO && e?.status === 0) { setUser((u) => u ? { ...u, emailVerified: true } : u); return { ok: true, offline: true }; } throw e; }
  }, []);

  const sendLoginLink = useCallback(async (email) => {
    await firebaseSendLoginLink(email);
    return { ok: true };
  }, []);

  const completeLoginLink = useCallback(async () => {
    try {
      const idToken = await firebaseCompleteLoginLink();
      const d = await api.post("/auth/login", { idToken });
      if (d?.accessToken || d?.token) setAccessToken(d.accessToken || d.token);
      if (d?.user) setUser(d.user);
      localStorage.removeItem("slt_demo_user");
      return { ok: true, user: d?.user || null };
    }
    catch (e) { if (OFFLINE_DEMO && e?.status === 0) { const u = mockUser("link@desk.com", { emailVerified: true }); persistDemo(u); return { ok: true, offline: true, user: u }; } throw e; }
  }, []);

  const googleSuccess = useCallback(async (payload) => {    try {
      // Prefer a real Firebase Google sign-in; fall back to the payload the button collected.
      let body = payload || {};
      if (firebaseConfigured) {
        try { const g = await firebaseGoogleLogin(); body = { idToken: g.idToken }; }
        catch (ge) { if (payload?.email) body = payload; else throw ge; }
      }
      const d = await api.post("/auth/google", body); if (d?.accessToken || d?.token) setAccessToken(d.accessToken || d.token); if (d?.user) setUser(d.user); else if (OFFLINE_DEMO && body?.email) setUser(mockUser(body.email, { name: body?.name, emailVerified: true })); return { ok: true };
    }
    catch (e) { if (OFFLINE_DEMO && e?.status === 0) { const u = mockUser(payload?.email, { name: payload?.name, emailVerified: true }); persistDemo(u); return { ok: true, offline: true, user: u }; } throw e; }
  }, []);

  const logout = useCallback(async () => {
    try { await api.post("/auth/logout", {}); } catch {}
    clearAccessToken(); setUser(null); localStorage.removeItem("slt_demo_user");
  }, []);

  const value = useMemo(() => ({
    user, loading, authenticated: !!user, emailVerified: !!user?.emailVerified,
    role: user?.role || "user", plan: user?.plan || user?.subscription?.plan || "FREE",
    subscription: user?.subscription || null,
    isAdmin: user?.role === "admin" || user?.role === "superadmin",
    isStaff: ["admin", "superadmin", "support", "finance", "analyst"].includes(user?.role),
    backendUp, login, register, verifyOTP, googleSuccess, logout, setUser, sendLoginLink, completeLoginLink,
  }), [user, loading, backendUp, login, register, verifyOTP, googleSuccess, logout, sendLoginLink, completeLoginLink]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

