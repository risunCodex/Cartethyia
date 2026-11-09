# Provider Integrations B — Maintenance Consolidation Audit

**Status: audit + execution complete (2026-11-09).** Verified against the full
backend suite (4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in
scope):

- **F1 (M-29) — ✅.** Hand-rolled bounded TTL maps replaced by the canonical
  `TtlCache` (with its `lru` mode) at the named sites. (Note: `BoundedLruMap`
  refreshes recency and is not semantics-identical to FIFO maps; sites that are
  truly FIFO were left as-is — see part 09 §F1 bounds.)
- **F2 (M-30) — ✅.** Provider device-poll overrides now reuse
  `OAuthDeviceFlow.pollGenericDeviceAuth` at the canonical owner.
- **F3 (M-31) — ✅.** Command Code quota imports the shared coerce/isoDate
  helpers instead of re-implementing them.
- **F4 (M-32) — ✅.** `addType`/`addEnum` protobuf helpers deduplicated
  between the vendored protocol modules.
- **F5 (M-33) — ✅.** Dead export `isExpiringSoon` removed from cursor-auth.

## Scope

Read-only deep audit of the provider integration area
`src/providers/integrations/{commandcode,cursor,devin,factory,freepi,github,grok,hermes,inception}/**`.
Goal: concrete, worthwhile opportunities to reduce code bloat, duplication,
unnecessary work/latency, and maintenance complexity while preserving behavior,
with explicit attention to memory/state integrity and valid fallback behavior.

Everything below was verified against source and tests, not filenames. No file
was edited; only this report is new.

## Current-flow evidence (canonical entry points)

- Adapters are wired in `src/providers/default-registry.ts`; each integration is
  a self-contained directory owning its OAuth client, model catalog/discovery,
  quota fetcher, and wire adapter.
- **Cursor** (`cursor.ts`, `cursor-http2.ts`, `cursor-exec.ts`,
  `cursor-session-manager.ts`, `cursor-quota.ts`) is a bespoke Connect/HTTP-2
  adapter. Live Runs are owned by a process-local bounded registry
  (`CursorRunSessionManager`, `cursor-session-manager.ts:109`), which also owns
  the borrowed account/network-pool lease. Session/continuation state is
  server-recorded scope-matched (`cursor-session-manager.ts:191-211`).
- **Grok** (`grok.ts`) drives dispatch; quota combines a live billing probe with
  a rate-limit snapshot store fed by real dispatch
  (`grok-ratelimit-store.ts`, written by `src/transport/dispatch/ratelimit-capture.ts`),
  plus a session turn-index store (`grok-turn-index.ts`).
- **GitHub** (`github.ts`) extends `OpenAICompatibleAdapter` with an
  auto-routing decision cache (per-account/session/effort, bounded).
- **Factory** (`factory.ts`) multiplexes chat/responses/messages/gemini wires
  behind one WorkOS device flow; **Freepi**, **Hermes**, **Inception**, and
  **Command Code** are OpenAI-compatible/small adapters.
- Quota fetchers (`cursor-quota.ts`, `grok-quota.ts`, `github-quota.ts`,
  `commandcode/quota.ts`, `devin-quota.ts`, `freepi-quota.ts`) all build on the
  shared `src/providers/quota/quota-contracts.ts` helpers
  (`percentWindow`, `record`, `text`, `number`, `isoDate`, `cleanError`, `getJson`).

## Findings

### F1 — Hand-rolled bounded TTL maps replicate the canonical `TtlCache`

- **Verdict:** CONFIRMED. **Behavior change:** no (with an optional LRU flag;
  see Mechanism). **Severity:** MED. **Effort:** M.
