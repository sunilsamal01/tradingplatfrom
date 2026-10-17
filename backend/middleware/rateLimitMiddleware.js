import rateLimit from 'express-rate-limit';
// Health/liveness must never be throttled: a 429 there is reported by clients
// (and Railway's probe) as "backend unreachable". It is mounted before the
// limiter already; this skip is belt-and-braces so a future reorder can't
// reintroduce the outage.
const isHealth = (req) => (req.originalUrl || req.url || '').startsWith('/api/health');
const mk = (max, mins = 15, extra = {}) => rateLimit({ windowMs: mins * 60e3, max, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests' }, ...extra });
// 900 / 15 min (60/min) per IP. The old 300 (20/min) was low enough that a
// trading SPA which polls market data, notifications, presence and chat could
// trip it — and the resulting 429s looked like an outage to users.
export const generalLimiter = mk(900, 15, { skip: isHealth });
export const authLimiter = mk(30);
export const otpLimiter = mk(10, 60);
export const paymentLimiter = mk(30);
export const adminLimiter = mk(200);
// Unified checkout needs a split budget. Writes (quote / order / payment
// session) are intentionally strict because they touch money and providers;
// reads (config / history / status polling) must tolerate a result page
// polling every couple of seconds, so they get a much larger ceiling.
export const checkoutWriteLimiter = mk(60);
export const checkoutReadLimiter = mk(400);
// Wallet. Deposits are money-touching writes with a deliberately small budget
// (a user only submits a handful per session); reads carry the history view and
// a status poll, so they get room like the checkout reads do.
export const walletWriteLimiter = mk(20);
export const walletReadLimiter = mk(400);
