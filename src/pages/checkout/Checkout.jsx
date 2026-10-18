import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useReducedMotion } from "framer-motion";
import { AlertTriangle, ArrowLeft, RefreshCw, ShieldCheck, ChevronRight } from "lucide-react";
import { useAuth } from "../../context/useAuth.js";
import { Button, Badge } from "../../components/ui.jsx";
import { PageLoader } from "../../components/Loaders.jsx";
import { StepIndicator } from "../../components/checkout/StepIndicator.jsx";
import { StepPane, ReviewStep, CustomerStep, PaymentStep, FinalStep } from "../../components/checkout/Steps.jsx";
import { checkout, loadRazorpay, openRazorpay } from "../../lib/checkout.js";
import { mountWhopCheckout } from "../../lib/whop.js";
import { cn } from "../../lib/utils.js";

// ---------------------------------------------------------------------------
// Unified checkout.
//
// Route contract:
//   /checkout?plan=<slug>                 subscription
//   /checkout?asset=BTC&qty=0.01          crypto purchase
//   /checkout?order=<id>                  resume an order after refresh/back
//
// The browser only ever supplies WHAT is being bought. Every price, fee, tax
// and total is produced by the server and rendered here verbatim.
//
// Order state survives refresh via sessionStorage + an idempotency key, so a
// reload never creates a second order (and therefore never a second charge).
// ---------------------------------------------------------------------------

const UNPAYABLE = ["cancelled", "expired", "failed"];
const ss = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
};

function idempotencyKeyFor(intentId) {
  const k = `checkout:key:${intentId}`;
  let v = ss.get(k);
  if (!v) { v = `ck-${intentId}-${Math.random().toString(36).slice(2, 10)}`; ss.set(k, v); }
  return v.slice(0, 128);
}

