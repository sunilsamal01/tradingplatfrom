// ---------------------------------------------------------------------------
// Whop-side provisioning for the subscription checkout.
//
// Orchestration only: every Whop call goes through the injected `client`, so
// the whole flow (find-or-create product, one recurring variant per plan, the
// webhook endpoint) is testable against a stub. Pointing it at a live account
// should never be the first time this code runs.
//
// Nothing here decides prices: a variant is always built from the plan it
// sells, because settlement rejects an order whose amount disagrees with the
// plan. `apply: false` plans everything and writes nothing.
// ---------------------------------------------------------------------------

/**
 * Drain an async-iterable (a Whop Page, or an array in tests) into an array.
 * Accepts a promise too, because the SDK's list methods return one and passing
 * it un-awaited is an easy mistake to make.
 */
export async function collect(source) {
  const out = [];
  if (!source) return out;
  const iterable = typeof source.then === 'function' ? await source : source;
  if (!iterable) return out;
  for await (const item of iterable) out.push(item);
  return out;
}

/** The create payload for one plan's recurring variant. */
export function variantPayload(plan, { accountId, productId }) {
  const price = plan.priceCents / 100;
  return {
    account_id: accountId,
    product_id: productId,
    title: String(plan.name).slice(0, 30), // Whop caps variant titles at 30 chars
    plan_type: 'renewal',
    billing_period: (plan.interval === 'year' ? 365 : 30) * (plan.intervalCount || 1),
    initial_price: price,
    renewal_price: price,
    currency: plan.currency || 'USD',
    visibility: 'visible',
    // Travels on payment + membership events, which makes a renewal
    // recognisable even when the checkout metadata is not echoed back.
    metadata: { app: 'sololevelingtrad', plan_slug: plan.slug },
  };
}

/**
 * Idempotent: the product, each variant and the webhook are all matched before
 * anything is created. Returns a description of what happened (or, with
 * `apply: false`, what would happen) — never a bare boolean.
 */
export async function provisionWhop({
  client, accountId, plans = [], productTitle, webhookUrl, events = [], apply = false, log = () => {},
}) {
  const errors = [];
  const fail = (step, e) => {
    const message = e?.message || String(e);
    errors.push({ step, message });
    log(`  ✖ ${step}: ${message}`);
  };
  const done = (action, text) => log(`  ${action === 'created' ? '→' : '·'} ${text}`);

  // --- 1. the product that holds the variants ------------------------------
  // Nothing is ever created when the existing resources could not be read: a
  // transient read failure must not turn into a duplicate product, variant or
  // endpoint on the merchant's live account.
  let product = null;
  let canDedupeProducts = true;
  try {
    const found = (await collect(client.products.list({ account_id: accountId })))
      .find((p) => p?.title === productTitle);
    if (found) product = { id: found.id, title: found.title, action: 'reuse' };
  } catch (e) { canDedupeProducts = false; fail('listing products', e); }

  if (!product) {
    if (!canDedupeProducts) {
      product = { id: null, title: productTitle, action: 'blocked' };
    } else if (!apply) {
      product = { id: null, title: productTitle, action: 'would-create' };
    } else {
      try {
        const created = await client.products.create({
          account_id: accountId,
          title: productTitle,
          headline: 'Trading plans',
          visibility: 'visible',
          metadata: { app: 'sololevelingtrad' },
        });
        product = { id: created.id, title: created.title, action: 'created' };
      } catch (e) { fail('creating the product', e); }
    }
  }
  done(product?.action, product?.action === 'created' ? `created "${productTitle}" → ${product?.id}` : `product "${productTitle}" → ${product?.id || 'not created yet'}`);

  // --- 2. one recurring variant per plan -----------------------------------
  let existing = [];
  let canDedupeVariants = true;
  if (product?.id) {
    try { existing = await collect(client.variants.list({ product_ids: [product.id] })); }
    catch (e) { canDedupeVariants = false; fail('listing variants', e); }
  }

  const variants = [];
  for (const plan of plans) {
    const title = String(plan.name).slice(0, 30);

    if (plan.linked) {
      variants.push({ slug: plan.slug, title, id: plan.linked, action: 'already-linked' });
      done('reuse', `${plan.slug}: already linked → ${plan.linked}`);
      continue;
    }
    const match = existing.find((v) => v?.title === title);
    if (match) {
      variants.push({ slug: plan.slug, title, id: match.id, action: 'found' });
      done('reuse', `${plan.slug}: found existing variant "${title}" → ${match.id}`);
      continue;
    }
    if (!(plan.priceCents > 0)) {
      variants.push({ slug: plan.slug, title, id: null, action: 'skip', reason: 'Whop has no paid variant at zero' });
      done('skip', `${plan.slug}: skipped — zero price`);
      continue;
    }

    // In a dry run the product does not exist yet, so the intended payload is
    // reported rather than judged unattachable.
    const payload = variantPayload(plan, { accountId, productId: product?.id || null });
    if (!apply) {
      variants.push({ slug: plan.slug, title, id: null, action: 'would-create', payload });
      done('plan', `${plan.slug}: would create "${title}" — ${payload.initial_price} ${payload.currency} every ${payload.billing_period}d`);
      continue;
    }
    if (!product?.id) {
      variants.push({ slug: plan.slug, title, id: null, action: 'skip', reason: 'no product to attach to' });
      done('skip', `${plan.slug}: skipped — no product id`);
      continue;
    }
    if (!canDedupeVariants) {
      variants.push({ slug: plan.slug, title, id: null, action: 'blocked', reason: 'existing variants could not be listed' });
      done('skip', `${plan.slug}: not created — existing variants could not be listed`);
      continue;
    }
    try {
      const v = await client.variants.create(payload);
      variants.push({ slug: plan.slug, title, id: v.id, action: 'created', payload });
      done('created', `${plan.slug}: created "${title}" — ${payload.initial_price} ${payload.currency} → ${v.id}`);
    } catch (e) {
      fail(`creating the variant for ${plan.slug}`, e);
      variants.push({ slug: plan.slug, title, id: null, action: 'error' });
    }
  }

  // --- 3. the webhook endpoint our backend verifies -------------------------
  let webhook = null;
  let canDedupeWebhooks = true;
  try {
    const found = (await collect(client.webhooks.list({ account_id: accountId })))
      .find((h) => h?.url === webhookUrl);
    if (found) webhook = { id: found.id, secret: null, action: 'reuse' };
  } catch (e) { canDedupeWebhooks = false; fail('listing webhooks', e); }

  if (!webhook) {
    if (!canDedupeWebhooks) {
      webhook = { id: null, secret: null, action: 'blocked' };
    } else if (!apply) {
      webhook = { id: null, secret: null, action: 'would-create' };
    } else {
      try {
        const created = await client.webhooks.create({ url: webhookUrl, events, enabled: true });
        // Whop returns the signing secret only on this response.
        webhook = { id: created.id, secret: created.webhook_secret || null, action: 'created' };
      } catch (e) { fail('creating the webhook', e); }
    }
  }
  done(webhook?.action, webhook?.action === 'created'
    ? `created webhook ${webhook.id} for ${events.length} events`
    : `webhook ${webhook?.id || 'not created yet'} → ${webhookUrl}`);

  const variantIdBySlug = new Map(variants.filter((v) => v.id).map((v) => [v.slug, v.id]));
  return { product, variants, webhook, variantIdBySlug, errors };
}
