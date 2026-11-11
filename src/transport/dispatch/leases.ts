import { GatewayError } from "../../protocol/gateway-error";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { ApiKeyAdmissionService } from "../../security/admission/service";
import type { ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { PoolRotation, PoolSelectionFailure } from "../../network/pool/selector";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../network/egress/factory";
import type { RouteCandidate as RouteCandidate, Reservation, RoutePlan } from "../routing/route-model";
import type { RoutingEngine } from "../routing/router";

export interface AttemptLeases {
  readonly lease: AdmissionLease;
  readonly reservation: Reservation;
  readonly proxySlot?: { poolId: string; release: () => void };
  readonly networkPoolId?: string;
  /**
   * Ownership of this attempt's account/network-pool release.
   *
   * A provider session that outlives the HTTP request — Cursor's Run, held open
   * for the client's next tool-result request — takes the release over instead
   * of having the request release it when the response is flushed. Request-scoped
   * accounting (admission, per-request telemetry) still settles per request;
   * only the *slot and pool inflight* move to the session's lifetime.
   */
  readonly ownership?: AttemptLeaseOwnership;
}

/**
 * Request-scoped accounting versus session-scoped ownership.
 *
 * One HTTP request = one admission lease, one reservation, one pool slot. One
 * Cursor Run = one upstream turn that can span several HTTP requests, and it
 * must keep the slot for the whole turn. Transferring ownership is the only way
 * to satisfy both: the request settles its own accounting and stops owning the
 * release; the session owns it until the Run terminates.
 *
 * Idempotent by construction — the release is handed over at most once, and a
 * second transfer attempt gets `undefined` so nothing is released twice.
 */
export class AttemptLeaseOwnership {
  #transferred = false;

  constructor(private readonly release: () => void) {}

  /**
   * Hands the release to a provider session. Returns the release to call
   * exactly once when the session terminates, or `undefined` when this attempt
   * already transferred it (or released it itself).
   */
  transferToProviderSession(): (() => void) | undefined {
    if (this.#transferred) return undefined;
    this.#transferred = true;
    const release = this.release;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /**
   * Releases only when ownership was never transferred — the ordinary
   * end-of-request path. Returns false when a session owns it, so the caller
   * can see that the slot outlives this request.
   */
  releaseByResponse(): boolean {
    if (this.#transferred) return false;
    this.#transferred = true;
    this.release();
    return true;
  }
}

export interface AttemptLeaseSource {
  readonly admissionService: ApiKeyAdmissionService;
  readonly routingEngine: RoutingEngine;
  readonly plan: RoutePlan;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly authorizationSnapshot: ApiKeyAuthorizationSnapshot;
  /**
   * True when this request continues a provider session the gateway already
   * holds, so its account and network-pool slot are already occupied by that
   * session.
   *
   * A Cursor tool-result request borrows the held Run: it talks to the socket
   * that is already open and does not open another connection. Acquiring a
   * second pool slot would charge one logical upstream turn two concurrency
   * slots — and, with a pool at its limit, would make the continuation fail
   * with `proxy_pool_capacity_exceeded` for a turn that is already inside it.
   *
   * Admission (API-key authorization) and the routing reservation still run:
   * per-request accounting is per request.
   */
  readonly borrowsHeldSession?: boolean;
}

async function acquirePoolSlot(
  candidate: RouteCandidate,
  source: AttemptLeaseSource,
  poolSelector: NetworkPoolSelector | undefined,
  strictPoolSelection: boolean,
): Promise<{ poolId: string; release: () => void } | undefined> {
  let poolIds = candidate.network_pool_ids;
  let limits = candidate.network_pool_limits;
  let weights = candidate.network_pool_weights;
  let routing = candidate.network_pool_routing;
  let providerLimit = candidate.network_pool_provider_limit;
  if (!poolIds?.length && !candidate.network_pool_required && source.plan.candidates) {
    const sibling = source.plan.candidates.find(
      (c) =>
        c.provider_id === candidate.provider_id &&
        c.tenant_id === candidate.tenant_id &&
        c.network_pool_ids?.length,
    );
    if (sibling?.network_pool_ids?.length) {
      poolIds = sibling.network_pool_ids;
      limits = sibling.network_pool_limits;
      weights = sibling.network_pool_weights;
      routing = sibling.network_pool_routing;
      providerLimit = sibling.network_pool_provider_limit;
    }
  }
  // Round-robin rotation rides the strategy the snapshot attached to the
  // candidate (the pool-owning tenant scopes the cursor); `random` scatters
  // each selection across eligible pools. Absent strategy or `least_loaded`
  // keeps the default weighted least-loaded scan.
  const rotation: PoolRotation | undefined =
    routing?.strategy === "round_robin" || routing?.strategy === "random"
      ? {
          key: routing.tenantId,
          rotateCount: routing.rotateCount,
          strategy: routing.strategy,
        }
      : undefined;

  if (!poolIds?.length || !poolSelector) {
    if (candidate.network_pool_required && strictPoolSelection) {
      throw new GatewayError(
        "proxy_pool_unhealthy",
        503,
        "Every proxy pool this route requires is unhealthy or disabled (request {requestId}). Repair a pool, or relax the route's pool requirement. This bridge looks shaky — repair or reroute 🔧",
        { reason: "no_healthy_pool" },
        "network",
      );
    }
    return undefined;
  }
  if (!strictPoolSelection) {
    return poolSelector.tryAcquireAvailablePool(
      poolIds,
      candidate.provider_id,
      limits,
      weights,
      rotation,
      providerLimit,
    );
  }
  let acquiredSlot: { poolId: string; release: () => void } | undefined;
  try {
    acquiredSlot = await poolSelector.tryAcquireAvailablePool(
      poolIds,
      candidate.provider_id,
      limits,
      weights,
      rotation,
      providerLimit,
    );
  } catch {
    throw new GatewayError(
      "proxy_pool_unavailable",
      503,
      "No active proxy pool is available because coordination is unavailable (request {requestId}). The bouncer stepped out — come back shortly 🚪",
      { reason: "coordination_unavailable" },
      "network",
    );
  }
  if (acquiredSlot) return acquiredSlot;
  const poolDetails = poolIds.map((poolId) => {
    const maxInflight = limits?.[poolId] ?? 10;
    const weight = weights?.[poolId] ?? 100;
    const currentInflight =
      typeof poolSelector.getInflight === "function" ? poolSelector.getInflight(poolId) : 0;
    return {
      poolId,
      maxInflight,
      weight,
      currentInflight,
      available: Math.max(0, maxInflight - currentInflight),
    };
  });
  const failure: PoolSelectionFailure =
    typeof poolSelector.getSelectionFailure === "function"
      ? await poolSelector.getSelectionFailure(
          poolIds,
          candidate.provider_id,
          limits,
          weights,
          providerLimit,
        )
      : { reason: "at_capacity" as const, pools: poolDetails };
  // One message per outcome, each naming the one action that fixes it. A
  // blocked egress is never described as a cooldown: nothing clears it on a
  // timer, so "retry shortly" would send the operator to wait for something
  // that will not happen.
  const code =
    failure.reason === "at_capacity"
      ? "proxy_pool_capacity_exceeded"
      : failure.reason === "provider_at_capacity"
        ? "proxy_pool_provider_capacity_exceeded"
        : failure.reason === "blocked"
          ? "proxy_pool_blocked"
          : failure.reason === "cooldown"
            ? "proxy_pool_cooldown"
            : "proxy_pool_unavailable";
  const status =
    failure.reason === "at_capacity" || failure.reason === "provider_at_capacity" ? 429 : 503;
  const message =
    failure.reason === "at_capacity"
      ? "Every proxy pool for this provider is at its concurrency limit (request {requestId}). Retry shortly, or add a pool or raise its capacity. The pools are full right now — chill 🌊"
      : failure.reason === "provider_at_capacity"
        ? "Every proxy pool has reached this provider's per-proxy concurrency limit (request {requestId}). Retry shortly, raise the limit in the provider's routing settings, or add a pool. The proxies are working overtime — hang tight ⚡️"
        : failure.reason === "blocked"
          ? "All proxy pools are saturated for this provider (request {requestId}): the upstream refuses every egress configured for it. Replace a blocked proxy, or add one the upstream has not flagged. All roads blocked — time to find a new route 🗺️"
          : failure.reason === "cooldown"
            ? "Every proxy pool for this provider is cooling down after upstream failures (request {requestId}). Retry once the cooldown resets. The proxies are catching their breath — zzz 💤"
            : "No active proxy pool is configured for this tenant and provider (request {requestId}). Add one, or route this provider through direct egress. No bridge to cross — configure a pool first 🏗️";
  throw new GatewayError(code, status, message, {
    pools: failure.pools,
    // Only measured evidence: a cooldown's real reset instant. The
    // `at_capacity` 429 carries no hint at all — how long until a slot frees is
    // not known here — so it keeps the documented one-second floor the error
    // normalization applies to every evidence-free 429, rather than this path
    // asserting a fabricated 1000ms that only happened to match it.
    ...(failure.retryAt ? { retryAt: new Date(failure.retryAt).toISOString() } : {}),
  });
}

export async function acquireAttemptLeases(
  source: AttemptLeaseSource,
  candidate: RouteCandidate,
  input: {
    readonly signal: AbortSignal;
    readonly poolSelector?: NetworkPoolSelector;
    readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
    readonly host?: ByokUpstreamHost;
    readonly strictPoolSelection: boolean;
  },
): Promise<AttemptLeases> {
  const partial: {
    lease?: AdmissionLease;
    reservation?: Reservation;
    proxySlot?: { poolId: string; release: () => void };
  } = {};
  try {
    partial.lease = await source.admissionService.admit({
      authorization: source.authorizationSnapshot,
      targetProvider: candidate.provider_id,
      targetModel: candidate.model_id,
      // The caller-facing name (alias/combo) this candidate was resolved
      // from. Admission authorizes it too, so an allowlisted alias works.
      requestedModel: source.plan.requested_model,
      estimatedInputTokens: source.estimatedInputTokens,
      estimatedOutputTokens: source.estimatedOutputTokens,
      signal: input.signal,
    });
    // Pre-dispatch fail-closed check for configurable (BYOK) upstreams: a host
    // whose advertised addresses fail the SSRF policy must be rejected before
    // any egress is attempted. The resolved destination is deliberately
    // discarded — the validated outbound fetch re-resolves and pins the
    // address per request, so storing it here would only pin a stale answer.
    if (input.networkBindingFactory && input.host)
      await input.networkBindingFactory.resolve(input.host.hostname, input.signal, input.host.port);
    // A continuation borrows the session's slot; see `borrowsHeldSession`.
    const slot = source.borrowsHeldSession === true
      ? undefined
      : await acquirePoolSlot(candidate, source, input.poolSelector, input.strictPoolSelection);
    if (slot) partial.proxySlot = slot;
    if (input.strictPoolSelection && input.signal.aborted)
      throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
    partial.reservation = await source.routingEngine.reserve({
      ...source.plan,
      candidates: [candidate],
    });
    return {
      lease: partial.lease,
      reservation: partial.reservation,
      ...(partial.proxySlot ? { proxySlot: partial.proxySlot } : {}),
      ...(partial.proxySlot ? { networkPoolId: partial.proxySlot.poolId } : {}),
      // The pool slot is the one resource a provider session can outlive, so it
      // is the one wrapped in a transferable owner. The admission lease and the
      // routing reservation stay request-scoped: the account's concurrency slot
      // is held for the Run's duration, while per-request usage settles per
      // request.
      ...(partial.proxySlot
        ? { ownership: new AttemptLeaseOwnership(partial.proxySlot.release) }
        : {}),
    };
  } catch (error) {
    await releaseAttemptLeases(partial, source.routingEngine);
    throw error;
  }
}

export async function releaseAttemptLeases(
  leases: {
    readonly lease?: AdmissionLease | undefined;
    readonly reservation?: Reservation | undefined;
    readonly proxySlot?: { release: () => void } | undefined;
    /**
     * When present, the pool slot's release is owned rather than called
     * directly: `releaseByResponse()` releases only if a provider session did
     * not take it over. A slot a live Cursor Run is holding must not be freed
     * at response time — the Run's next request needs it, and releasing early
     * is what lets another tenant's request occupy a slot that is still in use.
     */
    readonly ownership?: AttemptLeaseOwnership | undefined;
  },
  routingEngine: Pick<RoutingEngine, "release">,
): Promise<void> {
  // Every release runs inside the settled set: a throwing pool-slot release
  // must not skip the admission lease or routing reservation (slot + inflight
  // leak). Sync release is wrapped so it participates in the same guarantee.
  // When ownership exists it supersedes the raw slot release: calling both
  // would release twice, and `releaseByResponse` is the single-shot gate.
  await Promise.allSettled([
    ...(leases.ownership
      ? [Promise.resolve().then(() => leases.ownership?.releaseByResponse())]
      : leases.proxySlot
        ? [Promise.resolve().then(() => leases.proxySlot?.release())]
        : []),
    ...(leases.lease ? [leases.lease.release()] : []),
    ...(leases.reservation ? [routingEngine.release(leases.reservation)] : []),
  ]);
}