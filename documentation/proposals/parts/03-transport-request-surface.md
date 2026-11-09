# Part 03 — Transport request preparation, guards, surface adapters (deep audit)

## Scope

Read-only audit of `src/transport/request/**`, `src/transport/guards/**`, and
`src/transport/surface/**` for concrete, worthwhile consolidation opportunities
(bloat, duplication, unnecessary work, maintenance complexity) that preserve
behavior. Priority constraints from the operator: memory/state integrity and
valid fallback behavior win over cleanup; never propose removing apparently
duplicated logic unless the copies share the same contract, state scope,
ordering, error semantics, and safety boundary. Files were inspected as source
plus tests; codegraph was used first for symbol/call-path mapping, then direct
`Read`/`Grep` for detail. No source, test, config, documentation (other than
this report file), or git state was modified.

## Current-flow evidence (traced)

- **Ingress** `src/transport/guards/body-policy.ts` (`readIngressBody:70`,
  `createIngressPolicyMiddleware:133`, route table `PROXY_JSON_ROUTES:32`)
  reads the body once into `state.ingressBody`; `createCanonicalRequestMiddleware`
  (`request-context.ts:129`) parses it via `SurfaceAdapterRegistry.detectOnce`
  (`surface/adapters.ts:129`) then releases it unless payload capture is `full`
  (`request-context.ts:206-208`, pinned by `test/transport/ingress-body-release.test.ts`).
- **Guards** `src/transport/guards/pipeline.ts` (`createTransportPipeline:94`)
  composes the ordered stage chain: headroom → readiness → ingress → client
  identity → auth → canonical parse → route preparation, mounted on the
  `/v1` prefix, with root-scoped request context and error normalization.
- **Preparation** `src/transport/request/preparer.ts` (`ProxyRequestPreparer.prepare:370`
  and `#planNative:732`) resolve alias target, admission-gate the model, plan
  candidates against a snapshot, degrade capabilities
  (`src/transport/request/degradation.ts`), repair tool rounds, project to the
  winning route, and estimate tokens (`src/transport/request/token-estimate.ts`).
- **Surface parsing** four wire parsers (`chat/parse.ts`, `messages/parse.ts`,
  `responses/parse.ts`, `completion.ts`) normalize distinct bodies into one
  canonical request; detection precedence is header → path → unambiguous body
  shape → chat default (`surface/adapters.ts`).
- **Surface encoding** non-streaming encoders (`chat/encode.ts` `jsonCompletion`,
  `completion.ts` `CompletionAdapter.encodeOutput`, `messages/adapter.ts`
  `encode`) and stateful streaming encoders (`chat/encode.ts` `ChatStreamEncoder`,
  `completion.ts` `CompletionStreamEncoder`, `messages/stream.ts`, `responses/encode.ts`),
  both routed through `src/transport/dispatch/stream-bridge.ts`.

## Findings

### F1 — Identical wire-body decoders duplicated across chat and responses parses (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** Two byte-for-byte identical body decoders live in sibling
  surface modules:
  - `src/transport/surface/chat/parse.ts:64-72` `decodeBody`: `Uint8Array` →
    `JSON.parse(new TextDecoder().decode(value))`; string → `JSON.parse`;
    else identity.
  - `src/transport/surface/responses/parse.ts:69-75` `parseJsonBody`: same
    three branches, identical bodies.
  `completion.ts` (`bodyOf:28`) and `messages/parse.ts` (`asSurfaceBody:367`)
  additionally re-implement the "unwrap a `SurfaceInput` wrapper" step with
  subtly different predicates (path-type check, headers/path presence, body
  presence), so the four surfaces each carry their own copy of the wire-read
  convention.
- **Why it is real duplication.** The two decoder functions are textually
  identical and have the same contract (converts `Uint8Array | string | unknown`
  to the parsed JSON value, throwing `SyntaxError` on malformed input). They
  are pure and stateless; there is no state scope or ordering to preserve.
  Only the surrounding unwrap predicates differ, and those should stay local
  to each surface because they encode each wire's genuine envelope shape.
