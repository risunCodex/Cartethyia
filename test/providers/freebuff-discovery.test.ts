/**
 * Freebuff catalog + discovery + virtual-model + quota tests.
 */
import { describe, expect, test } from "bun:test";
import { FREEBUFF_MODELS } from "../../src/providers/integrations/freebuff/freebuff-catalog";
import { freebuffModelDiscovery } from "../../src/providers/integrations/freebuff/freebuff-discovery";
import {
  FREEBUFF_VIRTUAL_MODELS,
  freebuffDispatchModelId,
  freebuffDisplayNameFor,
  freebuffVirtualIdFor,
  isFreebuffVirtualModel,
} from "../../src/providers/integrations/freebuff/freebuff-virtual";
import { fetchFreebuffQuota } from "../../src/providers/integrations/freebuff/freebuff-quota";

describe("Freebuff static catalog", () => {
  test("publishes caller-facing virtual ids on the chat wire", () => {
    expect(FREEBUFF_MODELS.length).toBeGreaterThanOrEqual(10);
    for (const model of FREEBUFF_MODELS) {
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe("/api/v1/chat/completions");
      // Virtual ids are readable names, not the raw `m-<hex>` roster keys.
      expect(model.modelId).not.toMatch(/^m-[0-9a-f]+$/);
    }
    const ids = new Set(FREEBUFF_MODELS.map((m) => m.modelId));
    expect(ids.size).toBe(FREEBUFF_MODELS.length);
  });

  test("every virtual id is catalogued and maps to a distinct roster key", () => {
    for (const virtual of FREEBUFF_VIRTUAL_MODELS) {
      const row = FREEBUFF_MODELS.find((m) => m.modelId === virtual.id);
      expect(row, `virtual row ${virtual.id}`).toBeDefined();
      expect(freebuffDispatchModelId(virtual.id)).toBe(virtual.target);
      expect(isFreebuffVirtualModel(virtual.id)).toBe(true);
      expect(freebuffVirtualIdFor(virtual.target)).toBe(virtual.id);
      expect(freebuffDisplayNameFor(virtual.id)).toBe(virtual.displayName);
    }
    const targets = FREEBUFF_VIRTUAL_MODELS.map((virtual) => virtual.target);
    expect(new Set(targets).size).toBe(targets.length);
  });

  test("marks open rows free-tier and locked rows proOnly", () => {
    const fast = FREEBUFF_MODELS.find((m) => m.modelId === "deepseek-fast");
    expect(fast?.freeTier).toBe(true);
    expect(fast?.proOnly).toBeUndefined();
    expect(fast?.cost.input).toBe(0);
    const luna = FREEBUFF_MODELS.find((m) => m.modelId === "gpt-6-luna");
    expect(luna?.proOnly).toBe(true);
    expect(luna?.freeTier).toBeUndefined();
  });

  test("uses the server-published context windows, not a hardcoded guess", () => {
    const byId = new Map(FREEBUFF_MODELS.map((m) => [m.modelId, m]));
    expect(byId.get("deepseek-fast")?.contextLimit).toBe(1_048_576); // DeepSeek Fast
    expect(byId.get("gpt-6-luna")?.contextLimit).toBe(1_000_000); // GPT-6 Luna
    expect(byId.get("solar-pro-4")?.contextLimit).toBe(500_000); // Solar Pro 4
    expect(byId.get("glyph-cluster")?.contextLimit).toBe(256_000); // Glyph Cluster
    expect(byId.get("claude-haiku-5.5")?.contextLimit).toBe(100_000); // Claude Haiku 100k
  });
});

