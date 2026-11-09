# Boot / Configuration Deep Audit — `src/boot/`, `src/config/`, `src/main.ts`, `src/version.ts`

Area: Boot, configuration, composition root (`src/boot/**`, `src/config/**`, `src/main.ts`, `src/version.ts`).
Type: read-only audit. No source, test, config, or documentation was modified.
Execution status: **Implementasi kampaian (2026-11-09).** Verified against the
full backend suite (4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero
errors in scope):

- **boot-01 (M-01) — ✅.** `flushAllBuffers(deps)` helper added in
  `src/boot/`; `main.ts`'s `flushBuffers` and `lifecycle.ts`'s
  `flushTelemetry` hook both call it. Same three buffers, same order, same
  writers; the shutdown deadline wrapper and console error propagation stay
  where they are.
- **boot-02 (M-02) — ✅.** `SurfaceAdapterRegistry.bySurface()` accessor added;
  `createGatewayApp` builds the pipeline's `adapters` map from it instead of
  re-spelling the four-surface literal.
- **boot-03 (M-03) — ✅.** Coordinator constructor defaults aligned to the
  production `bootstrap()` values (8_000 / 1_000); `totalShutdownBudgetMs()`
  inherits the same copy. No production behavior change (no caller relies on
  the bare defaults).

## Scope

Everything in the exclusive area was read in full: `src/main.ts` (201 lines), `src/version.ts`,
`src/boot/app.ts`, `src/boot/dependencies.ts`, `src/boot/lifecycle.ts`, `src/boot/timeout.ts`,
`src/boot/elysia-typebox-bridge.ts`, and every file in `src/config/`
(`spec.ts`, `spec-metadata.ts`, `runtime.ts`, `resources.ts`, `cooldowns.ts`, `timeouts.ts`,
`network.ts`, `security.ts`, `providers.ts`, `telemetry.ts`, `usage.ts`, `routing.ts`,
`package-paths.ts`). Consumers and tests were traced with CodeGraph and grep: the composition
root's callers (`test/helpers/gateway.ts`), the config drift guards (`test/config/*`), the
main.ts forwarding guard (`test/meta/production-deps-wired.test.ts`), the shutdown drain path
(`test/console/update-apply.test.ts`), and the console flush route
(`test/console/data-management.test.ts`, `src/console/data-management/routes.ts`).

Current flow, in one line: `main.ts` resolves boot-stable env handles (`port`, `maxBodyBytes`,
`topology`, `drainToken`), `bootstrap()` → `buildProductionDeps()` constructs every singleton
(db, redis, snapshot service, scheduler, flush buffers, sampler, pools), `createGatewayApp()`
composes the HTTP surface, and `ShutdownCoordinator.begin()` drains in-flight work, flushes
telemetry, and closes pools against the same buffers the console can flush manually.

## Findings

### boot-01 — Triple-flush sequence duplicated between console manual flush and shutdown drain (CONFIRMED, MED, S, no behavior change)

**Evidence**
- `src/main.ts:91-97`: `consoleApi.flushBuffers.flush` = `await boot.deps.telemetryBuffer.flush(); await boot.deps.usageFlush.flush(); await boot.deps.healthEventFlush.flush();`
- `src/boot/lifecycle.ts:219-223`: the `ShutdownCoordinator` `flushTelemetry` hook = the identical three awaits, same order, same writers.
- Consumer of the first: `src/console/data-management/routes.ts:74-85` (`POST /console/api/data-management/flush` → `config.flusher?.flush()`), wired through `src/console/domain-registration.ts:370` and `src/console/console-router.ts:64,237`.

**Mechanism.** Two places encode the authoritative list of the process's queued writers and their drain order. Both are the same three buffers with the same state scope (process-owned) and the same write semantics (each `flush()` is guarded: `usage-flush.ts:159-164`, `health-event-flush.ts:132-134`). Only the wrapper error semantics differ — the shutdown hook is deadline-bounded (`withTimeout`, errors swallowed in the coordinator) while the console route propagates errors to a 500 — and those wrappers are the right home for that difference.

**Why it matters.** This is a divergence hazard, not a perf issue. Adding a fourth buffered writer (telemetry, usage, or health-event analog) currently requires editing two places; if only one is updated, the console's "flush now" button silently stops draining a writer that shutdown still drains (or vice versa), which is exactly the class of quiet data-loss/divergence bug the repo's own test headers warn about.

**Proposal (bounded).** Extract one helper, e.g. `flushAllBuffers(deps: { telemetryBuffer; usageFlush; healthEventFlush }): Promise<void>` next to the existing flush buffers or in `src/boot/`, and call it from both `main.ts`'s `flushBuffers` and `lifecycle.ts`'s `flushTelemetry` hook. The shutdown deadline wrapper and the console error propagation stay where they are. Behavior change: none (identical calls, order, and state scope). Memory/state integrity: low risk; the shared helper preserves the same idempotent writers. Fallback risk: low; the only failure mode is a mechanical mistake that omits a writer, which the proposed test catches.

