import { GatewayError } from "../../protocol/gateway-error";
import type { CanonicalRequest, UsageRecord } from "../../protocol/canonical-model";
import type { ClientIdentity } from "../../security/abuse";
import type { ResolvedApiKey } from "../../security/api-key-auth";
import type { PreparedProxyRequest } from "./preparer";
import type { PayloadCaptureState, TelemetryPayloadCapture } from "../../observability/payload-capture";
import type { TelemetryPayloadDepth, TelemetryPayloadMode } from "../../console/settings/contracts";
import { log } from "../../observability/logger";
import type { InFlightSnapshot } from "./inflight";
import { fastPathname } from "../pathname";

export interface ProxyRequestOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "truncated";
  /**
   * HTTP status the client received. The outcome `status` is the internal
   * terminal state; this is its wire projection, so a 400 stays a 400 in
   * Console Log / telemetry instead of collapsing to 500.
   */
  readonly httpStatus?: number;
  readonly providerId?: string;
  readonly accountId?: string;
  /** Operator-facing account label, when known — Console Log shows this
   * instead of the opaque `accountId`. */
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly errorCategory?: string;
  /**
   * Layer that produced the failure (`cartethyia` | `upstream` | `network`).
   * Recorded beside `errorCategory` because a code alone cannot say whether the
   * gateway rejected the request or the provider did.
   */
  readonly errorOrigin?: string;
  readonly usage?: UsageRecord;
  /**
   * The `model` the upstream put in its own response, verbatim.
   *
   * Distinct from the model the request asked for. A provider that answers a
   * `muse-spark` request as `deepseek-v4.1-flash` is telling the operator
   * something the request cannot; recording the ask as if it were the answer
   * would hide exactly that. Absent when the response carried no `model`.
   */
  readonly reportedModel?: string;
  readonly ttfbMs?: number;
  readonly tokensPerSec?: number;
  /** First meaningful content delta timestamp (for TTFT calculation). */
  readonly firstContentDeltaAtMs?: number;
  /** Last event timestamp (for generation duration calculation). */
  readonly lastEventAtMs?: number;
  /**
   * True for a completed request whose output was far smaller than the model's
   * ceiling and which ended with an ordinary `stop` (a "degenerate stop").
   * Set by completion bookkeeping; carried onto the telemetry row.
   */
  readonly degenerateStop?: boolean;
}
export interface ProxyRequestState {
  readonly requestId: string;
  readonly startedAtMs: number;
  /** Timestamp set when the adapter's upstream fetch / streaming iterator begins. */
  upstreamDispatchStartedAtMs?: number;
  /** Start one logical provider flight after dispatch leases are acquired. */
  startProviderFlight(): void;
  deadlineMs: number;
  readonly abortController: AbortController;
  /** Body decoded by the single ingress reader, when this is a proxy request. */
  ingressBody?: unknown;
  /**
   * Drops the parsed ingress body once it can no longer be needed.
   *
   * The parsed body is the largest per-request value and, for a canonical
   * request, only payload capture reads it after the canonical request exists.
   * Capture reads it at finalize — after the whole upstream stream — so the
   * dispatch path calls this before dispatch when the tenant's capture mode
   * does not keep request bodies. The object then becomes unreachable and is
   * reclaimed, instead of being held for the request's lifetime.
   */
  releaseIngressBody(): void;
  /** Inbound method/path are retained for structured Console Log events. */
  ingressMethod?: string;
  ingressPath?: string;
  /** Inbound `user-agent` header (capped) stashed for telemetry. */
  clientUserAgent?: string;
  clientIdentity?: ClientIdentity;
  authorization?: ResolvedApiKey;
  canonicalRequest?: CanonicalRequest;
  preparedRequest?: PreparedProxyRequest;
  outcome?: ProxyRequestOutcome;
  /**
   * Payload capture for this request, stashed so a rejection that never
   * reaches `completeAttempt` can still record what the client sent. Set on
   * the same code path that builds the dispatch deps; optional because a
   * route may decline to capture.
   */
  payloadCapture?: TelemetryPayloadCapture;
  /**
   * The error envelope the client was given, for a rejection raised before
   * dispatch. `attempt-finalize` derives this for dispatched attempts; an
   * early rejection has no attempt, so it is recorded here instead and both
   * paths end up with the same four panels populated.
   */
  clientResponseText?: string;
  /**
   * Why this request's drawer payloads were not captured, or `captured` when
   * they were. Written by the capture path and read by telemetry finalization.
   *
   * Remote-diagnosis field: the drawer reads empty for reasons invisible from
   * the client — the tenant's capture mode, a missing tenant, a non-terminal
   * attempt — and without the reason an operator cannot tell "not configured"
   * from "broken". The four panels are the only surface that could hint at it,
   * and they look identical in both cases.
   */
  payloadCaptureState?: PayloadCaptureState;
  /**
   * This request's resolved payload-capture preference, memoized on the request.
   *
   * The preference is a tenant setting, so it cannot change between attempts of
   * one request. It is read twice — once per attempt to decide whether to tee
   * the provider body, and again on the terminal attempt to decide what to
   * store — so memoizing it here makes the second read free and keeps the two
   * from disagreeing about whether capture is on.
   */
  payloadCapturePreference?:
    | {
        readonly ok: true;
        readonly mode: TelemetryPayloadMode;
        readonly depth: TelemetryPayloadDepth;
        readonly retentionMs: number;
      }
    | { readonly ok: false };
  /**
   * This request's resolved inline-attachment ceiling, memoized for the same
   * reason the capture preference is: it is a tenant setting, so it cannot
   * change between attempts, and reading it per attempt would pay for it
   * several times on a request that fails over.
   *
   * `undefined` means the deployment default.
   */
  imageClampMaxBytes?: number;
  /**
   * Set by the dispatch handler synchronously before returning a streaming
   * response. `afterResponse` lifecycle hooks read it to skip finalization
   * (telemetry + cleanup), deferring both to stream completion/cancel —
   * cleanup aborts the controller, which would tear down an in-flight stream.
   */
  streaming?: boolean;
  /**
   * Set by `completeAttempt` (dispatch/attempt-finalize) once the *terminal*
   * attempt has run its completion bookkeeping (usage commit, health report,
   * payload capture, telemetry finalization). The `afterResponse` telemetry
   * hook no-ops its finalize step when this is set (its Elysia registration
   * is untouched) so a request finalizes exactly once; cleanup still runs in
   * that hook's `finally` for every non-streaming request. Intermediate
   * failover attempts leave it clear.
   */
  completed?: boolean;
  /**
   * Re-arms the request deadline timer to `ms` from now. A streaming response
   * calls this once its body is established so the stream watchdogs (first
   * chunk + inter-event stall) govern body duration instead of the shorter
   * pre-stream deadline, while still keeping a hard ceiling over the whole
   * request. Idempotent and a no-op after cleanup.
   */
  extendDeadline(ms: number): void;
  cleanup(): void;
}

