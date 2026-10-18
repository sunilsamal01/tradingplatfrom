// Enterprise admin data service — every figure here is computed from the
// real Mongoose collections (no sample/mock fallbacks). Revenue arithmetic is
// deliberately conservative: gross = sum(paid), refunds = sum(refunded),
// net = gross − refunds. Payment rows transition to 'refunded' only after the
// payment provider confirms the refund (see refundPayment in adminController).
import mongoose from 'mongoose';
import User from '../models/User.js';
import Payment from '../models/Payment.js';
import Purchase from '../models/Purchase.js';
import Subscription from '../models/Subscription.js';
import Session from '../models/Session.js';
import ActivityLog from '../models/ActivityLog.js';
import AuditLog from '../models/AuditLog.js';
import LoginHistory from '../models/LoginHistory.js';
import Notification from '../models/Notification.js';
import { Call, LiveSession } from '../models/Comms.js';
import { Conversation, Message, ConversationMember, CommunityReport } from '../models/Community.js';
import { PLANS } from '../config/plans.js';
import CheckoutOrder from '../models/CheckoutOrder.js';
import env from '../config/env.js';
import { paymentProvider } from '../config/payment.js';

const oid = (id) => mongoose.isValidObjectId(id);
// Aggregation expression that buckets a date field by UTC day (YYYY-MM-DD).
// NOTE: this is a Mongo expression object for use inside $group stages, not a
// JS formatter — calling a JS Date formatter with '$createdAt' yields Invalid Date.
const dayExpr = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: `$${field}` } });

function periodRange(from, to) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 3600e3);
  return { start, end };
}
// Previous window of equal length, for period-over-period comparisons.
function prevRange({ start, end }) {
  const span = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - span), end: start };
}

