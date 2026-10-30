/**
 * `asJsonbRecord` normalizes the two stored shapes of an `auth_state`/JSONB
 * column into one POJO: Postgres' drizzle jsonb arrives as an object, SQLite's
 * text-backed column arrives as a JSON string. Every auth-state reader must
 * accept both — a SQLite install that drops the string form loses per-account
 * identity (Qoder's userId/machineId, Trae's region) and breaks dispatch.
 */
import { describe, expect, test } from "bun:test";
import { asJsonbRecord, asRecord } from "../../src/shared/coerce";

describe("asRecord", () => {
  test("returns the object for a plain object", () => {
    const value = { userId: "u1", machineId: "m1" };
    expect(asRecord(value)).toBe(value);
  });

  test("rejects a JSON string (the SQLite shape)", () => {
    expect(asRecord('{"userId":"u1"}')).toBeUndefined();
  });

  test("rejects arrays and null", () => {
    expect(asRecord([])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
  });
});

describe("asJsonbRecord", () => {
  test("passes a POJO through unchanged", () => {
    const object = { userId: "u1", machineId: "m1" };
    expect(asJsonbRecord(object)).toBe(object);
  });

  test("parses a JSON string into the same object", () => {
    expect(asJsonbRecord('{"userId":"u1","machineId":"m1"}')).toEqual({
      userId: "u1",
      machineId: "m1",
    });
  });

  test("returns undefined for malformed JSON", () => {
    expect(asJsonbRecord("{not-json")).toBeUndefined();
  });

  test("returns undefined for non-object, non-string values", () => {
    expect(asJsonbRecord(7)).toBeUndefined();
    expect(asJsonbRecord(null)).toBeUndefined();
    expect(asJsonbRecord(undefined)).toBeUndefined();
  });

  test("returns undefined for a JSON array string", () => {
    expect(asJsonbRecord("[1,2,3]")).toBeUndefined();
  });
});