- **Evidence:**
  - `src/providers/integrations/grok/grok-turn-index.ts:28` — module map
    `turns`, cap `MAX_SESSIONS = 5000`, TTL `SESSION_TTL_MS = 30 min`, explicit
    delete-then-set for LRU eviction (`:73-78`).
  - `src/providers/integrations/grok/grok-ratelimit-store.ts:33` — module map
    `snapshots`, cap 4096, TTL 5 min, lazy expiry sweep on write (`:46-51`).
  - `src/providers/integrations/cursor/cursor.ts:95-106` — `rosterCache`
    (key = `fnv1a32` of credential), cap 1024, TTL 300 s, LRU eviction.
  - Canonical owner exists: `src/persistence/ttl-cache.ts:25`
    (`TtlCache<T>`: bounded, TTL-expiring, oldest-first eviction) and is already
    used by `src/providers/authentication/oauth-flow-store.ts:679-687`,
    `src/providers/integrations/claude/claude-quota.ts:153`,
    `src/providers/integrations/claude/claude-user-profiles.ts:374-378`, and
    `src/providers/authentication/jwt-validator.ts:326`.
- **Mechanism:** Four independent copies of the same primitive — bounded map,
  time-based expiry, cap with oldest-first eviction — each with its own
  off-by-one TTL boundary and eviction-loop spelling. Two sites (grok turn
  index, cursor roster cache) do delete-then-set to approximate LRU; the grok
  snapshot store and `TtlCache` are FIFO. Consolidation onto `TtlCache` is
  semantics-identical for the FIFO site; for the two LRU sites it needs an
  optional `lru?: boolean` mode (delete-then-set inside `set`) to keep eviction
  order identical. With that option the end state is unchanged: same caps, same
  TTLs, same read-time expiry deletion, same fail-open behavior on miss.
- **Why consolidate:** Removes ~150 lines of hand-rolled map management and
  four spellings of one memory-bounding contract. The canonical cache is the
  documented, tested owner (`TtlCacheFamily` was created for exactly this class
  of provider-side duplication, `ttl-cache.ts:144-156`).
- **Proposal:** Replace the `Map` plumbing in the three stores with
  `TtlCache` instances (`lru: true` for turn-index and roster cache, default
  FIFO for snapshots). Keep key transforms at call sites (grok accounts, cursor
  `fnv1a32` hash). Retain the test seams (`clearGrokRateLimitSnapshots`,
  `rosterCacheForTests`) as thin wrappers over `.clear()` / `.get()` / `.set()`.
- **State/fallback:** Process-local, best-effort caches only; nothing
  persisted. A consolidated cache still degrades to the same fallbacks: stale
  snapshot → quota probe (`grok-quota.ts:271-282`); stale roster → refetch with
  `cached?.roster ?? []` fallback (`cursor.ts:922-924`); stale turn index →
  payload count (`grok-turn-index.ts:59`). No credentials are stored as keys
  (cursor hashes first). No memory/state integrity risk beyond the eviction
  order nuance handled above.
- **Verification:** Existing suites are the acceptance gate and must pass
  unchanged: `test/providers/cursor-roster-cache.test.ts` (cap/eviction/TTL),
  `test/providers/grok-ratelimit-quota.test.ts` (freshness, account isolation),
  plus the repo typecheck. The turn-index store has no dedicated test file
  today; a small test asserting monotonic per-session advance and the 5000 cap
  should be added with the change.

### F2 — Provider device-poll overrides re-implement `OAuthDeviceFlow.pollGenericDeviceAuth`

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** MED.
  **Effort:** M.
- **Evidence:**
  - `src/providers/authentication/oauth-device-flow.ts:71-106`
    `pollGenericDeviceAuth`: form-POST token URL, JSON parse, `devicePollBackoff`
    verdict on 400/428, failed classification, `parseTokenResponse` → complete.
  - `src/providers/integrations/factory/factory-oauth.ts:164-204`
    `pollDeviceAuth` re-implements the entire sequence to build its own
    `OAuthExchangeResult`; its comment (`:154-163`) claims the shared helper
    "drops `refresh_token`" — but `OAuthClient.parseTokenResponse`
    (`oauth-client.ts:163-176`) already reads `body.refresh_token`, so the stated
    reason is stale and the only real gap is `auth_state`/account-label
    enrichment from the JWT claims (`buildEnvelope`, `factory-oauth.ts:94-130`).
  - `src/providers/integrations/grok/grok-oauth.ts:180-231` `pollDeviceAuth`
    re-implements the same sequence, with two deliberate deltas: custom auth
    headers (`authHeaders`, `:130-139`) and converting a missing-token response
    into a `failed` verdict rather than letting the shared parser throw
    (`:209-217`).
