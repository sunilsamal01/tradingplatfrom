import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Whop SUBSCRIPTION checkout — the embedded-element path.
//
// These run the REAL services against a real (in-memory) MongoDB, because the
// invariants under test are exactly the database ones: an order settles at most
// once, the amount must match what we recorded, and access is granted only
// after the signed webhook says so.
//
// The webhook cases build genuinely signed payloads (the same Standard Webhooks
// HMAC the production endpoint verifies) and call the real controller, so the
// verify -> journal -> dispatch -> settle chain is exercised end to end.
//
// All credentials below are obviously fake fixtures, never real values.
// ---------------------------------------------------------------------------

process.env.PAYMENT_PROVIDER = 'whop';
process.env.WHOP_COMPANY_API_KEY = 'apik_test_only_not_a_real_key';
process.env.WHOP_COMPANY_ID = 'biz_test_only';
process.env.WHOP_WEBHOOK_SECRET = 'ws_test_only_not_a_real_secret';
process.env.WHOP_SANDBOX = 'true';
process.env.APP_URL = 'http://localhost:5173';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_for_quote_signing';
process.env.CHECKOUT_TAX_BPS = '0';
// Wallet top-ups stay off: the subscription path must work with them disabled.
process.env.WALLET_DEPOSITS_ENABLED = 'false';
// Mail is force-disabled for this suite: the local .env holds REAL SMTP
// credentials, and a test must never send mail. Empty (not deleted) values,
// because dotenv.config() would repopulate anything absent from the file.
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

// `skip` is consumed by every test's options: if the in-memory database cannot
// be started the whole file reports SKIPPED, never a false pass.
let skip = 'in-memory MongoDB not started';
let mongod = null;
let mongoose = null;
let checkout = null;
let whop = null;
let controller = null;
let planService = null;
let Plan = null;
let User = null;
let Payment = null;
let CheckoutOrder = null;
let WhopEvent = null;
let Subscription = null;
let AuditLog = null;

const SECRET = 'ws_test_only_not_a_real_secret';

