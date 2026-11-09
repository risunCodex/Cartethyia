# Console Domains A: Deep Audit — Keys, Auth, Audit, Backup, CLI Tools, Data Management, InferHub

## Scope

Read-only audit of `src/console/api-keys/**`, `src/console/audit/**`, `src/console/auth/**`,
`src/console/backup/**`, `src/console/cli-tools/**`, `src/console/data-management/**`,
`src/console/inferhub/**`. No source, test, configuration, or git state was modified.
This file is the only artifact produced.

Coverage: all files in the seven domains were read or explored via CodeGraph
(verbatim source) plus targeted reads. Tests inspected: `test/console/api-key-*.ts`
(default, prefix, list-order, regenerate-label, ban-audit-label, shared-page,
shared-revoke), `test/console/backup-*.ts` (contract, native-identity, portability,
restore-selection, share-child-policy, sqlite-restore, stream), `test/console/cli-tool-*.ts`
(injectors, lifecycle, model-completeness), `test/console/data-management.test.ts`,
`test/console/inferhub-*.ts` (key-store, market, routes), `test/console/login-lockout-message.test.ts`,
`test/console/session-cookie-security.test.ts`, `test/console/account-*.ts`.

## Current-flow evidence (canonical owners)

| Flow | Entry | Canonical owner | Consumers |
|---|---|---|---|
| Console auth (login/setup/session/lockout) | `createConsoleAuthRoutes` `src/console/auth/session.ts:237` | `ConsoleSessionService` `session-service.ts:125`, `ConsoleLockoutService` `lockout.ts:59`, `FirstBootSetupService` `setup-service.ts:48` | `src/boot/app.ts`, `domain-registration.ts` |
| Access resolution | `resolveConsoleAccess` / `resolveConsoleUser` `session-resolver.ts:32,63` | session-service + `readUsers` `user-store.ts:31` | every console route via `ConsoleAccessResolver` |
| Audit read | `createAuditRoutes` `audit/routes.ts:13` | `DrizzleAuditReadStore.list` `audit/store.ts:96` | `/console/api/audit` |
| Audit write | `AuditRecorder.record` `auth/audit-recorder.ts:66` | `admin_audit_log` insert | all console mutation routes |
| API keys | `createApiKeyOperations` `api-keys/routes.ts:81` | `DrizzleApiKeyStore` `src/persistence/stores/api-key-store.ts` | `createApiKeyRoutes` `routes.ts:927` |
| Backup/restore | `createBackupRoutes` `backup/routes.ts:166` | `BackupService` `backup/service.ts:270` → `applyRestore` `backup/store.ts:1059` | setup wizard (`setup-service.ts:216`) |
| Loopback-admin endpoints | drain, backup export, account reset, task trigger | `isLoopbackPeer`/`tokenMatches` `src/transport/drain-endpoint.ts:37,46` | `src/boot/app.ts` |
| CLI tools | `createCliToolsRoutes` | `CliToolService` `cli-tools/service.ts:93` → `createFileInjector` `cli-tools/injectors/driver.ts:32` | dashboard hooks |
| Data management | `createDataManagementRoutes` `data-management/routes.ts:29` | `createDataManagementOperations` `data-management/operations.ts:120` | dashboard hooks |
| InferHub | `createInferhubRoutes` `inferhub/routes.ts:213` | `ensureModels`/`ensureStatus` `routes.ts:97,156`; store `inferhub/store.ts`; client `client.ts` | dashboard `InferhubMarket` |

## Findings

### F1 — Dead branch in `listKeys`: both arms return the same value (CONFIRMED)

**Evidence:** `src/console/api-keys/routes.ts:99-105`:

```ts
return Promise.all(
  visible.map(async (record) => {
    const response = sanitizeApiKeyResponse(record);
    if (record.keyMode !== "share") return response;
    return response;
  }),
);
```

Both branches return `response` verbatim. The comment block above (lines 95-98)
describes a telemetry-based family accumulator, but no telemetry add-on exists in
the code — the branch is a leftover from a design that was removed. A grep of the
whole file confirms no other use of this distinction inside `listKeys`.

**Mechanism:** structural dead code survived a refactor. The conditional adds a
code path with no behavioral difference; it is noise and invites a future editor
to add a divergent branch.

