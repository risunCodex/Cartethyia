/**
 * Runcrate provider tests: catalog rows (the free-allowance roster), spec
 * shape, live `/v1/models` discovery mapping, and the billing-balance quota
 * collector.
 */
import { describe, expect, test } from "bun:test";
import {
  RUNCRATE_DEFAULT_MODELS,
  RUNCRATE_SPEC,
  discoverRuncrateModels,
} from "../../src/providers/integrations/runcrate/provider";
import { fetchRuncrateQuota } from "../../src/providers/integrations/runcrate/runcrate-quota";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

const FREE_IDS = [
  "Qwen/Qwen3.8-Flash",
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "openai/gpt-oss-120b",
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.3-Flash",
];

describe("Runcrate catalog", () => {
  test("spec carries chat and Anthropic Messages on the versioned base", () => {
    expect(RUNCRATE_SPEC.provider_id).toBe("runcrate");
    expect(RUNCRATE_SPEC.endpoint_paths_by_wire_family?.chat).toBe("/chat/completions");
    expect(RUNCRATE_SPEC.endpoint_paths_by_wire_family?.messages).toBe("/messages");
  });

  test("the static roster is exactly the five live free-allowance rows", () => {
    const ids = RUNCRATE_DEFAULT_MODELS.map((m) => m.modelId).sort();
    expect(ids).toEqual([...FREE_IDS].sort());
  });

  test("free rows bill zero and carry the freeTier marker", () => {
    for (const model of RUNCRATE_DEFAULT_MODELS) {
      expect(model.freeTier).toBe(true);
      expect(model.cost.input).toBe(0);
      expect(model.cost.output).toBe(0);
      expect(model.cost.pricing_model).toBe("pay-per-use");
      expect(model.endpointPath).toBe("/chat/completions");
      expect(model.wireFamily).toBe("chat");
      expect(model.toolCall).toBe(true);
      expect(model.reasoning).toBe(true);
    }
  });

  test("windows and vision match the upstream listing", () => {
    const byId = new Map(RUNCRATE_DEFAULT_MODELS.map((m) => [m.modelId, m]));
    const hasImage = (id: string) =>
      byId.get(id)?.modalities.input.includes("image") === true;
    expect(byId.get("deepseek-ai/DeepSeek-V4.1-Flash")?.contextLimit).toBe(1_048_576);
    expect(hasImage("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(true);
    expect(hasImage("zai-org/GLM-5.3-Flash")).toBe(true);
    expect(hasImage("zai-org/GLM-5.3")).toBe(false);
    expect(byId.get("openai/gpt-oss-120b")?.contextLimit).toBe(131_072);
    expect(byId.get("openai/gpt-oss-120b")?.outputLimit).toBe(117_964);
  });
});

describe("discoverRuncrateModels", () => {
  function fetcher(payload: unknown, status = 200) {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("maps the upstream shape: windows, vision, tools, reasoning", async () => {
    const models = await discoverRuncrateModels({
      baseUrl: "https://api.runcrate.ai/v1",
      credential: "rc_test",
      fetcher: fetcher({
        data: [
          {
            id: "deepseek-ai/DeepSeek-V4.1-Flash",
            context_length: 1048576,
            max_output_length: 1048576,
            input_modalities: ["text", "image"],
            supported_features: ["tools", "reasoning"],
          },
          {
            id: "somebody/paid-model",
            context_length: 131072,
            max_output_length: 65536,
            input_modalities: ["text"],
            supported_features: ["tools"],
            pricing: { prompt: "0.0000005", completion: "0.000001" },
          },
        ],
      }),
    });
    expect(models).not.toBeNull();
    const byId = new Map(models!.map((m) => [m.modelId, m]));

    const free = byId.get("deepseek-ai/DeepSeek-V4.1-Flash");
    // Roster precedence: the free flags survive discovery.
    expect(free?.freeTier).toBe(true);
    expect(free?.modalities.input).toContain("image");

    const paid = byId.get("somebody/paid-model");
    expect(paid?.freeTier).not.toBe(true);
    expect(paid?.contextLimit).toBe(131_072);
    expect(paid?.outputLimit).toBe(65_536);
    expect(paid?.toolCall).toBe(true);
    expect(paid?.reasoning).toBe(false);
    expect(paid?.modalities.input).not.toContain("image");
  });

  test("returns null on upstream failure so the roster fallback engages", async () => {
    const models = await discoverRuncrateModels({
      baseUrl: "https://api.runcrate.ai/v1",
      fetcher: fetcher({}, 500),
    });
    expect(models).toBeNull();
  });
});

describe("fetchRuncrateQuota", () => {
  function balanceFetcher(payload: unknown, status = 200): FetchLike {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchLike;
  }

  test("reads the workspace balance as pooled credit with remaining", async () => {
    const result = await fetchRuncrateQuota(
      "rc_test",
      balanceFetcher({
        data: {
          creditsBalance: 12.5,
          activeUsageCost: 1.25,
          floating_balance_usd: 11.25,
          burn_usd_per_hour: 0.04,
          runway_hours: 312.5,
        },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.source).toBe("runcrate");
    const credit = result.windows.find((w) => w.kind === "credit_balance");
    expect(credit?.accounting).toBe("pooled");
    expect(credit?.remaining).toBe(12.5);
    expect(credit?.limit).toBeNull();
    expect(credit?.usedPercent).toBeNull();
  });

  test("upstream failure returns an unreadable result, never throws", async () => {
    const result = await fetchRuncrateQuota("rc_test", balanceFetcher({}, 500));
    expect(result.error).not.toBeNull();
    expect(result.windows).toEqual([]);
  });
});
