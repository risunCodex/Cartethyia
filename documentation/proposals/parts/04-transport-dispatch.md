# Part 04 — Transport dispatch, streaming lifecycle, retries and finalization (deep audit)

## Scope

Read-only audit of `src/transport/dispatch/**` (attempt loop, attempt
finalization, capture policy, empty-stream recovery, leases, native routes,
streaming pipeline) for concrete, worthwhile consolidation opportunities
(bloat, duplication, unnecessary work, maintenance complexity) that preserve
behavior. Priority constraints from the operator: memory/state integrity and
valid fallback behavior win over cleanup; never propose removing apparently
duplicated logic unless the copies share the same contract, state scope,
ordering, error semantics, and safety boundary. Codegraph was used first for
symbol/call-path mapping, then direct `Read`/`Grep` of source and tests. No
source, test, config, documentation (other than this report file), or git
state was modified.

## Current-flow evidence (traced)

- **Attempt loop** `src/transport/dispatch/attempt-loop.ts` (`runAttemptLoop:233`)
  drives every dispatch route: admission lease → pool slot → routing
  reservation (`leases.ts` `acquireAttemptLeases:241`), route-specific `prepare`
 /`attempt` closures, one `completeAttempt` per attempt, retry/backoff/OAuth
  refresh/pool-cooldown policy in one place. Terminal failure bookkeeping lives
  in `attempt-finalize.ts` (`completeAttempt:741`), shared by the non-streaming
  proxy path (`proxy-request.ts` `handleProviderProxyRequest:112`), the streaming
  tail (`streaming/finalize.ts` `StreamFinalizer`), the native routes
  (`generation.ts`, `systemone.ts`, `websearch.ts`, `responses-compact.ts`,
  `token-count.ts`), and `vision-handoff.ts`.
- **Streaming** `streaming/stream.ts` (`dispatchStreamingAttempt:149`) primes the
  first upstream event before committing 200, then demand-drives the body via
  `pull`; `streaming/encoder.ts` (`StreamEventPipeline`) owns framing, the
  bounded telemetry transcript, and client-response buffer; `streaming/finalize.ts`
  owns watchdogs, abort handling, terminal completion, and single-shot lease
  release. `stream-bridge.ts` picks the surface encoder.
- **Native routes** all call `runAttemptLoop` with the same `leaseSource` shape
  and assemble terminal completions through `nativeCompletionBase`
  (`attempt-finalize.ts:593`); the proxy paths assemble through `completionContext`
  (`attempt-finalize.ts:540`).
- **Retry/egress policy** `attempt-loop.ts:400-423` classifies egress failures
  (`classifyEgressFailure`) and flags pools; `streaming/finalize.ts:582-589`
  repeats the identical classification-and-flag sequence for stream failures.
- **Tests read** `test/transport/empty-stream.test.ts`, `capture-invariant.test.ts`,
  `combo-attempt-budget.test.ts`, `exhausted-attempts-completion.test.ts`,
  `retry-deadline-budget.test.ts`, `pool-egress-failover.test.ts`,
  `stream-event-pipeline.test.ts`, `leak-loop-end-to-end.test.ts`,
  `thinking-loop-guard.test.ts` (grep), plus `test/helpers/attempt-loop.ts`.

## Findings

### F1 — Egress-verdict → pool-flag policy duplicated between the attempt loop and the streaming finalize (CONFIRMED)

- **Severity:** MED · **Effort:** S · **Behavior change:** no.
- **Mechanism.** Two copies of the same policy sequence exist:
  - `src/transport/dispatch/attempt-loop.ts:400-423` (catch path): compute
    `egressVerdict = classifyEgressFailure(error, candidate.provider_id)` when
    not cancelled; `rateLimitedPool` → `flagPoolCooldown`, `blockedPool` →
    `flagPoolBlocked`, gated on `networkPoolId !== undefined && deps.poolSelector !== undefined && error instanceof GatewayError`. Then `poolScopedFailure` drives the retry decision.
  - `src/transport/dispatch/streaming/finalize.ts:582-589`
    (`emitStreamErrorAndCloseOnce`): `classifyEgressFailure(err, candidate.providerId)`;
    `cooldown` → `flagPoolCooldown`, `blocked` → `flagPoolBlocked`, gated on
    `candidate.networkPoolId && !cancelled && deps.poolSelector && err instanceof GatewayError`.
  Both write the same volatile selector flag plus durable `health_events` / `provider_cooldowns`
  state (`network/pool-health.ts` `flagPoolCooldown:179`, `flagPoolBlocked:85`).
