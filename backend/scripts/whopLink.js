import mongoose from 'mongoose';
import env from '../config/env.js';
import { variantMismatch } from '../services/whopProvisioning.js';

// ---------------------------------------------------------------------------
// Links Whop variants to the plans they sell — the step that connects a
// provisioned variant to a purchasable plan.
//
// Before writing anything it fetches each variant from Whop and refuses to link
// one that cannot faithfully sell its plan (wrong price, wrong currency, or not
// a recurring renewal), because settlement rejects an order whose amount
// disagrees with the plan — a mismatched link turns every purchase into a
// parked order.
//
//   node scripts/whopLink.js                 # dry run: reports what it would do
//   node scripts/whopLink.js --apply         # writes the ids onto the plans
//
// Variant ids come from the plan records themselves when they already exist
// (`providerPriceIds.whop`), or from WHOP_LINKS="starter=plan_…,pro=plan_…".
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);

if (!env.MONGODB_URI) { log('✖ MONGODB_URI is required (run via `railway run` for production).'); process.exit(1); }

/** Explicit slug → variant id pairs, e.g. WHOP_LINKS="starter=plan_abc,pro=plan_def". */
function explicitLinks() {
  const out = new Map();
  for (const pair of String(process.env.WHOP_LINKS || '').split(',')) {
    const [slug, id] = pair.split('=').map((s) => s && s.trim());
    if (slug && id) out.set(slug, id);
  }
  return out;
}

/**
 * Connect to Atlas. A `mongodb+srv://` URI needs an SRV lookup, which some
 * networks refuse; fall back to resolving it over DNS-over-HTTPS and dialling
 * the nodes directly, so this works from a restricted shell as well as Railway.
 */
async function connect() {
  const uri = env.MONGODB_URI;
  try {
    await mongoose.connect(uri, { dbName: 'sololevelingtrad', serverSelectionTimeoutMS: 8000 });
    return;
  } catch (e) {
    const m = uri.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?]+)\/?(.*)$/);
    if (!m) throw e;
    log(`  · direct connection failed (${e?.code || e?.message}); resolving SRV over DNS-over-HTTPS`);
    const [, user, pass, host, rest] = m;
    const res = await fetch(`https://dns.google/resolve?name=_mongodb._tcp.${host}&type=SRV`);
    const answers = ((await res.json()).Answer || []).filter((a) => a.type === 33);
    if (!answers.length) throw e;
    const nodes = answers.map((a) => {
      const parts = a.data.trim().split(/\s+/);
      return `${parts[3].replace(/\.$/, '')}:${parts[2]}`;
    });
    const dbName = (rest.split('?')[0] || 'sololevelingtrad').trim() || 'sololevelingtrad';
    await mongoose.connect(
      `mongodb://${user}:${encodeURIComponent(pass)}@${nodes.join(',')}/${dbName}?ssl=true&authSource=admin&retryWrites=true`,
      { dbName, serverSelectionTimeoutMS: 15000 },
    );
  }
}

log('');
log('========================================================================');
log(`  Whop plan linking — ${APPLY ? 'APPLY — will write' : 'DRY RUN — nothing will be written'}`);
log('========================================================================');

await connect();
const Plan = (await import('../models/Plan.js')).default;
const plans = await Plan.find({ status: { $ne: 'archived' } }).sort({ displayOrder: 1 }).lean();
const explicit = explicitLinks();

// Verify against Whop only when we have credentials; otherwise we can still
// write ids that are already on the plans, but we cannot check them.
const canVerify = Boolean(env.WHOP_COMPANY_API_KEY && env.WHOP_COMPANY_ID);
let whop = null;
if (canVerify) {
  const { WhopClient, WhopEnvironment } = await import('@whop/sdk');
  whop = new WhopClient({
    token: env.WHOP_COMPANY_API_KEY,
    environment: env.WHOP_SANDBOX ? WhopEnvironment.Sandbox : WhopEnvironment.Production,
  });
  log('\nVariant ids will be verified against Whop before anything is written.');
} else {
  log('\n! No Whop credentials present — variant ids cannot be verified. Aborting.');
  await mongoose.disconnect();
  process.exit(1);
}

log('');
let linked = 0;
let refused = 0;
for (const plan of plans) {
  const wanted = explicit.get(plan.slug) || plan.providerPriceIds?.whop || null;
  if (!wanted) { log(`  · ${plan.slug.padEnd(10)} no variant id — skipped`); continue; }
  if (plan.providerPriceIds?.whop === wanted && !explicit.get(plan.slug)) {
    log(`  · ${plan.slug.padEnd(10)} already linked → ${wanted}`);
    continue;
  }

  let variant = null;
  try {
    variant = await whop.variants.retrieve({ id: wanted });
  } catch (e) {
    log(`  ✖ ${plan.slug.padEnd(10)} variant ${wanted} could not be read from Whop: ${e?.message || e}`);
    refused += 1;
    continue;
  }

  const mismatch = variantMismatch(plan, variant);
  if (mismatch) {
    log(`  ✖ ${plan.slug.padEnd(10)} ${wanted} cannot sell this plan — ${mismatch}. NOT linked`);
    refused += 1;
    continue;
  }
  log(`  ✓ ${plan.slug.padEnd(10)} ${wanted} verified (${variant.renewal_price ?? variant.initial_price} ${variant.currency}, ${variant.plan_type})`);

  if (!APPLY) { log(`      would set providerPriceIds.whop`); continue; }
  await Plan.updateOne({ _id: plan._id }, { $set: { 'providerPriceIds.whop': wanted } });
  linked += 1;
  log('      linked');
}

// Read back, so the report reflects the database rather than the intention.
const after = await Plan.find({ status: { $ne: 'archived' } }).sort({ displayOrder: 1 })
  .select('slug providerPriceIds.whop').lean();
log('\n--- database state ---');
for (const p of after) log(`  ${String(p.slug).padEnd(10)} whop=${p.providerPriceIds?.whop ?? 'NOT LINKED'}`);

log('');
log(`  ${APPLY ? `${linked} plan(s) linked.` : 'DRY RUN — nothing written.'}`);
if (refused) log(`  ${refused} plan(s) refused as unsafe to link.`);
log('');

await mongoose.disconnect();
process.exit(refused ? 1 : 0);