export default function Checkout() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const { user } = useAuth();

  const planSlug = params.get("plan");
  const assetParam = params.get("asset");
  const qtyParam = params.get("qty");
  const resumeId = params.get("order");
  const isCrypto = !!assetParam && !planSlug;

  const [config, setConfig] = useState(null);
  const [configErr, setConfigErr] = useState("");
  const [quote, setQuote] = useState(null);
  const [quoteErr, setQuoteErr] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quantity, setQuantity] = useState(qtyParam || "0.01");
  const [order, setOrder] = useState(null);
  const [session, setSession] = useState(null);
  // Server-provided Whop element config, set once the server has approved this
  // order for an embedded card payment (session mode === "whop").
  const [whop, setWhop] = useState(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState("");
  const [method, setMethod] = useState("provider_checkout");
  const [agreed, setAgreed] = useState(false);
  const [customer, setCustomer] = useState({
    email: user?.email || "",
    name: user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "",
    phone: "",
  });

  const sectionRef = useRef(null);
  const quoteSeq = useRef(0);
  const whopContainer = useRef(null);

  const intentId = useMemo(
    () => (isCrypto ? `crypto:${assetParam}:${quantity}` : `plan:${planSlug || "unknown"}`),
    [isCrypto, assetParam, quantity, planSlug],
  );

  const pricing = order || quote?.pricing || null;
  const methodLabel = config?.paymentMethods?.find((m) => m.id === method)?.label
    || config?.paymentMethods?.[0]?.label
    || "Secure payment";

  // ---- config -------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    checkout.config()
      .then((c) => { if (alive) setConfig(c); })
      .catch((e) => { if (alive) setConfigErr(e?.message || "Couldn't reach checkout."); });
    return () => { alive = false; };
  }, []);

  // ---- resume an existing order (refresh / back / shared link) ------------
  useEffect(() => {
    if (!resumeId) return undefined;
    let alive = true;
    checkout.order(resumeId)
      .then((o) => {
        if (!alive || !o) return;
        if (o.status === "paid") { navigate(`/checkout/success?id=${o.id}`, { replace: true }); return; }
        if (UNPAYABLE.includes(o.status)) { navigate(`/checkout/${o.status === "expired" ? "pending" : "failed"}?id=${o.id}`, { replace: true }); return; }
        setOrder(o);
      })
      .catch(() => { /* falls through to a fresh quote below */ });
    return () => { alive = false; };
  }, [resumeId, navigate]);

  // ---- quote --------------------------------------------------------------
  const fetchQuote = useCallback(async () => {
    if (order) return; // already committed to an order
    if (isCrypto && !(Number(quantity) > 0)) { setQuote(null); return; }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    setQuoteErr("");
    try {
      const payload = isCrypto
        ? { type: "crypto", asset: assetParam, quantity: Number(quantity) }
        : { type: "subscription", planSlug };
      const q = await checkout.quote(payload);
      if (seq === quoteSeq.current) setQuote(q);
    } catch (e) {
      if (seq === quoteSeq.current) { setQuote(null); setQuoteErr(e?.message || "Couldn't price this order."); }
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, [order, isCrypto, assetParam, quantity, planSlug]);

  // Debounced so typing a quantity doesn't fire a request per keystroke.
  useEffect(() => {
    if (resumeId && order) return undefined;
    const t = setTimeout(() => { fetchQuote(); }, 550);
    return () => clearTimeout(t);
  }, [fetchQuote, resumeId, order]);

  // ---- navigation ---------------------------------------------------------
  const goTo = useCallback((n) => {
    setStep(n);
    setStepError("");
    requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    });
  }, [reduce]);

  const clearIntent = () => { ss.del(`checkout:key:${intentId}`); ss.del(`checkout:order:${intentId}`); };

  // ---- step 1 → 2: create the order (idempotent) --------------------------
  const createOrder = async () => {
    if (order) { goTo(2); return; }
    if (!quote?.token) { setStepError("Wait for the price quote before continuing."); return; }
    setBusy(true);
    setStepError("");
    try {
      let key = idempotencyKeyFor(intentId);
      let res = await checkout.createOrder({ quoteToken: quote.token, idempotencyKey: key });
      let o = res?.order || res;
      // An idempotent hit can return an order that is no longer payable —
      // retire the key and create one fresh rather than dead-ending the user.
      if (o && UNPAYABLE.includes(o.status)) {
        clearIntent();
        key = idempotencyKeyFor(intentId);
        res = await checkout.createOrder({ quoteToken: quote.token, idempotencyKey: key });
        o = res?.order || res;
      }
      setOrder(o);
      ss.set(`checkout:order:${intentId}`, o.id);
      goTo(2);
    } catch (e) {
      setStepError(e?.message || "Couldn't create your order.");
    } finally {
      setBusy(false);
    }
  };

  // ---- step 4: take payment ----------------------------------------------
  const startPayment = async () => {
    if (busy) return; // guard against double-click / duplicate orders
    setBusy(true);
    setStepError("");
    try {
      let sess = session;
      if (!sess) {
        sess = await checkout.paymentSession(order.id);
        setSession(sess);
      }

      // Simulated crypto settlement — no provider charge, no real funds.
      if (sess.mode === "simulated") {
        const r = await checkout.completeSimulated(order.id);
        clearIntent();
        navigate(`/checkout/${r?.order?.status === "paid" ? "success" : "pending"}?id=${order.id}`);
        return;
      }

      // Embedded Whop checkout: the card is entered ON THIS PAGE, so there is no
      // redirect and nothing to fulfil here. The element prices the order from
      // the server-chosen variant, and the signed webhook settles it — so we
      // just mount it and let the result page ask the server what happened.
      if (sess.mode === "whop") {
        if (!sess.whop?.configured) {
          setStepError("Card payments aren't configured on the server yet. Please contact support.");
          setBusy(false);
          return;
        }
        clearIntent();
        setWhop(sess.whop);
        setBusy(false);
        return;
      }

      // Hosted Stripe checkout: leave for Stripe's own payment page and return
      // to /checkout/success, which confirms the payment server-side. Nothing
      // about the price or the outcome is taken from this redirect.
      if (sess.checkoutUrl) {
        clearIntent();
        window.location.assign(sess.checkoutUrl);
        return;
      }

      await loadRazorpay();
      const result = await openRazorpay({
        session: sess,
        customer,
        onVerify: (payload) => checkout.verify(payload),
      });

      if (result.ok) {
        clearIntent();
        // Only claim success once the SERVER reports the order as paid.
        const st = await checkout.status(order.id).catch(() => null);
        navigate(`/checkout/${st?.status === "paid" ? "success" : "pending"}?id=${order.id}`);
        return;
      }
      if (result.reason === "cancelled") {
        navigate(`/checkout/cancelled?id=${order.id}`);
        return;
      }
      ss.set(`checkout:error:${order.id}`, result.error || "The payment didn't complete.");
      navigate(`/checkout/failed?id=${order.id}`);
    } catch (e) {
      // Honest failure states — no fake success, no stack traces.
      if (e?.status === 503 || e?.code === "PAYMENTS_NOT_CONFIGURED") {
        setStepError(e.message || "Online payments aren't configured yet.");
      } else if (e?.code === "CRYPTO_SETTLEMENT_UNAVAILABLE") {
        setStepError(e.message);
      } else if (e?.code === "QUOTE_EXPIRED") {
        setStepError("Your price quote expired. Go back to review and refresh the price.");
      } else if (e?.status === 409) {
        setStepError(e.message);
      } else if (e?.status === 0) {
        setStepError("Backend unreachable — your order is saved. Check your connection and try again.");
      } else if (e?.status === 401) {
        navigate("/login");
      } else {
        setStepError(e?.message || "Payment couldn't be started.");
      }
      setBusy(false);
    }
  };

  // ---- embedded Whop element ---------------------------------------------
  // Mounted only after the server has approved the order and named the variant
  // to sell. The element owns the card fields; its onComplete is analytics only,
  // because fulfilment happens on the server from the signed webhook.
  useEffect(() => {
    if (!whop || !order || !whopContainer.current) return undefined;
    let alive = true;
    let widget = null;
    (async () => {
      try {
        widget = await mountWhopCheckout({
          planId: whop.planId,
          metadata: whop.metadata,
          returnUrl: whop.returnUrl,
          container: whopContainer.current,
          onComplete: (completion) => {
            if (completion?.result !== "payment") return;
            navigate(`/checkout/success?id=${order.id}`);
          },
        });
      } catch (e) {
        if (alive) setStepError(e?.message || "Couldn't open the payment form. Please try again.");
      }
    })();
    return () => {
      alive = false;
      if (widget) {
        try { widget.destroy(); } catch { /* element teardown is best-effort */ }
      }
    };
  }, [whop, order, navigate]);

  // ---- guards / empty states ---------------------------------------------
  if (!planSlug && !assetParam && !resumeId) {
    return (
      <Shell>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
          <p className="text-sm font-semibold text-white">Nothing to check out yet</p>
          <p className="mt-1 text-xs text-white/50">
            Choose a subscription plan or an asset to purchase to start an order.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button to="/pricing" variant="secondary" size="sm">View pricing</Button>
            <Button to="/markets" size="sm">Browse markets <ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden /></Button>
          </div>
        </div>
      </Shell>
    );
  }

  if (!config && !configErr) {
    return (
      <Shell>
        <PageLoader label="Preparing secure checkout" />
      </Shell>
    );
  }

  return (
    <Shell>
      {configErr && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100/85" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{configErr} You can still review your order — payment will resume when the backend responds.</span>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to={isCrypto ? "/markets" : "/pricing"} className="inline-flex items-center gap-1 text-xs text-white/45 transition-colors hover:text-white/80">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {isCrypto ? "Markets" : "Pricing"}
          </Link>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-white">Secure checkout</h1>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-white/40">
          <ShieldCheck className="h-4 w-4 text-emerald-400/80" aria-hidden />
          <span>SSL encrypted · server-verified payments</span>
        </div>
      </div>

      <div ref={sectionRef} className="scroll-mt-24">
        <StepIndicator step={step} onSelect={(n) => n < step && goTo(n)} className="mb-6" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* ---- Steps ---- */}
        <div className="min-w-0">
          <StepPane paneKey={`step-${step}`} dir={step > 1 ? 1 : -1} reduce={reduce}>
            {step === 1 && (
              <ReviewStep
                quote={quote}
                pricing={pricing}
                isCrypto={isCrypto}
                quantity={quantity}
                onQuantityChange={setQuantity}
                onRefresh={fetchQuote}
                refreshing={quoting}
                quoteError={quoteErr}
                expiresAt={order ? null : quote?.expiresAt}
                onBack={() => navigate(isCrypto ? "/markets" : "/pricing")}
                onContinue={createOrder}
                busy={busy}
              />
            )}
            {step === 2 && (
              <CustomerStep
                customer={customer}
                onChange={setCustomer}
                onBack={() => goTo(1)}
                onContinue={() => goTo(3)}
                busy={busy}
              />
            )}
            {step === 3 && (
              <PaymentStep
                config={config}
                value={pricing}
                method={method}
                onSelect={setMethod}
                onBack={() => goTo(2)}
                onContinue={() => goTo(4)}
                busy={busy}
              />
            )}
            {step === 4 && (
              <FinalStep
                order={order}
                methodLabel={methodLabel}
                customer={customer}
                agreed={agreed}
                onAgree={setAgreed}
                onBack={() => goTo(3)}
                onPay={startPayment}
                busy={busy}
                blocked={stepError || undefined}
              />
            )}

            {step === 4 && whop && (
              <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
                <div className="mb-2 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                  <p className="text-xs font-medium text-white">Complete your payment securely on this page</p>
                </div>
                <p className="mb-4 text-xs text-white/50">
                  Card details are handled by Whop. Your plan activates automatically once the payment is confirmed.
                </p>
                <div ref={whopContainer} />
              </div>
            )}
          </StepPane>

          {step < 4 && stepError && (
            <p role="alert" className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
              {stepError}
            </p>
          )}
        </div>

        {/* ---- Sticky summary rail ---- */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-[11px] uppercase tracking-widest text-white/40">Order reference</p>
            <p className="num mt-1 text-sm text-white/80">{order?.reference || "assigned on review"}</p>

            <dl className="mt-4 space-y-2.5 border-t border-white/10 pt-4 text-xs">
              <Row k="Type" v={isCrypto ? "Crypto purchase" : "Subscription"} />
              {isCrypto ? (
                <>
                  <Row k="Asset" v={`${pricing?.asset?.symbol || assetParam} · ${quantity}`} />
                  <Row k="Quote" v={pricing?.quoteSource || "market feed"} />
                </>
              ) : (
                <>
                  <Row k="Plan" v={pricing?.planName || planSlug || "—"} />
                  <Row k="Billing" v={pricing ? `Every ${pricing.intervalCount > 1 ? pricing.intervalCount + " " + (pricing.interval === "year" ? "years" : "months") : (pricing.interval || "month")}` : "—"} />
                </>
              )}
              <Row k="Status" v={order ? order.status : "not ordered"} />
            </dl>

            <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-center"
                onClick={fetchQuote}
                disabled={quoting || !!order}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", quoting && "animate-spin")} aria-hidden />
                {quoting ? "Refreshing price" : "Refresh price"}
              </Button>
              <Link
                to="/checkout/orders"
                className="block rounded-lg border border-white/10 px-3 py-2 text-center text-xs text-white/55 transition-colors hover:border-white/25 hover:text-white"
              >
                View all orders
              </Link>
            </div>

            <div className="mt-4 flex flex-wrap gap-1.5">
              <Badge tone="default">USD</Badge>
              <Badge tone="default">{config?.providerLabel || "provider"}</Badge>
              {config && !config.providerConfigured && <Badge tone="warning">keys pending</Badge>}
            </div>
          </div>
        </aside>
      </div>
    </Shell>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-white/40">{k}</dt>
      <dd className="num truncate text-right text-white/75">{v}</dd>
    </div>
  );
}

// Shared page shell — deep midnight backdrop with a single restrained glow.
function Shell({ children }) {
  return (
    <div className="font-checkout relative min-h-[calc(100vh-4rem)] overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[380px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(34,211,238,0.10),transparent)]"
      />
      <div className="relative mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</div>
    </div>
  );
}
