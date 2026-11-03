/**
 * Input-token accounting mode for `normalizeUsage` (`CARTETHYIA_USAGE_INPUT_MODE`).
 *
 * Providers disagree on whether `input_tokens` already includes cached tokens:
 *
 * - OpenAI/DeepSeek report the inclusive total with a cached subset
 *   (`input_tokens_details.cached_tokens` / flat `prompt_cache_hit_tokens`).
 * - Anthropic reports fresh-only input with cache reads/writes in separate
 *   fields, yet still sets `total_tokens = input + output`.
 *
 * `inclusive` (default) folds Anthropic's cache into input so every provider
 * reads alike: IN is always the whole prompt and CACHED its subset. `as-is`
 * keeps the raw upstream semantics.
 */
import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "../../src/providers/provider-usage";

const INPUT_MODE = "CARTETHYIA_USAGE_INPUT_MODE";

function withMode(mode: string | undefined, run: () => void): void {
  const previous = process.env[INPUT_MODE];
  if (mode === undefined) delete process.env[INPUT_MODE];
  else process.env[INPUT_MODE] = mode;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[INPUT_MODE];
    else process.env[INPUT_MODE] = previous;
  }
}

/** Anthropic-shape payload: fresh input + cache read/write, total = input + output. */
const ANTHROPIC = {
  input_tokens: 100,
  output_tokens: 50,
  total_tokens: 150,
  cache_read_input_tokens: 40,
  cache_creation_input_tokens: 10,
};

describe("normalizeUsage input mode", () => {
  test("default (inclusive) folds Anthropic cache into input", () => {
    withMode(undefined, () => {
      const record = normalizeUsage(ANTHROPIC);
      // Fresh 100 + cache read 40 + cache write 10 = the whole prompt.
      expect(record.input_tokens).toBe(150);
      expect(record.cached_input_tokens).toBe(40);
      expect(record.uncached_input_tokens).toBe(100);
    });
  });

  test("inclusive keeps an already-inclusive prompt from being summed twice", () => {
    withMode("inclusive", () => {
      // OpenAI-shape: prompt already includes the cached subset.
      const record = normalizeUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30 },
      });
      expect(record.input_tokens).toBe(100);
      expect(record.cached_input_tokens).toBe(30);
      expect(record.uncached_input_tokens).toBe(70);
    });
  });

  test("inclusive folds cache even when total_tokens equals input + output", () => {
    // Measured upstream (Ollama Cloud, Anthropic Messages wire): input 213,439
    // is fresh-only with 9,088 cached read, yet the payload also carries
    // `total_tokens = input + output` — which the legacy heuristic mistook for
    // "already-inclusive" and refused to fold. `inclusive` folds regardless.
    withMode("inclusive", () => {
      const record = normalizeUsage({
        input_tokens: 213_439,
        output_tokens: 123,
        total_tokens: 213_562,
        cache_read_input_tokens: 9_088,
      });
      expect(record.input_tokens).toBe(222_527);
      expect(record.cached_input_tokens).toBe(9_088);
      expect(record.uncached_input_tokens).toBe(213_439);
    });
  });

  test("as-is keeps Anthropic's raw fresh-only input", () => {
    withMode("as-is", () => {
      const record = normalizeUsage(ANTHROPIC);
      expect(record.input_tokens).toBe(100);
      expect(record.cached_input_tokens).toBe(40);
      expect(record.uncached_input_tokens).toBe(60);
    });
  });

  test("as-is keeps an inclusive prompt inclusive", () => {
    withMode("as-is", () => {
      const record = normalizeUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30 },
      });
      expect(record.input_tokens).toBe(100);
      expect(record.cached_input_tokens).toBe(30);
      expect(record.uncached_input_tokens).toBe(70);
    });
  });

  test("no cache fields leave input untouched in either mode", () => {
    for (const mode of [undefined, "inclusive", "as-is"]) {
      withMode(mode, () => {
        const record = normalizeUsage({ input_tokens: 200, output_tokens: 80, total_tokens: 280 });
        expect(record.input_tokens).toBe(200);
        expect(record.cached_input_tokens).toBe("unavailable");
        expect(record.uncached_input_tokens).toBe("unavailable");
      });
    }
  });
});
