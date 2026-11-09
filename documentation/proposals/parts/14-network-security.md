# Part 14 — Network egress, proxy pools, security & admission (deep audit)

## Scope

Read-only audit of `src/network/**` and `src/security/**` for concrete,
worthwhile consolidation opportunities (bloat, duplication, unnecessary work,
maintenance complexity) that preserve behavior. Priority constraints from the
operator: memory/state integrity and valid fallback behavior win over cleanup;
never propose removing apparently duplicated logic unless the copies share the
same contract, state scope, ordering, error semantics, and safety boundary.
Files were inspected as source plus tests; codegraph was used first for
symbol/call-path mapping, then direct `Read`/`Grep` for detail. No source,
test, config, or git state was modified.

## Current-flow evidence (traced)

- **Egress** `src/network/outbound-fetch.ts` (`createValidatedFetch`,
  `dial`, `nodeDial`, `relayRequest`) → SSRF guard `src/network/ssrf.ts`
  (`resolveAllAddresses`, `validateResolvedAddresses`, in-process DNS cache
  60s/64 entries) → `src/network/ip-utils.ts` (shared IPv4/IPv6/CIDR
  primitives, already consolidated from `ssrf.ts` + `security/ip-boundary.ts`
  per the module header).
- **Pool agents** `src/network/pool/agent.ts` (`createHttpProxyAgent`,
  `createSocks5Agent`, per-connect `createSsrfLookup`) built/cached by
  `src/network/pool/resolver.ts` (`PoolAgentResolver`, `ValidatedNetworkBindingFactory`),
  loaded by `src/network/pool/loader.ts` (`DrizzleNetworkPoolLoader`).
- **Pool admission** `src/network/pool/selector.ts` (`NetworkPoolSelector`:
  `tryAcquireAvailablePool`, `getSelectionFailure`, cooldown/block/inflight
  state) backed by `src/network/pool/pool-state.ts` (local maps + bounds) and
  `src/network/pool/pool-scripts.ts` (Redis Lua + key builders).
- **Pool health** `src/network/pool-health-machine.ts` (`recordPoolDispatchOutcome`,
  `disablePoolForProxyHttpStatus`, `recoverNetworkPool`,
  `sweepExpiredPoolCooldowns`, SSE `subscribePoolHealth`) and
  `src/network/pool-health.ts` (`flagPoolCooldown`, `flagPoolBlocked`, the
  per-(pool,provider) audit-row recorders), with the durable restart mirror
  `src/network/pool-cooldown-store.ts` (`upsert/drop/prune/restore`,
  `recordProbeVerdict`, `restorePoolProbeVerdicts`).
- **Failure classification** `src/network/rate-limit-verdict.ts`
  (`classifyEgressFailure`, `FREE_TIER_REFUSAL`) shared by dispatch
  (`src/transport/dispatch/attempt-loop.ts:400`, `streaming/finalize.ts:583`)
  and the probe (`src/console/routing/pools/probe-verdict.ts:44`).
- **Admission** `src/security/admission/service.ts` (`ApiKeyAdmissionService`),
  Redis store `src/security/admission/redis-store.ts` + Lua
  `src/security/admission/lua.ts`, single-process store
  `src/security/admission/in-memory-store.ts`, key/TTL arithmetic
  `src/security/admission/ttl.ts`, reasons `reasons.ts`, bucket helpers
  `buckets.ts`, lease sweeper `src/security/admission/lease-sweep.ts`.
- **Auth** `src/security/api-key-auth.ts` (`resolveApiKeyAuthorization`,
  L1 process cache + L2 `readShared`/`writeShared`, `invalidateApiKeyCache`)
  and `src/security/api-key-auth-cache.ts`
  (`createApiKeyAuthorizationCache`: positive/negative TTL cache, per-keyId
  invalidation, store-outage cooldown).
- **IP abuse** `src/security/abuse.ts` (`IpAbuseProtectionService`,
  `InMemoryIpAbuseStore`, `RedisIpAbuseStore` + `IP_ADMISSION_SCRIPT`).
- **Identity/headers** `src/security/ip-boundary.ts`, `access-control.ts`,
  `outbound-headers.ts`, `csrf.ts`, `client-router-fingerprint.ts`,
  `cli-client-fingerprint.ts`, `model-access-rule.ts`, `crypto.ts`.

## Findings

