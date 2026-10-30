/**
 * Shared per-candidate attempt lifecycle for every dispatch route.
 *
 * Admission lease → pool slot → routing reservation, the route-specific
 * upstream operation, then one `completeAttempt` for the attempt's accounting.
 * Retry, backoff, pool-cooldown flagging, and reactive OAuth refresh are one
 * policy here, so the canonical proxy routes and the native Responses-compact
 * route cannot drift. Route-specific behavior arrives as the `prepare` and
 * `attempt` closures; this module never forks retry policy.
 */
import { GatewayError } from "../../protocol/gateway-error";
import type { ResolvedCredential } from "../../providers/provider-contracts";
import {
  classifyTerminalOutcome,
  fallbackRetryDelayMs,
  isRetryableFailure,
  MIN_RETRY_BUDGET_MS,
  sleep,
} from "../failure-policy";
import { resolveRouteMaxAttempts } from "../../config/timeouts";
import type { OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";
import type { OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { RouteCandidate, Reservation, RouteSnapshotService } from "../routing/route-model";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { acquireAttemptLeases, releaseAttemptLeases } from "./leases";
import type { AttemptLeaseSource, AttemptLeases } from "./leases";
import type { AttemptLeaseOwnership } from "./leases";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ProxyRequestState } from "../request/state";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { flagPoolBlocked, flagPoolCooldown } from "../../network/pool-health";
import {
  completeAttempt,
  errorClientResponseBody,
  estimatedUsage,
  type AttemptCompletion,
  type ProviderExchangeCapture,
} from "./attempt-finalize";
import { repriceUsage } from "../../providers/provider-usage";
import { isFreeTierIpBlock, isOAuthCredentialInvalidated, shouldCooldownPool } from "./retry-policy";
import { drainAbortReason } from "../shutdown-notice";

/**
 * Identity of one combo member for the request-scoped failure flag.
 *
 * Account, model, and endpoint distinguish siblings that share a provider.
 * The flag lives only for this request: it stops a failed member from being
 * retried while another member remains, without writing a durable cooldown.
 */
function comboCandidateKey(candidate: RouteCandidate): string {
  return [
    candidate.provider_id,
    candidate.provider_account_id ?? "global",
    candidate.model_id,
    candidate.endpoint,
  ].join(":");
}

/**
 * Which combo member a candidate belongs to.
 *
 * A combo's members are distinct models (usually one per provider), so the
 * model id is what separates them — the accounts of one member are siblings
 * that share it. Used only to give each member its own share of the attempt
 * budget; a candidate list that is not a combo collapses to one member, which
 * keeps the ordinary single-model path untouched.
 */
function comboMemberKey(candidate: RouteCandidate): string {
  return `${candidate.provider_id}:${candidate.model_id}:${candidate.endpoint}`;
}

/**
 * One member's ordinal, resolved by *identity* rather than by position.
 *
 * Deliberately not a run-length scan. `plan()` reorders the eligible list — its
 * cooling partition emits every healthy candidate before every cooling one — so
 * one member's accounts can be non-contiguous and even interleaved with another
 * member's. A run-length scan then reports more "members" than actually exist:
 * `[cb, wb, cb, wb]` counts four, which pushed each member's skip threshold to
 * `cap * 4` — well past the whole budget — and silently disabled the cap on
 * exactly the degraded lists it exists for.
 *
 * Keyed off the same string the member count is derived from, so the two can
 * never disagree.
 */
function buildMemberOrdinals(
  candidates: readonly RouteCandidate[],
): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  for (const candidate of candidates) {
    const key = comboMemberKey(candidate);
    if (!ordinals.has(key)) ordinals.set(key, ordinals.size);
  }
  return ordinals;
}

