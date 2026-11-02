# Report 05 — network + security

Scope: `src/network/**` (19 files) and `src/security/**` (21 files) reviewed in full (every `.ts` file read top to bottom). Reference evidence = grep across the whole repo (`src/`, `test/`, `scripts/`, `dashboard/src/`, `documentation/`).

---

## Findings

### DEAD-CODE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| D1 | `src/network/response-headers.ts` | 11–39 | Whole module is dead in production: `stripResponseHeaders` and `STRIPPED_RESPONSE_HEADERS` are referenced only by `test/network/response-headers.test.ts`. No `src/` importer exists (grep: zero production hits). The header stripping it implements appears to have been superseded by the upstream projection in `transport/dispatch/upstream.ts` + `GATEWAY_SECURITY_HEADERS`. | Delete the module and its test, or wire it into the egress path if stripping is still required; if kept, move the constant next to its only consumer. |
| D2 | `src/network/pool/resolver.ts` | 260–262 | `PoolAgentResolver.agentCount()` is exported but has **zero** callers anywhere in the repo (grep: only the definition). The doc says "for the runtime metrics sampler", but no sampler references it. | Remove the method (or wire it into the telemetry sampler if the metric is missed). |
| D3 | `src/network/pool/selector.ts` | 40 | `export { parseCooldownEntry };` is a re-export no one consumes from this module — all importers use `pool-state.ts` directly (`test/network/pool-state.test.ts:43`, internal uses). | Drop the re-export; keep the canonical export in `pool-state.ts`. |
| D4 | `src/network/pool/selector.ts` | 39 | `PoolUsageSnapshot` type re-export is unused from this module (grep: consumers use `snapshotPoolUsage()` inferentially or import the type via `pool-state.ts`). `PoolRotation`/`ProxyCooldownEntry` re-exports are used and must stay. | Drop only the unused `PoolUsageSnapshot` from the re-export line. |

### DUPLICATION

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| U1 | `src/network/ssrf.ts` vs `src/security/ip-boundary.ts` | 34–41 vs 7–15 | IPv4→numeric parsing duplicated nearly verbatim: `ipv4Number` (throws) and `ipv4ToNumber` (returns `undefined`). Same split/`^\d+$` validate/octet-range check/combine logic. | Extract one shared `ipv4ToNumber(address): number | undefined` into a neutral helper (e.g. `src/network/ip-utils.ts` or `src/protocol/codecs`) and have both call sites adapt the throw/undefined difference. |
| U2 | `src/network/ssrf.ts` vs `src/security/ip-boundary.ts` | 43–70 vs 17–33 + 100–147 | IPv6 parsing duplicated: `ipv6Bytes` and `ipv6ToBigInt`/`normalizeIpv6Groups` both implement `::` expansion, 8-group validation, hex group checks, and dotted-quad handling independently. | Share one canonical IPv6 parser (string → 8 groups / 16 bytes) and derive both the byte form (SSRF) and bigint form (boundary) from it. |
| U3 | `src/network/ssrf.ts` vs `src/security/ip-boundary.ts` | 72–109 vs 149–185 | CIDR matching duplicated: `cidrContains` and `matchesCidr` repeat the same prefix-string validation (incl. the blank-prefix `/\d+$/` refusal), family pairing, and bit-mask comparison. Both independently added the "blank /0" hardening. | Extract one `cidrContainsAddress(address, cidr)` helper used by both modules. |
| U4 | `src/network/pool/agent.ts` vs `src/network/ssrf.ts` | 125–126 vs 199–215 | Double DNS timeout wrapper: `createSsrfLookup` creates its own `AbortController` + 5s `setTimeout`, then calls `resolveAllAddresses`, which already runs its own 5s race-timeout + abort handling. The outer timer is redundant (and adds an unref'd timer per socket connect). | Drop the outer timer/controller; pass a signal that only forwards caller abort (or rely on `resolveAllAddresses`' internal deadline). |
| U5 | `src/security/cli-client-fingerprint.ts` vs `src/security/client-router-fingerprint.ts` | 20–39 vs 135–139 | User-Agent extraction duplicated: `readUserAgent` hand-rolls Headers /Record-header reads (incl. case-insensitive fallback); `readHeader` re-does the same shape via `canonical-model.getHeader`. Two different probes, same "read UA from either shape" logic. | Extract a shared `readHeaderValue(headers, name)` helper (also usable by `requestToken` in `api-key-auth.ts`). |
| U6 | `src/network/pool/selector.ts` | 214–241 vs 243–270 | `acquireProvider` and `acquire` are two copies of the same local slot acquisition + release counter (one adds the provider share). The release closures are duplicated. | Extract a private `acquireLocalSlot(poolId, increments)` helper used by both. |

