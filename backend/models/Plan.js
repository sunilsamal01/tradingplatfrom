import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
// Plan — the single source of truth for sellable subscription tiers.
//
// Money is stored as INTEGER CENTS (priceCents) to avoid float drift; the
// public/admin API derives display strings from it. Prices are in USD by
// default but each plan carries its own currency so regional pricing can be
// added later without a migration.
//
// status lifecycle: draft -> published -> archived
//   - draft:       editable, never sold, invisible on the public pricing page
//   - published:   purchasable and shown publicly
//   - archived:    no NEW purchases, but existing subscribers keep their
//                  entitlements and full history is preserved
// ---------------------------------------------------------------------------
const s = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  // Stable machine identifier used in checkout, entitlements and URLs.
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 60 },
  blurb: { type: String, default: '', maxlength: 200 },
  description: { type: String, default: '', maxlength: 1000 },

  // Money — integer minor units. 2000 === $20.00
  priceCents: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'priceCents must be an integer (minor units)' } },
  currency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
  interval: { type: String, enum: ['month', 'year'], default: 'month' },
  intervalCount: { type: Number, default: 1, min: 1, max: 12 },

  // Merchandising
  features: { type: [String], default: [] },
  // -1 means "unmetered" (no artificial ceiling).
  limits: {
    aiLimit: { type: Number, default: 100, min: -1 },
    watchlists: { type: Number, default: 1, min: -1 },
    alerts: { type: Number, default: 1, min: -1 },
  },
  badge: { type: String, default: '', maxlength: 40 },
  recommended: { type: Boolean, default: false, index: true },
  cta: { type: String, default: 'Choose plan', maxlength: 40 },

  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
  displayOrder: { type: Number, default: 0, index: true },

  // Provider identifiers — filled in from the Razorpay/Stripe/Whop dashboards.
  // Never invented by the app; null means "not linked yet".
  // `whop` is the VARIANT id (`plan_…`), which is what the Whop checkout
  // element takes and what defines the price on Whop's side.
  providerPriceIds: {
    razorpay: { type: String, default: null },
    stripe: { type: String, default: null },
    whop: { type: String, default: null },
  },

  // Provenance for the audit trail shown in the admin panel.
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

// Query patterns: public catalogue listing, admin status filters.
s.index({ status: 1, displayOrder: 1 });
s.index({ createdAt: -1 });

export default mongoose.model('Plan', s);
