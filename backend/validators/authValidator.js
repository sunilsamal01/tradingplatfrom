import { z } from 'zod';
export const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8), firstName: z.string().min(1).max(50), lastName: z.string().max(50).optional(), username: z.string().min(3).max(30).optional() });
// Login accepts either a Firebase idToken or a local email+password pair
// (staff accounts / Firebase-less environments). Exactly one shape required.
export const loginTokenSchema = z.object({
  idToken: z.string().min(10).optional(),
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),
}).refine((d) => (d.idToken && !d.email) || (!d.idToken && d.email && d.password), { message: 'Provide either idToken or email+password' });
export const verifyEmailSchema = z.object({ email: z.string().email(), otp: z.string().length(6) });
export const resendOtpSchema = z.object({ email: z.string().email() });
export const forgotSchema = z.object({ email: z.string().email() });

// Changing a password requires the current one: an access token alone must not
// be enough, or a single stolen token could lock the real owner out.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
}).refine((d) => d.currentPassword !== d.newPassword, {
  message: 'New password must be different from the current one',
  path: ['newPassword'],
});
