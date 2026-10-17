import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Camera, ShieldCheck, BadgeCheck, Pencil, Settings as SettingsIcon, KeyRound, Trash2, Download, LogOut, Check, Crown } from "lucide-react";
import { useAuth } from "../context/useAuth.js";
import { api } from "../lib/api.js";
import { profileApi, resolveAvatar } from "../lib/profile.js";
import { formatLimit } from "../lib/plans.js";
import { Card, Button, Badge, Input, FormField, EmptyState } from "../components/ui.jsx";
import { SkeletonLoader } from "../components/Loaders.jsx";

// Frozen at module load so render stays pure (React Compiler purity rule).
const ACCOUNT_PAGE_LOAD = Date.now();

// Solo-Leveling rank shown on the profile, keyed by the subscription slug.
const RANKS = [["FREE", "E-Rank Hunter"], ["STARTER", "D-Rank Hunter"], ["PRO", "C-Rank Hunter"], ["ELITE", "S-Rank Hunter"], ["ULTIMATE", "Shadow Monarch"]];
const rankFor = (plan, role) => role === "admin" ? "Monarch" : (RANKS.find(([p]) => p === String(plan).toUpperCase())?.[1] || "E-Rank Hunter");
const anim = (rm) => rm ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } };
const stagger = (rm, i) => rm ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { delay: i * 0.06 } };

function Toast({ toast }) {
  if (!toast) return null;
  return <div role="status" aria-live="polite" className={`fixed bottom-5 left-1/2 z-[100] -translate-x-1/2 rounded-full border px-4 py-2 text-sm backdrop-blur-xl ${toast.ok ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200" : "border-red-500/40 bg-red-500/15 text-red-200"}`}>{toast.msg}</div>;
}

