/**
 * `accountsUnavailableError` messaging: the 503 must name the real blocker,
 * not always blame the pool. When the only reason is a capability the model's
 * accounts do not support, telling the client to "add an account" or wait out
 * a coffee break is misleading — the model itself is the limit.
 */
import { describe, expect, test } from "bun:test";
import { accountsUnavailableError } from "../../src/transport/routing/route-model";

describe("accountsUnavailableError", () => {
  test("capability_unsupported reason yields a capability hint, not a pool hint", () => {
    const error = accountsUnavailableError("provider/text-model", ["capability_unsupported"]);
    expect(error.code).toBe("accounts_unavailable");
    expect(error.status).toBe(503);
    const message = error.message;
    expect(message).toContain("No account in the pool can serve 'provider/text-model'");
    // The explanation is mapped to a readable sentence, not the raw reason.
    expect(message).toContain("do not support the request's capabilities");
    // The misleading "add an account / coffee break" advice is gone.
    expect(message).not.toContain("coffee break");
    expect(message).not.toContain("Add an account");
    // The real fix is named.
    expect(message).toContain("vision-capable model");
  });

  test("health/pool reasons keep the pool advice", () => {
    const error = accountsUnavailableError("provider/text-model", ["disabled"]);
    expect(error.message).toContain("Add an account");
    expect(error.message).toContain("coffee break");
  });
});
