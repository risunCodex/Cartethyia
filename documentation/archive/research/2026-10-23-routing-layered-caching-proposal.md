> # ARCHIVED â€” UNTRUSTED
>
> This file was archived on 2026-10-23. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. Do not read it as current behavior or cite it as evidence.

# Proposal: L1 in-process, L2 Redis, Postgres as source of truth

Investigation output. No code changed. Read [the request-path census](2026-10-23-routing-request-path-census.md) first â€”
every recommendation below targets a specific finding there.

---

## 0. What this is actually solving

Two different problems, two different fixes:

| Symptom | Real cause | Correct lever |
|---|---|---|
| DB load scales with requests | a few uncached per-attempt reads; wholesale snapshot invalidation | L1/L2 caching + narrower invalidation |
| RSS spikes under concurrency and stays high | per-request buffers held for the request's life | smaller/bounded per-request footprint |

Caching does **not** fix the second. It is stated plainly here because the
tempting fix â€” "cache everything" â€” addresses only the first.

---

## 1. The three layers

```
request
  â”‚
  â”œâ”€ L1  in-process Map      bounded by entries + TTL, never unbounded
  â”‚        hit  â†’ no I/O
  â”‚        miss â†“
  â”œâ”€ L2  Redis               shared across processes
  â”‚        hit  â†’ one round-trip, populate L1
  â”‚        miss â†“
  â””â”€ Postgres                source of truth, populate L2 + L1
```

**Postgres stays the source of truth.** L1 and L2 are caches, never writers.
Every path that mutates must invalidate upward, not write through.

### L1 â€” in-process, bounded, TTL'd

Keep the existing `TtlCache` (`src/persistence/ttl-cache.ts`). It already has
TTL + max-entries + oldest-first eviction, and `dedupeRequest`
(`src/network/deduplication.ts`) collapses concurrent misses to one fetch â€”
which is what stops a thundering herd at L1.

Per-entry bounds, kept where they are today:

| Entry | TTL | Cap | Today |
|---|---|---|---|
| Auth (positive) | 3 s | 10 000 | `api-key-auth.ts:25-26` |
| Auth (negative) | 1.5 s | â€” | `:28` |
| Preferences | 5 s | 128 | `tenant-preferences.ts:54` |
| Credential | 5 s | 2 000 | `provider-credential-service.ts:26` |
| Route snapshot | until invalidate | 1 | `route-model.ts:435` |

### L2 â€” Redis, shared

Redis already exists (`src/persistence/redis.ts`) and is already used for
admission, abuse, and quota. What is missing is using it for **cache sharing and
invalidation**, which is a different use of the same client.

Two mechanisms, and they are not interchangeable:

1. **Value cache** â€” store the serialized entry with its own TTL. Good for auth
   snapshots, credentials, preferences. Cost: one round-trip on an L1 miss.
2. **Invalidation channel** â€” publish/subscribe on mutation. Good for the route
   snapshot, which is **large** (11 SELECTs worth of rows) and would be an
   expensive Redis value, but which changes rarely and must converge fast.

The route snapshot should use **(2), not (1)**. Caching an 11-table structure in
Redis costs serialization on every write and deserialization on every read;
publishing a revision token costs almost nothing and gets the same convergence.

`src/persistence/settings-revision.ts` already implements the revision-counter
pattern in-process. Extending it to a Redis-published revision is the natural
step: keep the local counter as the fast path, publish on bump, and let peer
processes invalidate on receipt.

### Postgres â€” unchanged

No schema change proposed. Nothing writes to a cache.

---

## 2. Invalidation

The rule: **mutate Postgres, then invalidate upward (L2 then L1).** Never the
reverse, and never write to a cache.

| Mutation | Invalidate | Mechanism |
|---|---|---|
| API key create/update/revoke | auth L1 + L2 by `keyId` | targeted â€” reverse index already exists (`api-key-auth.ts:39`) |
| Settings write | preferences L1 + L2 by `tenantId` | revision bump (already exists) |
| Routing/provider/model change | route snapshot | revision publish (Redis pub/sub) |
| Credential rotate | credential L1 + L2 by account | targeted |
| Account health transition | **narrow**, not whole snapshot | see Â§3.2 |
| Pool health status change | pool health + route snapshot | status change only |

