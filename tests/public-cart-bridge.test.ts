import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type PublicContract = {
  buildCartSelectionContract(input: {
    value?: Record<string, unknown>;
    source?: Record<string, unknown>;
    snapshot?: Record<string, unknown> | null;
    config: Record<string, unknown>;
  }): {
    selections: Array<Record<string, unknown>>;
    selectionCount: number;
    totalQuantity: number;
  };
};

const configuredVariants = [
  {
    variantId: "101",
    variantGid: "gid://shopify/ProductVariant/101",
    color: "Green",
    size: "M",
    available: true,
  },
  {
    variantId: "102",
    variantGid: "gid://shopify/ProductVariant/102",
    color: "Green",
    size: "L",
    available: true,
  },
];

function loadContract(): PublicContract {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(
    readFileSync(
      "theme-live-cart/assets/customhouse-pitchprint-public-contract.js",
      "utf8",
    ),
    sandbox,
  );
  return sandbox.CustomHousePublicPitchPrintContract as PublicContract;
}

test("canonical public cart selections supersede an invalid legacy snapshot", () => {
  const contract = loadContract();
  const result = contract.buildCartSelectionContract({
    value: {
      variantSelections: [
        { variantId: "101", color: "Green", size: "M", quantity: 1 },
        { variantId: "102", color: "Green", size: "L", quantity: 1 },
      ],
    },
    snapshot: { variantId: 0, quantity: 0 },
    config: { variants: configuredVariants, colors: ["Green"], sizes: ["M", "L"] },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    selections: [
      {
        variantId: "101",
        variantGid: "gid://shopify/ProductVariant/101",
        color: "Green",
        size: "M",
        quantity: 1,
      },
      {
        variantId: "102",
        variantGid: "gid://shopify/ProductVariant/102",
        color: "Green",
        size: "L",
        quantity: 1,
      },
    ],
    selectionCount: 2,
    totalQuantity: 2,
  });
});

test("legacy single-variant fallback remains available only when canonical selections are absent", () => {
  const contract = loadContract();
  const result = contract.buildCartSelectionContract({
    value: {},
    snapshot: { variantId: 101, quantity: 2 },
    config: { variants: configuredVariants, colors: ["Green"], sizes: ["M", "L"] },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    selections: [
      {
        variantId: "101",
        variantGid: "gid://shopify/ProductVariant/101",
        color: "Green",
        size: "M",
        quantity: 2,
      },
    ],
    selectionCount: 1,
    totalQuantity: 2,
  });
});

test("the same nested source selections are not counted twice", () => {
  const contract = loadContract();
  const source = {
    variantSelections: [
      { variantId: "101", color: "Green", size: "M", quantity: 1 },
      { variantId: "102", color: "Green", size: "L", quantity: 1 },
    ],
  };
  const result = contract.buildCartSelectionContract({
    value: { source },
    source,
    snapshot: { variantId: 101, quantity: 1 },
    config: { variants: configuredVariants, colors: ["Green"], sizes: ["M", "L"] },
  });

  assert.equal(result.selectionCount, 2);
  assert.equal(result.totalQuantity, 2);
});

type BridgeHarness = {
  setPricing(pricing: Record<string, unknown>): void;
  setProductId(productId: string): void;
  dispatchMessage(event: Record<string, unknown>): void;
  emitClient(eventName: string, data: Record<string, unknown>): void;
  flush(): Promise<void>;
  requests: Array<{ url: string; payload: Record<string, unknown> }>;
  acknowledgements: Array<Record<string, unknown>>;
  clientFires: Array<{ eventName: string; data: Record<string, unknown> }>;
  location: { href: string; origin: string };
  logs: Array<{ level: string; message: string; detail?: unknown }>;
};

