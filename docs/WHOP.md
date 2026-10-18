# Whop integration

Official `@whop/sdk@2.5.0` on the server, plus Whop's **checkout element** in the browser (`src/lib/whop.js`). Everything Whop-related on the server lives in `backend/services/whopService.js`; no endpoint, event name, SDK method or provider id is invented.

## Environment
| Key | Notes |
|---|---|
| `WHOP_COMPANY_API_KEY` | `apik_…`, server-side only |
| `WHOP_COMPANY_ID` | `biz_…` |
| `WHOP_WEBHOOK_SECRET` | `ws_…`, used verbatim (including the `ws_` prefix) |
| `WHOP_SANDBOX` | `true` by default; remove only for verified live mode |
| `APP_URL` | public origin, no trailing slash — builds the return URL |
| `WHOP_DEPOSIT_PRODUCT_ID` | `prod_…` for top-up checkout links (only if deposits are enabled) |
| `WHOP_DEPOSIT_PLAN_IDS` | `<cents>:<plan_…>,…` — checkout links created **in the merchant dashboard** |
| `WALLET_DEPOSITS_ENABLED` | `false` — see `docs/WALLET.md` |

| `PAYMENT_PROVIDER` | `razorpay` \| `stripe` \| `whop`. Set `whop` to settle subscriptions with the embedded element |

Client bundles receive only `planId`, `environment`, `metadata.order_reference` and `returnUrl` — never a secret, and never an amount we assert.

## Dashboard setup (sandbox first)
1. Work in **sandbox.whop.com** while `WHOP_SANDBOX=true`.
2. Create the products/plans for the five subscription tiers and copy each variant id into the matching `Plan.providerPriceIds.whop` (plans are managed in the existing admin Pricing screen; prices are always resolved server-side).
3. Create one checkout link per top-up amount → list as `WHOP_DEPOSIT_PLAN_IDS`.
4. **Webhooks → add endpoint**: `APP_URL + /api/webhooks/whop`, subscribing to `payment.succeeded`, `payment.failed`, `payment.pending`, `payment.requires_action`, `payment.authorized`, `refund.created`, `refund.updated`, `dispute.created`, `dispute.updated`. The list on the dashboard is authoritative — keep it in step with `WHOP_EVENTS_SUBSCRIBED`.
5. Copy the signing secret into `WHOP_WEBHOOK_SECRET`.
6. API key permissions needed: `payment:basic:read`, `payment:manage`, `plan:create`, `access_pass:create`.
7. Test cards: `4242 … 4242` succeeds · `4000 0000 0000 0002` declines · `5385 3083 6013 5181` is 3DS.

CSP, if you enable it: `frame-src https://whop.com https://*.whop.com` and `connect-src https://*.whop.com`.

## Subscription checkout (embedded — the buyer never leaves the site)
`PAYMENT_PROVIDER=whop` makes **subscriptions** settle through Whop:

1. The buyer reaches step 4 of `/checkout`; `POST /checkout/orders/:id/payment-session` returns `{ mode: 'whop', whop: { planId, metadata, returnUrl, configured } }`. The variant id comes from `Plan.providerPriceIds.whop` (admin → Pricing → "Whop variant ID"). A plan with no variant id is refused with `PLAN_NOT_LINKED` — never guessed.
2. `src/lib/whop.js` mounts Whop's element **inside our own page** (`Window.WhopElements().checkout.create(...)`). Card fields belong to Whop; we never see card data. The element prices the order from the variant, and no server-side order is created — which is why there is no provider order id at this point.
3. Whop copies our `metadata.order_reference` onto the payment and every event about it, and returns the buyer to `/checkout/success?id=<orderId>` with `payment` + `status` appended (display only).
4. The signed webhook settles the order: `payment.succeeded` → `settleWhopCheckoutOrder` finds the order **by reference**, verifies the **amount and currency** against what we recorded, writes a canonical `Payment` row (`provider: 'whop'`), marks the order paid and activates the subscription. A mismatch is parked for review instead of granting access.

Because the element runs in the browser and fulfilment is webhook-only, nothing the page does can grant itself a plan — the result page always re-reads `GET /checkout/orders/:id` from the server.

**Renewals are not verified.** Later charges for the same membership are handled only if Whop carries our reference onto them; an event whose reference matches no local order is parked as `unmatched` — never credited blindly — so it can be reconciled by hand. Confirm renewal payloads in sandbox before relying on automatic renewal.

**Refunds** (`refund.created` / `refund.updated`) are recorded against the order and mark the `Payment` refunded; access is **not** revoked — the plan runs to the end of the period already paid for. Revoking is an explicit admin action.

## Webhook verification (Standard Webhooks)
Headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`.
Signature = HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}` keyed by the `ws_` secret, base64; timestamps older than 5 minutes are rejected.

Primary path is the official `unwrapWebhook` from `@whop/sdk/helpers`; a documented manual implementation (constant-time compare, 5-minute window) runs only if the SDK helper is unavailable. An unconfigured secret returns `503` — it never degrades to trusting the body.

Flow: verify → journal `WhopEvent` (unique `eventId` makes redelivery a no-op) → dispatch → 2xx fast. `metadata.order_reference` is the reconciliation key: `payment.succeeded` tries the wallet-deposit path first (exactly-once confirmation), then the subscription path (`settleWhopCheckoutOrder`). `payment.failed` marks the matching deposit **or** order failed. An event we cannot map is parked as `unmatched` — never dropped, never credited blindly.

Delivery is at-least-once with the same `webhook-id` on retries and no ordering guarantee; both are handled. Refunds and disputes are recorded; funds only move on an actual reversal, and a refund never silently revokes access.

## Return URL
Whop appends `payment` (`pay_…`) and `status`. The app **branches on it for display only** and always re-checks with the server, which either reads the signed webhook result or performs an authenticated `payments.retrieve` lookup.

## Sandbox / live status in this build
- Signature verification is proven: round-trip accepted, and tampered body, wrong secret, missing headers, swapped event id and both stale/future timestamps are rejected (`tests/whop.test.js`, 21 tests).
- **Not yet tested: an actual checkout or real money.** No Whop credentials, products or webhook endpoint exist in this environment, so no end-to-end payment has been run. The embedded subscription path is exercised end-to-end against a simulated `payment.succeeded` (see `backend/tests/whopSubscriptions.test.js`); renewals, disputes and real card flows are unverified.
- Before claiming live readiness: configure the merchant account, create one variant per plan and paste the `plan_…` ids into the admin Pricing screen, set `PAYMENT_PROVIDER=whop`, register the webhook, verify the signature and a real sandbox payment end-to-end, then set `WHOP_SANDBOX=false` only after every `liveBlockers` entry from `GET /api/admin/wallet/config` is clear.
