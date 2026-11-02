# Report 01 — boot/config/workers

Scope audited: `src/boot/` (app.ts, dependencies.ts, elysia-typebox-bridge.ts, lifecycle.ts, timeout.ts), `src/config/` (cooldowns.ts, network.ts, package-paths.ts, providers.ts, resources.ts, runtime.ts, security.ts, spec.ts, telemetry.ts, timeouts.ts), `src/workers/` (account-identity-sweep.ts, buddy-growth-tasks.ts, daily-checkin.ts, maintenance-lease.ts, oauth-refresh-sweep.ts, quota-refresh-sweep.ts, scheduler.ts, sweep-runner.ts), plus `src/main.ts` and `src/version.ts`. Every `.ts` file read completely. Cross-references verified against the whole repo (`src/`, `test/`, `scripts/`, `dashboard/src/`).

---

## Findings

### DEAD-CODE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| D1 | `src/workers/maintenance-lease.ts` | 102–122 | `createNoopMaintenanceLeaseStore()` — exported, zero references anywhere in the repo (grep: only the definition). The registry simply omits the lease option when Redis is absent, so this store is never constructed. | Remove it (and its `MaintenanceLeaseStore` doc references), or privatize. |
| D2 | `src/workers/buddy-growth-tasks.ts` | 344–346 | `growthClientToken(prefix)` — exported, zero references outside its own definition. | Remove. |
| D3 | `src/config/providers.ts` | 10–20 | `requirePublicOrigin()` and `oauthCallbackUrl()` — the only reference is `oauthCallbackUrl` calling `requirePublicOrigin`; no consumer anywhere. This is the sole spec-driven reader of `CARTETHYIA_PUBLIC_ORIGIN` (see S2). | Remove both, or port the live consumer (`console/auth/session-service.ts:45`) onto the spec reader. |
| D4 | `src/config/resources.ts` | 22 | `FALLBACK_MEMORY_LIMIT_BYTES` — referenced only by `test/config/resources.test.ts`; production memory fallback lives in `observability/runtime-metrics.ts:97` (`LAST_RESORT_MEMORY_LIMIT_BYTES`). Two different "fallback" constants exist; the resources.ts one is dead in prod. | Delete from prod code (move expectation into the test or drop), keeping one canonical fallback. |
| D5 | test-only exports | `src/workers/daily-checkin.ts:72,77`; `src/workers/buddy-growth-tasks.ts:44`; `src/workers/scheduler.ts:170,175` | `pendingCheckinCount`, `clearPendingCheckinRequests`, `BUDDY_TASK_NAMES`, `leaseSkips`, `lastLeaseSkipAt` — all referenced only from `test/`. Production registers task names as literals, never via `BUDDY_TASK_NAMES`. | Keep only if the test suite is the intended consumer; otherwise move to test helpers or annotate `@internal` (not part of the public surface). |

