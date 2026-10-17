import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import env from '../config/env.js';
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export function signAccess(payload) { return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES }); }
export function signRefresh(payload) { return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: `${env.JWT_REFRESH_DAYS}d` }); }
export function verifyAccess(t) { return jwt.verify(t, env.JWT_ACCESS_SECRET); }
export function verifyRefresh(t) { return jwt.verify(t, env.JWT_REFRESH_SECRET); }
// Cookie attributes.
//
// The auth cookies MUST survive BOTH deployment shapes:
//   * one service  — API and SPA share an origin (same-site)
//   * two services — the SPA is on e.g. sololevelingtrad.online and the API is on
//     a different *.up.railway.app domain (cross-site)
//
// `sameSite: 'strict'` silently DROPS the cookie on cross-site requests, so a
// split deployment would log the user out on every reload (and every token
// refresh). `sameSite: 'none'` is sent on same-site requests too, so it covers
// both — but browsers only accept `none` together with `secure`, which requires
// HTTPS. Production on Railway is HTTPS, so use none+secure there; development
// stays lax over plain http.
const cookieBase = {
  httpOnly: true,
  sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
};

export function setAuthCookies(res, access, refresh) {
  res.cookie('accessToken', access, { ...cookieBase, maxAge: 15 * 60 * 1000 });
  res.cookie('refreshToken', refresh, { ...cookieBase, maxAge: env.JWT_REFRESH_DAYS * 864e5 });
}
// clearCookie must repeat the same path/domain or the browser keeps the cookie.
export function clearAuthCookies(res) {
  res.clearCookie('accessToken', cookieBase);
  res.clearCookie('refreshToken', cookieBase);
}
