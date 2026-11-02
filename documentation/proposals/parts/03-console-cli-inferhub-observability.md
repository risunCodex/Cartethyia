# Report 03 — console/cli-tools, data-management, inferhub, observability

Audited files (42 total, every .ts read):
- src/console/cli-tools/: store.ts, service.ts, secret-source.ts, routes.ts, fs-ops.ts, contracts.ts + injectors/{driver,claude,cline,codex,copilot,cowork,deepseek-tui,droid,grok-build,hermes,jcode,kilo,openclaw,opencode}.ts
- src/console/data-management/: routes.ts, contracts.ts, operations.ts
- src/console/inferhub/: types.ts, store.ts, routes.ts, normalize.ts, key-store.ts, client.ts
- src/console/observability/: usage-periods.ts, usage-dimensions.ts, store.ts, sse.ts, routes.ts, performance.ts, performance-contracts.ts, logs.ts, live.ts, contracts.ts

Reference usage was verified by grepping the whole repo (src/ test/ scripts/ dashboard/src/) for every exported symbol before classifying it dead.

---

## Findings

### DEAD-CODE

1. **D1 — `isAlsoAccountCredential` never referenced** — `src/console/inferhub/key-store.ts:109-119`
   Exported async function that queries `provider_accounts`; the only hits in the repo are its own definition. `createInferhubKeyStore` (line 122-129) does not expose it, and no route/tests call it. Removing it also lets the `providerAccounts` import (line 18) go.
   *Fix:* delete the function and the `providerAccounts` import; if the "not also an account credential" guard is still wanted, wire it into the PUT key route and expose it from the store factory.

2. **D2 — `CliToolMappingStore.listAll` never called** — `src/console/cli-tools/store.ts:162-178`
   Grep for `.listAll(` finds only the declaration. The JSDoc claims the "route catalog snapshot" uses it, but no such caller exists in src/test/scripts/dashboard.
   *Fix:* remove the method (and the `tenantId?` branch), or find the intended consumer and wire it up.

3. **D3 — Empty `import type {} from "../contracts"` in 12 injector files** — opencode.ts:1, openclaw.ts:1, kilo.ts:2, jcode.ts:1, hermes.ts:1, grok-build.ts:1, droid.ts:1, deepseek-tui.ts:1, cowork.ts:2, codex.ts:1, cline.ts:1, claude.ts:1
   All import nothing (empty type-only import). No effect, but noise across every injector.
   *Fix:* delete these import lines.

4. **D4 — `summarizeUsagePerformance` exported but production-unused** — `src/console/observability/store.ts:220-247`
   The only consumer is `test/console/usage-performance.test.ts`. The comment says "still used by callers that already hold a bounded event list", but no production caller exists; the endpoints use `summarizeUsagePerformanceSql`.
   *Fix:* move it into the test fixture or delete and leave the SQL path as the only one.

5. **D5 — `formatSseFrame` re-export unused outside sse.ts** — `src/console/observability/sse.ts:17`
   Grep shows the alias `formatSseFrame` is only referenced inside sse.ts itself; external code imports `buildSseEventFrame` from protocol/sse-frame directly.
   *Fix:* drop the re-export (keep the internal alias if desired).

### DUPLICATION

6. **U1 — `num` and `numOrNull` are byte-identical** — `src/console/inferhub/normalize.ts:39-48` and `:51-58`
   Same body, same docstring, twice. `numOrNull` is the exported one; `num` is internal but used by normalizeCatalogModel/pricePointsToTiers.
   *Fix:* delete `num` and import/use `numOrNull` internally.

7. **U2 — Usage-period token regex triplicated** — `src/console/observability/contracts.ts:17` (`isSupportedUsagePeriod`), `store.ts:87` (`periodStartDate`); `chartBucketSeconds` re-parses via periodStartDate again
   Three copies of `/^(\d+)([hd])$/` split parsing and validation, so acceptance rules can drift (the cap in `isSupportedUsagePeriod` has no counterpart in `periodStartDate`).
   *Fix:* add one shared parser (e.g. in usage-periods.ts) returning `{ amount, unit } | null`, and have both `isSupportedUsagePeriod` and `periodStartDate` use it.

