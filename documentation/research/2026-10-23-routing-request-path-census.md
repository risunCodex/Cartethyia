> # ARCHIVED — UNTRUSTED
>
> This file was archived on 2026-10-23. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. Do not read it as current behavior or cite it as evidence.

# Request-path census: every DB call and allocation per request

Investigation only. No code changed. Every claim below cites `file:line`.

---

## 0. The shape of the problem

Two separate things are being reported as one symptom.

**Per-request DB calls** — real, but smaller than "every request hits the DB"
suggests. Most hot reads *are* cached. What is not cached is narrow and
identifiable (§2).

**Memory that spikes and does not settle** — measured to settle. This is a peak
concurrency effect, not a leak (§4). The fix is reducing what each concurrent
request holds, not reclaiming.

Conflating them would produce the wrong fix: caching everything would not bring
peak RSS down, because the peak is driven by per-request buffers, not by DB rows.

---

## 1. DB calls per request, by phase

### Auth — up to 3 reads on a miss, 0 on a hit

`resolveApiKeyAuthorization()` (`src/security/api-key-auth.ts:282`), once per
`/v1/*` request from `src/transport/guards/auth-guard.ts:42`.

On a cache miss:
- `api-key-auth.ts:296` — `store.findActiveByHash(hash)`
- `api-key-auth.ts:307` — `store.findActiveById(row.parentKeyId)` (share children only)
- `api-key-auth.ts:316` — `store.sumChildrenConsumed(policy.id)` — a SUM, every miss

Cache: `authCache` (`:37`), TTL `AUTH_CACHE_TTL_MS = 3_000` (`:25`), cap 10 000
(`:26`), with a `keyId → hashes` reverse index (`:39`) for targeted eviction.
Negative results cached 1 500 ms (`:28`). `invalidateApiKeyCache(keyId?)`
(`:93`) clears both on mutation.

**Hazard worth naming:** `lifetime_tokens_consumed` is a *mutating* figure folded
into a *cached* snapshot. The module says so (`:16-20`) and is safe only because
spending is enforced by the admission counter, not by this value.

### Tenant config — 0 on a hit

`applyTenantPreferences` (`src/transport/dispatch/proxy-request.ts:128`) →
`CachedPreferencesReader` (`src/persistence/tenant-preferences.ts:44`):
`TtlCache` 5 s (`:54`), cap 128, keyed `${tenantId}:${revision()}` (`:61`).
The revision is a process-global counter bumped on every settings write, so
mutations converge immediately rather than waiting out the TTL.

One memo serves three hot readers: preferences, the tenant concurrency limit
(`src/boot/dependencies.ts:216`), and the payload-capture policy.

### Route catalog — 0 on a hit, 11 SELECTs on a rebuild

`InMemoryRouteSnapshotService.getSnapshot()` (`src/transport/routing/route-model.ts:435`)
returns a memoized `deepFreeze`d snapshot (`:406`) built from **11 parallel
SELECTs** (`src/transport/routing/route-catalog.ts:373-390`: providers, models,
provider_accounts, aliases, combos, routing settings, pools, disabled models,
CLI mappings, CLI settings, pool settings).

Cached until `invalidate()` (`:451`). In-flight builds are revision-tagged
(`:437`, `:494`) so a write landing mid-build cannot clobber or be clobbered —
the comment at `:418-431` records both failure modes that tagging fixes.

Aliases, combos, and CLI mappings all ride this snapshot
(`route-model.ts:478-488`); `resolveAliasTarget` and `routingEngine.plan` read
it, not the DB. **Model/provider mapping is already zero-cost per request.**

### Credential — 1 read + decrypt per *attempt*, for OAuth

`resolveCredentialForAccount` (`src/providers/operations/provider-credential-service.ts:151`),
called per attempt (`proxy-request.ts:167`), so up to N times per request on
failover. Cached in `credCache` (`:34`), TTL 5 s (`:26`), cap 2 000.

OAuth credentials are **deliberately not cached** (`:220`:
`safeToCache = !isOAuth || dueAt > now + CRED_CACHE_TTL_MS`), and the hit path
re-checks `credential_kind !== "oauth"` (`:158`). So an OAuth account pays one
SELECT + AES-GCM decrypt on essentially every attempt. **This is the largest
remaining per-request DB read, and it is per-attempt, not per-request.**