function Avatar({ user, onChange, notify }) {
  const [preview, setPreview] = useState(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const src = preview || resolveAvatar(user?.avatar);
  const initials = (user?.name || user?.email || "?").slice(0, 2).toUpperCase();
  const pick = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (!/image\/(png|jpeg|webp)/.test(f.type)) return notify("Only PNG/JPEG/WebP allowed", false);
    if (f.size > 2 * 1024 * 1024) return notify("Max 2MB", false);
    setPreview(URL.createObjectURL(f)); upload(f);
  };
  const upload = async (f) => {
    setBusy(true); setProgress(0);
    try { const d = await profileApi.uploadAvatar(f, setProgress); onChange(d?.user || {}); notify("Avatar updated"); }
    catch { notify("Backend offline — preview only", false); }
    finally { setBusy(false); setPreview(null); setProgress(0); }
  };
  const remove = async () => { try { const d = await profileApi.deleteAvatar(); onChange({ ...user, avatar: null, ...(d?.user || {}) }); notify("Avatar removed"); } catch { onChange({ ...user, avatar: null }); } };
  return (
    <div className="group relative">
      <div className="h-24 w-24 overflow-hidden rounded-2xl border border-violet-500/40 bg-gradient-to-br from-violet-600/40 to-cyan-500/30 shadow-[0_0_30px_-5px_rgba(139,92,246,.5)] sm:h-28 sm:w-28">
        {src ? <img src={src} alt="Profile avatar" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-white">{initials}</div>}
      </div>
      <button onClick={() => input.current?.click()} aria-label="Upload profile picture" className="absolute -bottom-2 -right-2 rounded-full border border-white/15 bg-black p-2 text-white/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><Camera size={14} /></button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pick} aria-label="Choose profile picture" />
      {busy && <div className="mt-2 h-1 w-24 overflow-hidden rounded bg-white/10"><div className="h-full bg-gradient-to-r from-violet-500 to-cyan-400" style={{ width: `${progress}%` }} /></div>}
      {user?.avatar && !busy && <button onClick={remove} className="mt-2 text-xs text-white/40 hover:text-red-300">Remove</button>}
    </div>
  );
}

function EditForm({ user, onChange, notify }) {
  const [f, setF] = useState({ firstName: user?.firstName || "", lastName: user?.lastName || "", username: user?.username || "", phone: user?.phone || "", country: user?.country || "", timezone: user?.timezone || "", bio: user?.bio || "" });
  const [errs, setErrs] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { const h = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [dirty]);
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setDirty(true); };
  const save = async (e) => {
    e.preventDefault(); const er = {};
    if (f.username && (f.username.length < 3 || f.username.length > 30)) er.username = "3–30 characters";
    if (f.bio && f.bio.length > 500) er.bio = "Max 500 characters";
    setErrs(er); if (Object.keys(er).length) return;
    setSaving(true);
    try { const d = await profileApi.update(f); onChange(d?.user || f); setDirty(false); notify("Profile updated"); }
    catch (err) { if (err?.status === 0) { onChange({ ...user, ...f }); notify("Backend offline — saved locally", false); } else notify(err?.message || "Update failed", false); }
    finally { setSaving(false); }
  };
  const fields = [["firstName", "First name"], ["lastName", "Last name"], ["username", "Username"], ["phone", "Phone"], ["country", "Country"], ["timezone", "Timezone"]];
  return (
    <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
      {fields.map(([k, l]) => <FormField key={k} label={l} error={errs[k]}><Input aria-label={l} value={f[k]} onChange={(e) => set(k, e.target.value)} /></FormField>)}
      <FormField label="Bio" error={errs.bio} className="sm:col-span-2"><textarea aria-label="Bio" rows={3} value={f.bio} onChange={(e) => set("bio", e.target.value)} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" /></FormField>
      <div className="flex gap-2 sm:col-span-2">
        <Button disabled={saving || !dirty}>{saving ? "Saving…" : "Save changes"}</Button>
        <Button type="button" variant="secondary" onClick={() => { setDirty(false); notify("Changes discarded"); }}>Cancel</Button>
      </div>
      {dirty && <p className="text-xs text-amber-300 sm:col-span-2">You have unsaved changes.</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Subscription & benefits card. Shows the plan the user actually holds, the
// renewal date, the metered allowances and the full feature list — this is what
// appears in the profile once a purchase is fulfilled.
// ---------------------------------------------------------------------------
function SubscriptionCard({ sub, plan }) {
  const active = sub?.status === "active";
  const expires = sub?.expiresAt ? new Date(sub.expiresAt) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires.getTime() - ACCOUNT_PAGE_LOAD) / 864e5)) : null;
  const limits = plan?.limits || {};
  const meters = [
    ["AI assistant", limits.aiLimit, "messages / mo"],
    ["Watchlist", limits.watchlists, "symbols"],
    ["Price alerts", limits.alerts, "alerts"],
  ];

  return (
    <Card className="bg-white/[0.02] backdrop-blur-xl sm:col-span-2 lg:col-span-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-600/40 to-cyan-500/20 text-violet-200">
          <Crown size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-widest text-white/40">Your subscription</p>
          <p className="text-lg font-semibold text-white">
            {plan?.name || "Free"}
            {plan?.priceCents ? <span className="ml-2 text-xs font-normal text-white/50">${(plan.priceCents / 100).toLocaleString()}/mo</span> : null}
          </p>
        </div>
        <div className="ml-auto text-right">
          <Badge tone={active ? "success" : "default"}>{active ? "Active" : (sub?.status || "Free tier")}</Badge>
          {expires && (
            <p className="mt-1 text-xs text-white/50">
              {active ? "Renews" : "Ended"} {expires.toLocaleDateString()}
              {active && daysLeft !== null ? ` · ${daysLeft}d left` : ""}
            </p>
          )}
        </div>
      </div>

      {/* Metered allowances — the numbers the backend actually enforces. */}
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {meters.map(([label, val, unit]) => (
          <div key={label} className="rounded-lg border border-white/10 px-3 py-2">
            <p className="text-[11px] uppercase tracking-widest text-white/40">{label}</p>
            <p className="mt-0.5 text-sm font-semibold text-white">{formatLimit(val)}</p>
            <p className="text-[11px] text-white/40">{val === -1 ? "no ceiling" : unit}</p>
          </div>
        ))}
      </div>

      {plan?.features?.length ? (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {plan.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-xs leading-relaxed text-white/70">
              <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {!active && <Button size="sm" to="/pricing">Upgrade plan</Button>}
        {active && <Button size="sm" variant="secondary" to="/subscription">Manage subscription</Button>}
        <Button size="sm" variant="ghost" to="/purchases">Payment history</Button>
      </div>
    </Card>
  );
}

export default function Account() {
  const { user, setUser, logout } = useAuth();
  const rm = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get("tab") || "overview");
  const switchTab = (t) => { setTab(t); setParams(t === "overview" ? {} : { tab: t }, { replace: true }); };
  const [toast, setToast] = useState(null);
  const [sub, setSub] = useState(null);
  const [subPlan, setSubPlan] = useState(null);
  const [purchases, setPurchases] = useState(null);
  const [activity, setActivity] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [prefs, setPrefs] = useState(user?.preferences || { emailNotifications: true, tradeAlerts: true, priceAlerts: true, marketingEmails: false });
  const [ppage, setPpage] = useState(1);
  const notify = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000); };
  const applyUser = (u) => setUser({ ...user, ...u });

  useEffect(() => {
    profileApi.subscription().then((d) => { setSub(d?.subscription || null); setSubPlan(d?.plan || null); }).catch(() => { setSub(null); setSubPlan(null); });
    profileApi.activity().then((d) => setActivity(d?.items || [])).catch(() => setActivity([]));
    api.get("/users/me/sessions").then((d) => setSessions(d?.sessions || d?.items || [])).catch(() => setSessions([]));
  }, []);
  useEffect(() => {
    setPurchases(null);
    profileApi.purchases(ppage).then((d) => setPurchases(d?.items || [])).catch(() => setPurchases([]));
  }, [ppage]);

  const name = user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Hunter";
  const completion = ["firstName", "username", "phone", "bio", "avatar", "country"].filter((k) => user?.[k]).length / 6 * 100;
  const tabs = [["overview", "Overview"], ["edit", "Edit Profile"], ["security", "Security"], ["purchases", "Purchases"], ["activity", "Activity"], ["settings", "Settings"]];

  const changePassword = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api.post("/auth/change-password", { currentPassword: fd.get("cur"), newPassword: fd.get("next") }); notify("Password changed"); e.target.reset(); }
    catch (err) { notify(err?.message || "Failed", false); }
  };
  const resend = async () => { try { await api.post("/auth/resend-otp", { email: user?.email }); notify("Verification sent"); } catch (e) { notify(e?.message || "Failed", false); } };
  const exportData = async () => {
    try { const d = await profileApi.exportData(); const blob = new Blob([JSON.stringify(d?.export || d, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "sololevelingtrad-data.json"; a.click(); notify("Data exported"); }
    catch { notify("Export failed", false); }
  };
  const del = async () => { if (!confirm("Delete your account? This deactivates it and cannot be undone.")) return; try { await api.del("/users/me"); } catch {} await logout(); window.location.href = "/"; };
  const savePrefs = async () => { try { const d = await profileApi.prefs(prefs); applyUser(d?.user || {}); notify("Preferences saved"); } catch { applyUser({ preferences: prefs }); notify("Saved locally (offline)", false); } };

  return (
    <div>
      <Toast toast={toast} />
      <div>
        <motion.div {...anim(rm)} className="relative overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-br from-[#0b0716] via-[#14102a] to-[#06202b] p-5 sm:p-8">
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-violet-600/25 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-cyan-500/15 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
            <Avatar user={user} onChange={applyUser} notify={notify} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold text-white sm:text-2xl">{name}</h1>
                <Badge tone={user?.emailVerified ? "success" : "warning"}><BadgeCheck size={12} /> {user?.emailVerified ? "Verified" : "Unverified"}</Badge>
                <Badge tone="accent">{rankFor(user?.plan, user?.role)}</Badge>
                <Badge>{user?.role || "user"}</Badge>
                <Badge tone={user?.status === "suspended" ? "danger" : "success"}>{user?.status || "active"}</Badge>
              </div>
              <p className="mt-1 truncate text-sm text-white/60">{user?.email} · Joined {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</p>
              <div className="mt-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(completion)} aria-label="Profile completion">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 via-blue-500 to-cyan-400" style={{ width: `${completion}%` }} />
              </div>
              <p className="mt-1 text-xs text-white/50">{Math.round(completion)}% complete</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => switchTab("edit")}><Pencil size={14} /> Edit Profile</Button>
              <Button size="sm" variant="secondary" onClick={() => switchTab("settings")}><SettingsIcon size={14} /> Settings</Button>
              <Button size="sm" variant="secondary" onClick={() => switchTab("security")}><KeyRound size={14} /> Password</Button>
            </div>
          </div>
        </motion.div>

        <div role="tablist" aria-label="Profile sections" className="mt-4 flex gap-1 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02] p-1 backdrop-blur-xl">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => switchTab(id)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${tab === id ? "bg-white text-black" : "text-white/60 hover:text-white"}`}>{label}</button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "overview" && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[["Purchases", purchases?.length ?? "—", "Verified backend orders"], ["Plan", subPlan?.name || user?.plan || "FREE", sub?.status || "No active subscription"], ["Rank", rankFor(subPlan?.plan || user?.plan, user?.role), "Solo Leveling tier"], ["Member since", user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—", user?.email]].map(([t, v, s], i) => (
                <motion.div key={t} {...stagger(rm, i)}><Card className="bg-white/[0.02] backdrop-blur-xl"><p className="text-xs uppercase tracking-widest text-white/40">{t}</p><p className="mt-1 text-lg font-semibold text-white">{String(v)}</p><p className="mt-1 truncate text-xs text-white/50">{String(s)}</p></Card></motion.div>
              ))}
              <SubscriptionCard sub={sub} plan={subPlan} />
              <Card className="bg-white/[0.02] backdrop-blur-xl sm:col-span-2 lg:col-span-4">
                <h2 className="text-sm font-medium text-white">Recent purchases</h2>
                {purchases === null ? <div className="mt-3"><SkeletonLoader rows={2} /></div> : purchases.length === 0 ? <div className="mt-2"><EmptyState title="No purchases yet" desc="Your verified orders will appear here." /></div> :
                  <ul className="mt-2 space-y-2">{purchases.slice(0, 3).map((p, i) => <li key={p._id || p.id || i} className="flex justify-between rounded-lg border border-white/10 px-3 py-2 text-xs text-white/70"><span>{p.plan || p.product || "Order"}</span><span>{p.amount} · {p.status}</span></li>)}</ul>}
              </Card>
            </div>
          )}

          {tab === "edit" && <Card className="bg-white/[0.02] backdrop-blur-xl"><h2 className="mb-3 text-sm font-medium text-white">Edit profile</h2><EditForm user={user} onChange={applyUser} notify={notify} /></Card>}

          {tab === "security" && (
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="bg-white/[0.02] backdrop-blur-xl">
                <h2 className="text-sm font-medium text-white">Change password</h2>
                <form onSubmit={changePassword} className="mt-3 grid gap-3">
                  <FormField label="Current password"><Input name="cur" type="password" required autoComplete="current-password" /></FormField>
                  <FormField label="New password (min 8 chars)"><Input name="next" type="password" required minLength={8} autoComplete="new-password" /></FormField>
                  <Button className="w-fit">Update password</Button>
                </form>
              </Card>
              <Card className="bg-white/[0.02] backdrop-blur-xl">
                <h2 className="text-sm font-medium text-white">Email & sessions</h2>
                <p className="mt-2 text-xs text-white/60">Status: {user?.emailVerified ? "verified" : "unverified"}</p>
                {!user?.emailVerified && <Button size="sm" variant="secondary" className="mt-2" onClick={resend}>Resend verification</Button>}
                <h3 className="mt-4 text-xs font-medium text-white/70">Active sessions</h3>
                {sessions === null ? <div className="mt-2"><SkeletonLoader rows={2} /></div> : sessions.length === 0 ? <p className="mt-2 text-xs text-white/50">No other sessions.</p> :
                  <ul className="mt-2 space-y-1">{sessions.map((s, i) => <li key={s._id || i} className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-xs text-white/60"><span>{s.device || s.userAgent || "Session"}</span><button className="text-red-300 hover:text-red-200" onClick={async () => { try { await api.del(`/users/me/sessions/${s._id || s.id}`); setSessions((p) => p.filter((_, j) => j !== i)); notify("Session revoked"); } catch { notify("Failed", false); } }}>Revoke</button></li>)}</ul>}
                <Button size="sm" variant="secondary" className="mt-3" onClick={async () => { try { await api.post("/auth/logout-all", {}); } catch {} await logout(); }}><LogOut size={14} /> Log out everywhere</Button>
              </Card>
            </div>
          )}

          {tab === "purchases" && (
            <Card className="bg-white/[0.02] backdrop-blur-xl">
              <h2 className="text-sm font-medium text-white">Purchase history {sub && <span className="ml-2 text-xs text-white/50">{sub.plan} · {sub.status}{sub.expiresAt ? ` · renews ${new Date(sub.expiresAt).toLocaleDateString()}` : ""}</span>}</h2>
              {purchases === null ? <div className="mt-3"><SkeletonLoader rows={3} /></div> : purchases.length === 0 ? <div className="mt-2"><EmptyState title="No purchases yet" desc="Verified orders from the backend will appear here." /></div> :
                <ul className="mt-3 space-y-2">{purchases.map((p, i) => <li key={p._id || i} className="grid gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/70 sm:grid-cols-4"><span className="font-mono">{String(p._id || p.id || "").slice(-8) || "—"}</span><span>{p.plan || p.product || "Order"} · {new Date(p.createdAt).toLocaleString()}</span><span>{p.amount} {p.currency || ""}</span><span><Badge tone={p.status === "paid" || p.status === "completed" ? "success" : "warning"}>{p.status}</Badge></span></li>)}</ul>}
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={ppage <= 1} onClick={() => setPpage((p) => p - 1)}>Prev</Button>
                <span className="text-xs text-white/50">Page {ppage}</span>
                <Button size="sm" variant="secondary" onClick={() => setPpage((p) => p + 1)}>Next</Button>
              </div>
            </Card>
          )}

          {tab === "activity" && (
            <Card className="bg-white/[0.02] backdrop-blur-xl">
              <h2 className="text-sm font-medium text-white">Account activity</h2>
              {activity === null ? <div className="mt-3"><SkeletonLoader rows={3} /></div> : activity.length === 0 ? <div className="mt-2"><EmptyState title="No activity yet" desc="Security events like profile updates and purchases are logged here." /></div> :
                <ol className="mt-3 space-y-2">{activity.map((a, i) => <motion.li key={a._id || i} {...stagger(rm, Math.min(i, 5))} className="flex gap-3 rounded-lg border border-white/10 px-3 py-2 text-xs"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-violet-300" /><div><p className="text-white/80">{a.action}</p><p className="text-white/40">{new Date(a.createdAt).toLocaleString()}</p></div></motion.li>)}</ol>}
            </Card>
          )}

          {tab === "settings" && (
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="bg-white/[0.02] backdrop-blur-xl">
                <h2 className="text-sm font-medium text-white">Notifications</h2>
                {[["emailNotifications", "Email notifications"], ["tradeAlerts", "Trade alerts"], ["priceAlerts", "Price alerts"], ["marketingEmails", "Marketing emails"]].map(([k, l]) => (
                  <label key={k} className="mt-2 flex cursor-pointer items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-sm text-white/75">
                    {l}<input type="checkbox" checked={!!prefs[k]} onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.checked }))} aria-label={l} className="h-4 w-4 accent-violet-500" />
                  </label>
                ))}
                <Button size="sm" className="mt-3" onClick={savePrefs}><Check size={14} /> Save preferences</Button>
              </Card>
              <Card className="border-red-500/30 bg-white/[0.02] backdrop-blur-xl">
                <h2 className="text-sm font-medium text-red-300">Privacy & data</h2>
                <p className="mt-2 text-xs text-white/55">Export a copy of your profile, orders, and activity. Deleting deactivates your account; associated orders are retained for records.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={exportData}><Download size={14} /> Export data</Button>
                  <Button size="sm" variant="danger" onClick={del}><Trash2 size={14} /> Delete account</Button>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