- **Why it is real duplication.** Same contract (classify egress → retire pool
  by verdict), same state scope (pool selector + db), same error semantics
  (only `GatewayError`, only non-cancelled, only when a pool id and selector
  exist), same safety boundary (advisory writes that never fail the request).
  A policy change — e.g. which verdict maps to cooldown vs blocked, or a new
  verdict — must be edited in two places and would otherwise surface as
  telemetry that differs by response mode.
- **Proposal.** Extract one helper owning the verdict→flag dispatch, e.g.
  `flagPoolOnEgressFailure(poolSelector, db, poolId, providerId, error, verdict)`
  in `src/network/pool-health.ts` (next to the flags it calls), or a small
  `egress-policy.ts` beside `attempt-loop.ts`. Have both call sites compute the
  verdict (attempt-loop keeps needing `poolScopedFailure` from it) and pass the
  verdict to the helper. Keep the call order identical: in the attempt loop the
  flag must still be written synchronously before the retry decision (the next
  attempt must see the pool excluded); in the finalize path it must still run
  before `controller.close()`.
- **State/fallback analysis.** The volatile flag and durable marker writes are
  unchanged; the helper only bundles the dispatch. `flagPoolCooldown` vs
  `flagPoolBlocked` selection and each function's own swallow/`catch` semantics
  are preserved verbatim. No fallback branches are loosened.
- **Fallback risk.** None beyond preserving call order; consolidation does not
  alter which errors reach the flags.
- **Verification.** `test/transport/pool-egress-failover.test.ts` pins the
  non-streaming path (fails over across pools within one candidate, never
  retries the refused pool, terminal `proxy_pool_blocked`). The streaming path
  has no dedicated pool-flag unit test today; add one driving
  `emitStreamErrorAndCloseOnce` with a `classifyEgressFailure` cooldown and
  blocked verdict and asserting the same selector/durable writes.

### F2 — `completionContext` and `nativeCompletionBase` are two copies of the same builder (CONFIRMED)

- **Severity:** MED · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/transport/dispatch/attempt-finalize.ts` defines two
  near-identical completion-field builders:
  - `completionContext:540-584` — spreads `providerId`, `modelId`, `tenantId`,
    `ingressBody`, optional `providerCapture`, `db`, `terminal: true`, optional
    `accountId`, `accountLabel`, `networkPoolId`, `lease`, `telemetryBuffer`,
    `snapshotService`.
  - `nativeCompletionBase:593-641` — the same field set plus optional `usage`
    and `commitUsage`.
  `nativeCompletionBase` is a strict superset; the shared field spreads are
  textually identical.
- **Why it is real duplication.** Same contract, same state scope, same
  ordering, same error semantics (pure object assembly), same safety boundary
  (`exactOptionalPropertyTypes` conditional spreads). A field added to one
  (e.g. a new optional completion field) can silently miss the other — the
  exact drift class this pair exists to prevent (`streamCompletionContext` in
  `streaming/finalize.ts:627` already documents a three-copy drift it fixed).
- **Proposal.** Make `nativeCompletionBase` delegate to `completionContext` and
  add only `usage`/`commitUsage`, or merge `usage`/`commitUsage` into
  `completionContext` and keep one function. Either way there is exactly one
  builder owning the shared field set.
- **State/fallback analysis.** Pure object assembly; no reads, writes, or
  fallbacks. The two `Omit` types must keep identical key sets so an absent
  optional field stays absent (not explicit `undefined`).
- **Fallback risk.** None. Both are deterministic; delegation yields
  byte-identical objects.
- **Verification.** Existing suites already assert completion shapes for both
  families: `test/transport/stream-event-pipeline.test.ts` and
  `test/transport/leak-loop-end-to-end.test.ts` (streaming via
  `streamCompletionContext`), plus native-route accounting paths. A targeted
  unit test can assert `nativeCompletionBase({...})` deep-equals the current
  hand-written spread on a representative input.

### F3 — `candidateKey` re-implements `comboCandidateKey` inside the same file (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/transport/dispatch/attempt-loop.ts` builds the identical
  candidate identity key twice:
  - `comboCandidateKey:55-62` — `[provider, account ?? "global", model, endpoint].join(":")`.
  - `candidateKey:477` — `` `${provider}:${account ?? "global"}:${model}:${endpoint}` ``.
  Both are used as Set keys (`failedCandidates`, `refreshedCandidates`) for the
  same collision-identity contract.
- **Why it is real duplication.** Identical construction, identical state scope
  (local request-scoped sets), identical ordering and no error semantics. If the
  identity ever needs a new dimension (e.g. wire family or tenant), both sites
  must change together or the failed/refreshed bookkeeping diverges.

- **Proposal.** Reuse `comboCandidateKey(candidate)` at line 477.
- **State/fallback analysis.** Pure string derivation; the Sets behave
  identically. No state mutation or fallback involved.
