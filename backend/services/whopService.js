import crypto from 'crypto';
import env from '../config/env.js';
import AppError from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Whop provider module — the ONLY place in the backend that knows about Whop.
//
// Verified against the official docs (docs.whop.com):
//   * Client      : WhopClient / WhopEnvironment from `@whop/sdk`
//   * Webhooks    : Standard Webhooks. Header `webhook-signature: v1,<b64>`;
//                   signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`
//                   with HMAC-SHA256, 5-minute replay window. Verified with the
//                   official `unwrapWebhook` helper from `@whop/sdk/helpers`.
//   * Sandbox     : https://sandbox-api.whop.com/api/v1  (WHOP_SANDBOX=true)
//   * Production  : https://api.whop.com/api/v1
//   * Payments    : client.payments.retrieve({ id }) / client.payments.refund({ id })
//
// Nothing here invents an endpoint, event name or provider id: every plan/variant
// id comes from the merchant's own Whop dashboard via env (see .env.example).
//
// Everything the browser ever receives is produced by `publicCheckoutInfo()` —
// client-safe fields only. The company API key and webhook secret never leave
// this module.
// ---------------------------------------------------------------------------

// The events this endpoint actually acts on. The authoritative list is the one
// configured on the webhook in the Whop dashboard — keep the two in step.
export const WHOP_EVENTS_SUBSCRIBED = [
  'payment.succeeded',
  'payment.failed',
  'payment.requires_action',
  'payment.pending',
  'payment.authorized',
  'refund.created',
  'refund.updated',
  'dispute.created',
  'dispute.updated',
];

export function whopConfigured() {
  return Boolean(env.WHOP_COMPANY_API_KEY && env.WHOP_COMPANY_ID);
}
export function whopWebhookConfigured() {
  return Boolean(env.WHOP_WEBHOOK_SECRET);
}
export function whopEnvironment() {
  return env.WHOP_SANDBOX ? 'sandbox' : 'production';
}
/** Admin-facing status. Presence + mode only — NEVER a secret. */
export function whopProviderStatus() {
  return {
    provider: 'whop',
    label: 'Whop',
    configured: whopConfigured(),
    webhookConfigured: whopWebhookConfigured(),
    environment: whopEnvironment(),
    sandbox: !!env.WHOP_SANDBOX,
    companyIdConfigured: Boolean(env.WHOP_COMPANY_ID),
    depositProductIdConfigured: Boolean(env.WHOP_DEPOSIT_PRODUCT_ID),
    subscribedEvents: WHOP_EVENTS_SUBSCRIBED,
    // Honest, non-leaking explanation when the integration is not live yet.
    note: !whopConfigured()
      ? 'Whop credentials are not configured on the server.'
      : env.WHOP_SANDBOX
        ? 'Sandbox mode — test payments only, no real money moves.'
        : 'Live mode — real money moves.',
  };
}

