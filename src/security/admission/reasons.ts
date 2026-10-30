import { GatewayError } from "../../protocol/gateway-error";
import type { AdmissionRejectionReason } from "./contracts";

/**
 * Single source of truth for an admission rejection reason: the operator-facing
 * message, the canonical GatewayError code and status, and the telemetry label.
 *
 * Module-level and read-only. The three tables this replaces were rebuilt as
 * fresh object literals on every rejection, which is the hot path for a
 * throttled tenant.
 */
const REASON_META: Record<
  AdmissionRejectionReason,
  {
    readonly message: string;
    readonly code: GatewayError["code"];
    readonly status: number;
    readonly metricLabel: string;
  }
> = {
  "rpm-exhausted": {
    message: "This key has used its requests-per-minute allowance (request {requestId}). Wait for the window to roll over, or raise the key's rpm limit. You've maxed this window — pace yourself ⏳",
    code: "rate_limited",
    status: 429,
    metricLabel: "rpm_exhausted",
  },
  "daily-token-limit": {
    message: "This key has used today's token allowance (request {requestId}). It resets at the start of the next day, or raise the key's daily limit. Pace yourself — it resets tomorrow ⏳",
    code: "rate_limited",
    status: 429,
    metricLabel: "daily",
  },
  "monthly-token-limit": {
    message: "This key has used this month's token allowance (request {requestId}). It resets at the start of the next month, or raise the key's monthly limit. Saving up for next month? It resets then ⏳",
    code: "rate_limited",
    status: 429,
    metricLabel: "monthly",
  },
  "lifetime-token-budget": {
    message: "This key has spent its lifetime token budget (request {requestId}). Raise the budget, or issue a new key. The piggy bank is empty — top it up or mint a new key 🐷",
    code: "rate_limited",
    status: 429,
    metricLabel: "lifetime",
  },
  "concurrency-limit": {
    // This ceiling is the API key's own `max_concurrent`, not the provider's
    // max-inflight. The two used to be indistinguishable and both named the
    // provider, sending operators to the wrong setting after a rejection. The
    // `details` carry the limit so a client can tell which one fired.
    message: "This API key is already serving its maximum number of concurrent requests (request {requestId}). Retry shortly, or raise the key's concurrency limit. It'll free up in a moment 🌊",
    code: "capacity_exhausted",
    status: 429,
    metricLabel: "concurrency",
  },
  "tenant-capacity-exhausted": {
    message: "This tenant is already serving its maximum number of concurrent requests (request {requestId}). Retry shortly, or raise the tenant's concurrency limit. The tenant is maxed out right now — chill 🏠",
    code: "tenant_capacity_exhausted",
    status: 429,
    metricLabel: "tenant_capacity",
  },
  "model-not-allowed": {
    message: "This key is not allowed to use this model under its allowlist (request {requestId}). Add the model to the key, or use one it already allows. The door's locked for this one — check the allowlist 🔒",
    code: "model_not_allowed",
    status: 403,
    metricLabel: "model_not_allowed",
  },
  "model-denied": {
    message: "This key's denylist blocks this model (request {requestId}). Remove the model from the denylist, or use a different model. This one's on the banned list — pick another 🚫",
    code: "model_not_allowed",
    status: 403,
    metricLabel: "model_not_allowed",
  },
  "admission-unavailable": {
    // Covers both real causes behind this reason: the store is unreachable, and
    // the store's own counters failed an integrity check (`corrupt_counter`,
    // `invalid_counter`, `unknown_reservation`, `invalid_actual_usage`). The
    // second is not an outage, so the text must not claim one — it names the
    // effect the client can act on, and the diagnostic stays in `details.reason`.
    message: "The gateway could not admit this request (request {requestId}). Retry shortly; if it persists, check the instance's Redis or coordination backend. The bouncer stepped out — come back shortly 🚪",
    code: "admission_unavailable",
    status: 503,
    metricLabel: "admission_unavailable",
  },
};

export function reasonToGatewayError(
  reason: AdmissionRejectionReason,
  detail: Record<string, unknown> = {},
): GatewayError {
  const meta = REASON_META[reason];
  return new GatewayError(meta.code, meta.status, meta.message, { reason, ...detail });
}

/**
 * Derives the telemetry metric label from the rejection reason. Unknown reasons
 * fall back to `admission_unavailable` so a new reason cannot emit an unbounded
 * metric label before its row is filled in.
 */
export function admissionMetricLabel(reason: AdmissionRejectionReason | string): string {
  return (
    REASON_META[reason as AdmissionRejectionReason]?.metricLabel ?? "admission_unavailable"
  );
}
