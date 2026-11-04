/**
 * `isDegenerateStop` flags the pattern that surfaced as short, cut-off chat
 * replies: a completed request whose *total* output (answer + reasoning) is
 * far smaller than the model's ceiling, ended by an ordinary `stop` rather
 * than `length`.
 */
import { expect, test } from "bun:test";
import { isDegenerateStop } from "../../src/transport/dispatch/attempt-finalize";
import type { UsageRecord } from "../../src/protocol/canonical-model";

function usage(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    input_tokens: 1000,
    cache_write_tokens: 0,
    uncached_input_tokens: 100,
    output_tokens: 26,
    cached_input_tokens: 900,
    reasoning_tokens: 4,
    estimated_cost: null,
    ...overrides,
  };
}

test("flags a short output ended by an ordinary stop (the degenerate pattern)", () => {
  // 30 total output vs a 128k ceiling = well under 10% — degenerate.
  expect(isDegenerateStop(usage({}), 128_000)).toBe(true);
});

test("ignores output at or above 10% of the ceiling", () => {
  expect(isDegenerateStop(usage({ output_tokens: 13_000 }), 128_000)).toBe(false);
});

test("ignores very large degenerate-looking outputs (not a premature stop)", () => {
  // 600 total output is still tiny relative to a 128k ceiling, but the caller
  // treats it as a real answer, not a degenerate truncation.
  expect(isDegenerateStop(usage({ output_tokens: 596 }), 128_000)).toBe(false);
});

test("ignores zero total output (no content at all, not a truncation)", () => {
  expect(isDegenerateStop(usage({ output_tokens: 0, reasoning_tokens: 0 }), 128_000)).toBe(false);
});

test("returns false when usage is absent", () => {
  expect(isDegenerateStop(undefined, 128_000)).toBe(false);
});

test("returns false when the model has no known ceiling", () => {
  expect(isDegenerateStop(usage({}), undefined)).toBe(false);
});
