import crypto from 'crypto';
import env from '../config/env.js';
import AppError from '../utils/AppError.js';
import CheckoutOrder from '../models/CheckoutOrder.js';
import Payment from '../models/Payment.js';
import TradingPair from '../models/TradingPair.js';
import AuditLog from '../models/AuditLog.js';
import { resolvePurchasablePlan } from './planService.js';
import { coinDetail } from './marketService.js';
import { generateOrderId } from '../utils/generateId.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Unified checkout service.
//
// Trust model: the browser never supplies a price, fee, tax or total. It only
// ever supplies *what* is being bought (plan slug, or asset + quantity). Every
// monetary figure in this module is computed here, and price quotes are
// server-signed so a client cannot rewrite one before submitting it.
// ---------------------------------------------------------------------------

const bps = (amount, basisPoints) => Math.round((amount * basisPoints) / 10000);

// ---------------------------------------------------------------------------
// Signed price quotes (stateless — no extra collection, no TTL index needed)
// ---------------------------------------------------------------------------
const quoteSecret = () => env.JWT_ACCESS_SECRET || 'dev-access-secret';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64');
}

/** Sign a quote payload. Returns an opaque token handed back to the client. */
export function signQuote(payload) {
  const body = { ...payload, v: 1, iat: Date.now(), exp: Date.now() + env.QUOTE_TTL_SECONDS * 1000 };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', quoteSecret()).update(data).digest());
  return `${data}.${sig}`;
}

/**
 * Verify + decode a quote token. Throws AppError on tampering or expiry —
 * this is where "invalid and expired quotes are rejected" is enforced.
 */
