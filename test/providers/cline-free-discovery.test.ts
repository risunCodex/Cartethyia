/**
 * The free tier is one catalog behind three providers, and the auto-fetch must
 * not import paid models into it.
 *
 * Both properties were wrong before this file existed:
 *
 *   (a) `recommendedModels` set `free: !subscription`, so every row in Cline's
 *       `recommended` bucket — `anthropic/claude-sonnet-5.5`, `openai/gpt-6-astra`
 *       and friends — was marked free. That is not cosmetic: `defineModel`
 *       prices a `free` row at zero, so the cost surface reported paid models as
 *       free. The upstream settles it: dispatching `anthropic/claude-sonnet-5.5`
 *       answers 402 `insufficient_credits`, while a `free` bucket id answers 200.
 *
 *   (b) Cline's free tier was read from `/ai/cline/recommended-models` alone,
 *       whose `free` bucket files four ids, all spelled `cline-free/…`.
 *       `/models` publishes seventeen ids carrying a `:free` suffix — including
 *       `minimax/minimax-m3.1-flash:free` — and the two rosters do not
 *       intersect at all. Minimax was therefore invisible to auto-fetch.
 *
 * The rosters below are the live listings as observed, trimmed to the ids each
 * assertion turns on. No network: every fetch is injected.
 */
import { describe, expect, test } from "bun:test";
import {
  CLINE_MODELS,
  fetchClineFreeModelIds,
  fetchClineRecommendedModels,
} from "../../src/providers/integrations/cline/cline";
import { KILO_MODELS, KILO_FREE_MODELS } from "../../src/providers/integrations/kilo/kilo";
import { OPENROUTER_MODELS, OPENROUTER_FREE_MODELS } from "../../src/providers/integrations/openrouter/provider";

/** A billed row from Cline's `recommended` bucket. */
const BILLED = "anthropic/claude-sonnet-5.5";
/** A row from the `free` bucket. */
const FREE_BUCKET = "cline-free/mimo-v2.6-flash";
/** A free row only `/models` names. */
const MODELS_ONLY_FREE = "minimax/minimax-m3.1-flash:free";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Routes the three endpoints the discovery touches, so one injected fetcher
 * serves a whole run.
 */
