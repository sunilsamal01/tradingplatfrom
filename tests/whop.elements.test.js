// Regression tests for the embedded Whop checkout mount.
//
// The bug these exist for: `checkout.create()` takes the ELEMENT NAME
// ("checkout"), not a container id. Mounting with the container id made Whop
// request a bundle that does not exist — the frame 404'd, never sized, and the
// buyer saw an empty box where the card form should be. It looked fine in code
// review and only broke against the live CDN.
//
// Runs on plain node:test with stubbed browser globals — no DOM library needed.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  // Nothing pre-loaded, so the loader takes the create-a-script path.
  querySelector: () => null,
  createElement: (tag) => ({ tag, dataset: {} }),
  body: {
    // The loader assigns onload before appending, so firing it here resolves.
    appendChild: (el) => { if (typeof el.onload === "function") el.onload(); },
  },
};

/** A stand-in for window.WhopElements that records how it was driven. */
function stubWhop(calls) {
  const element = { mount: (sel) => calls.push({ call: "element.mount", sel }) };
  const handle = {
    create: (name) => { calls.push({ call: "element.create", name }); return element; },
    mount: (sel) => calls.push({ call: "handle.mount", sel }),
    destroy: () => calls.push({ call: "handle.destroy" }),
  };
  const factory = () => ({
    checkout: { create: (opts) => { calls.push({ call: "handle.create", opts }); return handle; } },
  });
  globalThis.window = { WhopElements: factory };
  return { handle, element };
}

let n = 0;
const fresh = () => import(`../src/lib/whop.js?case=${++n}`);

test("mounts the element named 'checkout', never the container id", async () => {
  const calls = [];
  stubWhop(calls);
  const { mountWhopCheckout } = await fresh();

  await mountWhopCheckout({
    planId: "plan_IiX8qW4cVV4OY",
    metadata: { order_reference: "SLT-2026-BFE9AC" },
    returnUrl: "https://sololevelingtrad.online/checkout/success?order=1",
    container: { innerHTML: "" },
    onComplete: () => {},
  });

  const created = calls.find((c) => c.call === "element.create");
  assert.ok(created, "the element was created");
  assert.equal(created.name, "checkout", "create() takes the element name");
  // The precise regression: the container id is not an element name.
  assert.ok(
    !/^whop-checkout-/.test(created.name),
    "the container id must not be passed where the element name belongs",
  );

  const mounted = calls.find((c) => c.call === "element.mount");
  assert.ok(mounted, "the element was mounted");
  assert.match(mounted.sel, /^#whop-checkout-/, "mount() takes the container selector");
});

test("the mounted selector matches the div actually placed in the container", async () => {
  const calls = [];
  stubWhop(calls);
  const { mountWhopCheckout } = await fresh();

  const container = { innerHTML: "" };
  await mountWhopCheckout({
    planId: "plan_MTVqxM9xwtfXe",
    metadata: {},
    returnUrl: "https://example.test/return",
    container,
    onComplete: () => {},
  });

  const id = container.innerHTML.match(/id="([^"]+)"/)?.[1];
  const mounted = calls.find((c) => c.call === "element.mount");
  assert.ok(id, "the container received a mount target");
  assert.equal(mounted.sel, `#${id}`, "mount targets the div that exists");
});

test("passes the plan, metadata and returnUrl straight through to Whop", async () => {
  const calls = [];
  stubWhop(calls);
  const { mountWhopCheckout } = await fresh();

  const metadata = { order_reference: "SLT-2026-BFE9AC" };
  await mountWhopCheckout({
    planId: "plan_we2lHbWKf5Hl5",
    metadata,
    returnUrl: "https://sololevelingtrad.online/checkout/success?order=abc",
    container: { innerHTML: "" },
    onComplete: () => {},
  });

  const opts = calls.find((c) => c.call === "handle.create")?.opts;
  assert.equal(opts.plan, "plan_we2lHbWKf5Hl5");
  assert.deepEqual(opts.metadata, metadata, "our reference reaches Whop unchanged");
  assert.equal(opts.returnUrl, "https://sololevelingtrad.online/checkout/success?order=abc");
});

test("onComplete forwards Whop's completion without fulfilling anything", async () => {
  const calls = [];
  stubWhop(calls);
  const { mountWhopCheckout } = await fresh();

  const seen = [];
  await mountWhopCheckout({
    planId: "plan_KKbg0OAYrSWf8",
    metadata: {},
    returnUrl: "https://example.test/return",
    container: { innerHTML: "" },
    onComplete: (c) => seen.push(c),
  });

  // Whop calls this callback; ours must relay it and do nothing else.
  const opts = calls.find((c) => c.call === "handle.create").opts;
  opts.onComplete({ result: "payment", paymentId: "pay_123" });
  assert.deepEqual(seen, [{ result: "payment", paymentId: "pay_123" }]);
});

test("a missing container is refused rather than silently doing nothing", async () => {
  stubWhop([]);
  const { mountWhopCheckout } = await fresh();
  await assert.rejects(
    () => mountWhopCheckout({ planId: "p", metadata: {}, returnUrl: "u", container: null }),
    /No container/,
  );
});