8. **U3 — Dimension whitelist validated twice per request** — `src/console/observability/routes.ts:59` and `src/console/observability/contracts.ts:435`
   Both check `USAGE_DIMENSIONS.includes(dimension)` and throw a ConsoleDomainError. The route check runs before the operations check.
   *Fix:* keep one (prefer the operations layer, which already returns a typed error) and drop the duplicated branch in routes.

9. **U4 — `memory_percent` formula duplicated** — `src/console/observability/store.ts:300` (`liveMemory`) and `:379` (`computeHealth`)
   `Math.round((rss / Math.max(totalmem(), 1)) * 10000) / 100` appears twice; computeHealth also recomputes `rss`.
   *Fix:* extract a `memoryPercent(rss)` helper used by both.

10. **U5 — Manual payload validators duplicate Elysia schemas** — `src/console/cli-tools/routes.ts:34-106` vs `:108-144`
    `parseMapping`/`parseApplyInput` hand-validate exactly the shape `applyBody`/`mappingBody` define (slotKey/sourceModel/targetModel/enabled, keyId, mode…). Two sources of truth for the same wire shape.
    *Fix:* drop the manual parsers and trust the typed `body` (Elysia already validated it), or generate the runtime check from the schema.

11. **U6 — `mapUsageRequestItem` vs `mapTelemetryEventRow` share large optional-field spread blocks** — `src/console/observability/store.ts:47-68` and `:115-169`
    Same pattern of conditional spreads (inputTokens/outputTokens/tokensPerSec/firstContentDeltaAtMs/lastEventAtMs/estimatedCost/status…) repeated with slightly different output names.
    *Fix:* extract a small shared projection helper for the common fields and let the two mappers add their specific keys.

12. **U7 — Payload-row read + `readCapturedBodies` duplicated** — `src/console/observability/store.ts:791-821` (`usageRequestDetail`) and `:875-896` (`getEvent`)
    Both query `telemetryPayloads` (tenant+requestId, newest first, limit 1) and then map `readCapturedBodies` onto different shapes (payloads vs payload).
    *Fix:* extract `fetchLatestPayload(db, tenantId, requestId)` returning the captured record; keep the two shape mappers.

### BLOAT

13. **B1 — `saveMappings` does an N+1 upsert + re-query dance** — `src/console/cli-tools/service.ts:198-235`
    Loops one upsert per mapping, then re-lists, then removes stale rows one-by-one, then calls `getMappings` (which re-queries settings + list). For a typical 2-5 slot tool this is 4-10 round trips.
    *Fix:* batch the upserts in one `insert(...).values(rows).onConflictDoUpdate(...)`; compute stale keys from the input alone (no mid-flight list); return the constructed settings instead of re-querying.

14. **B2 — `withPoolBytes` synthesizes a row with `as unknown as T`** — `src/console/observability/live.ts:80`
    The cast papers over merging byte rows (which lack currentInflight) into the selector rows. Works, but it is a full type hole.
    *Fix:* generalize the merge to `T & { poolId: string }` with a partial default (`{ currentInflight: 0 }`) instead of casting.

15. **B3 — `unlinkWhere` stat+unlink per file** — `src/console/data-management/operations.ts:221-247`
    For a telemetry retention sweep this is one `stat` then one `unlink` per file; acceptable at typical volumes but could use a single `readdir` + `rm` batch.
    *Fix (optional):* use `rm(path, { force: true })` after collecting sizes in a first pass, or `Promise.all` the unlinks.

### ANTI-PATTERN

