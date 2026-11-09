/**
 * The streaming half of provider dispatch: one candidate's SSE response, from
 * the primed first upstream event to the client's last frame.
 *
 * This is the gateway's hottest and most consequential path. It owns the
 * admission lease, the routing reservation, and the network-pool slot for the
 * whole body lifetime — a response returned here outlives the attempt loop that
 * created it, so releasing them is this module's job and no one else's. It was
 * extracted from `proxy-request.ts` (and again, internally, into
 * `encoder.ts` / `finalize.ts`) along real seams: the branch reads a fixed set
 * of values and returns a `Response`, and nothing outside it depends on how it
 * is organised.
 *
 * The shape worth understanding before editing:
 *
 * - **The first upstream event is primed before the response is committed.**
 *   Returning an SSE `Response` flushes `200 OK`, so a candidate that cannot
 *   produce even one event must fail *before* that point, letting the attempt
 *   loop advance to the next candidate instead of emitting an error into a
 *   stream the client already sees as successful.
 * - **`pull` demand-drives the upstream.** The runtime calls `pull` only when
 *   the consumer has drained the queue, which is where backpressure comes from.
 *   A `pull` that returns without enqueuing can leave Web Streams waiting
 *   forever, so the inner loop keeps reading until a wire chunk is produced.
 * - **Release is single-shot and coordinated with abort.** `streamReleased`
 *   makes release idempotent; `pullActive` tells the abort handler whether a
 *   pending pull owns the release or the handler must do it itself (a
 *   half-closed client leaves no pull to catch the abort).
 * - **A stream that ends without a terminal event is a failure.** It is
 *   reported as `finish_reason: error`, never as a clean `stop`.
 *
 * `test/gateway/streaming-contract.test.ts` pins the observable contract — the
 * encoded frames a client reads and the in-flight gauge returning to zero — so
 * a change here that alters behavior fails there.
 */
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import type { ProviderAdapter, ResolvedCredential } from "../../../providers/provider-contracts";
import type { ValidatedNetworkBindingFactory } from "../../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { Reservation, RouteCandidate, RouteSnapshotService } from "../../routing/route-model";
import type { AdmissionLease } from "../../../security/admission/contracts";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import type { ProviderExchangeCapture } from "../attempt-finalize";
import { resolveCaptureModeForRequest } from "../capture-policy";
import { resolveTenantImageClampMaxBytes, readTenantSystemPromptsForDispatch } from "../../request/tenant-preferences";
import { resolveTenantSystemPrompt } from "../../request/system-prompt-injection";
import { isWrappedInjectionProvider } from "../../../console/system-prompt/contracts";
import { proxySuccessHeaders, buildUpstreamDispatchContext, buildDispatchNetworkBindings } from "../upstream";
import type { AttemptLeaseOwnership } from "../leases";
import type { ProviderContinuationScope } from "../../../providers/provider-contracts";
import { resolveStreamFirstChunkTimeoutMs, resolveStreamStallTimeoutMs, resolveUpstreamTimeoutMs } from "../../../config/timeouts";
import type { ProxyRequestState } from "../../request/state";
import type { PreparedProxyRequest } from "../../request/preparer";
import { drainAbortReason } from "../../shutdown-notice";
import { StreamEventPipeline } from "./encoder";
import { StreamFinalizer, type StreamCandidateIdentity } from "./finalize";

/** Collaborators the streaming branch reads from the dispatch handler. */
interface StreamingDispatchDeps {
  readonly db: CartethyiaDatabase;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory | undefined;
  readonly poolSelector?: NetworkPoolSelector | undefined;
  readonly snapshotService?: RouteSnapshotService | undefined;
  readonly telemetryBuffer?: TelemetryBatchBuffer | undefined;
}

/** Everything one streamed attempt needs, all resolved by its caller. */
interface StreamingDispatchInput {
  readonly state: ProxyRequestState;
  readonly deps: StreamingDispatchDeps;
  readonly prepared: PreparedProxyRequest;
  readonly canonicalRequest: CanonicalRequest;
  readonly candidate: RouteCandidate;
  readonly credential: ResolvedCredential;
  readonly adapter: ProviderAdapter;
  /** The request as projected for this candidate's route. */
  readonly dispatchRequest: CanonicalRequest;
  /** The candidate in the shape the adapter contract expects. */
  readonly providerRouteCandidate: unknown;
  readonly inboundHeaders: Record<string, string>;
  readonly conversationAffinity: string | undefined;
  readonly lease: AdmissionLease;
  readonly reservation: Reservation;
  readonly proxySlot: { poolId: string; release: () => void } | undefined;
  readonly networkPoolId: string | undefined;
  readonly providerCapture: ProviderExchangeCapture;
  /** Ownership of this attempt's account/network-pool release, when one was acquired. */
  readonly leaseOwnership?: AttemptLeaseOwnership | undefined;
  /** Caller identity authorizing a provider session held across requests. */
  readonly continuationScope?: ProviderContinuationScope | undefined;
  /** Hands lease ownership to the returned `Response`'s async lifetime. */
  retainLeases: () => void;
  /** First-token latency in the spread shape `completeAttempt` accepts. */
  readonly ttfbFields: (
    firstByteAt: number | undefined,
    firstContentDeltaAtMs: number | undefined,
    startedAtMs: number | undefined,
  ) => { ttfbMs?: number };
}