export function verifyQuote(token) {
  const t = String(token || '');
  const dot = t.lastIndexOf('.');
  if (!dot) throw new AppError('Invalid quote', 400, 'INVALID_QUOTE');
  const data = t.slice(0, dot);
  const sig = t.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', quoteSecret()).update(data).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError('Invalid quote signature', 400, 'INVALID_QUOTE');
  }
  let payload;
  try { payload = JSON.parse(unb64url(data).toString('utf8')); } catch { throw new AppError('Invalid quote', 400, 'INVALID_QUOTE'); }
  if (!payload.exp || Date.now() > payload.exp) {
    throw new AppError('This price quote has expired — please refresh it', 410, 'QUOTE_EXPIRED');
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Crypto settlement availability (honest gating — no approved partner exists)
// ---------------------------------------------------------------------------
export function cryptoSettlementStatus() {
  const mode = env.CRYPTO_PURCHASE_MODE;
  if (mode === 'simulated') {
    return {
      available: true,
      mode: 'simulated',
      label: 'Simulated',
      // Never worded as if real assets or funds move.
      message: 'Simulated purchase: this credits your SololevelingTrad paper portfolio only. No real cryptocurrency or funds are exchanged.',
    };
  }
  return {
    available: false,
    mode: 'disabled',
    label: 'Unavailable',
    message: 'Crypto purchases are not available on this deployment. No licensed settlement partner has been approved for this merchant account, and payment providers restrict crypto-related payments without prior merchant approval.',
  };
}

// ---------------------------------------------------------------------------
// Asset resolution — only assets the app actually supports (active pairs).
// ---------------------------------------------------------------------------
export async function listPurchasableAssets() {
  const pairs = await TradingPair.find({ active: true }).lean();
  // Price lookups are independent and served from the market cache, so fetch
  // them concurrently rather than serially awaiting each one (was an N+1-style
  // sequential loop). A bounded fan-out keeps the upstream call count sane.
  const priced = await mapWithConcurrency(pairs, 8, async (p) => {
    if (!p.coinId) return null;
    try {
      const d = await coinDetail(p.coinId);
      if (!d?.price) return null;
      return {
        symbol: p.base, name: d.name, id: d.id || p.coinId, coinId: p.coinId,
        price: d.price, image: d.image || null, minQty: p.minQty,
        qtyPrecision: p.qtyPrecision, currency: 'USD', source: d.source, updatedAt: d.updatedAt,
      };
    } catch { return null; /* skip assets whose price we cannot verify right now */ }
  });
  return priced.filter(Boolean);
}

/** Map over items with a bounded number of concurrent async workers. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function resolveAsset(ref) {
  const key = String(ref || '').trim();
  if (!key) throw new AppError('Asset is required', 400, 'ASSET_REQUIRED');
  const upper = key.toUpperCase();
  const or = [{ base: upper }, { symbol: upper }, { coinId: key }];
  if (/^[a-f0-9]{24}$/i.test(key)) or.push({ _id: key });
  // Only ACTIVE pairs are purchasable — an delisted venue can't be bought on.
  const pair = await TradingPair.findOne({ active: true, $or: or }).lean();
  if (!pair || !pair.coinId) {
    throw new AppError('That asset is not available for purchase on this platform', 404, 'ASSET_UNAVAILABLE');
  }
  const detail = await coinDetail(pair.coinId);
  if (!detail?.price || !Number.isFinite(detail.price)) {
    throw new AppError('Live pricing is unavailable for this asset right now', 502, 'PRICE_UNAVAILABLE');
  }
  return { pair, detail };
}

function validateQuantity(pair, quantity) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new AppError('Quantity must be a positive number', 400, 'INVALID_QUANTITY');
  if (pair.minQty != null && qty < pair.minQty) {
    throw new AppError(`Minimum purchase quantity is ${pair.minQty}`, 400, 'QUANTITY_TOO_SMALL');
  }
  // Guard against float noise from the browser (e.g. 0.1 + 0.2 style drift).
  const precision = pair.qtyPrecision ?? 6;
  if (Number(qty.toFixed(precision)) !== qty) {
    throw new AppError(`Quantity supports at most ${precision} decimal places`, 400, 'INVALID_QUANTITY');
  }
  if (qty > 1e9) throw new AppError('Quantity is too large', 400, 'QUANTITY_TOO_LARGE');
  return qty;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Price a subscription from the PUBLISHED Plan catalogue. Draft/archived plans
 * are rejected here, before an order can even be created.
 */
export async function quoteSubscription({ planRef }) {
  const plan = await resolvePurchasablePlan(String(planRef || '').trim());
  const subtotal = plan.priceCents ?? 0;
  const tax = bps(subtotal, env.CHECKOUT_TAX_BPS);
  const total = subtotal + tax;
  return {
    type: 'subscription',
    planSlug: plan.slug,
    planName: plan.name,
    interval: plan.interval || 'month',
    intervalCount: plan.intervalCount || 1,
    features: plan.features || [],
    recommended: !!plan.recommended,
    unitPriceCents: subtotal,
    subtotalCents: subtotal,
    feeCents: 0,
    taxCents: tax,
    discountCents: 0,
    totalCents: total,
    currency: plan.currency || 'USD',
    quantity: 1,
    taxConfigured: env.CHECKOUT_TAX_BPS > 0,
  };
}

/** Price a crypto purchase from the trusted market feed. */
export async function quoteCrypto({ asset, quantity }) {
  const status = cryptoSettlementStatus();
  const { pair, detail } = await resolveAsset(asset);
  const qty = validateQuantity(pair, quantity);
  const unitPriceCents = Math.round(detail.price * 100);
  const subtotal = Math.round(unitPriceCents * qty);
  const fee = bps(subtotal, env.CRYPTO_FEE_BPS);
  const tax = bps(subtotal, env.CHECKOUT_TAX_BPS);
  const total = subtotal + fee + tax;
  if (total <= 0) throw new AppError('Order total must be greater than zero', 400, 'INVALID_TOTAL');

  return {
    type: 'crypto',
    asset: { id: detail.id, symbol: detail.symbol, name: detail.name, image: detail.image || null },
    coinId: pair.coinId,
    pair: pair.symbol,
    quantity: qty,
    qtyPrecision: pair.qtyPrecision ?? 6,
    minQty: pair.minQty ?? 0,
    unitPriceCents,
    quoteSource: detail.source,
    quoteIssuedAt: new Date().toISOString(),
    subtotalCents: subtotal,
    feeCents: fee,
    taxCents: tax,
    discountCents: 0,
    totalCents: total,
    currency: 'USD',
    taxConfigured: env.CHECKOUT_TAX_BPS > 0,
    settlement: status,
  };
}

/**
 * Issue a signed, expiring quote for either order type.
 */
export async function createQuote(input) {
  const type = input?.type === 'crypto' ? 'crypto' : 'subscription';
  const priced = type === 'crypto'
    ? await quoteCrypto({ asset: input.asset, quantity: input.quantity })
    : await quoteSubscription({ planRef: input.planSlug || input.plan });

  // Only identity + locked unit price travel in the token. Totals are
  // recomputed server-side at order time from these inputs.
  const token = signQuote({
    type,
    planSlug: priced.planSlug,
    planName: priced.planName,
    interval: priced.interval,
    intervalCount: priced.intervalCount,
    asset: type === 'crypto' ? priced.asset : undefined,
    coinId: priced.coinId,
    pair: priced.pair,
    quantity: priced.quantity,
    unitPriceCents: priced.unitPriceCents,
    currency: priced.currency,
  });

  return {
    token,
    expiresInSeconds: env.QUOTE_TTL_SECONDS,
    expiresAt: new Date(Date.now() + env.QUOTE_TTL_SECONDS * 1000).toISOString(),
    pricing: priced,
  };
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

function nextReference() { return generateOrderId('SLT'); }

/**
 * Recompute the full money breakdown from a verified quote. The client's
 * totals are ignored entirely — only the signed unit price is trusted.
 */
function priceFromQuote(q) {
  const subtotal = q.type === 'crypto'
    ? Math.round(q.unitPriceCents * q.quantity)
    : q.unitPriceCents;
  const fee = q.type === 'crypto' ? bps(subtotal, env.CRYPTO_FEE_BPS) : 0;
  const tax = bps(subtotal, env.CHECKOUT_TAX_BPS);
  const total = subtotal + fee + tax;
  if (total <= 0) throw new AppError('Order total must be greater than zero', 400, 'INVALID_TOTAL');
  return { subtotal, fee, tax, total };
}

export async function createCheckoutOrder({ userId, quoteToken, idempotencyKey }) {
  const q = verifyQuote(quoteToken);

  // Idempotency: repeated clicks / browser retries return the SAME order.
  if (idempotencyKey) {
    const existing = await CheckoutOrder.findOne({ userId, idempotencyKey });
    if (existing) return { order: existing, duplicate: true };
  }

  let doc = {
    userId,
    type: q.type,
    status: 'pending',
    currency: q.currency || 'USD',
  };

  if (q.type === 'subscription') {
    // Re-read the catalogue: the admin may have changed price/status since the
    // quote was issued. The database always wins over a stale quote.
    const plan = await resolvePurchasablePlan(q.planSlug);
    const priced = priceFromQuote({ type: 'subscription', unitPriceCents: plan.priceCents, quantity: 1 });
    doc = {
      ...doc,
      planSlug: plan.slug,
      planName: plan.name,
      interval: plan.interval || 'month',
      intervalCount: plan.intervalCount || 1,
      currency: plan.currency || 'USD',
      subtotalCents: priced.subtotal,
      feeCents: 0,
      taxCents: priced.tax,
      discountCents: 0,
      totalCents: priced.total,
      settlement: 'provider',
      simulated: false,
      provider: 'none',
      terms: {
        interval: plan.interval || 'month',
        intervalCount: plan.intervalCount || 1,
        renew: true,
        cancelAnytime: true,
        note: 'Billed every billing period until cancelled. Access continues until the end of the paid period.',
      },
    };
  } else {
    const status = cryptoSettlementStatus();
    // Crypto orders can be created for review even when settlement is
    // unavailable — payment is refused later, at the payment-session step.
    const priced = priceFromQuote(q);
    const issuedAt = q.iat ? new Date(q.iat) : new Date();
    const expiresAt = q.exp ? new Date(q.exp) : new Date();
    doc = {
      ...doc,
      asset: { id: q.asset?.id, symbol: q.asset?.symbol, name: q.asset?.name },
      quantity: q.quantity,
      unitPriceCents: q.unitPriceCents,
      quoteSource: q.quoteSource || q.asset?.source || 'coingecko',
      quoteIssuedAt: issuedAt,
      quoteExpiresAt: expiresAt,
      subtotalCents: priced.subtotal,
      feeCents: priced.fee,
      taxCents: priced.tax,
      discountCents: 0,
      totalCents: priced.total,
      settlement: status.available && status.mode === 'simulated' ? 'simulated' : 'provider',
      simulated: status.mode === 'simulated',
      provider: 'none',
      terms: {
        simulated: status.mode === 'simulated',
        feeBps: env.CRYPTO_FEE_BPS,
        quoteValidUntil: expiresAt.toISOString(),
        note: status.message,
      },
    };
  }

  if (idempotencyKey) doc.idempotencyKey = idempotencyKey;
  // Reference collision retry (astronomically unlikely, but cheap to guard).
  for (let i = 0; i < 3; i++) {
    doc.reference = nextReference();
    const clash = await CheckoutOrder.exists({ reference: doc.reference });
    if (!clash) break;
  }

  const order = await CheckoutOrder.create(doc);
  return { order, duplicate: false };
}

// ---------------------------------------------------------------------------
// Payment session
// ---------------------------------------------------------------------------
export async function createPaymentSession({ userId, orderId }) {
  const order = await CheckoutOrder.findOne({ _id: orderId, userId });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (order.status === 'paid') throw new AppError('This order is already paid', 409, 'ORDER_ALREADY_PAID');
  if (order.status === 'cancelled' || order.status === 'expired') {
    throw new AppError('This order can no longer be paid', 409, 'ORDER_NOT_PAYABLE');
  }

  // ---- Crypto settlement gating -----------------------------------------
  if (order.type === 'crypto') {
    const status = cryptoSettlementStatus();
    if (!status.available) {
      throw new AppError(status.message, 409, 'CRYPTO_SETTLEMENT_UNAVAILABLE');
    }
    if (order.quoteExpiresAt && order.quoteExpiresAt.getTime() < Date.now()) {
      order.status = 'expired';
      await order.save();
      throw new AppError('This price quote has expired — please request a new quote', 410, 'QUOTE_EXPIRED');
    }
    // Simulated mode never touches a payment provider: no real money moves.
    if (status.mode === 'simulated') {
      return { mode: 'simulated', requiresPayment: false, order: publicOrder(order) };
    }
  }

  // ---- Provider session ---------------------------------------------------
  const { createProviderOrder, createStripeCheckoutSession, paymentProvider } = await import('./paymentService.js');
  const provider = paymentProvider();

  // Whop runs the whole checkout inside OUR page (the Checkout element), so
  // there is nothing to create server-side and no secret to hand the browser:
  // the variant prices the order, and the signed webhook is what settles it.
  // Only subscriptions can be bought this way — Whop has no crypto flow.
  if (provider === 'whop') {
    if (order.type !== 'subscription') {
      throw new AppError('This order type cannot be paid with Whop', 409, 'PROVIDER_UNSUPPORTED');
    }
    const plan = await resolvePurchasablePlan(order.planSlug);
    const planId = plan?.providerPriceIds?.whop || null;
    if (!planId) {
      throw new AppError('This plan is not linked to a Whop checkout yet. Please contact support.', 409, 'PLAN_NOT_LINKED');
    }
    const { subscriptionCheckoutInfo } = await import('./whopService.js');
    order.provider = 'whop';
    order.status = 'awaiting_payment';
    await order.save();
    return {
      mode: 'whop',
      requiresPayment: true,
      provider: 'whop',
      // Client-safe only: which variant to buy, our opaque reference, and where
      // Whop sends the buyer afterwards. No secret and no asserted amount —
      // the variant defines the price, and the webhook defines the outcome.
      whop: subscriptionCheckoutInfo({ orderId: order._id, reference: order.reference, planId }),
      amountCents: order.totalCents,
      currency: order.currency,
      order: publicOrder(order),
    };
  }

  // Razorpay and Stripe are both driven by their official hosted checkout page,
  // so this single code path supports either one. Razorpay renders its Checkout
  // window over the page (keyId + order id); Stripe redirects to a hosted session.
  let gateway;
  if (provider === 'stripe') {
    // Prefill from the account record — server-side, not browser-supplied.
    const { default: User } = await import('../models/User.js');
    const u = await User.findById(userId).select('email firstName lastName name').lean();
    const base = String(env.CLIENT_URL || '').replace(/\/+$/, '');
    gateway = await createStripeCheckoutSession({
      order,
      customer: {
        email: u?.email || '',
        name: u?.name || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || '',
      },
      // Return URLs carry only the opaque order id — no PII, no amounts,
      // no provider payment ids in the query string.
      successUrl: `${base}/checkout/success?id=${String(order._id)}`,
      cancelUrl: `${base}/checkout/cancelled?id=${String(order._id)}`,
    });
  } else {
    gateway = await createProviderOrder({
      amountCents: order.totalCents,
      currency: order.currency,
      notes: {
        checkoutReference: order.reference,
        orderType: order.type,
        userId: String(userId),
        plan: order.planSlug || '',
      },
    });
  }

  order.provider = gateway.provider;
  order.providerOrderId = gateway.orderId;
  order.status = 'awaiting_payment';
  await order.save();

  // Link the canonical Payment row so /payments/verify and the webhook can
  // settle this checkout order idempotently.
  let pay = await Payment.findOne({ providerOrderId: gateway.orderId });
  if (!pay) {
    pay = await Payment.create({
      userId,
      provider: gateway.provider,
      providerOrderId: gateway.orderId,
      amount: gateway.amount,
      amountCents: gateway.amountCents,
      currency: gateway.currency,
      plan: order.planSlug || order.asset?.symbol || order.reference,
      status: 'created',
      checkoutOrderId: order._id,
    });
  }
  order.paymentId = pay._id;
  await order.save();

  return {
    mode: 'provider',
    requiresPayment: true,
    provider: gateway.provider,
    // Client-safe configuration only — the secret never leaves the server.
    keyId: gateway.keyId,          // Razorpay: opens its Checkout window
    clientSecret: gateway.clientSecret,
    checkoutUrl: gateway.url || null, // Stripe: hosted page to redirect to
    providerOrderId: gateway.orderId,
    amountCents: gateway.amountCents,
    currency: gateway.currency,
    order: publicOrder(order),
  };
}

/** Complete a simulated (no-provider) order. Used only in simulated mode. */
export async function completeSimulatedOrder({ userId, orderId }) {
  const order = await CheckoutOrder.findOne({ _id: orderId, userId });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (order.status === 'paid') return { order, duplicate: true };
  if (!order.simulated) throw new AppError('This order requires a payment provider', 409, 'PAYMENT_REQUIRED');

  order.status = 'paid';
  order.settlement = 'simulated';
  order.provider = 'none';
  order.paidAt = new Date();
  await order.save();
  await fulfilOrder(order);
  await audit(order.userId, 'checkout_simulated_complete', order.reference, { type: order.type, total: order.totalCents });
  return { order, duplicate: false };
}

// ---------------------------------------------------------------------------
// Fulfilment — runs exactly once, only after payment is confirmed.
// ---------------------------------------------------------------------------
export async function fulfilOrder(order) {
  if (order.type === 'subscription') {
    const { activateSubscription } = await import('./subscriptionService.js');
    const { default: User } = await import('../models/User.js');
    // Honour the plan's actual billing interval rather than a hardcoded month.
    const months = order.interval === 'year' ? 12 : 1;
    const days = 30 * months * (order.intervalCount || 1);
    const sub = await activateSubscription(order.userId, order.planSlug, order.paymentId || null, days);
    order.subscriptionId = sub._id;
    await order.save();
    const buyer = await User.findByIdAndUpdate(order.userId, {
      plan: order.planSlug,
      currentSubscription: sub._id,
      subscriptionStatus: 'active',
      subscriptionExpiresAt: sub.expiresAt,
    }, { new: true });

    // Receipt. This runs inside the settlement path, which is idempotent, so a
    // buyer gets exactly one receipt per order. Best-effort on purpose: a mail
    // outage must never roll back a payment we have already taken.
    try {
      const { sendSubscriptionReceipt } = await import('./emailService.js');
      if (buyer?.email) {
        await sendSubscriptionReceipt(buyer.email, {
          name: buyer.firstName || buyer.username || 'Hunter',
          planName: order.planName || order.planSlug,
          amount: (order.totalCents / 100).toFixed(2),
          currency: order.currency,
          reference: order.reference,
          provider: order.provider,
          interval: order.interval,
          intervalCount: order.intervalCount || 1,
          renewsOn: sub.expiresAt,
        });
      }
    } catch (e) {
      logger.warn(`Receipt email failed for ${order.reference}: ${e?.message || 'error'}`);
    }
    return { kind: 'subscription', subscriptionId: String(sub._id), receiptSentTo: buyer?.email || null };
  }

  // Crypto: only ever the SIMULATED path (the provider path is refused above).
  if (order.simulated) {
    const { ensurePaperWallet } = await import('./paperEngine.js');
    const { default: Balance } = await import('../models/Balance.js');
    const { default: LedgerTxn } = await import('../models/LedgerTxn.js');
    await ensurePaperWallet(order.userId);
    const asset = order.asset?.symbol;
    let bal = await Balance.findOne({ userId: order.userId, asset });
    if (!bal) bal = await Balance.create({ userId: order.userId, asset, available: 0, reserved: 0 });
    const r8 = (n) => Math.round(Number(n) * 1e8) / 1e8;
    bal.available = r8(bal.available + order.quantity);
    await bal.save();
    await LedgerTxn.create({
      userId: order.userId, asset,
      delta: order.quantity, balanceAfter: bal.available,
      kind: 'buy',
      refId: order._id,
      idemKey: `checkout:${order.reference}`,
      note: `SIMULATED purchase of ${order.quantity} ${asset} — paper portfolio credit, not a real asset transfer`,
    });
    return { kind: 'crypto_simulated', asset, quantity: order.quantity };
  }
  return { kind: 'none' };
}

/**
 * The single "money is confirmed" transition: mark paid, fulfil exactly once,
 * audit. Shared by the Razorpay/Stripe path and the Whop path so they cannot
 * drift apart.
 */
async function markPaidAndFulfil(order, { paymentId, providerPaymentId, providerOrderId } = {}) {
  order.status = 'paid';
  order.paidAt = new Date();
  if (providerPaymentId) order.providerPaymentId = providerPaymentId;
  if (providerOrderId) order.providerOrderId = providerOrderId;
  if (paymentId) order.paymentId = paymentId;
  await order.save();

  const fulfilment = await fulfilOrder(order);
  await audit(order.userId, 'checkout_order_paid', order.reference, {
    type: order.type, total: order.totalCents, currency: order.currency, ...fulfilment,
  });
  return fulfilment;
}

/**
 * Settle a CheckoutOrder after its provider payment is confirmed. Called from
 * /payments/verify and from the webhook — both are idempotent, and so is this.
 */
export async function settleCheckoutOrder({ providerOrderId, payment, providerPaymentId }) {
  const order = await CheckoutOrder.findOne({ providerOrderId });
  if (!order) return null;
  if (order.status === 'paid') return { order, alreadyPaid: true };

  const fulfilment = await markPaidAndFulfil(order, {
    paymentId: payment ? payment._id : undefined,
    providerPaymentId,
  });
  return { order, alreadyPaid: false, fulfilment };
}

// ---------------------------------------------------------------------------
// Whop settlement (webhook-driven)
//
// Unlike Razorpay/Stripe, a Whop order has no server-side session, so there is
// no provider order id to look the order up by. The element attaches our own
// reference as metadata and Whop copies it onto the payment and every event
// about it, so the reconciliation key here is `reference`.
//
// Safety rule: entitlement is granted only when the amount and currency the
// buyer actually paid match what we recorded. Anything else is reported as a
// mismatch and left for an admin — never credited blindly.
// ---------------------------------------------------------------------------

/** Decimal major units (Whop reports dollars) -> integer minor units. */
const toMinorUnits = (v) => {
  // A missing amount must read as "unknown", never as "$0 paid" — an absent
  // total would otherwise look like a deliberate underpayment.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Find a Whop-settled order by our own reference. Returns null if unknown. */
async function findWhopOrder(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return null;
  const order = await CheckoutOrder.findOne({ reference: ref });
  if (!order) return null;
  // A reference that belongs to a Razorpay/Stripe order must never be settled
  // by a Whop event, however the event was produced.
  return order.provider === 'whop' ? order : null;
}

/**
 * Confirm a subscription paid through the Whop checkout element.
 *
 * Returns one of:
 *   null                                   — no such Whop order (caller keeps looking)
 *   { alreadyPaid: true }                  — idempotent replay
 *   { mismatch: true, reason, expectedMinor, providerMinor }
 *   { order, fulfilment, paymentId }       — settled
 */
export async function settleWhopCheckoutOrder({ reference, providerPaymentId, providerAmount, providerCurrency }) {
  const order = await findWhopOrder(reference);
  if (!order) return null;
  if (order.status === 'paid') return { order, alreadyPaid: true };

  const expectedMinor = order.totalCents;
  const paidMinor = toMinorUnits(providerAmount);
  if (paidMinor == null) {
    return { order, mismatch: true, reason: 'provider reported no amount', expectedMinor, providerMinor: null };
  }
  if (paidMinor !== expectedMinor) {
    return { order, mismatch: true, reason: `amount mismatch: expected ${expectedMinor}, got ${paidMinor}`, expectedMinor, providerMinor: paidMinor };
  }
  const paidCurrency = providerCurrency ? String(providerCurrency).toUpperCase() : null;
  if (paidCurrency && paidCurrency !== String(order.currency || '').toUpperCase()) {
    return { order, mismatch: true, reason: `currency mismatch: expected ${order.currency}, got ${paidCurrency}`, expectedMinor, providerMinor: paidMinor };
  }
  if (!providerPaymentId) {
    return { order, mismatch: true, reason: 'provider reported no payment id', expectedMinor, providerMinor: paidMinor };
  }

  // Canonical Payment row, so admin revenue/refund tooling sees Whop like any
  // other provider. Scoped to THIS order so a provider id that somehow appears
  // against a different order can never be adopted as this one's payment.
  let pay = await Payment.findOne({ providerOrderId: providerPaymentId, checkoutOrderId: order._id });
  if (!pay) {
    pay = await Payment.create({
      userId: order.userId,
      provider: 'whop',
      providerOrderId: providerPaymentId,
      providerPaymentId,
      amount: expectedMinor / 100,
      amountCents: expectedMinor,
      currency: order.currency,
      plan: order.planSlug || order.reference,
      status: 'paid',
      checkoutOrderId: order._id,
    });
  }

  const fulfilment = await markPaidAndFulfil(order, {
    paymentId: pay._id,
    providerPaymentId,
    providerOrderId: providerPaymentId,
  });
  return { order, alreadyPaid: false, fulfilment, paymentId: String(pay._id) };
}

/** Mark a Whop order failed. Never downgrades a paid/refunded order. */
export async function failWhopCheckoutOrder({ reference, reason }) {
  const order = await findWhopOrder(reference);
  if (!order) return null;
  if (['paid', 'refunded', 'cancelled'].includes(order.status)) return { order, terminal: order.status };

  order.status = 'failed';
  order.failureReason = String(reason || 'The payment provider reported this payment as unsuccessful.').slice(0, 300);
  await order.save();
  await audit(order.userId, 'checkout_order_failed', order.reference, { provider: 'whop', reason: order.failureReason });
  return { order };
}

/**
 * Record a provider refund against a Whop order.
 *
 * Access is deliberately NOT revoked: the subscription runs to the end of the
 * period that was already paid for. Revoking entitlement is an explicit admin
 * decision, never a side effect of a refund event.
 */
export async function refundWhopCheckoutOrder({ reference, reason }) {
  const order = await findWhopOrder(reference);
  if (!order) return null;
  const wasPaid = order.status === 'paid';

  order.status = 'refunded';
  order.failureReason = String(reason || 'Refund issued by the payment provider').slice(0, 300);
  await order.save();
  if (order.paymentId) {
    try { await Payment.updateOne({ _id: order.paymentId }, { $set: { status: 'refunded' } }); } catch { /* payment row is advisory */ }
  }
  await audit(order.userId, 'checkout_order_refunded', order.reference, { provider: 'whop', wasPaid });
  return { order, wasPaid };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export function publicOrder(o) {
  if (!o) return null;
  const doc = o.toObject ? o.toObject() : o;
  return {
    id: String(doc._id),
    reference: doc.reference,
    type: doc.type,
    status: doc.status,
    planSlug: doc.planSlug, planName: doc.planName,
    interval: doc.interval, intervalCount: doc.intervalCount,
    asset: doc.asset, quantity: doc.quantity,
    unitPriceCents: doc.unitPriceCents,
    quoteSource: doc.quoteSource, quoteIssuedAt: doc.quoteIssuedAt, quoteExpiresAt: doc.quoteExpiresAt,
    subtotalCents: doc.subtotalCents, feeCents: doc.feeCents, taxCents: doc.taxCents,
    discountCents: doc.discountCents, totalCents: doc.totalCents, currency: doc.currency,
    settlement: doc.settlement, simulated: doc.simulated,
    provider: doc.provider, providerOrderId: doc.providerOrderId,
    terms: doc.terms,
    paidAt: doc.paidAt, failureReason: doc.failureReason,
    createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    // Deliberately omitted: payment secrets, internal ids of other records.
  };
}

export async function getOrderForUser(id, userId) {
  const order = await CheckoutOrder.findOne({ _id: id, userId }).lean();
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  return order;
}

export async function findOrderByReference(reference) {
  return CheckoutOrder.findOne({ reference: String(reference || '') }).lean();
}

async function audit(actorId, action, target, meta) {
  try { await AuditLog.create({ actorId, action, target: String(target), meta }); } catch { /* never break payment flow */ }
}

export { audit };
