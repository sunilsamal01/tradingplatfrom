import crypto from 'crypto';
import env from '../config/env.js';
import { paymentProvider as _pp, razorpayClient, stripeClient } from '../config/payment.js';
export const paymentProvider = _pp;
import { getPlan } from '../config/plans.js';
import { findPlan, resolvePurchasablePlan } from './planService.js';
import { logger } from '../utils/logger.js';

// Client-facing wording: honest and actionable, but never names internal env
// vars or configuration details. The precise cause is logged server-side and
// surfaced to administrators only, via the admin provider-status endpoint.
const NOT_CONFIGURED_MSG = 'Payments are temporarily unavailable while the payment provider is being set up. Please try again shortly or contact support.';

// ---------------------------------------------------------------------------
// Price resolution — THE server is the only source of truth. A client-submitted
// price is never read. New purchases resolve to a published Plan document;
// legacy plan ids (HUNTER/AWAKENED/MONARCH) fall back to the historical config
// so existing flows keep working while migrations land.
// ---------------------------------------------------------------------------

/**
 * Resolve a purchasable plan. Throws AppError(4xx) if the plan is missing,
 * draft or archived — enforcing "unpublished/archived plans cannot be bought".
 * Returns { id, name, priceCents, currency, slug }.
 */
export async function resolveCheckoutPlan(planRef) {
  const key = String(planRef || '').trim();
  if (!key) throw Object.assign(new Error('Plan is required'), { statusCode: 400, code: 'PLAN_REQUIRED' });
  // Preferred: the DB catalogue (source of truth for all new pricing).
  const dbPlan = await findPlan(key);
  if (dbPlan) {
    // Only published plans may be purchased (throws 409 if draft/archived).
    const purchasable = await resolvePurchasablePlan(dbPlan.slug);
    return {
      id: purchasable.slug, name: purchasable.name, slug: purchasable.slug,
      priceCents: purchasable.priceCents, currency: purchasable.currency || 'USD',
      interval: purchasable.interval || 'month',
    };
  }
  // Legacy fallback for pre-existing plan ids still referenced by old clients.
  const legacy = getPlan(key);
  return {
    id: legacy.id, name: legacy.name, slug: String(legacy.id).toLowerCase(),
    priceCents: Math.round((legacy.priceINR || 0) * 100), currency: 'INR',
    interval: 'month',
  };
}

/** Legacy sync helper kept for callers that pre-date the Plan collection. */
export function serverPriceForPlan(plan) { return getPlan(plan).priceINR; }

/**
 * Create a provider-side order/payment intent for an ALREADY-PRICED amount.
 * Used by the unified checkout, which resolves and stores the total itself.
 * Returns only client-safe fields — the provider secret never leaves here.
 */
export async function createProviderOrder({ amountCents, currency = 'USD', notes = {} }) {
  const provider = paymentProvider();
  const cur = String(currency || 'USD');
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw Object.assign(new Error('Invalid order amount'), { statusCode: 400, code: 'INVALID_AMOUNT' });
  }
  if (amountCents === 0) {
    return { provider, amountCents: 0, currency: cur, amount: 0, orderId: `free-${Date.now()}` };
  }
  // Fail loudly and cleanly when the provider isn't configured, rather than
  // leaking a raw SDK error or internal configuration to the browser. The
  // precise cause is logged for operators; admins see it in the panel.
  if (provider === 'stripe' && !env.STRIPE_SECRET_KEY) {
    logger.error('Payments unavailable: STRIPE_SECRET_KEY is not set');
    throw Object.assign(new Error(NOT_CONFIGURED_MSG), { statusCode: 503, code: 'PAYMENTS_NOT_CONFIGURED' });
  }
  if (provider !== 'stripe' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
    logger.error('Payments unavailable: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set');
    throw Object.assign(new Error(NOT_CONFIGURED_MSG), { statusCode: 503, code: 'PAYMENTS_NOT_CONFIGURED' });
  }
  if (provider === 'stripe') {
    const stripe = stripeClient();
    const pi = await stripe.paymentIntents.create({ amount: amountCents, currency: cur.toLowerCase(), metadata: notes });
    return { provider, amountCents, currency: cur, amount: amountCents / 100, orderId: pi.id, clientSecret: pi.client_secret };
  }
  const rzp = razorpayClient();
  // Razorpay expects the amount in minor units (paise/cents).
  const order = await rzp.orders.create({ amount: amountCents, currency: cur.toUpperCase(), notes });
  return { provider, amountCents, currency: cur, amount: amountCents / 100, orderId: order.id, keyId: env.RAZORPAY_KEY_ID };
}

/**
 * Create a HOSTED Stripe Checkout Session for an already-priced checkout order.
 *
 * Why hosted sessions and not Payment Elements: Stripe's own hosted page means
 * no card data ever reaches this app or its frontend bundle, and it is the
 * officially supported flow (the same role Razorpay's Checkout window plays on
 * the other provider). No Stripe.js dependency is needed in the browser.
 *
 * Why mode:'payment' (one-time) even for subscriptions: this app owns its own
 * subscription records and entitlements. A Stripe-managed subscription would be
 * a second source of truth for billing that nothing else reads. Charging
 * one-time and letting `fulfilOrder` activate the subscription keeps billing
 * identical across providers.
 *
 * `price_data` is built inline so no dashboard product/price setup is required
 * before this can run.
 *
 * Returns only client-safe fields; the secret key never leaves the server.
 */
