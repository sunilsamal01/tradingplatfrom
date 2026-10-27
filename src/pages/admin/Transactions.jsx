import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, IndianRupee, RefreshCw, Undo2 } from "lucide-react";
import { adminApi } from "../../lib/admin.js";
import { useAuth } from "../../context/useAuth.js";
import { Badge, Button, Panel, Tooltip } from "../../components/ui.jsx";
import { ConfirmDialog, DataTable, DateRangePresets, PageHeader, Pagination, QueryState, RefreshButton, SearchInput, SelectFilter, StatCard, StatusPill } from "../../components/admin/primitives.jsx";
import { fmtAggregate, fmtDate, fmtMoney, fmtNum } from "../../components/admin/format.js";

const STATUS_OPTIONS = [
  { value: "paid", label: "Paid" },
  { value: "created", label: "Created" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded" },
];
const PROVIDER_OPTIONS = [
  { value: "razorpay", label: "Razorpay" },
  { value: "stripe", label: "Stripe" },
];

// Roles allowed to trigger provider refunds (mirrors backend finance:refund).
const REFUND_ROLES = ["superadmin", "finance"];

export default function AdminTransactions() {
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [range, setRange] = useState(null);
  const [sort, setSort] = useState("createdAt");
  const [dir, setDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState(null);

  const [refundTarget, setRefundTarget] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const flash = (msg, ok = true) => setToast({ msg, ok });
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); }, [toast]);

  const load = useCallback(() => {
    setLoading(true); setErr("");
    adminApi.transactions({ q, status, provider, from: range?.from, to: range?.to, sort, dir, page, limit })
      .then(setData)
      .catch((e) => setErr(e?.message || "Failed to load transactions"))
      .finally(() => setLoading(false));
  }, [q, status, provider, range, sort, dir, page, limit]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q, status, provider, range]);

  const onSort = (key) => {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(key); setDir("desc"); }
  };

  const doRefund = async () => {
    setBusy(true);
    try {
      const d = await adminApi.refund(refundTarget._id, reason);
      flash(d?.idempotent ? "Already refunded — no provider call made" : `Refunded ${fmtMoney(refundTarget.amount, refundTarget.currency)} via ${refundTarget.provider}`);
      setRefundTarget(null); setReason("");
      load();
    } catch (e) {
      // Never pretends success: provider failure surfaces with unchanged status.
      flash(e?.message || "Refund failed — payment status unchanged", false);
    } finally { setBusy(false); }
  };

  const rows = data?.items || [];
  const summary = data?.summary || {};
  const canRefund = REFUND_ROLES.includes(me?.role);

  const columns = [
    {
      key: "amount", header: "Amount", sortable: true,
      render: (p) => (
        <Tooltip tip={`Currency: ${p.currency || "USD"}${p.plan ? ` · Plan: ${p.plan}` : ""}`}>
          <span className="num font-medium text-white">{fmtMoney(p.amount, p.currency)}</span>
        </Tooltip>
      ),
    },
    {
      key: "userId", header: "Customer",
      render: (p) => (p.userId
        ? <Link to={`/admin/users/${p.userId._id}`} className="block min-w-0 truncate text-sm text-white/80 hover:text-cyan-300" onClick={(e) => e.stopPropagation()}>{p.userId.email}</Link>
        : <span className="text-xs text-white/40">—</span>),
    },
    { key: "plan", header: "Plan", render: (p) => <span className="text-xs text-white/70">{p.plan || "—"}</span> },
    { key: "provider", header: "Provider", render: (p) => <Badge>{p.provider}</Badge> },
    {
      key: "providerPaymentId", header: "Provider ref",
      render: (p) => <span className="num text-xs text-white/40">{p.providerPaymentId || p.providerOrderId || "—"}</span>,
    },
    { key: "status", header: "Status", sortable: true, render: (p) => <StatusPill status={p.status} /> },
    { key: "createdAt", header: "Date", sortable: true, render: (p) => <span className="text-xs text-white/45">{fmtDate(p.createdAt)}</span> },
    {
      key: "_actions", header: "", sortable: false, cellClassName: "text-right",
      render: (p) => (p.status === "paid" ? (
        <Button
          variant="secondary" size="sm"
          onClick={(e) => { e.stopPropagation(); setReason(""); setRefundTarget(p); }}
          disabled={!canRefund}
          title={canRefund ? "Issue a provider refund" : "Your role cannot issue refunds"}
        >
          <Undo2 className="h-3.5 w-3.5" /> Refund
        </Button>
      ) : p.status === "refunded" ? (
        <Badge tone="violet">refunded</Badge>
      ) : null),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Transactions"
        desc="Payment records with server-side filters. Refunds are executed by the payment provider — status only changes after provider confirmation."
        actions={<RefreshButton onClick={load} loading={loading} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Paid" value={fmtAggregate(summary.paid?.amount, summary.paid?.currency)} sub={`${fmtNum(summary.paid?.count)} payments`} tone="green" loading={loading && !data} />
        <StatCard label="Failed" value={fmtNum(summary.failed?.count)} sub={fmtAggregate(summary.failed?.amount, summary.failed?.currency)} tone="rose" loading={loading && !data} />
        <StatCard label="Refunded" value={fmtAggregate(summary.refunded?.amount, summary.refunded?.currency)} sub={`${fmtNum(summary.refunded?.count)} refunds`} tone="violet" loading={loading && !data} />
        <StatCard label="In progress" value={fmtNum(summary.created?.count)} sub="created, unpaid" tone="amber" loading={loading && !data} />
      </div>

      <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={q} onChange={setQ}
            placeholder="Search by payment/order id or plan…"
            className="w-full sm:w-80"
            ariaLabel="Search transactions"
          />
          <SelectFilter label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          <SelectFilter label="Provider" value={provider} onChange={setProvider} options={PROVIDER_OPTIONS} />
          {(q || status || provider || range) && (
            <button
              type="button"
              onClick={() => { setQ(""); setStatus(""); setProvider(""); setRange(null); }}
              className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/20"
            >
              Clear filters
            </button>
          )}
        </div>
        <DateRangePresets value={range} onChange={setRange} className="mt-3" />
      </div>

      {!canRefund && (
        <p className="mb-3 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          Refund controls are visible for context but disabled — issuing refunds requires the <Badge tone="warning">superadmin</Badge> or <Badge tone="warning">finance</Badge> role.
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <QueryState
          loading={loading && !data} error={err} onRetry={load} rows={6}
          empty={!loading && !err && rows.length === 0}
          emptyTitle="No transactions match these filters"
          emptyDesc="Adjust the status, provider, or date range."
        />
        {rows.length > 0 && (
          <>
            <DataTable columns={columns} rows={rows} sort={sort} dir={dir} onSort={onSort} />
            <Pagination page={data?.page} pages={data?.pages} total={data?.total} onPage={setPage} limit={limit} onLimit={setLimit} loading={loading} />
          </>
        )}
      </div>

      <Panel className="mt-4" title="How refunds work" desc="Idempotent, provider-confirmed, fully audited">
        <ol className="list-decimal space-y-1.5 pl-5 text-xs text-white/55">
          <li>Only payments in <span className="text-white/80">paid</span> state can be refunded, and only with a provider payment reference.</li>
          <li>The backend calls {`Razorpay/Stripe's`} refund API. If the provider errors, the response is a failure and the payment status is <span className="text-white/80">unchanged</span>.</li>
          <li>On provider success the record becomes <span className="text-white/80">refunded</span>, an audit entry is written, and re-submitting is a no-op.</li>
        </ol>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-white/35">
          <IndianRupee className="h-3 w-3" aria-hidden /> Configure <span className="num">PAYMENT_PROVIDER</span>, <span className="num">RAZORPAY_KEY_ID/SECRET</span> or Stripe keys in the backend <span className="num">.env</span> for live refunds.
          <RefreshCw className="ml-2 h-3 w-3" aria-hidden />
        </p>
      </Panel>

      <ConfirmDialog
        open={!!refundTarget}
        title={`Refund ${fmtMoney(refundTarget?.amount, refundTarget?.currency)}?`}
        description={
          refundTarget
            ? `A ${refundTarget.provider} refund will be issued for payment ${refundTarget.providerPaymentId || refundTarget.providerOrderId || refundTarget._id}. This action is recorded in the audit log.`
            : ""
        }
        confirmLabel="Issue refund"
        loading={busy}
        reason={reason}
        onReasonChange={setReason}
        reasonLabel="Internal note"
        onCancel={() => { if (!busy) { setRefundTarget(null); setReason(""); } }}
        onConfirm={doRefund}
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
