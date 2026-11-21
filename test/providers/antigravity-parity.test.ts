/**
 * Antigravity parity items 10 and 6 from
 * the provider comparison research ("Antigravity" →
 * "Missing (prioritized)"), plus the envelope and wire-mapping guards.
 *
 * All are unit-level and offline: no network, no database, no real
 * credential. Env reads are exercised by setting `process.env` directly and
 * restoring it afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  antigravityTierSuffix,
  antigravityThinkingBudget,
  antigravityWireModelId,
  collapseAntigravityVariant,
  getAntigravityModelWireProfile,
  getAntigravityUserAgent,
  flattenAntigravitySchema,
  normalizeAntigravityToolSchema,
  normalizeAntigravityToolSchemas,
} from "../../src/providers/integrations/antigravity/antigravity-protocol";
import { buildAntigravityEnvelope } from "../../src/providers/integrations/antigravity/antigravity";
import {
  ANTIGRAVITY_FREE_TIER_MODEL_IDS,
  ANTIGRAVITY_MODELS,
} from "../../src/providers/integrations/antigravity/antigravity-models";
import { buildGeminiPayload } from "../../src/protocol/request/gemini";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

// ─── 10. Env-overridable UA os/arch/cl ─────────────────────────────────────

const UA_ENV_KEYS = [
  "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE",
  "CARTETHYIA_ANTIGRAVITY_UA_ARCH",
  "CARTETHYIA_ANTIGRAVITY_UA_CL",
] as const;

function withEnv<T>(values: Readonly<Record<string, string | undefined>>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("10. Antigravity UA fingerprint is env-overridable", () => {
  afterEach(() => {
    for (const key of UA_ENV_KEYS) delete process.env[key];
  });

  test("defaults to the captured desktop fingerprint", () => {
    const ua = withEnv({ "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE": undefined }, () =>
      getAntigravityUserAgent(),
    );
    expect(ua).toContain("os_type=darwin");
    expect(ua).toContain("arch=arm64");
    expect(ua).toContain("cl=963137146");
    expect(ua.startsWith("antigravity/hub/")).toBe(true);
    expect(ua).toContain("(aidev_client; ");
  });

  test("each field is overridable independently", () => {
    const ua = withEnv(
      {
        "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE": "linux",
        "CARTETHYIA_ANTIGRAVITY_UA_ARCH": "x64",
        "CARTETHYIA_ANTIGRAVITY_UA_CL": "424242",
      },
      () => getAntigravityUserAgent(),
    );
    expect(ua).toContain("os_type=linux");
    expect(ua).toContain("arch=x64");
    expect(ua).toContain("cl=424242");
    // Untouched fields keep their defaults.
    expect(ua.startsWith("antigravity/hub/")).toBe(true);
  });

  test("an empty value falls back to the default", () => {
    const ua = withEnv({ "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE": "   " }, () =>
      getAntigravityUserAgent(),
    );
    expect(ua).toContain("os_type=darwin");
  });

  test("a value that cannot appear in a UA field is rejected, not forwarded", () => {
    // Anything outside `[A-Za-z0-9._-]` — including a UA delimiter — would let
    // one env var corrupt the whole header, so it must not reach the wire.
    const ua = withEnv(
      {
        "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE": "darwin); injected",
        "CARTETHYIA_ANTIGRAVITY_UA_ARCH": "arm64; cl=evil",
        "CARTETHYIA_ANTIGRAVITY_UA_CL": "1 2 3",
      },
      () => getAntigravityUserAgent(),
    );
    expect(ua).toContain("os_type=darwin");
    expect(ua).toContain("arch=arm64");
    expect(ua).toContain("cl=963137146");
    expect(ua).not.toContain("injected");
    expect(ua).not.toContain("evil");
  });

  test("overrides are read per call, not cached at import", () => {
    const before = withEnv({ "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE": "linux" }, () =>
      getAntigravityUserAgent(),
    );
    const after = withEnv({ "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE": "win32" }, () =>
      getAntigravityUserAgent(),
    );
    expect(before).toContain("os_type=linux");
    expect(after).toContain("os_type=win32");
  });
});

// ─── 6. parametersJsonSchema → parameters normalization ────────────────────

describe("6. parametersJsonSchema normalization", () => {
  test("adopts a schema nested under parametersJsonSchema", () => {
    const schema = {
      type: "object",
      name: "outer",
      parametersJsonSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    };
    expect(normalizeAntigravityToolSchema(schema)).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
  });

  test("adopts a schema nested under parameters", () => {
    const schema = { name: "outer", parameters: { type: "object", properties: { n: { type: "number" } } } };
    expect(normalizeAntigravityToolSchema(schema)).toEqual({
      type: "object",
      properties: { n: { type: "number" } },
    });
  });

  test("leaves a bare object schema untouched and returns the same reference", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    expect(normalizeAntigravityToolSchema(schema)).toBe(schema);
  });

  test("does not replace a real schema with a non-object nested value", () => {
    // A stray scalar under `parameters` must not win over declared properties.
    const schema = { type: "object", properties: { q: { type: "string" } }, parameters: 42 };
    expect(normalizeAntigravityToolSchema(schema)).toBe(schema);
  });

  test("passes non-records through unchanged", () => {
    expect(normalizeAntigravityToolSchema(undefined)).toBeUndefined();
    expect(normalizeAntigravityToolSchema(null)).toBeNull();
    expect(normalizeAntigravityToolSchema("nope")).toBe("nope");
  });

  test("request-level helper rewrites only the tools that need it", () => {
    const wrapped = {
      name: "wrapped",
      description: "d",
      jsonSchema: {
        type: "object",
        parametersJsonSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    };
    const plain = { name: "plain", jsonSchema: { type: "object", properties: { p: { type: "number" } } } };
    const request = { tools: [wrapped, plain] } as unknown as CanonicalRequest;

    const normalized = normalizeAntigravityToolSchemas(request);
    expect(normalized).not.toBe(request);
    expect(normalized.tools?.[0]).not.toBe(wrapped);
    // The untouched tool is shared by reference, not copied.
    expect(normalized.tools?.[1]).toBe(plain);
    expect(normalized.tools?.[0]?.jsonSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  test("request-level helper returns the original object when nothing changes", () => {
    const request = { tools: [{ name: "t", jsonSchema: { type: "object" } }] } as unknown as CanonicalRequest;
    expect(normalizeAntigravityToolSchemas(request)).toBe(request);
    expect(normalizeAntigravityToolSchemas({} as unknown as CanonicalRequest)).toBeDefined();
  });

  test("normalized tools survive the shared Gemini builder with properties intact", () => {
    // The regression this guards: buildGeminiPayload's schema allowlist has no
    // `parametersJsonSchema` key, so an un-normalized declaration ships as
    // `{"type":"object"}` and the tool is unusable upstream.
    const request = {
      model: "gemini-3-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      stream: false,
      generation_controls: {},
      source_surface: "chat",
      tools: [
        {
          name: "search",
          description: "Search the web",
          jsonSchema: {
            type: "object",
            name: "search",
            parametersJsonSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "integer" } },
              required: ["query"],
            },
          },
        },
      ],
    } as unknown as CanonicalRequest;

    const before = buildGeminiPayload(request)["tools"] as unknown;
    const after = buildGeminiPayload(normalizeAntigravityToolSchemas(request))["tools"] as unknown;

    const declarations = (value: unknown): Record<string, unknown> | undefined =>
      (value as Array<{ functionDeclarations?: Array<Record<string, unknown>> }>)?.[0]
        ?.functionDeclarations?.[0];

    // Without normalization every property is lost.
    expect(declarations(before)?.["parameters"]).toEqual({ type: "object" });
    // With normalization the real schema reaches the wire.
    expect(declarations(after)?.["parameters"]).toEqual({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    });
  });

  test("flattenAntigravitySchema removes anyOf/oneOf and multi-type unions", () => {
    // The Antigravity Claude-route upstream validates tool schemas as strict
    // JSON Schema draft 2020-12 and refuses every `anyOf` / `oneOf` /
    // multi-type `type: [...]` — verified live 2026-11-05 (a client's `task`
    // tool: `tools.7.custom.input_schema: JSON schema is invalid`).
    const schema = {
      type: "object",
      properties: {
        model: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        tags: { type: ["string", "null"] },
        nested: {
          type: "object",
          properties: { n: { oneOf: [{ type: "number" }, { type: "string" }] } },
        },
      },
      required: ["model"],
    };
    expect(flattenAntigravitySchema(schema)).toEqual({
      type: "object",
      properties: {
        model: { type: "string" },
        tags: { type: "string" },
        nested: {
          type: "object",
          properties: { n: { type: "number" } },
        },
      },
      required: ["model"],
    });
  });

  test("flattenAntigravitySchema leaves a plain schema untouched (same serialization)", () => {
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    expect(flattenAntigravitySchema(schema)).toEqual(schema);
  });

  test("normalizeAntigravityToolSchemas flattens anyOf on the wire", () => {
    const request = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      stream: false,
      generation_controls: {},
      source_surface: "chat",
      tools: [
        {
          name: "task",
          description: "task",
          jsonSchema: {
            type: "object",
            properties: {
              model: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
            },
          },
        },
      ],
    } as unknown as CanonicalRequest;

    const after = buildGeminiPayload(normalizeAntigravityToolSchemas(request))["tools"] as unknown;
    const declaration = (after as Array<{ functionDeclarations?: Array<Record<string, unknown>> }>)?.[0]
      ?.functionDeclarations?.[0];
    expect(declaration?.["parameters"]).toEqual({
      type: "object",
      properties: { model: { type: "string" } },
    });
  });

  test("web_search tool maps to Gemini's native googleSearch hosted tool", () => {
    // Gemini grounds Google search through a *hosted* tool declaration
    // (`{ googleSearch: {} }`), not a function declaration — sending the
    // gateway's `web_search` tool as a function is why upstream answered with
    // no grounding chunks (2026-11-04).
    const request = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      stream: false,
      generation_controls: {},
      source_surface: "chat",
      tools: [{ name: "web_search", tool_type: "web_search", jsonSchema: {} }],
    } as unknown as CanonicalRequest;

    const tools = buildGeminiPayload(request)["tools"] as unknown;
    expect(tools).toEqual([{ googleSearch: {} }]);
  });

  test("googleSearch named tool also maps to the native hosted declaration", () => {
    const request = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      stream: false,
      generation_controls: {},
      source_surface: "chat",
      tools: [{ name: "googleSearch", jsonSchema: {} }],
    } as unknown as CanonicalRequest;

    const tools = buildGeminiPayload(request)["tools"] as unknown;
    expect(tools).toEqual([{ googleSearch: {} }]);
  });
});

// ─── 7. The envelope actually applies the normalization ────────────────────

describe("7. tool schemas survive the envelope", () => {
  // The unit tests above pin `normalizeAntigravityToolSchema`, and every one of
  // them passed while the helper was dead code: `buildAntigravityEnvelope`
  // called `buildGeminiPayload` on the raw request, whose sanitizer has no
  // `parametersJsonSchema` entry and dropped both the wrapper and the schema
  // inside it. The declared tool shipped as `{"type":"object"}` and arrived
  // unusable — every property gone. These assert the *dispatch* path, which is
  // where that showed up and which nothing else covered.
  const ccaTool = {
    name: "read_file",
    description: "Reads a file",
    jsonSchema: {
      parametersJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  };

  const envelopeFor = (tools: readonly unknown[]): Record<string, unknown> =>
    buildAntigravityEnvelope(
      {
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        tools,
        generation_controls: {},
        reasoning: {},
      } as unknown as CanonicalRequest,
      undefined,
      "gemini-2.5-flash",
      "gemini-2.5-flash",
      {},
      "seed",
    );

  const firstDeclaration = (envelope: Record<string, unknown>): Record<string, unknown> => {
    const inner = envelope["request"] as Record<string, unknown>;
    const toolGroups = inner["tools"] as Record<string, unknown>[];
    return (toolGroups[0]!["functionDeclarations"] as Record<string, unknown>[])[0]!;
  };

  test("a parametersJsonSchema declaration ships its real schema", () => {
    const declaration = firstDeclaration(envelopeFor([ccaTool]));
    expect(declaration["parameters"]).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("an already-bare schema is not rewritten", () => {
    const bare = {
      name: "write_file",
      description: "Writes",
      jsonSchema: { type: "object", properties: { path: { type: "string" } } },
    };
    expect(firstDeclaration(envelopeFor([bare]))["parameters"]).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });
});

describe("Antigravity wire model mapping & variant collapse", () => {
  test("resolves logical model ids to upstream wire deployments", () => {
    // Defaults follow the agy 1.5.12 roster reference: the Gemini 4 family
    // opens at effort medium, Neon at high.
    expect(antigravityWireModelId("gemini-4-argon")).toBe("gemini-4-argon-medium");
    expect(antigravityWireModelId("gemini-4-carbon")).toBe("gemini-4-carbon-medium");
    expect(antigravityWireModelId("gemini-4-hydrogen")).toBe("gemini-4-hydrogen-medium");
    expect(antigravityWireModelId("gemini-4-neon")).toBe("gemini-4-neon-high");
    expect(antigravityWireModelId("gemini-3.8-flash")).toBe("gemini-3.8-flash-low");
    expect(antigravityWireModelId("claude-opus-4-6")).toBe("claude-opus-4-6-thinking");
    expect(antigravityWireModelId("gemini-3.1-pro")).toBe("gemini-pro-agent");
    expect(antigravityWireModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    // Sonar is a standalone deployment id, not an effort tier: it has no
    // default tier and must pass through untouched.
    expect(antigravityWireModelId("gemini-4-hydrogen-sonar")).toBe("gemini-4-hydrogen-sonar");
    // Claude 5.5 bare ids are 404 upstream; they resolve to a live tier.
    expect(antigravityWireModelId("claude-opus-5-5")).toBe("claude-opus-5-5-high");
    expect(antigravityWireModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5-5-high");
    // Tier rows are already deployment ids and pass through untouched.
    expect(antigravityWireModelId("gemini-4-carbon-high")).toBe("gemini-4-carbon-high");
    expect(antigravityWireModelId("claude-opus-5-5-low")).toBe("claude-opus-5-5-low");
  });

  test("collapses effort variants back to logical catalog model ids", () => {
    expect(collapseAntigravityVariant("gemini-4-argon-low")).toBe("gemini-4-argon");
    expect(collapseAntigravityVariant("gemini-4-argon-medium")).toBe("gemini-4-argon");
    expect(collapseAntigravityVariant("gemini-4-argon-high")).toBe("gemini-4-argon");
    expect(collapseAntigravityVariant("gemini-4-hydrogen-medium")).toBe("gemini-4-hydrogen");
    expect(collapseAntigravityVariant("gemini-4-hydrogen-high")).toBe("gemini-4-hydrogen");
    expect(collapseAntigravityVariant("gemini-3.8-flash-low")).toBe("gemini-3.8-flash");
    expect(collapseAntigravityVariant("gemini-pro-agent")).toBe("gemini-3.1-pro");
  });
});

describe("Antigravity effort-tier vocabulary (single owner)", () => {
  test("tier suffixes resolve longest-match first", () => {
    expect(antigravityTierSuffix("gemini-3.8-flash-extra-low")).toBe("extra-low");
    expect(antigravityTierSuffix("gemini-3.8-flash-low")).toBe("low");
    expect(antigravityTierSuffix("gemini-4-argon-medium")).toBe("medium");
    expect(antigravityTierSuffix("gemini-4-argon-high")).toBe("high");
    expect(antigravityTierSuffix("gemini-3.8-flash-tiered")).toBe("tiered");
    expect(antigravityTierSuffix("gemini-3.8-flash")).toBeUndefined();
  });

  test("thinking budget follows the tier table for thinking-capable SKUs", () => {
    // Claude routes always think; tiered ids take the tier budget.
    expect(antigravityThinkingBudget("claude-sonnet-4-6")).toBe(10_000);
    expect(antigravityThinkingBudget("claude-opus-4-6-thinking")).toBe(10_000);
    // Gemini 3+ and the gemini-4 family (argon/carbon) are thinking-capable;
    // the `-low`/`-medium`/`-high` deployments get that tier's budget.
    expect(antigravityThinkingBudget("gemini-4-argon-low")).toBe(1_000);
    expect(antigravityThinkingBudget("gemini-4-argon-medium")).toBe(4_000);
    expect(antigravityThinkingBudget("gemini-4-argon-high")).toBe(10_000);
    expect(antigravityThinkingBudget("gemini-4-hydrogen-medium")).toBe(4_000);
    expect(antigravityThinkingBudget("gemini-4-carbon-low")).toBe(1_000);
    expect(antigravityThinkingBudget("gemini-3.8-flash-medium")).toBe(4_000);
    // A bare thinking-capable id falls back to the client's default budget.
    expect(antigravityThinkingBudget("gemini-3.8-flash")).toBe(10_000);
    expect(antigravityThinkingBudget("gemini-4-argon")).toBe(10_000);
    expect(antigravityThinkingBudget("gemini-3.1-pro")).toBe(10_001);
    // Earlier Gemini SKUs and GPT-OSS send no thinkingConfig.
    expect(antigravityThinkingBudget("gemini-2.5-flash")).toBeUndefined();
    expect(antigravityThinkingBudget("gemini-2.5-flash-thinking")).toBeUndefined();
    expect(antigravityThinkingBudget("gpt-oss-120b-medium")).toBeUndefined();
    expect(antigravityThinkingBudget("tab_flash_lite_preview")).toBeUndefined();
  });

  test("the default tier table is what wireModelId and collapseVariant share", () => {
    // Every DEFAULT_TIER entry must round-trip: logical → wire → logical.
    for (const [logical, tier] of [
      ["gemini-3.6-flash", "low"],
      ["gemini-3.7-flash", "low"],
      ["gemini-3.8-flash", "low"],
      ["gemini-4-argon", "medium"],
      ["gemini-4-carbon", "medium"],
      ["gemini-4-hydrogen", "medium"],
      ["gemini-4-neon", "high"],
      ["gpt-oss-120b", "medium"],
      ["claude-opus-5-5", "high"],
      ["claude-sonnet-5-5", "high"],
    ] as const) {
      const wire = antigravityWireModelId(logical);
      expect(wire).toBe(`${logical}-${tier}`);
      expect(collapseAntigravityVariant(wire)).toBe(logical);
    }
  });
});

describe("Antigravity catalog free-tier marking", () => {
  test("only rows published on the probed free-tier account are marked free", () => {
    // Source of truth is the 2026-11-21 `fetchAvailableModels` probe: 18 wire
    // deployments collapsed to the ids in ANTIGRAVITY_FREE_TIER_MODEL_IDS.
    // Other static rows are discoverable but were not published on that free
    // plan, so they must NOT be grouped as free or priced at zero.
    expect(ANTIGRAVITY_MODELS.length).toBeGreaterThan(0);
    for (const model of ANTIGRAVITY_MODELS) {
      if (ANTIGRAVITY_FREE_TIER_MODEL_IDS.has(model.modelId)) {
        expect(model.freeTier).toBe(true);
        expect(model.cost.input).toBe(0);
        expect(model.cost.output).toBe(0);
      } else {
        expect(model.freeTier).toBeUndefined();
      }
    }
    // Guard against an empty allowlist silently unflagging everything.
    expect(ANTIGRAVITY_FREE_TIER_MODEL_IDS.size).toBeGreaterThan(0);
  });

  test("gemini-4-hydrogen-sonar is catalogued at live-measured limits", () => {
    // Verified live 2026-11-21: direct chat answers
    // `modelVersion: gemini-4-hydrogen-sonar`; published limits are 1,048,576
    // in / 65,536 out. Earlier Hydrogen tiers publish 262,144 out.
    const sonar = ANTIGRAVITY_MODELS.find((m) => m.modelId === "gemini-4-hydrogen-sonar");
    expect(sonar).toBeDefined();
    expect(sonar?.contextLimit).toBe(1_048_576);
    expect(sonar?.outputLimit).toBe(65_536);
  });
});

describe("Antigravity wire profiles published by live discovery", () => {
  test("Claude 5.5 tiers carry their live model enums and 128000 cap", () => {
    // `fetchAvailableModels` on 2026-11-21 publishes these enums and a
    // 128,000-token output ceiling per tier. Bare ids are 404 upstream, so
    // only the tier deployments have wire profiles.
    for (const [wire, modelEnum] of [
      ["claude-opus-5-5-low", "MODEL_PLACEHOLDER_M400"],
      ["claude-opus-5-5-medium", "MODEL_PLACEHOLDER_M401"],
      ["claude-opus-5-5-high", "MODEL_PLACEHOLDER_M402"],
      ["claude-sonnet-5-5-low", "MODEL_PLACEHOLDER_M403"],
      ["claude-sonnet-5-5-medium", "MODEL_PLACEHOLDER_M404"],
      ["claude-sonnet-5-5-high", "MODEL_PLACEHOLDER_M405"],
    ] as const) {
      expect(getAntigravityModelWireProfile(wire)?.modelEnum).toBe(modelEnum);
      expect(getAntigravityModelWireProfile(wire)?.maxOutputTokens).toBe(128000);
    }
  });

  test("tab_jump preview has its live enum and 4096 cap", () => {
    expect(getAntigravityModelWireProfile("tab_jump_flash_lite_preview")?.modelEnum).toBe(
      "MODEL_PLACEHOLDER_M28",
    );
    expect(getAntigravityModelWireProfile("tab_jump_flash_lite_preview")?.maxOutputTokens).toBe(4096);
  });
});