function bridgeHarness(initialPricing?: Record<string, unknown>, fetchConfig?: typeof fetch): BridgeHarness {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const requests: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const acknowledgements: Array<Record<string, unknown>> = [];
  const clientFires: Array<{ eventName: string; data: Record<string, unknown> }> = [];
  const clientListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const logs: Array<{ level: string; message: string; detail?: unknown }> = [];
  const status = { textContent: "", hidden: true, classList: { toggle() {} } };
  let pricing: Record<string, unknown> = initialPricing || {
    version: 1,
    currency: "SEK",
    productionMethodPricing: {
      EMBROIDERY: {
        label: "Embroidery",
        surchargeMinor: 0,
        embroiderySubtypes: {
          TEXT_ONLY: {
            label: "Embroidery — Text only",
            surchargeMinor: 1000,
            feeVariantId: "9004",
          },
          IMAGE_OR_LOGO: {
            label: "Embroidery — Image / Logo",
            surchargeMinor: 30000,
            feeVariantId: "9005",
          },
        },
      },
      DTF: { label: "DTF", surchargeMinor: 2000, feeVariantId: "9002" },
      DTG: { label: "DTG", surchargeMinor: 3000, feeVariantId: "9003" },
    },
  };
  const form = {
    querySelector(selector: string) {
      if (selector === 'input[name="id"]') return { value: "101" };
      if (selector.includes('input[name="quantity"]')) return { value: "1" };
      return null;
    },
  };
  const actions = {
    dataset: {
      customhousePitchprintRequired: "true",
      productId: "gid://shopify/Product/100",
      productHandle: "t-shirt",
      productTitle: "T-shirt",
      productOptionNames: JSON.stringify(["Color", "Size"]),
      productVariants: JSON.stringify([
        { id: 101, title: "Green / M", available: true, price: 10000, options: ["Green", "M"] },
        { id: 102, title: "Green / L", available: true, price: 10000, options: ["Green", "L"] },
      ]),
      sizeOptionPosition: "2",
      colorOptionPosition: "1",
      currency: "SEK",
      initialVariantId: "101",
      initialQuantity: "1",
    },
    querySelector(selector: string) {
      if (selector === 'form[data-customhouse-pitchprint-form="true"]') return form;
      if (selector === "[data-customhouse-production-pricing-json]") {
        return { textContent: JSON.stringify(pricing) };
      }
      return null;
    },
  };
  const root = {
    querySelector(selector: string) {
      if (selector === "[data-marked-product-actions]") return actions;
      if (selector === 'form[data-customhouse-pitchprint-form="true"]') return form;
      if (selector === "[data-cart-status]") return status;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const location = { href: "https://customhouse.se/products/t-shirt", origin: "https://customhouse.se" };

  class FakeXmlHttpRequest {
    status = 0;
    responseText = "";
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    timeout = 0;
    url = "";
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body: string) {
      const payload = JSON.parse(body) as Record<string, unknown>;
      requests.push({ url: this.url, payload });
      if (this.url.includes("public-production-cart")) {
        this.status = 200;
        this.responseText = JSON.stringify({
          ok: true,
          data: {
            items: [
              { id: "101", quantity: 1, properties: { _customhouse_fee_key: "fee-key" } },
              { id: "102", quantity: 1, properties: { _customhouse_fee_key: "fee-key" } },
              {
                id: "9005",
                quantity: 2,
                properties: {
                  _customhouse_fee_key: "fee-key",
                  _customhouse_production_fee: "true",
                },
              },
            ],
          },
        });
      } else {
        this.status = 200;
        this.responseText = JSON.stringify({ items: [] });
      }
      queueMicrotask(() => this.onload?.());
    }
  }

  const windowObject: Record<string, unknown> & {
    __customHousePitchPrintOrderHandoffState?: { snapshot: unknown };
  } = {
    location,
    Shopify: { routes: { root: "/" } },
    ppclient: {
      vars: { designId: "base_design_123", projectId: "" },
      on(eventName: string, listener: (event: Record<string, unknown>) => void) {
        clientListeners.set(eventName, [...(clientListeners.get(eventName) || []), listener]);
      },
      fire(eventName: string, data: Record<string, unknown>) {
        clientFires.push({ eventName, data });
      },
    },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
  };
  const documentObject = {
    querySelector(selector: string) {
      return selector === '[data-customhouse-pitchprint-required="true"]' ? root : null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-customhouse-pitchprint-required="true"]' ? [root] : [];
    },
    addEventListener() {},
  };
  const sandbox: Record<string, unknown> = {
    window: windowObject,
    document: documentObject,
    XMLHttpRequest: FakeXmlHttpRequest,
    URL,
    Intl,
    Map,
    Set,
    Element: class {},
    requestAnimationFrame(callback: () => void) { callback(); },
    queueMicrotask,
    console: {
      log(message: string, detail?: unknown) { logs.push({ level: "log", message, detail }); },
      warn(message: string, detail?: unknown) { logs.push({ level: "warn", message, detail }); },
    },
  };
  if (fetchConfig) sandbox.fetch = fetchConfig;
  vm.runInNewContext(
    readFileSync("theme-live-cart/assets/customhouse-pitchprint-public-contract.js", "utf8"),
    sandbox,
  );
  vm.runInNewContext(
    readFileSync("theme-live-cart/assets/customhouse-pitchprint-order-handoff.js", "utf8"),
    sandbox,
  );
  windowObject.__customHousePitchPrintOrderHandoffState!.snapshot = {
    root,
    form,
    variantId: 0,
    quantity: 0,
    productId: "gid://shopify/Product/100",
  };

  return {
    setPricing(value) { pricing = value; },
    setProductId(value) { actions.dataset.productId = value; },
    dispatchMessage(event) {
      for (const listener of listeners.get("message") || []) listener(event);
    },
    emitClient(eventName, data) {
      for (const listener of clientListeners.get(eventName) || []) {
        listener({ type: eventName, data });
      }
    },
    async flush() {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    },
    requests,
    acknowledgements,
    clientFires,
    location,
    logs,
  };
}

