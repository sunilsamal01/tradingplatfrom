# SoloLevelingTrad Backend
Express + Mongoose ESM API. The backend also serves the built Vite frontend from `../dist` when present, including SPA routes.
## Setup
1. `cd backend && npm install`
2. Copy `.env.example` to `.env`, fill values (Mongo Atlas `MONGODB_URI`, JWT secrets, Firebase Admin, Razorpay/Stripe, SMTP).
3. From the repository root, run `npm run build` to create `dist` before starting the backend if it should serve the frontend.
4. `npm run dev` (nodemon) / `npm start` / `npm test` (`node --test tests/`) / `npm run seed` (never in production).
## Auth flow (Firebase client SDK + backend session)
Frontend signs in with Firebase client SDK (email/password or Google) → gets ID token → `POST /api/auth/login` (or `/session`, `/google`) with `{idToken}` → backend verifies via Admin SDK, upserts Mongo user, creates Session + HttpOnly cookies (`accessToken` 15m, `refreshToken` 30d rotated). Firebase UID always from verified token, never client. Register: `POST /api/auth/register` creates Firebase user (Admin SDK) + Mongo user + OTP email; verify via `/verify-email`. Forgot: `/forgot-password` sends Firebase reset link (generic response).
## API summary
`/api/health`, `/api/auth/*`, `/api/users/me*`, `/api/subscriptions/*` (plans/create/cancel/change/current/billing), `/api/payments/*` (create server-side price/verify/history/:id), `/api/webhooks/payment` (raw body, signature-checked, idempotent), `/api/admin/*` (dashboard/stats/users/moderate/role/activity/audit-logs/payments/subscriptions/revenue/analytics/notifications), `/api/chat/*` (usage-enforced).

### Market data (Stage 1) — CoinGecko primary, CMC optional
`/api/market/overview`, `/market/coins?page&limit&currency&provider=cmc`, `/market/search?q=`, `/market/coins/:id`, `/market/coins/:id/history?range=1D|1W|1M|6M|1Y|ALL`, `/market/coins/:id/snapshot?date=YYYY-MM-DD` (CoinGecko `/history` uses `dd-mm-yyyy`, derived server-side). Server-side TTL cache, provider errors surfaced honestly (no fabricated values). Free CoinGecko caps history at ~365d — `ALL` returns `truncated:true` + `rangeNote`.

### Paper trading (Stage 2) — simulated execution, never real money
`/api/trading/pairs`, `/trading/orders` (market/limit/stop-loss/take-profit, idempotent via `clientOrderId`, server-priced), `/trading/orders/:id` (GET/DELETE cancel), `/trading/trades`, `/trading/orderbook/:pair` (simulated depth), `/trading/recent-trades/:pair`, `/trading/wallet`, `/trading/wallet/transactions`, `/trading/portfolio`, `/trading/portfolio/history`. Engine: `services/paperEngine.js` — reserves funds, releases on cancel, atomic balance + immutable `LedgerTxn`, 0.1% fee, seeds 100,000 simulated USDT.

### Subscriptions & entitlements (Stage 3)
`/api/subscriptions/billing` (payments + purchase refs). `middleware/entitlementMiddleware.js` exposes `attachEntitlement`/`requireEntitlement` for server-side plan gating. `payments/verify` now ownership-checked and activates entitlements only against a verified payment.

### Groups & chat (Stage 4) — Socket.IO
`/api/groups` (list/create/join/:id/members/:id/messages POST+GET, edit/delete own, read/unread, invitations). Sockets authenticate via JWT (`socket.js`); `group:join` requires server-verified membership.

### Algo trading (Stage 5) — subscription-gated, paper only
`/api/algo/strategies`, `/bots` (create/start/pause/stop/delete, `/bots/:id/history`, `/events`). Worker `jobs/algoWorker.js` runs `runAllBots()` on a 5-min interval; `services/algoEngine.js` = SMA crossover + SL/TP, paper orders via `paperEngine`, audited to `AlgoEvent`. Entitlement: AWAKENED/MONARCH, enforced server-side (402 otherwise).

## Config
Mongo db `sololevelingtrad` from `MONGODB_URI` only. Payments: `PAYMENT_PROVIDER=razorpay|stripe`; prices server-side from `config/plans.js`. Email: SMTP env or console-log fallback. Market data: `COINGECKO_API_KEY` (optional, higher limits) and `CMC_API_KEY` (optional CoinMarketCap; server-side only — never expose to frontend). Socket.IO shares the API port; CORS origin from `CLIENT_URL`.