**Why consolidation helps:** removes a confusing no-op and a now-false comment;
~6 lines, zero behavior change.

**Proposed owner:** `src/console/api-keys/routes.ts` — `createApiKeyOperations.listKeys`.
**Bounded change:** replace the `visible.map(async …)` block with
`visible.map(sanitizeApiKeyResponse)` and delete the stale comment.
**Behavior change:** no (both branches identical).
**State/fallback risk:** none.
**Severity/effort:** LOW / S.
**Verification:** `test/console/api-key-default.test.ts` and
`test/console/api-key-regenerate-label.test.ts` already exercise `listKeys` for
personal and share keys; run the api-key suites. A focused assertion that a
share-mode key returns the same fields as its sanitized record would pin it.

### F2 — Loopback + drain-token gate duplicated across four admin endpoints (CONFIRMED)

**Evidence:**
- `createDrainHandler` — `src/transport/drain-endpoint.ts:53-60`
- `createBackupExportHandler` — `src/console/backup/export-endpoint.ts:55-58`
- `createConsoleAccountResetHandler` — `src/console/auth/account-reset.ts:43-50`
- task trigger — `src/boot/app.ts:655-658`

All four perform the identical pair: `isLoopbackPeer(deps.resolvePeerAddress(request))`
→ `GatewayError("policy_rejected", 403, …)` and
`tokenMatches(request.headers.get("x-drain-token"), deps.token)` →
`GatewayError("authentication_failed", 401, …)`, with near-identical prose
(three of four copy the same "no hard feelings 🫂" / "Wrong key, right door 🔑"
strings). Three of the four live in separate files under separate domains.

**Mechanism:** the security boundary for host-local admin operations is
copy-pasted. A policy change (e.g., tightening loopback detection, adding a
second header, or changing the error codes) currently requires four coordinated
edits; a missed one silently weakens or changes one surface.

**Why consolidation helps:** one canonical `requireLoopbackAdmin(request, { peer, token })`
helper (throwing the same two `GatewayError`s) removes ~28 duplicated lines and
makes the security boundary a single review point. The contract, ordering
(peer first, token second), error codes, and messages are identical across all
four sites.

**Proposed owner:** `src/transport/drain-endpoint.ts` (canonical home of
`isLoopbackPeer`/`tokenMatches`). **Bounded change:** add
`requireLoopbackAdmin`; call it from the three factories and the inline task
trigger. Keep the existing error codes, HTTP statuses, and message text exactly.
**Behavior change:** no — identical gate, ordering, and error semantics.
**State/fallback risk:** cannot be lost by the change; if a caller is missed,
that endpoint still has its own inline gate (the change is additive per site).
**Severity/effort:** MED / S.
**Verification:** existing tests for each endpoint
(`test/console/9router-import.test.ts`, backup export via `backup-*.ts`,
`account-reset.test.ts`, task-trigger paths in boot tests); plus a focused test
that a non-loopback peer and a wrong token each produce the preserved
`policy_rejected`/`authentication_failed` codes on all four surfaces.

### F3 — API-key family cache-invalidation + admission-purge sequence repeated in three mutation handlers (CONFIRMED)

**Evidence:** `src/console/api-keys/routes.ts`:
- `updateKey` lines 345-351 (`listChildren` → `invalidateApiKeyCache(keyId)` →
  loop children → later `admissionService.purgeKey(keyId)` + children at 400-404)
- `deleteKey` lines 447-455 (same sequence)
- `regenerateKey` lines 629-630 (`invalidateApiKeyCache(keyId)` → `purgeKey(keyId)`;
  single-key, no children)

All three repeat the same "load children, invalidate auth cache for parent and
children, purge admission state for parent and children" pattern, with the same
ordering and the same rationale (parent policy is live-inherited; cached child
snapshots must die with the parent; admission counters must not survive a
revocation/regeneration).

**Mechanism:** a shared invariant expressed three times. The sequences are
behaviorally identical in what they invalidate; the only differences are the
surrounding write operations. A future change to the invalidation contract (e.g.,
a new cache that must also be dropped) has three sites to keep in sync, and a
missed child loop silently leaves a stale cached identity for a share recipient.

**Why consolidation helps:** one `invalidateFamilyCaches(keyId, children)` and
one `purgeFamilyAdmission(admissionService, keyId, children)` helper removes the
triplicated loop and makes the invariant a single review point while keeping the
exact per-key ordering (parent first, then children).

