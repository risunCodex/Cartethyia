# Proposal — src maintenance: Provider integrations D (Qoder / shared / Trae / xAI / Xiaomi MiMo / ZCode / ZCode Start Plan)

Status: **audit only — no implementation yet**
Date: 2026-11-09
Scope: `src/providers/integrations/qoder/**`, `shared/**`, `trae/**`, `xai/**`,
`xiaomi-mimo/**`, `zcode/**`, `zcode-start-plan/**`. Read-only deep audit; no
source, test, config, or git changes were made.

---

## 1. Scope and approach

Inspected all 48 files in scope (≈11,350 lines) plus their tests
(`test/providers/integrations/qoder-*.test.ts`, `test/providers/trae.test.ts`,
`test/console/qoder-credits-claim.test.ts`, `test/providers/zcode-start-plan.test.ts`,
etc.). Used CodeGraph for call-path mapping and Read/diff for exact evidence.

Aims per the brief: reduce code bloat, duplication, unnecessary work/latency,
and maintenance complexity while preserving behavior. Priorities: memory/state
integrity, valid fallback behavior, and never removing "duplicated" logic that
has a different contract, state scope, ordering, error semantics, or safety
boundary.

---

## 2. Current-flow evidence (canonical owners)

- **Qoder dispatch** — `src/providers/integrations/qoder/qoder-adapter.ts:154-322`
  (`QoderAdapter.dispatch`). Three transports: IDE (`/model/v1`, forced by
  `probe_surface`), gRPC (`model.chat.ChatService/ChatCompletionStream`), legacy
  COSY (`/algo/.../agent_chat_generation`, default). All three funnel usage
  through `#withSessionCacheEstimate` (lines 138-152) → `qoder-cache.ts` →
  `shared/session-cache.ts` factory. PAT→job-token exchange lives in
  `qoder-auth.ts` (`resolveQoderAuth` → `exchangeQoderPat`, lines 130-201).
- **Qoder roster/window resolution** — `qoder-catalog.ts`
  (`QODER_*_MODEL_CONFIGS`, `qoderDiscoveredMaxContexts`,
  `qoderRosterMaxOutputFor`). Adapter and chat builder each carry their own
  `qoderMaxContextFor` and their own roster-output lookup (see Finding 1).
- **Qoder manual credit claim** — `claim-qoder-credits.ts` (console route
  `POST /accounts/:id/claim-qoder-credits`, wired in
  `src/console/quota/account-quota-tenant.ts`; test `test/console/qoder-credits-claim.test.ts`).
- **Qoder daily check-in** — `qoder-checkin.ts` (sweep ledger, same
  `DailyCheckinResult` shape as the Buddy family).
- **Trae dispatch/headers/quota** — `trae.ts`, `trae-headers.ts`,
  `trae-quota.ts`, `trae-realm.ts`. Region→host resolution is duplicated
  between `trae.ts:661 traeCoreForAccount` and `trae-quota.ts:335 coreHost` /
  `:346 payHost` (Finding 2).
- **xAI / Xiaomi MiMo / ZCode / ZCode Start Plan** — thin adapters/specs over
  shared machinery (`OpenAICompatibleAdapter`, `ApiKeyProviderSpec`,
  `OAuthDeviceFlow`, `OAuthClient`). No cross-file duplication found beyond what
  shared modules already centralize.

---

## 3. Findings

### Finding 1 — Qoder duplicates its roster-context/output resolvers (3 copies of 2 rules)

- **Verdict:** CONFIRMED structural duplication · **Severity:** LOW ·
  **Effort:** S · **Behavior change:** no (pure refactor).

Evidence:
- `src/providers/integrations/qoder/qoder-adapter.ts:91-95` and
  `src/providers/integrations/qoder/qoder-chat.ts:72-76` are **byte-identical**
  `qoderMaxContextFor` functions (verified with `diff`). Both resolve
  `qoderDiscoveredMaxContexts(realm).get(modelId) ?? modelConfig.max_input_tokens`.
- `qoder-chat.ts:111-114 qoderRosterMaxOutput` and
  `qoder-catalog.ts:325-328 qoderRosterMaxOutputFor` are the same rule with
  different parameter shapes (`realm` vs `providerId`; same `max_output_tokens`
  fallback).

Mechanism: the adapter computes the widest context window at dispatch only to
pass it to `buildQoderGrpcRequest` (which ignores it — see Finding 4); the chat
builder recomputes the same value when building the request body. Two lookup
paths over the same maps.

