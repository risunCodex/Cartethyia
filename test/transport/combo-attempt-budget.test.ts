/**
 * One combo member must not be able to spend the whole attempt budget.
 *
 * A combo's members are flattened into the candidate list the attempt loop
 * walks, so the first member's accounts occupy its head. `maxAttempts` (default
 * 8) bounded total attempts, not attempts per member, so a first member holding
 * more accounts than the budget spent every attempt inside itself and a later,
 * perfectly healthy member was never dialed at all — a `deepseek` combo of
 * [cb, wb] stayed stuck on cb while wb sat idle.
 *
 * These drive `runAttemptLoop` with a stubbed lease source and a first member
 * that always fails, so the proof is the sequence of candidates actually
 * attempted rather than a classifier.
 */
import { expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { runAttemptLoop } from "../../src/transport/dispatch/attempt-loop";
import type { RouteCandidate } from "../../src/transport/routing/route-model";
import { attemptCandidate as candidate, attemptLeaseSource, attemptState, prepareAttempt } from "../helpers/attempt-loop";

/** A 429 the first member always answers with; retryable, so failover walks on. */
function throttled(): GatewayError {
  return new GatewayError(
    "quota_exceeded",
    429,
    "usage exceeds frequency limit, you can switch to the other models",
    {},
    "upstream",
  );
}

/** Stub leases: every candidate is admitted, and every reservation succeeds. */
/**
 * Runs the loop with `cbCount` failing accounts on the first member and one
 * healthy account on the second, and returns the providers actually attempted.
 */
async function attemptedProviders(cbCount: number): Promise<readonly string[]> {
  const previousAttempts = process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
  const previousBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = "8";
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    const candidates: RouteCandidate[] = [];
    for (let i = 1; i <= cbCount; i += 1) candidates.push(candidate("cb", `cb-${i}`));
    candidates.push(candidate("wb", "wb-1"));

    const seen: string[] = [];
    await runAttemptLoop<string, unknown>({
      state: attemptState("req-combo-budget"),
      deps: { db: {} as never },
      leaseSource: attemptLeaseSource(candidates),
      candidates,
      tenantId: "tenant-1",
      strictPoolSelection: false,
      prepare: prepareAttempt,
      attempt: async (context: { readonly candidate: RouteCandidate }) => {
        const current = context.candidate;
        seen.push(current.provider_id);
        if (current.provider_id === "cb") throw throttled();
        return "ok";
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    });
    return seen;
  } finally {
    if (previousAttempts === undefined) delete process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
    else process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = previousAttempts;
    if (previousBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = previousBase;
  }
}

/**
 * Same as `attemptedProviders`, but the two members' accounts are interleaved
 * (`cb, wb, cb, cb, …`) rather than contiguous — the order `plan()` produces
 * after its cooling partition, and the order the cap silently ignored.
 */
async function attemptedProvidersInterleaved(cbCount: number): Promise<readonly string[]> {
  const previousAttempts = process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
  const previousBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = "8";
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    const cb: RouteCandidate[] = [];
    for (let i = 1; i <= cbCount; i += 1) cb.push(candidate("cb", `cb-${i}`));
    const wb = candidate("wb", "wb-1");
    // One wb account sits in the middle, so cb's run is split in two.
    const mid = Math.min(1, cb.length);
    const candidates = [...cb.slice(0, mid), wb, ...cb.slice(mid)];

    const seen: string[] = [];
    await runAttemptLoop<string, unknown>({
      state: attemptState("req-combo-budget"),
      deps: { db: {} as never },
      leaseSource: attemptLeaseSource(candidates),
      candidates,
      tenantId: "tenant-1",
      strictPoolSelection: false,
      prepare: prepareAttempt,
      attempt: async (context: { readonly candidate: RouteCandidate }) => {
        const current = context.candidate;
        seen.push(current.provider_id);
        if (current.provider_id === "cb") throw throttled();
        return "ok";
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    });
    return seen;
  } finally {
    if (previousAttempts === undefined) delete process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
    else process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = previousAttempts;
    if (previousBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = previousBase;
  }
}

test("a first member with more accounts than the budget still reaches the next member", async () => {
  // The regression: twelve cb accounts against a budget of eight spent every
  // attempt on cb, so wb — the healthy member the combo exists to fall back to
  // — was never dialed.
  const seen = await attemptedProviders(12);
  expect(seen.includes("wb")).toBe(true);
});

test("the first member's own accounts are still tried first", async () => {
  // Fair shares, not a reorder: the combo's declared order is preserved, so the
  // first member still gets its attempts before the fallback member is reached.
  const seen = await attemptedProviders(3);
  expect(seen[0]).toBe("cb");
  expect(seen[seen.length - 1]).toBe("wb");
});

test("no attempt budget is lost to a member that had fewer accounts than its share", async () => {
  // One failing account cannot consume the second member's half of the budget.
  const seen = await attemptedProviders(1);
  expect(seen).toEqual(["cb", "wb"]);
});

test("the cap still binds when members are interleaved, not contiguous", async () => {
  // The shape `plan()` actually produces once its cooling partition runs: every
  // healthy candidate is emitted before every cooling one, so one member's
  // accounts are non-contiguous and interleaved with the other's.
  //
  // Member identity was first inferred by run-length scanning that list, which
  // counted `[cb, wb, cb, wb]` as four members and pushed each member's skip
  // threshold to `cap * 4` — past the whole budget — silently disabling the cap
  // on exactly the degraded lists it exists for. Twelve cb accounts must not be
  // able to spend eight attempts here.
  const seen = await attemptedProvidersInterleaved(12);
  expect(seen.includes("wb")).toBe(true);
  expect(seen.filter((p) => p === "cb").length).toBeLessThanOrEqual(4);
});

/**
 * An API-key admission rejection (`capacity_exhausted`) is decided before the
 * upstream is ever called, so every candidate fails identically. The loop must
 * stop at the first attempt instead of walking the rest of the combo and
 * burning the budget — and must not write account-health rows for a ceiling
 * the key's `max_concurrent` imposed.
 */
test("a key-level concurrency rejection is terminal and does not fail over", async () => {
  const priorAttempts = process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
  const priorBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = "8";
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    const candidates: RouteCandidate[] = [candidate("cb", "cb-1"), candidate("wb", "wb-1")];
    const seen: string[] = [];
    const error = await runAttemptLoop<string, unknown>({
      state: attemptState("req-key-concurrency"),
      deps: { db: {} as never },
      leaseSource: attemptLeaseSource(candidates),
      candidates,
      tenantId: "tenant-1",
      strictPoolSelection: false,
      prepare: prepareAttempt,
      attempt: async (context: { readonly candidate: RouteCandidate }) => {
        seen.push(context.candidate.provider_id);
        // A key admission rejection happens before dispatch; the stubbed lease
        // source admits always, so simulate it by throwing from the first
        // attempt with the key-level code.
        if (context.candidate.provider_id === "cb") {
          throw new GatewayError(
            "capacity_exhausted",
            429,
            "This API key is already serving its maximum number of concurrent requests (request {requestId}). Retry shortly, or raise the key's concurrency limit. It'll free up in a moment 🌊",
            { reason: "concurrency-limit" },
          );
        }
        return "ok";
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    }).catch((thrown: unknown) => thrown);
    // Only the first candidate was attempted — no failover to wb.
    expect(seen).toEqual(["cb"]);
    // The key-level error surfaces as-is.
    expect(error instanceof GatewayError).toBe(true);
    expect((error as GatewayError).code).toBe("capacity_exhausted");
  } finally {
    if (priorAttempts === undefined) delete process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"];
    else process.env["CARTETHYIA_ROUTE_MAX_ATTEMPTS"] = priorAttempts;
    if (priorBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = priorBase;
  }
});