**Verification.** Add a unit test with stub buffers asserting all three are flushed in order; existing `test/console/update-apply.test.ts` (shutdown drain) and `test/console/data-management.test.ts` (disk housekeeping) plus a request-level test of `POST /data-management/flush` cover both wired call sites.

### boot-02 — Surface-adapter list enumerated twice in `createGatewayApp` (CONFIRMED, LOW, S, no behavior change)

**Evidence**
- `src/boot/app.ts:213-218`: `new SurfaceAdapterRegistry([chatAdapter, responsesAdapter, messagesAdapter, completionAdapter])`.
- `src/boot/app.ts:427-432`: `adapters: new Map<string, CanonicalAdapter>([["chat", chatAdapter], ["responses", responsesAdapter], ["messages", messagesAdapter], ["completion", completionAdapter]])` passed into `createTransportPipeline`.
- Consumer of the map: `src/transport/guards/pipeline.ts:121-126` → `createCanonicalRequestMiddleware` (`src/transport/guards/request-context.ts:167-200`) looks up `deps.adapters.get(detection.surface)`.
- Canonical surface strings live in `src/transport/surface/adapters.ts:72-89` (`SURFACE_DESCRIPTORS`), and each adapter declares the same string as its `surface` (`chat/adapter.ts:27`, `responses/adapter.ts:11`, `messages/adapter.ts:24`, `completion.ts:179`).

**Mechanism.** Two sibling lists of the same four singletons inside one function. The registry's keys (the adapters' `surface` values) are by construction the Map's keys, so the Map can be derived from the registry rather than re-spelled. Adding a fifth surface today means editing both lists in `app.ts` plus the descriptor table — three spots (four if you count the encode switch below).

**Proposal (bounded).** Give `SurfaceAdapterRegistry` a small accessor that exposes adapters keyed by surface (e.g. `bySurface(): ReadonlyMap<SourceSurface, SurfaceAdapter>` or a public readonly `adapters`), and build the pipeline's map from it (`new Map(registry.bySurface())`). This removes the duplicated literal from `app.ts` and makes the descriptor table plus one list the only source. Behavior change: none, provided the derived keys equal the surface strings (unchanged by construction). Memory/state integrity: none. Fallback risk: low; detection and parse flow are untouched.

**Verification.** Existing coverage already exercises this end-to-end: `test/helpers/gateway.ts` drives real requests through the composed pipeline, and `test/protocol/wire-family-codec-coverage.test.ts` pins the descriptor↔detection correspondence. Typecheck plus the four-surface codec coverage is the proof.

**Excluded part.** `src/transport/dispatch/proxy-request.ts:376-388` also hardcodes the four surfaces in an if/else that picks an encode call. It is intentionally **not** folded into this finding: the four encode signatures differ (`chatAdapter.encode`, `responsesAdapter.encodeOutput(events, {…model})`, `messagesAdapter.encodeOutput`, `completionAdapter.encodeOutput(events, {…prompt, echo, suffix})`), so a unified dispatch would change the option objects per surface — a different contract and a larger, riskier change.

### boot-03 — Drain-budget defaults duplicated between `ShutdownCoordinator` constructor and `bootstrap()`, already divergent (CONFIRMED, LOW, S, no production behavior change)

**Evidence**
- `src/boot/lifecycle.ts:32-40`: constructor defaults `drainWindowMs = 20_000`, `drainTimeoutMs = 5_000`, `flushTimeoutMs = 2_000`.
- `src/boot/lifecycle.ts:237-241`: `bootstrap()` passes `drainWindowMs: resolveShutdownDrainWindowMs()`, `drainTimeoutMs: 8_000`, `flushTimeoutMs: 1_000`.

**Mechanism.** The same conceptual drain budgets exist in two places with **different numbers** for two of the three (5s vs 8s drain timeout; 2s vs 1s flush timeout). Production always constructs the coordinator via `bootstrap()` (the only constructor call sites are `lifecycle.ts` and `test/helpers/gateway.ts:366`, which passes `{ drainWindowMs: 0 }` explicitly), so today's process behavior comes entirely from the `bootstrap()` values and the constructor defaults are effectively a second, divergent source of truth. Anyone reading the class to reason about drain timing gets a wrong answer, and a future edit to either side silently changes or fails to change drain behavior. `totalShutdownBudgetMs()` (line 49-51) then inherits whichever copy was used, so this also affects the force-exit guard in `main.ts:110-113`.