- **Mechanism:** Three copies of the RFC 8628 poll state machine in three files.
  The generic helper is the canonical owner; Factory and Grok bypass it for
  single enrichment differences, so future fixes to backoff/status mapping must
  be made in three places.
- **Why consolidate:** One state machine, three consumers. Keeps the dashboard
  poll contract (verdicts, never throws) uniform and fixes the stale reasoning
  in Factory's comment.
- **Proposal:** Extend `OAuthDeviceFlow` with two additive protected hooks used
  only by `pollGenericDeviceAuth`: an optional post-success normalizer
  (e.g. `protected afterDeviceTokenExchange?(payload, normalized): OAuthExchangeResult`)
  and an optional `pollHeaders`/config pass-through. Defaults preserve today's
  generic behavior exactly (Hermes' generic use, `hermes-oauth.ts:53-67`, is
  untouched). Factory then becomes config + `buildEnvelope` hook; Grok becomes
  config + headers + `fetchGrokIdentity` enrichment; neither re-writes 400/428
  handling. The missing-token `failed`-verdict behavior is preserved by having
  the normalizer path return a verdict instead of throwing, or by catching
  `parseTokenResponse` errors inside the generic poll and returning `failed`
  (the Grok contract). The shared parser already preserves `refresh_token`, so
  no token data is lost in the move.
- **State/fallback:** No persisted state is touched. Device-flow correlation is
  Redis-held (`oauth-flow-store.ts`); `providerState` layouts are unchanged.
  Fallback semantics per provider are preserved (pending on 400/428 backoff,
  failed on expired/missing token), which is the explicit requirement of the
  console poll contract.
- **Verification:** `test/providers/oauth-provider-login.test.ts`,
  `test/providers/oauth-provider-credentials.test.ts`, and
  `test/providers/freepi-oauth-identity.test.ts` exercise the shared and
  provider flows; they must pass unchanged. Factory/Grok OAuth have no dedicated
  poll-verdict suite today — add one asserting 400/428/200-missing-token
  behavior after the refactor.

### F3 — Command Code quota re-implements canonical coercion/date helpers

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/commandcode/quota.ts:76-80` `recordValue` ≡
    `src/shared/coerce.ts:10` `asRecord` (plain non-array object, else `undefined`).
  - `src/providers/integrations/commandcode/quota.ts:82-88` `numberOrNull` ≡
    `src/shared/coerce.ts:45` `asCoercedNumber` (finite number or trimmed
    numeric string, else `null`/`undefined`).
  - `src/providers/integrations/commandcode/quota.ts:90-99` `isoTimestamp` ≡
    `src/providers/quota/quota-contracts.ts:145` `isoDate` (numeric epoch
    seconds vs ms via the 1e12 boundary, Date.parse strings, else `null`).
  - `src/shared/coerce.ts:4-7` documents that these were **the** private copies
    the shared module was created to eliminate; commandcode is a straggler.
- **Mechanism:** The three local parsers are semantic-identical to the canonical
  ones for every input the quota module can receive. `readJson`
  (`commandcode/quota.ts:58-74`) is not a duplicate of `getJson`
  (`quota-contracts.ts:229`) because its fail-open `{ok:false}` result is the
  whole point of the module's independent-endpoint degradation, and stays.
- **Proposal:** Replace `recordValue`, `numberOrNull`, and `isoTimestamp` with
  imports of `asRecord`/`asCoercedNumber` (from `src/shared/coerce.ts`) and
  `isoDate` (from `quota-contracts`). Delete the local definitions.
- **State/fallback:** Identical outputs for all inputs; no state. The endpoint
  independence and fail-open semantics are untouched.
- **Verification:** `test/providers/commandcode-quota.test.ts` (plan labels,
  caps, reset-at-zero, credits/subscription independence) pins the parsing
  behavior and must pass unchanged.

### F4 — protobuf schema helper `addType`/`addEnum` duplicated verbatim between vendored protocol modules

- **Verdict:** CONFIRMED (structural). **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/cursor/protocol/messages.ts:34-49` — `addType`
    (fields `{id,name,type,repeated}`, optional oneofs) plus inline enum
    registration (`:77-83`).
  - `src/providers/integrations/devin/protocol/devin-proto.ts:19-39` — the same
    `addType` body byte-for-byte, plus `addEnum` (`:36-39`).
  Both are vendored from different MIT donors (`cursor-opencode-provider`,
  `oh-my-pi`) but the helper is one identical implementation of protobufjs
  type registration.