### Admission — write path, shared, not Postgres

`ApiKeyAdmissionService.admit` (`src/security/admission/service.ts:71`) and
`commitUsage` (`:140`) go to Redis Lua (`src/security/admission/lua.ts`) or an
in-memory store. Shared when Redis is configured (`dependencies.ts:208`),
process-local otherwise. Correct by design — it must be fleet-wide to enforce
limits.

### Usage persistence — already off the hot path

`UsageFlushBuffer.enqueue` (`src/persistence/usage-flush.ts:104`) never touches
the DB. A 1 s timer flushes coalesced deltas as one
`UPDATE ... FROM (VALUES ...)` (`:77`), chunked at 500 keys. The header (`:11-27`)
records why: one UPDATE per request bound throughput on the embedded backend,
and 300 keys measured 129 ms as separate UPDATEs vs 4 ms batched — 28x.

**Nothing to do here.**

### Account health — write path, per attempt, uncached

`reportAttemptOutcome` (`src/providers/operations/account-health-service.ts:1326`)
→ `recordAccountFailure` (`:876`): narrow projected SELECT (`:895`, deliberately
excluding `credential_ciphertext`) + UPDATE + `health_events` INSERT, in a
transaction.

**The costly interaction:** any mutating classification calls
`snapshotService.invalidate()` (`:1343`). A single account-health transition
therefore drops the **entire** route snapshot, and the next request pays all 11
SELECTs. Under a failure wave this is a snapshot-rebuild storm — each failed
attempt invalidates, and each following request rebuilds.

### Pool health — write path, per attempt

`recordPoolDispatchOutcome` (`src/network/pool-health-machine.ts:56`): SELECT +
UPDATE (+ INSERT on status change). Same `invalidate()` on status change (`:151`).

### Telemetry — write path, batched

`TelemetryBatchBuffer.enqueue` (`src/observability/telemetry-buffer.ts:250`) is
non-blocking; an adaptive-interval flush (`:226`) writes one multi-row INSERT per
drain, default 500 ms / 500 rows (`:235`). Drops rather than blocks when full
(`:252`), bounded by `maxItems` and `maxBytes` (`:252`).

**Correct already.**

### Quota debit — write path, already two-tier

`debitBuddySpend` (`attempt-finalize.ts:598`) → `debitCachedQuota`
(`src/console/quota/cache.ts:255`): in-process `TtlCache` + Redis (`:46`, `:232`),
batch `MGET` for the overview (`:173`). Advisory; failures swallowed.

### Abuse check — every request, shared only with Redis

`modelStrikes.check({ ip })` (`auth-guard.ts:76`) on every authenticated request.
`RedisModelAbuseStore` when Redis is present, else `InMemoryModelAbuseStore`
(`dependencies.ts:252`), a plain `Map` (`src/security/model-abuse.ts:126`).
Without Redis, bans are per-process — a prober spreading requests across
processes is not banned.

---

## 2. What is redundant, repeatable, or cacheable

| # | Call | Nature | Cached today | Scope | Verdict |
|---|---|---|---|---|---|
| 1 | API key by hash | stable read | 3 s / 10 000 | process-local | keep; move to shared |
| 2 | Parent share key | stable read | via #1 | process-local | keep; move to shared |
| 3 | `sumChildrenConsumed` | **mutates** | via #1 | — | **drop or seed from flush buffer** |
| 4 | Negative auth | stable-ish | 1.5 s | process-local | keep; move to shared |
| 5 | Tenant preferences | stable read | 5 s + revision | process-local | keep; add shared invalidation |
| 6 | Route catalog | stable read | until invalidate | process-local | keep; **stop invalidating wholesale** |
| 7 | Model/provider mapping | stable | via #6 | — | already zero-cost |
| 8 | BYOK upstream host | stable | in-memory registry | process-local | fine (post-boot registrations) |
| 9 | Provider adapter | stable | permanent memo | process-local | fine |
| 10 | Account credential | stable + decrypt | 5 s, **not for OAuth** | process-local | **largest remaining read** |
| 11 | Tenant concurrency limit | stable | via #5 | — | fine |
| 12 | Admission | **write** | Redis Lua | shared | correct |
| 13 | Lifetime usage | **write** | coalesced 1 s | — | correct |
| 14 | Account health | **write** | none | — | **invalidates whole snapshot** |
| 15 | Pool health | **write** | none | — | same invalidate concern |
| 16 | Telemetry | **write** | batched 500 ms | — | correct |
| 17 | Payload capture | **write** | none | — | resolved **twice** per request |
| 18 | Abuse check | semi-stable | Redis ZSET / Map | shared if Redis | correct with Redis |