- **Fallback risk.** None.
- **Verification.** `test/transport/combo-attempt-budget.test.ts` exercises the
  `comboCandidateKey` path (interleaved members, per-member budget); the OAuth
  refresh path (`refreshedCandidates`) is covered by provider credential tests.
  No new test strictly required, but a one-line assertion that `candidateKey`
  equals `comboCandidateKey` on the same candidate would pin it.

### F4 — Upstream response forwarding `Response` builder duplicated across four native handlers (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** Four handlers construct the same header set by hand when
  forwarding an upstream response body verbatim:
  - `src/transport/dispatch/generation.ts:136-143` (`passThrough`) —
    `"content-type": upstream ?? "text/event-stream"`, `"cache-control": "no-store"`,
    `"x-request-id": state.requestId`.
  - `src/transport/dispatch/systemone.ts:167-174` — same with `"application/json"`
    default.
  - `src/transport/dispatch/responses-compact.ts:146-153` — identical to systemone.
  - `src/transport/dispatch/token-count.ts:193-196` — identical to systemone.
  (`native-shared.ts` `jsonResponse:63` is a fifth JSON-payload builder used by
  generation/search success paths; it shares the same header values.)
- **Why it is real duplication.** Same contract (status from upstream, same
  three headers, content-type default), same state scope (none), same error
  semantics (none), same safety boundary (headers are the wire contract).
  These are exactly the copies that drifted once already — `generation`'s
  `jsonResponse` previously lost `cache-control` (documented in
  `native-shared.ts:1-7`).
- **Proposal.** Add `forwardUpstreamResponse(response: Response, requestId: string, defaultContentType = "application/json"): Response`
  to `native-shared.ts`; the systemone/responses-compact/token-count sites
  delegate to it, and `passThrough` calls it with `"text/event-stream"`.
  Deliberately do **not** replace with `proxySuccessHeaders`
  (`upstream.ts:29`) — that adds `GATEWAY_SECURITY_HEADERS`, which would change
  the wire headers these routes currently send.
- **State/fallback analysis.** Header values are preserved exactly; no body
  reading or state touched. Content-type defaults stay per-call.
- **Fallback risk.** None as long as the default content type argument is
  correct per call site (SSE vs JSON).
- **Verification.** `test/transport/token-count-route.test.ts`, provider service
  tests (`test/providers/provider-services.test.ts`), and search tests
  (`test/providers/search-providers.test.ts`) exercise the forwarded responses;
  assert the header set is unchanged.

### F5 — Outbound network-binding construction duplicated between the proxy attempt and the streaming branch (CONFIRMED)

- **Severity:** MED · **Effort:** M · **Behavior change:** no.
- **Mechanism.** Both the non-streaming proxy attempt and the streaming branch
  build the identical three binding objects for the dispatch context:
  - `src/transport/dispatch/proxy-request.ts:266-305` — `outboundFetch:
    captureProviderExchange(networkBindingFactory.fetch(...), providerCapture,
    await shouldCaptureProviderBodyForRequest(...), providerCaptureMaxBytes(await
    resolveCaptureDepthForRequest(...)))`; `outboundAttachmentFetch:
    networkBindingFactory.fetch(...)`; `outboundHttp2:
    networkBindingFactory.http2Bidi(...)`.
  - `src/transport/dispatch/streaming/stream.ts:173-253` — same three, with
    `captureBody`/`captureDepth` resolved beforehand, then passed to
    `captureProviderExchange`.
  Both rely on `buildUpstreamDispatchContext` (`upstream.ts:37`) to carry them;
  the per-attempt construction around it is written twice.
- **Why it is real duplication.** Same inputs (`deps.networkBindingFactory`,
  `networkPoolId`, tenant id, `providerCapture`, capture body/depth), same
  output semantics (identical context keys), same state scope (none), same
  safety boundary (the wrapped fetch is the validated egress). A change to the
  capture wrap or the attachment/HTTP2 binding shape must be made in two hot
  paths.
- **Proposal.** Extract a shared `buildDispatchNetworkBindings(deps, networkPoolId, tenantId, providerCapture, captureMode, captureDepth)`
  (in `upstream.ts` or a small dispatch module) that resolves capture body
  gating and returns `{ outboundFetch, outboundAttachmentFetch, outboundHttp2 }`
  exactly as today. Both call sites then spread the result into
  `buildUpstreamDispatchContext`.
- **State/fallback analysis.** No state mutated; the helper is pure
  construction. The capture-preference reads are already memoized on the
  request state (`capture-policy.ts` `resolveCapturePreference`, `state.payloadCapturePreference`),
  so eager resolution inside the helper costs no extra DB reads. The streaming
  branch's `outboundFetch`-absent case (no network binding factory) must
  continue to yield `outboundFetch: undefined` and skip capture wrapping.
