import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../context/useAuth.js";
import { Card, Button, Badge, EmptyState } from "../components/ui.jsx";
import { SkeletonLoader } from "../components/Loaders.jsx";
import { cn } from "../lib/utils.js";

// Frozen at module load so render stays pure (React Compiler purity rule).
const SUBSCRIPTION_PAGE_LOAD = Date.now();

export default function Subscription() {
  const { user, plan } = useAuth();
  const navigate = useNavigate();
  const [sub, setSub] = useState(null);
  const [plans, setPlans] = useState(null);
  const [billing, setBilling] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => {
    api.get("/subscriptions/current").then((d) => setSub(d?.subscription || null)).catch(() => setSub(null));
    api.get("/subscriptions/plans").then((d) => setPlans(d?.plans || [])).catch(() => setPlans([]));
    api.get("/subscriptions/billing").then((d) => setBilling(d?.items || [])).catch(() => setBilling([]));
  };
  useEffect(load, []);

  const cancel = async () => {
    setBusy(true); setMsg("");
    try { await api.post("/subscriptions/cancel", {}); setMsg("Subscription cancelled — active until period end."); load(); }
    catch (e) { setMsg(e?.message || "Cancel failed"); }
    finally { setBusy(false); }
  };

  const currentPlan = sub?.plan || plan || user?.plan || "FREE";
  const active = sub?.status === "active";
  const expires = sub?.expiresAt ? new Date(sub.expiresAt) : null;
  const daysLeft = expires ? Math.max(0, Math.ceil((expires.getTime() - SUBSCRIPTION_PAGE_LOAD) / 864e5)) : null;

  return (
    <div>
      <h2 className="font-display text-xl font-bold tracking-tight text-white">Subscription &amp; Billing</h2>
      <p className="mt-1 text-xs text-white/50">Entitlements are enforced server-side against verified payments.</p>

      <Card className="mt-4 bg-white/[0.02] backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-white/40">Current plan</p>
            <p className="mt-1 text-2xl font-semibold text-white">{currentPlan}</p>
          </div>
          <div className="ml-auto text-right">
            <Badge tone={active ? "success" : "default"}>{active ? "Active" : (sub?.status || "Free tier")}</Badge>
            {expires && <p className="mt-1 text-xs text-white/50">{active ? `Renews ${expires.toLocaleDateString()}` : `Expired ${expires.toLocaleDateString()}`} {daysLeft !== null && `· ${daysLeft}d left`}</p>}
          </div>
        </div>
        {active && <Button size="sm" variant="secondary" className="mt-3" onClick={cancel} disabled={busy}>{busy ? "Cancelling…" : "Cancel subscription"}</Button>}
        {msg && <p className="mt-2 text-xs text-white/60">{msg}</p>}
      </Card>

      <h2 className="mt-6 mb-2 text-sm font-medium text-white">Plans</h2>
      {plans === null ? <SkeletonLoader rows={2} /> : plans.length === 0 ? (
        <EmptyState title="No plans published yet" desc="Pricing is being configured — check back shortly." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const cents = Number(p.priceCents ?? 0);
            const sym = p.currency === "USD" ? "$" : p.currency === "INR" ? "₹" : "";
            const priceLabel = cents === 0 ? "Free" : `${sym || `${p.currency} `}${(cents / 100).toLocaleString()}`;
            const isCurrent = String(currentPlan).toLowerCase() === String(p.id).toLowerCase();
            return (
              <Card key={p.id} className={cn("bg-white/[0.02] backdrop-blur-xl", isCurrent && "border-cyan-500/50")}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-white">{p.name}</p>
                  {isCurrent && <Badge tone="accent">Current</Badge>}
                </div>
                <p className="mt-1 text-xl font-semibold text-white">
                  {priceLabel}
                  <span className="text-xs text-white/40">{p.interval === "year" ? "/yr" : "/mo"}</span>
                </p>
                <ul className="mt-2 space-y-1 text-xs text-white/55">{(p.features || []).map((f) => <li key={f}>✓ {f}</li>)}</ul>
                {cents > 0 && !isCurrent && (
                  <Button size="sm" className="mt-3 w-full" onClick={() => navigate(`/checkout?plan=${encodeURIComponent(p.id || p.slug)}`)}>
                    Upgrade
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <h2 className="mt-6 mb-2 text-sm font-medium text-white">Billing history</h2>
      {billing === null ? <SkeletonLoader rows={3} /> : billing.length === 0 ? <EmptyState title="No payments yet" desc="Your verified payment records will appear here." /> : (
        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-widest text-white/40">
              <th className="px-4 py-3">Order</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Provider</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Date</th>
            </tr></thead>
            <tbody>{billing.map((b) => (
              <tr key={b.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                <td className="px-4 py-2.5 font-mono text-xs text-white/50">{b.purchaseRef || String(b.id).slice(-8)}</td>
                <td className="px-4 py-2.5 text-white">{b.plan}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-white">{b.currency === "USD" ? "$" : b.currency === "INR" ? "₹" : `${b.currency || ""} `}{b.amount}</td>
                <td className="px-4 py-2.5 text-white/60">{b.provider}</td>
                <td className="px-4 py-2.5"><Badge tone={b.status === "paid" ? "success" : b.status === "failed" ? "danger" : "default"}>{b.status}</Badge></td>
                <td className="px-4 py-2.5 text-white/50">{new Date(b.createdAt).toLocaleDateString()}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button to="/checkout/orders" size="sm" variant="secondary">View checkout orders</Button>
        <Button to="/purchases" size="sm" variant="ghost">Payment history</Button>
      </div>
    </div>
  );
}
