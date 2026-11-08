import type {
  AccountErrorRule,
} from "../account-error-classification";

/**
 * Checks whether an upstream body indicates Copilot is not licensed.
 * Copilot answers 401 for a bad credential and 403 for a
 * license/entitlement refusal, so forbidden/unauthorized on this surface
 * is the same verdict.
 */
export function copilotNotLicensed(lower: string): boolean {
  return (
    lower.includes("not licensed") ||
    lower.includes("forbidden") ||
    lower.includes("unauthorized") ||
    lower.includes("license")
  );
}

export const githubRules: readonly AccountErrorRule[] = [
  {
    // GitHub Copilot answers a license/entitlement refusal with 403 and
    // "not licensed to use Copilot" / "forbidden" / "unauthorized". That is a
    // verdict on the account: the subscription cannot serve this credential,
    // and no amount of waiting or refreshing changes it. Cooldown cycling
    // (auth_invalidated + 5m backoff) kept a dead account in rotation where a
    // client's retry budget burned sibling accounts — the same failure the
    // buddy ban exists to prevent. Disable immediately. Must run before
    // `credential-rejected`, which would claim the bare 403 as a refreshable
    // auth rejection.
    name: "github-copilot-not-licensed",
    match: (s) =>
      s.origin === "upstream" &&
      s.providerId === "github" &&
      copilotNotLicensed(s.lower),
    decide: (s) =>
      s.result(
        "policy_blocked_banned",
        "disabled",
        0,
        null,
        s.reason("GitHub Copilot account not licensed"),
        // A license refusal is evidence about the account even at provider
        // scope, for the same reason a named revocation or a buddy ban is.
        true,
      ),
  },
];
