/**
 * Fase A quick-wins — one test file covering 6 changes:
 *
 * 1. X-Stainless-Retry-Count: 0 (claude-credentials)
 * 2. Never send context-1m on subscription credentials (claude-betas)
 * 3. Cap stop_sequences at 4 (claude.ts)
 * 4. Codex prompt_cache_retention passthrough (codex request + adapter)
 * 5. Antigravity usageLabel (antigravity-protocol)
 * 7. Adopt-on-rejection (client-version-resolver + claude)
 *
 * (Item 6 — Antigravity forced-choice restatement — was a placeholder and is
 * removed; it asserted nothing and gave false coverage credit.)
 */
import { describe, expect, test } from "bun:test";

// ─── 1. X-Stainless-Retry-Count ────────────────────────────────────────────

import { buildClaudeHeaders } from "../../src/providers/integrations/claude/claude-credentials";

describe("1. X-Stainless-Retry-Count", () => {
  test("stamps 0 on every request", () => {
    const headers = buildClaudeHeaders(undefined, undefined, {
      credential_kind: "oauth",
      sdk_version: "1.0.0",
    });
    expect(headers["X-Stainless-Retry-Count"]).toBe("0");
  });
});

// ─── 2. context-1m on subscription credentials ─────────────────────────────

import { negotiateAnthropicBetas } from "../../src/providers/integrations/claude/claude-betas";

describe("2. context-1m never sent on subscription credentials", () => {
  test("subscription credential rejects context-1m even when catalog declares it", () => {
    const result = negotiateAnthropicBetas(["context-1m-2025-08-07"], {
      credential_kind: "api_key",
      capabilities: { "context-1m-2025-08-07": true },
    });
    expect(result.accepted).not.toContain("context-1m-2025-08-07");
    expect(result.rejected.length + result.dropped.length).toBeGreaterThan(0);
  });

  test("oauth credential accepts context-1m when catalog declares it", () => {
    const result = negotiateAnthropicBetas(["context-1m-2025-08-07"], {
      credential_kind: "oauth",
      capabilities: { "context-1m-2025-08-07": true },
    });
    expect(result.accepted).toContain("context-1m-2025-08-07");
  });

  test("oauth credential rejects context-1m when catalog does not declare it", () => {
    const result = negotiateAnthropicBetas(["context-1m-2025-08-07"], {
      credential_kind: "oauth",
      capabilities: {},
    });
    expect(result.accepted).not.toContain("context-1m-2025-08-07");
  });
});

// ─── 3. Cap stop_sequences at 4 ────────────────────────────────────────────

import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function makeMinimalRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: false,
    generation_controls: {},
    source_surface: "test",
    ...overrides,
  } as CanonicalRequest;
}

describe("3. stop_sequences capped at 4", () => {
  test("passes through 4 or fewer", () => {
    const payload = canonicalToClaudeMessagesPayload(
      makeMinimalRequest({ generation_controls: { stop: ["a", "b", "c", "d"] } }),
    );
    expect(payload.stop_sequences).toEqual(["a", "b", "c", "d"]);
  });

  test("truncates to first 4 when more are provided", () => {
    const payload = canonicalToClaudeMessagesPayload(
      makeMinimalRequest({ generation_controls: { stop: ["a", "b", "c", "d", "e", "f"] } }),
    );
    expect(payload.stop_sequences).toEqual(["a", "b", "c", "d"]);
  });

  test("passes through undefined", () => {
    const payload = canonicalToClaudeMessagesPayload(makeMinimalRequest());
    expect(payload.stop_sequences).toBeUndefined();
  });
});

// ─── 4. Codex prompt_cache_retention ───────────────────────────────────────

import { canonicalToCodexResponsesPayload } from "../../src/protocol/request/codex";

