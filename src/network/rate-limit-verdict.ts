/**
 * Unified egress-failure classification for ip-scoped, rate-limited providers.
 *
 * One 429 is read in several places — dispatch (`attempt-loop`, streaming
 * `finalize`), the provider probe, account health, and the pool health machine
 * each had their own vocabulary. The two questions that decide whether a probe
 * *pool* (not an account) is responsible for a failure are:
 *
 * - Did the upstream count this request against the egress address? Only a
 *   provider whose limits follow the IP (`ipScopedRateLimit`) qualifies — for
 *   everyone else the 429 belongs to the credential that was dialed, and
 *   cooling the pool would sideline healthy accounts.
 * - Is the address itself retired (free-tier 403) rather than merely
 *   throttled (429)? A block is terminal; a cooldown refills.
 *
 * This module is the single source of truth for those two facts. Dispatch and
 * the probe both read it, so the operator's "test" and gateway's own dial
 * cannot disagree about which egress is spent.
 */
import { GatewayError } from "../protocol/gateway-error";
import { providerRateLimitIsIpScoped } from "../providers/provider-metadata";

/** What one upstream failure means for the egress that carried it. */
type EgressVerdict =
  | { kind: "none" }
  | { kind: "cooldown"; retryAfterMs?: number }
  | { kind: "blocked" };

/** The upstream's own wording for a retired free-tier address. */
export const FREE_TIER_REFUSAL = /freetier|free tier can only be used/i;

/**
 * Classifies one upstream failure against one provider.
 *
 * `providerId` is the caller's own candidate, not a field read off the error:
 * the in-stream error frames the protocol modules build carry no `providerId`
 * detail, so reading it from `details` would silently disable the IP-scoped
 * rule on exactly the streaming path it exists for.
 */
export function classifyEgressFailure(error: unknown, providerId: string): EgressVerdict {
  if (!(error instanceof GatewayError) || error.origin !== "upstream") {
    return { kind: "none" };
  }
  if (!providerRateLimitIsIpScoped(providerId)) return { kind: "none" };

  // A provider-scoped 429 exhausted the address's allowance: cool the pool
  // until the window refills.
  if (error.status === 429 && error.details.rateLimitScope === "provider") {
    const retryAfterMs =
      typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : undefined;
    return retryAfterMs === undefined ? { kind: "cooldown" } : { kind: "cooldown", retryAfterMs };
  }

  // A free-tier 403 retires the address: the request was never read, so the
  // same egress cannot succeed no matter what the payload says. Deliberately
  // narrower than "any 403" — a content-policy or licence refusal is also a
  // 403 and must not retire a healthy proxy.
  if (error.status === 403) {
    const providerCode =
      typeof error.details.providerCode === "string" ? error.details.providerCode : "";
    const raw = String(error.details.raw ?? "");
    if (/freetier|free.?tier/i.test(providerCode) || FREE_TIER_REFUSAL.test(`${error.message} ${raw}`)) {
      return { kind: "blocked" };
    }
  }

  return { kind: "none" };
}
