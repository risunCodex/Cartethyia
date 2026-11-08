// Routing configuration knobs.
import { CONFIG_SPEC, readText } from "./spec";

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