### F1 — Duplicated provider-scoped egress verdict audit-row writers (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** no.
- **Mechanism.** Three sites build and insert the same `health_events`
  row for a provider-scoped egress verdict — `entityKind: "pool"`,
  `networkPoolId`, `fromStatus: null`, `toStatus: "cooldown"`,
  `reason: "provider <id>: <reason>"`, `errorCategory` one of
  `rate_limit_transient` / `egress_blocked`:
  - `src/network/pool-health.ts:38-52` `recordPoolCooldownEvent` (coalesced:
    15-min per-(pool,provider) window, `lastRecordedByPoolProvider` map);
  - `src/network/pool-health.ts:126-146` `recordPoolBlockEvent` (not
    coalesced; appends `providerCodeSuffix(error)` to the reason);
  - `src/network/pool-cooldown-store.ts:160-186` `recordProbeVerdict`
    (not coalesced; picks category from `marker.blocked`).
  `recordPoolDispatchOutcome` (`pool-health-machine.ts:149`, `219`, `247`,
  `269`) writes *pool status transitions* (non-null `fromStatus`) — a
  different fact, not part of this duplication.
- **Why it is real duplication.** Identical insert shape, identical
  id-generation (`randomUUID`), identical fire-and-forget swallow (log/`catch`
  in `pool-health.ts`, try/catch in `pool-cooldown-store.ts`). The divergences
  are exactly three explicit knobs: coalescing window, optional code suffix,
  category. They are not different contracts — the console reads all of them
  through the same `listNetworkPoolHealthEvents` view.
- **Proposal.** Add one internal helper in `src/network/pool-cooldown-store.ts`
  (already imported by `pool-health.ts`): `appendPoolProviderEgressAuditRow(db,
  { poolId, providerId, reason, blocked, codeSuffix?, coalesceWindowMs? })`,
  owning the insert, the coalescing map (kept per call-site as today), and the
  swallow. Route the three call sites through it. `recordProbeVerdict` keeps
  its marker upsert; the helper replaces only its insert.
- **State/fallback analysis.** Audit rows are append-only and read only by
  console listing — routing never reads them. Consolidation must preserve the
  coalescing map semantics exactly (default `coalesceWindowMs` undefined ⇒ no
  coalesce, so block/probe rows are never deduped) and the code suffix only on
  the block path. Fallback risk: none, the swallow contract (never throw to
  dispatch; metric `pool_cooldown_record_failed`) is centralized unchanged.
- **Verification.** `test/network/pool-health.test.ts` pins the two row
  categories and reason shapes; `test/network/pool-cooldown-store.test.ts`
  pins the probe rows and the 15-min coalescing (`recordPoolCooldownEvent`).
  Both pass unchanged after the refactor; add one unit test asserting a
  non-coalesced call with `coalesceWindowMs` set still dedupes while the
  default does not.

### F2 — Failure-path pool reads issue unbatched Redis round trips (PLAUSIBLE)

- **Severity:** LOW · **Effort:** M · **Behavior change:** no.
- **Mechanism.** `NetworkPoolSelector.getSelectionFailure`
  (`src/network/pool/selector.ts:883-965`) runs per eligible pool:
  `isProviderCooldown` (Redis `GET` on local miss), `getInflightAuthoritative`
  (Redis `GET`), and, when a provider ceiling is set,
  `getProviderInflightAuthoritative` (Redis `GET`). Even parallelized, that is
  up to 3×N Redis round trips on the failure-explain path (dispatch leases
  `src/transport/dispatch/leases.ts:195`, account test egress
  `src/console/quota/account-test-egress.ts:147`). Meanwhile
  `tryAcquireAvailablePool` (`selector.ts:721-726`) performs its own per-pool
  `isProviderCooldown` pre-read, then a separate batched `MGET` for scoring
  (`selector.ts:801-807`).
- **Why it is worthwhile.** The module already documents prior round-trip
  batching wins (MGET score read; "one pass not two"). The failure path is the
  one that runs precisely when an operator is diagnosing a stuck pool; the
  console pool page and dispatch lease both pay the serialized per-pool cost.
  `getPoolCooldowns` already demonstrates the batched `MGET` + stale-cleanup
  pattern (`selector.ts:450-500`) that the failure path could reuse.
- **Proposal.** In `getSelectionFailure`, batch cooldown markers and inflight
  counters for all candidate pools into one `MGET` (plus one `MGET` for the
  provider-share counters when a ceiling is set), parse locally, and hydrate
  the local cooldown map exactly as `isProviderCooldown` does today. Keep the
  stale-marker cleanup semantics: expired markers are dropped from Redis
  (`clearRedisCooldown`) on read, matching the current `isProviderCooldown`
  behavior.