- **Fallback risk.** Low — the only hazard is changing the eager/lazy order of
  the capture reads or the wrapped-fetch identity handed to the adapter; the
  helper must return the same function objects in the same keys.
- **Verification.** Non-streaming proxy behavior is pinned by gateway/transport
  suites (`test/helpers/gateway.ts`, `test/transport/*`); streaming contract is
  pinned by `streaming-contract`-style tests and `test/transport/stream-event-pipeline.test.ts`.
  Re-run both families; add a unit assertion that both call sites receive
  identical binding objects for equal inputs.

## Excluded / unverified suspects

- **`ThinkingLoopDetector.flush()`** (`streaming/thinking-loop.ts:156`) is never
  called in production — only `.push()` and `.detected` are used
  (`streaming/encoder.ts:262,305,136`). Tests do exercise `flush()`
  (`test/transport/thinking-loop-guard.test.ts:62,106`). Adding a terminal
  flush could catch an unterminated trailing reasoning segment, but that would
  change behavior (terminating streams that currently complete), so it is not
  proposed here; it is recorded as an open question.
- **`empty-stream.ts`** (`fetchWithEmptyStreamRecovery`) is coherent and used by
  exactly one integration (`src/providers/integrations/antigravity/antigravity.ts:402`);
  no duplication found within it.
- **Stream-finalizer timer/concurrency invariants** (`StreamFinalizer`
  `streamSettled`/`streamReleased`, the deferred-release backstop) are
  intricate and behavior-critical; they were inspected but not re-derived
  exhaustively. No consolidation is proposed there.
- **Event-array buffering in the non-streaming proxy path** (`proxy-request.ts:342-358`)
  is inherent to non-streaming responses, not an opportunity.
- Speculative micro-optimizations (per-event allocation, transcript encoding
  costs in `none`/`metadata` modes — already gated) are excluded per
  instructions.

## Validation

- Source read in full: all files under `src/transport/dispatch/**` (17 + 4
  streaming), plus `failure-policy.ts`, `network/pool-health.ts`,
  `network/rate-limit-verdict.ts`, `transport/guards/error-lifecycle.ts`,
  `transport/request/state.ts`, `transport/request/tenant-preferences.ts`,
  `transport/vision-handoff.ts`.
- Tests read: empty-stream, capture-invariant, combo-attempt-budget,
  exhausted-attempts-completion, retry-deadline-budget, pool-egress-failover,
  stream-event-pipeline, leak-loop-end-to-end, thinking-loop-guard; helper
  `test/helpers/attempt-loop.ts`.
- Findings F1–F5 are each backed by cited line-level evidence above. F1–F4
  are small, bounded changes (S). F5 touches the two hot dispatch paths and is
  the only one that requires care to keep eager/lazy output identical (M).

## Open questions

- For F1: should the shared helper live in `network/pool-health.ts` (next to
  the flags) or in `transport/dispatch/`? Publishing it from `pool-health` is
  natural, but it would import `classifyEgressFailure`-shaped verdict types;
  either owner is fine as long as both call sites import one function.
- For F5: confirm whether the streaming branch's `captureBody` gating
  (`outboundFetch ? shouldCaptureProviderBodyForRequest(...) : false`) must be
  preserved exactly — it currently skips a DB-backed preference read when no
  network binding exists, an optimization the helper should retain.
- Whether to add a streaming-side pool-flag test as part of F1 (currently only
  the non-streaming path is pinned).

## Execution status

Implementasi kampaian (2026-11-09), verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-08) — ✅.** `flagPoolOnEgressFailure` extracted into
  `src/network/pool-health.ts`; both the attempt loop and `StreamFinalizer`
  compute the verdict and pass it to the single helper. `EgressVerdict`
  exported. New test in `test/transport/dispatch-consolidation.test.ts`.
- **F2 (M-09) — ✅.** `nativeCompletionBase` delegates to `completionContext`
  for the shared field set, adding only usage/commitUsage.
- **F3 (M-10) — ✅.** `candidateKey` reuses `comboCandidateKey` (same join
  order).
- **F4 (M-11) — ✅.** `forwardUpstreamResponse` added to `native-shared.ts`;
  generation/systemone/responses-compact/token-count all delegate to it.
  `proxySuccessHeaders` deliberately not reused (would add security headers).
- **F5 (M-12) — ✅.** `buildDispatchNetworkBindings` extracted into
  `src/transport/dispatch/upstream.ts`; both proxy-request and streaming/stream
  call it. The eager/lazy capture-read order and the no-factory zero-DB-read
  optimization are preserved.
