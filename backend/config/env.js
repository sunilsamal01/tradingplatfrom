import dotenv from 'dotenv';
dotenv.config();
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
// Env flags are opt-IN: anything unparseable or absent is false. This keeps a
// risky capability (real money) off unless it is explicitly turned on.
const bool = (v) => String(v || '').trim().toLowerCase() === 'true';
export const env = {
  PORT: num(process.env.PORT, 5000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLIENT_URL: process.env.CLIENT_URL || 'sololevelingtrad.online',
  // Comma-separated list of additional allowed browser origins (e.g. staging).
  // CLIENT_URL is always allowed; CORS_ORIGIN may add more.
  CORS_ORIGINS: String(process.env.CORS_ORIGIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  MONGODB_URI: process.env.MONGODB_URI || '',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || '15m',
  JWT_REFRESH_DAYS: num(process.env.JWT_REFRESH_EXPIRES_DAYS, 30),
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || '',
  FIREBASE_PRIVATE_KEY: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  PAYMENT_PROVIDER: (process.env.PAYMENT_PROVIDER || 'razorpay').toLowerCase(),
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: num(process.env.SMTP_PORT, 587),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'SololevelingTrad <no-reply@example.com>',
  SMTP_FROM_NAME: process.env.SMTP_FROM_NAME || 'SololevelingTrad Security',
  OTP_EXPIRY_MINUTES: num(process.env.OTP_EXPIRY_MINUTES, 10),
  OTP_COOLDOWN_SECONDS: num(process.env.OTP_COOLDOWN_SECONDS, 60),
  // Max OTPs a single account may request within a rolling hour (abuse cap,
  // layered on top of the per-request cooldown).
  OTP_HOURLY_LIMIT: num(process.env.OTP_HOURLY_LIMIT, 5),
  // Server-side pepper for OTP hashing. Never shipped to the client. Falls
  // back to the access secret so a leaked DB alone can't brute-force a
  // 6-digit code offline.
  OTP_HASH_SECRET: process.env.OTP_HASH_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-otp-pepper',
  // VideoSDK (calls / rooms / live). Secrets stay server-side only.
  VIDEOSDK_API_KEY: process.env.VIDEOSDK_API_KEY || '',
  VIDEOSDK_SECRET_KEY: process.env.VIDEOSDK_SECRET_KEY || '',
  VIDEOSDK_API_BASE_URL: (process.env.VIDEOSDK_API_BASE_URL || 'https://api.videosdk.live').replace(/\/$/, ''),
  VIDEOSDK_TOKEN_TTL_SECONDS: num(process.env.VIDEOSDK_TOKEN_TTL_SECONDS, 3600),
  VIDEOSDK_MAX_PARTICIPANTS: num(process.env.VIDEOSDK_MAX_PARTICIPANTS, 50),
  // --- Unified checkout -------------------------------------------------
  // How long a price quote stays valid before it must be refreshed (seconds).
  QUOTE_TTL_SECONDS: num(process.env.QUOTE_TTL_SECONDS, 120),
  // Platform fee applied to crypto purchases, in basis points (75 = 0.75%).
  CRYPTO_FEE_BPS: num(process.env.CRYPTO_FEE_BPS, 75),
  // Tax applied to checkout totals, in basis points. Default 0 = no tax is
  // configured, so none is charged or displayed. Set only where you have a
  // legal obligation and the rates for your jurisdictions.
  CHECKOUT_TAX_BPS: num(process.env.CHECKOUT_TAX_BPS, 0),
  // Crypto settlement mode. This deployment has NO approved/licensed crypto
  // settlement partner and NO exchange connectivity:
  //   'disabled'  (default) — crypto checkout is presented as unavailable and
  //                           the backend refuses to create a payment session.
  //   'simulated'           — orders complete without a provider charge and
  //                           credit the PAPER ledger. Always labelled
  //                           simulated; never a real asset/fund movement.
  CRYPTO_PURCHASE_MODE: (process.env.CRYPTO_PURCHASE_MODE || 'disabled').toLowerCase(),

  // --- Whop (official @whop/sdk) -------------------------------------------
  // Documentation: https://docs.whop.com — sandbox host is
  // https://sandbox-api.whop.com/api/v1, production is https://api.whop.com/api/v1.
  // All four are REQUIRED for any Whop-backed flow; leaving them blank keeps
  // Whop inert (the API reports "not configured" instead of throwing).
  WHOP_COMPANY_API_KEY: process.env.WHOP_COMPANY_API_KEY || '',   // apik_…
  WHOP_COMPANY_ID: process.env.WHOP_COMPANY_ID || '',             // biz_…
  WHOP_WEBHOOK_SECRET: process.env.WHOP_WEBHOOK_SECRET || '',     // ws_…  (signing secret)
  // Sandbox by DEFAULT. Remove it (set false) only once the live merchant
  // account, products, webhook and credentials are configured and verified.
  WHOP_SANDBOX: bool(process.env.WHOP_SANDBOX),
  // Public origin of THIS app. Used for return URLs and webhook registration.
  APP_URL: (process.env.APP_URL || process.env.CLIENT_URL || '').replace(/\/+$/, ''),
  // Whop product that holds the wallet top-up checkout links (prod_…).
  WHOP_DEPOSIT_PRODUCT_ID: process.env.WHOP_DEPOSIT_PRODUCT_ID || '',
  // Preset top-up amounts mapped to Whop variants created in the Whop
  // dashboard (Checkout links). Format: "<cents>:<plan_…>,<cents>:<plan_…>"
  // e.g. "2500:plan_AAA,5000:plan_BBB". Provider ids come ONLY from the
  // merchant's own dashboard — never invented by this app.
  WHOP_DEPOSIT_PLAN_IDS: process.env.WHOP_DEPOSIT_PLAN_IDS || '',

  // --- Real-money wallet ----------------------------------------------------
  // ELIGIBILITY GATE (deliberate, off by default). Funding a stored-value
  // wallet is not an approved Whop use case: Whop prohibits "Non-fiat
  // currencies and digital assets" and "Unregistered Financial Services"
  // (payment facilitation / escrow). Real top-ups stay unavailable until the
  // provider confirms support in writing for THIS merchant/product AND any
  // money-transmitter/licensing obligations for the deployment's jurisdictions
  // are addressed. Subscription checkout is unaffected — selling SaaS is a
  // supported Whop business model.
  WALLET_DEPOSITS_ENABLED: bool(process.env.WALLET_DEPOSITS_ENABLED),
  WALLET_CURRENCY: (process.env.WALLET_CURRENCY || 'USD').toUpperCase(),
  WALLET_MIN_DEPOSIT_CENTS: num(process.env.WALLET_MIN_DEPOSIT_CENTS, 500),
  WALLET_MAX_DEPOSIT_CENTS: num(process.env.WALLET_MAX_DEPOSIT_CENTS, 50000),
  // A pending deposit nobody paid for is expired after this long (frees the hold).
  WALLET_DEPOSIT_EXPIRY_MINUTES: num(process.env.WALLET_DEPOSIT_EXPIRY_MINUTES, 30),
  // Reason shown to users while deposits are gated off (safe to disclose).
  WALLET_DEPOSITS_UNAVAILABLE_REASON:
    process.env.WALLET_DEPOSITS_UNAVAILABLE_REASON ||
    'Wallet top-ups are not available on this deployment. Funding a stored-value wallet requires explicit approval from the payment provider for this merchant account, plus the applicable money-services licensing for your jurisdiction. Subscription purchases remain available.',
};
export default env;