function fetcher(): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/ai/cline/recommended-models")) {
      return jsonResponse({
        recommended: [{ id: BILLED, name: "Sonnet" }],
        free: [{ id: FREE_BUCKET, name: "Mimo" }],
        clinePass: [{ id: "cline-pass/kimi-k3", name: "Kimi" }],
        clineCloud: [],
      });
    }
    if (url.endsWith("/ai/cline/models")) {
      return jsonResponse({ data: [] });
    }
    if (url.endsWith("/models")) {
      return jsonResponse({
        object: "list",
        data: [
          { id: MODELS_ONLY_FREE, object: "model" },
          { id: "cohere/north-mini-code:free", object: "model" },
          // Billed ids must not be admitted by the free listing.
          { id: "anthropic/claude-sonnet-5.5", object: "model" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function discover(pass: boolean) {
  return (await fetchClineRecommendedModels(undefined, pass, fetcher())) ?? [];
}

describe("cline auto-fetch: free means free", () => {
  test("a billed recommended row is not marked free", async () => {
    const models = await discover(false);
    const billed = models.find((m) => m.modelId === BILLED);
    expect(billed).toBeDefined();
    // The defect was `free: !subscription`, which priced this row at zero. A
    // billed row must keep its real price, and must not claim the free tier.
    expect(billed?.cost).not.toEqual({ input: 0, output: 0, pricing_model: "pay-per-use" });
    expect(billed?.freeTier).toBe(false);
  });

  test("a free bucket row is marked free", async () => {
    const models = await discover(false);
    const free = models.find((m) => m.modelId === FREE_BUCKET);
    expect(free?.cost).toEqual({ input: 0, output: 0, pricing_model: "pay-per-use" });
  });

  test("a free row only /models names is discovered", async () => {
    // Minimax was invisible while discovery read the recommended roster alone.
    const models = await discover(false);
    expect(models.some((m) => m.modelId === MODELS_ONLY_FREE)).toBe(true);
  });

  test("a billed id is never admitted by the free listing", async () => {
    const ids = await fetchClineFreeModelIds(fetcher());
    expect(ids).not.toBeNull();
    expect(ids?.every((id) => id.endsWith(":free"))).toBe(true);
    expect(ids).not.toContain(BILLED);
  });
});

describe("the shared free roster", () => {
  test("kilo and openrouter agree; cline seeds its own probed roster", () => {
    const cline = CLINE_MODELS.filter((m) => m.freeTier === true).map((m) => m.modelId).sort();
    const kilo = KILO_FREE_MODELS.filter((m) => m.freeTier === true).map((m) => m.modelId).sort();
    const openrouter = OPENROUTER_FREE_MODELS.filter((m) => m.freeTier === true)
      .map((m) => m.modelId)
      .sort();
    // Compared against each other, never against a pinned count. The roster is
    // a catalog fact that upstream changes — two rows were dropped as junk, and
    // nine more had already been withdrawn — so any number written here goes
    // stale on the next catalog change and fails for the wrong reason.
    expect(kilo.length).toBeGreaterThan(0);
    expect(openrouter).toEqual(kilo);

    // Cline seeds its own roster, probed from its account's `free` bucket. It
    // is OpenRouter-backed, and most ids are Cline's own spellings
    // (`cline-free/…`, `…-free`) that the shared roster does not carry — but
    // the two now genuinely overlap where both serve the same upstream row
    // (`baidu/ernie-5.5-flash-preview:free` is in both, so the old "sharing
    // none" premise is no longer true). The point that survives: Cline is not
    // a mirror of kilo — it carries free ids the shared roster does not.
    expect(cline.length).toBeGreaterThan(0);
    expect(cline.some((id) => !kilo.includes(id))).toBe(true);
  });

  test("cline's pass roster is marked pro-only and its free rows are not", () => {
    // A pass row dispatched without a subscription 401s, so it must say so on
    // the card. Asserted as a property of the id namespace rather than a count,
    // because the subscription roster is what upstream changes most often.
    for (const row of CLINE_MODELS) {
      if (row.modelId.startsWith("cline-pass/")) {
        expect(row.proOnly).toBe(true);
        expect(row.freeTier).toBeUndefined();
      } else if (row.freeTier === true) {
        expect(row.proOnly).toBeUndefined();
      }
    }
    expect(CLINE_MODELS.some((row) => row.modelId.startsWith("cline-pass/"))).toBe(true);
    expect(CLINE_MODELS.some((row) => row.freeTier === true)).toBe(true);
  });

  test("every free row is priced at zero", () => {
    // Filtered to the free rows: Cline's catalog also carries its subscription
    // roster now, and a billed row is priced `unknown` rather than zero — which
    // is correct, since the gateway does not know what a subscription costs.
    const free = [...CLINE_MODELS, ...KILO_FREE_MODELS, ...OPENROUTER_FREE_MODELS].filter(
      (row) => row.freeTier === true,
    );
    expect(free.length).toBeGreaterThan(0);
    for (const row of free) {
      expect(row.cost).toEqual({ input: 0, output: 0, pricing_model: "pay-per-use" });
    }
  });

  test("the billed routers are all that remains in the static catalogs", () => {
    // Everything else was a snapshot of one afternoon; discovery is the
    // authority and the free roster is the offline floor. `openrouter/auto`
    // left with the rest of the static catalog — it publishes no limits of its
    // own, so the committed row was a guess about a router's window.
    expect(KILO_MODELS.map((m) => m.modelId).sort()).toEqual([
      "kilo-auto/free",
      "kilo-auto/small",
    ]);
    // `typesafe/jev-1.13` is not a chat row — it is the System One decision
    // route, and deleting it removes a capability rather than a stale entry.
    expect(OPENROUTER_MODELS.map((m) => m.modelId).sort()).toEqual([
      "typesafe/jev-1.13",
    ]);
  });

  test("the withdrawn free rows are gone from the shared roster", () => {
    const withdrawn = [
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "thinkingmachines/inkling-2-small:free", // withdrawn by operator 2026-11-19
      "thinkingmachines/inkling-small:free",
      "thinkingmachines/inkling:free",
      "xingchen-agi/xing4.0-29b-a4b:free",
    ];
    const ids = OPENROUTER_FREE_MODELS.map((m) => m.modelId);
    for (const id of withdrawn) expect(ids).not.toContain(id);
  });

  test("deepseek v4 is gone from Cline's static seed", () => {
    expect(CLINE_MODELS.some((m) => m.modelId.includes("deepseek-v4-flash"))).toBe(false);
  });
});