test("full-config request delivers sticker-only config, resends on ready, and tracks ACK", () => {
  const harness = bridgeHarness({ currency: "SEK", productionMethods: [
    { code: "STICKER_PRINTING", label: "Sticker Printing", enabled: true, surchargeMinor: 1000 },
    { code: "DTF", enabled: false, surchargeMinor: 2000 },
  ] });
  const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const source = { postMessage(message: typeof messages[number]) { messages.push(message); } };
  harness.dispatchMessage({ origin: "https://pitchprint.io", source, data: { type: "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST" } });
  const full = messages.find(message => message.type === "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG")!;
  assert.ok(full);
  assert.equal(full.payload.flowMode, "PUBLIC_CUSTOMIZE");
  assert.deepEqual(JSON.parse(JSON.stringify(full.payload.productionMethods)), [{
    code: "STICKER_PRINTING", id: "sticker_printing", label: "Sticker Printing", enabled: true, surchargeMinor: 1000, currency: "SEK",
  }]);
  harness.emitClient("editor-shown", {});
  assert.equal(messages.filter(message => message.type === "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG").length, 2);
  harness.dispatchMessage({ origin: "https://pitchprint.io", source, data: { type: "CUSTOMHOUSE_PP_ORDER_CONFIG_ACK", payload: { configRevision: full.payload.configRevision } } });
  assert.ok(harness.logs.some(log => log.message.includes("PUBLIC_CONFIG_ACKNOWLEDGED")));
});

test("authoritative list can shrink to empty and product switch cannot reuse its predecessor", () => {
  const harness = bridgeHarness({ currency: "SEK", productionMethods: [{ id: "DTF" }, { id: "STICKER_PRINTING" }] });
  const messages: Array<{ type: string; payload: { productId: string; productionMethods: Array<{ code: string }> } }> = [];
  const source = { postMessage(message: typeof messages[number]) { messages.push(message); } };
  const request = () => harness.dispatchMessage({ origin: "https://pitchprint.io", source, data: { type: "CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST" } });
  request();
  harness.setPricing({ currency: "SEK", productionMethods: [{ id: "STICKER_PRINTING" }] });
  request();
  assert.deepEqual(Array.from(messages.at(-1)?.payload.productionMethods || [], method => method.code), ["STICKER_PRINTING"]);
  harness.setPricing({ currency: "SEK", productionMethods: [] });
  request();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.payload.productionMethods)), []);
  harness.setProductId("gid://shopify/Product/200");
  harness.setPricing({ currency: "SEK", productionMethods: [{ id: "SCREEN_PRINTING" }] });
  request();
  assert.equal(messages.at(-1)?.payload.productId, "gid://shopify/Product/200");
  assert.deepEqual(Array.from(messages.at(-1)?.payload.productionMethods || [], method => method.code), ["SCREEN_PRINTING"]);
});

test("canonical server result replaces stale Liquid data and is delivered after readiness", async () => {
  let finish!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finish = resolve; });
  const harness = bridgeHarness({ productionMethods: [{ id: "EMBROIDERY" }, { id: "DTF" }, { id: "DTG" }] }, (() => response) as typeof fetch);
  const messages: Array<{ type: string; payload: { productionMethods: Array<{ code: string }> } }> = [];
  const source = { postMessage(message: typeof messages[number]) { messages.push(message); } };
  harness.dispatchMessage({ origin: "https://pitchprint.io", source, data: { type: "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST" } });
  finish(Response.json({ ok: true, data: { productId: "gid://shopify/Product/100", currency: "SEK", productionMethods: [{ code: "STICKER_PRINTING", enabled: true, surchargeMinor: 1000 }] } }));
  await harness.flush();
  await harness.flush();
  assert.deepEqual(Array.from(messages.at(-1)?.payload.productionMethods || [], method => method.code), ["STICKER_PRINTING"]);
});