describe("4. Codex prompt_cache_retention passthrough", () => {
  const baseRequest = {
    model: "gpt-5.2-codex",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    stream: false,
    generation_controls: {},
    source_surface: "test" as const,
  };

  test("emits retention when caller declares 24h", () => {
    const payload = canonicalToCodexResponsesPayload({
      ...baseRequest,
      provider_options: { codex_prompt_cache_retention: "24h" },
    } as any);
    expect(payload["prompt_cache_retention"]).toBe("24h");
  });

  test("emits retention when caller declares in_memory", () => {
    const payload = canonicalToCodexResponsesPayload({
      ...baseRequest,
      provider_options: { codex_prompt_cache_retention: "in_memory" },
    } as any);
    expect(payload["prompt_cache_retention"]).toBe("in_memory");
  });

  test("omits retention when not declared", () => {
    const payload = canonicalToCodexResponsesPayload(baseRequest as any);
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  test("omits retention for unknown values", () => {
    const payload = canonicalToCodexResponsesPayload({
      ...baseRequest,
      provider_options: { codex_prompt_cache_retention: "7d" },
    } as any);
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });
});

// ─── 5. Antigravity usageLabel ─────────────────────────────────────────────

import { getAntigravityModelWireProfile } from "../../src/providers/integrations/antigravity/antigravity-protocol";

describe("5. Antigravity usageLabel", () => {
  test("returns undefined for models without a profile entry", () => {
    expect(getAntigravityModelWireProfile("unknown-model")).toBeUndefined();
  });

  test("returns profile for known Claude wire id", () => {
    const profile = getAntigravityModelWireProfile("claude-opus-4-6-thinking");
    expect(profile).toBeDefined();
    expect(profile?.maxOutputTokens).toBe(64000);
  });

  test("returns profile for known Gemini wire id", () => {
    const profile = getAntigravityModelWireProfile("gemini-3.8-flash-medium");
    expect(profile).toBeDefined();
    expect(profile?.modelEnum).toBe("MODEL_PLACEHOLDER_M319");
    expect(profile?.maxOutputTokens).toBe(65536);
  });

  test("returns Claude modelEnum from the live roster", () => {
    const sonnet = getAntigravityModelWireProfile("claude-sonnet-4-6");
    expect(sonnet?.modelEnum).toBe("MODEL_PLACEHOLDER_M35");
    const opus = getAntigravityModelWireProfile("claude-opus-4-6-thinking");
    expect(opus?.modelEnum).toBe("MODEL_PLACEHOLDER_M26");
  });
});

// ─── 7. Adopt-on-rejection ─────────────────────────────────────────────────

import {
  adoptRequiredVersion,
  createClientVersionResolver,
} from "../../src/providers/operations/client-version-resolver";

describe("7. Adopt-on-rejection", () => {
  test("adoptRequiredVersion returns the version when error names a newer one", () => {
    const resolver = createClientVersionResolver({
      key: `test-${crypto.randomUUID()}`,
      client: "test",
      fallback: "1.0.0",
      sources: [],
    });
    const error = new Error(
      "claude_code_version_too_old: version 2.0.0 or newer is required",
    );
    const adopted = adoptRequiredVersion(
      resolver,
      () => {},
      error,
      { marker: "claude_code_version_too_old", pattern: /version (\d+\.\d+\.\d+) or newer is required/i },
    );
    expect(adopted).toBe("2.0.0");
  });

  test("adoptRequiredVersion returns null when version is not newer", () => {
    const resolver = createClientVersionResolver({
      key: `test-${crypto.randomUUID()}`,
      client: "test",
      fallback: "2.0.0",
      sources: [],
    });
    const error = new Error(
      "claude_code_version_too_old: version 1.0.0 or newer is required",
    );
    const adopted = adoptRequiredVersion(
      resolver,
      () => {},
      error,
      { marker: "claude_code_version_too_old", pattern: /version (\d+\.\d+\.\d+) or newer is required/i },
    );
    expect(adopted).toBeNull();
  });

  test("adoptRequiredVersion returns null when marker is absent", () => {
    const resolver = createClientVersionResolver({
      key: `test-${crypto.randomUUID()}`,
      client: "test",
      fallback: "1.0.0",
      sources: [],
    });
    const error = new Error("some other error");
    const adopted = adoptRequiredVersion(
      resolver,
      () => {},
      error,
      { marker: "claude_code_version_too_old", pattern: /version (\d+\.\d+\.\d+) or newer is required/i },
    );
    expect(adopted).toBeNull();
  });

  test("resolver.adopt() moves get() ahead of fallback", () => {
    const resolver = createClientVersionResolver({
      key: `test-${crypto.randomUUID()}`,
      client: "test",
      fallback: "1.0.0",
      sources: [],
    });
    expect(resolver.get()).toBe("1.0.0");
    resolver.adopt("3.0.0");
    expect(resolver.get()).toBe("3.0.0");
  });

  test("resolver.adopt() ignores versions that are not forward moves", () => {
    const resolver = createClientVersionResolver({
      key: `test-${crypto.randomUUID()}`,
      client: "test",
      fallback: "2.0.0",
      sources: [],
    });
    resolver.adopt("1.0.0");
    expect(resolver.get()).toBe("2.0.0");
  });

  test("resolver.reset() clears adopted version", () => {
    const resolver = createClientVersionResolver({
      key: `test-${crypto.randomUUID()}`,
      client: "test",
      fallback: "1.0.0",
      sources: [],
    });
    resolver.adopt("3.0.0");
    expect(resolver.get()).toBe("3.0.0");
    resolver.reset(null);
    expect(resolver.get()).toBe("1.0.0");
  });
});