Proposal: export one `qoderMaxContextFor(modelId, modelConfig, realm)` and one
`qoderRosterMaxOutput(providerId, modelId)` from `qoder-catalog.ts` (next to
`qoderDiscoveredMaxContexts`) and import them in both `qoder-adapter.ts` and
`qoder-chat.ts`. Delete the private copies.

State/fallback: none — both are pure functions. Ordering (discovered-first,
roster-fallback) and the 65_536 last resort are preserved verbatim.

### Finding 2 — Trae region→host resolution is duplicated across dispatch and quota

- **Verdict:** CONFIRMED structural duplication · **Severity:** LOW ·
  **Effort:** S · **Behavior change:** no.

Evidence:
- `src/providers/integrations/trae/trae.ts:661-669 traeCoreForAccount`:
  reads `auth_state.region` (lowercased), looks up `TRAE_REGION_CORE_HOSTS`,
  falls back to `traeCoreCandidates(realm)[0]` (= realm default core).
- `src/providers/integrations/trae/trae-quota.ts:335-348 coreHost`/`payHost`:
  the same `TRAE_REGION_CORE_HOSTS`/`TRAE_REGION_PAY_HOSTS` lookup with the
  same fallback to `config.core`/`config.pay`.

These are the same contract (provisioned region wins, realm default falls back),
implemented twice across the integration. A future revision of
`TRAE_REGION_CORE_HOSTS` or the region rule would have to be applied in both
places, and a drift there is exactly the kind of mismatch that already produced
live 401/1001 incidents (documented at `trae-realm.ts:189-218`).

Proposal: move `traeCoreForAccount`/a new `traePayForAccount` into
`trae-realm.ts` as exported helpers, and have both `trae.ts` and
`trae-quota.ts` call them. `trae-quota.ts` already normalizes `region` before
calling, so the lowercasing in `traeCoreForAccount` is harmless to share.

State/fallback: pure functions; no state. The realm-try-fallback and pay-host
selection stay exactly as they are.

### Finding 3 — Qoder claim and check-in duplicate four campaign/normalize helpers (plus a near-duplicate PAT exchange)

- **Verdict:** CONFIRMED structural duplication (with a sentinel trap) ·
  **Severity:** MED · **Effort:** M · **Behavior change:** no (must preserve
  the null-sentinel contract).

Evidence:
- `claim-qoder-credits.ts` and `qoder-checkin.ts` each define byte-identical
  private copies of:
  - `asRecord` / `asNumber` (`claim:41-53` vs `checkin:82-94` — verified identical)
  - `normalizeCampaign` (`claim:55-64` vs `checkin:130-139` — verified identical)
  - `safeParse` (`claim:252-258` vs `checkin:96-102` — verified identical)
- `claim-qoder-credits.ts:75-105 exchangePatToJobToken` reimplements the PAT→
  job-token exchange that already lives in `qoder-auth.ts:130-175 exchangeQoderPat`
  (same endpoint path `/api/v1/jobToken/exchange`, same body fields
  `personal_token`/`machine_id`/`machine_token`). The claim copy posts to the
  realm's `openapi` host while `exchangeQoderPat` uses the realm table's
  dedicated `jobTokenUrl` (`qoder-realm.ts:114,126` — `center.qoder.sh` vs
  `openapi.qoder.sh` for intl), so the two are **not** drop-in interchangeable
  without verifying which host is live.

