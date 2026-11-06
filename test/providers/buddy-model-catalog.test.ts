/**
 * The buddy roster is one shared list, so a model that belongs on both sites is
 * published on both or on neither.
 *
 * `cb` and `workbuddy` serve the same model set and read `BUDDY_SHARED_RAW`
 * directly, mapping it with their own endpoint path. A row added to one and not
 * the other cannot happen through this list — which is the point of asserting
 * on the *rendered* catalogs rather than on the raw table: the raw list would
 * pass while a provider's image/video filter silently dropped the row.
 */
import { describe, expect, test } from "bun:test";
import { CODEBUDDY_MODELS } from "../../src/providers/integrations/buddy/codebuddy/provider";
import { WORKBUDDY_MODELS } from "../../src/providers/integrations/buddy/workbuddy/provider";
import { WORKBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/workbuddy/cn-provider";
import type { ModelDefinition } from "../../src/providers/provider-model-definition";
import { CODEBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/codebuddy/cn-provider";

function luna(rows: readonly ModelDefinition[]) {
  return rows.find((row) => row.modelId === "gpt-6-luna");
}

describe("live Buddy CLI models on the shared roster", () => {
  test("publishes GPT-6 Astra on both international catalogs", () => {
    // It is in the live CLI roster of /v3/config, so omitting it made a
    // servable model invisible. Asserted with the limits upstream declares
    // rather than merely asserted present, so a silent limit drift fails here.
    for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
      const row = rows.find((model) => model.modelId === "gpt-6-astra");
      expect(row).toBeDefined();
      expect(row?.contextLimit).toBe(1_000_000);
      expect(row?.outputLimit).toBe(128_000);
      expect(row?.reasoning).toBe(true);
      expect(row?.toolCall).toBe(true);
    }
  });

  test("omits DeepSeek V4 Pro from both international catalogs", () => {
    for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
      expect(rows.some((model) => model.modelId === "deepseek-v4-pro")).toBe(false);
    }
  });

  test("publishes upstream CLI ids with their captured metadata on both sites", () => {
    const capturedRows = [
      ["gemini-3.8-flash", 1_000_000, 65_536, true],
      ["gpt-6-sol", 1_000_000, 128_000, true],
      ["step-5-preview", 1_000_000, 64_000, true],
    ] as const;

    for (const [modelId, contextLimit, outputLimit, reasoning] of capturedRows) {
      for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
        const row = rows.find((model) => model.modelId === modelId);
        expect(row).toBeDefined();
        expect(row?.contextLimit).toBe(contextLimit);
        expect(row?.outputLimit).toBe(outputLimit);
        expect(row?.reasoning).toBe(reasoning);
        expect(row?.toolCall).toBe(true);
        expect(row?.modalities.input).toContain("image");
      }
    }
  });

  test("publishes the named tiers, keeps default-model server-selected, omits kimi-k3.1", () => {
    // `fast-model`, `balanced-model` and `primary-model` are first-class rows in
    // the live CLI roster with published limits, so they belong in the catalog.
    // `default-model` is different: it is the id `auto` is rewritten onto at
    // dispatch (`BUDDY_AUTO_TARGET`), so publishing it would offer a client an
    // id it never needs to send. `kimi-k3.1` is not in the roster at all.
    for (const id of ["fast-model", "balanced-model", "primary-model"]) {
      for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
        expect(rows.some((model) => model.modelId === id)).toBe(true);
      }
    }
    for (const id of ["default-model", "kimi-k3.1"]) {
      for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
        expect(rows.some((model) => model.modelId === id)).toBe(false);
      }
    }
  });

  test("hy4-preview renamed to hy4 on both international catalogs", () => {
    for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
      expect(rows.some((model) => model.modelId === "hy4")).toBe(true);
      expect(rows.some((model) => model.modelId === "hy4-preview")).toBe(false);
      expect(rows.some((model) => model.modelId === "hy4-preview-f")).toBe(false);
    }
  });

  test("hy4free mirrors hy4 metadata on both international catalogs", () => {
    for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
      const free = rows.find((model) => model.modelId === "hy4free");
      const paid = rows.find((model) => model.modelId === "hy4");
      expect(free).toBeDefined();
      expect(paid).toBeDefined();
      expect(free?.contextLimit).toBe(paid?.contextLimit);
      expect(free?.outputLimit).toBe(paid?.outputLimit);
      expect(free?.reasoning).toBe(true);
      expect(free?.toolCall).toBe(true);
      expect(free?.modalities.input).toContain("image");
    }
  });
});

