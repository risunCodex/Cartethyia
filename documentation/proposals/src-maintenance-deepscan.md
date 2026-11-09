# Proposal — src maintenance deepscan (master)

Status: **executed (2026-11-09)** — all CONFIRMED findings implemented and
verified; see §11 Execution status. Local commit only, no push.
Date: 2026-11-09
Scope: `src/**` (exclusive, per-area audits; no source, test, config, or git
state modified).
Method: 15 parallel area audits plus independent composition. Each area report
is a read-only deep audit (CodeGraph call-path mapping + direct source reads +
caller/test sweeps). This master consolidates the 13 delivered area reports,
deduplicates overlapping findings across areas, resolves disagreements, and
preserves explicit uncertainty. Two planned areas produced no report
(`02-protocol`, `08-integrations-a`); they are recorded as unverified below.

Source reports (all under `documentation/proposals/parts/`):
- `01-boot-config.md` — boot, config, composition root, main.ts
- `03-transport-request-surface.md` — request prep, guards, surface adapters
- `04-transport-dispatch.md` — dispatch, streaming, retries, finalization
- `05-transport-routing.md` — routing, selection, quota admission, snapshots
- `06-provider-core-discovery.md` — provider core, registry, metadata, discovery
- `07-provider-operations-quota-auth.md` — provider operations, quota, auth
- `09-integrations-b.md` — integrations commandcode/cursor/devin/factory/freepi/github/grok/hermes/inception
- `10-integrations-c.md` — integrations kilo/kimi/kiro/muse/ollamacloud/opencode/openrouter/perch
- `11-integrations-d.md` — integrations qoder/shared/trae/xai/xiaomi-mimo/zcode
- `12-console-domains-a.md` — console keys/auth/audit/backup/cli-tools/data-management/inferhub
- `13-console-domains-b.md` — console ip-bans/observability/providers/quota/remote-support/routing/settings/share/system-prompt/updates
- `14-network-security.md` — network egress, pools, security, admission
- `15-persistence-runtime-observability.md` — persistence, observability, workers, shared

**Unverified areas (recorded honestly):** `src/protocol/**` (02) and
`src/providers/integrations/{anthropic,claude,buddy,copilot,…}/**`-family
(08) were not audited; no report exists. Nothing in this master proposes
changes there, and the two areas may contain the same duplication classes
found elsewhere.

---

## 1. Requested problem

Maintenance campaign for `src/`: cleanup, deduplication/merge, less bloat,
faster code — while preserving memory/state integrity, valid fallbacks, clear
ownership, and maintainable structure. Priority constraints carried from every
area audit: memory/state integrity and valid fallback behavior win over
cleanup; duplicated logic is only removed when the copies share the same
contract, state scope, ordering, error semantics, and safety boundary. This is
an audit proposal only; implementation waits for approval. No push.

## 2. Consolidated findings inventory

62 findings across 13 areas. Verdicts: **CONFIRMED** (56) vs **PLAUSIBLE**
(6). Two reviewed-and-kept consolidation candidates (15-F1, 15-F5) are
recorded as deliberate non-findings. Cross-area duplicates are merged where a
single underlying defect was reported by two areas (see §3). Master IDs are
assigned for decision tracking; each row preserves its source part ID, file
paths, and the owning report.

### Executive summary table

