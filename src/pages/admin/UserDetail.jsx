import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Ban, CheckCircle2, KeyRound, LogIn, Mail, Phone,
  ShieldCheck, Trash2, UserCog, Video, MessageSquare, Paperclip,
} from "lucide-react";
import { adminApi } from "../../lib/admin.js";
import { useAuth } from "../../context/useAuth.js";
import { Badge, Button, Panel, Input, FormField, Segmented } from "../../components/ui.jsx";
import { ConfirmDialog, DataTable, PageHeader, QueryState, RefreshButton, StatusPill } from "../../components/admin/primitives.jsx";
import { fmtDate, fmtMoney, fmtNum } from "../../components/admin/format.js";

const roleTone = (role) => (role === "superadmin" ? "violet" : role === "admin" ? "accent" : role === "support" ? "warning" : "default");

const TABS = [
  { value: "profile", label: "Profile" },
  { value: "subscription", label: "Subscription" },
  { value: "payments", label: "Payments" },
  { value: "purchases", label: "Purchases" },
  { value: "sessions", label: "Sessions" },
  { value: "activity", label: "Activity" },
  { value: "security", label: "Login history" },
];

export default function AdminUserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("profile");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  // Confirmation dialogs: { kind, title, desc, confirmLabel, requireReason, run }
  const [dialog, setDialog] = useState(null);
  const [reason, setReason] = useState("");

  // Editable profile fields
  const [edit, setEdit] = useState(null);

  const flash = (msg, ok = true) => setToast({ msg, ok });
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const load = useCallback(() => {
    setLoading(true); setErr("");
    adminApi.user(id)
      .then((d) => { setData(d); setEdit({ firstName: d?.user?.firstName || "", lastName: d?.user?.lastName || "", username: d?.user?.username || "", phone: d?.user?.phone || "", bio: d?.user?.bio || "" }); })
      .catch((e) => setErr(e?.message || "Failed to load this user"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const u = data?.user;

  const runDialog = async () => {
    if (!dialog) return;
    setBusy(true);
    try {
      await dialog.run(reason);
      flash(dialog.successMsg || "Done");
      setDialog(null); setReason("");
      load();
    } catch (e) {
      flash(e?.message || "Action failed", false);
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    try {
      await adminApi.updateUser(id, edit);
      flash("Profile updated");
      load();
    } catch (e) { flash(e?.message || "Update failed", false); } finally { setBusy(false); }
  };

  const inviteCall = async () => {
    setBusy(true);
    try {
      const d = await adminApi.callInvite(id, "video");
      flash(d?.message || "Call invitation sent — check Calls & Live for status");
    } catch (e) { flash(e?.message || "Could not start a call", false); } finally { setBusy(false); }
  };

  const sendMessage = async () => {
    const content = window.prompt("Message to this user (delivered to their community inbox):");
    if (!content) return;
    setBusy(true);
    try {
      await adminApi.sendMessage({ userId: id, content });
      flash("Message sent");
    } catch (e) { flash(e?.message || "Send failed", false); } finally { setBusy(false); }
  };

  if (loading && !data) {
    return <QueryState loading error={err} onRetry={load} rows={6} />;
  }
  if (err && !data) return <QueryState error={err} onRetry={load} />;
  if (!u) return <QueryState error="User not found" onRetry={() => navigate("/admin/users")} />;

  const sub = data?.subscription;
  const canManage = me?.role === "superadmin" || me?.role === "admin";

  return (
    <div>
      <PageHeader
        title={u.firstName ? `${u.firstName} ${u.lastName || ""}`.trim() : u.email}
        desc={u.email}
        badge={<Badge tone={roleTone(u.role)}>{u.role}</Badge>}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate("/admin/users")}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <RefreshButton onClick={load} loading={loading} />
          </>
        }
      />

      {/* Header card */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Account">
          <div className="flex flex-wrap items-start gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400/80 to-violet-500/80 text-lg font-bold text-black">
              {(u.firstName || u.email || "?").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1 space-y-1 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <StatusPill status={u.status} />
                <Badge tone={u.emailVerified ? "success" : "warning"}>{u.emailVerified ? "verified" : "unverified"}</Badge>
                <Badge>{u.plan || "FREE"}</Badge>
                <Badge tone="default">{u.authProvider || "email"}</Badge>
              </p>
              <p className="text-white/60"><Mail className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />{u.email}</p>
              {u.phone && <p className="text-white/60"><Phone className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />{u.phone}</p>}
              <p className="text-xs text-white/40">Joined {fmtDate(u.createdAt, { time: false })} · Last active {fmtDate(u.lastActiveAt)}</p>
              {u.bio && <p className="pt-1 text-xs text-white/50">{u.bio}</p>}
            </div>
          </div>
        </Panel>

        <Panel title="Actions" desc="Every action is confirmed and audited">
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" onClick={inviteCall} disabled={busy}>
                <Video className="h-3.5 w-3.5" /> Call
              </Button>
              <Button variant="secondary" size="sm" onClick={sendMessage} disabled={busy}>
                <MessageSquare className="h-3.5 w-3.5" /> Message
              </Button>
              <Button
                variant="secondary" size="sm" disabled={busy}
                onClick={() => setDialog({
                  title: "Revoke all sessions",
                  desc: "Signs this user out of every device. They can log in again.",
                  confirmLabel: "Revoke sessions", successMsg: "Sessions revoked",
                  run: () => adminApi.action(id, "revoke"),
                })}
              >
                <KeyRound className="h-3.5 w-3.5" /> Revoke sessions
              </Button>
              <Button
                variant="secondary" size="sm" disabled={busy}
                onClick={() => setDialog({
                  title: "Extend subscription",
                  desc: "Adds 30 days to the active subscription period.",
                  confirmLabel: "Extend 30 days", successMsg: "Subscription extended",
                  run: () => adminApi.action(id, "extend", { days: 30 }),
                })}
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Extend sub
              </Button>
            </div>

            {canManage && (
              <>
                <div className="my-1 h-px bg-white/[0.07]" />
                <div className="grid grid-cols-2 gap-2">
                  {u.status === "active" ? (
                    <Button
                      variant="secondary" size="sm" disabled={busy}
                      onClick={() => { setReason(""); setDialog({
                        title: "Suspend user",
                        desc: "Blocks sign-in and usage until reactivated. Sessions stay valid.",
                        confirmLabel: "Suspend", requireReason: true,
                        successMsg: "User suspended",
                        run: (r) => adminApi.moderate(id, "suspended", r),
                      }); }}
                    >
                      <Ban className="h-3.5 w-3.5" /> Suspend
                    </Button>
                  ) : (
                    <Button
                      variant="secondary" size="sm" disabled={busy}
                      onClick={() => setDialog({
                        title: "Reactivate user",
                        desc: "Restores normal access.",
                        confirmLabel: "Reactivate", successMsg: "User reactivated",
                        run: () => adminApi.moderate(id, "active", ""),
                      })}
                    >
                      <LogIn className="h-3.5 w-3.5" /> Activate
                    </Button>
                  )}
                  <Button
                    variant="danger" size="sm" disabled={busy}
                    onClick={() => { setReason(""); setDialog({
                      title: "Ban user",
                      desc: "Immediately blocks the account and revokes all sessions.",
                      confirmLabel: "Ban user", requireReason: true,
                      successMsg: "User banned",
                      run: (r) => adminApi.moderate(id, "banned", r),
                    }); }}
                  >
                    <Ban className="h-3.5 w-3.5" /> Ban
                  </Button>
                </div>

                <div className="my-1 h-px bg-white/[0.07]" />
                <FormField label="Role">
                  <select
                    value={u.role}
                    disabled={busy}
                    onChange={(e) => {
                      const role = e.target.value;
                      setReason(""); setDialog({
                        title: `Change role to ${role}`,
                        desc: "Role changes take effect on the user's next request.",
                        confirmLabel: "Change role", requireReason: true,
                        successMsg: `Role set to ${role}`,
                        run: (r) => adminApi.setRole(id, role).then(() => adminApi.action(id, "role", { role, reason: r })),
                      });
                    }}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                  >
                    {["user", "support", "analyst", "finance", "admin", "superadmin"].map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </FormField>

                {me?.role === "superadmin" && (
                  <Button
                    variant="danger" size="sm" disabled={busy}
                    onClick={() => { setReason(""); setDialog({
                      title: "Anonymize user",
                      desc: "Irreversibly removes personal data (email, name, avatar) and revokes sessions. Financial records are preserved for accounting.",
                      confirmLabel: "Anonymize", requireReason: true,
                      successMsg: "User anonymized",
                      run: (r) => adminApi.action(id, "delete", { reason: r }),
                    }); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Anonymize
                  </Button>
                )}
              </>
            )}
            {!canManage && (
              <p className="flex items-center gap-1.5 text-[11px] text-white/40">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Your role has read-only access to user records.
              </p>
            )}
          </div>
        </Panel>
      </div>

      {/* Tabs */}
      <Segmented items={TABS} value={tab} onChange={setTab} ariaLabel="User detail sections" className="mb-4" />

      {tab === "profile" && (
        <Panel title="Edit profile" desc="Whitelisted fields only — role, status and plan are managed elsewhere">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="First name"><Input value={edit?.firstName || ""} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></FormField>
            <FormField label="Last name"><Input value={edit?.lastName || ""} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></FormField>
            <FormField label="Username"><Input value={edit?.username || ""} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></FormField>
            <FormField label="Phone"><Input value={edit?.phone || ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></FormField>
            <FormField label="Bio" className="sm:col-span-2">
              <textarea
                value={edit?.bio || ""} onChange={(e) => setEdit({ ...edit, bio: e.target.value })} rows={3}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
              />
            </FormField>
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={saveProfile} disabled={busy} loading={busy}>Save changes</Button>
            <Button variant="ghost" size="sm" onClick={load} disabled={busy}>Reset</Button>
          </div>
        </Panel>
      )}

      {tab === "subscription" && (
        <Panel title="Subscription">
          {sub ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-white/45">Plan</dt><dd className="mt-0.5 text-white">{sub.plan}</dd></div>
              <div><dt className="text-xs text-white/45">Status</dt><dd className="mt-0.5"><StatusPill status={sub.status} /></dd></div>
              <div><dt className="text-xs text-white/45">Started</dt><dd className="mt-0.5 text-white/75">{fmtDate(sub.startedAt, { time: false })}</dd></div>
              <div><dt className="text-xs text-white/45">Expires</dt><dd className="mt-0.5 text-white/75">{fmtDate(sub.expiresAt, { time: false })}</dd></div>
            </dl>
          ) : (
            <div className="space-y-2 text-sm text-white/50">
              <p>No active subscription record.</p>
              <p className="text-xs text-white/35">Current plan on the account: <span className="text-white/60">{u.plan || "FREE"}</span> · subscription status: <span className="text-white/60">{u.subscriptionStatus || "none"}</span></p>
            </div>
          )}
        </Panel>
      )}

      {tab === "payments" && (
        <Panel title="Payments" desc="Real provider transactions">
          <DataTable
            columns={[
              { key: "amount", header: "Amount", render: (p) => <span className="num text-white">{fmtMoney(p.amount, p.currency)}</span> },
              { key: "plan", header: "Plan", render: (p) => <span className="text-xs text-white/70">{p.plan || "—"}</span> },
              { key: "provider", header: "Provider", render: (p) => <Badge>{p.provider}</Badge> },
              { key: "status", header: "Status", render: (p) => <StatusPill status={p.status} /> },
              { key: "providerPaymentId", header: "Provider id", render: (p) => <span className="num text-xs text-white/40">{p.providerPaymentId || "—"}</span> },
              { key: "createdAt", header: "Date", render: (p) => <span className="text-xs text-white/45">{fmtDate(p.createdAt)}</span> },
            ]}
            rows={data?.payments || []} rowKey="_id"
          />
          {(data?.payments || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No payments recorded.</p>}
        </Panel>
      )}

      {tab === "purchases" && (
        <Panel title="Purchases" desc="Order history">
          <DataTable
            columns={[
              { key: "orderId", header: "Order", render: (p) => <span className="num text-xs text-white/70">{p.orderId}</span> },
              { key: "plan", header: "Plan", render: (p) => <span className="text-xs text-white/70">{p.plan || "—"}</span> },
              { key: "amount", header: "Amount", render: (p) => <span className="num text-white">{fmtMoney(p.amount, p.currency)}</span> },
              { key: "status", header: "Status", render: (p) => <StatusPill status={p.status} /> },
              { key: "createdAt", header: "Date", render: (p) => <span className="text-xs text-white/45">{fmtDate(p.createdAt)}</span> },
            ]}
            rows={data?.purchases || []} rowKey="_id"
          />
          {(data?.purchases || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No purchases.</p>}
        </Panel>
      )}

      {tab === "sessions" && (
        <Panel title="Active sessions" desc="Refresh-token sessions for this account">
          <DataTable
            columns={[
              { key: "device", header: "Device", render: (s) => <span className="text-sm text-white/80">{s.device || "unknown"}</span> },
              { key: "ipAddress", header: "IP", render: (s) => <span className="num text-xs text-white/50">{s.ipAddress || "—"}</span> },
              { key: "revoked", header: "State", render: (s) => (s.revoked ? <Badge tone="danger">revoked</Badge> : <Badge tone="success">active</Badge>) },
              { key: "createdAt", header: "Created", render: (s) => <span className="text-xs text-white/45">{fmtDate(s.createdAt)}</span> },
              { key: "expiresAt", header: "Expires", render: (s) => <span className="text-xs text-white/45">{fmtDate(s.expiresAt)}</span> },
            ]}
            rows={data?.sessions || []} rowKey="_id"
          />
          {(data?.sessions || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No sessions.</p>}
        </Panel>
      )}

      {tab === "activity" && (
        <Panel title="Activity log" desc="Most recent events for this user">
          <DataTable
            columns={[
              { key: "action", header: "Action", render: (a) => <span className="text-sm text-white/80">{a.action}</span> },
              { key: "meta", header: "Detail", render: (a) => <span className="truncate text-xs text-white/45">{a.meta ? JSON.stringify(a.meta).slice(0, 80) : "—"}</span> },
              { key: "ip", header: "IP", render: (a) => <span className="num text-xs text-white/40">{a.ip || "—"}</span> },
              { key: "createdAt", header: "When", render: (a) => <span className="text-xs text-white/45">{fmtDate(a.createdAt)}</span> },
            ]}
            rows={data?.activity || []} rowKey="_id"
          />
          {(data?.activity || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No activity recorded.</p>}
        </Panel>
      )}

      {tab === "security" && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Panel title="Login history" desc="Success and failed sign-in attempts">
            <DataTable
              columns={[
                { key: "success", header: "Result", render: (l) => (l.success ? <Badge tone="success">success</Badge> : <Badge tone="danger">failed</Badge>) },
                { key: "ip", header: "IP", render: (l) => <span className="num text-xs text-white/50">{l.ip || "—"}</span> },
                { key: "createdAt", header: "When", render: (l) => <span className="text-xs text-white/45">{fmtDate(l.createdAt)}</span> },
              ]}
              rows={data?.loginHistory || []} rowKey="_id"
            />
            {(data?.loginHistory || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No login records.</p>}
          </Panel>
          <Panel title="Admin actions on this user" desc="Audit trail">
            <DataTable
              columns={[
                { key: "action", header: "Action", render: (a) => <Badge tone="accent">{a.action}</Badge> },
                { key: "actorId", header: "By", render: (a) => <span className="text-xs text-white/60">{a.actorId?.email || "system"}</span> },
                { key: "meta", header: "Reason", render: (a) => <span className="text-xs text-white/45">{a.meta?.reason || a.meta?.fields?.join(", ") || "—"}</span> },
                { key: "createdAt", header: "When", render: (a) => <span className="text-xs text-white/45">{fmtDate(a.createdAt)}</span> },
              ]}
              rows={data?.audit || []} rowKey="_id"
            />
            {(data?.audit || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No admin actions recorded.</p>}
          </Panel>
          {(data?.reports || []).length > 0 && (
            <Panel title="Reports involving this user" desc={`${fmtNum(data.reports.length)} report(s)`} className="xl:col-span-2">
              <DataTable
                columns={[
                  { key: "targetType", header: "Type", render: (r) => <Badge>{r.targetType}</Badge> },
                  { key: "reason", header: "Reason", render: (r) => <span className="text-sm text-white/75">{r.reason}</span> },
                  { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
                  { key: "createdAt", header: "Filed", render: (r) => <span className="text-xs text-white/45">{fmtDate(r.createdAt)}</span> },
                ]}
                rows={data?.reports || []} rowKey="_id"
              />
            </Panel>
          )}
        </div>
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={!!dialog}
        title={dialog?.title}
        description={dialog?.desc}
        confirmLabel={dialog?.confirmLabel}
        loading={busy}
        tone={dialog?.tone || "danger"}
        requireReason={dialog?.requireReason}
        reason={reason}
        onReasonChange={setReason}
        onCancel={() => { if (!busy) { setDialog(null); setReason(""); } }}
        onConfirm={runDialog}
      />

      {/* Toast */}
      {toast && (
        <div
          role="status" aria-live="polite"
          className={`fixed bottom-5 left-1/2 z-[100] -translate-x-1/2 rounded-full border px-4 py-2 text-sm backdrop-blur-xl ${toast.ok ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200" : "border-rose-500/40 bg-rose-500/15 text-rose-200"}`}
        >
          {toast.msg}
        </div>
      )}

      <p className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-white/35">
        <Paperclip className="h-3 w-3" aria-hidden />
        <Link to="/admin/users" className="text-cyan-300/70 hover:text-cyan-200">Back to user list</Link>
        <span>·</span>
        <span><UserCog className="mr-1 inline h-3 w-3" aria-hidden />User id <span className="num">{String(u._id)}</span></span>
      </p>
    </div>
  );
}
