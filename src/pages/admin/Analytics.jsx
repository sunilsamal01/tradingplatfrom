import { useCallback, useEffect, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { BarChart3, TrendingUp, PieChart as PieIcon } from "lucide-react";
import { adminApi } from "../../lib/admin.js";
import { Panel } from "../../components/ui.jsx";
import { PageHeader, QueryState, RefreshButton, StatCard } from "../../components/admin/primitives.jsx";
import { fmtMoney, fmtNum } from "../../components/admin/format.js";

const CHART_AXIS = { stroke: "#3f4a63", fontSize: 11 };
const tooltipStyle = {
  contentStyle: { background: "#0b0f1a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, fontSize: 12 },
  labelStyle: { color: "rgba(255,255,255,0.6)" },
  itemStyle: { color: "#e5eaf5" },
};
const PIE_COLORS = ["#22d3ee", "#8b5cf6", "#34d399", "#fbbf24", "#fb7185", "#38bdf8"];

export default function AdminAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    setLoading(true); setErr("");
    adminApi.analytics()
      .then(setData)
      .catch((e) => setErr(e?.message || "Failed to load analytics"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Revenue rows arrive per month AND currency. Adding 20 USD to 500 INR would
  // produce a meaningless figure, so the chart shows one currency and the rest
  // are reported separately rather than being folded in.
  const rawRevenue = data?.revenueByMonth || [];
  const totalsByCurrency = [...new Set(rawRevenue.map((r) => r._id?.currency || "USD"))]
    .map((currency) => ({
      currency,
      total: rawRevenue
        .filter((r) => (r._id?.currency || "USD") === currency)
        .reduce((s, r) => s + (r.revenue || 0), 0),
    }))
    .sort((a, b) => b.total - a.total);
  const primaryCurrency = totalsByCurrency[0]?.currency || "USD";
  const totalRevenue = totalsByCurrency[0]?.total || 0;
  const otherCurrencies = totalsByCurrency.slice(1);

  const revByMonth = rawRevenue
    .filter((r) => (r._id?.currency || "USD") === primaryCurrency)
    .map((r) => ({ month: r._id?.month, revenue: r.revenue, count: r.count }));
  const regs = (data?.registrationsByDay || []).map((r) => ({ date: r._id, count: r.count }));
  const dauMau = data?.dauMau || { dau: 0, mau: 0 };
  const byPlan = (data?.byPlan || []).map((r) => ({ name: r._id || "unknown", value: r.count }));
  const byStatus = (data?.byStatus || []).map((r) => ({ name: r._id || "unknown", value: r.count }));
  const byProvider = (data?.byProvider || []).map((r) => ({ name: r._id || "unknown", value: r.count }));
  const successRate = data?.paymentSuccessRate?.successRate;

  return (
    <div>
      <PageHeader
        title="Analytics"
        desc="Long-run trends across revenue, registrations, engagement and payment conversion."
        actions={<RefreshButton onClick={load} loading={loading} />}
      />

      <QueryState loading={loading && !data} error={err} onRetry={load} rows={4} />

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Revenue (all time)" icon={TrendingUp} tone="green" loading={loading} value={fmtMoney(totalRevenue, primaryCurrency)} sub={`${fmtNum(revByMonth.length)} months${otherCurrencies.length ? ` · also ${otherCurrencies.map((c) => fmtMoney(c.total, c.currency)).join(", ")}` : ""}`} />
            <StatCard label="Payment success" icon={BarChart3} tone="cyan" loading={loading} value={`${successRate ?? 0}%`} sub="confirmed / attempted" />
            <StatCard label="DAU / MAU" icon={PieIcon} tone="violet" loading={loading} value={`${fmtNum(dauMau.dau)} / ${fmtNum(dauMau.mau)}`} sub="last 1d / 30d" />
            <StatCard label="Registrations" icon={BarChart3} tone="white" loading={loading} value={fmtNum(regs.reduce((s, r) => s + (r.count || 0), 0))} sub="last 30 days" />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Panel title="Revenue by month" desc="Settled payments grouped by calendar month">
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={revByMonth} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="month" tick={CHART_AXIS} tickLine={false} axisLine={false} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => fmtMoney(v, primaryCurrency)} />
                    <Tooltip {...tooltipStyle} formatter={(v) => [fmtMoney(v, primaryCurrency), "Revenue"]} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="revenue" fill="#34d399" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {revByMonth.length === 0 && <p className="mt-2 text-center text-xs text-white/40">No settled revenue recorded yet.</p>}
            </Panel>

            <Panel title="Registrations over time" desc="New accounts per day">
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={regs} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="date" tick={CHART_AXIS} tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} formatter={(v) => [fmtNum(v), "New users"]} />
                    <Line type="monotone" dataKey="count" stroke="#22d3ee" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel title="Active users" desc="Daily (24h) vs monthly (30d) actives">
              <dl className="divide-y divide-white/[0.06]">
                <div className="flex items-center justify-between py-3">
                  <dt className="text-sm text-white/60">DAU — last 24 hours</dt>
                  <dd className="num text-lg font-semibold text-cyan-300">{fmtNum(dauMau.dau)}</dd>
                </div>
                <div className="flex items-center justify-between py-3">
                  <dt className="text-sm text-white/60">MAU — last 30 days</dt>
                  <dd className="num text-lg font-semibold text-violet-300">{fmtNum(dauMau.mau)}</dd>
                </div>
                <div className="flex items-center justify-between py-3">
                  <dt className="text-sm text-white/60">DAU / MAU stickiness</dt>
                  <dd className="num text-lg font-semibold text-white">
                    {dauMau.mau ? `${Math.round((dauMau.dau / dauMau.mau) * 100)}%` : "—"}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-white/35">Actives are users with a recorded last-active timestamp inside the window.</p>
            </Panel>

            <Panel title="Users by plan" desc="Distribution">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byPlan} layout="vertical" margin={{ top: 6, right: 12, left: 24, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={CHART_AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={CHART_AXIS} tickLine={false} axisLine={false} width={72} />
                    <Tooltip {...tooltipStyle} formatter={(v) => [fmtNum(v), "Users"]} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {byPlan.map((entry, i) => <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Users by status & provider" desc="Account health mix">
              <div className="space-y-3">
                <div>
                  <p className="mb-1.5 text-[11px] uppercase tracking-wider text-white/40">Status</p>
                  <div className="flex flex-wrap gap-2">
                    {byStatus.map((s, i) => (
                      <span key={s.name} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/70">
                        <span className="h-2 w-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                        <span className="capitalize">{s.name}</span>
                        <span className="num text-white/45">{fmtNum(s.value)}</span>
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-[11px] uppercase tracking-wider text-white/40">Auth provider</p>
                  <div className="flex flex-wrap gap-2">
                    {byProvider.map((s, i) => (
                      <span key={s.name} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/70">
                        <span className="h-2 w-2 rounded-full" style={{ background: PIE_COLORS[(i + 3) % PIE_COLORS.length] }} />
                        <span className="capitalize">{s.name}</span>
                        <span className="num text-white/45">{fmtNum(s.value)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
