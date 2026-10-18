import Session from '../models/Session.js';
import User from '../models/User.js';
import OTP from '../models/OTP.js';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/apiResponse.js';
import { signAccess, signRefresh, setAuthCookies, clearAuthCookies, hashToken } from '../services/jwtService.js';
import { requestOTP, verifyOTP } from '../services/otpService.js';
import { sendOTPEmail, sendWelcome } from '../services/emailService.js';
import { verifyIdToken, setEmailVerified, sendPasswordReset } from '../services/firebaseService.js';
import { logActivity, logLogin } from '../services/activityService.js';
import env from '../config/env.js';

// Dev-only convenience: when SMTP is not wired up locally we surface the OTP in
// the response so signup is testable. This MUST never happen in production —
// returning an OTP in an API response would let anyone with the email address
// complete verification. Gated on NODE_ENV, not just SMTP presence.
const otpPreviewEnabled = () => !env.SMTP_HOST && env.NODE_ENV !== 'production';
async function issueSession(req, res, user) {
  const refresh = signRefresh({ sub: String(user._id) });
  const sess = await Session.create({ userId: user._id, refreshTokenHash: hashToken(refresh), ipAddress: req.ip, userAgent: req.headers['user-agent'] || '', device: req.headers['user-agent'] || '', expiresAt: new Date(Date.now() + env.JWT_REFRESH_DAYS * 864e5) });
  const access = signAccess({ sub: String(user._id), firebaseUid: user.firebaseUid || '', role: user.role, sessionId: String(sess._id) });
  setAuthCookies(res, access, refresh);
  user.lastLoginAt = new Date(); user.lastActiveAt = new Date(); user.loginCount = (user.loginCount || 0) + 1; await user.save();
  await logLogin(user._id, req.ip, req.headers['user-agent'] || '', true);
  return { access, sess };
}
// Email/password signup, deliberately verification-free.
//
// No OTP is issued, so the address is NOT proven to belong to whoever registered
// it, and the account is active the moment it is created. That trade-off was
// chosen to keep onboarding simple: the OTP flow depended on SMTP mail, which is
// not configured on this deployment, so verified signup could never complete.
// To reinstate verification, issue the OTP here (requestOTP/sendOTPEmail are
// still wired up) and set status back to 'pending'.
export const register = asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, username } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const exists = await User.findOne({ email: cleanEmail });
  // One account per address. Signup is verification-free now, so there is no
  // half-finished "pending" signup to repair - an existing address is taken.
  if (exists) {
    return res.status(409).json({ success: false, message: 'Email already registered. Try logging in instead.' });
  }
  if (username) {
    const nameTaken = await User.findOne({ username: String(username).trim() });
    if (nameTaken) return res.status(409).json({ success: false, message: 'Username already taken' });
  }
  const passwordHash = await bcrypt.hash(String(password), 10);
  // Deliberately no Firebase account is created here. Firebase refuses to link a
  // Google sign-in to an email that already has a password account
  // (auth/account-exists-with-different-credential), so creating one would break
  // the "Continue with Google" button for everyone who signed up with a password.
  // A Firebase user is created later, on first Google sign-in, and linked by
  // email in tokenLogin().
  const user = await User.create({
    email: cleanEmail, passwordHash,
    firstName: String(firstName || '').trim(), lastName: String(lastName || '').trim(),
    ...(username ? { username: String(username).trim() } : {}),
    authProvider: 'email',
    // Active immediately - no verification step. emailVerified is set so the
    // Account page never offers a "Resend verification" action that has no code
    // to send.
    status: 'active',
    emailVerified: true,
  });
  // No OTP step: sign the new user in straight away. /auth/verify-email and
  // /auth/resend-otp remain mounted but are no longer part of this flow.
  try { await sendWelcome(user.email, firstName); } catch { /* email is best-effort */ }
  const { access } = await issueSession(req, res, user);
  return ok(res, 'Account created', {
    user: { id: user._id, email: user.email, role: user.role, plan: user.plan, emailVerified: true },
    accessToken: access,
  }, 201);
});
export const verifyEmail = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  await verifyOTP(email.toLowerCase(), otp);
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.emailVerified = true; user.status = 'active';
  if (user.firebaseUid) { try { await setEmailVerified(user.firebaseUid); } catch {} }
  await user.save(); await logActivity(user._id, 'email_verified', {}, req.ip);
  const { access } = await issueSession(req, res, user);
  return ok(res, 'Email verified', { user: { id: user._id, email: user.email, role: user.role, plan: user.plan, emailVerified: true }, accessToken: access });
});
export const resendOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const otp = await requestOTP(user, user.email);
  try { await sendOTPEmail(user.email, otp); } catch (e) {
    const { logger } = await import('../utils/logger.js');
    logger.warn(`OTP email failed: ${e.message}`);
  }
  return ok(res, 'OTP resent', { ...(otpPreviewEnabled() ? { otp } : {}) });
});
/**
 * Email + password login — the primary consumer path. Every account created by
 * /auth/register stores a bcrypt hash, so signing in is a straight password
 * comparison: no OTP, no Firebase round-trip. It only applies when a local hash
 * exists, so Google-only accounts are unaffected. Failed attempts are logged to
 * LoginHistory, and the response never reveals whether the address exists.
 */
