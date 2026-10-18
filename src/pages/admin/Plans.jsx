import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, Check, Eye, FileText, Plus, Sparkles, Archive, X,
} from "lucide-react";
import { adminApi } from "../../lib/admin.js";
import { Badge, Button, FormField, Input, Panel, Tooltip } from "../../components/ui.jsx";
import {
  ConfirmDialog, PageHeader, QueryState, RefreshButton, SelectFilter, StatCard, StatusPill,
} from "../../components/admin/primitives.jsx";
import { fmtDate, fmtNum, fmtUSD } from "../../components/admin/format.js";

// ---------------------------------------------------------------------------
// Pricing & Plans management. Every read/write goes to the backend Plan
// catalogue — no plan names or prices are defined in this file. Published
// changes appear on the public pricing page immediately after save.
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
];

// Field whitelist — mirrors backend/validators/planValidator.js so we never
// send a key the server will reject.
const emptyForm = () => ({
  name: "",
  slug: "",
  blurb: "",
  description: "",
  priceUsd: "",
  currency: "USD",
  interval: "month",
  intervalCount: "1",
  features: "",
  aiLimit: "100",
  watchlists: "1",
  alerts: "1",
  badge: "",
  recommended: false,
  cta: "Choose plan",
  displayOrder: "0",
  whopPlanId: "",
  razorpayPriceId: "",
  stripePriceId: "",
});

const toForm = (p) => ({
  name: p.name || "",
  slug: p.slug || "",
  blurb: p.blurb || "",
  description: p.description || "",
  priceUsd: p.priceCents != null ? String(p.priceCents / 100) : "",
  currency: p.currency || "USD",
  interval: p.interval || "month",
  intervalCount: String(p.intervalCount ?? 1),
  features: (p.features || []).join("\n"),
  aiLimit: String(p.limits?.aiLimit ?? 100),
  watchlists: String(p.limits?.watchlists ?? 1),
  alerts: String(p.limits?.alerts ?? 1),
  badge: p.badge || "",
  recommended: !!p.recommended,
  cta: p.cta || "Choose plan",
  displayOrder: String(p.displayOrder ?? 0),
  // Provider ids are carried through the form so a save never drops them.
  whopPlanId: p.providerPriceIds?.whop || "",
  razorpayPriceId: p.providerPriceIds?.razorpay || "",
  stripePriceId: p.providerPriceIds?.stripe || "",
});

