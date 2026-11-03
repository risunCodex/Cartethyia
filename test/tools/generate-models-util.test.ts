/**
 * Numeric guards for the packed offline model catalog generator.
 *
 * The packed catalog stores context/output limits in u32 columns; a value
 * ≥ 2^32 silently wraps modulo 2^32 and the reader decodes a garbage limit as
 * if it were real. These tests pin the guards: `positiveInt` normalizes the
 * raw upstream value, and `checkedPackedLimit` fails loudly at or above 2^31
 * instead of wrapping. Imported from the shared util module because
 * `generate-models.ts` fetches both upstream catalogs at module load.
 */
import { describe, expect, test } from "bun:test";
import {
  checkedPackedLimit,
  MAX_PACKED_U32_VALUE,
  positiveInt,
} from "../../scripts/tools/generate-models-util";

describe("generate-models packed-limit guards", () => {
  test("positiveInt maps non-finite and non-positive values to 0", () => {
    expect(positiveInt(0)).toBe(0);
    expect(positiveInt(-5)).toBe(0);
    expect(positiveInt(Number.NaN)).toBe(0);
    expect(positiveInt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(positiveInt({})).toBe(0);
    expect(positiveInt("128000")).toBe(0);
  });

  test("positiveInt truncates positive finite numbers", () => {
    expect(positiveInt(128_000)).toBe(128_000);
    expect(positiveInt(1_000_000)).toBe(1_000_000);
    expect(positiveInt(1024.9)).toBe(1024);
    expect(positiveInt(2 ** 31)).toBe(2 ** 31);
  });

  test("checkedPackedLimit rejects a value at or above 2^31 instead of wrapping", () => {
    expect(() => checkedPackedLimit("context", 2 ** 31)).toThrow(/exceeds/);
    expect(() => checkedPackedLimit("output", 4_294_967_296)).toThrow(/exceeds/);
    expect(() => checkedPackedLimit("context", Number.MAX_SAFE_INTEGER)).toThrow(/exceeds/);
  });

  test("checkedPackedLimit passes values below 2^31 through unchanged", () => {
    expect(checkedPackedLimit("context", 2 ** 31 - 1)).toBe(2 ** 31 - 1);
    expect(checkedPackedLimit("output", 512_000)).toBe(512_000);
    expect(checkedPackedLimit("context", 0)).toBe(0);
  });

  test("the documented ceiling is the largest safe u32 value", () => {
    expect(MAX_PACKED_U32_VALUE).toBe(2 ** 31 - 1);
    expect(MAX_PACKED_U32_VALUE).toBeLessThan(2 ** 31);
  });
});