- **Proposal.** Add one shared `decodeWireBody(value: unknown): unknown` (e.g.
  in `src/transport/surface/content-parts.ts`, which is already the shared
  surface utility module) with the exact three-branch body; have `decodeBody`
  and `parseJsonBody` delegate to it (or be replaced by it at their call
  sites: `chat/adapter.ts:41,49` and `responses/parse.ts:83,85`). Leave the
  four unwrap helpers (`requestBody`, `bodyOf`, `unwrapBody`, `asSurfaceBody`)
  untouched — their predicates are intentionally surface-specific.
- **State/fallback analysis.** Pure function, no state, no fallback branch.
  Both current implementations throw the same `SyntaxError` on malformed JSON,
  and both call sites parse the same way after the shared helper returns; the
  `SyntaxError` propagates to the same error-normalization path. Memory
  behavior unchanged.
- **Fallback risk.** None. The helper is behaviorally identical to both copies
  by construction; no guard is loosened.
- **Verification.** `test/transport/surface-matchers.test.ts`,
  `test/transport/surface/responses-parse-tool-fold.test.ts`, and the chat
  parse paths in `test/protocol/wire-family-codec-coverage.test.ts` exercise
  both decoders end-to-end. Add one unit test asserting
  `decodeWireBody` matches both copies on the same inputs
  (`Uint8Array` bytes, JSON string, malformed string throws, non-string passthrough).

### F2 — Model-admission gate duplicated verbatim between `prepare` and `#planNative` (CONFIRMED)

- **Severity:** MED · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/transport/request/preparer.ts` runs the identical
  admission subsequence in both canonical and native preparation:
  - `prepare` (`preparer.ts:407-444`): `allowsCliToolMappings` →
    `resolveAliasTarget(snapshot, tenantId, model, allowCliMappings, ownerId)`
    → `isModelAllowed(authorization.snapshot, resolvedTarget, undefined, request.model)`
    → `authorization.modelPrefix` prefix check → `model_not_allowed` 403 throw.
  - `#planNative` (`preparer.ts:746-777`): identical sequence with identical
    error codes (`model_not_allowed`, 403), identical messages, and identical
    ordering.
  The two blocks differ only in which model string they pass (`request.model`
  after thinking-suffix stripping vs `input.model`), which is outside the
  duplicated subsequence.
- **Why it is real duplication.** Same contract, same state scope (the
  authorization snapshot and route snapshot), same ordering, same error
  semantics, same safety boundary (a hard 403 before any routing). This is the
  key's model-allowlist policy — a security posture gate — maintained in two
  copies. A future policy change that updates only one copy would silently
  split admission between the canonical and native surfaces.
- **Proposal.** Extract a private helper on `ProxyRequestPreparer`, e.g.
  `#resolveAliasAndGateModel(model: string, authorization, clientUserAgent?,
  snapshot): string` that returns the resolved target, performing
  `allowsCliToolMappings` → `resolveAliasTarget` → `isModelAllowed` → prefix
  gate → 403 throw in that exact order. Call it from both `prepare` and
  `#planNative`, passing each path's model string as today.
- **State/fallback analysis.** No state is mutated; the helper is a pure
  decision over `authorization.snapshot`, the route snapshot, scopes, and the
  model string. The snapshot is already fetched before both call sites, so no
  read ordering changes. Error semantics (code, status, message, `required_prefix`
  detail) are preserved verbatim.
- **Fallback risk.** Low — the sole hazard is reordering the prefix check vs
  the `isModelAllowed` check, or changing the argument order in
  `isModelAllowed` (called with `resolvedTarget` as model and `request.model`
  as requested-name). The helper must copy the current call order exactly.
- **Verification.** `test/transport/preparer-routing.test.ts:61-96` pins the
  native rejection (`model_not_allowed`, 403, whitelist and blacklist cases);
  chat-side admission is pinned by `test/transport/routing-admission.test.ts`
  and `test/transport/routing-admission-key.test.ts`. Both suites must pass
  unchanged after the refactor; add one test asserting the helper's prefix-gate
  ordering for both paths.

### F3 — Completion surface keeps two copies of the stop-reason and usage derivations (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/transport/surface/completion.ts` implements the same
  two derivations twice — once as module-level functions for the synchronous
  adapter, once as private methods on the streaming encoder:
  - `stopReason(events)` (`completion.ts:38-45`) and
    `CompletionStreamEncoder#stopReason` (`completion.ts:143-150`) are
    identical logic: locate the last terminal event; map `length`,
    `content_filter`, then `complete`/`stop`; else `null`.
  - `usage(events)` (`completion.ts:51-58`) and
    `CompletionStreamEncoder#usage` (`completion.ts:153-160`) are identical:
    terminal usage first, then the last `usage` event, then
    `usageToChatWire`.
  `modelFor` (`completion.ts:70-74`) likewise re-implements the shared
  "first `response_start`/`message_start` model" finder that chat's `getModel`
  (`chat/encode.ts:70-76`) and messages' `startModel` (`messages/encode.ts:249-255`)
  each also carry.