const money = (n) => Math.round((n || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Overview / executive dashboard
// ---------------------------------------------------------------------------
export async function overview({ from, to } = {}) {
  const range = periodRange(from, to);
  const prev = prevRange(range);
  const inRange = (field, r = range) => ({ [field]: { $gte: r.start, $lt: r.end } });

  const [
    usersTotal, usersNew, usersNewPrev, usersActive, verified, byStatus,
    subsActive, subsNew, subsNewPrev, subsCancelled,
    paidAgg, refundAgg, failCount, paidPrevAgg, failPrevCount,
    regByDay, revByDay, paymentsByDay,
    recentPayments, recentUsers, recentAdminActions,
    sessionsActive, notifUnread, newLogins, failedLogins,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments(inRange('createdAt')),
    User.countDocuments(inRange('createdAt', prev)),
    User.countDocuments({ lastActiveAt: { $gte: range.start } }),
    User.countDocuments({ emailVerified: true }),
    User.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Subscription.countDocuments({ status: 'active' }),
    Subscription.countDocuments(inRange('createdAt')),
    Subscription.countDocuments(inRange('createdAt', prev)),
    Subscription.countDocuments({ status: { $in: ['cancelled', 'expired'] }, updatedAt: { $gte: range.start, $lt: range.end } }),
    Payment.aggregate([
      { $match: { status: 'paid', createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: 'refunded', createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.countDocuments({ status: 'failed', createdAt: { $gte: range.start, $lt: range.end } }),
    Payment.aggregate([
      { $match: { status: 'paid', createdAt: { $gte: prev.start, $lt: prev.end } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.countDocuments({ status: 'failed', createdAt: { $gte: prev.start, $lt: prev.end } }),
    User.aggregate([
      { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: dayExpr('createdAt'), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([
      { $match: { status: 'paid', createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: dayExpr('createdAt'), amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([
      { $match: { createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: { day: dayExpr('createdAt'), status: '$status' }, count: { $sum: 1 } } },
    ]),
    Payment.find({ createdAt: { $gte: range.start, $lt: range.end } })
      .sort({ createdAt: -1 }).limit(8)
      .populate('userId', 'email firstName lastName').lean(),
    User.find({ createdAt: { $gte: range.start, $lt: range.end } })
      .sort({ createdAt: -1 }).limit(6)
      .select('email firstName lastName status plan createdAt').lean(),
    AuditLog.find({}).sort({ createdAt: -1 }).limit(8)
      .populate('actorId', 'email role').lean(),
    Session.countDocuments({ expiresAt: { $gt: new Date() }, revoked: false }),
    Notification.countDocuments({ userId: null, read: false }),
    LoginHistory.countDocuments({ success: true, createdAt: { $gte: range.start, $lt: range.end } }),
    LoginHistory.countDocuments({ success: false, createdAt: { $gte: range.start, $lt: range.end } }),
  ]);

  const gross = paidAgg[0]?.amount || 0;
  const refunds = refundAgg[0]?.amount || 0;
  const prevGross = paidPrevAgg[0]?.amount || 0;
  const pct = (cur, base) => (base ? Math.round(((cur - base) / base) * 1000) / 10 : (cur ? 100 : 0));

  const statusMap = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));

  return {
    range: { from: range.start.toISOString(), to: range.end.toISOString() },
    kpis: {
      users: { total: usersTotal, new: usersNew, newPrev: usersNewPrev, newPct: pct(usersNew, usersNewPrev), active: usersActive, verified, unverified: usersTotal - verified, byStatus: statusMap },
      subscriptions: { active: subsActive, new: subsNew, newPrev: subsNewPrev, newPct: pct(subsNew, subsNewPrev), cancelledOrExpired: subsCancelled },
      revenue: {
        gross: money(gross), refunds: money(refunds), net: money(gross - refunds),
        grossPrev: money(prevGross), netPct: pct(gross - refunds, prevGross - (refundAgg[0]?.amount || 0)),
        paidCount: paidAgg[0]?.count || 0, refundCount: refundAgg[0]?.count || 0,
        failed: failCount, failedPrev: failPrevCount,
        successRate: (paidAgg[0]?.count || 0) + failCount
          ? Math.round(((paidAgg[0]?.count || 0) / ((paidAgg[0]?.count || 0) + failCount)) * 1000) / 10
          : 0,
        currency: 'INR',
      },
      security: { activeSessions: sessionsActive, newLogins, failedLogins, broadcastsPending: notifUnread },
    },
    trends: {
      registrations: regByDay.map((r) => ({ date: r._id, value: r.count })),
      revenue: revByDay.map((r) => ({ date: r._id, value: money(r.amount), count: r.count })),
      payments: paymentsByDay.reduce((acc, r) => {
        const day = acc.find((x) => x.date === r._id.day) || { date: r._id.day, paid: 0, failed: 0, refunded: 0, created: 0 };
        day[r._id.status] = (day[r._id.status] || 0) + r.count;
        if (!acc.includes(day)) acc.push(day);
        return acc;
      }, []).sort((a, b) => a.date.localeCompare(b.date)),
    },
    recent: { payments: recentPayments, users: recentUsers, adminActions: recentAdminActions },
  };
}

// ---------------------------------------------------------------------------
// User management — server-side search / filter / sort / pagination
// ---------------------------------------------------------------------------
const USER_SORT = {
  createdAt: 'createdAt', lastActiveAt: 'lastActiveAt', email: 'email',
  name: 'firstName', plan: 'plan', status: 'status', role: 'role',
};

export async function listUsers({ q, status, plan, role, verified, from, to, lastActiveFrom, sort = 'createdAt', dir = 'desc', page = 1, limit = 20 } = {}) {
  const filter = {};
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }, { username: rx }, ...(oid(q) ? [{ _id: q }] : [])];
  }
  if (status) filter.status = status;
  if (plan) filter.plan = plan;
  if (role) filter.role = role;
  if (verified === 'true' || verified === true) filter.emailVerified = true;
  if (verified === 'false' || verified === false) filter.emailVerified = false;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (lastActiveFrom) filter.lastActiveAt = { $gte: new Date(lastActiveFrom) };

  const sortField = USER_SORT[sort] || 'createdAt';
  const sortDir = dir === 'asc' ? 1 : -1;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const [total, items] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .select('email firstName lastName username status plan role emailVerified lastActiveAt createdAt authProvider')
      .sort({ [sortField]: sortDir, _id: sortDir })
      .skip((p - 1) * l).limit(l).lean(),
  ]);

  return { items, total, page: p, pages: Math.max(1, Math.ceil(total / l)), limit: l };
}

export async function userDetail(id) {
  if (!oid(id)) return null;
  const user = await User.findById(id)
    .select('email firstName lastName username status plan role emailVerified emailVerifiedAt lastActiveAt createdAt authProvider preferences phone country timezone bio notes subscriptionStatus subscriptionExpiresAt').lean();
  if (!user) return null;
  const [subscription, payments, purchases, sessions, activity, audit, loginHistory, reports] = await Promise.all([
    Subscription.findOne({ userId: id }).sort({ createdAt: -1 }).lean(),
    Payment.find({ userId: id }).sort({ createdAt: -1 }).limit(25).lean(),
    Purchase.find({ userId: id }).sort({ createdAt: -1 }).limit(25).lean(),
    Session.find({ userId: id }).sort({ createdAt: -1 }).limit(20).lean(),
    ActivityLog.find({ userId: id }).sort({ createdAt: -1 }).limit(50).lean(),
    AuditLog.find({ target: String(id) }).sort({ createdAt: -1 }).limit(50).populate('actorId', 'email role').lean(),
    LoginHistory.find({ userId: id }).sort({ createdAt: -1 }).limit(30).lean(),
    CommunityReport.find({ $or: [{ targetType: 'user', targetId: id }, { reporterId: id }] })
      .sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  return { user, subscription, payments, purchases, sessions, activity, audit, loginHistory, reports };
}

// Whitelist only — mass assignment from req.body would let an attacker promote
// their own role or set passwordHash. Never forward the raw body.
const USER_EDITABLE = ['firstName', 'lastName', 'username', 'phone', 'country', 'timezone', 'bio'];
export function userUpdatePatch(body = {}) {
  const patch = {};
  for (const k of USER_EDITABLE) if (body[k] !== undefined) patch[k] = body[k];
  if (body.preferences && typeof body.preferences === 'object') {
    patch.preferences = { ...(body.preferences || {}) };
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Transactions / payments
// ---------------------------------------------------------------------------
export async function listPayments({ q, status, provider, currency, userId, from, to, minAmount, maxAmount, sort = 'createdAt', dir = 'desc', page = 1, limit = 20 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (provider) filter.provider = provider;
  if (currency) filter.currency = currency;
  if (userId && oid(userId)) filter.userId = userId;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (minAmount || maxAmount) {
    filter.amount = {};
    if (minAmount) filter.amount.$gte = Number(minAmount);
    if (maxAmount) filter.amount.$lte = Number(maxAmount);
  }
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or = [{ providerOrderId: rx }, { providerPaymentId: rx }, { plan: rx }];
    if (oid(q)) or.push({ _id: q });
    filter.$or = or;
  }
  const sortField = ['createdAt', 'amount', 'status', 'provider'].includes(sort) ? sort : 'createdAt';
  const sortDir = dir === 'asc' ? 1 : -1;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const [total, items, byStatus] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).populate('userId', 'email firstName lastName')
      .sort({ [sortField]: sortDir, _id: sortDir }).skip((p - 1) * l).limit(l).lean(),
    Payment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
  ]);
  return {
    items, total, page: p, pages: Math.max(1, Math.ceil(total / l)), limit: l,
    summary: byStatus.reduce((a, r) => { a[r._id] = { count: r.count, amount: money(r.amount) }; return a; }, {}),
  };
}

// ---------------------------------------------------------------------------
// Unified checkout orders (admin search + detail)
// ---------------------------------------------------------------------------

/**
 * Search purchase orders created through the unified checkout. Supports the
 * full filter set: date range, status, order type, user, amount range, free text.
 * Money is returned in INTEGER CENTS alongside its currency — totals are never
 * summed across currencies.
 */
export async function listCheckoutOrders({ q, status, type, userId, from, to, minAmount, maxAmount, sort = 'createdAt', dir = 'desc', page = 1, limit = 20 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (type && ['subscription', 'crypto'].includes(type)) filter.type = type;
  if (userId && oid(userId)) filter.userId = userId;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (minAmount || maxAmount) {
    filter.totalCents = {};
    if (minAmount) filter.totalCents.$gte = Math.round(Number(minAmount));
    if (maxAmount) filter.totalCents.$lte = Math.round(Number(maxAmount));
  }
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or = [{ reference: rx }, { planSlug: rx }, { planName: rx }, { providerOrderId: rx }];
    if (oid(q)) or.push({ _id: q });
    // Top-level keys are ANDed, so this composes correctly with userId/status/type.
    filter.$or = or;
  }
  const sortField = ['createdAt', 'totalCents', 'status', 'type'].includes(sort) ? sort : 'createdAt';
  const sortDir = dir === 'asc' ? 1 : -1;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const [total, items, byStatus, byCurrency] = await Promise.all([
    CheckoutOrder.countDocuments(filter),
    CheckoutOrder.find(filter).populate('userId', 'email firstName lastName')
      .sort({ [sortField]: sortDir, _id: sortDir }).skip((p - 1) * l).limit(l).lean(),
    CheckoutOrder.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    CheckoutOrder.aggregate([{ $match: filter }, { $group: { _id: '$currency', totalCents: { $sum: '$totalCents' }, count: { $sum: 1 } } }]),
  ]);
  return {
    items, total, page: p, pages: Math.max(1, Math.ceil(total / l)), limit: l,
    summary: byStatus.reduce((a, r) => { a[r._id] = r.count; return a; }, {}),
    // Per-currency totals: never merged into a single misleading number.
    totalsByCurrency: byCurrency.map((r) => ({ currency: r._id || 'USD', totalCents: r.totalCents, count: r.count })),
  };
}

/** Full order detail incl. linked payment + provider references. */
export async function checkoutOrderDetail(id) {
  if (!oid(id)) return null;
  const order = await CheckoutOrder.findById(id).populate('userId', 'email firstName lastName plan subscriptionStatus').lean();
  if (!order) return null;
  const payment = order.paymentId
    ? await Payment.findById(order.paymentId).lean()
    : await Payment.findOne({ providerOrderId: order.providerOrderId || '__none__' }).lean();
  return { order, payment: payment || null };
}

/**
 * Provider configuration status for the admin panel.
 * Reports PRESENCE of credentials and the operating mode only — secret values
 * are never returned, not even partially masked.
 */
export async function providerConfigStatus() {
  const provider = paymentProvider();
  const rzpKeysSet = !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET;
  const stripeKeySet = !!env.STRIPE_SECRET_KEY;
  const { whopConfigured, whopWebhookConfigured, whopEnvironment, recommendedWebhookUrl } = await import('./whopService.js');
  const whopKeysSet = whopConfigured();
  const active = provider === 'stripe' ? stripeKeySet
    : provider === 'whop' ? whopKeysSet
      : rzpKeysSet;
  const warnings = [];
  if (!active) {
    warnings.push(provider === 'whop'
      ? 'No Whop credentials are configured. Subscriptions cannot start until WHOP_COMPANY_API_KEY and WHOP_COMPANY_ID are added, and each plan is linked to a Whop variant id.'
      : `No ${provider} credentials are configured. Checkout cannot create live orders until keys are added to the server environment.`);
  }
  if (provider === 'razorpay' && !env.RAZORPAY_WEBHOOK_SECRET) {
    warnings.push('RAZORPAY_WEBHOOK_SECRET is missing — webhook signatures cannot be verified, so payments will never be marked paid automatically.');
  }
  if (provider === 'stripe' && !env.STRIPE_WEBHOOK_SECRET) {
    warnings.push('STRIPE_WEBHOOK_SECRET is missing — Stripe events are not verified over a webhook. Customers who return from checkout still settle server-side (Stripe is queried directly), but a checkout abandoned before returning will never finish on its own. Point a webhook at checkout.session.completed to close that gap.');
  }
  if (provider === 'whop' && !whopWebhookConfigured()) {
    warnings.push('WHOP_WEBHOOK_SECRET is missing — Whop events cannot be verified, so a paid subscription would never be activated (and no wallet top-up would be credited). Register the webhook and copy its ws_ secret.');
  }
  // Live/test mode is inferred from the key shape (Razorpay: rzp_live_ /
  // rzp_test_) or, for Whop, from WHOP_SANDBOX.
  let mode = 'unknown';
  if (provider === 'razorpay' && env.RAZORPAY_KEY_ID) mode = env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
  if (provider === 'stripe' && env.STRIPE_SECRET_KEY) mode = env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
  if (provider === 'whop' && whopKeysSet) mode = whopEnvironment() === 'production' ? 'live' : 'sandbox';
  if (mode === 'live') warnings.push('LIVE MODE: real money will be charged. Confirm merchant activation and webhook configuration before accepting traffic.');
  // Every supported provider is driven by its official checkout — hosted for
  // Razorpay/Stripe, embedded in our own page for Whop — so there is no
  // "provider not wired up" case to warn about any more.

  const { cryptoSettlementStatus } = await import('./checkoutService.js');
  return {
    provider,
    mode,
    configured: active,
    // Presence flags only — no values, no prefixes of values.
    credentials: {
      razorpay: { keyId: rzpKeysSet, keySecret: rzpKeysSet, webhookSecret: !!env.RAZORPAY_WEBHOOK_SECRET },
      stripe: { secretKey: stripeKeySet, webhookSecret: !!env.STRIPE_WEBHOOK_SECRET },
      whop: { apiKey: !!env.WHOP_COMPANY_API_KEY, companyId: !!env.WHOP_COMPANY_ID, webhookSecret: !!env.WHOP_WEBHOOK_SECRET },
    },
    activeProviderConfigured: active,
    // Where the operator must register the webhook, when we can determine it.
    // Never APP_URL: that origin rejects POST, so a webhook there never fires.
    webhookUrl: provider === 'whop' ? recommendedWebhookUrl() : null,
    webhookVerified: provider === 'stripe' ? !!env.STRIPE_WEBHOOK_SECRET
      : provider === 'whop' ? whopWebhookConfigured()
        : !!env.RAZORPAY_WEBHOOK_SECRET,
    crypto: cryptoSettlementStatus(),
    checkout: {
      quoteTtlSeconds: env.QUOTE_TTL_SECONDS,
      cryptoFeeBps: env.CRYPTO_FEE_BPS,
      taxBps: env.CHECKOUT_TAX_BPS,
      taxConfigured: env.CHECKOUT_TAX_BPS > 0,
    },
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Subscriptions + revenue analytics
// ---------------------------------------------------------------------------

// Price resolution for analytics: DB Plan catalogue first (authoritative),
// legacy config as fallback for subscribers on pre-migration tier ids.
// Returns cents (integer) + currency so mixed-currency totals never collide.
async function buildPlanPriceMap() {
  const map = new Map(); // key(lowercased plan ref) -> { priceCents, currency, interval, name, slug }
  const { default: Plan } = await import('../models/Plan.js');
  const dbPlans = await Plan.find({}).lean();
  for (const p of dbPlans) {
    const key = String(p.slug || p._id).toLowerCase();
    map.set(key, {
      priceCents: p.priceCents ?? 0,
      currency: (p.currency || 'USD').toUpperCase(),
      interval: p.interval || 'month',
      name: p.name, slug: p.slug,
      features: Array.isArray(p.features) ? p.features : [],
    });
  }
  // Legacy tiers (HUNTER/AWAKENED/MONARCH…) still held by old subscribers.
  for (const [id, p] of Object.entries(PLANS)) {
    const key = id.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        priceCents: Math.round((p.priceINR ?? p.price ?? 0) * 100),
        currency: 'INR', interval: 'month', name: p.name || id, slug: id, legacy: true,
        features: Array.isArray(p.features) ? p.features : [],
      });
    }
  }
  return map;
}

/** Monthly-normalised amount for a plan, in that plan's own currency. */
function monthlyCents(entry) {
  if (!entry) return { cents: 0, currency: 'USD' };
  const cents = entry.interval === 'year' ? Math.round(entry.priceCents / 12) : entry.priceCents;
  return { cents, currency: entry.currency };
}

export async function subscriptionAnalytics({ from, to } = {}) {
  const range = periodRange(from, to);
  const [priceMap, byStatus, byPlan, activeSubs, newInRange, churnedInRange, paymentsByPlan] = await Promise.all([
    buildPlanPriceMap(),
    Subscription.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Subscription.aggregate([
      { $group: { _id: { plan: '$plan', status: '$status' }, count: { $sum: 1 } } },
      { $sort: { '_id.plan': 1 } },
    ]),
    Subscription.find({ status: 'active' }).select('plan status expiresAt').lean(),
    Subscription.countDocuments({ createdAt: { $gte: range.start, $lt: range.end } }),
    Subscription.countDocuments({ status: { $in: ['cancelled', 'expired'] }, updatedAt: { $gte: range.start, $lt: range.end } }),
    // Group by plan AND currency — summing ₹ and $ into one figure would be wrong.
    Payment.aggregate([
      { $match: { status: 'paid', createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: { plan: '$plan', currency: '$currency' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
  ]);

  // MRR: sum of configured plan prices across active subs, kept per-currency.
  const mrrByCurrency = {};
  for (const s of activeSubs) {
    const entry = priceMap.get(String(s.plan || '').toLowerCase());
    const { cents, currency } = monthlyCents(entry);
    mrrByCurrency[currency] = (mrrByCurrency[currency] || 0) + cents;
  }
  // Primary currency for display = the one with revenue, USD preferred.
  const currencies = Object.keys(mrrByCurrency).sort((a, b) => (a === 'USD' ? -1 : b === 'USD' ? 1 : 0));
  const mrrCurrency = currencies[0] || 'USD';
  const mrrMajor = (mrrByCurrency[mrrCurrency] || 0) / 100;

  // Revenue by plan, per currency (major units).
  const revenueByCurrency = {};
  const revenueByPlan = paymentsByPlan.map((r) => {
    const currency = (r._id?.currency || 'USD').toUpperCase();
    revenueByCurrency[currency] = money((revenueByCurrency[currency] || 0) + (r.amount || 0));
    return { plan: r._id?.plan || 'unknown', amount: money(r.amount), currency, count: r.count };
  });

  return {
    range: { from: range.start.toISOString(), to: range.end.toISOString() },
    counts: byStatus.reduce((a, r) => { a[r._id || 'unknown'] = r.count; return a; }, {}),
    byPlan: byPlan.map((r) => ({ plan: r._id?.plan || r._id?.planId || 'unknown', status: r._id?.status || 'unknown', count: r.count })),
    // `mrr` stays the primary-currency figure (major units); `mrrByCurrency`
    // carries the full picture so nothing is silently summed across currencies.
    mrr: money(mrrMajor),
    mrrCurrency,
    mrrByCurrency: Object.fromEntries(Object.entries(mrrByCurrency).map(([c, v]) => [c, money(v / 100)])),
    active: activeSubs.length,
    newInRange,
    churnedInRange,
    churnRate: activeSubs.length ? Math.round((churnedInRange / (activeSubs.length + churnedInRange)) * 1000) / 10 : 0,
    revenueByPlan,
    revenueByCurrency,
    // Live catalogue from the Plan collection (source of truth for pricing).
    plans: dbPlanCatalogue(priceMap),
  };
}

function dbPlanCatalogue(priceMap) {
  const out = [];
  for (const [, v] of priceMap.entries()) {
    out.push({
      id: v.slug, name: v.name || v.slug, slug: v.slug,
      priceCents: v.priceCents, currency: v.currency, interval: v.interval,
      // Legacy-compatible alias so older UI code keeps rendering.
      priceINR: v.currency === 'INR' ? v.priceCents / 100 : null,
      priceUSD: v.currency === 'USD' ? v.priceCents / 100 : null,
      features: v.features || [],
      legacy: !!v.legacy,
    });
  }
  // Current tiers first (by slug order), legacy last.
  const order = ['starter', 'basic', 'pro', 'elite', 'ultimate'];
  return out.sort((a, b) => {
    const ia = order.indexOf(String(a.slug).toLowerCase());
    const ib = order.indexOf(String(b.slug).toLowerCase());
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return String(a.slug).localeCompare(String(b.slug));
  });
}

export async function listSubscriptions({ status, plan, from, to, page = 1, limit = 20, sort = 'createdAt', dir = 'desc' } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (plan) filter.plan = plan;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const sortField = ['createdAt', 'status', 'expiresAt', 'plan'].includes(sort) ? sort : 'createdAt';
  const sortDir = dir === 'asc' ? 1 : -1;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const [total, items] = await Promise.all([
    Subscription.countDocuments(filter),
    Subscription.find(filter).populate('userId', 'email firstName lastName')
      .sort({ [sortField]: sortDir, _id: sortDir }).skip((p - 1) * l).limit(l).lean(),
  ]);
  return { items, total, page: p, pages: Math.max(1, Math.ceil(total / l)), limit: l };
}

// ---------------------------------------------------------------------------
// Activity / audit / security
// ---------------------------------------------------------------------------
export async function listActivity({ userId, action, from, to, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (userId && oid(userId)) filter.userId = userId;
  if (action) filter.action = new RegExp(String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const [total, items] = await Promise.all([
    ActivityLog.countDocuments(filter),
    ActivityLog.find(filter).populate('userId', 'email role').sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
  ]);
  return { items, total, page: p, pages: Math.max(1, Math.ceil(total / l)), limit: l };
}

export async function listAudit({ actorId, action, from, to, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (actorId && oid(actorId)) filter.actorId = actorId;
  if (action) filter.action = new RegExp(String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const [total, items] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter).populate('actorId', 'email role').sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
  ]);
  return { items, total, page: p, pages: Math.max(1, Math.ceil(total / l)), limit: l };
}

export async function securityOverview({ from, to } = {}) {
  const range = periodRange(from, to);
  const [recentLogins, failedByDay, failedByIp, activeSessions, recentAudit] = await Promise.all([
    LoginHistory.find({ createdAt: { $gte: range.start, $lt: range.end } })
      .populate('userId', 'email role status').sort({ createdAt: -1 }).limit(50).lean(),
    LoginHistory.aggregate([
      { $match: { success: false, createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: dayExpr('createdAt'), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    LoginHistory.aggregate([
      { $match: { success: false, createdAt: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: '$ip', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Session.find({ expiresAt: { $gt: new Date() }, revoked: false }).populate('userId', 'email role')
      .sort({ createdAt: -1 }).limit(50).lean(),
    AuditLog.find({}).sort({ createdAt: -1 }).limit(40).populate('actorId', 'email role').lean(),
  ]);
  return {
    range: { from: range.start.toISOString(), to: range.end.toISOString() },
    logins: recentLogins,
    failedByDay: failedByDay.map((r) => ({ date: r._id, value: r.count })),
    failedByIp,
    activeSessions,
    recentAudit,
    totals: {
      failed: failedByDay.reduce((s, r) => s + r.count, 0),
      activeSessions: activeSessions.length,
    },
  };
}

export async function health() {
  const dbState = mongoose.connection?.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
  const names = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  let counts = {};
  try {
    const [users, payments, subs, calls, lives] = await Promise.all([
      User.estimatedDocumentCount(), Payment.estimatedDocumentCount(),
      Subscription.estimatedDocumentCount(), Call.estimatedDocumentCount(),
      LiveSession.estimatedDocumentCount(),
    ]);
    counts = { users, payments, subscriptions: subs, calls, liveSessions: lives };
  } catch { /* DB unreachable — reported via state */ }
  const mem = process.memoryUsage();
  return {
    status: dbState === 1 ? 'healthy' : 'degraded',
    uptimeSec: Math.round(process.uptime()),
    db: { state: names[dbState] || String(dbState), name: mongoose.connection?.name || null },
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
    node: process.version,
    counts,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Messaging — admin ↔ user direct threads (reuses the community Conversation
// + Message models so the user's existing inbox/notifications keep working).
// ---------------------------------------------------------------------------
async function findOrCreateDm(adminId, userId) {
  let conv = await Conversation.findOne({
    type: 'direct',
    directMembers: { $all: [adminId, userId], $size: 2 },
  });
  if (conv) return conv;
  conv = await Conversation.create({
    type: 'direct', name: null, ownerId: adminId,
    directMembers: [adminId, userId], memberCount: 2, joinPolicy: 'invite',
  });
  await ConversationMember.insertMany([
    { conversationId: conv._id, userId: adminId },
    { conversationId: conv._id, userId },
  ], { ordered: false }).catch(() => {});
  return conv;
}

export async function listConversations({ q, userId, page = 1, limit = 30 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const filter = { type: 'direct' };
  if (userId && oid(userId)) filter.directMembers = userId;
  let rows = await Conversation.find(filter).sort({ updatedAt: -1 }).skip((p - 1) * l).limit(l).lean();
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const hits = await User.find({ $or: [{ email: rx }, { firstName: rx }, { lastName: rx }] }).select('_id').limit(200).lean();
    const ids = new Set(hits.map((h) => String(h._id)));
    rows = rows.filter((r) => (r.directMembers || []).some((m) => ids.has(String(m))));
  }
  const otherIds = rows.flatMap((r) => r.directMembers || []);
  const others = await User.find({ _id: { $in: otherIds } }).select('email firstName lastName avatar role').lean();
  const byId = Object.fromEntries(others.map((u) => [String(u._id), u]));
  const items = await Promise.all(rows.map(async (r) => {
    const last = await Message.findOne({ conversationId: r._id }).sort({ createdAt: -1 }).lean();
    const othersIn = (r.directMembers || []).map((m) => byId[String(m)]).filter(Boolean);
    return { _id: r._id, updatedAt: r.updatedAt, lastMessage: last ? { content: last.content?.slice?.(0, 160) || '', senderId: last.senderId, createdAt: last.createdAt } : null, participants: othersIn };
  }));
  return { items, total: items.length, page: p, pages: 1, limit: l };
}

export async function threadMessages(conversationId, { before, limit = 50 } = {}) {
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const filter = { conversationId };
  if (before) filter.createdAt = { $lt: new Date(before) };
  const items = await Message.find(filter).sort({ createdAt: -1 }).limit(l)
    .populate('senderId', 'email firstName lastName role avatar').lean();
  return items;
}

export async function sendAdminMessage(adminId, { userId, conversationId, content }) {
  if (!content || !String(content).trim()) throw Object.assign(new Error('Message content required'), { status: 400 });
  const conv = conversationId
    ? await Conversation.findById(conversationId)
    : await findOrCreateDm(adminId, userId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (!conv.directMembers?.some((m) => String(m) === String(adminId))) {
    throw Object.assign(new Error('Not a participant'), { status: 403 });
  }
  const doc = await Message.create({
    conversationId: conv._id, senderId: adminId,
    type: 'text', content: String(content).slice(0, 4000),
  });
  conv.updatedAt = new Date();
  await conv.save();
  const io = globalThis.__io;
  if (io) {
    for (const m of conv.directMembers) io.to(`user:${m}`).emit('message:new', { conversationId: String(conv._id), message: doc });
  }
  return { conversation: conv, message: doc };
}

export { findOrCreateDm };
