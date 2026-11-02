/**
 * Cross-provider isolation of the shared session-cache factory.
 *
 * Kiro and Trae both estimate prompt-cache hits from their own request
 * history. The shared module uses a factory so each integration keeps its own
 * private session Map: a session id seen by one provider must never be
 * visible to the other.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { estimateKiroSessionCache, resetKiroSessionCacheForTesting } from "../../src/providers/integrations/kiro/kiro-cache";
import { estimateTraeSessionCache, resetTraeSessionCacheForTesting } from "../../src/providers/integrations/trae/trae-cache";
import type { CanonicalMessage, UsageRecord } from "../../src/protocol/canonical-model";

const user = (text: string): CanonicalMessage => ({
  role: "user",
  content: [{ kind: "text", text }],
});

function record(inputTokens: number, cached: number | "unavailable" = "unavailable"): UsageRecord {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cached,
    cache_write_tokens: "unavailable",
    uncached_input_tokens: inputTokens,
    output_tokens: 10,
    reasoning_tokens: "unavailable",
    estimated_cost: null,
  };
}

beforeEach(() => {
  resetKiroSessionCacheForTesting();
  resetTraeSessionCacheForTesting();
});

describe("session-cache cross-provider isolation", () => {
  test("trae traffic on a session is invisible to the kiro estimator", () => {
    const messages = [user("halo")];
    // Record the exact request through the Trae cache on session "s1".
    estimateTraeSessionCache(record(100), "s1", messages);
    // The Kiro cache has never seen "s1": the same request must NOT be
    // flagged cached; it is remembered on Kiro's own map instead.
    const r = estimateKiroSessionCache(record(120), "s1", messages);
    expect(r.cached_input_tokens).toBe("unavailable");
    expect(r.uncached_input_tokens).toBe(120);
  });

  test("the reverse direction stays isolated too", () => {
    const messages = [user("dari-kiro")];
    estimateKiroSessionCache(record(50), "s1", messages);
    const r = estimateTraeSessionCache(record(70), "s1", messages);
    expect(r.cached_input_tokens).toBe("unavailable");
    expect(r.uncached_input_tokens).toBe(70);
  });
});