**Proposed owner:** `src/console/api-keys/routes.ts` — module-level helpers next
to `createApiKeyOperations`.
**Bounded change:** extract the two helpers and call them from `updateKey`,
`deleteKey`, and `regenerateKey`. Do not alter the order of invalidation vs. the
store write in any handler.
**Behavior change:** no — same keys invalidated, same purge order.
**State/fallback risk:** the `updateKey` tightening logic (lines 375-424) is
separate and intentionally narrower (only purges when a limit tightened / new
limit added) — that must *not* be folded into the shared helper. Only the
unconditional family invalidation/purge is extracted.
**Severity/effort:** MED / M.
**Verification:** `test/console/api-key-shared-revoke.test.ts`,
`api-key-regenerate-label.test.ts`, `api-key-default.test.ts`. Add an assertion
that after a parent `updateKey`/`deleteKey`/`regenerateKey`, a child's cached
auth entry is evicted (the existing suites already cover revocation; the
invalidation path is testable via the cache internals used by
`test/security/api-key-auth*`).

### F4 — Duplicate `num`/`numOrNull` implementations in InferHub normalize (CONFIRMED)

**Evidence:** `src/console/inferhub/normalize.ts:39-48` (`num`, non-exported)
and `:51-58` (`numOrNull`, exported). Bodies are identical (same finite-number
check, same decimal-string fallback, same null return). `numOrNull` is used by
`routes.ts:194-199`; `num` is used internally. This is not speculative: both
functions are byte-for-byte equivalent in logic.

**Mechanism:** a copy-paste split that likely happened when one helper was
exported for the routes. Any fix to the numeric coercion (e.g., handling a new
wire format) must be applied twice or the two drift.

**Why consolidation helps:** keep `numOrNull` as the single implementation and
alias `num` to it (or replace internal `num` calls with `numOrNull`). Removes a
second copy of a subtly security-relevant coercion (untrusted upstream numbers).

**Proposed owner:** `src/console/inferhub/normalize.ts`.
**Bounded change:** delete `num` and replace its ~6 call sites with `numOrNull`.
**Behavior change:** no — identical function body.
**State/fallback risk:** none (pure function).
**Severity/effort:** LOW / S.
**Verification:** `test/console/inferhub-market.test.ts` covers `numOrNull` via
the "null handling" block (`describe("null handling")` at line 152); the suites
already pin the coercion. Run the inferhub suites.

### F5 — `injectorFor` shadows the canonical injector map (CONFIRMED, low value)

**Evidence:** `src/console/cli-tools/injectors/driver.ts:50-53`:

```ts
function injectorFor(toolId: string): ToolInjector | null {
  const injector = INJECTORS[toolId as ToolId];
  return injector ?? null;
}
```

`INJECTORS` is already a complete `Record<ToolId, ToolInjector>` (built by
`Object.fromEntries(TOOL_IDS.map(...))` at `driver.ts:142-150`, throwing at
import time for a missing injector). `injectorFor` only adds a `null`-fallback
on a map that cannot miss (the compiled record is complete). Every miss path in
`service.ts` (`getStatus`, `downloadConfig`, `applyConfig`) already handles
`null` by returning `null`/early-return, so the wrapper adds no behavioral
difference over `INJECTORS[id]` with a type-narrowed check.

**Mechanism:** a defensive wrapper around an exhaustively-built record. It is not
harmful, but it is redundant indirection; `service.ts` could call `INJECTORS`
directly (the `as ToolId` cast is already the compile-time contract) and drop
the helper. Low value, but real.

**Why consolidation helps:** removes a redundant indirection; makes the
injector boundary read as "the registry is the map". ~4 lines.

**Proposed owner:** `src/console/cli-tools/injectors/driver.ts` + `service.ts`.
**Bounded change:** inline the lookup (`INJECTORS[toolId as ToolId]`) at the
three use sites (or keep `injectorFor` but drop the impossible `?? null`).
**Behavior change:** no — the map is complete by construction, and the null
path is never reached.
**State/fallback risk:** none.
**Severity/effort:** LOW / S.
**Verification:** `test/console/cli-tool-injectors.test.ts` and
`cli-tool-lifecycle.test.ts` exercise all four tools' status/apply/download;
they cover the non-null path. No new test needed for a no-op refactor.