interface RequestTracker {
  track(id: string): void;
  untrack(id: string): void;
}

/**
 * Per-request state registry keyed on the immutable `Request` object.
 *
 * Storage strategy: the canonical state map is a `WeakMap<Request, …>`, so a
 * request object that escapes any handler's scope becomes garbage along with
 * its state — there is no registry-wide sweep to leak or forget. The
 * companion `liveControllers` map, however, is a strong `Map` keyed by
 * request id: the shutdown coordinator needs to enumerate and abort *all*
 * in-flight requests (`abortAll`) regardless of whether any handler still
 * holds the `Request`, so those entries must be reachable. `cleanup()` is the
 * single idempotent teardown point — it untracks the request, releases the
 * deadline timer, runs registered cleanups LIFO, aborts the controller (which
 * tears down any in-flight upstream fetch), and drops the WeakMap entry.
 *
 * Lifecycle tracking: `tracker` (optional `RequestTracker`) feeds
 * shutdown coordination, which waits on tracked requests (or aborts them
 * past the grace window) instead of relying on connection close events.
 */
/**
 * Minimal pub/sub over a store's snapshot. Polling already re-reads
 * `inFlightSnapshot()`, so this only pushes the same derived value to the
 * console's SSE stream; no second registry behind it.
 */
function subscribeInFlightSnapshot(
  store: { inFlightSnapshot(): InFlightSnapshot },
  listener: (snapshot: InFlightSnapshot) => void,
): () => void {
  const push = (): void => listener(store.inFlightSnapshot());
  push();
  const handle = setInterval(push, 1_000);
  (handle as unknown as { unref?: () => void })?.unref?.();
  return () => {
    clearInterval(handle);
  };
}

