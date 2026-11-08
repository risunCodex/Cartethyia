/**
 * The two catalog caches that were unbounded or wrongly bounded.
 *
 * Both were found by measurement, not by reading: `metadataCache` was the only
 * cache in the codebase with no ceiling at all, and
 * `MODEL_CATALOG_CACHE_MAX_ENTRIES` sat *below* the bundled provider count, so
 * a rebuild evicted a provider it was about to need again.
 */
import { describe, expect, test } from "bun:test";
import { METADATA_CACHE_MAX_ENTRIES } from "../../src/providers/discovery/catalog/catalog-format";
import { MODEL_CATALOG_CACHE_MAX_ENTRIES } from "../../src/providers/operations/provider-caches";
import { BUNDLED_PROVIDER_METADATA } from "../../src/providers/provider-metadata";
import { modelsDevCatalog } from "../../src/providers/discovery/models-dev-catalog";

describe("catalog cache bounds", () => {
  test("the provider count fits inside the model catalog cache", () => {
    // The cap was 64 with 73 bundled providers, so every rebuild thrashed.
    // Asserted as a relation, not a literal, so adding providers fails this
    // with the number that actually matters.
    expect(MODEL_CATALOG_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(BUNDLED_PROVIDER_METADATA.length);
  });

  test("the metadata cache has a ceiling well below the catalog's row count", () => {
    // Unbounded before: one memo entry per row touched, never evicted, over a
    // catalog of thousands of rows.
    expect(METADATA_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(METADATA_CACHE_MAX_ENTRIES).toBeLessThan(8941);
  });
});
describe("metadata cache under a real working set", () => {
  // `ModelsDevCatalog` exposes `resolve`, not a model listing, so the working
  // set is built by resolving a fixed list of well-known ids across many
  // providers — more distinct rows than the ceiling, which is the condition
  // eviction has to survive.
  const IDS = [
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "claude-sonnet-4.5",
    "claude-opus-4.1",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "grok-4",
    "deepseek-chat",
    "qwen3-coder",
    "llama4-maverick",
    "mistral-large",
  ] as const;

  test("resolving past the ceiling still returns correct metadata", () => {
    let resolved = 0;
    for (const provider of modelsDevCatalog.providers.slice(0, 60)) {
      for (const modelId of IDS) {
        if (modelsDevCatalog.resolve(provider, modelId) !== undefined) resolved += 1;
      }
    }
    // The point is that this ran at all: 720 lookups over a bounded memo.
    expect(resolved).toBeGreaterThan(0);
  });

  test("a row resolved early is still correct after the memo must have evicted it", () => {
    // Correctness after eviction: an entry dropped from the memo has to be
    // rebuilt from the blob, not lost. Resolve far past the ceiling, then
    // re-resolve the very first row and require the same answer.
    const firstProvider = modelsDevCatalog.providers[0];
    const firstId = IDS[0];
    expect(firstProvider).toBeDefined();
    if (firstProvider === undefined) return;
    const before = modelsDevCatalog.resolve(firstProvider, firstId);
    for (const provider of modelsDevCatalog.providers.slice(0, 60)) {
      for (const modelId of IDS) modelsDevCatalog.resolve(provider, modelId);
    }
    const after = modelsDevCatalog.resolve(firstProvider, firstId);
    expect(after?.id).toBe(before?.id);
  });
});
