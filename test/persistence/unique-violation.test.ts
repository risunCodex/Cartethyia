import { describe, expect, test } from "bun:test";
import { isUniqueViolation } from "../../src/persistence/boot";

describe("isUniqueViolation", () => {
  test("detects Postgres SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  test("detects SQLite UNIQUE constraint message text", () => {
    expect(
      isUniqueViolation({
        message:
          "UNIQUE constraint failed: index 'provider_accounts_identity_uidx'",
      }),
    ).toBe(true);
  });

  test("detects SQLite SQLITE_CONSTRAINT_UNIQUE code", () => {
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
  });

  test("detects SQLite generic constraint code with message", () => {
    expect(isUniqueViolation({ code: "19", message: "UNIQUE constraint failed" })).toBe(true);
  });

  test("walks a nested cause chain (Drizzle wraps driver errors)", () => {
    const cause = { message: "UNIQUE constraint failed: index 'x'" };
    expect(isUniqueViolation({ cause })).toBe(true);
    expect(isUniqueViolation({ cause: { cause } })).toBe(true);
  });

  test("returns false for non-violation errors", () => {
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
    expect(isUniqueViolation({ code: "23505_bogus" })).toBe(false);
    expect(isUniqueViolation({ message: "FOREIGN KEY constraint failed" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("string")).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  test("does not treat every code-19 error as a unique violation", () => {
    // SQLite code 19 is any constraint error; only with a constraint message.
    expect(isUniqueViolation({ code: "19" })).toBe(false);
  });
});
