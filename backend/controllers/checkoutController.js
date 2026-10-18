import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { paginate } from '../utils/sanitize.js';
import env from '../config/env.js';
import CheckoutOrder from '../models/CheckoutOrder.js';
import {
  createQuote,
  createCheckoutOrder,
  createPaymentSession,
  completeSimulatedOrder,
  getOrderForUser,
  publicOrder,
  cryptoSettlementStatus,
  listPurchasableAssets,
} from '../services/checkoutService.js';
import { paymentProvider } from '../services/paymentService.js';

const isConfigured = () => {
  const p = paymentProvider();
  if (p === 'stripe') return !!env.STRIPE_SECRET_KEY;
  if (p === 'whop') return !!env.WHOP_COMPANY_API_KEY && !!env.WHOP_COMPANY_ID;
  return !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET;
};
// Providers whose checkout flow this page actually drives. Razorpay and Stripe
// host theirs; Whop's element is embedded inside our own page.
const SUPPORTED_CHECKOUT_PROVIDERS = ['razorpay', 'stripe', 'whop'];

// ---------------------------------------------------------------------------
// POST /api/checkout/quote — server-priced, signed, expiring quote.
// ---------------------------------------------------------------------------
export const quote = asyncHandler(async (req, res) => {
  const q = await createQuote(req.body);
  return ok(res, 'Quote ready', q);
});

// ---------------------------------------------------------------------------
// POST /api/checkout/orders — create an order from a verified quote.
// Idempotent: the same idempotencyKey returns the same order.
// ---------------------------------------------------------------------------
export const create = asyncHandler(async (req, res) => {
  const { order, duplicate } = await createCheckoutOrder({
    userId: req.user.sub,
    quoteToken: req.body.quoteToken,
    idempotencyKey: req.body.idempotencyKey,
  });
  return ok(res, duplicate ? 'Existing order returned' : 'Order created', { order: publicOrder(order) }, duplicate ? 200 : 201);
});

// ---------------------------------------------------------------------------
// POST /api/checkout/payment-session — provider session for an owned order.
// All money was already resolved server-side at order creation.
// ---------------------------------------------------------------------------
export const paymentSession = asyncHandler(async (req, res) => {
  const session = await createPaymentSession({ userId: req.user.sub, orderId: req.body.orderId });
  return ok(res, 'Payment session ready', session);
});

// ---------------------------------------------------------------------------
// POST /api/checkout/complete-simulated — ONLY reachable in simulated mode.
// Never marks a provider-backed order as paid.
// ---------------------------------------------------------------------------
export const completeSimulated = asyncHandler(async (req, res) => {
  const r = await completeSimulatedOrder({ userId: req.user.sub, orderId: req.body.orderId });
  return ok(res, r.duplicate ? 'Order already completed' : 'Simulated order completed', { order: publicOrder(r.order) });
});

// ---------------------------------------------------------------------------
// Reads — ownership enforced inside the service on every request.
// ---------------------------------------------------------------------------
export const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const q = { userId: req.user.sub };
  if (req.query.type && ['subscription', 'crypto'].includes(req.query.type)) q.type = req.query.type;
  if (req.query.status) q.status = String(req.query.status);
  const [items, total] = await Promise.all([
    CheckoutOrder.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CheckoutOrder.countDocuments(q),
  ]);
  return ok(res, 'Orders', { orders: items.map(publicOrder), page, limit, total, pages: Math.ceil(total / limit) || 1 });
});

export const byId = asyncHandler(async (req, res) => {
  const order = await getOrderForUser(req.params.id, req.user.sub);
  return ok(res, 'Order', { order: publicOrder(order) });
});

/** Lightweight polling endpoint for the payment-result page. */
export const status = asyncHandler(async (req, res) => {
  const order = await getOrderForUser(req.params.id, req.user.sub);
  return ok(res, 'Status', {
    status: order.status,
    paidAt: order.paidAt || null,
    reference: order.reference,
    // Safe to surface: tells the UI whether to keep polling.
    terminal: ['paid', 'failed', 'cancelled', 'expired', 'refunded'].includes(order.status),
  });
});

/** Client-safe checkout configuration (never exposes secrets). */
export const config = asyncHandler(async (req, res) => {
  const crypto = cryptoSettlementStatus();
  const provider = paymentProvider();
  const configured = isConfigured();
  // Payment methods are only ever advertised when they are actually reachable.
  // The provider's own secure window renders the live method list (UPI, cards,
  // net banking, wallets, EMI…) for whatever the merchant account has enabled,
  // so we never draw a method we cannot prove is enabled.
  const providerLabel = provider === 'stripe' ? 'Stripe' : provider === 'whop' ? 'Whop' : 'Razorpay';
  const supported = SUPPORTED_CHECKOUT_PROVIDERS.includes(provider);
  // Only advertised when it is actually reachable, and worded to match how the
  // provider really behaves: Razorpay overlays a window, Stripe continues to a
  // hosted page, and Whop's card form is rendered inside this page. Only Whop's
  // form is one we host — the other two card forms are never rendered by us.
  const paymentMethods = configured && supported
    ? [{
        id: 'provider_checkout',
        label: `${providerLabel} secure checkout`,
        available: true,
        primary: true,
        icon: 'lock',
        detail: provider === 'stripe'
          ? "Continues to Stripe's hosted payment page. Cards, wallets and other methods Stripe supports appear there when enabled for this merchant and available in your region."
          : provider === 'whop'
            ? 'Enter your card details here, on this page — the payment form is provided by Whop and your plan activates automatically once the payment is confirmed.'
            : `Opens ${providerLabel}'s secure payment window. UPI, credit/debit cards, net banking, wallets and EMI appear there when enabled for this merchant and available in your region.`,
      }]
    : [];
  return ok(res, 'Checkout config', {
    provider,
    providerLabel,
    providerConfigured: configured,
    // Whether THIS checkout page can actually drive the configured provider.
    checkoutSupported: supported,
    unavailableReason: !configured
      ? 'No payment credentials are configured on the server yet.'
      : !supported
        ? `This checkout page does not implement the ${providerLabel} flow yet. The server is configured for a different provider.`
        : null,
    paymentMethods,
    crypto,
    // Coupons are only offered when the backend actually supports them.
    couponsSupported: false,
    taxConfigured: env.CHECKOUT_TAX_BPS > 0,
    assets: crypto.mode === 'disabled' ? [] : await listPurchasableAssets().catch(() => []),
  });
});