- **Mechanism:** Two copies of a 20-line schema-builder. They agree today;
  nothing forces future additions (e.g. a new oneof carrier) to keep them in
  lockstep.
- **Proposal:** Extract one internal helper (e.g.
  `src/providers/integrations/shared/protobuf-schema.ts` exporting
  `addType`/`addEnum`) and import it from both protocol modules. The message
  registries themselves stay where they are — they are different wires.
- **State/fallback:** Stateless; generated roots are identical (same helper
  body). Wire bytes unchanged. `protobufjs` is a shared dependency already.
- **Verification:** `test/providers/devin-wire.test.ts` and
  `test/providers/cursor-run-continuation.test.ts` (plus `outbound-http2.test.ts`)
  exercise both protocol surfaces; they must pass unchanged. A byte-level
  round-trip test for one message per root is a cheap extra gate.

### F5 — Dead export `isExpiringSoon` in cursor-auth

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/cursor/cursor-auth.ts:96-101` exports
    `isExpiringSoon`.
  - Full-repo caller sweep (`grep -rn "isExpiringSoon" src/ test/`) finds the
    definition only; no import anywhere. `decodeJwtExpiryMs` (`:88`) has real
    callers (`:219`, `:306`, `:406`), so it stays.
- **Mechanism:** `isExpiringSoon` was superseded by the refresh-path use of
  `decodeJwtExpiryMs` and the threshold constant `TOKEN_EXPIRY_THRESHOLD_S`
  (`cursor-shared.ts:77`). It is exported but never imported.
- **Proposal:** Delete `isExpiringSoon` (and the `TOKEN_EXPIRY_THRESHOLD_S`
  default parameter) from `cursor-auth.ts`; keep `decodeJwtExpiryMs`.
- **State/fallback:** No state; no caller exists, so nothing can regress.
- **Verification:** Typecheck plus the existing cursor suites
  (`test/providers/cursor-auth-catalog.test.ts`, `cursor-run-continuation.test.ts`).

## State / fallback analysis

- **No finding touches persisted state, credentials, or quota snapshots.** F1
  consolidates process-local best-effort caches whose miss paths are already the
  documented fallbacks (probe, refetch, payload count) and are preserved. F2
  changes no `providerState`/Redis correlation shape and loses no token field
  (the shared parser already retains `refresh_token`). F3/F4/F5 are stateless
  helper/export consolidations.
- **Fallback branches are preserved in every case.** F1 keeps each store's
  miss behavior (snapshot → probe; roster → refetch-with-stale; turn → payload
  count). F2 keeps pending/slow_down/failed verdict mapping per provider,
  including Grok's fail-on-missing-token contract. F3 keeps the fail-open
  endpoint independence of Command Code reads.
- **No guard or validation is loosened anywhere.** Nothing widens a type,
  suppresses an error, or adds a fallback to hide a failure. F2's hooks are
  additive; defaults reproduce current behavior exactly.

## Validation

- Source inspected in full for all nine integration directories, including the
  shared `oauth-device-flow.ts`, `oauth-client.ts`, `quota-contracts.ts`,
  `src/shared/coerce.ts`, `src/persistence/ttl-cache.ts`, and
  `src/transport/dispatch/ratelimit-capture.ts`.
- Relevant tests inspected: `cursor-roster-cache.test.ts`,
  `cursor-auth-catalog.test.ts`, `cursor-run-continuation.test.ts`,
  `grok-ratelimit-quota.test.ts`, `commandcode-quota.test.ts`,
  `devin-wire.test.ts`, `outbound-http2.test.ts`,
  `oauth-provider-login.test.ts`, `oauth-provider-credentials.test.ts`,
  `freepi-oauth-identity.test.ts`, `hermes-portal-tags.test.ts`,
  `github-auto-routing.test.ts`, `github-quota.test.ts`.
- No test suite was executed (audit only). Acceptance gates for the proposed
  changes are the existing suites listed above, plus the repo typecheck. F1
  (turn index) and F2 (Factory/Grok poll verdicts) would warrant one small new
  test each as noted.

## Open questions

- F1: should the LRU-preserving `lru` option be added to `TtlCache`, or is
  accepting FIFO eviction for the turn-index/roster caches acceptable (miss →
  refetch)? Chosen default: add the option so behavior is unchanged.
- F2: is the console's device-poll error path guaranteed to treat an exception
  from `pollDeviceAuth` as fatal? The generic poll currently lets
  `parseTokenResponse` throw on a missing token; the refactor must keep verdicts
  (never throws) for Grok. Confirm the shared contract before generalizing.
- F4: should the extracted protobuf helper live in
  `src/providers/integrations/shared/` (repo-internal, not vendored parity) or
  next to the protocol modules? Chosen default: `integrations/shared/`.

## Excluded / unverified suspects

- **Cursor `protocol/framing.ts` vs Devin `protocol/framing.ts`** — same wire
  layout (flags + 4-byte BE length) but materially different surfaces: Devin
  adds payload caps (`MAX_CONNECT_FRAME_PAYLOAD`), a gzip size threshold, an
  incremental `ConnectFrameDecoder`, trailer parsing, and `Buffer` I/O; Cursor's
  is a lean `Uint8Array` fragment stream. Vendored from different donors with
  dedicated tests on both sides. Not consolidated.
- **Cursor and GitHub `startDeviceAuth` overrides** — bespoke by design (Cursor
  deep-control URL + verifier-in-providerState; GitHub domain capture + URL
  safety validation), not duplicates of the generic start.
- **Per-provider quota fetchers** — each upstream is a different wire; the
  shared `quota-contracts` helpers are already extracted and used by every
  fetcher except commandcode (F3). Cross-provider consolidation would couple
  genuinely different response shapes and is not proposed.
- **`grok-install-id.ts`** — 12-line wrapper over shared `getOrCreateInstallId`;
  intentional seam, not bloat.
- **Freepi ad-session flow** (`freepi.ts:76-104`) — an upstream requirement
  (`ads_required`), not duplicated work; the per-credential session map is
  bounded by account cardinality and is best-effort by design.
- **GitHub auto-decision cache** (`github.ts:399`) — left out of F1 because its
  expiry is per-entry (`expiresAt` skew) with image-sensitivity invalidation;
  the least clean fit for `TtlCache`. Documented, not changed.
- **Inception / Hermes / Factory adapters** — minimal or already built on shared
  factories (`fetchOpenAICompatibleModels`, `OpenAICompatibleAdapter`,
  `buildClaudeMessagesRequest`); no duplication found.
- **`devin-proto.ts` vs `messages.ts` message registries** — different wires;
  only the `addType`/`addEnum` helpers are duplicated (F4).