- **State/fallback analysis.** Cooldown hydration must stay identical: local
  map gets the same parsed entry, same `enforceCooldownLimit`, same error
  handling (Redis failure ⇒ `{ inCooldown: true, reason: "cooldown store
  unavailable" }` → `coordination_unavailable`). Memory/state integrity is
  unchanged if the helper is a straight read + hydrate; the risk is only in
  re-implementing the local-hydration ordering, which is why this is scoped
  and test-pinned.
- **Verification.** `test/network/pool-cooldown-store.test.ts:116,322-324` and
  `test/console/pool-probe-enforcement.test.ts:107-198` pin `getSelectionFailure`
  verdicts and `tryAcquireAvailablePool` behavior; re-run them plus an added
  Redis-mock test asserting exactly one `MGET` per failure read and identical
  verdict output.

### F3 — Misleading comment contradicting the negative auth cache (CONFIRMED)

- **Severity:** LOW · **Effort:** S · **Behavior change:** none (comment only).
- **Mechanism.** `src/security/api-key-auth.ts:24` states: "Negative results
  (unknown/revoked tokens) are deliberately NOT cached, so a newly minted key
  is usable immediately." The implementation negative-caches for 1.5s:
  `src/security/api-key-auth-cache.ts:4` `AUTH_NEGATIVE_CACHE_TTL_MS =
  1_500`, `rememberNegative` (line 70) with `negativeEntries` map, consulted at
  `lookup` (lines 49-53). A token rejected within the last 1.5s is refused
  even if the key is minted/revoked-state changes in between; the negative
  entry is cleared only by `invalidate` (which the API-key domain calls on
  mutation) or TTL expiry.
- **Why it matters.** The comment is the spec a future maintainer reads to
  decide whether `resolveApiKeyAuthorization` can serve a just-minted key. It
  is wrong in both directions: the cache is not "deliberately NOT cached", and
  the "usable immediately" guarantee holds only because `invalidateApiKeyCache`
  clears negative entries on mutation — not because negatives are absent.
- **Proposal.** Rewrite the comment to state the real contract: unknown tokens
  are negative-cached for 1.5s; immediate usability after a mutation is
  provided by `invalidateApiKeyCache` clearing the negative entries, not by
  the absence of a negative cache. Optionally hoist `AUTH_NEGATIVE_CACHE_TTL_MS`
  next to the comment so the two cannot drift again.
- **State/fallback analysis.** No code change; the negative-cache TTL and its
  invalidation interplay are preserved exactly. This is a documentation fix
  that eliminates a real maintenance trap on the auth hot path.
- **Verification.** `test/security/api-key-auth-cache.test.ts` pins negative
  caching and invalidation; nothing changes. Update the adjacent comment and
  re-run the suite.

### F4 — Repeated hand-rolled bounded-map eviction despite a shared helper (PLAUSIBLE)

- **Severity:** LOW · **Effort:** M · **Behavior change:** no for the
  eviction-relevant sites, if semantics are copied verbatim.
- **Mechanism.** A shared `BoundedLruMap` exists at
  `src/transport/routing/bounded-lru.ts` and is used by five routing-layer
  callers. Several network/security caches still hand-roll the same
  "evict oldest insertion-order entry past a cap" loop:
  - `src/network/ssrf.ts:37-46` `cacheDnsResult` (64 entries);
  - `src/network/pool/byte-accounting.ts:44-55` `entry()` (10_000);
  - `src/security/api-key-auth-cache.ts:20-44` `evictOldest` /
    `evictNegativeOldest` (10_000 each).
  (Comparable loops also remain in `provider-caches.ts` catalog cache,
  `pool-state.ts` `enforceCooldownLimit`/`enforceInflightLimit`, `abuse.ts`
  `evictOldest`, and `resolver.ts` agent cache.)
- **Why it is worthwhile.** The shared class already documents that the routing
  layer used to hand-roll this twice with subtly different code and that one
  implementation makes the bound provable once. The DNS cache and byte
  accounting are the two smallest, most self-contained fits; both are pure
  production-order eviction with no recency refresh today, so adopting
  `BoundedLruMap` (or a small shared eviction helper) is mechanical.
