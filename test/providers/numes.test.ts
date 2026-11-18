// test/providers/numes.test.ts — Numes catalog, discovery, and quota tests.

import { describe, expect, test } from "bun:test";
import {
  NUMES_DEFAULT_MODELS,
  NUMES_SPEC,
  discoverNumesModels,
} from "../../src/providers/integrations/numes/provider";
import { fetchNumesQuota } from "../../src/providers/integrations/numes/numes-quota";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

const FREE_IDS = [
  "dealignai/deepseek-v4.1-flash-uncensored-fp8:free",
  "dealignai/glm-5.3-flash-uncensored-fp8:free",
  "dealignai/glm-5.3-uncensored-fp8:free",
  "deepseek/deepseek-v4.1-flash:free",
  "moonshotai/kimi-k3.1-pro:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "uniboshi/kimi-k3-abliterated-v1:free",
  "z-ai/glm-5.3-flash:free",
  "z-ai/glm-5.3:free",
];

describe("Numes catalog", () => {
  test("spec targets the chat wire on the versioned base", () => {
    expect(NUMES_SPEC.provider_id).toBe("numes");
    expect(NUMES_SPEC.endpoint_paths_by_wire_family?.chat).toBe("/chat/completions");
  });

  test("the static roster is exactly the nine live-verified :free rows", () => {
    const ids = NUMES_DEFAULT_MODELS.map((m) => m.modelId).sort();
    expect(ids).toEqual([...FREE_IDS].sort());
  });

  test("free rows bill zero and carry the freeTier marker", () => {
    for (const model of NUMES_DEFAULT_MODELS) {
      expect(model.modelId.endsWith(":free")).toBe(true);
      expect(model.freeTier).toBe(true);
      // cost is only set when freeTier is asserted; the provider's
      // defineModel resolves it from the `free` flag at definition time.
      if (model.cost !== undefined) {
        expect(model.cost.input).toBe(0);
        expect(model.cost.output).toBe(0);
        expect(model.cost.pricing_model).toBe("pay-per-use");
      }
      expect(model.endpointPath).toBe("/chat/completions");
      expect(model.wireFamily).toBe("chat");
      expect(model.toolCall).toBe(true);
      expect(model.reasoning).toBe(true);
      expect(model.reasoningEfforts?.length).toBeGreaterThan(0);
    }
  });

  test("vision and context windows match the upstream listing", () => {
    const byId = new Map(NUMES_DEFAULT_MODELS.map((m) => [m.modelId, m]));
    const hasImage = (id: string) =>
      byId.get(id)?.modalities.input.includes("image") === true;
    // glm-5.3 (non-flash) and deepseek flash are the text-only free rows;
    // glm-5.3 is also the only one below the 1M window.
    expect(hasImage("z-ai/glm-5.3:free")).toBe(false);
    expect(byId.get("z-ai/glm-5.3:free")?.contextLimit).toBe(262_144);
    expect(hasImage("deepseek/deepseek-v4.1-flash:free")).toBe(false);
    expect(hasImage("moonshotai/kimi-k3.1-pro:free")).toBe(true);
    expect(byId.get("z-ai/glm-5.3-flash:free")?.contextLimit).toBe(1_048_576);
    expect(byId.get("z-ai/glm-5.3-flash:free")?.outputLimit).toBe(65_536);
  });
});