| ID | Area / Finding | Verdict | Behavior change | Severity | Effort |
| --- | --- | --- | --- | --- | --- |
| M-01 | boot-01 triple-flush duplicated (main.ts ↔ lifecycle.ts) | CONFIRMED | no | MED | S |
| M-02 | boot-02 surface-adapter list enumerated twice in createGatewayApp | CONFIRMED | no | LOW | S |
| M-03 | boot-03 drain-budget defaults duplicated, already divergent | CONFIRMED | no | LOW | S |
| M-04 | 03-F1 wire-body decoders duplicated (chat/responses) | CONFIRMED | no | LOW | S |
| M-05 | 03-F2 model-admission gate duplicated (prepare/#planNative) | CONFIRMED | no | MED | S |
| M-06 | 03-F3 completion stop-reason/usage derivations duplicated | CONFIRMED | no | LOW | S |
| M-07 | 03-F4 route-gate boilerplate duplicated across middlewares | CONFIRMED | no | LOW | S |
| M-08 | 04-F1 egress verdict → pool-flag policy duplicated (attempt-loop/finalize) | CONFIRMED | no | MED | S |
| M-09 | 04-F2 completionContext/nativeCompletionBase duplicate builder | CONFIRMED | no | MED | S |
| M-10 | 04-F3 candidateKey re-implements comboCandidateKey | CONFIRMED | no | LOW | S |
| M-11 | 04-F4 upstream forwarding Response builder duplicated ×4 | CONFIRMED | no | LOW | S |
| M-12 | 04-F5 outbound network-binding construction duplicated | CONFIRMED | no | MED | M |
| M-13 | 05-F1 unused EligibilityEvaluator.filter (dead code) | CONFIRMED | no | LOW | S |
| M-14 | 05-F2 soft-cooldown candidates not deprioritized (ordering defect) | CONFIRMED | **yes** | MED | M |
| M-15 | 05-F3 candidate construction duplicated across four route-catalog literals | CONFIRMED | no | MED | M |
| M-16 | 05-F4 per-candidate quota reads are serial round trips; batch APIs unused | CONFIRMED | no | MED | M |
| M-17 | 05-F5 free-plan detection duplicated across plan-gate/account-tier | CONFIRMED | no | LOW | S |
| M-18 | 06-F1 ten metadata predicates re-scan bundled array per call | CONFIRMED | no | LOW | S |
| M-19 | 06-F2 discovery-backed provider ids enumerated three times + divergent test copy | CONFIRMED | no | LOW | M |
| M-20 | 06-F3 ProviderRegistry.snapshot/ProviderRegistrySnapshot dead; #revision write-only | CONFIRMED | no | LOW | S |
| M-21 | 06-F4 JSON-credential token extraction duplicated verbatim | CONFIRMED | no | MED | S |
| M-22 | 06-F5 provider-family id sets duplicated despite canonical export | CONFIRMED | no | MED | S |
| M-23 | 06-F6 loadOne vs resolve near-duplicate, one consumer | PLAUSIBLE | yes (unclear) | LOW | S |
| M-24 | 07-F1 Claude module-local quota cache can overwrite debit-ahead balance | CONFIRMED | **yes** | MED | S |
| M-25 | 07-F2 parseLimitWindows/parseQuotaWindows overlapping parsers | CONFIRMED | no | MED | M |
| M-26 | 07-F3 account-row+OAuth-state loading implemented four times | CONFIRMED | no | LOW | S |
| M-27 | 07-F4 five client-version extractors are subsets of defaultExtract | CONFIRMED | no | LOW | S |
| M-28 | 07-F5 free-plan marker split (merged with M-17, see §3) | — | — | — | — |
| M-29 | 09-F1 hand-rolled bounded TTL maps vs canonical TtlCache | CONFIRMED | no | MED | M |
| M-30 | 09-F2 provider device-poll overrides re-implement pollGenericDeviceAuth | CONFIRMED | no | MED | M |
| M-31 | 09-F3 Command Code quota re-implements coerce/isoDate helpers | CONFIRMED | no | LOW | S |
| M-32 | 09-F4 protobuf addType/addEnum duplicated verbatim | CONFIRMED | no | LOW | S |
| M-33 | 09-F5 dead export isExpiringSoon (cursor-auth) | CONFIRMED | no | LOW | S |
| M-34 | 10-F1 Kiro TokenType mapping duplicated three times | CONFIRMED | no | MED | S |
| M-35 | 10-F2 Kiro conversation-id resolver invoked three times; fallback mints distinct UUIDs | CONFIRMED | **yes** (fallback only) | MED | S |
| M-36 | 10-F3 PERCH_APP_URL declared twice | CONFIRMED | no | LOW | S |
| M-37 | 10-F4 Perch credential-envelope parsing duplicated | CONFIRMED | no | LOW | S |
| M-38 | 10-F5 KIRO_EFFORTS duplicated between catalog/discovery | CONFIRMED | no | LOW | S |
| M-39 | 10-F6 OpenCode Go quota re-implements isoDate | CONFIRMED | no | LOW | S |
| M-40 | 11-F1 Qoder roster-context/output resolvers duplicated (3 copies of 2 rules) | CONFIRMED | no | LOW | S |
| M-41 | 11-F2 Trae region→host resolution duplicated across dispatch/quota | CONFIRMED | no | LOW | S |
| M-42 | 11-F3 Qoder claim/check-in duplicate four helpers + near-duplicate PAT exchange | CONFIRMED | no | MED | M |
| M-43 | 11-F4 Qoder gRPC builder dead `_contextWindow` parameter + wasted work | CONFIRMED | no | MED | S |
| M-44 | 11-F5 fetchQoderIdeWithEmptyRecovery unreferenced outside tests | PLAUSIBLE | none if verified | LOW | S |
| M-45 | 12-F1 dead branch in listKeys (both arms identical) | CONFIRMED | no | LOW | S |
| M-46 | 12-F2 loopback+drain-token gate duplicated across four admin endpoints | CONFIRMED | no | MED | S |
| M-47 | 12-F3 API-key family cache-invalidation + admission-purge triplicated | CONFIRMED | no | MED | M |
| M-48 | 12-F4 duplicate num/numOrNull in InferHub normalize | CONFIRMED | no | LOW | S |
| M-49 | 12-F5 injectorFor shadows canonical injector map | CONFIRMED | no | LOW | S |
| M-50 | 13-F1 account-status PATCH validation duplicated tenant/global | CONFIRMED | no | MED | S |
| M-51 | 13-F2 listPools/getPoolDetail duplicate enrichment projection | CONFIRMED | no | MED | S |
| M-52 | 13-F3 live-cooldown SQL fragment duplicated catalog/global-quota | CONFIRMED | no | MED | S–M |
| M-53 | 13-F4 IP-ban domain private ban-duration copy + dead export | CONFIRMED | no | LOW | S |
| M-54 | 13-F5 summarizeUsagePerformance/percentile have no production callers | CONFIRMED | no | LOW | S |
| M-55 | 13-F6 CSRF/mutation-limiter duplicate path/method/exclusion predicate | CONFIRMED | no | MED | S |
| M-56 | 14-F1 provider-scoped egress verdict audit-row writers duplicated ×3 | CONFIRMED | no | LOW | S |
| M-57 | 14-F2 failure-path pool reads issue unbatched Redis round trips | PLAUSIBLE | no | LOW | M |
| M-58 | 14-F3 misleading comment contradicting negative auth cache | CONFIRMED | no (comment) | LOW | S |
| M-59 | 14-F4 hand-rolled bounded-map eviction despite shared helper | PLAUSIBLE | no | LOW | M |
| M-60 | 15-F2 telemetry toRow (reconciliation) vs telemetryEventRow drift | CONFIRMED | **yes** (backfill) | MED | S |
| M-61 | 15-F3 file-based event-log read surface is legacy; only types/const used | CONFIRMED | no | LOW | M |
| M-62 | 15-F4 memory gauges published to two registries from one sample | PLAUSIBLE | no | LOW | S |

Reviewed-and-kept (explicitly not findings): 15-F1 (`UsageFlushBuffer` vs
`HealthEventFlushBuffer` — different pending structures, failure policies, and
a drain barrier; merging would risk the invariants) and 15-F5 (`TtlCache.load`
vs hand-rolled tenant-preference read-through — different layers/cache
instances; routing through `load` would change the hot miss path without test
coverage). These are recorded so a later reader does not re-report them.

## 3. De-duplication across areas

- **Free-plan marker (M-17 = M-28).** 05-F5 (`src/transport/routing/plan-gate.ts:20-27`,
  `FREE_PLAN_MARKERS`) and 07-F5 (`src/providers/operations/account-tier.ts:40-45`)
  report the same single underlying defect: one "is free plan" predicate
  implemented twice with a comment claiming the two cannot disagree. Merged
  into M-17. The 07 report's owned side of the fix is the `account-tier.ts`
  consumer; the shared constant should live in `plan-gate.ts` or a neutral
  module. One finding, two consumer surfaces.
- **Bounded-map / cache-primitive consolidation family (related, not merged).**
  09-F1 (M-29) targets the time-based `TtlCache` for grok/cursor stores; 14-F4
  (M-59) targets the insertion-order `BoundedLruMap` for the SSRF DNS cache and
  byte accounting. Different canonical primitives (`src/persistence/ttl-cache.ts`
  vs `src/transport/routing/bounded-lru.ts`), different recipients; kept
  separate but sequenced together in Tier 2 so the shared primitives gain
  coverage once.
- **Redis round-trip batching (related, not merged).** 05-F4 (M-16, quota
  admission reads) and 14-F2 (M-57, pool failure-explain reads) are the same
  pattern (per-key GETs → batched MGET) in different subsystems with different
  cache/snapshot precedence invariants. Kept separate; both are Tier 3
  latency work.
- **Egress verdict handling (adjacent, not duplicates).** 04-F1 (M-08)
  duplicates the classify → flagPoolCooldown/Blocked *call* between attempt-loop
  and streaming finalize; 14-F1 (M-56) duplicates the `health_events` audit-row
  *insert shape* across three writers. Distinct facts (policy dispatch vs row
  construction) in overlapping code; both stand, sequenced together.
- **Encode-surface registry (boot-02) vs proxy-request encode switch.** The 01
  report deliberately excludes the four-surface encode switch from boot-02
  (different encode signatures per surface). No merge proposed. Confirmed
  disagreement-free: the 03 report independently reaches the same conclusion
  (sync vs streaming encoders stay separate state machines).
- **`num`/`numOrNull` (M-48) vs `asRecord`/`asCoercedNumber` (M-31/M-42).**
  Different modules (`src/console/inferhub/normalize.ts` vs
  `src/shared/coerce.ts`), same dialect of helper. Not merged — the InferHub
  pair is internal to console and the shared coerce module already exists;
  M-48 is the local alignment, M-31/M-42 are imports of the shared module.

**Resolved disagreement:** 07-F5 labels the free-plan split PLAUSIBLE while
05-F5 labels it CONFIRMED. Both agree on the mechanism and the identical
semantics; the difference is only certainty about drift risk. Resolution:
treat as CONFIRMED duplication with a low behavior-change risk (the two copies
are byte-identical today), preserve the "must not drift" framing.

## 4. Current state — key evidence (path:symbol)

- **M-14 (routing defect, the only confirmed behavior-breaking bug):**
  `src/transport/routing/router.ts:481-482` excludes only
  `cooldown_kind === "hard"`; `router.ts:717-720` assigns `ROUTING_RANK.COOLING`
  only for `model_cooldown`/`cooldown_hard`; soft cooldowns (the runtime stamp
  default, `route-catalog.ts:909-921`) fall through to `FRESH_KNOWN` and sort
  ahead of healthy siblings. Verified against source in this composition.
- **M-24 (stale-state hazard):** `src/providers/integrations/claude/claude-quota.ts:153`
  keeps a module-local `TtlCache<ProviderQuotaResult>` keyed by credential that
  is never invalidated by a debit; `debitCachedQuota` (`quota/cache.ts:255`)
  subtracts from the shared cache, so a sweep within the 5-minute local TTL can
  write the pre-debit balance back. Verified: the local cache exists and is
  separate from the shared two-tier cache.
- **M-60 (backfill data loss):** `src/observability/telemetry-reconciliation.ts:147-183`
  (`toRow`) omits `creditUsed`, `resolveMs`, `tokensPerSec`,
  `firstContentDeltaAtMs`, `lastEventAtMs`, `payloadCaptureState`,
  `degenerateStop` that `telemetry-buffer.ts:108-167` (`telemetryEventRow`)
  persists; `toRow`'s return type silently nulls them.
- **M-35 (state-integrity divergence):** `src/providers/integrations/kiro/kiro.ts:379-387,608`
  calls `resolveKiroConversationId` three times; the no-session fallback mints
  a fresh UUID per call, so `conversationId` ≠ `rootConversationId` and the
  usage-cache key diverges from the request's id.
- **M-46 (security boundary):** `src/transport/drain-endpoint.ts:53-60`,
  `src/console/backup/export-endpoint.ts:55-58`,
  `src/console/auth/account-reset.ts:43-50`, `src/boot/app.ts:655-658` repeat
  the identical loopback+token gate.
- **M-55 (security-adjacent):** `src/console/console-router-guards.ts:21-41,77-111`
  duplicate the CSRF/mutation-limiter exclusion predicate and list.
- **M-08:** `src/transport/dispatch/attempt-loop.ts:400-423` and
  `src/transport/dispatch/streaming/finalize.ts:582-589` repeat the identical
  classify→flagPool sequence.
- **M-09:** `src/transport/dispatch/attempt-finalize.ts:540-584` vs `:593-641`
  (`completionContext` / `nativeCompletionBase`) — same field set, one adds
  `usage`/`commitUsage`.

Full per-finding line-level evidence, fallback analysis, and verification
tests are preserved in each source part report; the IDs above map 1:1 to the
part reports' own finding IDs.

## 5. Recommended design — tiered priorities and order

Findings are grouped by what they are and executed in the order below. Each
item is independent; all are behavior-preserving except where a row says
"yes" (and those are deliberate, documented corrections).

**Tier 1 — correctness / state-integrity / security (highest priority).**
Fix first; each is bounded and test-pinned.
1. M-14 — soft-cooldown rank classification (`router.ts` evaluateCandidate).
   Must decide the all-soft 429 boundary (open decision O-1).
2. M-24 — remove Claude's module-local `quotaCache`; shared cache owns dedup.
3. M-60 — single shared `telemetryInsertRow` used by write + reconciliation.
4. M-35 — resolve Kiro conversation id once per dispatch.
5. M-46 — extract `requireLoopbackAdmin` (owner: `src/transport/drain-endpoint.ts`).
6. M-55 — extract `isProtectedConsoleMutation` + `AUTH_ROUTE_SUFFIXES`.
7. M-08 — extract `flagPoolOnEgressFailure` (owner: `src/network/pool-health.ts`).

**Tier 2 — structural duplication, MED (worthwhile, mechanical with care).**
8. M-12 — `buildDispatchNetworkBindings` (only M-effort hot-path change; keep
   eager/lazy capture-read order).
9. M-29 — consolidate grok/cursor bounded caches onto `TtlCache` (add optional
   `lru` mode to preserve eviction order).
10. M-30 — extend `OAuthDeviceFlow` with additive hooks; Factory/Grok delegate.
11. M-15 — `buildCandidateBase` for the four route-catalog literals (preserve
    each branch's health stamping).
12. M-09 — `nativeCompletionBase` delegates to `completionContext`.
13. M-19 — canonical `DISCOVERY_BACKED_PROVIDER_IDS`; completeness test imports it.
14. M-25 — shared per-window field-resolution core for the two quota parsers.
15. M-42 — share normalize helpers (with null-sentinel care) + unify PAT
    exchange only after verifying which host is live.
16. M-47 — extract `invalidateFamilyCaches` / `purgeFamilyAdmission`
    (unconditional family path only; keep updateKey's tightened-limit logic).
17. M-52 — extract the live-cooldown SQL subquery to `src/persistence/dialect.ts`.
18. M-50 — `resolveNextAccountStatus` in `account-quota-shared.ts`.
19. M-51 — `enrichPoolResponse` in pool operations.
20. M-21 — `extractJsonEnvelopeToken` in `provider-credentials.ts`.
21. M-22 — export Trae/Qoder family id sets from `provider-metadata.ts`.
22. M-05 — extract `#resolveAliasAndGateModel` on the preparer.
23. M-34 — `kiroTokenTypeHeader` from `kiro-catalog.ts`.
24. M-56 — `appendPoolProviderEgressAuditRow` in `pool-cooldown-store.ts`.

**Tier 3 — latency/effort M (worthwhile; needs measurement-backed proof).**
25. M-16 — batch quota reads per lens in `plan()` (one MGET per lens).
26. M-57 — batch cooldown/inflight reads in `getSelectionFailure` (one MGET).

**Tier 4 — LOW/S mechanical cleanups (safe; can batch).**
27. Remaining LOW/S confirmed: M-01, M-02, M-03, M-04, M-06, M-07, M-10,
    M-11, M-13, M-17, M-18, M-20, M-26, M-27, M-31, M-32, M-33, M-36,
    M-37, M-38, M-39, M-40, M-41, M-43, M-45, M-48, M-49, M-53, M-54,
    M-58, M-61, M-62.
28. **Plausible candidates — verify before acting:** M-23 (decide loadOne
    semantics), M-44 (confirm no probe entry point re-exports the recovery
    wrapper before deleting), M-59 (choose BoundedLruMap vs shared eviction
    helper; do not change DNS eviction recency without justification). These
    are explicitly not queued for blind execution.

## 6. Affected file clusters

| Cluster | Files |
| --- | --- |
| Boot/config | `src/main.ts`, `src/boot/app.ts`, `src/boot/lifecycle.ts` (M-01/02/03) |
| Transport request | `src/transport/surface/{chat/parse.ts,responses/parse.ts,completion.ts,adapters.ts,content-parts.ts}`, `src/transport/request/preparer.ts`, `src/transport/guards/{request-context.ts,body-policy.ts}` (M-04/05/06/07) |
| Transport dispatch | `src/transport/dispatch/{attempt-loop.ts,attempt-finalize.ts,proxy-request.ts,generation.ts,systemone.ts,responses-compact.ts,token-count.ts,native-shared.ts,upstream.ts,streaming/finalize.ts,streaming/stream.ts}` (M-08..12) |
| Routing / quota admission | `src/transport/routing/{router.ts,route-catalog.ts,plan-gate.ts}`, `src/providers/quota/{cache.ts,snapshot.ts}` (M-13..17, M-16) |
| Providers core/discovery | `src/providers/{provider-metadata.ts,provider-registry.ts,provider-contracts.ts,default-registry.ts,configured-provider.ts,provider-credentials.ts,discovery/probe-phases.ts}` (M-18..23) |
| Provider operations/quota/auth | `src/providers/integrations/claude/claude-quota.ts`, `src/providers/quota/{quota-limit-windows.ts,quota-window-parser.ts}`, `src/providers/operations/{provider-credential-service.ts,account-refresh-status.ts,client-versions.ts,client-version-resolver.ts}`, `src/providers/authentication/oauth-refresh-service.ts` (M-24..27) |
| Integrations B | `src/providers/integrations/{grok/*,cursor/*,factory/factory-oauth.ts,commandcode/quota.ts,devin/protocol/devin-proto.ts,cursor/protocol/messages.ts,cursor/cursor-auth.ts}` (M-29..33) |
| Integrations C | `src/providers/integrations/{kiro/*,perch/*,opencode/opencode-go-quota.ts}` (M-34..39) |
| Integrations D | `src/providers/integrations/{qoder/*,trae/*}` (M-40..44) |
| Console A | `src/console/api-keys/routes.ts`, `src/transport/drain-endpoint.ts`, `src/console/{backup/export-endpoint.ts,auth/account-reset.ts}`, `src/boot/app.ts` (task trigger), `src/console/inferhub/normalize.ts`, `src/console/cli-tools/injectors/{driver.ts,service.ts}` (M-45..49) |
| Console B | `src/console/quota/{account-quota-tenant.ts,account-quota-global.ts,account-quota-shared.ts}`, `src/console/routing/pools/operations.ts`, `src/console/providers/catalog/store.ts`, `src/console/ip-bans/routes.ts`, `src/console/observability/store.ts`, `src/console/console-router-guards.ts` (M-50..55) |
| Network/security | `src/network/{pool-health.ts,pool-cooldown-store.ts,pool/selector.ts,ssrf.ts,pool/byte-accounting.ts}`, `src/security/{api-key-auth.ts,api-key-auth-cache.ts}` (M-56..59) |
| Persistence/observability | `src/observability/{telemetry-reconciliation.ts,telemetry-buffer.ts,event-log.ts,runtime-metrics.ts,performance-metrics.ts}` (M-60..62) |

## 7. State / memory integrity and fallback risks / guards

- **No finding touches credentials in transit, persisted quota snapshots,
  routing snapshots, leases, or telemetry payloads** except where noted.
- **M-24 is the only genuine stale-state hazard** (debit overwrite). Fixing it
  makes the shared two-tier cache the single source of truth; the retained-
  success and 429-cooldown fallbacks are preserved.
- **M-60 is the only data-loss hazard** (backfilled rows silently null newer
  columns). Fix adds data already present in the raw file; `ON CONFLICT DO
  NOTHING` idempotency is untouched.
- **M-35 changes runtime state layout in the no-session fallback only**; the
  healthy path is byte-identical; the in-memory session-cache estimate becomes
  coherent. No persisted state.
- **M-14 changes routing order and the all-soft 429 boundary** — the only
  finding that changes a fallback decision. The single-account deployment must
  still serve (open decision O-1).
- **M-42's PAT-exchange unification is gated** on verifying which host
  (`center.qoder.sh` vs `openapi.qoder.sh`) is currently live; the null-
  sentinel (`asRecord` → `null` vs `undefined`) must be preserved at call sites.
- Guards that must NOT be loosened (explicitly excluded by the area audits):
  `main.ts`→`createGatewayApp` field-by-field forwarding (production-deps
  wired guard), readiness dual-path, `updateKey` purge-vs-seed logic, backup
  bulk-insert row-diagnostic fallback, the health-buffer `inflightDone` drain
  barrier, the settings-revision monotonic counter, and the API-key negative-
  cache invalidation interplay (M-58 comment fix only).

## 8. Migrations

**None.** No DB schema change, baseline rewrite, or data migration is proposed
by any finding. M-60 changes a row mapping (backfill now fills existing
columns), not the schema. M-52 extracts a SQL fragment; the generated SQL is
unchanged. Dashboard (browser) code is untouched by every backend finding; the
dashboard `ban-durations.ts` mirror is noted as an optional follow-up (open
decision O-5).

## 9. Verification baseline

**Not run.** This is a read-only audit; no test suite was executed and no code
was changed. Proposed proof gates per finding (from the source reports):
- **Per-finding unit/request tests** as named in each area report (e.g.
  M-14: planner ordering tests for soft-vs-healthy and all-soft; M-16: one
  MGET per lens assertion; M-57: one MGET per failure read; M-24: debit-then-
  sweep assertion; M-60: backfill column assertion).
- **Existing behavioral suites that must pass unchanged** — the canonical
  gates: `test/transport/*`, `test/providers/*`, `test/console/*`,
  `test/network/*`, `test/security/*`, `test/observability/*`,
  `test/persistence/*`, `test/protocol/wire-family-codec-coverage.test.ts`,
  `test/meta/production-deps-wired.test.ts`.
- **Typecheck** (`tsc --noEmit`) and the repo gate after each work item.
- **Runtime / latency claims are deliberately not made.** No speed gain is
  asserted anywhere in this proposal; M-16 and M-57 are round-trip-count
  reductions whose end-to-end effect must be measured (open decision O-2)
  before they are claimed as wins.

## 10. Concrete open decisions

- **O-1** (M-14): all-soft-cooling set — answer 429 with the earliest reset,
  or keep serving so a sole-account provider never 429s? Current code serves;
  documented intent leans 429 when a healthy/slow sibling exists.
- **O-2** (M-16/M-57): apply the batch read to the sweep/refresh path too, or
  only the request path? Whether to add a latency benchmark before/after.
- **O-3** (M-23): keep `loadOne` cache-bypassing (rename/`force` param) or
  switch the probe to `resolve`?
- **O-4** (M-44): confirm the probe service cannot reach Qoder's IDE recovery
  wrapper dynamically before deleting; if it can, re-home it at the probe
  boundary.
- **O-5** (M-53 follow-up): should the dashboard `ban-durations.ts` mirror
  import the canonical browser-safe `ban-constants.ts`? Crosses the dashboard
  boundary; proposed only as follow-up.
- **O-6** (M-61): migrate the legacy file-reader tests to `event-query.ts`
  before removing the reader, or keep the reader as a debugging surface?
- **O-7** (M-62): is `memory_bytes.external` required, or can the snapshot be
  derived entirely from the Prometheus gauges?
- **O-8** (boot open question, carried): `empty-stream.ts` hardcodes 200s
  first-chunk timeout — decoupled from the operator knob intentionally?
- **O-9** (15 open question): should backfilled rows fill `tokensPerSec`/
  `creditUsed`/`degenerateStop` (proposed) or stay null to match pre-migration
  rows?

## 11. Execution status

**Execute — complete (2026-11-09).** Local commit only, no push (standing
operator instruction).

- **Phase 0 (re-audit):** 02-protocol and 08-integrations-a re-audited;
  02-protocol produced P-F1..P-F3 (now executed); 08-integrations-a confirmed no
  new findings.
- **Phase 1:** final manifest 60 findings (56 CONFIRMED + 4 promoted:
  M-44, M-62 verified; M-23/M-59 remain plausible-unverified and excluded).
  M-16/M-57 deferred (Tier-3 latency, needs benchmark).
- **Phase 2:** 16 executor agents (one per file-disjoint cluster). All
  clusters completed. Findings executed: M-01..15 (minus 16), M-17..22,
  M-24..27, M-29..44, M-45..56, M-58, M-60..62, P-F1..3.
- **Phase 3 (cross-cluster closure):** M-22 completed via canonical family-id
  exports (`BUDDY_PROVIDER_IDS`, `QODER_CHECKIN_PROVIDER_IDS`,
  `TRAE_PROVIDER_IDS` new export); typecheck re-run after closure.
- **Phase 4 (validation):** `tsc --noEmit` — **0 errors**. Full backend suite
  — **4735 pass / 1 skip / 0 fail** (skip is the pre-existing Redis-gated
  suite). Dashboard `dashboard:typecheck` — unchanged from HEAD: one
  pre-existing error in `src/providers/integrations/buddy/codebuddy/shared.ts`
  (currently only under the dashboard tsconfig; no campaign file touches it;
  not a regression). Focused per-cluster suites were run by each executor.
- **Phase 5:** this master + every part report updated with ✅/⛔ per finding.
  ⛔ only with reason: M-16/M-57 (deferred Tier-3), M-23/M-59 (plausible-
  unverified), M-42 PAT-exchange (live-host-gated residual). CHANGELOG updated.
  Single local commit (no push).

### Per-finding status summary

| Finding | Status | Finding | Status |
|---|---|---|---|
| M-01 | ✅ | M-31 | ✅ |
| M-02 | ✅ | M-32 | ✅ |
| M-03 | ✅ | M-33 | ✅ |
| M-04 | ✅ | M-34 | ✅ |
| M-05 | ✅ | M-35 | ✅ |
| M-06 | ✅ | M-36 | ✅ |
| M-07 | ✅ | M-37 | ✅ |
| M-08 | ✅ | M-38 | ✅ |
| M-09 | ✅ | M-39 | ✅ |
| M-10 | ✅ | M-40 | ✅ |
| M-11 | ✅ | M-41 | ✅ |
| M-12 | ✅ | M-42 | ✅ (PAT exchange ⛔ live-host-gated) |
| M-13 | ✅ | M-43 | ✅ |
| M-14 | ✅ | M-44 | ✅ (promoted) |
| M-15 | ✅ | M-45 | ✅ |
| M-16 | ⛔ deferred Tier-3 | M-46 | ✅ |
| M-17 | ✅ | M-47 | ✅ |
| M-18 | ✅ | M-48 | ✅ |
| M-19 | ✅ | M-49 | ✅ |
| M-20 | ✅ | M-50 | ✅ |
| M-21 | ✅ | M-51 | ✅ |
| M-22 | ✅ (Phase-3 closure) | M-52 | ✅ |
| M-23 | ⛔ plausible-unverified | M-53 | ✅ |
| M-24 | ✅ | M-54 | ✅ |
| M-25 | ✅ | M-55 | ✅ |
| M-26 | ✅ | M-56 | ✅ |
| M-27 | ✅ | M-57 | ⛔ deferred Tier-3 |
| M-29 | ✅ | M-58 | ✅ |
| M-30 | ✅ | M-59 | ⛔ plausible-unverified |
| — | — | M-60 | ✅ |
| — | — | M-61 | ✅ |
| — | — | M-62 | ✅ (promoted) |
| — | — | P-F1 | ✅ |
| — | — | P-F2 | ✅ |
| — | — | P-F3 | ✅ |