16. **A1 — Usage chart reports input tokens as the cache share** — `src/console/observability/store.ts:540-541`
    `cached: bucket.inputTokens` with a comment claiming the SQL reader sums cached_input_tokens. `chartTelemetry` (event-query.ts:625-658) returns no `cachedInputTokens` field, so the chart's "cached" series is actually the full input-token series — misleading data on the dashboard.
    *Fix:* add `cachedInputTokens` to the SQL `chartTelemetry` GROUP BY select, or drop the `cached` field from `UsageChartBucket` until it is real.

17. **A2 — `downloadConfig` swallows every injector error into a misleading 404** — `src/console/cli-tools/service.ts:253-262` + `routes.ts:279-282`
    Any throw inside `injector.download` becomes `null`, which the route renders as "CLI tool not found". A write/parse failure looks identical to an unknown tool, hiding the real cause.
    *Fix:* let errors propagate to `errorResponse`, and reserve 404 for `injectorFor` returning null.

18. **A3 — Pasted-secret fallback path is unreachable from production** — `src/console/cli-tools/service.ts:109-118` + `:127-141`
    `withResolvedSecret` always calls `resolveApiKey(tenantId, keyId, undefined)`, so `resolveSecretByValue` (secret-source.ts:57-79) is dead in production; only the keyId path runs. The interface advertises a fallback nothing uses.
    *Fix:* simplify `CliToolSecretSource` to `resolveSecret` only (or pass a real pasted secret when the route wants it); delete `resolveSecretByValue` + the hash query.

19. **A4 — `readConfigKey` masks decryption corruption as "no key"** — `src/console/inferhub/key-store.ts:37-54`
    A decrypt failure (rotated key, corrupt row) returns `undefined`, which routes render as `no_config_key` — an operator sees "no key" instead of "key present but unreadable". Documented intent, but it hides data loss.
    *Fix:* differentiate `{ status: "corrupt" }` from `{ status: "absent" }` and surface a warning on the key page.

### STALE

20. **S1 — `bypassPermissions` accepted but never consumed** — `src/console/cli-tools/routes.ts:130`, `contracts.ts:177`
    `applyBody` validates `bypassPermissions`, `ApplyInput` types it, but `parseApplyInput` drops it and no injector reads `input.bypassPermissions` (the only hit is a hardcoded baseline string in claude.ts:30).
    *Fix:* remove the field from the schema/type, or parse it and hand it to the injector that is meant to use it.

