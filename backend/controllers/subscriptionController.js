import Payment from '../models/Payment.js';
import Purchase from '../models/Purchase.js';
import Subscription from '../models/Subscription.js';
import Usage from '../models/Usage.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { paginate } from '../utils/sanitize.js';
import { activateSubscription, cancelSubscription, currentSubscription, listPurchasablePlans, resolvePlanForEntitlement, effectiveEntitlement, limitStatus } from '../services/subscriptionService.js';
import { resolveCheckoutPlan } from '../services/paymentService.js';
import { sendSubscriptionEmail } from '../services/emailService.js';
import User from '../models/User.js';

/**
 * Authorise activation of a paid plan from a client-supplied payment id.
 *
 * Three things must ALL hold, or a user could upgrade for free:
 *   1. the payment exists, belongs to the caller, and is provider-confirmed paid;
 *   2. it was raised FOR THE SAME PLAN (a cheap-tier payment can never activate a
 *      more expensive tier);
 *   3. it has not already been consumed by another Subscription, so a single
 *      payment cannot be replayed to extend entitlement repeatedly.
 *
 * Returns { ok:true, payment } or { ok:false, reason }.
 */
/**
 * Pure predicate: does a stored payment's plan reference match the plan being
 * activated? Extracted so the plan-matching rule is unit-testable without a DB.
 */
export const paymentMatchesPlan = (paymentPlan, planSlug) =>
  String(paymentPlan || '').trim().toLowerCase() === String(planSlug || '').trim().toLowerCase();

async function authorisePaidActivation({ userId, paymentId, planSlug }) {
  if (!paymentId) return { ok: false, reason: 'MISSING_PAYMENT' };
  const pay = await Payment.findOne({ _id: paymentId, userId, status: 'paid' });
  if (!pay) return { ok: false, reason: 'NO_VERIFIED_PAYMENT' };
  if (!paymentMatchesPlan(pay.plan, planSlug)) return { ok: false, reason: 'PLAN_MISMATCH' };
  const used = await Subscription.exists({ paymentId: pay._id });
  if (used) return { ok: false, reason: 'PAYMENT_ALREADY_USED' };
  return { ok: true, payment: pay };
}

const activationError = (res, reason) => {
  if (reason === 'PLAN_MISMATCH') {
    return res.status(409).json({ success: false, message: 'This payment was raised for a different plan', code: reason });
  }
  if (reason === 'PAYMENT_ALREADY_USED') {
    return res.status(409).json({ success: false, message: 'This payment has already been applied to a subscription', code: reason });
  }
  return res.status(402).json({ success: false, message: 'Paid plan requires a verified payment first', code: 'PAYMENT_REQUIRED' });
};


// Published catalogue from the Plan collection — the source of truth for
// pricing. The frontend never hardcodes plan names or amounts.
export const plans = asyncHandler(async (_req, res) => ok(res, 'OK', { plans: await listPurchasablePlans() }));

export const create = asyncHandler(async (req, res) => {
  const { plan } = req.body;
  // Reject unknown/unpublished/archived plans before any entitlement work.
  const resolved = await resolveCheckoutPlan(plan);
  if (resolved.priceCents > 0) {
    // Paid plans activate ONLY against a provider-verified paid Payment that
    // matches this plan and has not already been consumed. Never trust the client.
    const check = await authorisePaidActivation({ userId: req.user.sub, paymentId: req.body.paymentId, planSlug: resolved.slug });
    if (!check.ok) return activationError(res, check.reason);
  }
  const sub = await activateSubscription(req.user.sub, resolved.slug, req.body.paymentId || null);
  await User.findByIdAndUpdate(req.user.sub, { plan: resolved.slug, currentSubscription: sub._id, subscriptionStatus: 'active', subscriptionExpiresAt: sub.expiresAt });
  const u = await User.findById(req.user.sub);
  if (u) await sendSubscriptionEmail(u.email, resolved.name).catch(() => {});
  return ok(res, 'Subscription activated', { subscription: sub }, 201);
});
export const cancel = asyncHandler(async (req, res) => { const s = await cancelSubscription(req.user.sub); await User.findByIdAndUpdate(req.user.sub, { subscriptionStatus: 'cancelled' }); return ok(res, 'Cancelled', { subscription: s }); });
export const change = asyncHandler(async (req, res) => {
  const { plan } = req.body;
  const resolved = await resolvePlanForEntitlement(plan);
  if (!resolved) return res.status(400).json({ success: false, message: 'Invalid plan' });
  // Switching to a paid plan still requires a verified, plan-matched, unused payment.
  if (resolved.priceCents > 0) {
    const check = await authorisePaidActivation({ userId: req.user.sub, paymentId: req.body.paymentId, planSlug: resolved.slug });
    if (!check.ok) return activationError(res, check.reason);
  }
  const s = await activateSubscription(req.user.sub, resolved.slug, req.body.paymentId || null);
  await User.findByIdAndUpdate(req.user.sub, { plan: resolved.slug, currentSubscription: s._id });
  return ok(res, 'Plan changed', { subscription: s });
});
export const current = asyncHandler(async (req, res) => {
  const [s, user] = await Promise.all([
    currentSubscription(req.user.sub),
    User.findById(req.user.sub).select('plan').lean(),
  ]);
  // The plan's real benefits travel with the subscription so the profile can
  // show exactly what the user gets, not just a raw slug.
  const plan = await effectiveEntitlement(s?.plan || user?.plan || 'FREE');
  return ok(res, 'OK', { subscription: s, plan });
});

/** GET /api/subscriptions/entitlements — effective plan + limits for the caller. */
export const entitlements = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).select('plan').lean();
  return ok(res, 'OK', await effectiveEntitlement(user?.plan || 'FREE'));
});

/** GET /api/subscriptions/usage — current AI-usage against the plan's allowance. */
export const usage = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).select('plan').lean();
  const ent = await effectiveEntitlement(user?.plan || 'FREE');
  const u = await Usage.findOne({ userId: req.user.sub }).lean();
  const used = u && u.period === new Date().toISOString().slice(0, 7) ? u.aiCalls : 0;
  return ok(res, 'OK', { plan: ent.plan, name: ent.name, ...limitStatus(ent.limits.aiLimit, used) });
});
export const billing = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const [payments, total, purchases] = await Promise.all([
    Payment.find({ userId: req.user.sub }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Payment.countDocuments({ userId: req.user.sub }),
    Purchase.find({ userId: req.user.sub }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  // Only payment metadata is exposed — no provider secrets or raw signatures.
  const items = payments.map((p) => ({ id: p._id, plan: p.plan, amount: p.amount, currency: p.currency || 'INR', provider: p.provider, status: p.status, createdAt: p.createdAt, purchaseRef: purchases.find((q) => String(q.paymentId) === String(p._id))?.orderId || null }));
  return ok(res, 'OK', { items, page, limit, total });
});
