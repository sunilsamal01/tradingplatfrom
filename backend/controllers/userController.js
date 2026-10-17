import User from '../models/User.js';
import Session from '../models/Session.js';
import Purchase from '../models/Purchase.js';
import ActivityLog from '../models/ActivityLog.js';
import Notification from '../models/Notification.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { paginate } from '../utils/sanitize.js';
import { currentSubscription, effectiveEntitlement } from '../services/subscriptionService.js';
import fs from 'fs';
import path from 'path';
const PREFS = ['emailNotifications', 'tradeAlerts', 'priceAlerts', 'marketingEmails', 'theme', 'reducedMotion'];
// Chart/UI prefs persisted to Mongo. Indicators validated to a known set so we
// never store arbitrary client strings.
const CHART_RANGES = ['1D', '1W', '1M', '6M', '1Y', 'ALL'];
const CHART_MODES = ['candle', 'area', 'line'];
const CHART_INDICATORS = ['sma', 'ema', 'bb', 'vwap', 'rsi', 'macd'];
const safe = (u) => { if (!u) return null; const o = u.toObject ? u.toObject() : { ...u }; delete o.passwordHash; delete o.refreshTokenHash; delete o.otpHash; delete o.twoFactorSecret; return o; };
const log = (userId, action, meta, req) => ActivityLog.create({ userId, action, meta, ip: req?.ip }).catch(() => {});
const AVATAR_DIR = path.join(process.cwd(), 'uploads', 'avatars');
export const getMe = asyncHandler(async (req, res) => { const u = await User.findById(req.user.sub); if (!u) return res.status(404).json({ success: false, message: 'Not found' }); return ok(res, 'OK', { user: safe(u) }); });
export const patchMe = asyncHandler(async (req, res) => {
  const ALLOWED = ['firstName', 'lastName', 'username', 'phone', 'country', 'timezone', 'bio'];
  // Build the update from provided fields only. An empty string on a clearable
  // field means "clear it" -> store null (never an empty-string value).
  const body = {}; for (const k of ALLOWED) { if (req.body?.[k] === undefined) continue; const v = String(req.body[k]).trim(); body[k] = v === '' ? null : v; }
  if (body.username) { const ex = await User.findOne({ username: body.username, _id: { $ne: req.user.sub } }); if (ex) return res.status(409).json({ success: false, message: 'Username taken' }); }
  const u = await User.findByIdAndUpdate(req.user.sub, { $set: body }, { new: true, runValidators: true }); log(req.user.sub, 'profile.updated', { fields: Object.keys(body) }, req); return ok(res, 'Updated', { user: safe(u) }); });