Targeted invalidation is already the pattern for auth (`:39`, `:93`). The route
snapshot is the one place invalidation is wholesale, and it is the expensive one.

---

## 3. Ordered recommendations

### 3.1 â€” Stop invalidating the whole route snapshot from health writes

**Highest impact, lowest risk.**

`account-health-service.ts:1343` invalidates on *any* mutating classification.
Pool health does the same on status change (`pool-health-machine.ts:151`).

Under a failure wave: N failed attempts â†’ N invalidations â†’ next request pays
11 SELECTs â†’ that request may also fail â†’ invalidate again. The rebuild storm
is self-sustaining under exactly the conditions when the system is least able
to afford it.

Fix: invalidate only when the routing-visible state actually changed â€” account
`status` transitions and enable/disable. A cooldown timestamp or an error
category does not change routing and must not drop the snapshot.

### 3.2 â€” Cache OAuth credentials with a token-bound TTL

`provider-credential-service.ts:158`, `:220` refuse to cache OAuth at all, so
every attempt pays a SELECT + AES-GCM decrypt.

The reason stated is sound: a token near expiry must not be served stale. But
the fix for that is a **shorter TTL derived from the token's own expiry**, not
no cache. Cache with `ttl = min(CRED_CACHE_TTL_MS, timeUntilExpiry - safetyMargin)`.
A token with 30 minutes left caches for nearly the full window; one with 20
seconds left does not cache at all. Same safety, far fewer reads.

### 3.3 â€” Remove the duplicate payload-capture resolution

`proxy-request.ts:237` resolves it per attempt, `attempt-finalize.ts:312`
resolves it again on the terminal attempt. Thread the resolved value through
request state instead. Cheap today (cache hits) but pure waste.

### 3.4 â€” Seed `sumChildrenConsumed` from the usage-flush buffer

`api-key-auth.ts:316` runs a SUM on every auth miss for a value the module
documents as deliberately stale (`:16-20`). The usage-flush buffer already
tracks the same deltas (`usage-flush.ts:104`). Seeding from memory removes a
query from the auth path with no accuracy loss the module does not already
accept.

### 3.5 â€” Move auth + preferences + snapshot invalidation to Redis

Only after 3.1â€“3.4. This is the largest change and the only one that needs
cross-process coordination.

- auth + preferences: Redis value cache with TTL, L1 in front
- route snapshot: Redis pub/sub revision, **not** a value cache

### 3.6 â€” Defer what is already deferred, verify what is not

Already correct, do not touch: usage flush (`usage-flush.ts:104`), telemetry
(`telemetry-buffer.ts:250`), admission (Redis Lua).

Not yet deferred: account health (`:876`) and pool health
(`pool-health-machine.ts:56`) both do SELECT + UPDATE + INSERT synchronously
per attempt. Both are candidates for the same coalescing pattern usage-flush
uses â€” enqueue, flush on a timer, bounded loss on crash.

---

## 4. Estimated impact

**These are estimates from the census, not measurements.** No load test was run.
Each is stated with the assumption it depends on.

### DB calls per request

| Scenario | Today | After 3.1â€“3.4 | After 3.5 |
|---|---|---|---|
| Steady state, cache warm | ~0â€“1 (OAuth credential) | ~0 | ~0 |
| Auth miss | 3 (`:296`, `:307`, `:316`) | 2 | 1 + Redis |
| After any health transition | 11 (snapshot rebuild) | 0 | 0 |
| Failure wave | 11 Ã— attempts | 0 | 0 |

The failure-wave row is the one that matters: it is where today's behaviour is
superlinear in attempts.

### Latency

Per-request, assuming Redis RTT â‰ˆ 0.5 ms and Postgres read â‰ˆ 5 ms
(order-of-magnitude, not measured):

| | Today | After |
|---|---|---|
| Warm, OAuth account | +1 Postgres read (â‰ˆ5 ms) + decrypt | â‰ˆ0 ms |
| Post-invalidation request | +11 Postgres reads (â‰ˆ55 ms serial, less if parallel) | â‰ˆ0 ms |
| Cold L1, warm L2 | n/a | +0.5 ms Redis |