/** How often the SSE keepalive comment frame is sent while the stream is idle. */
const CLIENT_SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Settles a pending provider read when the owning request is aborted. */
function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("request aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
}

/**
 * Streams one candidate's answer to the client.
 *
 * Never throws for an upstream failure: by the time the body streams, `200 OK`
 * is already on the wire, so every failure rides in the frames. A throw is
 * reserved for the pre-commit window, where the attempt loop can still fail
 * over to another candidate.
 */
export async function dispatchStreamingAttempt(input: StreamingDispatchInput): Promise<Response> {
  const {
    state,
    deps,
    prepared,
    canonicalRequest,
    candidate,
    credential,
    adapter,
    dispatchRequest,
    providerRouteCandidate,
    inboundHeaders,
    conversationAffinity,
    lease,
    reservation,
    proxySlot,
    networkPoolId,
    providerCapture,
    retainLeases,
    ttfbFields,
    leaseOwnership,
    continuationScope,
  } = input;

  const bindings = await buildDispatchNetworkBindings({
    deps,
    networkPoolId,
    tenantId: prepared.authorization.snapshot.tenant_id,
    providerCapture,
    state,
  });
  // Resolved once, before the pipeline exists: the pipeline's diagnostics are
  // gated on it from construction, so `none`/`metadata` tenants never pay the
  // transcript serialization or the client-response copy for any event.
  const captureMode = await resolveCaptureModeForRequest(
    deps.db,
    prepared.authorization.snapshot.tenant_id,
    state,
  );
  // Same memoized ceiling the non-streaming path resolves, read before the
  // dispatch context is built so a stream gets the same limit as a normal
  // request rather than silently falling back to the deployment default.
  if (state.imageClampMaxBytes === undefined) {
    const clampMaxBytes = await resolveTenantImageClampMaxBytes(
      deps.db,
      prepared.authorization.snapshot.tenant_id,
    );
    if (clampMaxBytes !== undefined) state.imageClampMaxBytes = clampMaxBytes;
  }
  const dispatchContext = buildUpstreamDispatchContext({
    credential,
    deadline: state.deadlineMs,
    signal: state.abortController.signal,
    headers: inboundHeaders,
    requestId: state.requestId,
    requestIdentity: state,
    ...(state.imageClampMaxBytes === undefined
      ? {}
      : { imageClampMaxBytes: state.imageClampMaxBytes }),
    ...(conversationAffinity ? { conversationAffinity } : {}),
    // Same wrapped-injection text the non-streaming path carries: providers
    // whose upstream validates the fixed system prompt as a channel identity
    // (the buddy family) receive the tenant prompt through dispatch context
    // so the adapter can fold it into its fixed turn. `override` degrades to
    // wrapped append there; stripping the identity would be refused outright.
    ...(await (async () => {
      if (!isWrappedInjectionProvider(candidate.provider_id)) return {};
      const text = resolveTenantSystemPrompt(
        await readTenantSystemPromptsForDispatch(deps.db, prepared.authorization.snapshot.tenant_id),
        {
          providerId: candidate.provider_id,
          modelId: candidate.model_id,
          requestedModel: prepared.plan?.requested_model ?? candidate.model_id,
        },
      )?.text;
      return text === undefined ? {} : { tenantSystemPrompt: text };
    })()),
    ...(candidate.user_agent === undefined ? {} : { userAgent: candidate.user_agent }),
    ...bindings,
    ...(leaseOwnership === undefined ? {} : { leaseOwnership }),
    ...(continuationScope === undefined ? {} : { continuationScope }),
    ...(providerCapture ? { providerCapture } : {}),
  });
  // `ProviderAdapter.dispatch` is declared to return a non-nullable
  // `AsyncIterable`, so an adapter that returned `undefined` would be a
  // type violation rather than a state this code could handle — no null check
  // is needed here, and adding one would advertise a contract the interface
  // does not have. Enforcing it belongs at the adapter boundary.
  const createUpstreamIterable = () =>
    adapter.dispatch(
      dispatchRequest,
      providerRouteCandidate as never,
      dispatchContext as never,
    );
  const streamOptions = {
    created: Date.now() / 1000,
    include_usage: canonicalRequest.generation_controls["extension:include_usage"] === true,
  };
  let iterable = createUpstreamIterable();
  let iterator = iterable[Symbol.asyncIterator]();
  state.upstreamDispatchStartedAtMs = Date.now();
  let first: IteratorResult<CanonicalEvent> = await nextWithAbort(iterator, state.abortController.signal);
  const candidateIdentity: StreamCandidateIdentity = {
    providerId: candidate.provider_id,
    modelId: candidate.model_id,
    accountId: candidate.provider_account_id,
    accountLabel: candidate.provider_account_label,
    networkPoolId,
  };
  // Any upstream event (even surface-invisible) proves liveness for
  // watchdog bound selection.
  let sawUpstreamActivity = false;
  // A Responses-family wire may deliver a prelude with no client-renderable
  // content; the retry guard below keys on this flag.
  const recoverableResponsesPrelude = candidate.wire_family === "responses";
  const pipeline = new StreamEventPipeline(
    canonicalRequest.source_surface,
    canonicalRequest.source_surface === "completion"
      ? {
          model: candidate.model_id,
          created: Date.now() / 1000,
          prompt: canonicalRequest.generation_controls["extension:completion.prompt"],
          echo: canonicalRequest.generation_controls["extension:completion.echo"] === true,
          suffix: canonicalRequest.generation_controls["extension:completion.suffix"],
        }
      : canonicalRequest.source_surface === "messages"
        ? { response_id: `msg-${crypto.randomUUID()}`, model: candidate.model_id }
        : streamOptions,
    recoverableResponsesPrelude,
    { captureMode },
  );
  const finalizer = new StreamFinalizer(
    {
      state,
      deps: {
        db: deps.db,
        poolSelector: deps.poolSelector,
        telemetryBuffer: deps.telemetryBuffer,
        snapshotService: deps.snapshotService,
      },
      prepared,
      candidate: candidateIdentity,
      lease,
      reservation,
      proxySlot,
      providerCapture,
      getIterator: () => iterator,
      ttfbFields,
      ...(leaseOwnership === undefined ? {} : { leaseOwnership }),
    },
    pipeline,
    {
      stallTimeoutMs: resolveStreamStallTimeoutMs(),
      firstChunkTimeoutMs: resolveStreamFirstChunkTimeoutMs(),
    },
  );

  let preContentRetryCount = 0;
  const retryUncommittedResponsesPrelude = async (): Promise<boolean> => {
    if (
      !recoverableResponsesPrelude ||
      pipeline.hasClientVisibleEvent ||
      preContentRetryCount >= 1 ||
      state.abortController.signal.aborted
    )
      return false;
    preContentRetryCount += 1;
    try {
      await iterator.return?.();
    } catch {
      // The failed provider iterator is already being discarded.
    }
    // Only prelude events can be buffered here: the retry guard requires
    // `!clientVisibleEvent`, so nothing client-visible is discarded.
    pipeline.resetUncommittedPrelude();
    sawUpstreamActivity = false;
    iterable = createUpstreamIterable();
    iterator = iterable[Symbol.asyncIterator]();
    state.upstreamDispatchStartedAtMs = Date.now();
    return true;
  };

  const failureForAbort = (): GatewayError | undefined =>
    finalizer.abortFailure(state.abortController.signal.reason);

  const finishAbortedPull = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    const failure = failureForAbort();
    if (!failure) {
      await finalizer.releaseStreamResources();
      try {
        controller.close();
      } catch {
        // The client may have cancelled the body while the abort was handled.
      }
      return;
    }
    try {
      await finalizer.emitStreamErrorAndClose(failure, controller);
    } finally {
      void finalizer.releaseStreamResources();
    }
  };

  // The client may already be gone before the stream is even constructed.
  if (state.abortController.signal.aborted) finalizer.onStreamAbort();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      finalizer.attachController(controller);
      if (state.abortController.signal.aborted) return;
      finalizer.startClientKeepalive(controller, CLIENT_SSE_KEEPALIVE_INTERVAL_MS);
      if (!first.done) pipeline.enqueueEvent(first.value, controller);
    },
    async pull(controller) {
      finalizer.pullActive = true;
      try {
        if (state.abortController.signal.aborted) {
          await finishAbortedPull(controller);
          return;
        }
        try {
          // A canonical event may be intentionally invisible on the
          // selected client surface (for example xAI's encrypted
          // reasoning item when the client is Chat Completions). Keep
          // pulling until at least one wire chunk is enqueued; returning
          // from pull with an empty queue can leave Web Streams waiting
          // forever — a client then sees one assistant header and then a
          // 60s socket reset.
          for (;;) {
            // Re-arm on every upstream read: the watchdog fires only
            // when the provider stays silent longer than the bound.
            finalizer.armStallWatchdog(sawUpstreamActivity);
            let result: IteratorResult<CanonicalEvent>;
            try {
              result = await nextWithAbort(iterator, state.abortController.signal);
            } catch (err) {
              finalizer.clearStallWatchdog();
              if (await retryUncommittedResponsesPrelude()) continue;
              throw err;
            }
            finalizer.clearStallWatchdog();
            if (state.abortController.signal.aborted) {
              await finishAbortedPull(controller);
              return;
            }
            if (result.done) {
              if (await retryUncommittedResponsesPrelude()) continue;
              await finalizer.finalizeStream(controller);
              return;
            }
            sawUpstreamActivity = true;
            if (pipeline.enqueueEvent(result.value, controller)) return;
            // The guard terminated the stream early: stop consuming. Pulling
            // on would keep the runaway upstream alive and bill tokens the
            // client was already told are not coming.
            if (pipeline.loopDetected) {
              await finalizer.finalizeStream(controller);
              return;
            }
          }
        } catch (err) {
          finalizer.clearStallWatchdog();
          const abortFailure = failureForAbort();
          if (state.abortController.signal.aborted && !abortFailure) {
            await finishAbortedPull(controller);
            return;
          }
          // A drain or deadline that landed mid-read aborts the pending
          // `next()`. Preserve that typed reason instead of reporting a
          // generic upstream failure.
          const drain = drainAbortReason(state.abortController.signal.reason);
          try {
            await finalizer.emitStreamErrorAndClose(drain ?? abortFailure ?? err, controller);
          } finally {
            // The release must not depend on the error path completing:
            // anything that throws above it (a bookkeeping call, a dead
            // controller) would otherwise skip it, and `afterResponse`
            // cannot rescue a request whose `state.streaming` is set. The
            // `streamReleased` guard makes this safe to reach twice.
            void finalizer.releaseStreamResources();
          }
        }
      } finally {
        // The watchdog abort and the abort handler coordinate through
        // this flag: while a pull is pending it owns the release; once
        // pull returns, an abort with no reader must release itself.
        finalizer.pullActive = false;
      }
    },
    cancel() {
      if (state.completed) return;
      // A cancelled stream may never see another pull(), so abort alone
      // would leak the quota lease, routing reservation, and pool slot.
      // Request upstream iterator cleanup, but do not await a generator's
      // return(): async generators can queue it behind a permanently pending
      // read. The request signal has already cancelled the underlying fetch.
      state.abortController.abort(new DOMException("client disconnect", "AbortError"));
      finalizer.settleUpstreamIterator();
      return finalizer.releaseStreamResources();
    },
  }, {
    // Do not prefetch provider events while the previous SSE frame is queued.
    highWaterMark: 0,
  });

  // Ownership of the lease handles now belongs to the stream's async
  // lifetime; handing them over only after the ReadableStream has been
  // successfully constructed avoids a leak if `new ReadableStream(...)`
  // itself throws — in which case `start` never runs and the attempt
  // loop's `finally` must still release them.
  retainLeases();
  // Set before returning so `afterResponse` lifecycle hooks (telemetry +
  // cleanup) skip this request and let stream completion/cancel finalize.
  state.streaming = true;
  // Re-arm the request deadline so the stream watchdogs, not the shorter
  // pre-stream deadline, govern body duration. The hard ceiling becomes
  // pre-stream budget + stall budget, which is exactly the 480s pool-slot
  // crash-recovery budget the network pool is sized for.
  state.extendDeadline(
    Math.max(
      0,
      state.startedAtMs + resolveUpstreamTimeoutMs() + finalizer.streamStallTimeoutMs - Date.now(),
    ),
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      connection: "keep-alive",
      ...proxySuccessHeaders(state),
      // Intermediaries (nginx, Cloudflare, corporate proxies) otherwise
      // buffer the whole SSE response and flush it at the end, which
      // makes a live stream look like one delayed chunk. `no-transform`
      // forbids compression and `x-accel-buffering: no` disables nginx
      // proxy buffering for this response. These override the generic
      // `cache-control: no-store` above, which a proxy may still buffer.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
