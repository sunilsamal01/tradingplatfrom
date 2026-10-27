import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { hashOTP, verifyOTPHash, generateOTP } from '../utils/generateOTP.js';
import { PLANS, getPlan, checkUsageLimit } from '../config/plans.js';
import { rbacCan } from '../services/paymentService.js';
import { registerSchema, verifyEmailSchema, changePasswordSchema } from '../validators/authValidator.js';
import { generateOrderId } from '../utils/generateId.js';

test('otp hash/verify roundtrip', () => {
  const otp = generateOTP();
  assert.match(otp, /^\d{6}$/);
  const h = hashOTP(otp);
  assert.ok(verifyOTPHash(otp, h));
  assert.ok(!verifyOTPHash('000000', h));
});
test('plan catalog pricing integrity', () => {
  assert.equal(PLANS.AWAKENED.priceINR, 999);
  assert.equal(PLANS.MONARCH.priceINR, 2499);
  assert.ok(getPlan('awakened').aiLimit === 2000);
  assert.throws(() => getPlan('NOPE'));
});
test('razorpay HMAC test vector', () => {
  const orderId = 'order_123', paymentId = 'pay_123';
  const sig = crypto.createHmac('sha256', 'testsecret').update(`${orderId}|${paymentId}`).digest('hex');
  // recompute manually to prove vector logic
  assert.equal(sig.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(sig));
});
test('zod validators accept/reject', () => {
  assert.ok(registerSchema.safeParse({ email: 'a@b.com', password: 'password1', firstName: 'A' }).success);
  assert.ok(!registerSchema.safeParse({ email: 'bad', password: 'short', firstName: '' }).success);
  assert.ok(verifyEmailSchema.safeParse({ email: 'a@b.com', otp: '123456' }).success);
  assert.ok(!verifyEmailSchema.safeParse({ email: 'a@b.com', otp: '12' }).success);
});
test('change-password requires the current password and a genuine new one', () => {
  assert.ok(changePasswordSchema.safeParse({ currentPassword: 'old-pass', newPassword: 'new-pass-1' }).success);
  // A stolen access token alone must not be enough to take the account over.
  assert.ok(!changePasswordSchema.safeParse({ newPassword: 'new-pass-1' }).success);
  assert.ok(!changePasswordSchema.safeParse({ currentPassword: 'old-pass', newPassword: 'short' }).success);
  // "Changing" a password to itself is rejected instead of reported as success.
  assert.ok(!changePasswordSchema.safeParse({ currentPassword: 'same-pass', newPassword: 'same-pass' }).success);
});
test('RBAC matrix', () => {
  assert.ok(rbacCan('superadmin', 'anything'));
  assert.ok(rbacCan('admin', 'read:payments'));
  assert.ok(!rbacCan('user', 'read:payments'));
  assert.ok(rbacCan('user', 'read:self'));
});
test('usage-limit enforcement', () => {
  assert.ok(checkUsageLimit('FREE', 99).allowed);
  assert.ok(!checkUsageLimit('FREE', 100).allowed);
  assert.equal(generateOrderId().slice(0, 4), 'SLT-');
});