### Redundancy found

1. **Payload-capture policy resolved twice per request** —
   `shouldCaptureProviderBody` (`attempt-finalize.ts:35`) per attempt from
   `proxy-request.ts:237`, then `resolvePayloadCapture` again at
   `attempt-finalize.ts:312` on the terminal attempt. Both are cache hits, so
   cheap, but the second call is pure redundancy and trivially removable by
   threading the value through request state.

2. **`sumChildrenConsumed` on every auth miss** (`api-key-auth.ts:316`) — an
   aggregate whose only consumer is a value the module itself documents as
   deliberately stale. Seeding it from the usage-flush buffer would remove a
   query from the auth path.

3. **OAuth credential re-read every attempt** (`provider-credential-service.ts:158`,
   `:220`). Cacheable in principle, intentionally not cached today.

4. **Whole-snapshot invalidation from account health**
   (`account-health-service.ts:1343`) and pool health (`pool-health-machine.ts:151`).
   Invalidating on *status* change is defensible; on any mutating classification
   it is not.

---

## 3. What is shared and bounded today vs per-request

### Shared and bounded (good)

| Thing | Bound | Where |
|---|---|---|
| Route snapshot | one instance, `deepFreeze`d | `route-model.ts:435`, `:406` |
| Auth cache | 10 000 entries, 3 s | `api-key-auth.ts:25-26` |
| Preferences | 128 entries, 5 s | `tenant-preferences.ts:54` |
| Credential cache | 2 000 entries, 5 s | `provider-credential-service.ts:26` |
| Telemetry queue | `maxItems` + `maxBytes` | `telemetry-buffer.ts:252` |
| Provider adapter | permanent memo | `provider-registry.ts:111` |

### Per-request (scales with concurrency)

| Thing | Bound | Where |
|---|---|---|
| Provider capture body | 256 KiB per attempt | `attempt-finalize.ts:83` |
| Provider capture response | 256 KiB, `response.clone()` | `attempt-finalize.ts:263` |
| Request translation buffers | unbound | `src/transport/translation/` |
| SSE decode state | per stream | `src/protocol/sse-decoder.ts` |
| Stream transform state | per stream | `src/transport/dispatch/streaming/` |
| Usage/accounting struct | per attempt | `attempt-finalize.ts` |

The 256 KiB capture is the single largest per-request allocation, and it is
**per attempt** — a request with 3 attempts may hold 3 × (256 + 256) KiB of
capture buffers alive simultaneously, because `captureProviderExchange` sinks
into a per-attempt object (`attempt-loop.ts:270`) held until the loop returns.

---

## 4. Memory: measured, and it does settle

Allocation measured on the decode path with no DB and no cache involved:

```
slots=40   heap delta=161 KiB   per-request=4122 B
after release=-373 KiB vs baseline (no forced GC)

slots=100  heap delta=353 KiB   per-request=3615 B
after release=-363 KiB vs baseline (no forced GC)
```

Memory **returned below baseline naturally** after the slots were released, with
no `Bun.gc()`, no `--smol`, no forced collection. So the reported symptom is not
a leak — it is **peak concurrency footprint**: N concurrent requests each hold
their own buffers, and RSS tracks N until the wave ends.

This matters for the fix. Reducing DB calls will not bring peak RSS down; only
reducing per-request footprint will.

---

## 5. Process model multiplies everything

`src/main.ts:112` sets `reusePort: true`, and `src/persistence/boot.ts:110`
confirms each process opens its own pool.

Every cache in §3 is **process-local**. With P processes:

- DB read load for a cached key ≈ `P / TTL` instead of `1 / TTL`
- a revoked key stays valid up to TTL *per process*
- peak memory ≈ `P × per-request footprint × concurrency-per-process`

Redis is used today for **counters and ephemeral state** (admission
`dependencies.ts:208`, abuse `dependencies.ts:252`, quota `cache.ts:46`) but
**never as a shared invalidation bus** for the catalog caches. Console writes
converge per-instance only by whichever instance happened to serve the write.
