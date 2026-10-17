import { Router } from 'express';
import auth from './authRoutes.js'; import users from './userRoutes.js';
import subs from './subscriptionRoutes.js'; import pay from './paymentRoutes.js';
import webhooks from './webhookRoutes.js'; import admin from './adminRoutes.js'; import chat from './chatRoutes.js';
import market from './marketRoutes.js';
import plans from './planRoutes.js';
import trading from './tradingRoutes.js';
import checkout from './checkoutRoutes.js';
import orders from './orderRoutes.js';
import wallet from './walletRoutes.js';
import announcements from './announcementRoutes.js';
const r = Router();
r.use('/auth', auth); r.use('/users', users); r.use('/subscriptions', subs); r.use('/payments', pay);
r.use('/webhooks', webhooks); r.use('/admin', admin); r.use('/chat', chat); r.use('/market', market); r.use('/trading', trading);
// Public pricing catalogue (published plans only). Serves the pricing page
// and checkout plan resolution — never exposes drafts or internal fields.
r.use('/plans', plans);
// Unified checkout (quote → order → payment session) + purchase order history.
// Distinct from /trading/orders, which are paper-trading exchange orders.
r.use('/checkout', checkout);
r.use('/orders', orders);
// Real-money wallet (deposits, ledger, history). Distinct from /trading/wallet,
// which is the PAPER-trading simulation.
r.use('/wallet', wallet);
r.use('/announcements', announcements);
// NOTE: /api/health* is served by routes/healthRoutes.js and mounted in
// server.js BEFORE the rate limiter so probes can never be throttled into a
// false "backend unreachable".
export default r;