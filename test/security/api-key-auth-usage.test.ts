/**
 * How the auth path assembles `lifetime_tokens_consumed`.
 *
 * Two properties matter and both fail silently:
 *
 * - the children aggregate used to run for every key, though only a `share`
 *   parent can have children — a Postgres round-trip on the auth path that was
 *   certain to return 0;
 * - the persisted value lags the flush buffer, so it was understated by the
 *   most exactly when a key was busiest.
 *
 * Neither produces a wrong status code, so nothing else catches them.
 *
 * The guard is extracted to a pure function so it is testable without a
 * database; `resolveApiKeyAuthorization` itself builds a real store and needs
 * one, which is why the end-to-end half is not asserted here.
 */
import { describe, expect, test } from "bun:test";
import { canHaveChildKeys } from "../../src/security/api-key-auth";

describe("canHaveChildKeys", () => {
  test("only a share key can carry children", () => {
    expect(canHaveChildKeys({ keyMode: "share" })).toBe(true);
    expect(canHaveChildKeys({ keyMode: "personal" })).toBe(false);
  });

  test("a key with no mode stated is treated as childless", () => {
    // Fail closed rather than open: an unstated mode must not buy an extra
    // query on the auth path.
    expect(canHaveChildKeys({})).toBe(false);
    expect(canHaveChildKeys({ keyMode: null })).toBe(false);
  });

  test("an unrecognised mode is treated as childless", () => {
    expect(canHaveChildKeys({ keyMode: "something-else" })).toBe(false);
  });
});
