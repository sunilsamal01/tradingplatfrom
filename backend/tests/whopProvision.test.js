import test from 'node:test';
import assert from 'node:assert/strict';
import { provisionWhop, variantPayload, variantMismatch, collect } from '../services/whopProvisioning.js';

// ---------------------------------------------------------------------------
// Provisioning is the one part of the Whop integration that WRITES to the
// merchant's live account, so it is exercised here against a stub client:
// dry runs must write nothing, applies must be idempotent, a reused webhook
// must not pretend to have a secret, and a provider error must be reported
// rather than thrown into the middle of a live run.
// ---------------------------------------------------------------------------

const ACCOUNT = 'biz_test';
const TITLE = 'SoloLevelingTrad';
const HOOK = 'https://backend.test/api/webhooks/whop';
const EVENTS = ['payment.succeeded', 'payment.failed'];

const plan = (over = {}) => ({
  name: 'Starter', slug: 'starter', priceCents: 2000, currency: 'USD',
  interval: 'month', intervalCount: 1, linked: null, ...over,
});

const CATALOGUE = [
  plan(),
  plan({ name: 'Pro', slug: 'pro', priceCents: 5000 }),
  plan({ name: 'Elite', slug: 'elite', priceCents: 10000 }),
  plan({ name: 'Ultimate', slug: 'ultimate', priceCents: 15000 }),
];

/** A stand-in for the Whop client: records writes, serves what it holds. */
function makeClient({ products = [], variants = [], webhooks = [], failWebhook = false } = {}) {
  const writes = { products: [], variants: [], webhooks: [] };
  return {
    writes,
    state: { products, variants, webhooks },
    products: {
      async list() { return products; },
      async create(p) {
        writes.products.push(p);
        const made = { id: `prod_${writes.products.length}`, title: p.title };
        products.push(made);
        return made;
      },
    },
    variants: {
      async list({ product_ids }) { return variants.filter((v) => v.product_id === product_ids?.[0]); },
      async retrieve({ id }) {
        const v = variants.find((x) => x.id === id);
        if (!v) throw new Error('variant not found');
        return v;
      },
      async create(p) {
        writes.variants.push(p);
        if (!p.product_id) throw new Error('product_id is required');
        const made = { id: `plan_${p.metadata?.plan_slug}`, title: p.title, product_id: p.product_id };
        variants.push(made);
        return made;
      },
    },
    webhooks: {
      async list() { return webhooks; },
      async create(p) {
        writes.webhooks.push(p);
        if (failWebhook) { const e = new Error('Forbidden'); e.statusCode = 403; throw e; }
        const made = { id: 'hook_1', url: p.url, webhook_secret: 'ws_test_secret' };
        webhooks.push(made);
        return made;
      },
    },
  };
}

const run = (client, apply, plans = CATALOGUE) =>
  provisionWhop({ client, accountId: ACCOUNT, plans, productTitle: TITLE, webhookUrl: HOOK, events: EVENTS, apply });

test('a dry run writes nothing and names every action it would take', async () => {
  const client = makeClient();
  const r = await run(client, false);

  assert.deepEqual(client.writes.products, [], 'no product may be created');
  assert.deepEqual(client.writes.variants, [], 'no variant may be created');
  assert.deepEqual(client.writes.webhooks, [], 'no webhook may be created');

  assert.deepEqual(r.errors, []);
  assert.equal(r.product.action, 'would-create');
  assert.equal(r.variants.length, 4);
  assert.ok(r.variants.every((v) => v.action === 'would-create' && v.id === null));
  assert.equal(r.webhook.action, 'would-create');
  assert.equal(r.webhook.secret, null);
  assert.equal(r.variantIdBySlug.size, 0, 'nothing exists, so nothing can be linked');
});

test('the variant payload matches the plan it sells', async () => {
  const client = makeClient();
  const r = await run(client, false);
  const payload = r.variants.find((v) => v.slug === 'pro').payload;

  assert.equal(payload.plan_type, 'renewal', 'subscriptions, not one-off charges');
  assert.equal(payload.billing_period, 30, 'a monthly plan bills every 30 days');
  // Whop charges initial_price PLUS the first renewal at checkout, and
  // initial_price is a one-time signup fee. Setting it to the plan price made a
  // $20/month plan take $40 on day one, which is the bug this pins.
  assert.equal(payload.initial_price, 0, 'no signup fee — the buyer pays one period');
  assert.equal(payload.renewal_price, 50, 'and then the plan price every period');
  // The API rejects the uppercase form; the response comes back lowercase.
  assert.equal(payload.currency, 'usd');
  assert.equal(payload.product_id, null, 'no product exists yet in a dry run');
  assert.equal(payload.metadata.plan_slug, 'pro', 'so a payment can be traced back to its plan');
  assert.equal(payload.visibility, 'visible');
});