async function passwordLogin(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email || '').toLowerCase() }).select('+passwordHash');
  const genericFail = () => res.status(401).json({ success: false, message: 'Invalid email or password' });
  if (!user || !user.passwordHash) { if (user) await logLogin(user._id, req.ip, req.headers['user-agent'] || '', false); return genericFail(); }
  const match = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!match) { await logLogin(user._id, req.ip, req.headers['user-agent'] || '', false); return genericFail(); }
  if (user.status !== 'active') return res.status(403).json({ success: false, message: `This account is ${user.status}. Please contact support.`, code: 'ACCOUNT_INACTIVE' });
  const { access } = await issueSession(req, res, user);
  return ok(res, 'Logged in', { user: { id: user._id, email: user.email, role: user.role, plan: user.plan }, accessToken: access });
}

async function tokenLogin(req, res) {
  const { idToken } = req.body;
  // No idToken → local password path (admin/staff accounts, Firebase-less envs).
  if (!idToken) return passwordLogin(req, res);
  const decoded = await verifyIdToken(idToken);
  const email = (decoded.email || '').toLowerCase();
  let user = decoded.uid ? await User.findOne({ firebaseUid: decoded.uid }) : null;
  if (!user && email) user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ firebaseUid: decoded.uid, email: email || `${decoded.uid}@firebase.local`, emailVerified: !!decoded.email_verified, authProvider: decoded.firebase?.sign_in_provider === 'google.com' ? 'google' : 'email', googleId: decoded.firebase?.sign_in_provider === 'google.com' ? decoded.sub : undefined, firstName: decoded.name?.split(' ')[0] || '', status: decoded.email_verified ? 'active' : 'pending' });
  } else {
    if (!user.firebaseUid) user.firebaseUid = decoded.uid;
    if (decoded.email_verified) { user.emailVerified = true; if (user.status === 'pending') user.status = 'active'; }
    await user.save();
  }
  if (user.status !== 'active') return res.status(403).json({ success: false, message: 'Account not active' });
  const { access } = await issueSession(req, res, user);
  return ok(res, 'Logged in', { user: { id: user._id, email: user.email, role: user.role, plan: user.plan }, accessToken: access });
}
export const login = tokenLogin;
export const session = tokenLogin;
export const google = tokenLogin;
export const refresh = asyncHandler(async (req, res) => {
  const { verifyRefresh, signAccess: sA, signRefresh: sR, hashToken: hT } = await import('../services/jwtService.js');
  const token = req.cookies?.refreshToken || req.body.refreshToken;
  if (!token) return res.status(401).json({ success: false, message: 'No refresh token' });
  let decoded; try { decoded = verifyRefresh(token); } catch { return res.status(401).json({ success: false, message: 'Invalid refresh token' }); }
  const sess = await Session.findOne({ userId: decoded.sub, refreshTokenHash: hT(token), revoked: false });
  if (!sess || sess.expiresAt < new Date()) return res.status(401).json({ success: false, message: 'Session expired' });
  const user = await User.findById(decoded.sub);
  if (!user) return res.status(401).json({ success: false, message: 'User not found' });
  sess.revoked = true; await sess.save();
  const refresh2 = sR({ sub: String(user._id) });
  const s2 = await Session.create({ userId: user._id, refreshTokenHash: hT(refresh2), ipAddress: req.ip, userAgent: req.headers['user-agent'] || '', expiresAt: new Date(Date.now() + env.JWT_REFRESH_DAYS * 864e5) });
  const access = sA({ sub: String(user._id), firebaseUid: user.firebaseUid || '', role: user.role, sessionId: String(s2._id) });
  setAuthCookies(res, access, refresh2);
  // Return the new access token in the body too — the client needs it to
  // retry the original request (and to keep working if cookies are blocked).
  return ok(res, 'Refreshed', { accessToken: access, user: { id: user._id, email: user.email, role: user.role, plan: user.plan } });
});
export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) await Session.updateOne({ refreshTokenHash: hashToken(token) }, { $set: { revoked: true } });
  clearAuthCookies(res); return ok(res, 'Logged out');
});
export const logoutAll = asyncHandler(async (req, res) => {
  await Session.updateMany({ userId: req.user.sub }, { $set: { revoked: true } });
  clearAuthCookies(res); return ok(res, 'Logged out everywhere');
});
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  try { const link = await sendPasswordReset(email); const { sendResetEmail } = await import('../services/emailService.js'); await sendResetEmail(email, link); } catch {}
  return ok(res, 'If the email exists, a reset link was sent');
});
export const resetPassword = asyncHandler(async (req, res) => {
  return ok(res, 'Password reset is completed via the Firebase reset link sent by email');
});
export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).select('-__v');
  if (!user) return res.status(404).json({ success: false, message: 'Not found' });
  return ok(res, 'OK', { user });
});
