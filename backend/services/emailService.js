import nodemailer from 'nodemailer';
import env from '../config/env.js';
import { logger } from '../utils/logger.js';
let transporter = null;
if (env.SMTP_HOST) transporter = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: Number(env.SMTP_PORT) === 465, requireTLS: Number(env.SMTP_PORT) !== 465, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined });
const BRAND = { name: 'SoloLevelingTrad', accent: '#7c3aed', dark: '#0f0d1a', muted: '#8b849e', url: process.env.CLIENT_URL || 'http://localhost:5173' };
const wrap = (title, preheader, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f4f1fa;font-family:'Segoe UI',Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</span>
<div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e9e2f7">
<div style="background:linear-gradient(135deg,#1a1033,#4c1d95);padding:28px 32px;text-align:center">
<div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:1px">⚔️ ${BRAND.name}</div>
<div style="color:#c4b5fd;font-size:12px;letter-spacing:3px;margin-top:4px">ARISE & TRADE</div></div>
<div style="padding:32px"><h1 style="margin:0 0 8px;font-size:20px;color:${BRAND.dark}">${title}</h1><div style="color:#3b3550;font-size:14px;line-height:1.7">${body}</div></div>
<div style="padding:20px 32px;background:#faf8ff;border-top:1px solid #eee;font-size:12px;color:${BRAND.muted};text-align:center">© ${new Date().getFullYear()} ${BRAND.name} · Professional trading platform<br>Need help? Reply to this email.</div>
</div></body></html>`;
const stripHtml = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export async function sendEmail(to, subject, html, { text, replyTo } = {}) {
  if (!transporter) { logger.info(`[email:unconfigured] to=${to} subject=${subject}`); return { queued: false, logged: true }; }
  // From identity must match the authenticated Gmail account, otherwise Gmail/Outlook flag as spoof → spam.
  return transporter.sendMail({ from: env.SMTP_FROM, to, subject, html, text: text || stripHtml(html), replyTo: replyTo || env.SMTP_USER, headers: { 'X-Mailer': 'SoloLevelingTrad', 'List-Unsubscribe': `<mailto:${env.SMTP_USER}?subject=unsubscribe>` }, envelope: { from: env.SMTP_USER, to } });
}
export const sendWelcome = (to, name) => sendEmail(to, `Welcome to ${BRAND.name}, ${name} ⚔️`, wrap(`Welcome, Hunter ${name}`, 'Your SoloLevelingTrad account is ready.', `<p>Your journey to <b>S-rank trading</b> begins now.</p><p>Verify your email to unlock live signals, backtesting, and guild features.</p><a href="${BRAND.url}" style="display:inline-block;background:${BRAND.accent};color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700">Enter the Gate →</a>`));
export const sendOTPEmail = (to, otp) => sendEmail(to, `${otp} — your ${BRAND.name} verification code`, wrap('Verify your email', `Your code is ${otp}. Valid for 10 minutes.`, `<p>Use this code to complete your registration:</p><div style="font-size:36px;font-weight:800;letter-spacing:10px;text-align:center;background:#f4f1fa;border:2px dashed ${BRAND.accent};border-radius:12px;padding:16px;margin:16px 0">${otp}</div><p style="color:${BRAND.muted};font-size:13px">Valid for 10 minutes. Never share this code — our team will never ask for it.</p>`), { text: `Your ${BRAND.name} verification code is ${otp}. Valid for 10 minutes.` });
export const sendResetEmail = (to, link) => sendEmail(to, `Reset your ${BRAND.name} password`, wrap('Reset your password', 'Someone requested a password reset.', `<p>Click below to set a new password. Link expires in 1 hour.</p><a href="${link}" style="display:inline-block;background:${BRAND.accent};color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700">Reset Password</a><p style="color:${BRAND.muted};font-size:13px">Didn't request this? Ignore this email.</p>`));
export const sendPaymentEmail = (to, orderId, amount, currency = 'INR') => { const sym = currency === 'USD' ? '$' : '₹'; return sendEmail(to, `Payment receipt — Order ${orderId}`, wrap('Payment received ✓', `Order ${orderId} confirmed.`, `<p>Amount received: <b>${sym}${amount}</b></p><p>Order ID: <b>${orderId}</b></p><p>Thank you for powering up with ${BRAND.name}.</p>`)); };
export const sendSubscriptionEmail = (to, plan) => sendEmail(to, `Your ${plan} plan is active ⚔️`, wrap('Subscription active', `Plan ${plan} activated.`, `<p>Your <b>${plan}</b> plan is now active. Enjoy premium signals and analytics.</p><a href="${BRAND.url}/subscription" style="display:inline-block;background:${BRAND.accent};color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700">Manage Subscription</a>`));
export const sendSecurityEmail = (to, msg) => sendEmail(to, `Security alert — ${BRAND.name}`, wrap('Security alert', 'Unusual activity on your account.', `<p>${msg}</p><p style="color:${BRAND.muted};font-size:13px">If this wasn't you, reset your password immediately.</p>`));

// Anything interpolated into the receipt may originate from the database (plan
// names are admin-authored), so escape it rather than trusting it in HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PROVIDER_LABELS = { whop: 'Whop', stripe: 'Stripe', razorpay: 'Razorpay' };
// An unrecognised or absent provider (e.g. a simulated order) is described as
// the card it ultimately was, never rendered as a raw "none".
const methodLabel = (p) => PROVIDER_LABELS[p] || (p && p !== 'none' ? String(p) : 'Card');

/**
 * Purchase receipt for a subscription that has actually been paid for.
 *
 * `buildSubscriptionReceipt` is pure so the rendering — including the escaping
 * of DB-authored values — can be tested without a mail server. Sent from the
 * settlement path, which is idempotent, so a buyer receives this exactly once.
 */
export function buildSubscriptionReceipt(r = {}) {
  const sym = r.currency === 'USD' ? '$' : r.currency === 'INR' ? '₹' : `${r.currency || ''} `;
  const renews = r.renewsOn ? new Date(r.renewsOn) : null;
  const hasRenews = !!renews && !Number.isNaN(renews.getTime());
  const cadence = r.interval === 'year' ? 'year' : 'month';
  const every = Number(r.intervalCount) > 1 ? `Every ${r.intervalCount} ${cadence}s` : `Every ${cadence}`;
  const rows = [
    ['Plan', esc(r.planName || 'Subscription')],
    ['Amount paid', `${sym}${esc(r.amount)}`],
    ['Order reference', esc(r.reference)],
    ['Payment method', esc(methodLabel(r.provider))],
    ['Billing', every],
  ];
  if (hasRenews) {
    rows.push(['Next renewal', renews.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })]);
  }
  const table = `<table style="width:100%;border-collapse:collapse;margin:16px 0">${rows
    .map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:${BRAND.muted};font-size:13px">${k}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:${BRAND.dark}">${v}</td></tr>`)
    .join('')}</table>`;
  const body = `<p>Hi ${esc(r.name || 'Hunter')}, your <b>${esc(r.planName || 'subscription')}</b> plan is active. Here is your receipt.</p>${table}<a href="${BRAND.url}/subscription" style="display:inline-block;background:${BRAND.accent};color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700">View your subscription →</a><p style="color:${BRAND.muted};font-size:13px">Keep this email as your payment receipt. Questions? Just reply to this message.</p>`;
  return {
    // Subject is a header, not HTML: strip CR/LF so a plan name can never
    // inject a header, and escape everywhere the value lands in markup.
    subject: `Receipt — ${String(r.planName || 'subscription').replace(/[\r\n]+/g, ' ')} plan activated ⚔️`,
    html: wrap('Payment received — your plan is live', `Receipt for ${esc(r.planName || 'your subscription')}.`, body),
    text: `${BRAND.name} receipt\nPlan: ${r.planName || 'Subscription'}\nAmount paid: ${sym}${r.amount}\nOrder reference: ${r.reference}\nPayment method: ${methodLabel(r.provider)}${hasRenews ? `\nNext renewal: ${renews.toISOString().slice(0, 10)}` : ''}`,
  };
}

export function sendSubscriptionReceipt(to, r = {}) {
  const { subject, html, text } = buildSubscriptionReceipt(r);
  return sendEmail(to, subject, html, { text });
}