try {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(mongod.getUri(), { dbName: 'whop_subscriptions_test' });

  checkout = await import('../services/checkoutService.js');
  whop = await import('../services/whopService.js');
  controller = await import('../controllers/whopWebhookController.js');
  planService = await import('../services/planService.js');
  Plan = (await import('../models/Plan.js')).default;
  User = (await import('../models/User.js')).default;
  Payment = (await import('../models/Payment.js')).default;
  CheckoutOrder = (await import('../models/CheckoutOrder.js')).default;
  WhopEvent = (await import('../models/WhopEvent.js')).default;
  Subscription = (await import('../models/Subscription.js')).default;
  AuditLog = (await import('../models/AuditLog.js')).default;

  // Build the declared indexes — the UNIQUE ones are load-bearing for
  // exactly-once settlement, so a test without them would be meaningless.
  await Promise.all([
    Plan.init(), User.init(), Payment.init(), CheckoutOrder.init(),
    WhopEvent.init(), Subscription.init(), AuditLog.init(),
  ]);
  skip = false;
  after(async () => {
    try { await mongoose.disconnect(); } catch { /* already gone */ }
    try { await mongod.stop(); } catch { /* already gone */ }
  });
} catch (e) {
  skip = `in-memory MongoDB unavailable (${e?.code || e?.name || 'error'}): ${String(e?.message || e).slice(0, 200)}`;
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
let seq = 0;
const tag = () => `${Date.now().toString(36)}${(seq += 1)}`;

async function makePlan({ slug, priceCents = 2000, whopId = 'plan_test_pro' } = {}) {
  return Plan.create({
    name: `Test ${slug}`,
    slug,
    priceCents,
    currency: 'USD',
    interval: 'month',
    intervalCount: 1,
    status: 'published',
    providerPriceIds: { whop: whopId },
  });
}

async function makeUser() {
  return User.create({ email: `buyer_${tag()}@example.test`, name: 'Test Buyer', status: 'active' });
}

/** Quote -> sign -> create the order, exactly like the API does. */
async function placeOrder(userId, slug, idem) {
  const { token } = await checkout.createQuote({ type: 'subscription', planSlug: slug });
  const { order } = await checkout.createCheckoutOrder({
    userId, quoteToken: token, idempotencyKey: idem || `idem_${tag()}`,
  });
  return order;
}

/** Approve the order for payment and return the client-safe session. */
async function startSession(userId, orderId) {
  return checkout.createPaymentSession({ userId, orderId });
}

function makeRes() {
  const out = { code: 0, body: null };
  const res = {
    status(c) { out.code = c; return res; },
    json(b) { out.body = b; return res; },
    send(b) { out.body = b; return res; },
    setHeader() { return res; },
  };
  return { res, out };
}

let evtSeq = 0;
/** Deliver a genuinely signed webhook through the real controller. */
async function deliverWith(type, data, id) {
  const body = JSON.stringify({ id, type, data });
  const headers = whop.signWhopPayload({
    id: `msg_${id}`,
    timestamp: Math.floor(Date.now() / 1000),
    body,
    secret: SECRET,
  });
  const { res, out } = makeRes();
  await controller.whopWebhook({ body: Buffer.from(body), headers, requestId: 'test' }, res);
  return { out, id };
}
const deliver = (type, data) => deliverWith(type, data, `evt_test_${(evtSeq += 1)}_${tag()}`);

/** A distinct provider payment id per order, so tests cannot cross-link. */
const paymentIdFor = (order) => `pay_test_${order.reference.replace(/[^A-Za-z0-9]/g, '')}`;

const paidEvent = (order) => ({
  id: paymentIdFor(order), status: 'paid', total: 20, currency: 'USD',
  metadata: { order_reference: order.reference },
});

// ---------------------------------------------------------------------------
// 1. The payment session handed to the browser
// ---------------------------------------------------------------------------

test('the Whop session is client-safe and returns to OUR success page', { skip }, async () => {
  const plan = await makePlan({ slug: `pro_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);

  const sess = await startSession(user._id, order._id);

  assert.equal(sess.mode, 'whop');
  assert.equal(sess.requiresPayment, true);
  assert.equal(sess.amountCents, 2000);
  assert.equal(sess.currency, 'USD');
  assert.equal(sess.whop.planId, 'plan_test_pro');            // the variant the server chose
  assert.equal(sess.whop.metadata.order_reference, order.reference);
  assert.equal(sess.whop.configured, true);
  assert.ok(
    sess.whop.returnUrl.endsWith(`/checkout/success?id=${order._id}`),
    `returnUrl should come back to our own page, got ${sess.whop.returnUrl}`,
  );

  // Nothing that could let the page charge, credit or impersonate may ship.
  const flat = JSON.stringify(sess).toLowerCase();
  for (const needle of ['apik_', 'ws_', 'biz_test', 'secret', 'api_key', 'api_key']) {
    assert.ok(!flat.includes(needle), `the browser payload must not contain "${needle}"`);
  }

  const fresh = await CheckoutOrder.findById(order._id);
  assert.equal(fresh.provider, 'whop');
  assert.equal(fresh.status, 'awaiting_payment');
});

test('a plan with no Whop variant id is refused, never guessed', { skip }, async () => {
  const plan = await makePlan({ slug: `unlinked_${tag()}`, whopId: null });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);

  await assert.rejects(
    () => startSession(user._id, order._id),
    (e) => e.code === 'PLAN_NOT_LINKED' && e.statusCode === 409,
  );
});

test('the server controls the return path (no open redirect)', { skip }, async () => {
  const abs = whop.publicCheckoutInfo({ reference: 'SLT-X', planId: 'plan_x', returnPath: 'https://evil.example.com/steal' });
  assert.equal(abs.returnUrl, 'http://localhost:5173/wallet/transactions?deposit=SLT-X');

  const protoRelative = whop.publicCheckoutInfo({ reference: 'SLT-X', planId: 'plan_x', returnPath: '//evil.example.com/steal' });
  assert.ok(!protoRelative.returnUrl.includes('evil.example.com'));
  assert.ok(protoRelative.returnUrl.includes('/wallet/transactions'));
});

// ---------------------------------------------------------------------------
// 2. Settlement — the whole point
// ---------------------------------------------------------------------------

test('payment.succeeded activates the subscription exactly once', { skip }, async () => {
  const plan = await makePlan({ slug: `settle_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);

  const { out, id } = await deliver('payment.succeeded', paidEvent(order));
  assert.equal(out.code, 200);

  const fresh = await CheckoutOrder.findById(order._id);
  assert.equal(fresh.status, 'paid');
  assert.ok(fresh.paidAt);

  const pay = await Payment.findOne({ checkoutOrderId: order._id });
  assert.ok(pay, 'a canonical Payment row is written for the settled order');
  assert.equal(pay.provider, 'whop');
  assert.equal(pay.amountCents, 2000);
  assert.equal(pay.status, 'paid');

  const sub = await Subscription.findOne({ userId: user._id });
  assert.ok(sub, 'the subscription is activated at settlement');
  assert.equal(sub.status, 'active');
  assert.equal(fresh.subscriptionId?.toString(), sub._id.toString());

  const u = await User.findById(user._id);
  assert.equal(u.subscriptionStatus, 'active');

  const ev = await WhopEvent.findOne({ eventId: id });
  assert.equal(ev.status, 'processed');

  // ---- and it can never happen twice ------------------------------------
  const replay = await deliverWith('payment.succeeded', paidEvent(order), id);
  assert.equal(replay.out.code, 200);
  assert.equal(replay.out.body?.message, 'Already processed');

  const secondRedelivery = await deliver('payment.succeeded', paidEvent(order));
  assert.equal(secondRedelivery.out.code, 200);

  assert.equal(await Payment.countDocuments({ checkoutOrderId: order._id }), 1, 'no second Payment');
  assert.equal(await Subscription.countDocuments({ userId: user._id }), 1, 'no second Subscription');
});

test('a wrong amount is held for review instead of activating the plan', { skip }, async () => {
  const plan = await makePlan({ slug: `mismatch_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);

  const { out, id } = await deliver('payment.succeeded', {
    id: 'pay_test_cheap', status: 'paid', total: 0.01, currency: 'USD',
    metadata: { order_reference: order.reference },
  });
  assert.equal(out.code, 200);

  const fresh = await CheckoutOrder.findById(order._id);
  assert.notEqual(fresh.status, 'paid');
  assert.equal(await Payment.countDocuments({ checkoutOrderId: order._id }), 0);
  assert.equal(await Subscription.countDocuments({ userId: user._id }), 0, 'no access for a wrong amount');

  const ev = await WhopEvent.findOne({ eventId: id });
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /amount mismatch/);
});

test('a currency mismatch is held for review too', { skip }, async () => {
  const plan = await makePlan({ slug: `currency_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);

  await deliver('payment.succeeded', {
    id: 'pay_test_inr', status: 'paid', total: 20, currency: 'INR',
    metadata: { order_reference: order.reference },
  });

  const fresh = await CheckoutOrder.findById(order._id);
  assert.notEqual(fresh.status, 'paid');
  assert.equal(await Subscription.countDocuments({ userId: user._id }), 0);
});

test('payment.failed marks the order failed and grants nothing', { skip }, async () => {
  const plan = await makePlan({ slug: `failed_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);

  const { out } = await deliver('payment.failed', {
    id: 'pay_test_declined', decline_code: 'insufficient_funds',
    metadata: { order_reference: order.reference },
  });
  assert.equal(out.code, 200);

  const fresh = await CheckoutOrder.findById(order._id);
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.failureReason, /insufficient_funds|unsuccessful/);
  assert.equal(await Subscription.countDocuments({ userId: user._id }), 0);
});

test('a reference we do not know is parked, never credited', { skip }, async () => {
  const { out, id } = await deliver('payment.succeeded', {
    id: 'pay_test_orphan', status: 'paid', total: 20, currency: 'USD',
    metadata: { order_reference: 'SLT-DOES-NOT-EXIST' },
  });
  assert.equal(out.code, 200);

  const ev = await WhopEvent.findOne({ eventId: id });
  assert.equal(ev.status, 'unmatched');
  assert.equal(await Payment.countDocuments({ providerOrderId: 'pay_test_orphan' }), 0);
});

test('an order owned by another provider is never settled by Whop', { skip }, async () => {
  const plan = await makePlan({ slug: `other_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  // Simulate an order that was routed to Razorpay/Stripe (provider stays 'none'
  // until a session is created — here we force it away from Whop explicitly).
  await CheckoutOrder.updateOne({ _id: order._id }, { $set: { provider: 'razorpay' } });

  const settled = await checkout.settleWhopCheckoutOrder({
    reference: order.reference, providerPaymentId: 'pay_test_notours', providerAmount: 20, providerCurrency: 'USD',
  });
  assert.equal(settled, null);

  const fresh = await CheckoutOrder.findById(order._id);
  assert.notEqual(fresh.status, 'paid');
  assert.equal(await Subscription.countDocuments({ userId: user._id }), 0);
});

// ---------------------------------------------------------------------------
// 3. Refunds and terminal states
// ---------------------------------------------------------------------------

test('a refund is recorded but does NOT revoke access', { skip }, async () => {
  const plan = await makePlan({ slug: `refund_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);
  await deliver('payment.succeeded', paidEvent(order));

  const before = await Subscription.findOne({ userId: user._id });
  assert.equal(before.status, 'active');

  const { out, id } = await deliver('refund.created', {
    id: paymentIdFor(order), metadata: { order_reference: order.reference },
  });
  assert.equal(out.code, 200);

  const fresh = await CheckoutOrder.findById(order._id);
  assert.equal(fresh.status, 'refunded');
  const pay = await Payment.findOne({ checkoutOrderId: order._id });
  assert.equal(pay.status, 'refunded');

  const after = await Subscription.findOne({ userId: user._id });
  assert.equal(after.status, 'active', 'a refund keeps access to the paid period');

  const ev = await WhopEvent.findOne({ eventId: id });
  assert.equal(ev.status, 'processed');
});

test('a late failure never downgrades a refunded order', { skip }, async () => {
  const plan = await makePlan({ slug: `late_${tag()}` });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);
  await deliver('payment.succeeded', paidEvent(order));
  await deliver('refund.created', { id: paymentIdFor(order), metadata: { order_reference: order.reference } });

  const r = await checkout.failWhopCheckoutOrder({ reference: order.reference, reason: 'late event' });
  assert.equal(r.terminal, 'refunded');

  const fresh = await CheckoutOrder.findById(order._id);
  assert.equal(fresh.status, 'refunded');
});

// ---------------------------------------------------------------------------
// 3b. Receipt email + billing history
// ---------------------------------------------------------------------------

test('settlement emails one receipt to the buyer (Whop path)', { skip }, async () => {
  const plan = await makePlan({ slug: `receipt_${tag()}`, priceCents: 5000 });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);

  const r = await checkout.settleWhopCheckoutOrder({
    reference: order.reference, providerPaymentId: `pay_test_rcpt_${order.reference}`, providerAmount: 50, providerCurrency: 'USD',
  });

  assert.equal(r.alreadyPaid, false);
  // The receipt is addressed to the buyer's real address, and a second
  // settlement cannot send a second one.
  assert.equal(r.fulfilment.receiptSentTo, user.email);
  const again = await checkout.settleWhopCheckoutOrder({
    reference: order.reference, providerPaymentId: `pay_test_rcpt_${order.reference}`, providerAmount: 50, providerCurrency: 'USD',
  });
  assert.equal(again.alreadyPaid, true);
  assert.equal(again.fulfilment, undefined, 'an already-paid order must not re-fulfil or re-email');
});

test('the receipt renders and degrades gracefully when mail is unconfigured', { skip }, async () => {
  const { buildSubscriptionReceipt, sendSubscriptionReceipt } = await import('../services/emailService.js');

  // Content is asserted on the pure builder, so no mail is ever sent.
  const { subject, html, text } = buildSubscriptionReceipt({
    name: 'Buyer', planName: 'Pro', amount: '50.00', currency: 'USD', reference: 'SLT-TEST-1',
    provider: 'whop', interval: 'month', intervalCount: 1, renewsOn: new Date('2026-12-01'),
  });
  assert.match(subject, /Pro/);
  assert.match(html, /\$50\.00/);
  assert.match(html, /SLT-TEST-1/);
  assert.match(html, /Whop/, 'the receipt names the method the buyer actually used');
  assert.match(html, /\/subscription/, 'links to a route that exists');
  assert.match(text, /SLT-TEST-1/);

  // A DB-authored plan name containing markup must be escaped, not injected.
  const risky = buildSubscriptionReceipt({ planName: '<img src=x onerror=alert(1)>', amount: '1.00', currency: 'USD' });
  assert.ok(!risky.html.includes('<img'), 'plan names are escaped before interpolation');

  // Every field optional — a bare receipt still renders without throwing.
  assert.match(buildSubscriptionReceipt({}).subject, /Receipt/);

  // And with SMTP unconfigured the send degrades to logging, never throwing.
  const out = await sendSubscriptionReceipt('buyer@example.test', { planName: 'Pro', amount: '50.00', currency: 'USD' });
  assert.equal(out?.queued, false);
  assert.equal(out?.logged, true);
});

test('the billing history shows the paid Whop order with its reference', { skip }, async () => {
  const plan = await makePlan({ slug: `history_${tag()}`, priceCents: 10000 });
  const user = await makeUser();
  const order = await placeOrder(user._id, plan.slug);
  await startSession(user._id, order._id);
  await checkout.settleWhopCheckoutOrder({
    reference: order.reference, providerPaymentId: `pay_test_hist_${order.reference}`, providerAmount: 100, providerCurrency: 'USD',
  });

  // Exercise the real controller the profile page calls.
  const { billing } = await import('../controllers/subscriptionController.js');
  const { res, out } = makeRes();
  await billing({ user: { sub: String(user._id) }, query: {} }, res);

  const items = out.body?.data?.items || [];
  assert.equal(items.length, 1);
  assert.equal(items[0].provider, 'whop');
  assert.equal(items[0].status, 'paid');
  assert.equal(items[0].amount, 100);
  assert.equal(items[0].currency, 'USD');
  // The reference the receipt quotes is what the table shows.
  assert.equal(items[0].purchaseRef, order.reference);
});

// ---------------------------------------------------------------------------
// 4. Admin wiring — the operator can actually link a variant
// ---------------------------------------------------------------------------

test('the recommended webhook URL is the backend origin, never APP_URL', { skip }, async () => {
  const had = process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  assert.equal(whop.recommendedWebhookUrl(), null, 'unknown locally — never guessed from APP_URL');

  process.env.RAILWAY_PUBLIC_DOMAIN = 'backend.example.test';
  assert.equal(whop.recommendedWebhookUrl(), 'https://backend.example.test/api/webhooks/whop');
  // APP_URL is the frontend origin; using it would send events to a 405.
  assert.ok(!whop.recommendedWebhookUrl().startsWith(process.env.APP_URL));

  const bare = 'https://backend.example.test/';
  process.env.RAILWAY_PUBLIC_DOMAIN = bare;
  assert.equal(whop.recommendedWebhookUrl(), 'https://backend.example.test/api/webhooks/whop');

  if (had === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN; else process.env.RAILWAY_PUBLIC_DOMAIN = had;
});

test('the admin plan payload carries the Whop variant id', { skip }, async () => {
  const plan = await makePlan({ slug: `admin_${tag()}`, whopId: 'plan_admin_linked' });
  const admin = planService.toAdminPlan(plan);
  assert.equal(admin.providerPriceIds.whop, 'plan_admin_linked');

  // And an admin write round-trips it (this is what the Pricing screen sends).
  const updated = await planService.updatePlan(null, plan._id, {
    providerPriceIds: { whop: 'plan_admin_updated', razorpay: null, stripe: null },
  });
  const after1 = await Plan.findById(plan._id);
  assert.equal(after1.providerPriceIds.whop, 'plan_admin_updated');
  assert.ok(updated);
});