test('a yearly plan bills every 365 days and honours intervalCount', async () => {
  const yearly = variantPayload(plan({ interval: 'year', intervalCount: 1 }), { accountId: ACCOUNT, productId: 'prod_1' });
  assert.equal(yearly.billing_period, 365);

  const biennial = variantPayload(plan({ interval: 'year', intervalCount: 2 }), { accountId: ACCOUNT, productId: 'prod_1' });
  assert.equal(biennial.billing_period, 730);
});

test('a variant title is truncated to Whop’s 30-character limit', async () => {
  const long = variantPayload(plan({ name: 'Ultra Mega Deluxe Trading Plan' }), { accountId: ACCOUNT, productId: 'prod_1' });
  assert.equal(long.title.length, 30);
});

test('apply creates the product, four variants and the webhook, then links them', async () => {
  const client = makeClient();
  const r = await run(client, true);

  assert.deepEqual(r.errors, []);
  assert.equal(r.product.action, 'created');
  assert.equal(client.writes.products.length, 1);
  assert.equal(client.writes.variants.length, 4);
  assert.equal(client.writes.webhooks.length, 1);

  // Every variant hangs off the product that was just created.
  assert.ok(client.writes.variants.every((p) => p.product_id === r.product.id));

  assert.equal(r.webhook.action, 'created');
  assert.equal(r.webhook.secret, 'ws_test_secret', 'the signing secret is surfaced for WHOP_WEBHOOK_SECRET');
  assert.deepEqual(client.writes.webhooks[0].events, EVENTS);
  assert.equal(client.writes.webhooks[0].url, HOOK);
  assert.equal(client.writes.webhooks[0].enabled, true);

  assert.equal(r.variantIdBySlug.get('starter'), 'plan_starter');
  assert.equal(r.variantIdBySlug.get('ultimate'), 'plan_ultimate');
});

test('re-running is idempotent — a second apply creates nothing', async () => {
  const client = makeClient();
  const first = await run(client, true);
  const second = await run(client, true);

  assert.equal(client.writes.products.length, 1, 'the product is found, not duplicated');
  assert.equal(client.writes.variants.length, 4, 'each variant is found, not duplicated');
  assert.equal(client.writes.webhooks.length, 1, 'the endpoint is found, not duplicated');

  assert.equal(second.product.action, 'reuse');
  assert.ok(second.variants.every((v) => v.action === 'found'));
  assert.equal(second.webhook.action, 'reuse');
  assert.deepEqual(second.variantIdBySlug, first.variantIdBySlug);
});

test('a reused webhook reports no secret rather than a stale one', async () => {
  const client = makeClient({ webhooks: [{ id: 'hook_existing', url: HOOK, webhook_secret: null }] });
  const r = await run(client, true);

  assert.equal(r.webhook.action, 'reuse');
  assert.equal(r.webhook.secret, null, 'Whop will not re-show it, so we must not imply we have it');
  assert.equal(client.writes.webhooks.length, 0);
});

test('plans already linked in the database are left alone', async () => {
  const client = makeClient();
  const plans = CATALOGUE.map((p) => (p.slug === 'pro' ? { ...p, linked: 'plan_existing' } : p));
  const r = await run(client, true, plans);

  assert.equal(r.variantIdBySlug.get('pro'), 'plan_existing');
  assert.equal(client.writes.variants.length, 3, 'only the three unlinked plans are created');
  assert.ok(r.variants.find((v) => v.slug === 'pro').action === 'already-linked');
});

test('a provider error is collected, not thrown, and the run continues', async () => {
  const client = makeClient({ failWebhook: true });
  const r = await run(client, true);

  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].step, /webhook/);
  assert.equal(r.webhook, null);
  // The variants were still provisioned — one failing step does not abandon the rest.
  assert.equal(client.writes.variants.length, 4);
  assert.equal(r.variantIdBySlug.size, 4);
});

test('a zero-price plan is skipped — Whop has no paid variant at zero', async () => {
  const client = makeClient();
  const r = await run(client, true, [plan({ name: 'Free', slug: 'free', priceCents: 0 })]);

  const free = r.variants.find((v) => v.slug === 'free');
  assert.equal(free.action, 'skip');
  assert.equal(free.id, null);
  assert.deepEqual(client.writes.variants, []);
  assert.deepEqual(r.errors, []);
});

test('an unreachable product list blocks creation rather than risking a duplicate', async () => {
  const client = makeClient();
  client.products.list = async () => { throw new Error('ENOTFOUND api.whop.com'); };
  const r = await run(client, true);

  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /ENOTFOUND/);
  assert.equal(r.product.action, 'blocked', 'we could not read, so we must not write');
  assert.deepEqual(client.writes.products, [], 'a read failure must never create a second product');
  // Without a product there is nowhere to attach a variant.
  assert.deepEqual(client.writes.variants, []);
  assert.equal(r.variants.every((v) => v.action === 'skip'), true);
  // The webhook does not depend on the product list, so it is still provisioned.
  assert.equal(client.writes.webhooks.length, 1);
});