### BLOAT

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| B1 | `src/network/pool/resolver.ts` | 1076–1100 | `http2Bidi()` has a duplicated direct-dial branch: the `dialDirect(destination, signal)` + `openBidiStream(...)` pair appears twice (once inside the `networkPoolId !== undefined || tenantId !== undefined` guard with an inner `if (... undefined ...)` bail, once at the tail). The gate condition is convoluted and re-checks each id three times. | Simplify to `if (networkPoolId !== undefined && tenantId !== undefined && this.poolResolver !== undefined) { …pool path… }` and let the single direct path below handle everything else. |
| B2 | `src/network/pool/selector.ts` | 611–868 | `tryAcquireAvailablePool` is a 250-line monolith with the same "try slot, fail over, return release" block repeated ~3× (random / round-robin / weighted scans, plus the Redis admit loop). The Redis and local paths each re-implement the release closure. | Extract small helpers: `localAcquire(candidate, providerCapacity, rotation)` and `redisAdmit(candidate)`. Keeps the three scan strategies readable. |
| B3 | `src/network/pool-health.ts` | 85–117, 179–210 | `flagPoolBlocked` and `flagPoolCooldown` duplicate the same fire-and-forget `poolSelector…().then(upsert).catch(metric+log.warn)` shape, and `recordPoolBlockEvent`/`recordPoolCooldownEvent` are two near-identical `healthEvents` inserts differing only in `errorCategory`. | Extract `persistCooldownMarker(poolSelector, db, …)` and one `insertPoolHealthEvent(db, …)` helper; keep only the string/reason differences. |
| B4 | `src/network/pool-cooldown-store.ts` | 66–153 | Every operation (`upsertProviderCooldownMarker`, `dropProviderCooldownMarker`, `dropAllProviderCooldownMarkers`, `pruneExpiredProviderCooldownMarkers`) repeats the identical read-map → mutate → write-map → `try/catch` + `log.warn` wrapper. | Extract a `mutateMarkerMap(db, poolId, mutate)` helper returning the write; each export becomes a one-liner. |
| B5 | `src/network/outbound-fetch.ts` | 180–228 | `nodeDial` buffers the entire upstream response body in memory (`chunks: Buffer[]` + `Buffer.concat`) before resolving. For the GET/HEAD+body path this is a full-body materialization for a response that may be large (registry/metadata JSON is small today, but the path is unbounded). | Stream: resolve with a `Response` over a `ReadableStream` from `res`, or at least guard with a size cap. |

