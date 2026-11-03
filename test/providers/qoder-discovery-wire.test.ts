/**
 * Qoder model discovery wire contract.
 *
 * `discoverQoderModels` must reach `/algo/api/v2/model/list` with a **GET**
 * carrying the signed `{}` body — upstream rejects POST on this surface (400
 * "Request method 'POST' not supported"), and the signature covers the body,
 * so a bare GET fails too (101 "Signature invalid"). The gateway dials
 * GET+body through the Node http(s) client because the runtime fetch rejects
 * GET bodies. This test locks the method to GET and asserts the signed body is
 * what is sent.
 */
import { describe, expect, test } from "bun:test";
import { discoverQoderModels, resetQoderDiscoveryCache } from "../../src/providers/integrations/qoder/qoder-catalog";
import type { QoderRealm } from "../../src/providers/integrations/qoder/qoder-realm";

const ROSTER_PAYLOAD = JSON.stringify({
  chat: [
    { key: "auto", display_name: "Auto", is_vl: true, is_reasoning: false, enable: true, max_input_tokens: 200000 },
    { key: "dmodel", display_name: "DeepSeek-V4-Pro", is_vl: true, is_reasoning: true, enable: true, max_input_tokens: 1000000 },
  ],
});

interface CapturedCall {
  method: string | undefined;
  url: string | undefined;
  body: string | undefined;
  bodyNull: boolean;
}

function stubFetch(captured: CapturedCall): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.method = init?.method;
    captured.url = String(input);
    if (typeof init?.body === "string") captured.body = init.body;
    else captured.body = undefined;
    captured.bodyNull = init?.body === null;
    return new Response(ROSTER_PAYLOAD, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("Qoder model discovery wire", () => {
  test("issues a GET carrying the signed body (not POST)", async () => {
    resetQoderDiscoveryCache("intl");
    const captured: CapturedCall = { method: undefined, url: undefined, body: undefined, bodyNull: false };
    const models = await discoverQoderModels({
      realm: "intl",
      providerId: "qoder",
      credential: "pt-test",
      headers: () => Promise.resolve({ authorization: "Bearer COSY.test" }),
      fetcher: stubFetch(captured),
      encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    });
    expect(captured.method).toBe("GET");
    expect(captured.url).toContain("/algo/api/v2/model/list?Encode=1");
    expect(captured.body).toBe("{}");
    expect(models.map((m) => m.modelId).sort()).toEqual(["auto", "deepseek-v4-pro"]);
  });

  test("falls through hosts on failure and surfaces the last error", async () => {
    resetQoderDiscoveryCache("intl");
    let calls = 0;
    const fetcher: typeof fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 403 });
    }) as unknown as typeof fetch;
    await expect(
      discoverQoderModels({
        realm: "intl",
        providerId: "qoder",
        credential: "pt-test",
        headers: () => Promise.resolve({}),
        fetcher,
        encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
      }),
    ).rejects.toThrow(/Qoder model list answered 403/);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("publishes the lite roster slot with its plan config", async () => {
    resetQoderDiscoveryCache("intl");
    const payload = JSON.stringify({
      chat: [
        { key: "lite", display_name: "Lite-Qwen-3.7-Plus", is_vl: true, is_reasoning: false, enable: true, max_input_tokens: 1000000 },
      ],
    });
    const fetcher: typeof fetch = (async () =>
      new Response(payload, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const models = await discoverQoderModels({
      realm: "intl",
      providerId: "qoder",
      credential: "pt-test",
      headers: () => Promise.resolve({}),
      fetcher,
      encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    });
    const lite = models.find((m) => m.modelId === "lite-qwen-3.7-plus");
    expect(lite).toBeDefined();
    expect(lite?.freeTier).toBe(true);
    expect(lite?.outputLimit).toBe(65536);
    expect(lite?.modalities.input).toContain("image");
  });

  test("discovered rows inherit the roster's output ceiling instead of shrinking", async () => {
    resetQoderDiscoveryCache("intl");
    // No row carries `max_output_tokens` — upstream's model list reports none —
    // so the discovered row's output limit must come from the static roster.
    const payload = JSON.stringify({
      chat: [
        { key: "ultimate", display_name: "Ultimate", is_vl: true, is_reasoning: true, enable: true, max_input_tokens: 1000000 },
        { key: "dmodel", display_name: "DeepSeek-V4-Pro", is_vl: true, is_reasoning: true, enable: true, max_input_tokens: 1000000 },
      ],
    });
    const fetcher: typeof fetch = (async () =>
      new Response(payload, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const models = await discoverQoderModels({
      realm: "intl",
      providerId: "qoder",
      credential: "pt-test",
      headers: () => Promise.resolve({}),
      fetcher,
      encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    });
    // `ultimate` has no virtual alias → published through `qoderCatalogModel`;
    // its row must carry the roster's 128k ceiling, not a base-catalog/unfiled
    // estimate (131k) and not the 65k floor.
    const ultimate = models.find((m) => m.modelId === "ultimate");
    expect(ultimate).toBeDefined();
    expect(ultimate?.outputLimit).toBe(128_000);
    // `dmodel` publishes under its virtual alias; same inheritance from the
    // roster (384k).
    const deepseek = models.find((m) => m.modelId === "deepseek-v4-pro");
    expect(deepseek).toBeDefined();
    expect(deepseek?.outputLimit).toBe(384_000);
  });

  test("caches per realm and reuses within TTL", async () => {
    resetQoderDiscoveryCache("intl");
    let fetches = 0;
    const fetcher: typeof fetch = (async () => {
      fetches += 1;
      return new Response(ROSTER_PAYLOAD, { status: 200 });
    }) as unknown as typeof fetch;
    const opts = {
      realm: "intl" as QoderRealm,
      providerId: "qoder",
      credential: "pt-test",
      headers: () => Promise.resolve({}),
      fetcher,
      encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1"),
    };
    await discoverQoderModels(opts);
    await discoverQoderModels(opts);
    expect(fetches).toBe(1);
    resetQoderDiscoveryCache("intl");
  });
});
