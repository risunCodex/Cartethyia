/**
 * P2-12: `ensureMaxTokensForThinking` gets real ceilings at its call sites.
 *
 * Contract under test:
 * - undefined/0/negative budgets are passthrough (no raise, no throw).
 * - A budget that does not fit raises `max_tokens` to `budget + buffer`
 *   (1024) — never a silent clamp to `maxAllowed`, because Anthropic rejects
 *   `budget_tokens >= max_tokens`.
 * - An already-sufficient `max_tokens` is left untouched.
 * - An OAuth request whose budget cannot fit under the wire's `oauthCeiling`
 *   (64k) fails fast as a typed local 400 GatewayError, instead of producing
 *   an over-ceiling `max_tokens` that 400s opaquely upstream.
 */
import { describe, expect, test } from "bun:test";
import { ensureMaxTokensForThinking } from "../../src/protocol/translation/capabilities";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { GatewayError } from "../../src/protocol/gateway-error";
import { WIRE_TOKEN_BOUNDS } from "../../src/protocol/translation/quirks";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

describe("ensureMaxTokensForThinking — budget handling", () => {
  test("undefined budget is a passthrough", () => {
    expect(ensureMaxTokensForThinking(4_096, undefined, 64_000)).toBe(4_096);
  });

  test("zero budget is a passthrough", () => {
    expect(ensureMaxTokensForThinking(4_096, 0, 64_000)).toBe(4_096);
  });

  test("negative budget is a passthrough", () => {
    expect(ensureMaxTokensForThinking(4_096, -5, 64_000)).toBe(4_096);
  });

  test("a budget that does not fit raises max_tokens (4096 → 5120)", () => {
    // budget 4096 + buffer 1024 = 5120
    expect(ensureMaxTokensForThinking(4_096, 4_096, 64_000)).toBe(5_120);
  });

  test("an already-sufficient max_tokens is untouched", () => {
    expect(ensureMaxTokensForThinking(10_000, 4_096, 64_000)).toBe(10_000);
  });

  test("an impossible budget under the OAuth ceiling throws a typed 400", () => {
    const ceiling = WIRE_TOKEN_BOUNDS["messages"]?.oauthCeiling ?? Number.MAX_SAFE_INTEGER;
    // budget 100_000 + buffer 1024 > 64_000 ceiling → local rejection, not a clamp.
    expect(() => ensureMaxTokensForThinking(64_000, 100_000, ceiling)).toThrow(GatewayError);
    try {
      ensureMaxTokensForThinking(64_000, 100_000, ceiling);
      throw new Error("expected GatewayError");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      if (error instanceof GatewayError) {
        expect(error.status).toBe(400);
      }
    }
  });
});

function thinkingRequest(budgetTokens: number): CanonicalRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
    reasoning: { thinking_type: "enabled", budget_tokens: budgetTokens },
  } as CanonicalRequest;
}

describe("encode-level: OAuth thinking budget over the wire ceiling is a local 400", () => {
  test("reasoning.budget_tokens 100_000 with OAuth rejects before upstream", () => {
    expect(() =>
      canonicalToClaudeMessagesPayload(thinkingRequest(100_000), { isOAuth: true }),
    ).toThrow(GatewayError);
    try {
      canonicalToClaudeMessagesPayload(thinkingRequest(100_000), { isOAuth: true });
      throw new Error("expected GatewayError");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      if (error instanceof GatewayError) {
        expect(error.status).toBe(400);
      }
    }
  });
});
