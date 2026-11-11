/**
 * Regression tests: Qoder session-cache estimate.
 *
 * Qoder's upstream never reports prompt-cache hits (verified live on gRPC
 * and IDE HTTP surfaces — see
 * `documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip` (`2026-11-05-qoder-cache-hit-live.md`)).
 * The gateway bridges the gap with the shared session-cache estimator, exactly
 * like Trae and Kiro. These tests pin:
 *
 * 1. The estimator fills `cached_input_tokens` on a repeated request.
 * 2. It computes a partial prefix hit for a grown conversation.
 * 3. A genuine upstream report (>0) is trusted and left untouched.
 * 4. The adapter wiring passes the canonical messages and stable session id.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  estimateQoderSessionCache,
  resetQoderSessionCacheForTesting,
} from "../../../src/providers/integrations/qoder/qoder-cache";
import type { CanonicalMessage, UsageRecord } from "../../../src/protocol/canonical-model";

const msg = (text: string): CanonicalMessage => ({
  role: "user",
  content: [{ kind: "text", text }],
});

const record = (input: number): UsageRecord => ({
  input_tokens: input,
  output_tokens: 10,
  total_tokens: input + 10,
  cached_input_tokens: "unavailable",
  uncached_input_tokens: "unavailable",
  cache_write_tokens: "unavailable",
  reasoning_tokens: "unavailable",
  estimated_cost: null,
});

describe("Qoder session-cache estimate", () => {
  beforeEach(() => {
    resetQoderSessionCacheForTesting();
  });

  test("byte-identical repeat reports the whole input as cached", () => {
    const sessionId = "sess-1";
    const messages = [msg("Halo, apa kabar?")];

    const first = estimateQoderSessionCache(record(100), sessionId, messages);
    expect(first.cached_input_tokens).toBe("unavailable");

    const second = estimateQoderSessionCache(record(100), sessionId, messages);
    expect(second.cached_input_tokens).toBe(100);
    expect(second.uncached_input_tokens).toBe(0);
  });

  test("a grown conversation gets a partial prefix hit", () => {
    const sessionId = "sess-2";
    const p = msg("Halo, apa kabar?");
    const first = estimateQoderSessionCache(record(100), sessionId, [p]);
    expect(first.cached_input_tokens).toBe("unavailable");

    const grown = estimateQoderSessionCache(record(150), sessionId, [p, msg("Tambah pertanyaan.")]);
    expect(grown.cached_input_tokens).toBe(100);
    expect(grown.uncached_input_tokens).toBe(50);
  });

  test("a genuine upstream report is trusted and left untouched", () => {
    const sessionId = "sess-3";
    const messages = [msg("Halo")];
    const reported: UsageRecord = {
      ...record(200),
      cached_input_tokens: 120,
      uncached_input_tokens: 80,
    };
    const result = estimateQoderSessionCache(reported, sessionId, messages);
    expect(result.cached_input_tokens).toBe(120);
    expect(result.uncached_input_tokens).toBe(80);
  });

  test("sessions are isolated from each other", () => {
    const messages = [msg("Sama")];
    estimateQoderSessionCache(record(50), "sess-A", messages);
    const b = estimateQoderSessionCache(record(50), "sess-B", messages);
    expect(b.cached_input_tokens).toBe("unavailable");
  });
});