test('a variant list failure blocks variant creation', async () => {
  const client = makeClient({ products: [{ id: 'prod_1', title: TITLE }] });
  client.variants.list = async () => { throw new Error('ETIMEDOUT'); };
  const r = await run(client, true);

  assert.ok(r.errors.some((e) => /variants/.test(e.step)));
  assert.deepEqual(client.writes.variants, [], 'never create a variant we could not match against');
  assert.equal(r.variants.every((v) => v.action === 'blocked'), true);
  assert.equal(r.variantIdBySlug.size, 0, 'nothing was created, so nothing may be linked');
});

test('an existing product is reused even when its title differs only in case', async () => {
  // The live account carries "Sololevelingtrad"; an exact match against
  // "SoloLevelingTrad" would have created a duplicate product.
  const client = makeClient({ products: [{ id: 'prod_existing', title: 'Sololevelingtrad' }] });
  const r = await run(client, true);

  assert.equal(r.product.action, 'reuse');
  assert.equal(r.product.id, 'prod_existing');
  assert.deepEqual(client.writes.products, [], 'the existing product is adopted, not duplicated');
});

test('an existing variant at the right price is reused', async () => {
  const client = makeClient({
    products: [{ id: 'prod_1', title: TITLE }],
    variants: [{ id: 'plan_starter', title: 'Starter', product_id: 'prod_1', initial_price: 0, renewal_price: 20, currency: 'USD' }],
  });
  const r = await run(client, true, [plan()]);

  assert.equal(r.variantIdBySlug.get('starter'), 'plan_starter');
  assert.deepEqual(client.writes.variants, []);
  assert.deepEqual(r.errors, []);
});

test('an existing variant whose price disagrees with the plan is never linked', async () => {
  // Linking this would make every purchase park for review, so it must be
  // refused and reported instead.
  const client = makeClient({
    products: [{ id: 'prod_1', title: TITLE }],
    variants: [{ id: 'plan_starter', title: 'Starter', product_id: 'prod_1', initial_price: 0, renewal_price: 5, currency: 'USD' }],
  });
  const r = await run(client, true, [plan()]);

  assert.equal(r.variants[0].action, 'mismatch');
  assert.equal(r.variantIdBySlug.size, 0, 'a wrong-priced variant must never be linked');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].step, /variant/);
  assert.deepEqual(client.writes.variants, [], 'a mismatched variant is not replaced either');
});

test('a variant title that differs only in case is still matched', async () => {
  const client = makeClient({
    products: [{ id: 'prod_1', title: TITLE }],
    variants: [{ id: 'plan_pro', title: 'PRO', product_id: 'prod_1', initial_price: 0, renewal_price: 50, currency: 'USD' }],
  });
  const r = await run(client, true, [plan({ name: 'Pro', slug: 'pro', priceCents: 5000 })]);

  assert.equal(r.variantIdBySlug.get('pro'), 'plan_pro');
  assert.deepEqual(client.writes.variants, []);
});

test('variantMismatch refuses a variant that cannot faithfully sell a plan', () => {
  const p = plan(); // Starter, 2000 cents, USD, monthly
  const good = { renewal_price: 20, initial_price: 0, currency: 'usd', plan_type: 'renewal' };

  assert.equal(variantMismatch(p, good), null, 'an exact match is linkable');

  assert.match(variantMismatch(p, { ...good, renewal_price: 5 }), /costs 5/);
  assert.match(variantMismatch(p, { ...good, currency: 'inr' }), /priced in INR/);
  assert.match(variantMismatch(p, { ...good, plan_type: 'one_time' }), /not a recurring renewal/);
  // A one-off variant at the right price still cannot sell a subscription.
  assert.match(variantMismatch(p, { ...good, plan_type: 'one_time' }), /one_time/);

  // The exact bug that shipped: initial_price is a one-time signup fee charged
  // ON TOP of the first period, so a $20 plan with initial_price 20 took $40.
  assert.match(variantMismatch(p, { ...good, initial_price: 20 }), /signup fee/);
  assert.match(variantMismatch(p, { ...good, initial_price: 20 }), /on top of the first period/);

  // Unknown information must not be treated as a mismatch: refusing on data we
  // were not given would block linking for no reason.
  assert.equal(variantMismatch(p, { currency: 'usd', plan_type: 'renewal' }), null);
  assert.equal(variantMismatch(p, {}), null);
});

test('collect() drains a Whop page, a promise of one, and a plain array', async () => {
  assert.deepEqual(await collect([1, 2, 3]), [1, 2, 3]);
  async function* gen() { yield 'a'; yield 'b'; }
  assert.deepEqual(await collect(gen()), ['a', 'b']);
  assert.deepEqual(await collect(undefined), []);
  // The SDK's list methods return a promise, so collect must accept one.
  assert.deepEqual(await collect(Promise.resolve(['x', 'y'])), ['x', 'y']);
});