export async function createStripeCheckoutSession({ order, customer = {}, successUrl, cancelUrl }) {
  if (!env.STRIPE_SECRET_KEY) {
    logger.error('Payments unavailable: STRIPE_SECRET_KEY is not set');
    throw Object.assign(new Error(NOT_CONFIGURED_MSG), { statusCode: 503, code: 'PAYMENTS_NOT_CONFIGURED' });
  }
  const amountCents = Number(order.totalCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error('Invalid order amount'), { statusCode: 400, code: 'INVALID_AMOUNT' });
  }
  const currency = String(order.currency || 'USD').toLowerCase();

  const productName = order.type === 'subscription'
    ? `${order.planName || order.planSlug} plan`
    : `${order.quantity} ${order.asset?.symbol || ''}`.trim();
  const description = order.type === 'subscription'
    ? `Billed every ${order.interval === 'year' ? 'year' : 'month'}`
    : 'Simulated crypto purchase credited to your SololevelingTrad paper portfolio';

  const stripe = stripeClient();
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Only the opaque order id travels in return URLs — never an email,
      // amount, or provider payment id.
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(order.reference),
      ...(customer.email ? { customer_email: String(customer.email) } : {}),
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: productName.slice(0, 120),
            description: description.slice(0, 200),
          },
        },
      }],
      // Metadata lets the webhook resolve the local records from either the
      // session id or the payment intent, whichever event body arrives.
      metadata: {
        checkoutReference: String(order.reference),
        checkoutOrderId: String(order._id),
        orderType: String(order.type),
        userId: String(order.userId),
      },
      payment_intent_data: {
        metadata: {
          checkoutReference: String(order.reference),
          checkoutOrderId: String(order._id),
          userId: String(order.userId),
        },
      },
      // Let the user abandon rather than pay a stale crypto quote later.
      ...(order.type === 'crypto' && order.quoteExpiresAt
        ? { expires_at: Math.floor(new Date(order.quoteExpiresAt).getTime() / 1000) }
        : {}),
    });
  } catch (e) {
    // Surface a clean, non-leaking failure instead of the raw SDK error: the
    // precise cause goes to the server log for operators only.
    logger.error('Stripe checkout session creation failed', {
      type: e?.type || e?.code || 'unknown',
      statusCode: e?.statusCode,
      message: e?.message,
    });
    throw Object.assign(
      new Error(NOT_CONFIGURED_MSG),
      { statusCode: 502, code: 'PAYMENT_PROVIDER_ERROR' },
    );
  }

  return {
    provider: 'stripe',
    orderId: session.id,
    url: session.url,
    amountCents,
    currency: String(order.currency || 'USD'),
    amount: amountCents / 100,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
  };
}

/**
 * Ask Stripe directly whether a payment actually succeeded.
 *
 * Used by the two places that must never take the browser's word for it:
 *   * /payments/verify — hosted checkout returns no signature to the browser,
 *     so the only proof is Stripe's own answer.
 *   * the result page's status poll — lets a deployment that has not yet
 *     configured a Stripe webhook still settle correctly, because Stripe
 *     itself is the authority either way.
 *
 * Never throws on a lookup failure: an unreachable provider is not proof that
 * a payment happened, so callers receive confirmed:false and keep waiting.
 */
export async function confirmStripePayment(providerOrderId) {
  if (!env.STRIPE_SECRET_KEY) {
    logger.error('Stripe confirmation unavailable: STRIPE_SECRET_KEY is not set');
    throw Object.assign(new Error(NOT_CONFIGURED_MSG), { statusCode: 503, code: 'PAYMENTS_NOT_CONFIGURED' });
  }
  const id = String(providerOrderId || '');
  const stripe = stripeClient();
  try {
    if (id.startsWith('cs_')) {
      const session = await stripe.checkout.sessions.retrieve(id);
      return session.payment_status === 'paid'
        ? { confirmed: true, paymentIntentId: session.payment_intent || null }
        : { confirmed: false, reason: `payment_status=${session.payment_status}` };
    }
    if (id.startsWith('pi_')) {
      const pi = await stripe.paymentIntents.retrieve(id);
      return pi.status === 'succeeded'
        ? { confirmed: true, paymentIntentId: pi.id }
        : { confirmed: false, reason: `status=${pi.status}` };
    }
    return { confirmed: false, reason: 'unrecognised provider reference' };
  } catch (e) {
    return { confirmed: false, reason: `lookup failed: ${e?.message || 'error'}` };
  }
}

export async function createOrder({ plan, userId }) {
  const resolved = await resolveCheckoutPlan(plan);
  const gateway = await createProviderOrder({
    amountCents: resolved.priceCents,
    currency: resolved.currency || 'USD',
    notes: { plan: resolved.id, userId: String(userId) },
  });
  return { ...gateway, plan: resolved.id };
}
export function verifyRazorpaySignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function verifyStripeWebhook(rawBody, signature) {
  const stripe = stripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
export function verifyRazorpayWebhook(rawBody, signature) {
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Invalid webhook signature'), { statusCode: 400 });
  return JSON.parse(rawBody.toString());
}
export async function refund(provider, paymentId, amount) {
  if (provider === 'stripe') return stripeClient().refunds.create({ payment_intent: paymentId });
  if (provider === 'whop') {
    // Whop refunds the payment by id and takes a decimal major-unit amount.
    // Same call the wallet-deposit refund path uses — one audited refund path.
    const { refundDepositPayment } = await import('./whopService.js');
    return refundDepositPayment(paymentId, amount ? Math.round(amount * 100) : null, 'Admin refund');
  }
  return razorpayClient().payments.refund(paymentId, { amount: amount ? amount * 100 : undefined });
}
export const rbacCan = (role, action) => {
  const m = { user: ['read:self'], support: ['read:self', 'read:users', 'read:tickets'], admin: ['read:self', 'read:users', 'write:users', 'read:payments', 'read:analytics', 'write:notify'], superadmin: ['*'] };
  const perms = m[role] || []; return perms.includes('*') || perms.includes(action);
};