test("untrusted origins cannot obtain config", () => {
  const harness = bridgeHarness({ productionMethods: [] });
  let sent = false;
  harness.dispatchMessage({ origin: "https://untrusted.invalid", source: { postMessage() { sent = true; } }, data: { type: "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST" } });
  assert.equal(sent, false);
});

test("Liquid numeric product ID is normalized for the canonical server lookup", async () => {
  const requests: string[] = [];
  const harness = bridgeHarness({ productionMethods: [] }, (async (url: string) => {
    requests.push(url);
    const productId = new URL(url, "https://customhouse.se").searchParams.get("productId");
    return Response.json({ ok: true, data: { productId, baseProductId: productId, currency: "SEK", productionMethods: [{ code: "STICKER_PRINTING" }] } });
  }) as typeof fetch);
  harness.setProductId("16472592548185");
  const messages: Array<{ payload: { productionMethods: Array<{ code: string }> } }> = [];
  harness.dispatchMessage({ origin: "https://pitchprint.io", source: { postMessage(message: typeof messages[number]) { messages.push(message); } }, data: { type: "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST" } });
  await harness.flush();
  await harness.flush();
  assert.ok(requests.some(url => decodeURIComponent(url).includes("gid://shopify/Product/16472592548185")));
  assert.deepEqual(Array.from(messages.at(-1)?.payload.productionMethods || [], method => method.code), ["STICKER_PRINTING"]);
});

test("partial Liquid pricing cannot close the authoritative list, while a resolved empty server list does", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const harness = bridgeHarness({ currency: "SEK" }, (() => pending) as typeof fetch);
  const messages: Array<{ payload: { productionMethods: unknown[] } }> = [];
  const source = { postMessage(message: typeof messages[number]) { messages.push(message); } };
  harness.dispatchMessage({ origin: "https://pitchprint.io", source, data: { type: "CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG_REQUEST" } });
  assert.equal(messages.length, 0);
  finish(Response.json({ ok: true, data: { productId: "gid://shopify/Product/100", currency: "SEK", productionMethods: [] } }));
  await harness.flush();
  await harness.flush();
  assert.ok(messages.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.payload.productionMethods)), []);
});

test("allowed PitchPrint cart-ready message atomically adds all prepared lines, acknowledges, and redirects", async () => {
  const harness = bridgeHarness();
  const source = {
    postMessage(message: Record<string, unknown>) {
      harness.acknowledgements.push(message);
    },
  };
  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source,
    data: {
      type: "CUSTOMHOUSE_PP_CART_READY",
      payload: {
        projectId: "project_123",
        designId: "design_123",
        productionMethod: "EMBROIDERY",
        artworkType: "IMAGE_OR_LOGO",
        embroiderySubtype: "IMAGE_OR_LOGO",
        placementCount: 1,
        totalQuantity: 2,
        legalConfirmations: { rightsAccepted: true, termsAccepted: true },
        artworkSource: { pages: [{ name: "Front", objects: [{ type: "image" }] }] },
        variantSelections: [
          { variantId: "101", color: "Green", size: "M", quantity: 1 },
          { variantId: "102", color: "Green", size: "L", quantity: 1 },
        ],
      },
    },
  });
  await harness.flush();

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0]?.url, "/apps/customhouse/api/public-production-cart");
  assert.deepEqual(
    (harness.requests[0]?.payload.variantSelections as Array<Record<string, unknown>>).map(({ variantId, quantity }) => ({ variantId, quantity })),
    [
      { variantId: "101", quantity: 1 },
      { variantId: "102", quantity: 1 },
    ],
  );
  assert.deepEqual(
    (harness.requests[1]?.payload.items as Array<Record<string, unknown>>).map(({ id, quantity }) => ({ id, quantity })),
    [
      { id: "101", quantity: 1 },
      { id: "102", quantity: 1 },
      { id: "9005", quantity: 2 },
    ],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(harness.acknowledgements)), [
    {
      type: "CUSTOMHOUSE_PP_CART_READY_ACK",
      payload: { ok: true, projectId: "project_123" },
    },
  ]);
  assert.equal(harness.location.href, "/cart");
});

test("foreign cart-ready postMessage cannot mutate the Shopify cart", async () => {
  const harness = bridgeHarness();
  harness.dispatchMessage({
    origin: "https://malicious.example",
    source: { postMessage() {} },
    data: { type: "CUSTOMHOUSE_PP_CART_READY", payload: { projectId: "attack" } },
  });
  await harness.flush();

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.location.href, "https://customhouse.se/products/t-shirt");
});

