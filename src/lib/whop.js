// Whop Checkout element loader.
//
// Follows the same lazy-script pattern already used for Razorpay in
// lib/checkout.js: the provider bundle is never downloaded until the user
// actually reaches payment, so the wallet page stays small.
//
// Official integration (docs.whop.com → "Embed a checkout"): Whop's element
// runs entirely in the browser, prices the order from the variant the SERVER
// chose, and copies our metadata onto the payment. The server only ever hears
// about success through the signed `payment.succeeded` webhook — so nothing
// here can grant itself a credit.
//
// Alternative if you prefer a bundled component: `npm i @whop/elements-react
// @whop/elements` and mount <Checkout plan=... metadata=... returnUrl=...>.
// The dynamic script keeps Whop out of the main bundle entirely.
const SCRIPT_SRC = "https://cdn.whop.com/elements/amber/elements.js";

let loader = null;

function loadScript(src) {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.WhopElements) return resolve(window.WhopElements);
      existing.addEventListener("load", () => resolve(window.WhopElements));
      existing.addEventListener("error", () => reject(new Error("Couldn't load Whop's secure checkout. Check your connection and try again.")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.whopElements = "";
    s.onload = () => resolve(window.WhopElements);
    s.onerror = () => {
      loader = null; // allow a retry
      reject(new Error("Couldn't load Whop's secure checkout. Check your connection and try again."));
    };
    document.body.appendChild(s);
  });
  return loader;
}

/**
 * Mount Whop's checkout into `container`.
 *
 * @param {object}   opts
 * @param {string}   opts.planId        Whop variant chosen by the server
 * @param {object}   opts.metadata      our opaque internal reference
 * @param {string}   opts.returnUrl     where Whop sends the buyer afterwards
 * @param {HTMLElement} opts.container   where to render
 * @param {function} opts.onComplete    analytics only — NEVER fulfilment
 * @returns {Promise<{destroy: function}>}
 */
export async function mountWhopCheckout({ planId, metadata, returnUrl, container, onComplete }) {
  if (!container) throw new Error("No container for the Whop checkout");
  const factory = await loadScript(SCRIPT_SRC);
  if (typeof factory !== "function") {
    throw new Error("Whop's checkout did not initialise. Please try again.");
  }

  const checkout = factory().checkout.create({
    plan: planId,
    metadata: metadata || {},
    returnUrl,
    // Fired before any navigation — for pixels/analytics only. Fulfilment
    // happens on the server from the signed webhook, never from here.
    onComplete: (completion) => {
      if (onComplete) onComplete(completion);
    },
  });

  // `create()` takes the ELEMENT NAME, not a container. Whop's own example is
  //   checkout.create("checkout").mount("#checkout")
  // and "checkout" is the registry key of the bundle Whop's CDN serves. Passing
  // a container id here makes the element request a bundle that does not exist:
  // the frame 404s, never sizes, and the buyer sees an empty box where the card
  // form should be. The container id belongs on mount(), not on create().
  //
  // The target element must already be in the DOM before mount() runs.
  const mountId = `whop-checkout-${Math.random().toString(36).slice(2, 8)}`;
  container.innerHTML = `<div id="${mountId}"></div>`;
  const element = checkout.create("checkout");
  // Documented builds return the element from create(); fall back to the handle
  // if a build exposes mount() only there, rather than throwing at the user.
  const target = element && typeof element.mount === "function" ? element : checkout;
  target.mount(`#${mountId}`);

  return {
    destroy() {
      try {
        if (typeof checkout.destroy === "function") checkout.destroy();
      } catch { /* element teardown is best-effort */ }
      container.innerHTML = "";
    },
  };
}
