import mongoose from 'mongoose';
import env from '../config/env.js';

// ---------------------------------------------------------------------------
// Seeds/reconciles the four launch pricing tiers ($20/$50/$100/$150). IDEMPOTENT
// — safe to run repeatedly. It creates a missing tier and reconciles one that is
// still untouched, but NEVER overwrites an administrator's live edits.
//
//   node scripts/seedPlans.js
//   npm run seed:plans
// ---------------------------------------------------------------------------

if (!env.MONGODB_URI) { console.error('MONGODB_URI is required'); process.exit(1); }

await mongoose.connect(env.MONGODB_URI, { dbName: 'sololevelingtrad' });
const { ensureSeedPlans, DEFAULT_PLANS, listAllPlans } = await import('../services/planService.js');

console.log('Seeding pricing plans…');
console.log('  Expected launch tiers:');
for (const p of DEFAULT_PLANS) {
  console.log(`    ${p.name.padEnd(10)} ${p.slug.padEnd(10)} $${(p.priceCents / 100).toFixed(2)}/mo`);
}

const { created, skipped, updated, retired } = await ensureSeedPlans();

const all = await listAllPlans();
console.log(`\nResult: ${created} created, ${updated} reconciled, ${retired} retired, ${skipped} left untouched (admin-edited).`);
console.log(`Catalogue now has ${all.length} plan(s):`);
for (const p of all) {
  console.log(`    [${p.status.padEnd(9)}] ${p.name.padEnd(10)} ${p.slug.padEnd(10)} ${(p.priceCents / 100).toFixed(2)} ${p.currency} /${p.interval}`);
}

await mongoose.disconnect();
process.exit(0);
