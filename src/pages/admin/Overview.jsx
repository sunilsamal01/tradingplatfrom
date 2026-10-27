import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from "recharts";
import {
  Activity, ArrowUpRight, CreditCard, IndianRupee, ShieldAlert, UserPlus, Users,
} from "lucide-react";
import { adminApi } from "../../lib/admin.js";
import { Badge, Panel } from "../../components/ui.jsx";
import { DateRangePresets, PageHeader, QueryState, RefreshButton, StatCard, StatusPill, DataTable } from "../../components/admin/primitives.jsx";
import { defaultRange, fmtAggregate, fmtDate, fmtMoney, fmtNum } from "../../components/admin/format.js";

const CHART_AXIS = { stroke: "#3f4a63", fontSize: 11 };
const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;
const tooltipStyle = {
  contentStyle: { background: "#0b0f1a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, fontSize: 12 },
  labelStyle: { color: "rgba(255,255,255,0.6)" },
  itemStyle: { color: "#e5eaf5" },
};

export default function AdminOverview() {
  const [range, setRange] = useState(() => defaultRange());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    setLoading(true); setErr("");
    adminApi.overview({ from: range.from, to: range.to })
      .then(setData)
      .catch((e) => setErr(e?.message || "Failed to load the executive overview"))
      .finally(() => setLoading(false));
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const k = data?.kpis;
  const rev = k?.revenue;
  const reg = data?.trends?.registrations || [];
  const revenueTrend = data?.trends?.revenue || [];
  const payTrend = data?.trends?.payments || [];

  return (
    <div>
      <PageHeader
        title="Executive overview"
        desc="Platform KPIs computed from live user, subscription and payment records."
        actions={
          <>
            <span className="hidden text-xs text-white/40 sm:inline">
              {range.label ? `${range.label} · ` : ""}{fmtDate(range.from, { time: false })} → {fmtDate(range.to, { time: false })}
            </span>
            <RefreshButton onClick={load} loading={loading} />
          </>
        }
      />

      <DateRangePresets value={range} onChange={setRange} className="mb-5" />

      <QueryState loading={loading && !data} error={err} onRetry={load} rows={5} />

      {data && (
        <>
          {sessionStorage.getItem('slt_admin_welcome') && (
            <div role="status" className="mb-4 flex items-center justify-between rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3">
              <p className="text-sm text-cyan-100">Welcome back, Administrator <span className="ml-2 rounded-full border border-cyan-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wider">Administrator Account · {data?.me?.role || 'verified'}</span></p>
              <button type="button" aria-label="Dismiss" onClick={() => { sessionStorage.removeItem('slt_admin_welcome'); }} className="text-cyan-200/70 hover:text-white">✕</button>
            </div>
          )}
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total users" icon={Users} tone="cyan" loading={loading}
              value={fmtNum(k?.users?.total)}
              delta={k?.users?.newPct}
              sub={`${fmtNum(k?.users?.new)} new in range`}
              tip={`Active in period: ${fmtNum(k?.users?.active)} · Verified: ${fmtNum(k?.users?.verified)} · Unverified: ${fmtNum(k?.users?.unverified)}`}
            />
            <StatCard
              label="Active subscriptions" icon={Activity} tone="violet" loading={loading}
              value={fmtNum(k?.subscriptions?.active)}
              delta={k?.subscriptions?.newPct}
              sub={`${fmtNum(k?.subscriptions?.new)} new in range`}
              tip={`Cancelled or expired in range: ${fmtNum(k?.subscriptions?.cancelledOrExpired)}`}
            />
            <StatCard
              label="Net revenue" icon={IndianRupee} tone="green" loading={loading}
              value={fmtAggregate(rev?.net, rev?.currency)}
              delta={rev?.netPct}
              sub={`vs previous period`}
              tip={`Gross (paid): ${fmtAggregate(rev?.gross, rev?.currency)} - Refunds: ${fmtAggregate(rev?.refunds, rev?.currency)} = Net. Figures from confirmed payments only.`}
            />
            <StatCard
              label="Payment success" icon={CreditCard} tone="amber" loading={loading}
              value={`${rev?.successRate ?? 0}%`}
              sub={`${fmtNum(rev?.paidCount)} paid / ${fmtNum(rev?.failed)} failed`}
              tip={`${fmtNum(rev?.refundCount)} refund(s) totalling ${fmtAggregate(rev?.refunds, rev?.currency)} in this period`}
            />
          </div>

          {/* Secondary stats */}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard label="New users" icon={UserPlus} value={fmtNum(k?.users?.new)} sub={`prev ${fmtNum(k?.users?.newPrev)}`} loading={loading} tone="cyan" />
            <StatCard label="Verified" icon={Users} value={fmtNum(k?.users?.verified)} sub="email verified" loading={loading} tone="white" />
            <StatCard label="Gross volume" icon={IndianRupee} value={fmtAggregate(rev?.gross, rev?.currency)} sub="paid" loading={loading} tone="green" />
            <StatCard label="Refunds" icon={CreditCard} value={fmtAggregate(rev?.refunds, rev?.currency)} sub={`${fmtNum(rev?.refundCount)} refunds`} loading={loading} tone="rose" />
            <StatCard label="Failed payments" icon={ShieldAlert} value={fmtNum(rev?.failed)} sub={`prev ${fmtNum(rev?.failedPrev)}`} loading={loading} tone="amber" />
            <StatCard label="Active sessions" icon={Activity} value={fmtNum(k?.security?.activeSessions)} sub={`${fmtNum(k?.security?.failedLogins)} failed logins`} loading={loading} tone="violet" />
          </div>

          {/* Charts */}
          <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Panel title="Revenue (confirmed payments)" desc="Daily settled revenue in the selected range">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueTrend} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="date" tick={CHART_AXIS} tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => fmtAggregate(v, rev?.currency)} />
                    <Tooltip {...tooltipStyle} formatter={(v) => [fmtAggregate(v, rev?.currency), "Revenue"]} />
                    <Area type="monotone" dataKey="value" stroke="#22d3ee" strokeWidth={2} fill="url(#revGrad)" isAnimationActive={!REDUCED_MOTION} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Registrations" desc="New accounts per day">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={reg} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="date" tick={CHART_AXIS} tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} formatter={(v) => [fmtNum(v), "New users"]} />
                    <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="mt-4">
            <Panel title="Payment outcomes" desc="Paid / failed / refunded counts per day">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={payTrend} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="date" tick={CHART_AXIS} tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="paid" stackId="a" fill="#34d399" name="Paid" />
                    <Bar dataKey="failed" stackId="a" fill="#fb7185" name="Failed" />
                    <Bar dataKey="refunded" stackId="a" fill="#a78bfa" name="Refunded" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex gap-4 text-[11px] text-white/50">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Paid</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-400" /> Failed</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-violet-400" /> Refunded</span>
              </div>
            </Panel>
          </div>

          {/* Recent activity */}
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel title="Recent transactions" desc="Latest payments in range" className="xl:col-span-1"
              actions={<Link to="/admin/transactions" className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200">All <ArrowUpRight className="h-3 w-3" /></Link>}>
              <DataTable
                columns={[
                  { key: "amount", header: "Amount", render: (r) => <span className="num text-white">{fmtMoney(r.amount, r.currency)}</span> },
                  { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
                  { key: "createdAt", header: "Date", render: (r) => <span className="text-xs text-white/45">{fmtDate(r.createdAt)}</span> },
                ]}
                rows={data?.recent?.payments || []}
                rowKey="_id"
              />
              {(data?.recent?.payments || []).length === 0 && <p className="py-4 text-center text-xs text-white/40">No transactions in this range.</p>}
            </Panel>

            <Panel title="New users" desc="Latest registrations in range"
              actions={<Link to="/admin/users" className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200">All <ArrowUpRight className="h-3 w-3" /></Link>}>
              <ul className="space-y-2.5">
                {(data?.recent?.users || []).map((u) => (
                  <li key={u._id}>
                    <Link to={`/admin/users/${u._id}`} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition hover:bg-white/[0.04]">
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-white/85">{u.firstName ? `${u.firstName} ${u.lastName || ""}`.trim() : u.email}</span>
                        <span className="block truncate text-xs text-white/40">{u.email}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusPill status={u.status} />
                        <span className="text-[11px] text-white/35">{fmtDate(u.createdAt, { time: false })}</span>
                      </span>
                    </Link>
                  </li>
                ))}
                {(data?.recent?.users || []).length === 0 && <li className="py-4 text-center text-xs text-white/40">No registrations in this range.</li>}
              </ul>
            </Panel>

            <Panel title="Recent admin actions" desc="Audit trail"
              actions={<Link to="/admin/activity" className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200">All <ArrowUpRight className="h-3 w-3" /></Link>}>
              <ul className="space-y-2.5">
                {(data?.recent?.adminActions || []).map((a) => (
                  <li key={a._id} className="rounded-lg px-2 py-1.5">
                    <p className="text-sm text-white/80">
                      <Badge tone="accent" className="mr-2">{a.action}</Badge>
                    </p>
                    <p className="mt-1 text-xs text-white/40">
                      {a.actorId?.email || "system"} · {fmtDate(a.createdAt)}
                      {a.target ? ` · target ${String(a.target).slice(0, 8)}…` : ""}
                    </p>
                  </li>
                ))}
                {(data?.recent?.adminActions || []).length === 0 && <li className="py-4 text-center text-xs text-white/40">No admin actions recorded.</li>}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
