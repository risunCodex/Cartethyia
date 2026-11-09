/**
 * `resolveGrokTurnIndex` pins the per-session monotonic advance and the
 * bounded LRU eviction of the remembered-session store (M-29 consolidation
 * onto `TtlCache`).
 */
import { describe, expect, test } from "bun:test";
import { resolveGrokTurnIndex } from "../../src/providers/integrations/grok/grok-turn-index";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function requestWithUserTurns(count: number): CanonicalRequest {
  const messages = Array.from({ length: count }, () => ({ role: "user", content: "hi" }));
  return { model: "m", messages } as unknown as CanonicalRequest;
}

describe("resolveGrokTurnIndex", () => {
  test("advances per session and never goes backwards", () => {
    expect(resolveGrokTurnIndex("sess-1", requestWithUserTurns(1))).toBe(1);
    // Same session, delta-style client reporting 1 again: advance past the
    // remembered index.
    expect(resolveGrokTurnIndex("sess-1", requestWithUserTurns(1))).toBe(2);
    expect(resolveGrokTurnIndex("sess-1", requestWithUserTurns(1))).toBe(3);
    // A full-history client reporting 5 dominates the remembered index.
    expect(resolveGrokTurnIndex("sess-1", requestWithUserTurns(5))).toBe(5);
    // A different session starts fresh.
    expect(resolveGrokTurnIndex("sess-2", requestWithUserTurns(1))).toBe(1);
  });

  test("a user turn count of zero is floored at 1", () => {
    expect(resolveGrokTurnIndex("sess-3", requestWithUserTurns(0))).toBe(1);
  });

  test("without a session id the payload count is returned as-is", () => {
    expect(resolveGrokTurnIndex(undefined, requestWithUserTurns(4))).toBe(4);
    expect(resolveGrokTurnIndex("", requestWithUserTurns(2))).toBe(2);
  });

  test("replays the remembered turn for the same request key", () => {
    const request = requestWithUserTurns(1);
    const key = {};
    expect(resolveGrokTurnIndex("sess-4", request, key)).toBe(1);
    expect(resolveGrokTurnIndex("sess-4", request, key)).toBe(1);
  });
});