## State / fallback analysis (explicitly checked, not proposed for change)

- **InferHub snapshot store (`inferhub/store.ts`).** The read-through cache with
  freshness windows is deliberately not a poller; a failed refresh returns the
  previous snapshot with `stale: true` and never blanks a view
  (`ensureModels`/`ensureStatus` in `routes.ts:97-204`). Any consolidation of
  `ensureModels`/`ensureStatus` must preserve (a) the freshness-window check
  before fetch, (b) the stale-keep fallback on fetch failure, (c) the
  `no_config_key` error path, and (d) the fact that the store is module-level
  state shared across the process. We found no safe consolidation here — the two
  helpers fetch different endpoints (`/catalog`+`/market` vs `/status`) and
  cache different data, so they are correctly separate.
- **Backup/restore (`backup/store.ts`, `service.ts`).** The restore is one
  transaction; validation precedes any write; deletion is ownership-scoped
  (`ownedByFilter`), never table-wide; telemetry appends idempotently by natural
  key. The bulk-insert chunk-with-savepoint plus per-row diagnostic fallback
  (`insertRows`, `store.ts:805-984`) is deliberate: it exists to name the
  offending row without losing the bulk error. **Do not** "simplify" this to a
  loop or to a single bulk statement — the fallback is the safety boundary that
  keeps a bad row from failing an entire restore with an unactionable error.
  `restoreFirstBoot` and `restore` share `apply` correctly; they differ in
  format acceptance and admin handling, and must not be merged.
- **API-key admission counters.** `updateKey`'s purge-vs-seed logic
  (`routes.ts:375-424`) is deliberately conservative: purge only on a
  *tightened or newly added* ceiling, seed only on a *newly added* ceiling. The
  comments document the failure modes this avoids (a `!== undefined` check
  wiped mid-bucket counters on every save; re-seeding after a purge would
  restore the baseline the purge removed). Any refactor of `updateKey` must keep
  this distinction — it is the reason F3 is scoped to the *unconditional*
  family invalidation and not the limit logic.
- **Session sweep (`deleteExpiredSessions`, `session-service.ts:27-40`).** The
  bounded 1000-row pass is intentional (no long lock). The scheduled interval
  (12h, `dependencies.ts:387-396`) is tuned to the 48h session lifetime. Not a
  candidate for "optimization" — changing the bound or interval alters both
  lock duration and sweep promptness with no correctness gain.
- **Lockout (`lockout.ts`).** The atomic `upsertFailure` with a sliding-window
  CASE expression and the `lock` step are a single coherent security flow.
  `recordFailure` increments *then* decides the lock; the count comes from the
  row the failure just wrote, so a token can never be told "attempts remain"
  after a lock is taken. Any refactor must keep this ordering. The
  `logBanAudit` best-effort sink (wrap in try/catch, stderr on failure) is the
  documented fail-open posture and must not be hardened into a blocking write.