**Proposal (bounded).** Make the constructor defaults equal the production values (8_000 / 1_000), or better, require the `opts` in the constructor so the default path cannot drift from what `bootstrap()` actually ships. The latter touches the test helper that passes opts (no change needed there) and would surface any future caller that forgets budgets. Behavior change: none in production (no caller today relies on the constructor's bare defaults); only hypothetical no-opts callers would observe the aligned numbers. Memory/state integrity: none (timing only). Fallback risk: none.

**Verification.** Existing `test/console/update-apply.test.ts` stubs `totalShutdownBudgetMs` and exercises the drain surface; add/adjust a unit assertion on `ShutdownCoordinator` construction that the defaults equal the bootstrap-supplied values (or that opts are required).

## State / fallback analysis (per finding)

- **boot-01**: Both flush paths are idempotent and guarded; no state is lost or corrupted by sharing. The risk being *removed* is silent divergence when a writer is added to one path only. Fallback semantics (deadline-bounded shutdown vs erroring console route) are preserved by keeping the wrappers.
- **boot-02**: No persisted state involved. The Map is a process-local lookup table; deriving it from the registry changes no request behavior.
- **boot-03**: The budgets are wall-clock bounds only; aligning defaults changes no drain ordering, no in-flight abort decision, and no buffer write. The only behavioral surface is `totalShutdownBudgetMs()`, which is driven by whichever opts are in effect — unchanged for production.

No finding touches credentials, quota/routing snapshots, sessions, or telemetry payloads beyond the shared flush helper, which preserves the existing write set exactly.

## Validation

- Audit is read-only; nothing was executed against dev/production data.
- Proposed verification for each finding is listed above; the existing relevant suites are `test/config/*` (spec/env bijection, no-direct-env-reads, config reference, resources, elysia-precompile), `test/meta/production-deps-wired.test.ts`, `test/console/update-apply.test.ts`, `test/console/data-management.test.ts`, and `test/protocol/wire-family-codec-coverage.test.ts`.

## Open questions

1. `src/transport/dispatch/empty-stream.ts:71` hardcodes `DEFAULT_FIRST_EVENT_TIMEOUT_MS = 200_000` with a comment claiming it "matches CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS default". This is a second source of truth for the 200s first-chunk bound (spec default at `src/config/spec.ts:215-220`). Whether the Antigravity empty-stream recovery should intentionally stay decoupled from the operator knob, or read `resolveStreamFirstChunkTimeoutMs()`, is a product decision, not a mechanical one — left open.
2. Config-reader caching is deliberately split: `resolveUpstreamTimeoutMs`/`resolveStreamStallTimeoutMs`/`resolveInflightTtlSeconds` are memoized (`src/config/timeouts.ts:25-75`), while `resolveStreamFirstChunkTimeoutMs`, `resolveFallbackRetryBaseMs/CapMs`, `resolveRouteMaxAttempts` are not — and every cooldown resolver is memoized with a test reset hook (`src/config/cooldowns.ts:16-24,179-181`). This is **not** reported as a finding: the split is load-bearing. Tests mutate `CARTETHYIA_ROUTE_MAX_ATTEMPTS` and `CARTETHYIA_FALLBACK_RETRY_BASE_MS` between cases in-process (`test/transport/combo-attempt-budget.test.ts`, `test/transport/exhausted-attempts-completion.test.ts`, `test/transport/pool-egress-failover.test.ts`, `test/transport/retry-deadline-budget.test.ts`, `test/transport/failure-policy.test.ts`), so caching those without reset hooks would break them, and adding reset hooks would grow the maintenance surface. The asymmetry is explained, not arbitrary.
3. `resolvePort()` is re-read in `src/console/domain-registration.ts:289` (`createRemoteSupportService({ port: resolvePort() })`) in addition to `main.ts`; boot-time and cold, so not worth caching.

## Excluded / unverified suspects

- **`main.ts` → `createGatewayApp` field-by-field forwarding (30 lines)**: consolidating to a bulk spread of `boot.deps` is contraindicated. `test/meta/production-deps-wired.test.ts` exists precisely because a silently-dropped field caused a real outage (runtime sampler never binding → permanently-zero in-flight gate → forced-GC stalls). The explicit forwarding is the guard; removing it risks reintroducing that bug class.
- **Readiness dual-path** (`src/boot/app.ts:355-403` production uses the memoized `checkReadiness` via `deps.readiness`; the shell falls back to `checkDatabaseConnection`/`checkRedisConnection` at 181-193): the two probe implementations have different state scope (singleton `getDbHandle()` vs the passed handle), different timeouts (2000ms per check vs the 5000ms shared budget in `src/persistence/readiness.ts`), and the shell path is genuinely exercised by the AOT/tests composition. Not a safe consolidation.
- **`src/config/cooldowns.ts:8-13` `CooldownSpecEntry`** re-declares the int-entry shape instead of importing `IntConfigEntry` from `spec.ts` (which is not exported). Trivial (4-line type); noted, not worth a finding.
- **`src/config/resources.ts:32-34`**: an orphaned empty JSDoc block left from a refactor (a deleted constant's comment survived). Trivial cleanup; not a finding.
- **`src/transport/dispatch/proxy-request.ts` encode switch**: excluded from boot-02 (different encode contract, see above).
- **`src/config/package-paths.ts`** and **`src/version.ts`**: single-responsibility, no duplication found; `CARTETHYIA_VERSION` consumers are all leaf reads.

## Coverage notes

- All 18 files in the exclusive area were read in full; every resolver in `src/config/` had its external callers enumerated (grep) and the hot path ones traced to their call sites.
- CodeGraph was used for symbol/call-path mapping across `boot`, `config`, transport pipeline, routing, and persistence; uncovered details were confirmed with direct reads.
- No source, test, documentation, configuration, or git state was modified during this audit.