### DUPLICATION

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| U1 | `src/config/cooldowns.ts` | 9–184 | Eleven resolvers (`resolveAccountRateLimitCooldownMs` … `resolvePoolProviderRateLimitCooldownMs`) are byte-for-byte copies of the same `if (cache === undefined) cache = readInt(...)` pattern, each with its own module-level cache var and `resetCooldownCacheForTests` duplicating the reset list. | Extract one shared `cachedCooldownMs(name, entry)` helper (single `Map` cache keyed by var name) and have all eleven call it; reset becomes `cache.clear()`. |
| U2 | `src/boot/dependencies.ts` | 140–148 | Local `withTimeout` duplicates `src/boot/timeout.ts:10–24` (shared version adds `unref` + custom message). | Import the shared `withTimeout` from `./timeout`; drop the local copy. |
| U3 | `src/boot/app.ts` | 177–179 | `runDependencyReadinessCheck` is a 2s timeout wrapper over `withTimeout`; `src/persistence/readiness.ts:72–81` implements the same shape (`withTimeoutCheck`). | Consolidate into one shared helper (e.g. reuse `readiness.ts`'s) instead of two near-identical implementations. |
| U4 | `src/workers/daily-checkin.ts` | 321–351 vs 273–319 | `checkinAttemptedToday` (single account) and `checkinAttemptedTodayBatch` duplicate the same Redis-then-DB branch logic; `markCheckinAttempted` mirrors `reserveDaySlot` writes. | Let the batch function be the single implementation; express the single-account read as the batch with `[id]` (or vice versa). |

### BLOAT

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| B1 | `src/boot/lifecycle.ts` | 156–166 | `flushTelemetry`'s guard is a nested conditional maze: `if (remaining <= 0 || !hook) { if (remaining > 0 && !hook) { sleep(min(remaining,5)) } return }`. The "simulate flush" branch (a 1–5 ms wait when there is no hook) is hard to follow and its purpose is undocumented. | Rewrite as: `if (remaining <= 0) return; if (!hook) return;` — drop the simulated-delay branch or document it and give it a named constant. |
| B2 | `src/workers/quota-refresh-sweep.ts` | 260–512 | `quotaRefreshSweep` is one ~250-line function mixing: target listing + cache-age batching, eligibility, sort/select policy (queued/buddy/freshness), the quota run, the check-in ride-along, per-item error shaping, log-line suppression, and slot release. | Extract `selectBatch`, `runCheckinRideAlong`, and the per-line suppression into named helpers (the file already has `logSweepAccounts`; follow that pattern). |
| B3 | `src/boot/dependencies.ts` | 212–704 | `buildProductionDeps` is ~490 lines: connection boot, provider registration, admission, lease/task registration (13 `register` blocks), and the deps assembly. The task-registration blocks are long and visually repetitive. | Extract a `registerMaintenanceTasks(registry, ctx)` helper with a per-task builder, keeping the boot ordering explicit. |

### ANTI-PATTERN

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| A1 | `src/main.ts` | 63–64 | `resolveDrainToken()` called twice in one expression, second call cast `as string` — relies on identical env read, and the cast papers over a narrowing failure. | `const drainToken = resolveDrainToken();` once, then `...(drainToken !== undefined ? { drainToken, triggerDrain: () => shutdown("SIGTERM") } : {})`. |
| A2 | `src/boot/app.ts` | 209 | `result.body as unknown as BodyInit` double cast on the static-handler body. | Type `StaticHandler`'s body as `BodyInit | null` at its source (dashboard-assets) so no cast is needed here. |
| A3 | `src/workers/quota-refresh-sweep.ts` | 437–442 | `(await deps.checkinFetcherFor(...)) as unknown as typeof fetch` double cast to satisfy the `fetch`-typed check-in fetcher. | Tighten `checkinFetcherFor`'s return to `typeof fetch | ValidatedFetch` once; avoid double cast. |
| A4 | `src/workers/maintenance-lease.ts` | 138–146 | `redis as unknown as { eval: ... }` to reach `eval` on the Redis client — non-strict typing hole. | Add `eval` to the `RedisClient` interface (or a typed extension) instead of casting. |
| A5 | `src/workers/daily-checkin.ts` | 288–290 | `(await args.redis.mget(...)) as Array<string | null>` cast on MGET result. | Type the Redis client's `mget` return; avoid the unchecked cast. |
| A6 | `src/boot/lifecycle.ts` | 108–112 | `try { this.hooks.abortInflight?.(); } catch {}` — empty catch silently swallows abort failures during drain. | At least `log.warn` the abort failure; silent swallow hides a leak of in-flight work into `close_pools`. |
| A7 | `src/workers/scheduler.ts` | 336 | `await lease.release().catch(() => undefined)` swallows release errors after a failure. | Log at `warn` (the TTL is the backstop, but the failure should be visible). |
| A8 | `src/config/spec.ts` | 333, 358, 364 | `readOptionalText`, `readFlag`, `readList` take unused `entry` params and `void entry;` to appease the compiler — a typing smell where the entry is decoration. | Either consume the entry (validate kind) or drop the parameter from these readers. |

### OPTIMIZATION-OPP

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| O1 | `src/main.ts` | 52, 63–64, 144, 147 | `resolveMaxBodyBytes()` computed twice, `resolveDrainToken()` twice, `resolveProcessTopology()` re-read per use — each is an env parse+range-check on a cold path, but trivially avoidable. | Hoist to `const maxBodyBytes = resolveMaxBodyBytes();`, `const topology = resolveProcessTopology();`, `const drainToken = resolveDrainToken();` and reuse. |
| O2 | `src/console/domain-registration.ts` | 235, 279, 307 | `resolveSsrfPolicy()` called three times within one registration pass (per provider sync). | Resolve once at the top of the registration and pass the policy object through. |
| O3 | `src/boot/dependencies.ts` | 421–459 | `readRoutingAccountInflight` memoizes exactly one `DrizzleProviderCatalogStore` (`lastInflightTenant`/`lastInflightStore`); any tenant switch rebuilds a heavy store object. Under multi-tenant console polling this churns per switch. | Cache per-tenant with a bounded `Map` (or reuse a small shared pool) instead of a single-entry memo. |

### STALE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| S1 | `src/config/spec.ts` | 18, 88 | `DASHBOARD_DIST` spec entry (default `"./dist/dashboard"`) is never consumed through any spec reader — `src/config/runtime.ts:15` reads `process.env.DASHBOARD_DIST` directly and falls back to `resolvePackagePath("dist","dashboard")` (absolute, `PACKAGE_ROOT`-based). Two sources of truth for the default. | Route `resolveDashboardDist` through `readText` (or remove the spec row and the `.env.example` line together) so one default wins. |
| S2 | `src/config/spec.ts` | 271–275 | `CARTETHYIA_PUBLIC_ORIGIN` is declared `required`, but its only spec-driven readers (`requirePublicOrigin`) are dead code (D3). The live consumer `console/auth/session-service.ts:45` reads via injected env without enforcement — so the "required, throws at startup" contract is not actually enforced. | Wire the startup check (or move the required validation into the live consumer) once the dead functions are removed. |

---

## OK — verified clean

- `src/version.ts` — single-source constant, consumed by two callers; no issues.
- `src/boot/elysia-typebox-bridge.ts` — side-effect module with a clear explanatory contract; no cleanup needed.
- `src/config/package-paths.ts` — small, single-purpose; all exports used; no dead/duplicate logic.
- `src/config/security.ts` — small, pure, tested; `decodeEncryptionKey` hex/base64 path is deliberate.
- `src/config/telemetry.ts` — thin, clean.
- `src/config/network.ts` — resolvers small; `DEFAULT_BOUNDS` consumed by `db-pg.ts` and `telemetry-buffer.ts`; platform-token handling is careful.
- `src/config/timeouts.ts` — module-level lazy caches are deliberate and correct (boot-stable env, hot per-request callers); doc comment explains why.
- `src/workers/sweep-runner.ts` — the shared sweep skeleton is genuinely reused by three sweeps; no duplication found.
- `src/workers/account-identity-sweep.ts` — clean; single-batch `list` avoids N+1 (documented).
- `src/workers/oauth-refresh-sweep.ts` — clean; refresher memoization is per-pass and correct.
- `src/workers/maintenance-lease.ts` — Lua scripts, token-conditional release, TTL clamping all sound (only the `eval` cast at A4).
- `src/workers/scheduler.ts` — registry invariants (single-flight gate, idempotent `register`/`start`, unref'd timers, precomputed disabled set, lease deadline) are solid.
- `src/boot/app.ts` route composition and `src/boot/lifecycle.ts` drain ordering — coherent (aside from listed A2/A6/B1).
- No `any`, `@ts-ignore`, or blanket suppressions anywhere in `src/boot/`, `src/config/`, `src/workers/` (grep verified); the only loose typing is the casts listed under ANTI-PATTERN.

---

## Summary counts

| Severity | Count |
|----------|-------|
| DEAD-CODE | 5 |
| DUPLICATION | 4 |
| BLOAT | 3 |
| ANTI-PATTERN | 8 |
| OPTIMIZATION-OPP | 3 |
| STALE | 2 |
| **Total** | **25** |