### ANTI-PATTERN

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| A1 | `src/network/outbound-fetch.ts` | 102, 108 | `{} as never` passed to `agent.connect(...)` for the SOCKS dispatcher — two suppressed/unsafe casts that hide the real option shape. | Define a typed `connect` parameter interface (host/port/family/lookup) instead of `as never`; the `opts` cast above is already doing the typing work. |
| A2 | `src/security/api-key-auth.ts` | 326–327 | `JSON.parse(shared) as ResolvedApiKey` — unchecked cast of shared-cache bytes; validated only by `typeof parsed?.id === "string"` afterwards. A schema-drifted object could flow through. | Validate the required fields (id/tenantId/scopes/snapshot) into a proper type guard before trusting the entry. |
| A3 | `src/security/abuse.ts` | 469 | `cause: (err as Error).message` — the non-GatewayError catch casts `unknown` to `Error` without checking; a thrown string/null produces `undefined`. | Use `err instanceof Error ? err.message : String(err)`. |
| A4 | `src/network/pool/resolver.ts`, `pool-health-machine.ts`, `pool/agent.ts` | 854; 160; 449, 486–487 | Cluster of `as unknown as` non-strict escapes: `http2.OutgoingHttpHeaders` (854), `healthEvents` insert (160), socket `write` wrapper (449), `SocksProxyAgent`→`HttpAgent`/`HttpsAgent` (486–487). | Replace where feasible with structured types (typed header object, typed insert row, typed `createConnection` signature). The `agent.ts` 486–487 pair is the most defensible (Node's agent type union), but the header cast at 854 can be a real typed object. |

### OPTIMIZATION-OPP

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| O1 | `src/network/pool/resolver.ts` | 988–1008 | `ValidatedNetworkBindingFactory.fetch()` rebuilds a full `createValidatedFetch({ policy, agent })` closure on **every request** through a pool (line 994), re-running `dialer`/`relayRequest` setup and re-creating the redirect-loop closure each dispatch. | Cache one `ValidatedFetch` per resolved agent (key by agent/poolId) and reuse it; invalidate on `releasePool`. |
| O2 | `src/network/pool/agent.ts` | 125–126 | `createSsrfLookup` allocates an `AbortController` + `setTimeout` per socket connect (per CONNECT handshake and per SOCKS dial). On a hot pool this is per-request garbage. | Reuse a single pre-created controller/timer pattern (or drop the outer timer entirely — see U4), so connects allocate only the lookup. |
| O3 | `src/network/outbound-fetch.ts` | 147–155 | `dial()` computes `content-length` for non-string/Buffer/Uint8Array bodies by materializing `await new Response(rawBody).arrayBuffer()` — a full copy of the body per dial just to measure it. | For stream/FormData bodies either skip `content-length` (let chunked apply) or use a known-length `ReadableStream` size when cheap; avoid the full buffering copy on the hot path. |

### STALE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| S1 | `src/network/outbound-fetch.ts` | 33–37 | Orphaned doc block ("Whether a configured pool/relay agent owns this dial…") sits between the `ValidatedFetch` type and `relayRequest`; it documents behavior that was refactored into `poolDialsTarget` (line 265) and no longer has a function. | Delete the dangling comment (the current logic is documented inline at 257–273). |
| S2 | `src/network/pool/agent.ts` | 190–197 | Orphaned doc block ("True when a CONNECT attempt failed at the handshake…") immediately followed by `createProxyConnection`'s own doc (198+). The described predicate/function no longer exists in this file. | Remove the stale block. |
| S3 | `src/network/pool/resolver.ts` | 277–279 | `resolveWebSocketAgent()` is a one-line passthrough to `resolveAgent` used exactly once (line 1029). It adds a public API surface that is identical to `resolveAgent`. | Call `resolveAgent` directly at line 1029 and delete the wrapper (or keep only if the factory consumer needs a distinct seam). |

---

## Summary count per severity

| Severity | Count |
|----------|-------|
| DEAD-CODE | 4 |
| DUPLICATION | 6 |
| BLOAT | 5 |
| ANTI-PATTERN | 4 |
| OPTIMIZATION-OPP | 3 |
| STALE | 3 |
| **Total** | **25** |

---

## OK — verified clean

The following parts were inspected fully and show no dead symbols, duplication, bloat, anti-patterns, optimization holes, or stale code (within the scope of this audit):

- `src/network/backoff.ts` — small, single-purpose; exported and used (`telemetry-buffer.ts`, `retry.ts`).
- `src/network/deduplication.ts` — bounded map, correct eviction; used by `ttl-cache.ts`.
- `src/network/rate-limit-verdict.ts` — single source of truth; `FREE_TIER_REFUSAL` consumed by `probe-verdict.ts`.
- `src/network/retry.ts` — clean; used by `provider-version-cache.ts`.
- `src/network/types.ts` — `parseAgentConfig`/`ProxyConfigError` used by `resolver.ts`; strict validators.
- `src/network/ssrf.ts` — security-critical; heavy comment discipline; only duplication is the IP/CIDR overlap noted above (U1–U3).
- `src/network/pool/byte-accounting.ts` — one-direction accounting, bounded maps, no leaks.
- `src/network/pool/pool-scripts.ts` — all scripts consumed by `selector.ts`; keys consistent.
- `src/network/pool/pool-state.ts` — bounded state maps, eviction helpers used; `parseCooldownEntry` consumers correct.
- `src/network/pool/loader.ts` — small, typed, fail-closed.
- `src/network/pool-health-machine.ts` — the `as never` at line 160 is the only knock (A4); logic itself is coherent and coalesced.
- `src/security/access-control.ts` — frozen decisions, closed scope set, `TENANT_KEY_SCOPES` used by dashboard + tests.
- `src/security/crypto.ts` — AES-256-GCM, test seams isolated, HMAC key reuse intentional.
- `src/security/csrf.ts` — timing-safe comparison, stateless double-submit; all exports consumed.
- `src/security/credential-codec.ts` — strict decoders share `decodeSecretText`/`parseEnvelopeRecord`; every export wired to a provider adapter or test.
- `src/security/ip-boundary.ts` — well-tested trust model; duplication is only the IP-parsing overlap (U1–U3).
- `src/security/model-access-rule.ts` — pure, shared by gateway/dashboard; no dead exports.
- `src/security/api-key-auth-cache.ts` — bounded positive/negative cache; no leaks.
- `src/security/admission/**` — Lua scripts + stores agree on key shapes; `reasons.ts`/`ttl.ts`/`buckets.ts`/`contracts.ts` all consumed; `lease-sweep.ts` bounded.
- `src/security/abuse.ts` — Redis + in-memory stores parallel by design; `RingCounter` amortized; fail-closed.
- `src/security/client-router-fingerprint.ts` / `cli-client-fingerprint.ts` — only the UA-read duplication noted (U5).

---

## Execution status

- **Area execution:** 14 file(s) changed in this scope during the cleanup pass; `bunx tsc --noEmit` clean and full backend suite green (4217 pass / 0 fail, protocol 591 pass / 0 fail).
- **Confirmed done (✅):** Stale comments (S1–S3) removed; agentCount (D2) and selector re-exports (D3/D4) confirmed handled.
- **Not done / skipped (⛔):**
  - D1 response-headers.ts module still present in src — not deleted ⛔
  - U1–U3 IP/IPv6/CIDR shared `ip-utils.ts` — NOT created (duplication still present) ⛔
  - U4 double DNS timeout wrapper — not verified
  - O1 ValidatedFetch closure cache — not verified
- **Note:** this status reflects the orchestrator's verification of representative findings, not an item-by-item re-audit of every finding in this report.
