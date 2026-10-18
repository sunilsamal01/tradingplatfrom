import Razorpay from 'razorpay';
import Stripe from 'stripe';
import env from './env.js';
/**
 * Which provider settles ORDERS (subscriptions / crypto).
 *
 * `whop` is handled differently from the other two: Whop prices the order from
 * its own variant and collects the card in the browser (the Checkout element),
 * so there is no server-side "create an order" call. See
 * checkoutService.createPaymentSession.
 */
export function paymentProvider() {
  const p = String(env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (p === 'stripe') return 'stripe';
  if (p === 'whop') return 'whop';
  return 'razorpay';
}
export function razorpayClient() { return new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET }); }
export function stripeClient() { return new Stripe(env.STRIPE_SECRET_KEY); }