describe("Freebuff model discovery", () => {
  test("maps a live catalog response to virtual ModelDefinitions", async () => {
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
    const fast = result!.find((m) => m.modelId === "deepseek-fast");
    expect(fast?.freeTier).toBe(true);
    expect(fast?.proOnly).toBeUndefined();
    // The server-published context window and modality must survive discovery.
    expect(fast?.contextLimit).toBe(1_048_576);
    expect(fast?.modalities.input).toContain("image");
    expect(fast?.reasoningEfforts).toEqual(["low", "high", "max"]);
    const luna = result!.find((m) => m.modelId === "gpt-6-luna");
    expect(luna?.proOnly).toBe(true);
    expect(luna?.contextLimit).toBe(1_000_000);
    const solar = result!.find((m) => m.modelId === "solar-pro-4");
    expect(solar?.contextLimit).toBe(500_000);
    expect(solar?.modalities.input).not.toContain("image");
    // No raw `m-<hex>` key survives when it has a virtual name.
    expect(result!.every((m) => !m.modelId.startsWith("m-"))).toBe(true);
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

describe("Freebuff virtual dispatch translation", () => {
  test("translates a virtual id to its roster key and leaves raw ids unchanged", () => {
    expect(freebuffDispatchModelId("deepseek-fast")).toBe("m-096e75164d");
    expect(freebuffDispatchModelId("solar-pro-4")).toBe("m-9a7e098cc1");
    expect(freebuffDispatchModelId("m-096e75164d")).toBe("m-096e75164d");
    expect(freebuffDispatchModelId("unknown-model")).toBe("unknown-model");
    expect(isFreebuffVirtualModel("gpt-6-luna")).toBe(true);
    expect(isFreebuffVirtualModel("m-5a5d0e255e")).toBe(false);
  });
});

describe("Freebuff quota collector", () => {
  /** Real Ed25519 device identity shaped like the stored auth_state.device. */
  async function deviceIdentity() {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    return {
      version: 1,
      publicKey: Buffer.from(publicKey).toString("base64url"),
      privateKey: Buffer.from(privateKey).toString("base64url"),
      keyId: "user:acc-1|k_test_123",
      installId: "5e2e1b40-0000-4000-8000-000000000000",
    };
  }

  async function sessionContext(overrides: Record<string, unknown> = {}) {
    return {
      auth_state: {
        accountId: "acc-1",
        device: await deviceIdentity(),
        ...overrides,
      },
    };
  }

  function sessionBody(extra: Record<string, unknown> = {}) {
    return {
      status: "active",
      accessTier: "limited",
      freebucks: {
        balance: 10,
        daily: { limit: 25, spent: 15, remaining: 10, resetAt: "2026-11-10T08:00:00.000Z" },
      },
      rateLimitsByModel: {
        "m-096e75164d": { model: "m-096e75164d", limit: 6, recentCount: 3, resetAt: "2026-11-10T08:00:00.000Z" },
      },
      ...extra,
    };
  }

  test("builds windows from a read-only session response, with no admission", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/freebuff/session")) {
        return new Response(JSON.stringify(sessionBody()), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, await sessionContext());
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
    // The window carries the caller-facing virtual name, matching the catalog.
    expect(rate?.modelIds).toEqual(["deepseek-fast"]);
    // Exactly one read — no catalog resolve, no admission, no release.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/freebuff/session");
    expect(calls[0]).not.toContain("admission");
  });

  test("reports an error when the session read is refused", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: "waiting_room_required" }), { status: 428 })) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, await sessionContext());
    expect(quota.error).not.toBeNull();
  });

  test("returns an error when the account has no device identity", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return new Response(JSON.stringify(sessionBody()), { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, { auth_state: {} });
    expect(quota.error).not.toBeNull();
    expect(quota.windows).toEqual([]);
    // No upstream call at all when the identity is missing.
    expect(calls).toHaveLength(0);
  });

  test("emits session_active windows from session desktopPurchases", async () => {
    const future = new Date(Date.now() + 4 * 3_600_000 + 29 * 60_000).toISOString(); // 4h29m from now
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/freebuff/session")) {
        return new Response(
          JSON.stringify(
            sessionBody({
              desktopPurchases: [{ model: "m-096e75164d", expiresAt: future, holderInstanceId: "inst-1" }],
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, await sessionContext());
    expect(quota.error).toBeNull();
    const session = quota.windows.find((w) => w.kind === "session_active");
    expect(session).toBeDefined();
    expect(session!.modelIds).toEqual(["deepseek-fast"]);
    expect(session!.resetsAt).toBe(future);
    expect(session!.recurring).toBe(false);
    expect(session!.remaining).toBeGreaterThanOrEqual(269); // ~4h29m in minutes
    expect(session!.remaining).toBeLessThanOrEqual(270);
  });

  test("skips session windows for expired purchases", async () => {
    const past = new Date(Date.now() - 5_000).toISOString();
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/freebuff/session")) {
        return new Response(
          JSON.stringify(
            sessionBody({
              desktopPurchases: [{ model: "m-096e75164d", expiresAt: past, holderInstanceId: "inst-1" }],
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, await sessionContext());
    expect(quota.windows.some((w) => w.kind === "session_active")).toBe(false);
  });

  test("session without purchases emits no session windows", async () => {
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/freebuff/session")) {
        return new Response(JSON.stringify(sessionBody()), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const quota = await fetchFreebuffQuota("token-1", fetcher, await sessionContext());
    expect(quota.error).toBeNull();
    expect(quota.windows.some((w) => w.kind === "session_active")).toBe(false);
  });
});
