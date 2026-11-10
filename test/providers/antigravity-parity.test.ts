/**
 * Antigravity parity items 10, 4, 6 and 3 from
 * the provider comparison research ("Antigravity" →
 * "Missing (prioritized)").
 *
 * All four are unit-level and offline: no network, no database, no real
 * credential. Env reads are exercised by setting `process.env` directly and
 * restoring it afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  antigravityClaudeThinkingBeta,
  ANTIGRAVITY_CLAUDE_THINKING_BETA,
  antigravityWireModelId,
  collapseAntigravityVariant,
  getAntigravityUserAgent,
  flattenAntigravitySchema,
  normalizeAntigravityToolSchema,
  normalizeAntigravityToolSchemas,
  orderAntigravityEndpoints,
  rememberAntigravityEndpoint,
  resetAntigravityEndpointMemory,
} from "../../src/providers/integrations/antigravity/antigravity-protocol";
import { buildAntigravityEnvelope } from "../../src/providers/integrations/antigravity/antigravity";
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

// ─── 4. anthropic-beta passthrough on Claude thinking routes ───────────────

describe("4. Claude-route interleaved-thinking beta", () => {
  test("is the beta name claude-betas already declares", () => {
    // Guard against spelling drift: the owner module is the vocabulary source.
    expect(ANTIGRAVITY_CLAUDE_THINKING_BETA).toBe("interleaved-thinking-2025-05-14");
  });

  test("emitted on a Claude route with enabled thinking", () => {
    const beta = antigravityClaudeThinkingBeta(
      { reasoning: { thinking_type: "enabled", budget_tokens: 4096 } },
      true,
    );
    expect(beta).toBe("interleaved-thinking-2025-05-14");
  });

  test("emitted on a Claude route with adaptive thinking", () => {
    const beta = antigravityClaudeThinkingBeta({ reasoning: { thinking_type: "adaptive" } }, true);
    expect(beta).toBe("interleaved-thinking-2025-05-14");
  });

  test("emitted on a Claude route that only declares a budget", () => {
    const beta = antigravityClaudeThinkingBeta(
      { reasoning: { budget_tokens: 8192 } },
      true,
    );
    expect(beta).toBe("interleaved-thinking-2025-05-14");
  });

  test("omitted on a Claude route with thinking disabled", () => {
    expect(
      antigravityClaudeThinkingBeta({ reasoning: { thinking_type: "disabled" } }, true),
    ).toBeUndefined();
  });

  test("omitted on a Claude route with no reasoning at all", () => {
    expect(antigravityClaudeThinkingBeta({}, true)).toBeUndefined();
    expect(antigravityClaudeThinkingBeta({ reasoning: undefined }, true)).toBeUndefined();
  });

  test("omitted on a Gemini route even with thinking requested", () => {
    // Gemini routes must stay byte-identical: the beta is Claude-only.
    const beta = antigravityClaudeThinkingBeta(
      { reasoning: { thinking_type: "enabled", budget_tokens: 4096 } },
      false,
    );
    expect(beta).toBeUndefined();
  });

  test("omitted when reasoning carries neither type nor budget", () => {
    expect(antigravityClaudeThinkingBeta({ reasoning: { effort: "high" } }, true)).toBeUndefined();
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
    // multi-type `type: [...]` — verified live 2026-11-05 (OMP's `task`
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

// ─── 3. Last-good-endpoint stickiness ──────────────────────────────────────

const PROD = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const SANDBOX =
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse";

describe("3. Last-good-endpoint stickiness", () => {
  afterEach(() => {
    resetAntigravityEndpointMemory();
  });

  test("caller order is preserved before anything is remembered", () => {
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
  });

  test("a remembered endpoint is tried first on the next turn", () => {
    rememberAntigravityEndpoint("https://base.example.com", SANDBOX);
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])).toEqual([
      SANDBOX,
      PROD,
    ]);
  });

  test("reordering preserves every entry exactly once", () => {
    const endpoints = [PROD, "https://b.example.com/x", SANDBOX];
    rememberAntigravityEndpoint("https://base.example.com", SANDBOX);
    const ordered = orderAntigravityEndpoints("https://base.example.com", endpoints);
    expect(ordered.length).toBe(endpoints.length);
    expect([...ordered].sort()).toEqual([...endpoints].sort());
    expect(ordered[0]).toBe(SANDBOX);
  });

  test("stickiness is scoped per base URL", () => {
    rememberAntigravityEndpoint("https://base-a.example.com", SANDBOX);
    expect(orderAntigravityEndpoints("https://base-b.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
  });

  test("a remembered endpoint that is no longer offered is ignored", () => {
    rememberAntigravityEndpoint("https://base.example.com", "https://gone.example.com/x");
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
  });

  test("remembering the first endpoint is a no-op", () => {
    rememberAntigravityEndpoint("https://base.example.com", PROD);
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
  });

  test("a single endpoint list is returned untouched", () => {
    const single = [PROD];
    rememberAntigravityEndpoint("https://base.example.com", PROD);
    expect(orderAntigravityEndpoints("https://base.example.com", single)).toBe(single);
  });

  test("empty and blank endpoints are not remembered", () => {
    rememberAntigravityEndpoint("https://base.example.com", "");
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
  });

  test("reset clears one base, or every base when omitted", () => {
    rememberAntigravityEndpoint("https://base-a.example.com", SANDBOX);
    rememberAntigravityEndpoint("https://base-b.example.com", SANDBOX);
    resetAntigravityEndpointMemory("https://base-a.example.com");
    expect(orderAntigravityEndpoints("https://base-a.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
    expect(orderAntigravityEndpoints("https://base-b.example.com", [PROD, SANDBOX])).toEqual([
      SANDBOX,
      PROD,
    ]);
    resetAntigravityEndpointMemory();
    expect(orderAntigravityEndpoints("https://base-b.example.com", [PROD, SANDBOX])).toEqual([
      PROD,
      SANDBOX,
    ]);
  });

  test("later successes overwrite the earlier sticky endpoint", () => {
    rememberAntigravityEndpoint("https://base.example.com", SANDBOX);
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])[0]).toBe(
      SANDBOX,
    );
    // Production recovers: the next successful turn re-sticks to it.
    rememberAntigravityEndpoint("https://base.example.com", PROD);
    expect(orderAntigravityEndpoints("https://base.example.com", [PROD, SANDBOX])[0]).toBe(PROD);
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
      "gemini-2.5-pro",
      "gemini-2.5-pro",
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
    expect(antigravityWireModelId("gemini-4-argon")).toBe("gemini-4-argon-low");
    expect(antigravityWireModelId("gemini-3.8-flash")).toBe("gemini-3.8-flash-low");
    expect(antigravityWireModelId("claude-opus-4-6")).toBe("claude-opus-4-6-thinking");
    expect(antigravityWireModelId("gemini-3.1-pro")).toBe("gemini-pro-agent");
    expect(antigravityWireModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  test("collapses effort variants back to logical catalog model ids", () => {
    expect(collapseAntigravityVariant("gemini-4-argon-low")).toBe("gemini-4-argon");
    expect(collapseAntigravityVariant("gemini-4-argon-medium")).toBe("gemini-4-argon");
    expect(collapseAntigravityVariant("gemini-4-argon-high")).toBe("gemini-4-argon");
    expect(collapseAntigravityVariant("gemini-3.8-flash-low")).toBe("gemini-3.8-flash");
    expect(collapseAntigravityVariant("gemini-pro-agent")).toBe("gemini-3.1-pro");
  });
});
