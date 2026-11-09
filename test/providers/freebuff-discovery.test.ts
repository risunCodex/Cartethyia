/**
 * Freebuff catalog + discovery + quota tests.
 */
import { describe, expect, test } from "bun:test";
import { FREEBUFF_MODELS } from "../../src/providers/integrations/freebuff/freebuff-catalog";
import { freebuffModelDiscovery } from "../../src/providers/integrations/freebuff/freebuff-discovery";
import { fetchFreebuffQuota } from "../../src/providers/integrations/freebuff/freebuff-quota";

describe("Freebuff static catalog", () => {
  test("seeds the live 13-row surface with chat wire", () => {
    expect(FREEBUFF_MODELS.length).toBeGreaterThanOrEqual(10);
    for (const model of FREEBUFF_MODELS) {
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe("/api/v1/chat/completions");
      expect(model.modelId).toMatch(/^m-[0-9a-f]+$/);
    }
    const ids = new Set(FREEBUFF_MODELS.map((m) => m.modelId));
    expect(ids.size).toBe(FREEBUFF_MODELS.length);
  });

  test("marks open rows free-tier and locked rows proOnly", () => {
    const fast = FREEBUFF_MODELS.find((m) => m.modelId === "m-096e75164d");
    expect(fast?.freeTier).toBe(true);
    expect(fast?.proOnly).toBeUndefined();
    expect(fast?.cost.input).toBe(0);
    const luna = FREEBUFF_MODELS.find((m) => m.modelId === "m-5a5d0e255e");
    expect(luna?.proOnly).toBe(true);
    expect(luna?.freeTier).toBeUndefined();
  });
});

describe("Freebuff model discovery", () => {
  test("maps a live catalog response to ModelDefinitions", async () => {
    const discovery = freebuffModelDiscovery();
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          protocol: 1,
          fetchId: "fbf1.test",
          rows: [
            { key: "m-096e75164d", displayName: "DeepSeek Fast", handle: "fbm1.x", access: "open", premium: false },
            { key: "m-5a5d0e255e", displayName: "GPT-6 Luna", handle: "fbm1.y", access: "locked", premium: true },
            { key: "m-9a7e098cc1", displayName: "Solar Pro 4", handle: "fbm1.z", access: "open", premium: false },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await discovery({
      baseUrl: "https://www.codebuff.com",
      credential: "token-1",
      fetcher,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    const fast = result!.find((m) => m.modelId === "m-096e75164d");
    expect(fast?.freeTier).toBe(true);
    expect(fast?.proOnly).toBeUndefined();
    const luna = result!.find((m) => m.modelId === "m-5a5d0e255e");
    expect(luna?.proOnly).toBe(true);
  });

  test("returns null on non-OK or malformed catalog", async () => {
    const discovery = freebuffModelDiscovery();
    const fetcher = (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const bad = await discovery({
      baseUrl: "https://www.codebuff.com",
      credential: "token-1",
      fetcher,
    });
    expect(bad).toBeNull();
  });
});

describe("Freebuff quota collector", () => {
  test("builds windows from an admission response", async () => {
    const admissionBody = {
      status: "active",
      accessTier: "limited",
      freebucks: {
        balance: 10,
        daily: { limit: 25, spent: 15, remaining: 10, resetAt: "2026-11-10T08:00:00.000Z" },
      },
      rateLimit: { model: "m-096e75164d", limit: 6, recentCount: 3, resetAt: "2026-11-10T08:00:00.000Z" },
    };
    let calls = 0;
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      const url = String(input);
      if (url.includes("/session/admission")) {
        return new Response(JSON.stringify(admissionBody), { status: 200 });
      }
      if (url.includes("/session")) {
        return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher);
    expect(quota.error).toBeNull();
    expect(quota.plan).toBe("limited");
    expect(quota.windows.length).toBeGreaterThanOrEqual(2);
    const daily = quota.windows.find((w) => w.kind === "freebucks_daily");
    expect(daily?.used).toBe(15);
    expect(daily?.limit).toBe(25);
    expect(daily?.remaining).toBe(10);
    const rate = quota.windows.find((w) => w.kind === "rate_limit");
    expect(rate?.used).toBe(3);
    expect(rate?.limit).toBe(6);
    expect(calls).toBe(2); // admission + release
  });

  test("reports an error when admission is refused", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: "waiting_room_required" }), { status: 428 })) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher);
    expect(quota.error).not.toBeNull();
  });
});