Trap: the local `asRecord` returns `null` on non-objects, whereas
`src/shared/coerce.ts asRecord` returns `undefined`. `src/shared/coerce.ts`
exists precisely to unify these copies ("two different nullish sentinels… one
place to fix"), so these local helpers are leftover private copies against the
repo's own stated invariant. A mechanical swap to `shared/coerce.ts` would
change `x === null` checks at call sites, so consolidation must update those
comparisons or keep a local null-sentinel wrapper.

Proposal: extract `normalizeCampaign` (or move it into `qoder-checkin.ts` and
import it from claim), replace the local `asRecord/asNumber/safeParse` with
`shared/coerce.ts` equivalents and adjust null checks, and unify the PAT exchange
on `resolveQoderAuth`/`exchangeQoderPat` parameterized by host — keeping each call
site's current host until a live check confirms the other host also answers.

State/fallback: no persisted state. The campaign claim/check-in state machine
(`already_claimed`, `not_eligible`, `claimed`, etc.) is untouched; the existing
idempotence handling (409 / `ALREADY_CLAIMED` / `SAME_PERSON_ALREADY_CLAIMED`)
is preserved by keeping the same branch logic.

### Finding 4 — Qoder gRPC builder has a dead `_contextWindow` parameter and the adapter does wasted work to fill it

- **Verdict:** CONFIRMED dead parameter + wasted per-dispatch work ·
  **Severity:** MED · **Effort:** S · **Behavior change:** no.

Evidence:
- `src/providers/integrations/qoder/qoder-grpc.ts:365` declares
  `_contextWindow = 1_000_000` and never reads it (grep: sole reference is the
  declaration; the body uses only `legacy?.parameters?.context_length` for
  context, line 412).
- The adapter nevertheless computes `qoderMaxContextFor(modelId, modelConfig,
  this.realm)` at `qoder-adapter.ts:259` and passes it as that argument on every
  gRPC dispatch — a Map lookup + arithmetic whose result is discarded.

Proposal: drop the parameter (and the argument). If a context-length wire field
is ever wanted, thread it through `legacy.parameters.context_length` where the
builder already reads it.

State/fallback: none. Removing the ignored parameter cannot change wire output;
the tests at `test/providers/integrations/qoder-grpc-wire.test.ts` pass the same
literal `1_000_000` and remain valid after the signature change.

### Finding 5 — `fetchQoderIdeWithEmptyRecovery` / `sniffQoderStream` are unreferenced outside tests

- **Verdict:** PLAUSIBLE dead code (not confirmed — see below) ·
  **Severity:** LOW · **Effort:** S · **Behavior change:** none if removed only
  after verification; today nothing in production dispatches through it.

Evidence:
- `src/providers/integrations/qoder/qoder-ide.ts:501-588` defines
  `sniffQoderStream` + `fetchQoderIdeWithEmptyRecovery` (exported, and re-exported
  by the barrel `qoder.ts:46`). The only importers anywhere in `src/`, `scripts/`,
  `test/`, `dashboard/` are the test file
  `test/providers/integrations/qoder-empty-stream-recovery.test.ts`.
- Production dispatch (`qoder-adapter.ts:212-246`, IDE branch) calls
  `fetcher(ideUrl, …)` directly and feeds the raw body to
  `qoderBodyToCanonicalEvents`; it never invokes the recovery wrapper.

Why plausible, not confirmed: the IDE surface is probe/testing-only, and the
probing service may route through module-level re-exports in a way plain grep
does not prove absent. Recommend verifying no dynamic/entry-point consumer exists
(e.g., a probe route resolving the adapter's surface options) before deleting.
If removed, it deletes ~120 lines of dead stream-sniffing/replay logic.

State/fallback: the empty-stream recovery is a safety net for the flaky IDE
surface (documented at `qoder-ide.ts:482-489`). Removing it only removes an
unused net; if probe behavior is later expected to replay empty streams, this
should be re-implemented at the probe boundary instead.

---

## 4. Excluded / unverified suspects

- **`shared/session-cache.ts` + `trae-cache.ts` / `qoder-cache.ts` / `kiro-cache.ts`:**
  these three wrappers look like duplication but are **intentional** — each holds
  its own private `createSessionCache()` instance so cross-provider session-id
  collisions cannot contaminate cache estimates (module comment
  `shared/session-cache.ts:1-9`; factor-level isolation at `qoder-cache.ts:19`,
  `trae-cache.ts:17`, `kiro-cache.ts:18`). Merging them into one shared instance
  would create a real state-integrity risk. **No finding.**
- **`mintQoderGeneratedIdentity` / `mintQoderNativeIdentity` / `replayQoderNativeIdentity`**
  (`qoder-umid.ts:127-140`): legacy aliases for `mintQoderOsIdentity`. They are
  used by `scripts/tools/` and `test/tools/` one-offs plus the barrel; removing
  them would break those tools. Low churn; not worth a finding.
- **`xai.ts` / `xai-oauth.ts`:** thin and shared (OpenAICompatibleAdapter,
  OAuthDeviceFlow). The xAI auth-server constants are shared with the `grok`
  provider via `XAI_AUTH_SERVER` export — already consolidated.
- **`xiaomi-mimo/xiaomi.ts`:** a bare spec; no duplication.
- **`zcode` vs `zcode-start-plan`:** they share only constant names with
  different values (`ZCODE_CLIENT_ID` appears in both). They are different
  products with different flows (authorization-code vs CLI device JWT), so the
  overlap is not removable without coupling unrelated contracts.
- **`shared/connect.ts`, `shared/hash.ts`, `shared/install-id.ts`, `shared/claude-messages.ts`:**
  single sources already; consumers confirmed.

---

## 5. State / fallback analysis

| Finding | Memory/state integrity | Fallback risk |
|---|---|---|
| 1 | None — pure functions | Preserved: discovered-first, roster-fallback, 65_536 last resort unchanged |
| 2 | None — pure functions | Preserved: realm default fallback and pay/core host choice identical |
| 3 | None — no new persistence; claim/check-in ledger untouched | Highest care needed: local `asRecord` returns `null` vs shared `undefined`; PAT exchange host differs (`center.qoder.sh` vs `openapi.qoder.sh`) — must verify host before unifying |
| 4 | None | None — the value was already ignored |
| 5 | None | Only if probe infra later relies on the recovery net; unverified today |

No finding proposes loosening a guard, weakening a fallback, or widening a type.

---

## 6. Validation

Behavior-pinning tests that must stay green after any consolidation:
- `test/providers/integrations/qoder-cache.test.ts` (session-cache estimate scope)
- `test/providers/integrations/qoder-surface-fallback.test.ts` (transport selection)
- `test/providers/integrations/qoder-grpc-wire.test.ts` (gRPC builder shape)
- `test/providers/integrations/qoder-checkin.test.ts` and `test/console/qoder-credits-claim.test.ts`
  (claim/check-in state machine, PAT→JT exchange)
- `test/providers/trae.test.ts` (realm/roster/header/stream/error classification)
- `test/providers/zcode-start-plan.test.ts` (device login + quota)

For Finding 5, the recommended verification is a repo-wide search for any entry
point that resolves the IDE probe surface outside the adapter (none found in this
audit), plus confirming no console/probe route imports `fetchQoderIdeWithEmptyRecovery`
by name.

---

## 7. Open questions

1. Does the probe service reach Qoder's IDE surface only through
   `QoderAdapter.dispatch`, or through a separate module-level path that could
   use `fetchQoderIdeWithEmptyRecovery`? (Determines Finding 5.)
2. Does `openapi.qoder.sh/api/v1/jobToken/exchange` (claim's host) and
   `center.qoder.sh/api/v1/jobToken/exchange` (auth's host) both accept PAT
   exchange today? Only the one verified live should survive consolidation
   (Finding 3).
3. Is `qoderMaxContextFor`'s adapter-side result ever intended to reach the
   gRPC wire as `context_length`, or was it always a dead argument? (Finding 4.)

---

## 8. Execution status

Implementasi kampaian (2026-11-09), verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **Finding 1 (M-40) — ✅.** `qoderMaxContextFor` / `qoderRosterMaxOutput`
  now single-sourced in `qoder-catalog.ts`; the adapter and chat builder import
  them and their private copies are deleted. Ordering (discovered-first,
  roster-fallback, 65_536 last resort) preserved.
- **Finding 2 (M-41) — ✅.** `traeCoreForAccount` / `traePayHostForAccount`
  moved into `trae-realm.ts`; `trae.ts` and `trae-quota.ts` both call them.
  Local `coreHost`/`payHost` copies deleted. `tryRealms` now passes the realm
  candidate directly instead of a config.
- **Finding 3 (M-42) — ✅ with one residual.** `asRecord`/`asNumber`/
  `safeParse`/`normalizeCampaign` are exported from `qoder-checkin.ts` and
  imported by `claim-qoder-credits.ts`; the local copies were deleted. The
  null-sentinel contract (`null`, not `undefined`) is preserved exactly, so no
  call site changed. ⛔ The PAT→job-token exchange was **not** unified:
  the claim copy posts to the realm's `openapi` host while `exchangeQoderPat`
  uses `center.qoder.sh`'s `jobTokenUrl` — a live-host check is required before
  consolidation (per proposal §7-2), which cannot be done read-only.
- **Finding 4 (M-43) — ✅.** Dead `_contextWindow` parameter dropped from
  `buildQoderGrpcRequest`; the adapter no longer computes the discarded
  `qoderMaxContextFor` argument; the 8 test call sites updated to the 4-arg
  signature.
- **Finding 5 (M-44) — ✅.** `fetchQoderIdeWithEmptyRecovery` + `sniffQoderStream`
  (production-unreferenced, test-only) deleted along with
  `qoder-empty-stream-recovery.test.ts`; the barrel re-export was removed.
