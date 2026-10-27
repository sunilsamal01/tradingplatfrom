// Formatting + date-range helpers for the Admin Control Center. Kept in a
// non-component module so primitives.jsx stays Fast Refresh-compatible
// (component file exports components only).

export const fmtINR = (n, { decimals = 0 } = {}) =>
  n == null || Number.isNaN(Number(n))
    ? "—"
    : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}`;

/** USD formatter from INTEGER CENTS (the canonical stored value). */
export const fmtUSD = (cents, { decimals } = {}) => {
  if (cents == null || Number.isNaN(Number(cents))) return "—";
  const n = Number(cents) / 100;
  const dp = decimals ?? (Number(cents) % 100 === 0 ? 0 : 2);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};

/** Currency-aware money display for mixed INR/USD records. */
export const fmtMoney = (amount, currency = "USD", { fromCents = false, decimals } = {}) => {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  const n = fromCents ? Number(amount) / 100 : Number(amount);
  const dp = decimals ?? (fromCents && Number(amount) % 100 === 0 ? 0 : undefined);
  const opts = dp != null ? { minimumFractionDigits: dp, maximumFractionDigits: dp } : { maximumFractionDigits: 2 };
  const symbol = currency === "USD" ? "$" : currency === "INR" ? "₹" : "";
  const body = n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", opts);
  return symbol ? `${symbol}${body}` : `${currency} ${body}`;
};

/**
 * Money for a figure that may span currencies. With a known currency it is
 * formatted properly; when the currency is null the total mixes currencies, so
 * stamping a symbol on it would be a lie — say so instead.
 */
export const fmtAggregate = (amount, currency) => {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  if (currency) return fmtMoney(amount, currency);
  return `${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} (mixed)`;
};

export const fmtNum = (n) =>
  n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-IN");

export const fmtCompact = (n) => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n));
};

export const fmtDate = (d, { time = true } = {}) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("en-IN", time
    ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short", year: "numeric" });
};

export const fmtDuration = (sec) => {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
};

/** Relative "3m ago" label for activity feeds. */
export const fmtAgo = (d) => {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(d, { time: false });
};

const PRESETS = [
  { label: "Today", days: 0 },
  { label: "7 days", days: 6 },
  { label: "30 days", days: 29 },
  { label: "90 days", days: 89 },
  { label: "12 months", days: 364 },
];

export const RANGE_PRESETS = PRESETS;

export function rangeForPreset(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - days);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Default range used when a page first loads (last 30 days). */
export const defaultRange = () => ({ ...rangeForPreset(29), label: "30 days" });