export default function AdminPlans() {
  const [plans, setPlans] = useState(null); // null = loading
  const [audit, setAudit] = useState(null);
  const [auditPage, setAuditPage] = useState(1);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  // Editor + preview
  const [editor, setEditor] = useState(null); // { mode: 'create'|'edit', id?, form, impact?, error }
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // { plans, source }
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirm, setConfirm] = useState(null); // { kind, plan, reason }
  const [busy, setBusy] = useState(false);

  const flash = (msg, ok = true) => setToast({ msg, ok });
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); }, [toast]);

  const load = useCallback(() => {
    setLoading(true); setErr("");
    adminApi.plans()
      .then((d) => setPlans(Array.isArray(d?.plans) ? d.plans : []))
      .catch((e) => { setErr(e?.message || "Failed to load plans"); setPlans([]); })
      .finally(() => setLoading(false));
  }, []);

  const loadAudit = useCallback(() => {
    adminApi.planAudit({ page: auditPage, limit: 10 })
      .then(setAudit)
      .catch(() => setAudit({ items: [], total: 0, page: 1, pages: 1 }));
  }, [auditPage]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadAudit(); }, [loadAudit]);

  const rows = useMemo(() => {
    const list = Array.isArray(plans) ? [...plans] : [];
    const needle = q.trim().toLowerCase();
    return list
      .filter((p) => (status ? p.status === status : true))
      .filter((p) => (needle ? `${p.name} ${p.slug}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  }, [plans, status, q]);

  const counts = useMemo(() => {
    const c = { total: plans?.length || 0, published: 0, draft: 0, archived: 0 };
    (plans || []).forEach((p) => { if (c[p.status] != null) c[p.status] += 1; });
    return c;
  }, [plans]);

  // ---- Editor -------------------------------------------------------------
  const openCreate = () => setEditor({ mode: "create", form: { ...emptyForm(), displayOrder: String(counts.total * 10 + 10) } });

  const openEdit = (p) => {
    setEditor({ mode: "edit", id: p.id, form: toForm(p), plan: p, impact: null, impactNote: "" });
    // Load subscriber impact so price/archive edits are made with full context.
    adminApi.planImpact(p.id)
      .then((d) => setEditor((cur) => (cur?.id === p.id ? { ...cur, impact: d?.impact, plan: d?.plan || p } : cur)))
      .catch(() => {});
  };

  const setField = (k, v) => setEditor((cur) => ({ ...cur, form: { ...cur.form, [k]: v } }));

  // Dollars (as typed by the admin) → integer cents. Rejects invalid input.
  const priceToCents = (raw) => {
    const n = Number(String(raw).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return null;
    const cents = Math.round(n * 100);
    return Number.isInteger(cents) ? cents : null;
  };

  const buildPayload = (form) => {
    const cents = priceToCents(form.priceUsd);
    if (cents == null) throw new Error("Price must be a non-negative number (e.g. 50 or 49.99)");
    const num = (v, fb) => { const x = Number(v); return Number.isFinite(x) ? x : fb; };
    return {
      name: form.name.trim(),
      slug: form.slug.trim().toLowerCase(),
      blurb: form.blurb.trim(),
      description: form.description.trim(),
      priceCents: cents,
      currency: form.currency,
      interval: form.interval,
      intervalCount: num(form.intervalCount, 1),
      features: form.features.split("\n").map((s) => s.trim()).filter(Boolean),
      limits: { aiLimit: num(form.aiLimit, 100), watchlists: num(form.watchlists, 1), alerts: num(form.alerts, 1) },
      badge: form.badge.trim(),
      recommended: !!form.recommended,
      cta: form.cta.trim() || "Choose plan",
      displayOrder: num(form.displayOrder, 0),
      // Sent as a whole object (the service replaces it), so every id must be
      // included — otherwise saving would silently unlink the other providers.
      providerPriceIds: {
        whop: form.whopPlanId?.trim() || null,
        razorpay: form.razorpayPriceId?.trim() || null,
        stripe: form.stripePriceId?.trim() || null,
      },
    };
  };

  const save = async () => {
    setSaving(true);
    setEditor((c) => ({ ...c, error: "" }));
    try {
      const payload = buildPayload(editor.form);
      if (editor.mode === "create") {
        await adminApi.createPlan(payload);
        flash(`Created ${payload.name} at ${fmtUSD(payload.priceCents)}`);
      } else {
        await adminApi.updatePlan(editor.id, payload);
        flash(`Saved ${payload.name} — public pricing page updated`);
      }
      setEditor(null);
      load(); loadAudit();
    } catch (e) {
      setEditor((c) => ({ ...c, error: e?.message || "Save failed" }));
    } finally { setSaving(false); }
  };

  // ---- Status transitions (with impact-aware confirmation) ----------------
  const requestStatus = async (plan, next) => {
    if (next === "archived") {
      // Warn when the plan has active subscribers before archiving.
      try {
        const d = await adminApi.planImpact(plan.id);
        setConfirm({ kind: "status", plan, next, impact: d?.impact });
        return;
      } catch { /* fall through to a plain confirmation */ }
    }
    setConfirm({ kind: "status", plan, next });
  };

  const applyStatus = async () => {
    setBusy(true);
    try {
      await adminApi.setPlanStatus(confirm.plan.id, confirm.next);
      flash(`${confirm.plan.name} is now ${confirm.next}`);
      setConfirm(null);
      load(); loadAudit();
    } catch (e) {
      flash(e?.message || "Status change failed", false);
    } finally { setBusy(false); }
  };

  // ---- Reordering ---------------------------------------------------------
  const move = async (index, dir) => {
    const full = [...(plans || [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    const target = index + dir;
    if (target < 0 || target >= full.length) return;
    [full[index], full[target]] = [full[target], full[index]];
    try {
      await adminApi.reorderPlans(full.map((p, i) => ({ id: p.id, displayOrder: (i + 1) * 10 })));
      flash("Display order saved");
      load();
    } catch (e) { flash(e?.message || "Reorder failed", false); }
  };

  // ---- Preview ------------------------------------------------------------
  const openPreview = async (draft) => {
    setPreviewLoading(true); setPreview({ plans: [], source: "…" });
    try {
      const d = await adminApi.planPreview(draft ? [draft] : null);
      setPreview({ plans: d?.plans || [], source: d?.source || "published" });
    } catch (e) {
      setPreview({ plans: [], source: "error", error: e?.message });
    } finally { setPreviewLoading(false); }
  };

  const openPreviewFromEditor = async () => {
    try { await openPreview(buildPayload(editor.form)); } catch (e) { setEditor((c) => ({ ...c, error: e?.message })); }
  };

  const f = editor?.form;
  const impact = editor?.impact;

  return (
    <div>
      <PageHeader
        title="Pricing & Plans"
        desc="Create, price, publish and reorder subscription tiers. Prices are stored as integer cents and served to the public pricing page from the database — no frontend edit required."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => openPreview(null)}>
              <Eye className="h-3.5 w-3.5" /> Preview
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> New plan
            </Button>
            <RefreshButton onClick={() => { load(); loadAudit(); }} loading={loading} />
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total plans" value={fmtNum(counts.total)} sub="in the catalogue" icon={FileText} loading={loading && plans === null} />
        <StatCard label="Published" value={fmtNum(counts.published)} sub="live on pricing page" tone="green" icon={Check} loading={loading && plans === null} />
        <StatCard label="Draft" value={fmtNum(counts.draft)} sub="not purchasable" tone="amber" loading={loading && plans === null} />
        <StatCard label="Archived" value={fmtNum(counts.archived)} sub="existing subs retained" tone="violet" icon={Archive} loading={loading && plans === null} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.02] p-3">
        <Input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or slug…" aria-label="Search plans" className="w-full sm:w-72"
        />
        <SelectFilter label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        {(q || status) && (
          <button
            type="button"
            onClick={() => { setQ(""); setStatus(""); }}
            className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/20"
          >
            Clear filters
          </button>
        )}
      </div>

      <QueryState
        loading={loading && plans === null} error={err} onRetry={load} rows={5}
        empty={!loading && !err && rows.length === 0}
        emptyTitle="No plans match"
        emptyDesc="Adjust the filter, or create your first plan."
      />

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((p, i) => (
            <PlanRow
              key={p.id} plan={p} index={i} total={rows.length}
              onEdit={() => openEdit(p)}
              onStatus={(next) => requestStatus(p, next)}
              onMove={(dir) => move(plans.findIndex((x) => x.id === p.id), dir)}
              onPreview={() => openPreview(null)}
            />
          ))}
        </div>
      )}

      {/* ---- Audit trail ---- */}
      <Panel
        className="mt-5"
        title="Pricing audit log"
        desc="Who changed what — previous → new values for every plan mutation"
        actions={audit?.pages > 1 ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={(audit?.page || 1) <= 1} onClick={() => setAuditPage((n) => Math.max(1, n - 1))}>Prev</Button>
            <span className="num text-xs text-white/50">{audit?.page}/{audit?.pages}</span>
            <Button variant="secondary" size="sm" disabled={(audit?.page || 1) >= (audit?.pages || 1)} onClick={() => setAuditPage((n) => n + 1)}>Next</Button>
          </div>
        ) : null}
        bodyClassName="p-0"
      >
        {!audit ? (
          <div className="p-5"><QueryState loading rows={3} /></div>
        ) : (audit.items || []).length === 0 ? (
          <div className="p-5"><QueryState empty emptyTitle="No pricing changes yet" emptyDesc="Edits, publishes and archives will appear here." /></div>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {audit.items.map((a) => (
              <li key={a._id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.action === "plan_create" ? "success" : a.action === "plan_seed" ? "accent" : "violet"}>{a.action}</Badge>
                    <span className="text-xs text-white/70">{a.actorId?.email || a.meta?.slug || a.target}</span>
                  </div>
                  <p className="mt-1 break-words text-xs text-white/45">
                    <AuditSummary meta={a.meta} />
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-white/35">{fmtDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ---- Editor ---- */}
      {editor && (
        <div className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={editor.mode === "create" ? "Create plan" : "Edit plan"}>
          <div className="my-8 w-full max-w-3xl rounded-2xl border border-white/12 bg-[#0b0f1a] shadow-2xl">
            <header className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-white">{editor.mode === "create" ? "New plan" : `Edit ${editor.plan?.name}`}</h2>
                <p className="mt-0.5 text-xs text-white/45">Prices are stored as integer cents. Saved changes go live on the public page immediately.</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setEditor(null)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </header>

            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <FormField label="Plan name"><Input value={f.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. Pro" /></FormField>
              <FormField label="Slug (URL / checkout id)"><Input value={f.slug} onChange={(e) => setField("slug", e.target.value)} placeholder="e.g. pro" className="num" /></FormField>

              <FormField label="Price (USD)">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/40">$</span>
                  <Input value={f.priceUsd} onChange={(e) => setField("priceUsd", e.target.value)} placeholder="50" inputMode="decimal" className="num" />
                  <span className="whitespace-nowrap text-xs text-white/40">/ {f.interval === "year" ? "year" : "month"}</span>
                </div>
              </FormField>
              <FormField label="Display order">
                <Input value={f.displayOrder} onChange={(e) => setField("displayOrder", e.target.value)} inputMode="numeric" className="num" />
              </FormField>

              <FormField label="Billing interval">
                <SelectFilter value={f.interval} onChange={(v) => setField("interval", v)} options={[{ value: "month", label: "Monthly" }, { value: "year", label: "Yearly" }]} />
              </FormField>
              <FormField label="Interval count">
                <Input value={f.intervalCount} onChange={(e) => setField("intervalCount", e.target.value)} inputMode="numeric" className="num" />
              </FormField>

              <FormField label="Short blurb"><Input value={f.blurb} onChange={(e) => setField("blurb", e.target.value)} placeholder="One-line value proposition" /></FormField>
              <FormField label="Badge"><Input value={f.badge} onChange={(e) => setField("badge", e.target.value)} placeholder="e.g. Most popular" /></FormField>

              <FormField label="Description" className="sm:col-span-2">
                <textarea
                  value={f.description} onChange={(e) => setField("description", e.target.value)} rows={2}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                  placeholder="Longer description shown on the pricing page"
                />
              </FormField>

              <FormField label="Features (one per line)" className="sm:col-span-2">
                <textarea
                  value={f.features} onChange={(e) => setField("features", e.target.value)} rows={6}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                  placeholder={"Real-time market data\nUnlimited watchlists\nAI insights (2,500/mo)"}
                />
              </FormField>

              <FormField label="AI limit (−1 = unlimited)"><Input value={f.aiLimit} onChange={(e) => setField("aiLimit", e.target.value)} inputMode="numeric" className="num" /></FormField>
              <FormField label="Watchlists (−1 = unlimited)"><Input value={f.watchlists} onChange={(e) => setField("watchlists", e.target.value)} inputMode="numeric" className="num" /></FormField>
              <FormField label="Alerts (−1 = unlimited)"><Input value={f.alerts} onChange={(e) => setField("alerts", e.target.value)} inputMode="numeric" className="num" /></FormField>
              <FormField label="CTA button label"><Input value={f.cta} onChange={(e) => setField("cta", e.target.value)} /></FormField>

              <FormField label="Whop variant ID" className="sm:col-span-2">
                <Input value={f.whopPlanId} onChange={(e) => setField("whopPlanId", e.target.value)} placeholder="plan_xxxxxxxxxxxxx" className="num" />
              </FormField>
              <p className="-mt-2 text-xs text-white/40 sm:col-span-2">
                Paste the variant id from your Whop dashboard to sell this plan with the card form
                embedded on your own checkout page. The variant&apos;s price must match the price above —
                a payment whose amount does not match is held for review instead of activating the plan.
              </p>

              <FormField label="Razorpay plan ID (optional)">
                <Input value={f.razorpayPriceId} onChange={(e) => setField("razorpayPriceId", e.target.value)} placeholder="plan_…" className="num" />
              </FormField>
              <FormField label="Stripe price ID (optional)">
                <Input value={f.stripePriceId} onChange={(e) => setField("stripePriceId", e.target.value)} placeholder="price_…" className="num" />
              </FormField>

              <label className="flex items-center gap-2 text-sm text-white/70 sm:col-span-2">
                <input type="checkbox" checked={f.recommended} onChange={(e) => setField("recommended", e.target.checked)} className="h-4 w-4 accent-cyan-400" />
                Mark as the recommended plan (only one can be recommended at a time)
              </label>
            </div>

            {impact && (
              <p className={`mx-5 mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${impact.activeSubscribers > 0 ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-white/10 bg-white/[0.03] text-white/55"}`}>
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{impact.note}</span>
              </p>
            )}

            {editor.error && (
              <p role="alert" className="mx-5 mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{editor.error}</p>
            )}

            <footer className="flex flex-wrap justify-end gap-2 border-t border-white/10 px-5 py-4">
              <Button variant="secondary" size="sm" onClick={openPreviewFromEditor} disabled={saving}>
                <Eye className="h-3.5 w-3.5" /> Preview
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditor(null)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={save} loading={saving}>
                {editor.mode === "create" ? "Create plan" : "Save changes"}
              </Button>
            </footer>
          </div>
        </div>
      )}

      {/* ---- Preview modal ---- */}
      {preview && (
        <div className="fixed inset-0 z-[96] flex items-start justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Pricing page preview">
          <div className="my-8 w-full max-w-5xl rounded-2xl border border-white/12 bg-[#0b0f1a] p-5 shadow-2xl">
            <header className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Public pricing preview</h2>
                <p className="mt-0.5 text-xs text-white/45">
                  Source: <span className="text-white/70">{preview.source === "draft" ? "unsaved edits (not published)" : "live published catalogue"}</span>
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setPreview(null)} aria-label="Close preview"><X className="h-4 w-4" /></Button>
            </header>

            {previewLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-56 animate-pulse rounded-xl bg-white/5" />)}
              </div>
            ) : preview.error ? (
              <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{preview.error}</p>
            ) : preview.plans.length === 0 ? (
              <p className="text-sm text-white/50">No published plans to preview.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {preview.plans.map((p) => (
                  <div key={p.id} className={`relative flex flex-col rounded-xl border p-4 ${p.recommended ? "border-cyan-400/50 bg-cyan-400/[0.05]" : "border-white/10 bg-white/[0.02]"}`}>
                    {p.recommended && (
                      <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-black">
                        {p.badge || "Recommended"}
                      </span>
                    )}
                    <h3 className="text-sm font-bold text-white">{p.name}</h3>
                    <p className="mt-2 text-2xl font-bold text-white num">{p.price === "0" ? "Free" : `$${p.price}`}<span className="text-xs font-normal text-white/40">/{p.interval}</span></p>
                    <ul className="mt-3 flex-1 space-y-1.5">
                      {(p.features || []).slice(0, 6).map((x) => (
                        <li key={x} className="flex items-start gap-1.5 text-[11px] text-white/60"><Check className="mt-0.5 h-3 w-3 shrink-0 text-cyan-400" aria-hidden />{x}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 text-[11px] text-white/35">Preview is read-only — it never mutates the live catalogue.</p>
          </div>
        </div>
      )}

      {/* ---- Destructive / state-change confirmation ---- */}
      <ConfirmDialog
        open={!!confirm}
        tone={confirm?.next === "archived" ? "danger" : "primary"}
        title={
          confirm?.next === "archived"
            ? `Archive ${confirm?.plan?.name}?`
            : confirm?.next === "published"
              ? `Publish ${confirm?.plan?.name}?`
              : `Move ${confirm?.plan?.name} to draft?`
        }
        description={
          confirm?.kind === "status" && confirm?.next === "archived"
            ? `Archiving blocks NEW purchases of ${confirm.plan.name}. Existing subscriptions keep their entitlements and all purchase history is preserved. ${confirm.impact?.activeSubscribers > 0 ? `${confirm.impact.activeSubscribers} active subscriber(s) are currently on this plan.` : ""}`
            : confirm?.next === "published"
              ? `${confirm?.plan?.name} will appear on the public pricing page and become purchasable immediately.`
              : `${confirm?.plan?.name} will be hidden from the pricing page and cannot be purchased. Existing subscriptions are unaffected.`
        }
        confirmLabel={confirm?.next === "archived" ? "Archive plan" : confirm?.next === "published" ? "Publish" : "Unpublish"}
        reason={confirm?.reason || ""}
        onReasonChange={(v) => setConfirm((c) => ({ ...c, reason: v }))}
        loading={busy}
        onCancel={() => { if (!busy) setConfirm(null); }}
        onConfirm={applyStatus}
      />

      {toast && (
        <div
          role="status" aria-live="polite"
          className={`fixed bottom-5 left-1/2 z-[100] -translate-x-1/2 rounded-full border px-4 py-2 text-sm backdrop-blur-xl ${toast.ok ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200" : "border-rose-500/40 bg-rose-500/15 text-rose-200"}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan row — price, status, provenance, ordering and lifecycle controls.
// ---------------------------------------------------------------------------
function PlanRow({ plan: p, index, total, onEdit, onStatus, onMove, onPreview }) {
  const nextStatus = p.status === "published" ? "draft" : "published";
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-white/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{p.name}</h3>
            <span className="num text-xs text-white/35">{p.slug}</span>
            <StatusPill status={p.status} />
            {p.recommended && <Badge tone="accent">recommended</Badge>}
            {p.badge && !p.recommended && <Badge tone="violet">{p.badge}</Badge>}
          </div>
          {p.blurb && <p className="mt-1 text-xs text-white/50">{p.blurb}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/40">
            <span className="num text-white/70">{fmtUSD(p.priceCents)} <span className="text-white/40">/ {p.interval}</span></span>
            <span>{fmtNum(p.features?.length ?? 0)} features</span>
            <span>order {p.displayOrder}</span>
            <span>created {fmtDate(p.createdAt, { time: false })}</span>
            <span>updated {fmtDate(p.updatedAt)}</span>
            {p.updatedBy?.email && <span>by {p.updatedBy.email}</span>}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Tooltip tip={p.providerPriceIds?.razorpay || p.providerPriceIds?.stripe ? "Provider price id linked" : "No provider price id linked yet"}>
            <span className="num rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/45">
              {p.providerPriceIds?.razorpay || p.providerPriceIds?.stripe || "no provider id"}
            </span>
          </Tooltip>

          <div className="flex flex-col">
            <button
              type="button" onClick={() => onMove(-1)} disabled={index === 0}
              aria-label={`Move ${p.name} up`}
              className="rounded border border-white/10 px-1.5 py-0.5 text-white/50 transition hover:bg-white/10 disabled:opacity-25"
            ><ArrowUp className="h-3 w-3" /></button>
            <button
              type="button" onClick={() => onMove(1)} disabled={index === total - 1}
              aria-label={`Move ${p.name} down`}
              className="rounded border border-white/10 px-1.5 py-0.5 text-white/50 transition hover:bg-white/10 disabled:opacity-25"
            ><ArrowDown className="h-3 w-3" /></button>
          </div>

          <Button variant="secondary" size="sm" onClick={onPreview} aria-label={`Preview pricing page`}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button variant="secondary" size="sm" onClick={onEdit}>Edit</Button>
          <Button
            variant={nextStatus === "published" ? "primary" : "secondary"} size="sm"
            onClick={() => onStatus(nextStatus)}
          >
            {p.status === "published" ? "Unpublish" : "Publish"}
          </Button>
          {p.status !== "archived" && (
            <Button variant="secondary" size="sm" onClick={() => onStatus("archived")} aria-label={`Archive ${p.name}`}>
              <Archive className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

// Compact audit summary: handles create/update/status/reorder meta shapes.
function AuditSummary({ meta }) {
  if (!meta) return null;
  if (meta.changes) {
    const entries = Object.entries(meta.changes);
    if (entries.length) {
      return entries.slice(0, 4).map(([k, v]) => `${k}: ${JSON.stringify(v?.from)} → ${JSON.stringify(v?.to)}`).join(" · ")
        + (entries.length > 4 ? ` · +${entries.length - 4} more` : "");
    }
  }
  if (meta.from != null || meta.to != null) return `${meta.slug || ""} ${meta.from} → ${meta.to}`;
  if (meta.created != null) return `${meta.created} created, ${meta.skipped} skipped`;
  if (meta.priceCents != null) return `${meta.slug} at ${fmtUSD(meta.priceCents)} (${meta.status})`;
  return meta.slug || "";
}