export class ProxyRequestStateStore {
  private readonly states = new WeakMap<Request, ProxyRequestState>();
  private readonly liveControllers = new Map<string, AbortController>();
  /**
   * The in-flight gauge is derived from the same map that owns a request's
   * lifetime. There is no second registry: a count that disagreed with
   * `liveControllers` was the ghost — entries that outlived the request they
   * described. The deadline each flight last armed is kept alongside, so the
   * backstop sweep still finds requests whose abort path never fired.
   */
  private readonly inFlightDeadlines = new Map<string, number>();
  private readonly inFlightIps = new Map<string, string>();

  constructor(private readonly tracker?: RequestTracker) {}

  activeCount(): number {
    return this.liveControllers.size;
  }

  inFlightSnapshot(): InFlightSnapshot {
    let uniqueIps = 0;
    const seen = new Set<string>();
    for (const ip of this.inFlightIps.values()) {
      if (!seen.has(ip)) {
        seen.add(ip);
        uniqueIps += 1;
      }
    }
    return { inFlight: this.inFlightDeadlines.size, uniqueIps };
  }

  /** Live flight count for this store. */
  inFlightCount(): number {
    return this.inFlightDeadlines.size;
  }

  subscribeInFlight(listener: (snapshot: InFlightSnapshot) => void): () => void {
    return subscribeInFlightSnapshot(this, listener);
  }

  /**
   * Releases every flight past its deadline. Aborting the controller unwinds
   * the fetch and lets the request's own `cleanup` run, which drops the
   * flight's entry with it. A request nothing observes — a half-closed socket
   * that neither pulls, cancels, nor aborts — never runs that cleanup, so
   * after a further grace window the sweep drops the entry itself: the fetch
   * is already torn down by the abort, and a permanently wrong number is the
   * exact defect this backstop exists to end. Logged, never silent.
   */
  sweepOverdueInFlight(nowMs: number, graceMs: number, hardGraceMs: number): number {
    for (const [requestId, deadline] of this.inFlightDeadlines) {
      if (nowMs < deadline + graceMs) continue;
      const controller = this.liveControllers.get(requestId);
      try {
        if (controller && !controller.signal.aborted) {
          controller.abort(
            new GatewayError("deadline_exceeded", 504, "in-flight request exceeded its deadline (request {requestId}). Some things just take longer 🐢"),
          );
        }
      } catch {
      }
    }
    let forced = 0;
    for (const [requestId, deadline] of this.inFlightDeadlines) {
      if (nowMs < deadline + hardGraceMs) continue;
      this.inFlightDeadlines.delete(requestId);
      this.inFlightIps.delete(requestId);
      forced += 1;
    }
    if (forced > 0) {
      log.error(
        `[inflight-backstop] force-releasing ${forced} flight(s): abort did not release them within ${hardGraceMs}ms`,
      );
    }
    return forced;
  }

  abortAll(reason?: unknown): void {
    const controllers = [...this.liveControllers.values()];
    if (controllers.length === 0) return;
    // A shutdown abort is deliberately *not* a bare `AbortError`. The streaming
    // dispatch path classifies an `AbortError` as a client disconnect and
    // releases the stream silently; a drain must instead emit a terminal frame
    // so the client sees an explicit "shutting down / restarting" close rather
    // than an EOF that reads as a truncated response. A caller that passes an
    // explicit reason (tests, or a future targeted abort) keeps it.
    const abortReason =
      reason instanceof Error || reason instanceof DOMException
        ? reason
        : new GatewayError("shutting_down", 503, "The gateway is shutting down, so this request cannot be served (request {requestId}). Retry against a live instance. Maintenance mode — back in a minute 🧘");
    for (const controller of controllers) {
      try {
        if (!controller.signal.aborted) controller.abort(abortReason);
      } catch {
      }
    }
  }

