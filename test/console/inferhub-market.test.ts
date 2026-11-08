/**
 * InferHub market normalization, caching, and rate limiting.
 *
 * The four derivations the market module is built on, each pinned because each
 * fails silently rather than loudly: a wrong tier count, a discount computed
 * against a zero baseline, an alias that fails to unify two prefixes, or a null
 * coerced to zero all render as plausible-looking numbers.
 *
 * Also pinned: the store must never fetch on its own (no background polling)
 * and the rate bucket must cap, because the whole design rests on market data
 * being on-demand.
 */
import { describe, expect, test } from "bun:test";
import {
  aliasKeyOf,
  applyFamilyHealth,
  capacityWeightedPrice,
  discountPct,
  groupTiers,
  mergeMarketPrices,
  mergeModelHealth,
  normalizeCatalogModel,
  splitId,
} from "../../src/console/inferhub/normalize";
import {
  __resetRateLimit,
  fetchMarket,
  INFERHUB_API_BASE,
  objectArray,
} from "../../src/console/inferhub/client";
import {
  __resetStore,
  getFreshModels,
  getStaleModels,
  metaFor,
  setModels,
} from "../../src/console/inferhub/store";
import type { ModelMarket } from "../../src/console/inferhub/types";

// ── Derivations ────────────────────────────────────────────────────────────

describe("tier grouping", () => {
  test("three identical asks collapse into one tier with avail 3", () => {
    const tiers = groupTiers([3, 3, 3], 10);
    expect(tiers).toEqual([{ price: 3, avail: 3, discountPct: 70 }]);
  });

  test("tiers are sorted ascending by price", () => {
    const tiers = groupTiers([5, 2, 9, 2], 10);
    expect(tiers.map((tier) => tier.price)).toEqual([2, 5, 9]);
    expect(tiers[0]?.avail).toBe(2);
  });

  test("an empty asks array yields no tiers — the No Provider case", () => {
    // The model stays listed but has zero live providers, so it is never routed to.
    expect(groupTiers([], 10)).toEqual([]);
  });

  test("float noise does not split one price into two tiers", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; bucketing to 6 decimals
    // keeps one advertised price as one tier.
    const tiers = groupTiers([0.30000000000000004, 0.1 + 0.2], 1);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.avail).toBe(2);
  });
});

describe("discount math", () => {
  test("computes the percentage below the official price", () => {
    expect(discountPct(3, 10)).toBe(70);
    expect(discountPct(7.5, 10)).toBe(25);
  });

  test("rounds to one decimal", () => {
    expect(discountPct(1, 3)).toBe(66.7);
  });

  test("is null when the official price is missing or zero", () => {
    // A discount against an unknown baseline is unknown; dividing by zero here
    // would advertise the model as infinitely cheap.
    expect(discountPct(3, null)).toBeNull();
    expect(discountPct(3, 0)).toBeNull();
  });
});

