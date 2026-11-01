/**
 * The PG→SQLite value mapper must turn a node-postgres driver value into the
 * binding the lite backend expects for the same column. The SQLite schema is
 * the shared Drizzle schema, so a wrong mapping here corrupts a migrated
 * install (a timestamp stored as a Date object, a boolean stored as text, a
 * jsonb stored as a JS object, a credential blob stored as JSON).
 */
import { expect, test } from "bun:test";
import { mapPgValue } from "../../scripts/migrate-pg-to-sqlite";

test("booleans become 1/0", () => {
  expect(mapPgValue(true, "boolean")).toBe(1);
  expect(mapPgValue(false, "boolean")).toBe(0);
  expect(mapPgValue(null, "boolean")).toBeNull();
});

test("timestamps and dates become ISO text", () => {
  const at = new Date("2026-10-30T12:34:56.789Z");
  expect(mapPgValue(at, "timestamp with time zone")).toBe("2026-10-30T12:34:56.789Z");
  expect(mapPgValue(at, "date")).toBe("2026-10-30T12:34:56.789Z");
  expect(mapPgValue("2026-10-30T12:34:56.789Z", "timestamp with time zone")).toBe(
    "2026-10-30T12:34:56.789Z",
  );
});

test("jsonb/json become JSON text, preserving strings", () => {
  expect(mapPgValue({ a: 1 }, "jsonb")).toBe('{"a":1}');
  expect(mapPgValue("[1,2]", "json")).toBe("[1,2]");
  expect(mapPgValue(null, "jsonb")).toBeNull();
});

test("bytea stays a blob", () => {
  const buf = Buffer.from([1, 2, 3]);
  const mapped = mapPgValue(buf, "bytea");
  expect(Buffer.isBuffer(mapped)).toBe(true);
  expect(mapped).toEqual(buf);
});

test("bigint strings become numbers when safe, text when too large", () => {
  expect(mapPgValue("9007199254740991", "bigint")).toBe(9007199254740991);
  expect(mapPgValue("-9007199254740990", "bigint")).toBe(-9007199254740990);
  expect(mapPgValue("9007199254740992", "bigint")).toBe("9007199254740992");
  expect(mapPgValue("123.45", "numeric")).toBe(123.45);
  expect(mapPgValue("not-a-number", "numeric")).toBe("not-a-number");
});

test("null and plain scalars pass through", () => {
  expect(mapPgValue(null, "text")).toBeNull();
  expect(mapPgValue("abc", "text")).toBe("abc");
  expect(mapPgValue(42, "integer")).toBe(42);
  expect(mapPgValue(3.5, "double precision")).toBe(3.5);
});
