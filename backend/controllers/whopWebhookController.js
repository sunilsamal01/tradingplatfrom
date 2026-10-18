import env from '../config/env.js';
import WhopEvent from '../models/WhopEvent.js';
import AppError from '../utils/AppError.js';
import { ok } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import {
  verifyWhopWebhook,
  whopWebhookConfigured,
} from '../services/whopService.js';
import { confirmDeposit, failDeposit, reverseDeposit } from '../services/walletService.js';
import {
  settleWhopCheckoutOrder,
  failWhopCheckoutOrder,
  refundWhopCheckoutOrder,
} from '../services/checkoutService.js';

// ---------------------------------------------------------------------------
// Whop webhook endpoint — POST /api/webhooks/whop
//
// Verified against docs.whop.com/developer/guides/webhooks:
//   * the RAW body is what gets signed, so this route must run before the JSON
//     parser (server.js mounts express.raw on /api/webhooks)
//   * `unwrapWebhook` verifies the Standard Webhooks HMAC and the 5-minute
//     replay window
//   * Whop delivers at-least-once with the SAME webhook-id on retries, and the
//     order of deliveries is not guaranteed
//
// Guarantees:
//   * invalid signature  -> 401, payload never reaches business logic
//   * duplicate event id -> recognised at the DB (WhopEvent.eventId UNIQUE) and
//                           the deposit status claim, so no double credit
//   * returns <5s with 2xx for anything we have accepted, so Whop stops retrying
//   * an event for a record we cannot find yet is NOT dropped: it is parked as
//     'unmatched' with its provider payment id for later reconciliation
// ---------------------------------------------------------------------------

export const whopWebhook = asyncHandler(async (req, res) => {
  if (!whopWebhookConfigured()) {
    logger.error('Whop webhook received but WHOP_WEBHOOK_SECRET is not set');
    return res.status(503).json({ success: false, message: 'Webhook secret not configured' });
  }

  const raw = req.body;
  const rawText = Buffer.isBuffer(raw) ? raw.toString('utf8')
    : (typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}));

  // 1. Signature + replay verification. Throws 401 for a bad signature.
  let event;
  try {
    event = await verifyWhopWebhook(rawText, req.headers);
  } catch (e) {
    if (e instanceof AppError) {
      logger.warn('Whop webhook rejected', { code: e.code, requestId: req.requestId });
      return res.status(e.statusCode).json({ success: false, message: e.message, code: e.code });
    }
    logger.error('Whop webhook verification error', { message: e?.message || 'error' });
    return res.status(401).json({ success: false, message: 'Invalid webhook signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
  }

  const eventId = String(event?.id || '');
  const type = String(event?.type || '');
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const providerPaymentId = data.id || null;
  const reference = extractReference(data);

  // 2. Journal the event. UNIQUE(eventId) makes redelivery a no-op before any
  //    money logic runs.
  let row;
  try {
    row = await WhopEvent.create({
      provider: 'whop', eventId, type, status: 'received',
      providerPaymentId, depositReference: reference,
      summary: summarise(type, data),
    });
  } catch (e) {
    if (e && (e.code === 11000 || e?.cause?.code === 11000)) {
      return ok(res, 'Already processed');
    }
    logger.error('Whop event journal write failed', { eventId, message: e?.message || 'error' });
    // Accept so Whop does not hammer us for a transient DB issue we can read back.
    return res.status(200).json({ success: true, message: 'Event received (not journaled)' });
  }

  try {
    const outcome = await dispatch(type, data, { reference, eventId, providerPaymentId });
    await WhopEvent.updateOne({ _id: row._id }, {
      $set: {
        status: outcome.status, error: outcome.error || null,
        depositReference: outcome.reference || reference,
        processedAt: new Date(),
      },
    });
    if (outcome.status === 'failed') {
      logger.error('Whop event processing failed', { eventId, type, error: outcome.error });
    }
    return ok(res, outcome.message || 'OK');
  } catch (e) {
    // Acknowledge with 5xx only for infrastructure faults so Whop retries and
    // we eventually land the credit (the deposit claim keeps it exactly once).
    try {
      await WhopEvent.updateOne(
        { _id: row._id },
        { $set: { status: 'failed', error: e?.message || 'error' }, $inc: { attempts: 1 } },
      );
    } catch { /* journal update must never mask the original failure */ }
    logger.error('Whop event handler threw', { eventId, type, message: e?.message || 'error' });
    return res.status(500).json({ success: false, message: 'Processing failed' });
  }
});

/**
 * Route a verified event to the right handler. Returns
 * { status: 'processed'|'ignored'|'unmatched'|'failed', message, reference? }.
 */