describe("alias normalization", () => {
  test("folds dots to dashes and lowercases", () => {
    expect(aliasKeyOf("cb/claude-opus-4.6")).toBe("claude-opus-4-6");
    expect(aliasKeyOf("cc/claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  test("unifies the same model across two prefixes", () => {
    expect(aliasKeyOf("cb/claude-opus-4.6")).toBe(aliasKeyOf("cc/claude-opus-4-6"));
  });

  test("applies the known manual alias", () => {
    expect(aliasKeyOf("kc/kimi-k2-7")).toBe("kimi-k2-7-code");
  });

  test("strips a Kiro label", () => {
    expect(aliasKeyOf("kiro/claude-opus-4-6 (Kiro)")).toBe("claude-opus-4-6");
  });

  test("tolerates a bare model id", () => {
    expect(aliasKeyOf("glm-5.3")).toBe("glm-5-3");
  });
});

describe("id splitting", () => {
  test("keeps the prefix and never strips it", () => {
    expect(splitId("cc/claude-opus-5-5")).toEqual({ prefix: "cc", modelId: "claude-opus-5-5" });
  });
});

// ── Null handling ──────────────────────────────────────────────────────────

function model(overrides: Partial<ModelMarket> = {}): ModelMarket {
  return {
    id: "cc/claude-opus-5-5",
    prefix: "cc",
    family: "Claude Code",
    modelId: "claude-opus-5-5",
    aliasKey: "claude-opus-5-5",
    officialIn: 15,
    officialOut: 75,
    tiersIn: [{ price: 3, avail: 2, discountPct: 80 }],
    tiersOut: [{ price: 15, avail: 2, discountPct: 80 }],
    minAskIn: 3,
    minAskOut: 15,
    maxAskIn: 3,
    maxAskOut: 15,
    capacityPriceIn: null,
    capacityPriceOut: null,
    providersLive: 2,
    lastRate: null,
    cacheHitRate: null,
    health: { successRatePct: null, avgTtftMs: null, avgTps: null, familyState: null },
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      modalities: ["text"],
      outputModality: "text",
      reasoningLevels: [],
      supportsCache: true,
    },
    systemPromptNote: null,
    routable: true,
    ...overrides,
  };
}

describe("null handling", () => {
  test("per-model health is keyed by id, not slug", () => {
    // `/api/status` returns `id` (`ag/claude-opus-4-6-thinking`), not `slug`.
    // Reading `slug` matched nothing and every model reported a null success
    // rate, which the UI shows as "unknown" and sorts last.
    const merged = mergeModelHealth([model({ id: "ag/claude-opus-4-6-thinking" })], [
      { id: "ag/claude-opus-4-6-thinking", successRatePct: 100, avgTtftMs: 4198, avgTps: 27.2 },
    ]);
    expect(merged[0]?.health.successRatePct).toBe(100);
    expect(merged[0]?.health.avgTtftMs).toBe(4198);
    expect(merged[0]?.health.avgTps).toBe(27.2);
  });

  test("slug is still honoured as a fallback", () => {
    const merged = mergeModelHealth([model({ id: "cc/claude-opus-5-5" })], [
      { slug: "cc/claude-opus-5-5", successRatePct: 97.5 },
    ]);
    expect(merged[0]?.health.successRatePct).toBe(97.5);
  });

  test("a model absent from status keeps a null rate", () => {
    // Unverified, not failing.
    const merged = mergeModelHealth([model()], [{ id: "other/model", successRatePct: 100 }]);
    expect(merged[0]?.health.successRatePct).toBeNull();
  });

  test("a null lastRate stays null, never zero", () => {
    const merged = mergeMarketPrices([model()], [{ slug: "cc/claude-opus-5-5", lastRate: null }]);
    expect(merged[0]?.lastRate).toBeNull();
  });

  test("a null success rate stays null and stays routable", () => {
    // Null is unknown, not bad: a quiet model must not be treated as an outage.
    const merged = mergeModelHealth([model()], [{ slug: "cc/claude-opus-5-5", successRatePct: null }]);
    expect(merged[0]?.health.successRatePct).toBeNull();
    const applied = applyFamilyHealth(merged, [{ prefix: "cc", state: "operational" }], 80);
    expect(applied[0]?.routable).toBe(true);
  });

  test("a reported success rate below the threshold makes it unroutable", () => {
    const merged = mergeModelHealth([model()], [{ slug: "cc/claude-opus-5-5", successRatePct: 50 }]);
    const applied = applyFamilyHealth(merged, [{ prefix: "cc", state: "operational" }], 80);
    expect(applied[0]?.routable).toBe(false);
  });

  test("a major outage family makes it unroutable", () => {
    const applied = applyFamilyHealth([model()], [{ prefix: "cc", state: "major_outage" }], 80);
    expect(applied[0]?.routable).toBe(false);
  });

  test("zero live providers makes it unroutable", () => {
    // The "No Provider" case: listed, but never routed to.
    const applied = applyFamilyHealth(
      [model({ providersLive: 0, tiersIn: [], tiersOut: [], minAskIn: null, minAskOut: null })],
      [{ prefix: "cc", state: "operational" }],
      80,
    );
    expect(applied[0]?.routable).toBe(false);
    expect(applied[0]?.providersLive).toBe(0);
  });
});

describe("capacity weighting", () => {
  test("prefers the cheapest tier with enough providers behind it", () => {
    // The cheapest tier is often a single provider, so a sustainable price is
    // exposed alongside the minimum rather than assuming the min is capacity.
    const tiers = [
      { price: 1, avail: 1, discountPct: 90 },
      { price: 3, avail: 5, discountPct: 70 },
    ];
    expect(capacityWeightedPrice(tiers, 2)).toBe(3);
  });

  test("falls back to the cheapest tier when none meets the bar", () => {
    const tiers = [{ price: 1, avail: 1, discountPct: 90 }];
    expect(capacityWeightedPrice(tiers, 2)).toBe(1);
  });

  test("returns null when there are no tiers", () => {
    expect(capacityWeightedPrice([], 2)).toBeNull();
  });
});

describe("catalog normalization", () => {
  test("reads decimal-string prices and groups tiers", () => {
    // The catalog carries money as decimal strings, unlike `/market`.
    // `[price, providerCount]` tuples: one entry per distinct price.
    const normalized = normalizeCatalogModel(
      {
        id: "eac4da12-04f0-4314-bb80-4e43bcacb322",
        upstreamModelId: "claude-opus-5-5",
        officialIn: "15",
        officialOut: "75",
        pricePointsIn: [[3, 2], [5, 1]],
        pricePointsOut: [[15, 2]],
      },
      { prefix: "cc", label: "Claude Code", systemPromptNote: null },
    );
    // The UUID is never the route id; the slug is.
    expect(normalized?.id).toBe("cc/claude-opus-5-5");
    expect(normalized?.modelId).toBe("claude-opus-5-5");
    expect(normalized?.officialIn).toBe(15);
    expect(normalized?.tiersIn).toEqual([
      { price: 3, avail: 2, discountPct: 80 },
      { price: 5, avail: 1, discountPct: 66.7 },
    ]);
    expect(normalized?.providersLive).toBe(2);
  });

  test("returns null for a row with no slug — a UUID cannot be requested", () => {
    // `id` is a UUID; only `upstreamModelId` is routable. Emitting a UUID would
    // put a phantom in the catalog.
    expect(normalizeCatalogModel({ id: "eac4da12-04f0-4314-bb80-4e43bcacb322" }, { prefix: "cc" })).toBeNull();
  });

  test("returns null when the upstream has no prefix", () => {
    expect(normalizeCatalogModel({ upstreamModelId: "claude-opus-5-5" }, {})).toBeNull();
  });

  test("empty price points mean zero live providers", () => {
    const normalized = normalizeCatalogModel(
      { upstreamModelId: "glm-5.3", officialIn: "1", officialOut: "4", pricePointsIn: [], pricePointsOut: [] },
      { prefix: "zai", label: "Z.AI", systemPromptNote: null },
    );
    expect(normalized?.providersLive).toBe(0);
    expect(normalized?.tiersIn).toEqual([]);
    expect(normalized?.minAskIn).toBeNull();
  });

  test("malformed price tuples are dropped, not defaulted", () => {
    // A tier with an unknown provider count would make `providersLive` wrong,
    // which is worse than an absent tier.
    const normalized = normalizeCatalogModel(
      { upstreamModelId: "m", officialIn: "10", officialOut: "10", pricePointsIn: [["3"], [5, 2], null, "x"], pricePointsOut: [[10, 2]] },
      { prefix: "cc", label: "Claude Code", systemPromptNote: null },
    );
    expect(normalized?.tiersIn).toEqual([{ price: 5, avail: 2, discountPct: 50 }]);
  });
});

// ── Store: on demand, never background ─────────────────────────────────────

describe("snapshot store", () => {
  test("serves a fresh snapshot and misses an old one without fetching", () => {
    __resetStore();
    const now = 1_000_000;
    setModels([model()], now);
    expect(getFreshModels(now + 1_000)).toHaveLength(1);
    // Past the 60 s window: a miss. No fetch happens here — the caller decides.
    expect(getFreshModels(now + 120_000)).toBeUndefined();
  });

  test("a miss keeps the last snapshot readable as stale", () => {
    __resetStore();
    const now = 1_000_000;
    setModels([model()], now);
    expect(getFreshModels(now + 120_000)).toBeUndefined();
    expect(getStaleModels()?.value).toHaveLength(1);
    expect(metaFor(now, "market", now + 120_000).stale).toBe(true);
    expect(metaFor(now, "market", now + 120_000).ageSeconds).toBe(120);
  });

  test("with no snapshot at all, meta reports stale rather than a fake zero", () => {
    __resetStore();
    expect(metaFor(undefined, "market", 1_000).stale).toBe(true);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe("management rate limit", () => {
  test("caps at 20 calls per minute and skips the rest", async () => {
    __resetRateLimit(0);
    let issued = 0;
    const fetchFn = (async () => {
      issued += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    for (let i = 0; i < 25; i++) await fetchMarket({ fetchFn, now: () => 0 });
    // 20 issued, 5 skipped by the bucket — never a burst, never queued.
    expect(issued).toBe(20);
  });

  test("refills after the window", async () => {
    __resetRateLimit(0);
    const fetchFn = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    for (let i = 0; i < 20; i++) await fetchMarket({ fetchFn, now: () => 0 });
    const before = await fetchMarket({ fetchFn, now: () => 0 });
    const after = await fetchMarket({ fetchFn, now: () => 60_001 });
    expect(before).toBeUndefined();
    expect(after).toEqual({});
  });

  test("a 429 is not retried past the bound", async () => {
    __resetRateLimit(0);
    let attempts = 0;
    const fetchFn = (async () => {
      attempts += 1;
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch;
    await fetchMarket({ fetchFn, now: () => 0 });
    // One attempt: no `Retry-After` means no second try.
    expect(attempts).toBe(1);
  });

  test("a non-2xx yields undefined rather than a partial object", async () => {
    __resetRateLimit(0);
    const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchMarket({ fetchFn, now: () => 0 })).toBeUndefined();
  });
});

describe("response parsing", () => {
  test("extracts an object array from a keyed envelope", () => {
    expect(objectArray({ models: [{ a: 1 }, "x", null] }, "models")).toEqual([{ a: 1 }]);
  });

  test("yields empty for a missing or non-array field", () => {
    expect(objectArray({}, "models")).toEqual([]);
    expect(objectArray({ models: "nope" }, "models")).toEqual([]);
  });

  test("the management base is the documented host", () => {
    expect(INFERHUB_API_BASE).toBe("https://inferhub.dev/api");
  });
});