The dominant win is not the steady-state read â€” it is **removing the 11-SELECT
rebuild from the failure path**.

### Memory at 40 and 100 concurrent

Measured per-request footprint: **~3.6â€“4.1 KB** (`01-â€¦census.md` Â§4).

Excluding the 256 KiB capture buffers (`attempt-finalize.ts:83`), which dominate
everything else and are opt-in per tenant:

| Concurrency | Translation + stream state (est.) | With capture enabled (per attempt) |
|---|---|---|
| 40 | ~160 KB | up to 40 Ã— 512 KB = **~20 MB** |
| 100 | ~400 KB | up to 100 Ã— 512 KB = **~50 MB** |

The capture number is the real peak driver, and it is **per attempt** â€” a
3-attempt request holds 3 Ã— 512 KB. Bounding capture to the terminal attempt,
or to a single shared buffer per request, reduces this by the attempt factor.

**Honest caveat:** memory is dominated by capture buffers, which caching cannot
fix. If the reported RSS spike is large (tens of MB), the lever is capture
bounding, not L1/L2. If it is a few MB, it is the per-request state above.

---

## 5. Constraints honoured

- **No forced GC, no `Bun.gc()`, no `--smol`.** Â§4 of the census measures that
  memory already returns below baseline naturally once slots are released.
  Nothing proposed relies on reclaim timing.
- **Memory must come down naturally.** Every L1 bound here is entry-capped and
  TTL'd, so an idle process converges to its bounded set without any collection
  pressure. Nothing grows without bound.
- **No code changed.** This document is investigation only.

---

## 6. Implementation status (2026-10-20)

All six recommendations are implemented and committed. Two landed differently
from the original text, for reasons found while implementing:

**3.1 â€” done as written.** Classification carries `routesVisible`; the
model-scoped path reports false. The proposal also named pool health; that was
wrong â€” `pool-health-machine.ts:151` already gated on `statusChanged` and was
left alone.

**3.2 â€” done as written.** OAuth caches with `min(window, expiry - 30s)`.

**3.3 â€” done as written.** Resolved once per request, memoized on request state.

**3.4 â€” done, but only partly as written.** Seeding `sumChildrenConsumed` from
the buffer needs a parentâ†’children map in memory, which does not exist and
which is not worth adding. What landed instead is better: the aggregate is
skipped entirely unless the key is a `share` parent, since no other key can have
children. That removes the query rather than making it cheaper. The pending
delta is added to the persisted total, which closes the accuracy gap the
proposal only noted.

**3.5 â€” done, with one change.** The route snapshot uses the broadcast channel,
as proposed. Auth uses the shared value cache keyed by **token hash**, not by key
id: a lookup only has the hash, and invalidation travels by broadcast because a
console mutation names a key id and cannot enumerate that key's hashes in
another process. Preferences use the broadcast channel (revision) rather than a
value cache â€” the reader is already revision-keyed and 5 s TTL'd, so a value
cache would add serialization for nothing.

**3.6 â€” done, decomposed.** The proposal said "defer account health and pool
health writes". Deferring the *status* UPDATE is unsafe: routing reads it, so a
following request would pick an account that had just failed â€” worse under
exactly the failure wave this targets. Only the `health_events` INSERT moved off
the request path; the status write stays synchronous and transactional.

### Not measured

No load test was run. Every number in Â§4 remains an estimate from the census.
The correctness of each change is pinned by tests, but the *impact* on DB load
and latency is still unverified against a real deployment.

## 7. What is still unknown

1. **Real per-request footprint under load.** The ~3.6â€“4.1 KB figure is from a
   synthetic decode-path measurement, not a live request. A real request adds
   translation buffers and stream state that were not measured.
2. **Whether Redis is present in the deployment that showed the symptom.** If
   not, Â§3.5 is unavailable and the fix is entirely 3.1â€“3.4 plus capture
   bounding.
3. **Process count.** `reusePort: true` (`main.ts:112`) means P processes; P was
   not determined, and it multiplies both DB load and peak memory.
4. **Whether payload capture is on** for the tenant that showed the spike. It
   is the difference between ~400 KB and ~50 MB at 100 concurrent.
