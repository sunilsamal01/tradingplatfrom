import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Container, Section, Card, FormField, Input, Button } from "../components/ui.jsx";
import { ButtonLoader } from "../components/Loaders.jsx";
import { useAuth } from "../context/useAuth.js";
import { isLoginLinkHref } from "../lib/firebaseClient.js";
import { api } from "../lib/api.js";

const emailOK = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);


export function Login() {
  const nav = useNavigate();
  const { login, googleSuccess, sendLoginLink, completeLoginLink } = useAuth();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  // Complete a passwordless sign-in when returning from the email link.
  useEffect(() => {
    if (!isLoginLinkHref()) return;
    setBusy(true);
    completeLoginLink()
      .then(() => nav("/dashboard"))
      .catch((er) => { setErr(er.message || "This sign-in link is invalid or expired."); setBusy(false); });
  }, [nav, completeLoginLink]);
  const emailBad = email && !emailOK(email);
  const pwBad = pw && pw.length < 6;
  const submit = async (e) => {
    e.preventDefault();
    if (linkMode) {
      if (!email || emailBad) { setErr("Enter a valid email to receive the link."); return; }
      setBusy(true); setErr("");
      try { await sendLoginLink(email); setLinkSent(true); }
      catch (er) { setErr(er.message || "Could not send link"); }
      finally { setBusy(false); }
      return;
    }
    if (!email || !pw || emailBad || pwBad) { setErr("Please fix the highlighted fields."); return; }
    setBusy(true); setErr("");
    try { const r = await login(email, pw); const role = r?.user?.role;
      nav(role === 'admin' || role === 'superadmin' ? '/admin' : '/dashboard');
      if (role === 'admin' || role === 'superadmin') sessionStorage.setItem('slt_admin_welcome', '1');
    }
    catch (er) { setErr(er.message || "Login failed"); }
    finally { setBusy(false); }
  };
  return <Section><Container><Card className="mx-auto max-w-md bg-white/[0.02] backdrop-blur-xl">
    <h1 className="text-xl font-semibold">Welcome back</h1>
    {linkSent ? (
      <div className="mt-5 flex flex-col gap-3">
        <p className="text-sm text-white/70">Sign-in link sent to <span className="text-white">{email}</span>. Open it on this device to finish signing in.</p>
        <Button variant="secondary" className="w-full" type="button" onClick={() => { setLinkSent(false); setLinkMode(false); }}>Back to password login</Button>
      </div>
    ) : (
    <form className="mt-5 flex flex-col gap-4" onSubmit={submit}>
      <FormField label="Email" error={emailBad ? "Enter a valid email." : ""}><Input aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@desk.com" /></FormField>
      {!linkMode && (
      <FormField label="Password" error={pwBad ? "Minimum 6 characters." : ""}><Input aria-label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" /></FormField>
      )}
      {err && <p className="text-xs text-red-400" role="alert">{err}</p>}
      <Button className="w-full" loading={busy}>{busy ? <><ButtonLoader /> {linkMode ? "Sending…" : "Signing in…"} </> : (linkMode ? "Email me a sign-in link" : "Log in")}</Button>
      {!linkMode && (
      <Button variant="secondary" className="w-full" type="button" onClick={async () => { try { await googleSuccess({}); nav("/dashboard"); } catch (er) { setErr(er.message); } }}>Continue with Google</Button>
      )}
      <button type="button" onClick={() => { setLinkMode((m) => !m); setErr(""); }} className="text-xs text-blue-400">{linkMode ? "Use password instead" : "Or continue with email link"}</button>
      <p className="text-center text-xs text-white/50"><Link to="/forgot-password" className="text-blue-400">Forgot password?</Link> · <Link to="/register" className="text-blue-400">Create account</Link></p>
    </form>
    )}
  </Card></Container></Section>;
}

export function Register() {
  const nav = useNavigate();
  const { register, googleSuccess } = useAuth();
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [pw, setPw] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const bad = !name || !email || !emailOK(email) || pw.length < 6;
  const submit = async (e) => {
    e.preventDefault();
    if (bad) { setErr("Please fix the highlighted fields."); return; }
    setBusy(true); setErr("");
    // No OTP step: the backend activates the account and returns a session.
    try { await register(name, email, pw); nav("/dashboard"); }
    catch (er) { setErr(er.message || "Registration failed"); }
    finally { setBusy(false); }
  };
  return <Section><Container><Card className="mx-auto max-w-md bg-white/[0.02] backdrop-blur-xl">
    <h1 className="text-xl font-semibold">Create your account</h1>
    <form className="mt-5 flex flex-col gap-4" onSubmit={submit}>
      <FormField label="Name"><Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Trader" /></FormField>
      <FormField label="Email"><Input aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@desk.com" /></FormField>
      <FormField label="Password" error={pw && pw.length < 6 ? "Minimum 6 characters." : ""}><Input aria-label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" /></FormField>
      {err && <p className="text-xs text-red-400" role="alert">{err}</p>}
      <Button className="w-full" loading={busy}>{busy ? <><ButtonLoader /> Creating…</> : "Create account"}</Button>
      <Button variant="secondary" className="w-full" type="button" onClick={async () => { try { await googleSuccess({ email, name }); nav("/dashboard"); } catch (er) { setErr(er.message); } }}>Continue with Google</Button>
      <p className="text-center text-xs text-white/50"><Link to="/login" className="text-blue-400">Have an account? Log in</Link></p>
    </form>
  </Card></Container></Section>;
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle");
  const [err, setErr] = useState("");
  return <Section><Container><Card className="mx-auto max-w-md bg-white/[0.02] backdrop-blur-xl">
    <h1 className="text-xl font-semibold">Reset password</h1>
    <form className="mt-5 flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); setStatus("loading"); setErr(""); try { await api.post("/auth/forgot-password", { email }); setStatus("success"); } catch (er) { if (er?.status === 0) setStatus("success"); else { setErr(er.message); setStatus("idle"); } } }}>
      <FormField label="Email"><Input aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@desk.com" /></FormField>
      {status === "success" && <p className="text-xs text-green-400">If the email exists, a reset link was sent.</p>}
      {err && <p className="text-xs text-red-400" role="alert">{err}</p>}
      <Button className="w-full" loading={status === "loading"}>{status === "loading" ? "Sending…" : "Send reset link"}</Button>
      <p className="text-center text-xs text-white/50"><Link to="/login" className="text-blue-400">Back to log in</Link></p>
    </form>
  </Card></Container></Section>;
}