21. **S2 — Dead header writes on the SSE route** — `src/console/observability/live.ts:97-100`
    `/live/requests/stream` sets `set.headers[...]` and then returns `consoleSseResponse(...)`; the Response constructor owns the headers, so the four assignments are no-ops (other SSE routes don't bother).
    *Fix:* delete the `set.headers` block.

22. **S3 — cowork injector is scaffolding awaiting a bridge** — `src/console/cli-tools/injectors/cowork.ts:24-57`
    `readStatus` hardcodes unconfigured; `apply` only deletes a phantom key; `download` returns an empty `managedServers: {}`. Comment references "P3-2" MCP bridge. If the bridge is not coming, this injector is dead weight; if it is, it's incomplete scaffolding.
    *Fix:* implement the MCP/bridge write or remove `cowork` from the registry until it exists.

23. **S4 — `catalog` freshness entry unused** — `src/console/inferhub/store.ts:31`
    `FRESHNESS_MS.catalog` (300s) is never consulted: `ensureModels` reports/marks everything as `"market"`. Dead configuration.
    *Fix:* remove the catalog entry, or actually use it where the catalog snapshot is served.

### OPTIMIZATION-OPP

24. **O1 — `usage()` scans the payload directory twice** — `src/console/data-management/operations.ts:136-137`
    `scan(payloadDir(), isFrame)` and `scan(payloadDir(), isFrame, payloadCutoff)` each `readdir` + `stat` every payload file. Two full passes per request for numbers that one pass (collecting bytes/files and whether mtime < cutoff) can produce.
    *Fix:* single scan returning both `{bytes,files}` and stale `{bytes,files}`.

25. **O2 — `computeChart` parses the period twice (plus once more in `chartBucketSeconds`)** — `src/console/observability/store.ts:521-529`
    `periodStartDate(period)` runs for `since`, then `this.periodSince(period)` runs again inside the `chartTelemetry` call, and `chartBucketSeconds(period)` re-parses for the width. Three regex parses per call.
    *Fix:* compute `since` once, derive `bucketSeconds` from it, pass both down.

26. **O3 — `saveMappings` round-trips (same as B1)** — `src/console/cli-tools/service.ts:218-234`
    Counted here for the query-count impact: per-mapping upserts plus a re-list plus per-stale deletes plus a final `getMappings` re-query.
    *Fix:* single batched upsert; derive removals from input; construct the response without re-querying.

27. **O4 — Per-row `clientNameFromUserAgent` in list rendering** — `src/console/observability/store.ts:147`
    `mapUsageRequestItem` parses the user agent for every row of a 50-500 row page; the same UA repeats across rows.
    *Fix:* cache the UA->clientName parse per page (a small Map) or rely on the ingestion-stamped `client_name` column like the `client` breakdown does.

---

## Summary counts

| Severity | Count |
| --- | --- |
| DEAD-CODE | 5 |
| DUPLICATION | 7 |
| BLOAT | 3 |
| ANTI-PATTERN | 4 |
| STALE | 4 |
| OPTIMIZATION-OPP | 4 |
| **Total** | **27** |

Highest-impact first: A1 (mislabeled chart data), D2/D1 (dead code), O1 (double directory scan), B1/O3 (N+1 mapping persistence), A2 (error swallowing), S2 (dead headers).

---

## OK — verified clean

- **cli-tools/fs-ops.ts** — no unused exports; every helper has at least one caller or test; the structured-text editor (textGet/textHas/textUpsert/textRemove) is cohesive and heavily commented with the failure modes it prevents.
- **cli-tools/service.ts** — clean application boundary; `getAllStatuses` failure isolation is deliberate and bounded; `applyConfig` outcome logic is linear.
- **cli-tools/injectors/driver.ts** — the declarative driver genuinely removes per-tool boilerplate; `guideInjectorFor` centralizes guide tools; INJECTORS is built exhaustively from the registry.
- **data-management/contracts.ts** — named error classes map to correct statuses; types are tight.
- **inferhub/types.ts** — raw wire shapes vs normalized shapes are deliberately separated; defensive `unknown` fields are consistent.
- **inferhub/client.ts** — shared rate-limit bucket is bounded; retry is capped at 2 with Retry-After honored; failures return undefined without throwing.
- **inferhub/store.ts** — read-through cache is minimal, mutation-free except the documented test seam, and has explicit freshness windows.
- **observability/usage-periods.ts + usage-dimensions.ts** — slim canonical modules; correctly consumed by dashboard codegen.
- **observability/sse.ts** — heartbeat/abort/close cleanup is correct; reused consistently by logs, live, updates, and share routes.
- **observability/performance.ts + performance-contracts.ts** — minimal; no issues found.
- **observability/routes.ts + logs.ts** — scopes, 304/conditional handling, and SSE header patterns are consistent; no dead routes.
- No `any` or suppression directives were found in the audited directories; the only casts are narrow, local `as Record<string, unknown>` for untrusted JSON, which fits the codebase's defensive parsing standard.

---

## Execution status

- **Area execution:** 17 file(s) changed in this scope during the cleanup pass; `bunx tsc --noEmit` clean and full backend suite green (4217 pass / 0 fail, protocol 591 pass / 0 fail).
- **Confirmed done (✅):** Usage chart `cached` now reads `bucket.cachedInputTokens` (A1 — fixed by orchestrator, SQL + store); dead `summarizeUsagePerformance` removed (D4); `formatSseFrame` re-export dropped (D5).
- **Not done / skipped (⛔):**
  - S2 dead header writes on SSE route — not verified
  - O4 UA client-name cache — not verified
- **Note:** this status reflects the orchestrator's verification of representative findings, not an item-by-item re-audit of every finding in this report.