test("new public design config exposes explicit save-on-continue identity", () => {
  const harness = bridgeHarness();
  const messages: Array<Record<string, unknown>> = [];
  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source: {
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    },
    data: { type: "CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST" },
  });

  const response = messages.find(message => message.type === "CUSTOMHOUSE_PP_ORDER_CONFIG_DATA") as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  assert.equal(response.type, "CUSTOMHOUSE_PP_ORDER_CONFIG_DATA");
  assert.equal(response.payload?.projectIdentityMode, "SAVE_ON_CONTINUE");
  assert.equal(
    response.payload?.pitchprintProjectId,
    "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
  );
  assert.equal(
    response.payload?.pitchprintDesignId,
    "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
  );
});

test("new public design saves first, then adds real PitchPrint identity to cart", async () => {
  const harness = bridgeHarness();
  const source = {
    postMessage(message: Record<string, unknown>) {
      harness.acknowledgements.push(message);
    },
  };

  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source,
    data: {
      type: "CUSTOMHOUSE_PP_CART_READY",
      payload: {
        handoffId: "handoff_live_123",
        projectId: "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
        designId: "base_design_123",
        productionMethod: "EMBROIDERY",
        artworkType: "IMAGE_OR_LOGO",
        embroiderySubtype: "IMAGE_OR_LOGO",
        placementCount: 1,
        placements: [{ side: "front" }],
        totalQuantity: 1,
        copyrightConfirmed: true,
        nonReturnConfirmed: true,
        acknowledgements: {
          copyrightConfirmed: true,
          nonReturnConfirmed: true,
        },
        artworkSummary: {
          hasText: false,
          hasImage: true,
          printableObjectCount: 1,
          objectTypes: ["image"],
        },
        variantSelections: [
          { variantId: "101", color: "Green", size: "M", quantity: 1 },
        ],
      },
    },
  });
  await harness.flush();

  assert.deepEqual(JSON.parse(JSON.stringify(harness.clientFires)), [
    { eventName: "start-save", data: {} },
  ]);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.acknowledgements.length, 0);

  harness.emitClient("project-saved", {
    projectId: "project_real_123",
    designId: "design_real_123",
    previews: ["https://pitchprint.io/previews/project_real_123_1.jpg"],
    source: {
      designId: "design_real_123",
    },
  });
  await harness.flush();

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0]?.payload.pitchprintProjectId, "project_real_123");
  assert.equal(harness.requests[0]?.payload.pitchprintDesignId, "design_real_123");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.requests[0]?.payload.legalConfirmations)),
    { rightsAccepted: true, termsAccepted: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.requests[0]?.payload.artworkSource)),
    {
      pages: [
        {
          name: "front",
          objects: [{ type: "image", isUserArtwork: true }],
        },
      ],
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(harness.acknowledgements)), [
    {
      type: "CUSTOMHOUSE_PP_CART_READY_ACK",
      payload: {
        ok: true,
        projectId: "project_real_123",
        handoffId: "handoff_live_123",
      },
    },
  ]);
  assert.equal(harness.location.href, "/cart");
});

test("public cart artwork summary includes only the claimed designed placements", async () => {
  const harness = bridgeHarness();
  const source = {
    postMessage(message: Record<string, unknown>) {
      harness.acknowledgements.push(message);
    },
  };

  harness.dispatchMessage({
    origin: "https://pitchprint.io",
    source,
    data: {
      type: "CUSTOMHOUSE_PP_CART_READY",
      payload: {
        handoffId: "handoff_placement_123",
        projectId: "__CUSTOMHOUSE_PUBLIC_SAVE_PENDING__",
        designId: "base_design_123",
        productionMethod: "EMBROIDERY",
        artworkType: "TEXT_ONLY",
        embroiderySubtype: "TEXT_ONLY",
        placementCount: 1,
        placements: [
          { side: "front", hasArtwork: true },
          { side: "back", hasArtwork: false },
          { side: "side", hasArtwork: false },
        ],
        totalQuantity: 1,
        copyrightConfirmed: true,
        nonReturnConfirmed: true,
        artworkSummary: {
          hasText: true,
          hasImage: false,
          printableObjectCount: 1,
          objectTypes: ["text"],
        },
        variantSelections: [
          { variantId: "101", color: "Green", size: "M", quantity: 1 },
        ],
      },
    },
  });
  await harness.flush();

  harness.emitClient("project-saved", {
    projectId: "project_placement_123",
    designId: "design_placement_123",
    source: { designId: "design_placement_123" },
  });
  await harness.flush();

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.requests[0]?.payload.artworkSource)),
    {
      pages: [
        {
          name: "front",
          objects: [{ type: "text" }],
        },
      ],
    },
  );
});
