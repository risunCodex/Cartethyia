/**
 * Freebuff catalog + discovery + quota tests.
 */
import { describe, expect, test } from "bun:test";
import { FREEBUFF_MODELS } from "../../src/providers/integrations/freebuff/freebuff-catalog";
import { freebuffModelDiscovery } from "../../src/providers/integrations/freebuff/freebuff-discovery";
import { fetchFreebuffQuota } from "../../src/providers/integrations/freebuff/freebuff-quota";
import { freebuffMintDeviceKey } from "../../src/providers/integrations/freebuff/freebuff";

async function testDevice() {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ keyId: "k_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return freebuffMintDeviceKey("token-1", { fetchFn, accountId: "acc_1" });
}

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

  test("uses the server-published context windows, not a hardcoded guess", () => {
    const byId = new Map(FREEBUFF_MODELS.map((m) => [m.modelId, m]));
    expect(byId.get("m-096e75164d")?.contextLimit).toBe(1_048_576); // DeepSeek Fast
    expect(byId.get("m-5a5d0e255e")?.contextLimit).toBe(1_000_000); // GPT-6 Luna
    expect(byId.get("m-9a7e098cc1")?.contextLimit).toBe(500_000); // Solar Pro 4
    expect(byId.get("m-02244092cb")?.contextLimit).toBe(256_000); // Glyph Cluster
    expect(byId.get("m-5b6a604eb6")?.contextLimit).toBe(100_000); // Claude Haiku 100k
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
            { key: "m-096e75164d", displayName: "DeepSeek Fast", handle: "fbm1.x", access: "open", premium: false, contextWindow: 1_048_576, multimodal: true, efforts: ["low", "high", "max"] },
            { key: "m-5a5d0e255e", displayName: "GPT-6 Luna", handle: "fbm1.y", access: "locked", premium: true, contextWindow: 1_000_000, multimodal: true, efforts: ["low", "medium", "high"] },
            { key: "m-9a7e098cc1", displayName: "Solar Pro 4", handle: "fbm1.z", access: "open", premium: false, contextWindow: 500_000 },
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
    // The server-published context window and modality must survive discovery.
    expect(fast?.contextLimit).toBe(1_048_576);
    expect(fast?.modalities.input).toContain("image");
    expect(fast?.reasoningEfforts).toEqual(["low", "high", "max"]);
    const luna = result!.find((m) => m.modelId === "m-5a5d0e255e");
    expect(luna?.proOnly).toBe(true);
    expect(luna?.contextLimit).toBe(1_000_000);
    const solar = result!.find((m) => m.modelId === "m-9a7e098cc1");
    expect(solar?.contextLimit).toBe(500_000);
    expect(solar?.modalities.input).not.toContain("image");
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

  test("emits session_active windows from a live GET /session with device identity", async () => {
    const future = new Date(Date.now() + 4 * 3_600_000 + 29 * 60_000).toISOString(); // 4h29m from now
    const admissionBody = { status: "active", accessTier: "limited", freebucks: { balance: 15, daily: { limit: 25, spent: 10, remaining: 15, resetAt: "2026-11-10T08:00:00.000Z" } } };
    const device = await testDevice();
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/session/admission")) {
        return new Response(JSON.stringify(admissionBody), { status: 200 });
      }
      if (url.endsWith("/session")) {
        return new Response(
          JSON.stringify({
            status: "active",
            desktopPurchases: [{ model: "m-096e75164d", expiresAt: future, holderInstanceId: "inst-1" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, {
      auth_state: { accountId: "acc_1", device },
      credential_kind: "oauth",
      accountId: "acc_1",
    });
    expect(quota.error).toBeNull();
    const session = quota.windows.find((w) => w.kind === "session_active");
    expect(session).toBeDefined();
    expect(session!.modelIds).toEqual(["m-096e75164d"]);
    expect(session!.resetsAt).toBe(future);
    expect(session!.recurring).toBe(false);
    expect(session!.remaining).toBeGreaterThanOrEqual(269); // ~4h29m in minutes
    expect(session!.remaining).toBeLessThanOrEqual(270);
  });

  test("skips session windows for expired purchases", async () => {
    const past = new Date(Date.now() - 5_000).toISOString();
    const admissionBody = { status: "active", accessTier: "limited", freebucks: { balance: 15, daily: { limit: 25, spent: 10, remaining: 15, resetAt: "2026-11-10T08:00:00.000Z" } } };
    const device = await testDevice();
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/session/admission")) {
        return new Response(JSON.stringify(admissionBody), { status: 200 });
      }
      if (url.endsWith("/session")) {
        return new Response(
          JSON.stringify({
            status: "active",
            desktopPurchases: [{ model: "m-096e75164d", expiresAt: past, holderInstanceId: "inst-1" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, {
      auth_state: { accountId: "acc_1", device },
      credential_kind: "oauth",
      accountId: "acc_1",
    });
    expect(quota.windows.some((w) => w.kind === "session_active")).toBe(false);
  });

  test("without device identity, quota still works and emits no session windows", async () => {
    const admissionBody = { status: "active", accessTier: "limited", freebucks: { balance: 15, daily: { limit: 25, spent: 10, remaining: 15, resetAt: "2026-11-10T08:00:00.000Z" } } };
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/session/admission")) {
        return new Response(JSON.stringify(admissionBody), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, {
      auth_state: { accountId: "acc_1" },
      credential_kind: "oauth",
      accountId: "acc_1",
    });
    expect(quota.error).toBeNull();
    expect(quota.windows.some((w) => w.kind === "session_active")).toBe(false);
  });
});