export const deleteMe = asyncHandler(async (req, res) => { await User.findByIdAndUpdate(req.user.sub, { status: 'inactive' }); return ok(res, 'Account deactivated'); });
export const myActivity = asyncHandler(async (req, res) => { const { page, limit, skip } = paginate(req.query); const [items, total] = await Promise.all([ActivityLog.find({ userId: req.user.sub }).sort({ createdAt: -1 }).skip(skip).limit(limit), ActivityLog.countDocuments({ userId: req.user.sub })]); return ok(res, 'OK', { items, page, limit, total }); });
export const mySessions = asyncHandler(async (req, res) => { const items = await Session.find({ userId: req.user.sub, revoked: false }); return ok(res, 'OK', { items }); });
export const myPurchases = asyncHandler(async (req, res) => { const { page, limit, skip } = paginate(req.query); const [items, total] = await Promise.all([Purchase.find({ userId: req.user.sub }).sort({ createdAt: -1 }).skip(skip).limit(limit), Purchase.countDocuments({ userId: req.user.sub })]); return ok(res, 'OK', { items, page, limit, total }); });
export const mySubscription = asyncHandler(async (req, res) => {
  const [sub, user] = await Promise.all([
    currentSubscription(req.user.sub),
    User.findById(req.user.sub).select('plan').lean(),
  ]);
  // Include the effective plan + benefit list so the profile can render exactly
  // what the subscription grants (features, metered AI allowance, limits).
  const plan = await effectiveEntitlement(sub?.plan || user?.plan || 'FREE');
  return ok(res, 'OK', { subscription: sub, plan });
});
export const myNotifications = asyncHandler(async (req, res) => { const { page, limit, skip } = paginate(req.query); const [items, total] = await Promise.all([Notification.find({ userId: req.user.sub }).sort({ createdAt: -1 }).skip(skip).limit(limit), Notification.countDocuments({ userId: req.user.sub })]); return ok(res, 'OK', { items, page, limit, total }); });
export const readNotification = asyncHandler(async (req, res) => { const n = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user.sub }, { read: true }, { new: true }); if (!n) return res.status(404).json({ success: false, message: 'Not found' }); return ok(res, 'OK', { notification: n }); });
export const readAllNotifications = asyncHandler(async (req, res) => { await Notification.updateMany({ userId: req.user.sub, read: false }, { $set: { read: true } }); return ok(res, 'All marked read'); });
export const deleteSession = asyncHandler(async (req, res) => { const s = await Session.findOneAndUpdate({ _id: req.params.id, userId: req.user.sub }, { $set: { revoked: true } }, { new: true }); if (!s) return res.status(404).json({ success: false, message: 'Not found' }); return ok(res, 'Session revoked'); });
export const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded' });
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
  const name = `${req.user.sub}-${Date.now()}${ext}`;
  const prev = await User.findById(req.user.sub).select('avatar');
  fs.writeFileSync(path.join(AVATAR_DIR, name), req.file.buffer);
  if (prev?.avatar?.startsWith('/uploads/avatars/')) { try { fs.unlinkSync(path.join(process.cwd(), prev.avatar.replace(/^\//, ''))); } catch {} }
  const u = await User.findByIdAndUpdate(req.user.sub, { avatar: `/uploads/avatars/${name}` }, { new: true });
  log(req.user.sub, 'profile.avatar_updated', {}, req); return ok(res, 'Avatar updated', { user: safe(u) });
});
export const removeAvatar = asyncHandler(async (req, res) => {
  const prev = await User.findById(req.user.sub).select('avatar');
  if (prev?.avatar?.startsWith('/uploads/avatars/')) { try { fs.unlinkSync(path.join(process.cwd(), prev.avatar.replace(/^\//, ''))); } catch {} }
  const u = await User.findByIdAndUpdate(req.user.sub, { avatar: null }, { new: true });
  log(req.user.sub, 'profile.avatar_removed', {}, req); return ok(res, 'Avatar removed', { user: safe(u) });
});
export const patchPreferences = asyncHandler(async (req, res) => {
  const prefs = {};
  for (const k of PREFS) if (req.body?.preferences?.[k] !== undefined) prefs[`preferences.${k}`] = req.body.preferences[k];

  // Chart/UI prefs — validated against known sets, never trust raw client input.
  const cp = req.body?.preferences || {};
  if (cp.chartRange !== undefined && CHART_RANGES.includes(cp.chartRange)) prefs['preferences.chartRange'] = cp.chartRange;
  if (cp.chartMode !== undefined && CHART_MODES.includes(cp.chartMode)) prefs['preferences.chartMode'] = cp.chartMode;
  if (cp.chartShowGrid !== undefined) prefs['preferences.chartShowGrid'] = !!cp.chartShowGrid;
  if (Array.isArray(cp.chartIndicators)) prefs['preferences.chartIndicators'] = cp.chartIndicators.filter((i) => CHART_INDICATORS.includes(i)).slice(0, 6);

  if (!Object.keys(prefs).length) return res.status(400).json({ success: false, message: 'No valid preferences' });
  const u = await User.findByIdAndUpdate(req.user.sub, { $set: prefs }, { new: true }); log(req.user.sub, 'preferences.updated', {}, req); return ok(res, 'Preferences saved', { user: safe(u) });
});
export const exportMe = asyncHandler(async (req, res) => {
  const [u, purchases, activity] = await Promise.all([User.findById(req.user.sub), Purchase.find({ userId: req.user.sub }).lean(), ActivityLog.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(200).lean()]);
  return ok(res, 'OK', { export: { user: safe(u), purchases, activity, exportedAt: new Date().toISOString() } });
});