async function dispatch(type, data, { reference, eventId, providerPaymentId }) {
  switch (type) {
    case 'payment.succeeded': {
      if (!reference) {
        return { status: 'unmatched', message: 'Event stored for reconciliation (no order reference)', error: 'missing_order_reference' };
      }
      const providerAmount = Number.isFinite(Number(data.total)) ? Number(data.total)
        : (Number.isFinite(Number(data.usd_total)) ? Number(data.usd_total) : null);
      const providerCurrency = data.currency ? String(data.currency).toUpperCase() : null;

      // A reference is either a wallet top-up or a subscription order, never
      // both. Whichever owns it decides the outcome.
      const r = await confirmDeposit({
        reference,
        providerPaymentId,
        providerEventId: eventId,
        providerAmount,
        providerCurrency,
        source: 'webhook',
      });
      if (r.found) {
        if (r.mismatch) return { status: 'failed', message: 'Amount mismatch — held for review', error: `amount mismatch: expected ${r.expected}, got ${r.providerAmount}`, reference };
        if (r.discrepancy) return { status: 'failed', message: 'Hold mismatch — held for review', error: 'missing_hold', reference };
        if (r.alreadyPaid) return { status: 'processed', message: 'Already processed', reference };
        if (r.terminal) return { status: 'processed', message: `Deposit already ${r.terminal}`, reference };
        return { status: 'processed', message: 'Deposit credited', reference };
      }

      const sub = await settleWhopCheckoutOrder({ reference, providerPaymentId, providerAmount, providerCurrency });
      if (sub) {
        if (sub.mismatch) return { status: 'failed', message: 'Amount mismatch — held for review', error: sub.reason, reference };
        if (sub.alreadyPaid) return { status: 'processed', message: 'Subscription order already paid', reference };
        return { status: 'processed', message: 'Subscription activated', reference };
      }

      return { status: 'unmatched', message: 'Event stored for reconciliation', error: 'no wallet deposit or checkout order for this reference' };
    }

    case 'payment.failed': {
      if (!reference) return { status: 'unmatched', message: 'Event stored for reconciliation', error: 'missing_order_reference' };
      const reason = data.failure_message || data.decline_code || 'The payment provider reported this payment as unsuccessful.';
      const r = await failDeposit({ reference, reason });
      if (r.found) return { status: 'processed', message: 'Deposit marked failed', reference };
      const sub = await failWhopCheckoutOrder({ reference, reason });
      if (sub) return { status: 'processed', message: sub.terminal ? `Order already ${sub.terminal}` : 'Subscription order marked failed', reference };
      return { status: 'unmatched', message: 'Event stored for reconciliation', error: 'no wallet deposit or checkout order for this reference' };
    }

    // Buyer must complete 3D Secure off-session: not a success, not a failure.
    // We only record it — credit still waits for payment.succeeded. When Whop
    // supplies a recovery link we surface it so the UI can offer it back to the
    // buyer (it never starts a charge on its own).
    case 'payment.requires_action':
    case 'payment.pending':
    case 'payment.authorized':
      return { status: 'processed', message: 'Pending state recorded', reference };

    case 'refund.created':
    case 'refund.updated':
    case 'payment.refunded': {
      if (!reference) return { status: 'unmatched', message: 'Event stored for reconciliation', error: 'missing_order_reference' };
      try {
        await reverseDeposit({ reference, providerEventId: eventId, reason: 'Refund issued by the payment provider' });
        return { status: 'processed', message: 'Refund reversal recorded', reference };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        // Not a wallet deposit. A subscription refund is recorded, but access is
        // retained to the end of the paid period — revoking is an admin choice.
        const sub = await refundWhopCheckoutOrder({ reference, reason: 'Refund issued by the payment provider' });
        if (sub) {
          return {
            status: 'processed',
            message: sub.wasPaid ? 'Subscription refund recorded — access retained to period end' : 'Refund recorded',
            reference,
          };
        }
        return { status: 'ignored', message: e.message, reference };
      }
    }

    // Disputes are recorded for the admin alerts queue. Funds are only moved
    // when the provider actually claws them back (refund.created).
    case 'dispute.created':
    case 'dispute.updated':
      return { status: 'processed', message: 'Dispute recorded for review', reference };

    default:
      // Anything we do not act on is still acknowledged so Whop stops retrying.
      return { status: 'ignored', message: 'Event ignored' };
  }
}

/** Pull our internal reference out of the payment's attached metadata. */
function extractReference(data) {
  const meta = data?.metadata;
  if (meta && typeof meta === 'object') {
    const ref = meta.order_reference || meta.orderReference || meta.reference || meta.checkoutReference;
    if (ref && /^[A-Za-z0-9_-]{6,64}$/.test(String(ref))) return String(ref);
  }
  return null;
}

/** Redacted event excerpt for the admin webhook-status view. No secrets. */
function summarise(type, data) {
  return {
    type,
    paymentId: data?.id || null,
    status: data?.status || null,
    substatus: data?.substatus || null,
    currency: data?.currency || null,
    // Decimal major units, exactly as Whop reports them.
    total: Number.isFinite(Number(data?.total)) ? Number(data.total) : null,
    product: data?.product?.id || null,
    plan: data?.plan?.id || null,
    // Card data is deliberately NOT stored — last4 only, for support triage.
    cardLast4: data?.card_last4 || data?.payment_method?.card?.last4 || null,
    receivedAt: new Date().toISOString(),
    environment: env.WHOP_SANDBOX ? 'sandbox' : 'production',
  };
}

/**
 * Reconciliation pass for events that arrived before we could map them.
 * Called when a deposit status is polled, so a late-arriving local record
 * still picks up its parked payment instead of dropping it.
 */
export async function reconcileUnmatched(reference) {
  if (!reference) return 0;
  const parked = await WhopEvent.find({ depositReference: reference, status: 'unmatched', type: 'payment.succeeded' }).limit(10);
  let credited = 0;
  for (const row of parked) {
    const paymentId = row.providerPaymentId;
    const r = await confirmDeposit({
      reference,
      providerPaymentId: paymentId,
      providerEventId: row.eventId,
      source: 'reconciliation',
    });
    if (r.found && !r.alreadyPaid && r.deposit?.status === 'paid') {
      await WhopEvent.updateOne({ _id: row._id }, { $set: { status: 'processed', processedAt: new Date(), error: null } });
      credited += 1;
    }
  }
  return credited;
}
