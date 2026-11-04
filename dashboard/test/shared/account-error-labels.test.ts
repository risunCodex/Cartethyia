import { describe, expect, test } from "bun:test";
import { accountErrorLabel, showsErrorPill } from "../../src/lib/format/labels";

/**
 * The account pill used to render the raw category, so a quota endpoint that
 * failed showed `quota_fetch_failed` — a machine value an operator cannot act
 * on. The label has to say what is wrong.
 */
describe("accountErrorLabel", () => {
  test("a quota fetch failure reads as the quota surface being unreachable", () => {
    expect(accountErrorLabel("quota_fetch_failed")).toBe("Quota unreachable");
  });

  test("a revoked OAuth credential says to re-login", () => {
    expect(accountErrorLabel("auth_invalidated", "oauth")).toBe("Re-login required");
  });

  test("a revoked API key says to replace the key, not re-login", () => {
    // A BYOK key has no login to return to; telling the operator to re-login
    // sends them after a sign-in button their provider does not have.
    expect(accountErrorLabel("auth_invalidated", "api_key")).toBe("Replace API key");
  });

  test("an unlabelled revoked credential still avoids a login instruction", () => {
    expect(accountErrorLabel("auth_invalidated")).not.toMatch(/login/i);
  });

  test("a GitHub Copilot license refusal reads as no access, not a ban", () => {
    expect(accountErrorLabel("policy_blocked_banned", "oauth", "github")).toBe("No Copilot access");
  });

  test("a ban on other providers still reads as a ban", () => {
    expect(accountErrorLabel("policy_blocked_banned", "oauth", "buddy")).toBe("Account banned");
    expect(accountErrorLabel("policy_blocked_banned", "oauth")).toBe("Account banned");
  });

  test("an unknown category is shown as-is rather than hidden", () => {
    expect(accountErrorLabel("something_new")).toBe("something_new");
  });
});

/**
 * A check that will be retried is not a state of the account.
 *
 * `quota_fetch_failed` says the quota *endpoint* did not answer this pass. The
 * account routes fine; only its allowance is unknown, and the sweep tries again.
 * A pill reading "Quota unreachable" told the operator the opposite — that the
 * account could not be used — for a condition that clears itself.
 */
describe("showsErrorPill", () => {
  test("a retryable quota-fetch failure raises no pill", () => {
    expect(showsErrorPill("quota_fetch_failed")).toBe(false);
  });

  test("a spent allowance still shows: it will not clear on its own", () => {
    expect(showsErrorPill("quota_exhausted")).toBe(true);
  });

  test("a rejected credential still shows", () => {
    expect(showsErrorPill("auth_invalidated")).toBe(true);
  });

  test("an unknown category is shown rather than silently swallowed", () => {
    expect(showsErrorPill("something_new")).toBe(true);
  });

  test("no category means no pill", () => {
    expect(showsErrorPill(undefined)).toBe(false);
    expect(showsErrorPill("")).toBe(false);
  });
});