describe("Buddy image generation routes", () => {
  test("CodeBuddy uses native image generation while WorkBuddy keeps its chat route", () => {
    const codebuddy = CODEBUDDY_MODELS.find((model) => model.modelId === "gemini-3.1-flash-image");
    const workbuddy = WORKBUDDY_MODELS.find((model) => model.modelId === "gemini-3.1-flash-image");
    expect(codebuddy?.serviceKind).toBe("imageGeneration");
    expect(codebuddy?.endpointPath).toBe("/images/generations");
    expect(workbuddy?.serviceKind).toBe("imageGeneration");
    expect(workbuddy?.endpointPath).toBe("/v2/chat/completions");
  });
});

describe("gpt-6-luna on the buddy roster", () => {
  test("cb publishes it at the shared context window", () => {
    const row = luna(CODEBUDDY_MODELS);
    expect(row).toBeDefined();
    // 1,000,000 is what /v3/config publishes for `gpt-6-luna` (and for every
    // gpt-6 sibling). It was recorded as 1,050,000, a number no endpoint
    // reports; asserting the sibling as the source of truth would have kept
    // that error self-consistent instead of catching it.
    expect(row?.contextLimit).toBe(1_000_000);
    expect(row?.outputLimit).toBe(128_000);
  });

  test("workbuddy publishes the same row at its own endpoint path", () => {
    const row = luna(WORKBUDDY_MODELS);
    expect(row).toBeDefined();
    // Same model, different URL: WorkBuddy's base carries no version segment,
    // so it needs the explicit `/v2` prefix. Asserting the path is what stops
    // the shared-list refactor from pointing workbuddy at cb's path.
    expect(row?.endpointPath).toBe("/v2/chat/completions");
    expect(luna(CODEBUDDY_MODELS)?.endpointPath).toBe("/chat/completions");
  });

  test("both sites carry identical limits for it", () => {
    // The shared list is only shared if the limits it yields are. A per-provider
    // override that changed one number would be invisible from either side.
    const cb = luna(CODEBUDDY_MODELS);
    const wb = luna(WORKBUDDY_MODELS);
    expect(wb?.contextLimit).toBe(cb?.contextLimit);
    expect(wb?.outputLimit).toBe(cb?.outputLimit);
    expect(wb?.reasoning).toBe(cb?.reasoning);
    expect(wb?.modalities.input).toEqual(cb?.modalities.input);
  });

  test("it is a reasoning, tool-calling, vision row", () => {
    // `toolCall: false` here silently strips `tools` during capability
    // preflight, so the model would look unable to call tools at all.
    const row = luna(CODEBUDDY_MODELS);
    expect(row?.reasoning).toBe(true);
    expect(row?.toolCall).toBe(true);
    expect(row?.modalities.input).toContain("image");
  });

  test("CodeBuddy CN stays separate from the international-only gpt-6-luna row", () => {
    expect(luna(CODEBUDDY_CN_MODELS)).toBeUndefined();
  });

  test("CodeBuddy CN publishes the live CLI roster and drops the legacy fallback rows", () => {
    // `uto` was here only because the reference's CN fallback table carried it;
    // the CN /v3/config roster does not publish it. The legacy block is gone, so
    // the CN catalog is exactly what upstream serves — chat rows plus the image
    // and video generation rows.
    const rows = [
      ["space-bunny", 1_000_000, 128_000],
      ["step-5-preview", 1_000_000, 64_000],
      ["kimi-k3-1", 1_000_000, 32_000],
      ["minimax-m2.7", 200_000, 48_000],
    ] as const;
    for (const [modelId, contextLimit, outputLimit] of rows) {
      const row = CODEBUDDY_CN_MODELS.find((model) => model.modelId === modelId);
      expect(row).toBeDefined();
      expect(row?.contextLimit).toBe(contextLimit);
      expect(row?.outputLimit).toBe(outputLimit);
    }
    // The rename: hy4-preview became hy4.
    expect(CODEBUDDY_CN_MODELS.some((model) => model.modelId === "hy4")).toBe(true);
    // hy4free mirrors hy4 on the CN roster (960k/64k).
    const cnHy4 = CODEBUDDY_CN_MODELS.find((model) => model.modelId === "hy4");
    const cnHy4Free = CODEBUDDY_CN_MODELS.find((model) => model.modelId === "hy4free");
    expect(cnHy4Free).toBeDefined();
    expect(cnHy4Free?.contextLimit).toBe(cnHy4?.contextLimit);
    expect(cnHy4Free?.outputLimit).toBe(cnHy4?.outputLimit);
    for (const removed of ["uto", "hy4-preview-x", "hy4-preview", "hunyuan-chat", "glm-4.6", "default"]) {
      expect(CODEBUDDY_CN_MODELS.some((model) => model.modelId === removed)).toBe(false);
    }
    // Generation rows are published but not chat models: kept as generation.
    for (const imageId of ["hunyuan-image-alpha", "hunyuan-image-alpha-edit"]) {
      expect(
        CODEBUDDY_CN_MODELS.find((model) => model.modelId === imageId)?.serviceKind,
      ).toBe("imageGeneration");
    }
    for (const videoId of ["kling-video-v3", "minimax-video-h3"]) {
      expect(
        CODEBUDDY_CN_MODELS.find((model) => model.modelId === videoId)?.serviceKind,
      ).toBe("videoGeneration");
    }
  });

  test("WorkBuddy CN uses exactly the CodeBuddy CN catalog with its own endpoint", () => {
    expect(WORKBUDDY_CN_MODELS.map((model) => model.modelId)).toEqual(
      CODEBUDDY_CN_MODELS.map((model) => model.modelId),
    );
    for (let index = 0; index < CODEBUDDY_CN_MODELS.length; index += 1) {
      const codebuddyCn = CODEBUDDY_CN_MODELS[index];
      const workbuddyCn = WORKBUDDY_CN_MODELS[index];
      expect(workbuddyCn).toBeDefined();
      // Chat and image rows use WorkBuddy's chat route; video rows use its
      // own native video route on the `/v2` base.
      const expectedEndpoint = codebuddyCn?.serviceKind === "videoGeneration"
        ? "/v2/videos/generations"
        : "/v2/chat/completions";
      expect(workbuddyCn?.endpointPath).toBe(expectedEndpoint);
      expect(workbuddyCn?.contextLimit).toBe(codebuddyCn?.contextLimit);
      expect(workbuddyCn?.outputLimit).toBe(codebuddyCn?.outputLimit);
      expect(workbuddyCn?.modalities).toEqual(codebuddyCn?.modalities);
      expect(workbuddyCn?.reasoning).toBe(codebuddyCn?.reasoning);
      expect(workbuddyCn?.toolCall).toBe(codebuddyCn?.toolCall);
    }
  });
});

describe("measured context windows", () => {
  test("hy3 is published at the measured 192k window on both international sites", () => {
    for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
      const row = rows.find((model) => model.modelId === "hy3");
      expect(row?.contextLimit).toBe(192_000);
      expect(row?.outputLimit).toBe(64_000);
    }
  });

  test("kimi-k2.8-preview is published at each realm's measured context", () => {
    // The two realms genuinely differ and always did: intl publishes
    // 1,048,576/65,536 while CN publishes 1,000,000/64,000. Asserting one pair
    // across all three catalogs only passed because CN's row was a copy of the
    // intl numbers, so it encoded the bug rather than the fact.
    for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
      const row = rows.find((model) => model.modelId === "kimi-k2.8-preview");
      expect(row?.contextLimit).toBe(1_048_576);
      expect(row?.outputLimit).toBe(65_536);
    }
    const cn = CODEBUDDY_CN_MODELS.find((model) => model.modelId === "kimi-k2.8-preview");
    expect(cn?.contextLimit).toBe(1_000_000);
    expect(cn?.outputLimit).toBe(64_000);
  });
});