describe("discoverNumesModels", () => {
  function fetcher(payload: unknown, status = 200) {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("maps the rich upstream shape: limits, vision, efforts, tools, :free", async () => {
    const models = await discoverNumesModels({
      baseUrl: "https://api.numes.ai/api/v1",
      credential: "sk-test",
      fetcher: fetcher({
        data: [
          {
            id: "deepseek/deepseek-v4.1-flash:free",
            context_length: 1048576,
            max_input_tokens: 917504,
            maximum_output_length: 65536,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
              modality: "text->text",
            },
            reasoning: { supported_efforts: ["none", "low", "medium", "high", "max"] },
            supported_parameters: ["tools", "temperature"],
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "acme/paid-model",
            context_length: 131072,
            top_provider: { max_completion_tokens: 8192 },
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              modality: "text+image->text",
            },
            reasoning: { supported_efforts: ["low", "high"] },
            supported_parameters: ["tools"],
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
    });
    expect(models).not.toBeNull();
    const byId = new Map(models!.map((m) => [m.modelId, m]));

    const free = byId.get("deepseek/deepseek-v4.1-flash:free");
    expect(free?.freeTier).toBe(true);
    expect(free?.contextLimit).toBe(1_048_576);
    expect(free?.outputLimit).toBe(65_536);
    expect(free?.reasoningEfforts).toEqual(["none", "low", "medium", "high", "max"]);
    expect(free?.toolCall).toBe(true);

    const paid = byId.get("acme/paid-model");
    expect(paid?.freeTier).not.toBe(true);
    expect(paid?.contextLimit).toBe(131_072);
    // No `maximum_output_length` on this row — falls back to
    // `top_provider.max_completion_tokens`.
    expect(paid?.outputLimit).toBe(8_192);
    expect(paid?.modalities.input).toContain("image");
    expect(paid?.reasoningEfforts).toEqual(["low", "high"]);
  });

  test("roster rows win over the listing so :free flags survive", async () => {
    const models = await discoverNumesModels({
      baseUrl: "https://api.numes.ai/api/v1",
      fetcher: fetcher({
        data: [
          {
            id: "z-ai/glm-5.3-flash:free",
            context_length: 1,
            maximum_output_length: 1,
          },
        ],
      }),
    });
    const row = models!.find((m) => m.modelId === "z-ai/glm-5.3-flash:free");
    // The roster row (1M ctx, real efforts) is kept, not the degenerate
    // listing row.
    expect(row?.contextLimit).toBe(1_048_576);
    expect(row?.reasoningEfforts).toEqual(["low", "high", "max"]);
  });

  test("returns null on upstream failure so the roster fallback engages", async () => {
    const models = await discoverNumesModels({
      baseUrl: "https://api.numes.ai/api/v1",
      fetcher: fetcher({}, 500),
    });
    expect(models).toBeNull();
  });
});

describe("fetchNumesQuota", () => {
  function keyFetcher(payload: unknown, status = 200): FetchLike {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-content": "application/json" },
      })) as unknown as FetchLike;
  }

  test("reads usage counters and the spend cap", async () => {
    const result = await fetchNumesQuota(
      "sk-test",
      keyFetcher({
        data: {
          hash: "abc",
          label: "sk-numes-v1-redacted-example",
          billing_currency: "USD",
          disabled: false,
          limit: 10,
          limit_remaining: 7.5,
          limit_reset: "2026-12-01T00:00:00Z",
          usage: 2.5,
          usage_daily: 0.5,
          usage_weekly: 1.5,
          usage_monthly: 2.5,
        },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.source).toBe("numes");
    expect(result.plan).toBe("USD");
    expect(result.accountLabel).toBe("sk-numes-v1-redacted-example");
    const limit = result.windows.find((w) => w.kind === "key_spend_limit");
    expect(limit?.accounting).toBe("pooled");
    expect(limit?.used).toBeCloseTo(2.5);
    expect(limit?.limit).toBe(10);
    expect(limit?.usedPercent).toBeCloseTo(25);
    expect(limit?.resetsAt).toBe("2026-12-01T00:00:00Z");
    const daily = result.windows.find((w) => w.kind === "usage_daily");
    expect(daily?.used).toBe(0.5);
    expect(daily?.limit).toBeNull();
  });

  test("a disabled key invalidates the credential", async () => {
    const result = await fetchNumesQuota("sk-test", keyFetcher({ data: { disabled: true } }));
    expect(result.authInvalidated).toBe(true);
    expect(result.error).not.toBeNull();
  });

  test("upstream failure returns an unreadable result, never throws", async () => {
    const result = await fetchNumesQuota("sk-test", keyFetcher({}, 500));
    expect(result.error).not.toBeNull();
    expect(result.windows).toEqual([]);
  });
});