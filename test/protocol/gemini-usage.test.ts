/**
 * Gemini-family usage mapping.
 *
 * Two failures were silent, and both land on billing and every usage graph:
 *
 * 1. **Reasoning was dropped.** Gemini reports thinking in its own counter,
 *    `thoughtsTokenCount`, and `candidatesTokenCount` excludes it. Reading only
 *    the candidate count under-reported every thinking model's completion
 *    tokens by the entire reasoning budget.
 * 2. **Cache was double-counted.** `promptTokenCount` on these payloads is
 *    inclusive of `cachedContentTokenCount`, so adding the cached figure to it
 *    again inflates input.
 *
 * The fresh-input split and its clamp are `normalizeUsage`'s job — this file
 * pins the decoder's half: that reasoning reaches the wire, and that the
 * inclusive prompt stays inclusive rather than being summed twice.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mapGeminiUsage } from "../../src/protocol/response/gemini";
import { normalizeUsage, usageToChatWire } from "../../src/providers/provider-usage";

const CACHE_MODE_ENV = "CARTETHYIA_CACHE_MODE";

beforeEach(() => {
  delete process.env[CACHE_MODE_ENV];
});

function usage(metadata: Record<string, unknown>): Record<string, unknown> {
  return mapGeminiUsage({ usageMetadata: metadata });
}

describe("mapGeminiUsage", () => {
  test("adds thinking tokens to output", () => {
    // 40 candidate tokens plus 300 reasoning: the completion the upstream
    // billed is 340, not 40.
    expect(usage({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 300 })).toMatchObject({
      output_tokens: 340,
    });
  });

  test("surfaces reasoning through the details slot normalizeUsage reads", () => {
    const record = normalizeUsage(
      usage({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 300 }),
    );
    expect(record.reasoning_tokens).toBe(300);
    expect(record.output_tokens).toBe(340);
  });

  test("reasoning reaches the Chat Completions wire", () => {
    const wire = usageToChatWire(
      normalizeUsage(
        usage({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 300 }),
      ),
    );
    expect(wire.completion_tokens).toBe(340);
    expect(wire.completion_tokens_details?.reasoning_tokens).toBe(300);
  });

  test("a non-thinking response reports no reasoning rather than zero", () => {
    // "0 reasoning" and "this provider does not report reasoning" are different
    // facts, and the console distinguishes them.
    expect(
      normalizeUsage(usage({ promptTokenCount: 100, candidatesTokenCount: 40 })).reasoning_tokens,
    ).toBe("unavailable");
  });

  test("keeps the inclusive prompt rather than adding cache again", () => {
    // cached 30 of prompt 100: input the upstream billed is 100, and in
    // simplified mode the whole input counts as cached — summing would read 130.
    const record = normalizeUsage(
      usage({ promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 30 }),
    );
    expect(record.input_tokens).toBe(100);
    expect(record.cached_input_tokens).toBe(100);
    expect(record.uncached_input_tokens).toBe(0);
  });

  test("survives Antigravity reporting cached above prompt", () => {
    // The observed quirk: a naive `prompt - cached` goes negative, and nothing
    // may emit a negative token count downstream.
    const record = normalizeUsage(
      usage({ promptTokenCount: 50, candidatesTokenCount: 10, cachedContentTokenCount: 80 }),
    );
    expect(record.input_tokens).toBe(50);
    expect(record.uncached_input_tokens).toBe(0);
    expect(record.cached_input_tokens).toBe(50);
  });

  test("falls back to a computed total when the upstream omits one", () => {
    expect(
      usage({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 300 }),
    ).toMatchObject({ total_tokens: 440 });
  });

  test("trusts a reported total over the computed one", () => {
    expect(
      usage({ promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 999 }),
    ).toMatchObject({ total_tokens: 999 });
  });

  test("an absent usageMetadata reads as zeros, not NaN", () => {
    expect(mapGeminiUsage({})).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
    });
  });
});
