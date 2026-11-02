import { describe, expect, test } from "bun:test";
import {
  advertisedMetadata,
  resolveTargetIds,
} from "../../src/console/providers/catalog/public-model-store";

describe("public model metadata resolution", () => {
  test("walks combo members and aliases to concrete ids", () => {
    const aliases = new Map([["bansos/deepseek-v4.1-flash", "deepseek-pool"]]);
    const combos = new Map([
      ["deepseek-pool", ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"]],
    ]);
    expect(resolveTargetIds("bansos/deepseek-v4.1-flash", aliases, combos)).toEqual([
      "cb/deepseek-v4.1-flash",
      "cbcn/deepseek-v4.1-flash",
    ]);
  });

  test("no describable member falls back to a null-limit entry", () => {
    const result = advertisedMetadata(["nope/deepseek-v4.1-flash"], new Map());
    expect(result.contextLimit).toBeNull();
    expect(result.reasoning).toBe(false);
  });

  test("cycle protection returns no fabricated target", () => {
    const aliases = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(resolveTargetIds("a", aliases, new Map())).toEqual([]);
  });
});
