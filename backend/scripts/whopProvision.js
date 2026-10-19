import env from '../config/env.js';
import { WHOP_EVENTS_SUBSCRIBED } from '../services/whopService.js';
import { provisionWhop, collect } from '../services/whopProvisioning.js';

// ---------------------------------------------------------------------------
// CLI for provisioning the Whop side of the subscription checkout:
//
//   1. the product that holds the plans           (reused if it already exists)
//   2. one RECURRING variant per sellable plan     (price taken from the plan)
//   3. the webhook endpoint our backend verifies   (prints its signing secret)
//   4. links each variant id back onto its Plan    (only when Mongo is reachable)
//
// The orchestration lives in services/whopProvisioning.js so it can be tested
// without a network. This file is only wiring, output and the optional linking.
//
//   node scripts/whopProvision.js            # dry run: prints what it would do
//   node scripts/whopProvision.js --apply    # create (and link, if Mongo is up)
//
// Requires WHOP_COMPANY_API_KEY (apik_) and WHOP_COMPANY_ID (biz_).
// WHOP_SANDBOX=true targets sandbox; unset means PRODUCTION (real money).
//
// Plan prices come from the live catalogue when the database is reachable, and
// from the shipped catalogue otherwise. A variant's price MUST equal its plan's
// price — settlement rejects an order when the two disagree — so
// WHOP_PRICES="starter=20,pro=50" can pin them explicitly.
//
// Whop returns a webhook's signing secret ONLY on the create response — later
// reads return null even for the account owner — so it is printed exactly once.
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply');
const PRODUCT_TITLE = process.env.WHOP_PRODUCT_TITLE || 'SoloLevelingTrad';
const WEBHOOK_URL = (process.env.WHOP_WEBHOOK_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/webhooks/whop` : ''))
  .replace(/\/+$/, '');

const LIVE = !env.WHOP_SANDBOX;
const log = (...a) => console.log(...a);

if (!env.WHOP_COMPANY_API_KEY) { log('✖ WHOP_COMPANY_API_KEY (apik_) is required.'); process.exit(1); }
if (!env.WHOP_COMPANY_ID) { log('✖ WHOP_COMPANY_ID (biz_) is required.'); process.exit(1); }
if (!WEBHOOK_URL.startsWith('http')) {
  log('✖ No webhook URL. Set WHOP_WEBHOOK_URL, or run where RAILWAY_PUBLIC_DOMAIN is set.');
  process.exit(1);
}

log('');
log('========================================================================');
log(`  Whop provisioning — ${LIVE ? 'PRODUCTION (real money)' : 'sandbox'}`);
log(`  company  : ${env.WHOP_COMPANY_ID}`);
log(`  api key  : ${env.WHOP_COMPANY_API_KEY.slice(0, 9)}… (${env.WHOP_COMPANY_API_KEY.length} chars)`);
log(`  webhook  : ${WEBHOOK_URL}`);
log(`  mode     : ${APPLY ? 'APPLY — will create' : 'DRY RUN — nothing will be written'}`);
log('========================================================================');

// ---------------------------------------------------------------------------
// Authenticate first: a bad key should surface before anything else.
// ---------------------------------------------------------------------------
const { WhopClient, WhopEnvironment } = await import('@whop/sdk');
const whop = new WhopClient({
  token: env.WHOP_COMPANY_API_KEY,
  environment: env.WHOP_SANDBOX ? WhopEnvironment.Sandbox : WhopEnvironment.Production,
});

log('\n[0/4] Authenticating with Whop');
try {
  const visible = await collect(whop.products.list({ account_id: env.WHOP_COMPANY_ID }));
  log(`  ✓ authenticated — ${visible.length} product(s) visible to this key`);
} catch (e) {
  log(`  ✖ authentication failed: ${e?.message || e}`);
  if (/forbidden|unauthor|401|403/i.test(String(e?.message || ''))) {
    log('    ↳ the key was rejected. Check it is an account API key (apik_) for this company (biz_).');
  }
  log('\nCannot continue without a working key.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Plan catalogue: the live database when reachable, the shipped one otherwise.
// ---------------------------------------------------------------------------
let mongoose = null;
let plans = [];
let source = '';
try {
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(env.MONGODB_URI, { dbName: 'sololevelingtrad', serverSelectionTimeoutMS: 4000 });
  const Plan = (await import('../models/Plan.js')).default;
  const rows = await Plan.find({ status: { $ne: 'archived' } }).sort({ displayOrder: 1 }).lean();
  plans = rows.map((p) => ({
    name: p.name, slug: p.slug, priceCents: p.priceCents, currency: p.currency || 'USD',
    interval: p.interval || 'month', intervalCount: p.intervalCount || 1,
    id: String(p._id), linked: p.providerPriceIds?.whop || null,
  }));
  source = 'the live plan catalogue';
} catch (e) {
  if (mongoose) { try { await mongoose.disconnect(); } catch { /* was never connected */ } }
  mongoose = null;
  const { DEFAULT_PLANS } = await import('../services/planService.js');
  plans = DEFAULT_PLANS.map((p) => ({
    name: p.name, slug: p.slug, priceCents: p.priceCents, currency: p.currency || 'USD',
    interval: p.interval || 'month', intervalCount: p.intervalCount || 1, id: null, linked: null,
  }));
  source = 'the SHIPPED catalogue (database unreachable)';
  log(`\n  ! Database unreachable (${e?.code || e?.message}).`);
  log('  ! Using the shipped catalogue — confirm these prices match your live plans,');
  log('  ! or run this where Mongo is reachable. Override with WHOP_PRICES="starter=20,pro=50".');
}

for (const pair of String(process.env.WHOP_PRICES || '').split(',')) {
  const [slug, amount] = pair.split('=').map((s) => s && s.trim());
  const plan = plans.find((p) => p.slug === slug);
  if (plan && amount && Number.isFinite(Number(amount))) {
    plan.priceCents = Math.round(Number(amount) * 100);
    log(`  · price override: ${slug} → ${amount}`);
  }
}

log(`\nPlans to provision (${plans.length}) — from ${source}:`);
for (const p of plans) {
  log(`  ${String(p.name).padEnd(12)} ${String(p.slug).padEnd(10)} ${(p.priceCents / 100).toFixed(2)} ${p.currency}/${p.interval}  — ${p.linked ? `linked → ${p.linked}` : 'not linked'}`);
}

// ---------------------------------------------------------------------------
// Provision.
// ---------------------------------------------------------------------------
log('\n[1/4] Product\n[2/4] Variants\n[3/4] Webhook');
const result = await provisionWhop({
  client: whop,
  accountId: env.WHOP_COMPANY_ID,
  plans,
  productTitle: PRODUCT_TITLE,
  webhookUrl: WEBHOOK_URL,
  events: WHOP_EVENTS_SUBSCRIBED,
  apply: APPLY,
  log,
});

if (result.webhook?.secret) {
  log('\n  ┌─ WHOP_WEBHOOK_SECRET (shown once) ───────────────────────');
  log(`  │ ${result.webhook.secret}`);
  log('  └──────────────────────────────────────────────────────────');
  log('  Lost it? Delete the endpoint in the Whop dashboard and re-run.');
} else if (result.webhook?.action === 'reuse') {
  log('\n  ! The webhook already existed, so Whop will not re-show its secret.');
  log('  ! If you do not have it, delete the endpoint in the Whop dashboard and re-run.');
} else if (result.webhook?.action === 'would-create') {
  log('\n  · The webhook would be created on --apply, and its secret printed here.');
}

// ---------------------------------------------------------------------------
// 4. Link the variant ids onto their plans (needs the database).
// ---------------------------------------------------------------------------
log('\n[4/4] Link variants to plans');
let linked = 0;
if (!mongoose) {
  log('  ! Database unreachable, so nothing was linked. Enter these in');
  log('  ! Admin → Pricing → "Whop variant ID" (or run this where Mongo is up):');
  for (const [slug, id] of result.variantIdBySlug) log(`      ${slug.padEnd(10)} ${id}`);
} else {
  const Plan = (await import('../models/Plan.js')).default;
  const bySlug = new Map(plans.map((p) => [p.slug, p]));
  for (const [slug, id] of result.variantIdBySlug) {
    const plan = bySlug.get(slug);
    if (!plan?.id) continue;
    if (plan.linked === id) { log(`  · ${slug}: already correct`); continue; }
    if (!APPLY) { log(`  · ${slug}: would set providerPriceIds.whop = ${id}`); continue; }
    await Plan.updateOne({ _id: plan.id }, { $set: { 'providerPriceIds.whop': id } });
    linked += 1;
    log(`  → ${slug}: linked → ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
log('\n========================================================================');
if (!APPLY) log('  DRY RUN complete — nothing was created. Re-run with --apply to provision.');
else log(`  Provisioned on ${LIVE ? 'PRODUCTION' : 'sandbox'}. ${linked} plan(s) linked.`);
if (result.errors.length) log(`  ${result.errors.length} step(s) failed — see above.`);
log('');
log('  Backend environment variables (Railway):');
log('    PAYMENT_PROVIDER=whop');
log(`    WHOP_COMPANY_ID=${env.WHOP_COMPANY_ID}`);
log(`    WHOP_WEBHOOK_SECRET=${result.webhook?.secret || '<create the webhook, or copy it from the dashboard>'}`);
log(`    WHOP_SANDBOX=${env.WHOP_SANDBOX ? 'true' : 'false'}`);
log('    WHOP_COMPANY_API_KEY=<the key you supplied, unchanged>');
log('========================================================================\n');

if (mongoose) await mongoose.disconnect();
process.exit(result.errors.length ? 1 : 0);
