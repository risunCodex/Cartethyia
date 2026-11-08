// Routing configuration knobs.
import { CONFIG_SPEC, readInt, readText } from "./spec";

/**
 * Unified routing decision engine switch (routing/quota/health unification).
 *
 * Defaults to off. When on, the routing engine evaluates a normalized
 * quota/plan fact per candidate: known-exhausted or below-floor accounts are
 * proactively excluded before dispatch (model-aware window matching), unknown
 * quota is an explicit lower-rank state, and the plan gate is a first-class
 * reason. See the proposal for the staged rollout contract.
 */
export function unifiedRoutingDecisionEnabled(): boolean {
  return readText(
    "CARTETHYIA_UNIFIED_ROUTING_DECISION",
    CONFIG_SPEC.CARTETHYIA_UNIFIED_ROUTING_DECISION,
  ) === "true";
}

/** Routing reserve percent (0–100). Accounts at/below this remaining-quota % are demoted. */
export function accountReservePct(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_RESERVE_PCT",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_RESERVE_PCT,
  );
}

/** Session-sticky warm window in ms. 0 disables stickiness. */
export function routingStickyWarmMs(): number {
  return readInt(
    "CARTETHYIA_ROUTING_STICKY_WARM_MS",
    CONFIG_SPEC.CARTETHYIA_ROUTING_STICKY_WARM_MS,
  );
}

/** LRU cap on remembered session→account sticky state per provider. */
export function routingStickyMaxSessions(): number {
  return readInt(
    "CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS",
    CONFIG_SPEC.CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS,
  );
}