// ---------------------------------------------------------------------------
// SDK client (lazy — the process boots and serves reads without Whop creds)
// ---------------------------------------------------------------------------
let clientPromise = null;
export async function getWhop() {
  if (!whopConfigured()) {
    throw new AppError(
      'Payment provider is not configured yet. Please try again shortly or contact support.',
      503, 'PAYMENTS_NOT_CONFIGURED',
    );
  }
  if (!clientPromise) {
    // Dynamic import keeps startup free of Whop work and lets the app run
    // without the dependency in an environment that does not use it.
    clientPromise = import('@whop/sdk')
      .then(({ WhopClient, WhopEnvironment }) => new WhopClient({
        token: env.WHOP_COMPANY_API_KEY,
        environment: env.WHOP_SANDBOX ? WhopEnvironment.Sandbox : WhopEnvironment.Production,
      }))
      .catch((e) => {
        clientPromise = null; // allow a retry after a transient failure
        logger.error('Whop client init failed', { message: e?.message || 'error' });
        throw new AppError('Payment provider is unavailable right now. Please try again shortly.', 502, 'PAYMENT_PROVIDER_ERROR');
      });
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
//
// Primary path = the official `unwrapWebhook` helper (it also enforces the
// 5-minute replay window). The manual implementation below mirrors the
// documented Standard Webhooks algorithm and only runs if the SDK helper is
// unavailable, so verification never silently degrades to "trust the body".
// ---------------------------------------------------------------------------
export async function verifyWhopWebhook(rawBody, headers) {
  const secret = env.WHOP_WEBHOOK_SECRET;
  if (!secret) throw new AppError('Webhook secret not configured', 503, 'WEBHOOK_NOT_CONFIGURED');
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');

  // Official helper is authoritative. It performs the HMAC check and rejects
  // timestamps outside the 5-minute replay window.
  const sdkVerify = await loadSdkVerifier();
  if (sdkVerify) {
    try {
      return sdkVerify(payload, { headers: normalizeHeaders(headers), key: secret });
    } catch {
      // Bad signature, stale timestamp or malformed body — never "trust the body".
      throw new AppError('Invalid webhook signature', 401, 'WEBHOOK_SIGNATURE_INVALID');
    }
  }
  // SDK unavailable: fall back to the documented Standard Webhooks algorithm
  // rather than accepting an unsigned payload.
  return verifyManually(payload, headers, secret);
}

let sdkVerifierPromise = null;
function loadSdkVerifier() {
  if (!sdkVerifierPromise) {
    sdkVerifierPromise = import('@whop/sdk/helpers')
      .then((m) => (typeof m.unwrapWebhook === 'function' ? m.unwrapWebhook : null))
      .catch(() => null); // null => use the documented manual verifier
  }
  return sdkVerifierPromise;
}

/**
 * Documented fallback: HMAC-SHA256 over `{id}.{timestamp}.{raw body}`,
 * compared to the `v1,<base64>` value of the `webhook-signature` header in
 * constant time, rejecting timestamps older than 5 minutes.
 */
function verifyManually(payload, headers, secret) {
  const h = normalizeHeaders(headers);
  const id = h['webhook-id'];
  const timestamp = h['webhook-timestamp'];
  const signature = h['webhook-signature'];
  if (!id || !timestamp || !signature) {
    throw new AppError('Missing webhook signature headers', 401, 'WEBHOOK_SIGNATURE_INVALID');
  }
  // Replay protection: reject anything more than 5 minutes from now.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new AppError('Webhook timestamp outside the allowed window', 401, 'WEBHOOK_REPLAY_REJECTED');
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');
  // `webhook-signature` is `v1,<base64>` and may contain several comma-
  // separated versions; compare the v1 entry only.
  const ok = String(signature).split(',').some((part) => {
    const value = part.trim().replace(/^v\d+\s*/, '');
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!ok) throw new AppError('Invalid webhook signature', 401, 'WEBHOOK_SIGNATURE_INVALID');
  return JSON.parse(payload);
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.raw === 'function') return headers; // undici / fetch
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Sign a payload exactly as Whop does — used by tests to build fixtures. */
export function signWhopPayload({ id, timestamp, body, secret }) {
  const key = secret || env.WHOP_WEBHOOK_SECRET;
  const mac = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${mac}` };
}

// ---------------------------------------------------------------------------
// Preset top-up amounts -> Whop variant (checkout link) ids
//
// Amounts are chosen by the user but each preset must already exist as a Whop
// checkout link configured in the MERCHANT dashboard and listed in
// WHOP_DEPOSIT_PLAN_IDS. This is how provider ids stay out of source code: the
// app never mints, guesses or invents a `plan_…`/`prod_…` id.
// ---------------------------------------------------------------------------
export function depositPresets() {
  const raw = String(env.WHOP_DEPOSIT_PLAN_IDS || '');
  const presets = [];
  for (const chunk of raw.split(',')) {
    const [centsRaw, planId] = chunk.split(':').map((v) => (v || '').trim());
    const cents = Number(centsRaw);
    if (!planId || !Number.isInteger(cents) || cents <= 0) continue;
    presets.push({ amountMinor: cents, amount: (cents / 100).toFixed(2), planId });
  }
  return presets.sort((a, b) => a.amountMinor - b.amountMinor);
}

/** Resolve a preset strictly inside the server-configured allow-list. */
export function resolveDepositPreset(amountMinor) {
  const n = Number(amountMinor);
  if (!Number.isInteger(n)) {
    throw new AppError('Deposit amount must be a whole dollar amount', 400, 'INVALID_AMOUNT');
  }
  if (n < env.WALLET_MIN_DEPOSIT_CENTS || n > env.WALLET_MAX_DEPOSIT_CENTS) {
    throw new AppError(
      `Deposit amount must be between ${fmtMinor(env.WALLET_MIN_DEPOSIT_CENTS)} and ${fmtMinor(env.WALLET_MAX_DEPOSIT_CENTS)}`,
      400, 'DEPOSIT_AMOUNT_OUT_OF_RANGE',
    );
  }
  const match = depositPresets().find((p) => p.amountMinor === n);
  if (!match) {
    throw new AppError('Choose one of the available top-up amounts', 400, 'DEPOSIT_AMOUNT_NOT_OFFERED');
  }
  return match;
}

const fmtMinor = (c) => `$${(Number(c) / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Client-safe checkout payload for the Whop Checkout element.
//
// The browser gets: which variant to buy, the sandbox/production flag, our own
// opaque reference as metadata, and the return URL. It does NOT get a price to
// assert (the variant defines it), a secret, or a payment id.
// ---------------------------------------------------------------------------
export function publicCheckoutInfo({ reference, planId, returnPath }) {
  const base = (env.APP_URL || env.CLIENT_URL || '').replace(/\/+$/, '');
  // The return path is chosen by the SERVER. Only a same-site relative path is
  // accepted, so a bad caller cannot turn our own return URL into an open
  // redirect on Whop's side.
  const path = typeof returnPath === 'string' && /^\/[^/\\]/.test(returnPath)
    ? returnPath
    : `/wallet/transactions?deposit=${encodeURIComponent(reference)}`;
  return {
    provider: 'whop',
    providerLabel: 'Whop',
    planId,                          // Whop variant id, merchant-configured
    environment: whopEnvironment(),  // 'sandbox' | 'production'
    // Whop copies this onto the payment and every webhook about it — this is
    // the internal order reference used to reconcile the payment.
    metadata: { order_reference: reference },
    // Whop appends `payment` + `status` here; both are DISPLAY ONLY and are
    // never treated as proof of payment.
    returnUrl: `${base}${path}`,
    // Lets the UI fail honestly if credentials are missing.
    configured: whopConfigured(),
  };
}

/**
 * Client-safe config for a SUBSCRIPTION checkout element.
 *
 * The element is mounted inside our own checkout page — the buyer never leaves
 * the site, and the money settles to this Whop account. `orderId` is our
 * CheckoutOrder `_id` (already opaque); the buyer only ever sees it in a URL.
 */
export function subscriptionCheckoutInfo({ orderId, reference, planId }) {
  return publicCheckoutInfo({
    reference,
    planId,
    returnPath: `/checkout/success?id=${encodeURIComponent(String(orderId))}`,
  });
}

// ---------------------------------------------------------------------------
// Server-side payment lookups (the authoritative, never-the-browser path)
// ---------------------------------------------------------------------------

/** Map a Whop payment object to a conservative internal status. */
export function interpretWhopPayment(payment) {
  if (!payment) return { paid: false, refunded: false, unknown: true };
  const status = String(payment.status || '').toLowerCase();
  const substatus = String(payment.substatus || '').toLowerCase();
  const refundedAmount = Number(payment.refunded_amount || 0);
  const refunded = refundedAmount > 0 || substatus === 'refunded';
  // Only an unambiguous `paid` counts as confirmed. Everything else is treated
  // as not-yet-confirmed so callers keep waiting instead of granting credit.
  const paid = status === 'paid';
  return { paid, refunded, status, substatus, refundedAmount };
}

/**
 * Ask Whop directly whether a payment happened.
 *
 * Used by the authenticated deposit verify endpoint: the browser is never
 * believed, and an unreachable provider is NOT proof of payment — it returns
 * confirmed:false so the UI keeps polling.
 */
export async function retrieveDepositPayment(paymentId) {
  const id = String(paymentId || '');
  if (!/^pay_[A-Za-z0-9_]+$/.test(id)) return { confirmed: false, reason: 'unrecognised provider reference' };
  try {
    const client = await getWhop();
    const payment = await client.payments.retrieve({ id });
    const verdict = interpretWhopPayment(payment);
    return {
      confirmed: verdict.paid && !verdict.refunded,
      refunded: verdict.refunded,
      status: verdict.status || null,
      substatus: verdict.substatus || null,
      // Whop amounts are decimal major units (e.g. 25.0); keep as-is for audit.
      amount: Number.isFinite(Number(payment.total)) ? Number(payment.total)
        : (Number.isFinite(Number(payment.usd_total)) ? Number(payment.usd_total) : null),
      currency: payment.currency ? String(payment.currency).toUpperCase() : null,
      metadata: payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : null,
      paidAt: payment.paid_at || null,
      paymentId: payment.id,
      reason: verdict.paid ? null : `provider status=${verdict.status || 'unknown'}`,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    return { confirmed: false, reason: `lookup failed: ${e?.message || 'error'}` };
  }
}

/** Issue a provider refund. Only ever called from the audited admin flow. */
export async function refundDepositPayment(paymentId, amountMinor, reason) {
  const client = await getWhop();
  // Whop refunds in decimal major units.
  const payload = { id: String(paymentId) };
  if (Number.isInteger(amountMinor) && amountMinor > 0) payload.amount = Number((amountMinor / 100).toFixed(2));
  if (reason) payload.reason = String(reason).slice(0, 300);
  const refund = await client.payments.refund(payload);
  return refund;
}