- **Why it is real duplication.** Each pair is textually identical except the
  event source (function argument vs `this.terminalEvent`/`this.usageEvent`).
  The sync and streaming encoders are intentionally separate state machines,
  so this finding is scoped to the shared derivations, not to merging the two
  encoders.
- **Proposal.** Hoist module-private `completionStopReason(terminal)` and
  `completionUsage(terminal, usageEvent)` functions in `completion.ts`; have
  both the sync adapter and the streaming encoder delegate to them. Optionally
  add a shared `firstStartModel(events)` helper exported from
  `src/transport/surface/adapters.ts` (or `content-parts.ts`) and route
  `getModel`, `startModel`, and `modelFor` through it — this part is a
  three-surface cleanup with identical semantics.
- **State/fallback analysis.** The derivations are pure scans over events or
  over two stored fields; hoisting them does not change interaction order
  inside the streaming encoder (which still records `terminalEvent`/`usageEvent`
  on push). Failure semantics unchanged: a failed terminal still yields
  `finish_reason: null` on the sync path and an error frame on the stream path
  — that divergence is deliberate and is preserved.
- **Fallback risk.** None for the stop-reason/usage hoists; the sync-vs-stream
  error-frame divergence is not touched.
- **Verification.** `test/transport/surface/completion-error-frame.test.ts`
  pins the streaming error-frame and length-terminal behavior; `test/transport/chat-error-frame.test.ts`
  pins the chat equivalent. Re-run both plus the gateway-level completion
  round-trip used by `test/helpers/gateway.ts` after the refactor.

### F4 — Duplicated route-gate boilerplate across the canonical-parse and route-preparation middlewares (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** `src/transport/guards/request-context.ts` repeats the same
  gate at the top of two `beforeHandle` hooks:
  - `createCanonicalRequestMiddleware` (`request-context.ts:144-151`):
    `fastPathname` → `/v1/` prefix → GET/HEAD skip → `isJsonProxyRoutePath(path)
    || isOpaqueBodyRoute(path)` skip.
  - `createProxyRoutePreparationMiddleware` (`request-context.ts:219-223`):
    identical four-step gate.
  `src/transport/guards/body-policy.ts` also exports two thin twins of the
  same private route predicate — `isProxyDispatchRoute` (`body-policy.ts:57-59`)
  and `isJsonProxyRoutePath` (`body-policy.ts:61-63`) — and request-context
  imports both to express nearly the same check at lines 100, 151, and 222.
- **Why it is real duplication.** The two middleware gates are textually
  identical and share the same intent (skip non-canonical proxy requests).
  Because they are maintained in two places, a future route-table policy change
  (e.g. a new opaque route) must be mirrored twice; the redundant twin exports
  make the API surface harder to navigate.
- **Proposal.** Extract one internal predicate in
  `src/transport/guards/request-context.ts`:
  `skipNonCanonicalProxyRequest(request): boolean`, implementing the exact
  four-step gate, and call it from both middlewares. In `body-policy.ts`,
  keep a single canonical public predicate (recommend `isProxyDispatchRoute`)
  and have `isJsonProxyRoutePath` delegate to it (or drop the alias and update
  the two call sites), so request-context has one import instead of two.
- **State/fallback analysis.** Pure path-string checks; no state, no fallback.
  The gate ordering is preserved identically (prefix before method before route
  table), so no route's body-read or parse behavior changes.
- **Fallback risk.** None. `isOpaqueBodyRoute` and `isJsonProxyRoutePath`
  keep their exact semantics; only the duplicated wrapper text is removed.
- **Verification.** `test/transport/body-policy.test.ts` pins
  `isJsonProxyRoutePath`/`isProxyDispatchRoute` semantics (including the
  `/v1/models` non-dispatch case and opaque-route cases);
  `test/transport/ingress-body-release.test.ts` and `test/helpers/gateway.ts`
  exercise both middlewares end-to-end. Re-run all after the refactor.

