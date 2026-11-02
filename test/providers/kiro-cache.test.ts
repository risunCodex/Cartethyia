/**
 * Kiro session-cache estimation.
 *
 * Kiro's runtime EventStream never reports prompt-cache hits (only
 * `contextUsageEvent` and `meteringEvent`); the estimator bridges that gap from
 * our own history, exactly as the Trae adapter does. A byte-identical repeat
 * in the same session is flagged fully cached; a continuation whose prefix
 * equals a previous full request flags just that prefix.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  estimateKiroSessionCache,
  resetKiroSessionCacheForTesting,
} from "../../src/providers/integrations/kiro/kiro-cache";
import type { CanonicalMessage, UsageRecord } from "../../src/protocol/canonical-model";

const user = (text: string): CanonicalMessage => ({
  role: "user",
  content: [{ kind: "text", text }],
});

const assistant = (text: string): CanonicalMessage => ({
  role: "assistant",
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
});

describe("estimateKiroSessionCache", () => {
  test("a first request in a session is never flagged cached", () => {
    const r = estimateKiroSessionCache(record(100), "ses-1", [user("halo")]);
    expect(r.cached_input_tokens).toBe("unavailable");
    expect(r.uncached_input_tokens).toBe(100);
  });

  test("an identical second request is flagged fully cached", () => {
    const messages = [user("halo"), assistant("hai"), user("lanjut")];
    estimateKiroSessionCache(record(100), "ses-1", messages);
    const r = estimateKiroSessionCache(record(120), "ses-1", messages);
    expect(r.cached_input_tokens).toBe(120);
    expect(r.uncached_input_tokens).toBe(0);
  });

  test("a continuation whose prefix equals the previous full request flags the prefix only", () => {
    const first = [user("halo"), assistant("hai")];
    estimateKiroSessionCache(record(80), "ses-1", first);
    const next = [...first, user("lanjut")];
    const r = estimateKiroSessionCache(record(120), "ses-1", next);
    expect(r.cached_input_tokens).toBe(80);
    expect(r.uncached_input_tokens).toBe(40);
  });

  test("a real multi-turn conversation flags the stable prefix", () => {
    // turn 1: [user]            → input 45
    // turn 2: [user, assistant, user] → prefix [user] is cached (45)
    estimateKiroSessionCache(record(45), "ses-1", [user("halo")]);
    const turn2 = [user("halo"), assistant("hai"), user("lanjut")];
    const r = estimateKiroSessionCache(record(66), "ses-1", turn2);
    expect(r.cached_input_tokens).toBe(45);
    expect(r.uncached_input_tokens).toBe(21);
  });

  test("a different session never sees another session's history", () => {
    estimateKiroSessionCache(record(80), "ses-1", [user("halo")]);
    const r = estimateKiroSessionCache(record(90), "ses-2", [user("halo")]);
    expect(r.cached_input_tokens).toBe("unavailable");
    expect(r.uncached_input_tokens).toBe(90);
  });

  test("a real upstream cache report is trusted and left untouched", () => {
    const messages = [user("halo"), assistant("hai"), user("lanjut")];
    estimateKiroSessionCache(record(100), "ses-1", messages);
    const r = estimateKiroSessionCache(record(120, 50), "ses-1", messages);
    expect(r.cached_input_tokens).toBe(50);
    expect(r.uncached_input_tokens).toBe(120);
  });

  test("no session id means no estimation", () => {
    const r = estimateKiroSessionCache(record(100), undefined, [user("halo")]);
    expect(r.cached_input_tokens).toBe("unavailable");
  });
});