  /**
   * Creates per-request state with deadline enforcement: the deadline is
   * *enforced by an unref'd timer* that aborts the controller with a
   * `deadline_exceeded` at `deadlineMs` — unref'd so an idle deadline never
   * keeps the event loop alive during graceful shutdown. The inbound client
   * signal is bridged (abort propagation in both directions), so a client
   * disconnect aborts the upstream fetch immediately. Everything the timer
   * and signal listener allocated is torn down by `state.cleanup()`.
   */
  initialize(request: Request, now: number, deadlineDurationMs: number): ProxyRequestState {
    const abortController = new AbortController();
    const deadlineMs = now + Math.max(0, deadlineDurationMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => abortController.abort(request.signal.reason);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    let cleaned = false;
    let providerFlightStarted = false;
    const armDeadline = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Same vocabulary as the stream stall watchdog: a TimeoutError
        // DOMException was mis-handled mid-stream as a silent client cancel
        // (no SSE error, telemetry fell through to generic 500).
        abortController.abort(
          new GatewayError(
            "deadline_exceeded",
            504,
            "request deadline exceeded (request {requestId}). Some things just take longer 🐢",
            {},
            "cartethyia",
          ),
        );
      }, Math.max(0, ms));
      // Do not keep event loop alive for idle deadline timers (graceful shutdown)
      (timer as unknown as { unref?: () => void })?.unref?.();
    };
    armDeadline(Math.max(0, deadlineMs - Date.now()));
    const requestId = crypto.randomUUID();
    const state: ProxyRequestState = {
      requestId,
      startedAtMs: now,
      deadlineMs,
      abortController,
      startProviderFlight: () => {
        if (cleaned || providerFlightStarted) return;
        providerFlightStarted = true;
        this.inFlightDeadlines.set(requestId, state.deadlineMs);
        this.inFlightIps.set(requestId, state.clientIdentity?.address || "unknown");
      },
      releaseIngressBody: () => {
        state.ingressBody = undefined;
      },
      ingressMethod: request.method,
      ingressPath: fastPathname(request.url),
      extendDeadline: (ms: number) => {
        if (cleaned) return;
        // Keep the field in sync with the timer: dispatch contexts are built
        // from `state.deadlineMs`, so a re-armed timer with a stale field let
        // the upstream fetch time out earlier than the stall budget.
        state.deadlineMs = Date.now() + Math.max(0, ms);
        // The backstop sweep keys off the flight's own deadline, so a streaming
        // request that legitimately extends its budget must move the flight's
        // deadline too — otherwise the sweep would force-release a healthy
        // long stream the moment the pre-stream budget elapsed.
        if (providerFlightStarted) this.inFlightDeadlines.set(requestId, state.deadlineMs);
        armDeadline(ms);
      },
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        // Every step is guarded: one throwing cleanup must not skip the
        // remaining cleanups, the abort, or the map eviction (leak).
        try {
          if (providerFlightStarted) {
            this.inFlightDeadlines.delete(state.requestId);
            this.inFlightIps.delete(state.requestId);
          }
        } catch {
        }
        try {
          this.tracker?.untrack(state.requestId);
        } catch {
        }
        this.liveControllers.delete(state.requestId);
        clearTimeout(timer);
        timer = undefined;
        try {
          request.signal.removeEventListener("abort", onAbort);
        } catch {
        }
        try {
          abortController.abort(new DOMException("request complete", "AbortError"));
        } catch {
        }
        this.states.delete(request);
      },
    };
    this.liveControllers.set(state.requestId, abortController);
    this.tracker?.track(state.requestId);
    this.states.set(request, state);
    return state;
  }
  require(request: Request): ProxyRequestState {
    const state = this.states.get(request);
    if (!state)
      throw new GatewayError("route_unavailable", 503, "The request was never registered, so it cannot be served (request {requestId}). Resend the request. The bouncer stepped out — resend shortly 🚪");
    return state;
  }

  get(request: Request): ProxyRequestState | undefined {
    return this.states.get(request);
  }
}