/** Build the common failure payload; the call site supplies only attempt-specific decisions. */
function failureCompletion(input: {
  readonly state: ProxyRequestState;
  readonly deps: AttemptLoopDeps;
  readonly candidate?: RouteCandidate | undefined;
  readonly status: AttemptCompletion["status"];
  readonly errorCategory?: string;
  readonly errorOrigin?: string;
  readonly error: unknown;
  readonly tenantId: string | null;
  readonly terminal: boolean;
  readonly networkPoolId?: string | undefined;
  readonly lease?: AdmissionLease | undefined;
  readonly commitUsage?: AttemptCompletion["commitUsage"];
  readonly providerCapture?: ProviderExchangeCapture | undefined;
  readonly includeClientResponse: boolean;
}): AttemptCompletion {
  const { state, deps, candidate } = input;
  return {
    status: input.status,
    providerId: candidate?.provider_id ?? "",
    ...(candidate?.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
    ...(candidate?.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
    ...(candidate?.model_id === undefined ? {} : { modelId: candidate.model_id }),
    ...(input.networkPoolId === undefined ? {} : { networkPoolId: input.networkPoolId }),
    ...(input.errorCategory === undefined ? {} : { errorCategory: input.errorCategory }),
    ...(input.errorOrigin === undefined ? {} : { errorOrigin: input.errorOrigin }),
    error: input.error,
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    ...(input.commitUsage === undefined ? {} : { commitUsage: input.commitUsage }),
    terminal: input.terminal,
    tenantId: input.tenantId,
    ingressBody: state.ingressBody,
    responseBody: null,
    ...(input.includeClientResponse && input.status !== "cancelled"
      ? { clientResponseText: errorClientResponseBody(input.error) }
      : {}),
    ...(input.providerCapture === undefined ? {} : { providerCapture: input.providerCapture }),
    db: deps.db,
    ...(deps.telemetryBuffer === undefined ? {} : { telemetryBuffer: deps.telemetryBuffer }),
    ...(deps.snapshotService === undefined ? {} : { snapshotService: deps.snapshotService }),
  };
}

/** Route-specific preconditions resolved for one candidate before its leases are taken. */
interface PreparedAttempt<TAdapter> {
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
}

/** One candidate attempt with its admission lease, pool slot, and reservation held. */
interface AttemptContext<TAdapter> {
  readonly candidate: RouteCandidate;
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
  readonly leases: AttemptLeases;
  /** Zero-based candidate index; also this attempt's failover count. */
  readonly attemptIndex: number;
  readonly providerCapture: ProviderExchangeCapture;
  /**
   * Ownership of this attempt's account/network-pool release, when the route
   * acquired a pool slot. A provider session that outlives this request (a
   * Cursor Run held open for the client's tool result) calls
   * `transferToProviderSession()` and takes it over; otherwise the request
   * releases it through `releaseByResponse()`.
   */
  readonly leaseOwnership?: AttemptLeaseOwnership | undefined;
  /**
   * Hands lease ownership to the value this attempt returns (a streaming
   * response releases its own lease on stream completion/cancel). Without it
   * the loop releases the leases in `finally`.
   */
  retainLeases(): void;
}

/** Collaborators shared by every dispatch route. */
interface AttemptLoopDeps {
  readonly db: CartethyiaDatabase;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

interface AttemptLoopInput<TResult, TAdapter> {
  readonly state: ProxyRequestState;
  readonly deps: AttemptLoopDeps;
  readonly leaseSource: AttemptLeaseSource;
  readonly candidates: readonly RouteCandidate[];
  readonly tenantId: string | null;
  /** Strict pool selection rejects direct egress when every pool is at capacity. */
  readonly strictPoolSelection: boolean;
  /** BYOK host for a candidate, when this route validates network bindings. */
  readonly resolveHost?: (candidate: RouteCandidate) => ByokUpstreamHost | undefined;
  readonly prepare: (candidate: RouteCandidate) => Promise<PreparedAttempt<TAdapter>>;
  readonly attempt: (context: AttemptContext<TAdapter>) => Promise<TResult>;
  /** Raised when the candidate list is empty and no attempt ever ran. */
  readonly exhaustedError: GatewayError;
}

/**
 * Shared per-candidate attempt lifecycle for the canonical proxy routes and
 * the native Responses-compact route: admission lease → pool slot → routing
 * reservation, the route-specific upstream operation, then one
 * `completeAttempt` for the attempt's accounting. Retry, backoff,
 * pool-cooldown flagging, and reactive OAuth refresh are one policy here, so
 * the two routes cannot drift.
 */
export async function runAttemptLoop<TResult, TAdapter>(
  input: AttemptLoopInput<TResult, TAdapter>,
): Promise<TResult> {
  const { state, deps, leaseSource } = input;
  const candidates = [...input.candidates];
  let lastError: unknown = input.exhaustedError;
  const refreshedCandidates = new Set<string>();
  const failedCandidates = new Set<string>();
  // Every attempt owns a fresh capture sink, but only the terminal attempt's
  // sink reaches the payload store. When the terminal attempt fails before it
  // fires an outbound request (lease/acquire/prepare threw, or failover
  // exhausted), its sink is empty and the drawer reads "—" for a request that
  // DID reach an upstream on an earlier attempt. Only the LAST fired exchange
  // is ever consulted — every consumer below falls back to the most recent
  // capture that has a request — so this holds one reference, not the whole
  // history: a request walking N attempts used to pin N provider exchanges
  // (each holding its bounded provider tee) alive until the loop returned.
  // Earlier attempts' captures are released as each new attempt fires; the
  // payload store's own bounded writer is what bounds anything persisted.
  let lastFiredCapture: ProviderExchangeCapture | undefined;
  const maxAttempts = resolveRouteMaxAttempts();
  // One combo member must not be able to spend the whole budget.
  //
  // A combo's member list is flattened into this candidate list, so the first
  // member's accounts occupy its head. With one member holding more accounts
  // than `maxAttempts` (default 8), every attempt was spent inside that member
  // and a later, perfectly healthy member was never dialed — a `deepseek` combo
  // of [cb, wb] stayed stuck on cb while wb sat idle, because cb's twelve
  // accounts exhausted all eight attempts before the list reached wb.
  //
  // Each member gets an equal share of the budget, counted **per member** — not
  // as a cumulative watermark over total attempts, or one member that over-runs
  // silently steals the tail's share. The share is a ceiling, not a reservation:
  // a member that used less than its share simply never reaches it, and the
  // unused budget stays available to the members behind it.
  const memberOrdinals = buildMemberOrdinals(candidates);
  const memberCount = memberOrdinals.size;
  const perMemberCap =
    memberCount > 1 ? Math.max(1, Math.ceil(maxAttempts / memberCount)) : maxAttempts;
  const attemptsByMember = new Map<string, number>();
  // The budget itself is owned by failure-policy, so this loop, the
  // empty-stream replay, and the Codex retry budget cannot drift apart.
  let index = 0;
  let attempts = 0;
  while (index < candidates.length && attempts < maxAttempts) {
    const candidate = candidates[index];
    if (!candidate) break;
    const memberKey = comboMemberKey(candidate);
    // A member that has spent its share is skipped: the loop advances past the
    // rest of its accounts to the next member instead of burning the budget
    // they would have consumed.
    if (
      memberCount > 1 &&
      (attemptsByMember.get(memberKey) ?? 0) >= perMemberCap
    ) {
      index += 1;
      continue;
    }
    // Do not start an attempt that cannot finish. The measured pre-dispatch
    // cost of the previous attempt (`resolveMs` ran 60s+ on a slow upstream)
    // is what a follow-on attempt has to spend again before the upstream is
    // even called, so a retry that begins with less than that left is a retry
    // the deadline will kill mid-flight. Stopping here surfaces the first
    // attempt's own error instead of a second one's timeout.
    if (attempts > 0) {
      const remainingMs = state.deadlineMs - Date.now();
      if (remainingMs < MIN_RETRY_BUDGET_MS) {
        if (lastError !== undefined && !state.completed) {
          const terminal = classifyTerminalOutcome(lastError, state.abortController.signal);
          const lastFired =
            lastFiredCapture?.request !== null && lastFiredCapture !== undefined
              ? lastFiredCapture
              : undefined;
          await completeAttempt(state, failureCompletion({
            state,
            deps,
            candidate,
            status: terminal.status,
            errorCategory: terminal.errorCategory,
            errorOrigin: terminal.errorOrigin,
            ...(terminal.httpStatus === undefined ? {} : { terminalHttpStatus: terminal.httpStatus }),
            error: lastError,
            tenantId: input.tenantId,
            terminal: true,
            providerCapture: lastFired,
            includeClientResponse: true,
          }));
          metrics.proxy_requests_total.inc(1, {
            status: terminal.status === "cancelled" ? "cancelled" : "failed",
          });
        }
        throw lastError;
      }
    }
    let lease: AdmissionLease | undefined;
    let reservation: Reservation | undefined;
    let proxySlot: { poolId: string; release: () => void } | undefined;
    let networkPoolId: string | undefined;
    let leaseOwnership: AttemptLeaseOwnership | undefined;
    let bindingEstablished = false;
    let leasesRetained = false;
    let retryDelayMs = 0;
    const providerCapture: ProviderExchangeCapture = {
      request: null,
      response: Promise.resolve(null),
    };
    try {
      if (state.abortController.signal.aborted)
        throw new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
      const { credential, adapter } = await input.prepare(candidate);
      const host = input.resolveHost?.(candidate);
      // Single attempt-lease manager owns acquisition order (admission →
      // pool slot → reservation) with reverse-order unwind. Assigned only on
      // success, so a mid-acquire throw leaves these undefined for `finally`.
      const attemptLeases = await acquireAttemptLeases(leaseSource, candidate, {
        signal: state.abortController.signal,
        ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
        ...(deps.networkBindingFactory ? { networkBindingFactory: deps.networkBindingFactory } : {}),
        ...(host ? { host } : {}),
        strictPoolSelection: input.strictPoolSelection,
      });
      lease = attemptLeases.lease;
      reservation = attemptLeases.reservation;
      proxySlot = attemptLeases.proxySlot;
      networkPoolId = attemptLeases.networkPoolId;
      leaseOwnership = attemptLeases.ownership;
      // Downstream error paths gate `commitUsage(estimated)` on this flag so
      // the estimate is only charged once the request truly consumed
      // upstream resources; the lease and reservation are held from here on.
      bindingEstablished = true;
      state.startProviderFlight();
      return await input.attempt({
        candidate,
        credential,
        adapter,
        leases: attemptLeases,
        attemptIndex: index,
        providerCapture,
        ...(leaseOwnership === undefined ? {} : { leaseOwnership }),
        retainLeases: () => {
          leasesRetained = true;
        },
      });
    } catch (error) {
      // A drain aborts the controller, so a mid-flight attempt unwinds here as
      // an abort. Surface the typed shutdown error (503 shutting_down /
      // restart_for_update) instead of an opaque `transport_closed`, so the
      // client's JSON error — not just the SSE path — names the real cause.
      const drain = drainAbortReason(state.abortController.signal.reason);
      if (drain !== undefined) error = drain;
      lastError = error;
      // A drain is a *server* close, not a client cancel: it must be recorded
      // as a failure with the shutdown code, and it is never retryable.
      // Status, category, and origin come from one classifier so they cannot
      // disagree and mark a `cancelled` row `transport_unavailable`/502.
      const terminal = classifyTerminalOutcome(error, state.abortController.signal);
      const cancelled = terminal.status === "cancelled";
      // A failure the *pool* caused retires that pool, not the candidate: the
      // next attempt keeps the same provider/model/account and selects a
      // different egress. That is a genuinely new attempt even though the
      // candidate index does not move, so it must not be judged terminal by
      // "this was the last candidate" — that rule is about candidates, and
      // opencode has exactly one (it is credential-less, so the plan holds a
      // single candidate carrying every pool). Judging it there is what made a
      // refused egress end the request instead of failing over to a healthy
      // one.
      const rateLimitedPool = !cancelled && shouldCooldownPool(error, candidate.provider_id);
      // A free-tier refusal is only ever this provider's: the guard is gated on
      // `ipScopedRateLimit` in the provider metadata, so a 403 from any other
      // upstream still means what it always did and never retires an egress.
      const blockedPool = !cancelled && isFreeTierIpBlock(error, candidate.provider_id);
      const poolScopedFailure =
        (rateLimitedPool || blockedPool) &&
        networkPoolId !== undefined &&
        deps.poolSelector !== undefined;
      // Flag before the decision below, so the retry that follows already sees
      // the pool excluded. Both flag helpers write the local entry
      // synchronously, so the ordering holds even though the Redis mirror is
      // fire-and-forget.
      if (networkPoolId && deps.poolSelector && error instanceof GatewayError) {
        if (rateLimitedPool) {
          flagPoolCooldown(deps.poolSelector, deps.db, networkPoolId, candidate.provider_id, error);
        } else if (blockedPool) {
          // The address itself is refused, not the request: retire the egress
          // so the next attempt leaves by a different one instead of retrying
          // a proxy the upstream has already flagged.
          flagPoolBlocked(deps.poolSelector, deps.db, networkPoolId, candidate.provider_id, error);
        }
      }
      const terminalAttempt =
        cancelled ||
        !isRetryableFailure(error) ||
        (index === candidates.length - 1 && !poolScopedFailure);
      // Track only the most recent fired exchange; the array this replaced
      // accumulated every attempt's capture until the loop returned.
      if (providerCapture.request !== null) lastFiredCapture = providerCapture;
      // The payload store only keeps the terminal attempt's exchange. When the
      // terminal attempt never fired (failover walked past the attempt that
      // did, or prepare/lease threw first), fall back to the last fired
      // exchange so Request Detail still shows the translated provider
      // request instead of "—" for a request that reached an upstream.
      const terminalCapture =
        providerCapture.request !== null
          ? providerCapture
          : lastFiredCapture ?? providerCapture;
      await completeAttempt(state, failureCompletion({
        state,
        deps,
        candidate,
        status: terminal.status,
        errorCategory: terminal.errorCategory,
        errorOrigin: terminal.errorOrigin,
        ...(terminal.httpStatus === undefined ? {} : { terminalHttpStatus: terminal.httpStatus }),
        error,
        tenantId: input.tenantId,
        terminal: terminalAttempt,
        networkPoolId,
        lease,
        // A failed attempt may have sent bytes upstream, so it is not free —
        // but it must not be charged the full input estimate plus a full
        // output reserve either, because a request that walks N candidates
        // would then leave N estimates on the counters for one client request.
        // Commit the input estimate only: nothing was generated, and the
        // `finally` release then refunds the (uncommitted) output reserve.
        commitUsage: !cancelled && bindingEstablished
          ? repriceUsage(
              estimatedUsage(leaseSource.estimatedInputTokens, 0),
              candidate.provider_id,
              candidate.model_id,
            )
          : undefined,
        // The client still receives the public error envelope on the wire —
        // store it so Request Detail's Client Response panel traces failures
        // exactly as the client saw them. Cancelled requests have no client
        // response (the caller is gone).
        providerCapture: terminalCapture,
        includeClientResponse: terminalAttempt,
      }));
      // A 403 can be a deterministic provider policy rejection, not an
      // invalid OAuth credential. Only the evidence-based classifier above
      // may trigger a refresh.
      const candidateKey = `${candidate.provider_id}:${candidate.provider_account_id ?? "global"}:${candidate.model_id}:${candidate.endpoint}`;
      const authInvalidated = isOAuthCredentialInvalidated(error);
      if (
        !cancelled &&
        !refreshedCandidates.has(candidateKey) &&
        authInvalidated &&
        candidate.provider_account_id &&
        deps.oauthRefreshService &&
        deps.resolveOAuthRefresher
      ) {
        const refresher = await deps.resolveOAuthRefresher(candidate.provider_id);
        if (refresher) {
          const fresh = await deps.oauthRefreshService.ensureFreshAccessToken(
            candidate.provider_account_id,
            refresher,
            { force: true },
          );
          if (fresh) {
            refreshedCandidates.add(candidateKey);
            continue;
          }
        }
      }
      if (terminalAttempt) {
        metrics.proxy_requests_total.inc(1, { status: cancelled ? "cancelled" : "failed" });
        throw error;
      }
      // A failed combo member stays flagged for this request. Move it behind
      // every candidate that has not failed yet, so the next attempt cannot
      // stick to it while a sibling remains. It becomes eligible again only
      // after that sibling list is exhausted.
      //
      // A pool-scoped failure is exempt: the candidate never got its turn, so
      // marking it failed would spend its only remaining chance on the pool
      // that just refused it. The candidate stays at the head, and the next
      // attempt selects a different pool for it. The attempt budget still
      // bounds the loop, and once every pool is retired the selection itself
      // fails with `proxy_pool_blocked`, which is terminal.
      const failureKey = comboCandidateKey(candidate);
      if (poolScopedFailure) {
        // Deliberately no index movement and no `failedCandidates` entry.
      } else if (!failedCandidates.has(failureKey)) {
        failedCandidates.add(failureKey);
        candidates.push(candidates.splice(index, 1)[0]!);
      } else {
        index += 1;
      }
      retryDelayMs = fallbackRetryDelayMs(attempts);
    } finally {
      if (!leasesRetained)
        await releaseAttemptLeases(
          { lease, reservation, proxySlot, ...(leaseOwnership === undefined ? {} : { ownership: leaseOwnership }) },
          leaseSource.routingEngine,
        );
    }
    attempts += 1;
    // Charged to the member that spent it, so one member's own attempts are
    // what exhaust its share — not the running total across every member.
    attemptsByMember.set(memberKey, (attemptsByMember.get(memberKey) ?? 0) + 1);
    if (retryDelayMs > 0) {
      try {
        await sleep(retryDelayMs, state.abortController.signal);
      } catch {
        // Fail with the last attempt's error so the client sees the real cause,
        // counted once: attempts already recorded their telemetry, but escaping
        // as the sleep's own error would leave `proxy_requests_total` missing
        // the request.
        metrics.proxy_requests_total.inc(1, { status: "cancelled" });
        throw lastError;
      }
    }
  }
  // The loop can fall out with a retryable error still in hand (every attempt
  // was retryable, so the terminal branch in the catch never fired). Throwing
  // here instead of recording it would leave no telemetry row, no payload
  // capture, and `state.completed` clear — so a request that genuinely
  // exhausted its attempts would be invisible in Request Detail. Record it as
  // terminal here.
  if (!state.completed) {
    const terminal = classifyTerminalOutcome(lastError, state.abortController.signal);
    const lastCandidate = candidates[Math.min(index, candidates.length - 1)];
    const terminalCapture =
      lastFiredCapture?.request !== null && lastFiredCapture !== undefined
        ? lastFiredCapture
        : undefined;
    await completeAttempt(state, failureCompletion({
      state,
      deps,
      candidate: lastCandidate,
      status: terminal.status,
      errorCategory: terminal.errorCategory,
      errorOrigin: terminal.errorOrigin,
      ...(terminal.httpStatus === undefined ? {} : { terminalHttpStatus: terminal.httpStatus }),
      error: lastError,
      terminal: true,
      tenantId: input.tenantId,
      // The client receives the public error envelope on the wire — store it
      // so the Client Response panel traces the failure as the client saw it.
      providerCapture: terminalCapture,
      includeClientResponse: true,
    }));
  }
  metrics.proxy_requests_total.inc(1, { status: "failed" });
  throw lastError;
}