- **Data-management reclaim (`data-management/operations.ts`).** The telemetry
  directory is injected; the payload directory is deliberately not (the module
  comment explains why a second path would let the scanner measure one place
  while prune empties another). `reclaim("payload_frames")` measures before/after
  rather than estimating, because frame expiry lives inside each file. The
  per-tenant `payloadRetentionMs` resolution is load-bearing (the panel must not
  report the deployment default while the gateway applies the tenant's window).
  Do not consolidate the two `scan` calls in `usage()` into one traversal
  without preserving the distinct stale-vs-total semantics.
- **CLI injector file writes.** `writeJsonFileWithBackup`/`writeTextFileWithBackup`
  preserve `.bak` before overwrite; this is the anti-clobber guarantee for
  hand-edited config files. The `codex` auth-helper file and `auth.json` have a
  coordinated write/reset/remove lifecycle; any consolidation across injectors
  must not merge the two distinct file formats (TOML text editing vs JSON) — the
  `textGet`/`textUpsert`/`textRemove` helpers exist precisely because the
  formats differ.
- **Account reset (`account-reset-store.ts`).** `resetConsoleAuthState` deletes
  lockouts and users in one transaction so first-boot setup can follow
  immediately. This is a destructive, intentional operation; the loopback+token
  gate (F2) is its boundary. No change proposed.

## Excluded / unverified suspects

- **`exportBackup` buffered variant (`backup/store.ts:568-577`)** is used by
  backup round-trip tests to feed restores; it intentionally exists alongside
  the streaming form. Leaving it is correct; it is not dead code.
- **`readUsers`/`readUser`/`ConsoleUserStore` (`user-store.ts`)** — small, no
  verified duplication; `findByUsername`'s two-row limit is a deliberate
  ambiguity guard (shared usernames refused rather than guessed).
- **`shouldUseSecureSessionCookie` / `securePolicyForRequest`
  (`session-service.ts:42-48`, `session.ts:132-151`)** — two different policies
  (env-time default vs per-request proxy-boundary upgrade); merging them would
  change cookie security behind TLS-terminating proxies, so it is excluded.
- **`resolveConsoleUser` returning `passwordHash`** — used by backup
  re-authentication; intentional and required, not a leak.
- **`ban-constants.ts` vs `ip-bans/routes.ts` `BAN_DURATION_CHOICES`** — both
  exist and are identical in value, but they serve different domains (API-key
  ban durations vs manual IP-ban durations), live in different modules, and one
  is browser-safe while the other is not. Consolidating across domains would
  couple the two ban UIs; flagged as a plausible future cleanup but not
  proposed (behavior-neutral but crosses domain boundaries).
- **`familyBucketSpend` (`bucket-spend.ts`)** — the two SQL sums on the
  key-creation path are a deliberate feature (seeding a newly added limit from
  already-spent telemetry). Not an optimization target.
- **InferHub `ensureStatus`'s `config === undefined ? {} : …` (routes.ts:168-170)**
  — odd but harmless; `config` is always defined inside the factory. Low value;
  not proposed.
- **`data-management` double scan in `usage()`** — deliberately distinct totals;
  a single-pass merge would mix the stale bound with the total scan and was not
  proposed because the gain is tiny and the semantics are subtle.
- **`deleteExpiredSessions` reuse of `ConsoleSessionStore`** — the store has no
  batch-delete; adding one would be new plumbing for no behavioral gain.

## Validation

Audit only. No code ran; the evidence is static reading. Reported findings are
mechanical (identical bodies/exact duplicates) or structural (same sequence in
three handlers, same gate in four endpoints) and are reproducible from the lines
cited. No new tests were written.

## Open questions

1. F2: should the shared gate helper live in `src/transport/drain-endpoint.ts`
   (its current home) or in `src/console/shared/`? The three console-side
   factories currently import from `src/transport/drain-endpoint`, so keeping it
   there is the least-churn owner; the task-trigger inline copy in `src/boot/app.ts`
   is the one site that would need to import it from transport. Confirm the owner
   before implementing.
2. F3: `regenerateKey` invalidates only the single key (no children). If a share
   template could ever be regenerated — currently impossible, the route rejects
   `keyMode !== "personal"` — the helper would need a children arm. The current
   scope (personal keys only) makes the single-key path correct; keep it.
3. F4: `num` is also used by `pricePointsToTiers` via internal calls; confirm no
   hidden export consumers outside `normalize.ts` before removing it (grep shows
   only internal use).

## Execution status

**Implementasi kampaian (2026-11-09).** Verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-45) — ✅.** Dead branch in `listKeys` replaced with
  `visible.map(sanitizeApiKeyResponse)`; stale comment deleted.
- **F2 (M-46) — ✅.** `requireLoopbackAdmin` extracted into
  `src/transport/drain-endpoint.ts`; drain, backup-export, account-reset
  factories and the inline task trigger in `app.ts` all call it. Codes
  (403/401), ordering (peer→token), and per-surface message text preserved.
- **F3 (M-47) — ✅.** `invalidateFamilyCaches`/`purgeFamilyAdmission` extracted;
  used by updateKey/deleteKey/regenerateKey. updateKey's tightened-limit
  conditional preserved.
- **F4 (M-48) — ✅.** Duplicate `num`/`numOrNull` collapsed to one `numOrNull`;
  all internal call sites updated.
- **F5 (M-49) — ✅.** `injectorFor` removed; canonical `INJECTORS` used
  directly with an `undefined` guard at the three sites; unused `ToolInjector`
  import dropped.
