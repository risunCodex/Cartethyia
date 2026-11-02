/**
 * The Models grid Show filter: `all` shows every registered model, `free`
 * hides every row the provider does not publish as free tier. The filter is
 * what makes the header's Show selector meaningful, so it is pinned here.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { ModelGrid } from "../../src/features/provider-detail/sections/Models";
import { renderMarkup } from "../helpers/render";
import type { ModelCatalogEntry } from "../../src/data/contracts";

function model(
  partial: Partial<Omit<ModelCatalogEntry, "modelId">> & { readonly modelId: string },
): ModelCatalogEntry {
  const { modelId, ...rest } = partial;
  return {
    modelId,
    route: "/chat/completions",
    provider: "qoder",
    wireFamily: "chat",
    serviceKind: "llm",
    enabled: true,
    contextLimit: 1000000,
    outputLimit: 65536,
    reasoning: false,
    toolCall: true,
    vision: true,
    document: false,
    audio: false,
    mediaGeneration: false,
    cost: null,
    source: "builtin",
    sourceUpdatedAt: null,
    ...rest,
  };
}

const FREE = model({ modelId: "lite-qwen-3.7-plus", freeTier: true });
const BILLED = model({ modelId: "sonus", freeTier: false });
const UNKNOWN = model({ modelId: "manual-model", source: "manual" });

function grid(showFilter: "all" | "free"): string {
  return renderMarkup(
    createElement(ModelGrid, {
      providerId: "qoder",
      models: [FREE, BILLED, UNKNOWN],
      thinkingEffort: "auto",
      showFilter,
    }),
  );
}

describe("ModelGrid Show filter", () => {
  test("`all` renders every registered model", () => {
    const markup = grid("all");
    expect(markup).toContain("lite-qwen-3.7-plus");
    expect(markup).toContain("sonus");
    expect(markup).toContain("manual-model");
  });

  test("`free` hides every row the provider does not publish as free", () => {
    const markup = grid("free");
    expect(markup).toContain("lite-qwen-3.7-plus");
    expect(markup).not.toContain("sonus");
    expect(markup).not.toContain("manual-model");
  });
});

function expectLabel(options: { value: string; label: string }[], value: string, label: string): void {
  const found = options.find((option) => option.value === value);
  expect(found).toBeDefined();
  expect(found?.label).toBe(label);
}

describe("Show selector options", () => {
  test("offers All models and Free tier, in that order", async () => {
    const { modelShowFilterOptions } = await import("../../src/features/provider-detail/sections/Models");
    const options = modelShowFilterOptions();
    expect(options).toHaveLength(2);
    expectLabel(options, "all", "All models");
    expectLabel(options, "free", "Free tier");
    expect(options[0]?.value).toBe("all");
    expect(options[1]?.value).toBe("free");
  });
});
