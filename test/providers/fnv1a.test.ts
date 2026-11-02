import { describe, expect, test } from "bun:test";
import { fnv1a32 } from "../../src/providers/integrations/shared/hash";

describe("fnv1a32", () => {
  test("golden values (FNV-1a 32-bit)", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });

  test("returns unsigned 32-bit values", () => {
    const hash = fnv1a32("anything");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  test("deterministic and input-sensitive", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
    expect(fnv1a32("hello")).not.toBe(fnv1a32("hellp"));
  });
});
