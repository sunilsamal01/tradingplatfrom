// Public pricing catalogue client. Fetches *published* plans from the backend
// so the pricing page never hardcodes plan names or amounts.
import { api } from "./api.js";

/** Published plans for the public pricing page. */
export const fetchPublishedPlans = () => api.get("/plans").then((d) => d?.plans || []);

/** Currency-aware price formatting from integer cents. */
export function formatPlanPrice(plan) {
  const cents = Number(plan?.priceCents ?? 0);
  const currency = plan?.currency || "USD";
  const symbol = currency === "USD" ? "$" : currency === "INR" ? "₹" : `${currency} `;
  // Show cents only when needed (e.g. $20 vs $20.50).
  const value = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return { symbol, value, display: `${symbol}${value}` };
}

/** Billing-interval label, e.g. "/month". */
export const intervalLabel = (plan) => {
  const n = Number(plan?.intervalCount || 1);
  const unit = plan?.interval === "year" ? (n > 1 ? "years" : "year") : (n > 1 ? "months" : "month");
  return n > 1 ? `/${n} ${unit}` : `/${unit}`;
};

/** Human label for a metered limit. -1 / nullish means unmetered. */
export const formatLimit = (n) =>
  n === -1 || n === null || n === undefined ? "Unlimited" : Number(n).toLocaleString("en-US");