- **Proposal.** Replace the DNS-cache and byte-accounting maps with
  `BoundedLruMap` or with a shared `evictOldestEntry(map, cap)` helper whose
  semantics match the current code (evict while `size > cap`, insertion-order
  oldest first). The API-key auth cache is a deliberate exception: its lookup
  re-inserts to refresh recency, its invalidation walks hashes by keyId, and
  its negative map stores timestamps — leave it hand-rolled unless a later
  change rewrites the whole cache, and keep this finding away from it.
- **State/fallback analysis.** The DNS cache and byte totals are process-local,
  advisory (a lost DNS answer re-resolves; a lost byte total is at most one
  flush interval stale per the module's own contract). The eviction bound is a
  memory ceiling, not correctness; identical ordering preserves the existing
  worst-case behavior.
- **Verification.** `test/network/ssrf-policy.test.ts`, `test/network/vpn-dns.test.ts`,
  and `test/network/pool-state.test.ts` pin DNS cache bounds and byte totals
  (including `poolByteTotals`/`poolByteSnapshot`); add one unit test asserting
  the shared helper's eviction ordering matches insertion order.

## Excluded / unverified suspects

- **`TtlCache` vs `createApiKeyAuthorizationCache`** — distinct contracts (no
  negative caching or per-keyId invalidation in `TtlCache`); not a safe merge.
  Left out.
- **`poolByteTotals` export** (`byte-accounting.ts:67`) — referenced only by
  tests (`test/network/pool-state.test.ts`); no production caller found by
  full-tree search. A candidate dead export, but grep-only evidence → noted,
  not a finding (per the no-deadness-from-grep rule).
- **`InMemoryIpAbuseStore` vs `RedisIpAbuseStore`** — intentional dual
  implementations of `IpAbuseStore` for single-process vs distributed mode,
  matching the admission store pattern; not duplication.
- **`getSelectionFailure` vs `tryAcquireAvailablePool` selection logic** — two
  surfaces with different contracts (failure explainer vs admission); shared
  helpers already exist (`effectiveConcurrency`, `normalizedWeight`,
  `isProviderCooldown`). The residual overlap is the batched-read opportunity
  in F2, not a merge.
- **`resolver.ts` per-connect SSRF revalidation (`createSsrfLookup`) vs
  create-time `validateDialHost`** — deliberate two-layer rebind protection
  (documented in `agent.ts`); removing either would weaken a security boundary.
- **`relayRequest` header construction vs `agent.ts` `isRelayHost`** — one
  writes, one classifies; no duplication.
- **`classifyEgressFailure` inline `/freetier|free.?tier/i` vs exported
  `FREE_TIER_REFUSAL`** — the inline regex applies to provider codes, the
  constant to body text; a deliberately different check, not a copy.

## Validation

- Method: codegraph symbol/call-path mapping first, then direct source reads
  for every finding; full-tree `Grep` for consumers of suspect exports and of
  each duplicated row shape. No code was executed or modified.
- The evidence quoted is from current on-disk source at the commit shown in
  git status (`0c012b1e`, branch `dev`).
- Tests referenced exist in the tree (`test/network/…`, `test/security/…`,
  `test/console/pool-probe-enforcement.test.ts`) and pin the behaviors each
  finding preserves; none were run (read-only audit).

## Open questions

- Should F2 also batch the `tryAcquireAvailablePool` pre-read cooldown checks
  into the existing score `MGET`? It would save one round-trip wave per request
  on the hot dispatch path, but touches the per-request selection path and
  needs its own latency benchmark — left as a follow-up, not bundled.
- Whether `BoundedLruMap` (recency-refreshing) should replace the DNS/byte
  maps outright or a shared helper should be introduced first is a design call;
  both options preserve current ordering, but changing the DNS cache to
  recency ordering would alter eviction under read-heavy traffic and is not
  recommended without a separate justification.

## Execution status

**Implementasi kampaian (2026-11-09).** Verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-56) — ✅.** Provider-scoped egress-verdict audit-row writers
  deduplicated; the shared helper is exported from `network/rate-limit-verdict.ts`
  and consumed by `pool-cooldown-store.ts` (all three writers).
- **F2 — ⛔ (plausible-unverified).** Failure-path unbatched Redis round trips
  — latency optimization, deferred (needs benchmark).
- **F3 (M-58) — ✅.** Misleading comment contradicting the negative auth cache
  corrected.
- **F4 — ⛔ (plausible-unverified).** Repeated hand-rolled bounded-map eviction
  — `BoundedLruMap` refreshes recency; the sites are FIFO, not a semantic
  match, so no merge.