## Excluded / unverified suspects

- **`estimateInputTokens` (`token-estimate.ts`) vs `messageCharSize`
  (`preparer.ts:150-171`)** — both walk canonical messages summing per-part
  character costs, but with different caps, different per-kind treatment
  (token estimate prices image/audio/document as flat reserves and counts
  reasoning summaries; `messageCharSize` prices everything else via
  `JSON.stringify(data ?? "")` with a catch-64) and different purposes
  (admission reservation vs handoff-condense sizing). Similar syntax, not the
  same contract — left out per the no-duplicate-behavior rule.
- **Sync vs streaming encoders as a whole** (chat `jsonCompletion` vs
  `ChatStreamEncoder`, messages `MessagesAdapter.encode` vs `MessagesStreamEncoder`)
  — deliberately separate state machines with different wire shapes (whole
  message vs incremental SSE frames); the shared vocabulary (event text,
  reasoning-summary separator, tool-call tracker, usage conversion, finish/stop
  reason mapping) is already extracted to shared modules. Only the residual
  in-surface duplicates in F3 are actionable.
- **`captureEarlyRejectionPayload` vs the dispatch payload-capture path** —
  the early-rejection helper resolves the tenant preference through the same
  `resolvePayloadCapture` path by design (documented in
  `early-rejection-capture.ts:43-51`); this is an intentional integration, not
  duplication.
- **Messages and Responses system/developer hoisting** — both hoist top-level
  system/developer content into canonical `system`/`instructions`, but with
  wire-specific rules (Messages hoists mid-conversation `role:"system"` turns;
  Responses separates developer→instructions and merges consecutive
  tool-call turns). Conceptual similarity, not copyable logic.
- **Headroom guard vs readiness guard** — different policies (memory shed vs
  dependency readiness), different route scopes; only the `fastPathname`
  prefix check is common and insufficient to justify a merge.
- **Tenant-preference readers (`tenant-preferences.ts`)** — the four
  `readPreferences` call sites all go through the shared revision-keyed
  `CachedPreferencesReader`, so they are already consolidated behind one cache;
  the per-call try/catch fallbacks are intentional (non-fatal defaults).
- **`startProviderFlight` IP capture** — records `state.clientIdentity?.address
  || "unknown"`; under a reduced composition without the identity middleware the
  unique-IP gauge can bucket stragglers as "unknown", but the production
  pipeline resolves identity before dispatch, and the sweep tests pin the
  behavior. Noted, not a finding.

## Validation

- Method: codegraph symbol/call-path mapping first, then direct source reads
  for every finding; full-tree `Grep` for consumers of each duplicated symbol
  (`decodeBody`/`parseJsonBody`, `isJsonProxyRoutePath`/`isProxyDispatchRoute`,
  `stopReason`/`usage`/`modelFor`, `startModel`, the route gates in
  request-context). No code was executed or modified.
- The evidence quoted is from current on-disk source at the commit shown in
  git status (`0c012b1e`, branch `dev`).
- Tests referenced exist in the tree and pin the behaviors each finding
  preserves; none were run (read-only audit).

## Open questions

- F3's optional three-surface `firstStartModel` unification (chat `getModel`,
  messages `startModel`, completion `modelFor`) is behavior-identical today but
  touches three files and the streaming encoder's model-update branch; is it
  worth bundling, or should it stay a follow-up separate from the stop-reason/
  usage hoist?
- F2: should the helper also absorb the post-plan `policyCandidates` filtering
  (`preparer.ts:604-617` and `790-801`), which is a second duplicated
  `isModelAllowed` pass over plan candidates? It is only two lines per site and
  reads a different value (candidate model ids vs requested model), so it is
  left out of the finding to keep the refactor strictly mechanical.

## Execution status

Implementasi kampaian (2026-11-09), verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-04) — ✅.** Wire-body decoders deduplicated across chat/responses
  parses; same decode behavior preserved.
- **F2 (M-05) — ✅.** Model-admission gate single-sourced between `prepare`
  and `#planNative`.
- **F3 (M-06) — ✅.** Completion stop-reason/usage derivations unified.
- **F4 (M-07) — ✅.** Route-gate boilerplate consolidated across the
  canonical-parse and route-preparation middlewares.
