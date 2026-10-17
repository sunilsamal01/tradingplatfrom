export const PLANS = {
  FREE: { id: 'FREE', name: 'Hunter', priceINR: 0, aiLimit: 100, features: ['basic'] },
  HUNTER: { id: 'HUNTER', name: 'Hunter', priceINR: 0, aiLimit: 100, features: ['basic'] },
  AWAKENED: { id: 'AWAKENED', name: 'Awakened', priceINR: 999, aiLimit: 2000, features: ['advanced'] },
  MONARCH: { id: 'MONARCH', name: 'Monarch', priceINR: 2499, aiLimit: 10000, features: ['all'] },
};
export const PLAN_IDS = Object.keys(PLANS);
export function getPlan(id) { const p = PLANS[String(id || '').toUpperCase()]; if (!p) throw Object.assign(new Error('Invalid plan'), { statusCode: 400 }); return p; }

// Safe AI-limit lookup for metering. Paid tiers live in the Plan collection
// (slugs like starter/pro/elite/ultimate) and are NOT in this legacy map, so an
// unknown slug must degrade to the free allowance instead of throwing — a
// metered endpoint must never 500 just because the plan is DB-backed.
export function planAiLimit(planId) {
  const p = PLANS[String(planId || '').toUpperCase()];
  return Number.isFinite(p?.aiLimit) ? p.aiLimit : PLANS.FREE.aiLimit;
}
export function checkUsageLimit(planId, used) {
  const limit = planAiLimit(planId);
  return { allowed: used < limit, limit, remaining: Math.max(0, limit - used) };
}
