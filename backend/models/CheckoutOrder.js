import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
// CheckoutOrder — the single order record behind the unified checkout page.
//
// Two order types are supported, deliberately kept distinct:
//   * subscription — buying a published Plan from the Plan catalogue.
//   * crypto       — a quoted crypto purchase (asset + quantity).
//
// They are NEVER conflated: `type` drives validation, fulfilment and display.
// Fulfilment outcomes differ too — a paid subscription activates entitlements,
// while a crypto purchase can only be settled by an approved settlement
// partner (see CRYPTO_PURCHASE_MODE). No exchange-native states
// (submitted/filled) exist because no exchange/broker is connected to this
// deployment — see `settlement`.
//
// All money is INTEGER MINOR UNITS (…Cents) to avoid float drift. The browser
// never supplies a price: every amount here is written by the server.
// ---------------------------------------------------------------------------
const s = new mongoose.Schema({
  // Human-facing, globally unique order reference (shown in UI, emails, admin).
  reference: { type: String, required: true, unique: true, index: true },
  // Client-supplied idempotency key — duplicate submits collapse to one order.
  idempotencyKey: { type: String, index: true, sparse: true },

  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  type: { type: String, enum: ['subscription', 'crypto'], required: true, index: true },
  status: {
    type: String,
    enum: ['pending', 'awaiting_payment', 'paid', 'failed', 'cancelled', 'expired', 'refunded'],
    default: 'pending',
    index: true,
  },

  // ---- subscription payload ------------------------------------------------
  planSlug: { type: String },
  planName: { type: String },
  interval: { type: String, enum: ['month', 'year'] },
  intervalCount: { type: Number },

  // ---- crypto payload ------------------------------------------------------
  asset: {
    id: String,      // CoinGecko id
    symbol: String,  // BTC
    name: String,    // Bitcoin
  },
  quantity: { type: Number },
  // Unit price snapshot taken by the server when the quote was issued.
  unitPriceCents: { type: Number },
  quoteSource: { type: String },
  quoteIssuedAt: { type: Date },
  quoteExpiresAt: { type: Date, index: true },
  quoteStale: { type: Boolean, default: false },

  // ---- money (integer minor units, all server-derived) ---------------------
  subtotalCents: { type: Number, required: true, min: 0 },
  feeCents: { type: Number, default: 0, min: 0 },
  taxCents: { type: Number, default: 0, min: 0 },
  discountCents: { type: Number, default: 0, min: 0 },
  totalCents: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD', uppercase: true },

  // ---- settlement ----------------------------------------------------------
  // 'provider'  — real payment provider charge (subscriptions, approved flows)
  // 'simulated' — no provider charge; credits the paper ledger. Never presented
  //               as a real crypto transaction.
  settlement: { type: String, enum: ['provider', 'simulated'], default: 'provider' },
  simulated: { type: Boolean, default: false },

  // ---- provider linkage ----------------------------------------------------
  provider: { type: String, enum: ['razorpay', 'stripe', 'whop', 'none'] },
  providerOrderId: { type: String, index: true, sparse: true },
  providerPaymentId: { type: String },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },

  paidAt: { type: Date },
  failureReason: { type: String },
  // Terms snapshot shown to the user at final review (renewal / cancellation).
  terms: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

s.index({ userId: 1, createdAt: -1 });
s.index({ userId: 1, status: 1 });
// Admin checkout-order search filters status (and type) then sorts by createdAt.
s.index({ status: 1, createdAt: -1 });
s.index({ type: 1, createdAt: -1 });

export default mongoose.model('CheckoutOrder', s);
