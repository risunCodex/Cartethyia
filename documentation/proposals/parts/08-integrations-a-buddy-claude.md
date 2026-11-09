# 08 — Integrations A: Buddy + Claude — deep audit findings

Read-only audit of exactly two provider integration families:
`src/providers/integrations/buddy/**` and `src/providers/integrations/claude/**`.

Scope: header builders, message identity prompts, tool-round handling, error
classification, quota/refresh paths. No files were edited. Every finding cites
the precise mechanism and a bounded, behavior-preserving change.

---

## Finding 1 — Buddy billing-facade identity envelope duplicated across chat, quota, and checkin

**Verdict: CONSOLIDATE.** Three independent builders reproduce the same Tencent
billing-facade identity header block with only the variant (`IDE`/`CLI`)
differing:

- `src/providers/integrations/buddy/codebuddy/shared.ts:57-87` and
  `:90-124` — `codebuddyHeaders` (chat path) emits `X-Product`,
  `X-IDE-Type`, `X-IDE-Name`, `X-Domain`, `x-requested-with`,
  `x-codebuddy-request` in both the CLI and IDE branches.
- `src/providers/integrations/buddy/codebuddy/quota.ts:34-62` —
  `cnHeaders` / `intlHeaders` emit the identical six-header envelope
  (`X-Product`, `X-IDE-Type`, `X-IDE-Name`, `X-Domain`, `x-requested-with`,
  `x-codebuddy-request`) for the billing-meter quota and usage reads.
- `src/providers/integrations/buddy/buddy-checkin.ts:308-324` —
  `checkinHeaders` emits the same six-header envelope for the daily check-in
  status/claim and activity-report reads.

**Mechanism.** The three call sites share the same upstream risk gate
(CodeBuddy intl = `IDE`, CN = `CLI`; wrong identity -> 403) but each hand-writes
the header map. There is already a canonical per-variant source of truth for the
variant identity and domain — `codebuddyDomain` (`codebuddy/shared.ts:22-24`)
and `buildCodeBuddyUserAgent` — yet the envelope itself is not lifted out.

**Why consolidation helps.** Four copies of the same wire contract can drift.
CodeBuddy CN is the live proof of how costly that is: the chat path had to add
`codebuddyDomain("CLI")` explicitly because a missing/wrong `X-Domain` drew a
channel-check block. A single `buddyBillingFacadeHeaders(variant)` helper would
make the billing facade's identity provably identical across chat, quota, usage,
and checkin, and give the drift test one target.

**Owner:** `src/providers/integrations/buddy/codebuddy/shared.ts`
(export the helper there; `codebuddyHeaders`, `codebuddy/quota.ts`,
`buddy-checkin.ts` consume it).

**Bounded change.** Add `buddyBillingFacadeHeaders(variant)` to
`codebuddy/shared.ts`; replace the duplicated literal blocks in `quota.ts` and
`buddy-checkin.ts` with a call. The chat path's `codebuddyHeaders` keeps its own
extra layers (agent envelope, conversation trace, OAuth identity, device token)
on top; only the shared six-header base is unified.

**Behavior change: NO.** All three emit byte-identical headers for the same
variant today. The refactor preserves them.

**State/fallback risk:** none. Pure header-map construction, no state, no
fallback.

**Severity: MED.** Not a live bug, but a 403-flavored drift hazard across three
surfaces, and the family's own history shows the failure mode is real.

**Effort: S.**

**Verification.** `bun test test/providers/buddy-cli-identity.test.ts`
`test/providers/buddy-enterprise.test.ts` `test/providers/buddy-usage-detail.test.ts`
`test/providers/buddy-activity-report.test.ts`. Optionally a new parity test
asserting `checkinHeaders` / quota headers equal `buddyBillingFacadeHeaders`
for each variant. Live verify one CodeBuddy chat dispatch and one check-in claim
return non-403.

---

## Finding 2 — Claude beta string literals scattered across four modules with no single owner

**Verdict: CONSOLIDATE (single source of truth).** The same Anthropic beta id
strings are re-declared as literals in four places in the `claude` family:

- `src/providers/integrations/claude/claude-credentials.ts:75-126` —
  `OAUTH_AUTH_BETA`, `INTERLEAVED_THINKING_BETA`, `THINKING_TOKEN_COUNT_BETA`,
  `CONTEXT_MANAGEMENT_BETA`, `PROMPT_CACHING_SCOPE_BETA`,
  `STRUCTURED_OUTPUTS_BETA`, `MID_CONVERSATION_SYSTEM_BETA`,
  `CLAUDE_CODE_BETA`, `EFFORT_BETA`, `FALLBACK_CREDIT_BETA`, then
  `CLAUDE_CODE_UTILITY_BETA_DEFAULTS` / `CLAUDE_CODE_AGENT_BETA_DEFAULTS`
  (the agent/utility profiles sent on the wire).
- `src/providers/integrations/claude/claude-quota.ts:9-20` —
  `claudeCodeOAuthBetas` re-lists `claude-code-20250219`,
  `oauth-2025-04-20`, `interleaved-thinking-2025-05-14`,
  `context-management-2025-06-27`, `prompt-caching-scope-2026-01-05`,
  `mid-conversation-system-2026-04-07`, `effort-2025-11-24` verbatim
  (plus the quota-only `redact-thinking`, `advanced-tool-use`,
  `extended-cache-ttl`).
- `src/providers/integrations/claude/claude-betas.ts:40-65` —
  `ANTHROPIC_BETA_CAPABILITIES` keys these same beta ids, and `:148-157`
  `oauthBaselineBetas` re-lists seven of them as a second literal map.
- `src/providers/integrations/claude/fallback-credit.ts:39` —
  `FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01"` (duplicated from
  `claude-credentials.ts:84`).

**Mechanism.** The negotiation authority (`claude-betas.ts`) owns the
beta→capability mapping, and `claude-credentials.ts` owns the wire defaults, but
nothing imports one module's constants from the other — the ids are repeated as
literals. `claude-quota.ts` is a third independent copy for the usage endpoint.

**Why consolidation helps.** A beta rename or a policy change (e.g. dropping a
beta from the OAuth profile) must be applied in four places. Because the wire
header is the visible artifact, an edit that hits only `claude-credentials.ts`
would silently change dispatch behavior while the quota endpoint and negotiation
table still name the old id — a fingerprint and capability mismatch the upstream
can reject. The `claude-quota.ts` list is already observably divergent from the
credentials defaults: it carries `redact-thinking-2026-02-12`,
`advanced-tool-use-2025-11-20`, `extended-cache-ttl-2025-04-11` and omits
`structured-outputs-2025-12-15` + `fallback-credit-2026-06-01`. Some of that is
intentional (quota endpoint specific betas), but the overlap is unmarked and
undocumented.

**Owner:** `src/providers/integrations/claude/claude-betas.ts` (export the
canonical id constants there; `claude-credentials.ts`, `claude-quota.ts`, and
`fallback-credit.ts` import them). Keep the quota-only ids explicitly separate
from the dispatch profile ids so the divergence is intentional and named.

**Bounded change.** Introduce `export const` beta ids in `claude-betas.ts`;
replace the literal strings in `claude-credentials.ts`, `claude-quota.ts`, and
`fallback-credit.ts` with imports. Do not merge the two profile lists — they are
different sets by design; just stop re-typing the overlapping ids.

**Behavior change: NO.** Pure constant lifting; wire bytes unchanged.

**State/fallback risk:** none.

**Severity: MED.** No live bug, but the divergence between `claudeCodeOAuthBetas`
and the profile defaults is already real and unnamed, which is exactly the shape
of a future silent drift.

**Effort: S.**

**Verification.** `bun test` on the claude suites
(`test/providers/claude-*.test.ts`). Grep the family for each beta id and
confirm a single declaration site after the change (except the documented
quota-only ids).

---

## Finding 3 — `claude-user-profiles` request headers duplicate the `claude-quota` header block

**Verdict: CONSOLIDATE.** `claude-user-profiles.ts:131-147` (`requestHeaders`)
and `claude-quota.ts:119-133` (`fetchClaudeQuota` headers) build near-identical
fixed Anthropic API header dictionaries:

- `authorization: Bearer <access>` (both)
- `"anthropic-beta"` (both)
- `"anthropic-version": "2023-06-01"` (both)
- `"anthropic-dangerous-direct-browser-access": "true"` (both)
- `"x-app": "cli"` (both)
- `"user-agent": CLAUDE_CODE_USER_AGENT` (both)
- `accept: "application/json, text/plain, */*"` (both)
- `"accept-encoding": "gzip, compress, deflate, br"` (both)
- `connection: "keep-alive"` (both)

The only differences are the beta value and the `accept` variant. Both routes
already share the `getJson` transport helper from `quota-contracts`; only the
header dictionaries are hand-built per caller.

**Mechanism.** Two read-only Anthropic REST surfaces (usage, user-profiles) are
auth'd and fingerprinted identically, but each assembles its own header literal.

**Why consolidation helps.** The fixed Anthropic client-identity block
(version, dangerous-direct-browser-access, x-app, UA, accept-encoding, keep-alive)
should have one definition. Changes (e.g. a UA formula change in
`claude-fingerprint.ts`) are already centralized through `CLAUDE_CODE_USER_AGENT`,
so the remaining drift risk is the static literals around it. A shared
`claudeApiRequestHeaders(access, beta, accept)` helper removes the copy.

**Owner:** a small shared helper (natural home in `claude-quota.ts` or a new
`claude-http.ts`), consumed by both `claude-quota.ts` and
`claude-user-profiles.ts`.

**Bounded change.** Extract the fixed header block into one function; have both
call sites call it and merge their beta/accept differences. No change to the
`getJson` transport or response handling.

**Behavior change: NO.** Identical bytes on both routes.

**State/fallback risk:** none.

**Severity: LOW-MED.** Low live risk because both blocks are currently correct
and stable; worth fixing as a hygiene/consolidation item.

**Effort: S.**

**Verification.** `bun test test/providers/claude-user-profiles.test.ts` (if
present) plus a quota fetch test (`test/providers/claude-quota*.test.ts`). Assert
the produced header dicts are unchanged.

---

## Finding 4 — `FallbackCreditCache` reimplements `TtlCache` semantics

**Verdict: PARTIAL (review, low confidence).** `fallback-credit.ts:63-122`
(`FallbackCreditCache`) is a bespoke bounded TTL cache (per-key `expiresAt`,
max-size oldest-first eviction, refresh-position-on-read). The repo already has
`TtlCache` (`src/persistence/ttl-cache.ts:25-134`), used by `claude-quota.ts`
and `claude-user-profiles.ts` with the same 5-minute / 256-entry parameters.

**Mechanism.** `FallbackCreditCache` and `TtlCache` share the core shape (Map
backed, insertion-order eviction, lazy expiry), but differ in one semantic:
`FallbackCreditCache.get()` refreshes the entry's LRU position on every read
(`fallback-credit.ts:80-85`), while `TtlCache.get()` deletes expired entries but
does **not** refresh position. For a credit-redemption cash this refresh-on-read
matters: a token that is read repeatedly stays hot instead of aging out of the
64-entry budget.

**Why consolidation helps.** Reusing `TtlCache` would remove ~60 lines of cache
mechanics, but only if the refresh-on-read semantic is preserved — either by
adding an optional `refreshOnGet` flag to `TtlCache`, or by wrapping it. A naive
swap would change eviction order and could evict a live, frequently-checked
credit token — a real (if rare) behavioral change on the redemption path. So this
is a *candidate* consolidation, not a clean win.

**Owner:** `src/providers/integrations/claude/fallback-credit.ts` +
`src/persistence/ttl-cache.ts`.

**Bounded change.** Add an optional `refreshOnGet` option to `TtlCache` (default
false, so existing quota/profile caches are untouched), then re-point
`FallbackCreditCache` at `TtlCache<{ token: string }>` preserving the 5-min TTL,
64-entry cap, and refresh-on-get.

**Behavior change: NO if the flag is additive; YES if `TtlCache` is swapped in
without preserving refresh-on-read.** The refresh-on-read must be kept.

**State/fallback risk:** the redemption cache is in-memory and process-local; a
regression here changes which token survives long enough to be spent, but never
fails a request (a missed token just means a standard retry). Low impact, but the
semantics must be pinned by a test before consolidating.

**Severity: LOW.** Hygiene + dedup; not a live bug.

**Effort: M** (touches the shared cache primitive, so needs a `TtlCache` unit
test addition).

**Verification.** Add a `TtlCache` test for `refreshOnGet` (read keeps the entry
alive; non-refreshing default unchanged). Then run `test/providers/claude-fallbacks-chain.test.ts`
and the existing `TtlCache` tests. Assert the redemption path still spends a token
that was read once in the middle of its window.

---

## Things reviewed and not flagged

- **Tool-round handling**: `buddy-chat-shared.ts` has a deep, well-internalized
  tool repair stack (`repackBuddyToolResultBlocks`, `cleanupBuddyOrphanToolPairs`,
  `dropBuddyEmptyNameToolCalls`, `coalesceConsecutiveAssistantMessages`). These
  are buddy-wire-specific (11148 sequence, 11133 empty-name, 11151 empty turn)
  and the canonical `repairRequestToolCalls` (`src/protocol/translation/tool-repair.ts:168`)
  is correctly *not* duplicated — the file even documents that division
  (`buddy-chat-shared.ts:1181-1182`). No consolidation warranted.
- **Message identity prompts**: `scrubBuddyChannelIdentity` / `DSH_*`
  patterns and `applyBuddySystemPrompt` are each a single implementation shared by
  both variants. `coalesceConsecutiveUserMessages` is shared. No duplication.
- **Slow-lane logic**: `claude-slow-lane.ts` (parse/registry) and
  `claude-slow-lane-retry.ts` (decision) are cleanly separated; `claude.ts:537-574`
  (`planAndWaitSlowLane`) delegates to `planSlowLaneRetry` rather than duplicating
  it. The router consumes `sharedClaudeSlowLanes.isActive` directly. Well-factored.
- **Error classification**: `mapClaudeHttpError` lives once in
  `src/protocol/messages-errors.ts:56`; the Claude adapter classifies via
  `isFallbackCreditTokenRejection`, `classifyClaudeSlowStatus`, and
  `isOverloadedFailure` — each single-sourced. No duplication.
- **Quota/refresh**: the Tencent billing envelope arithmetic is already shared
  (`buddy-quota-shared.ts`), and `resolveBearerToken` is deliberately exported so
  `buddy-usage-shared.ts` does not re-implement it. The Claude quota/profile
  caches already use `TtlCache` (which is what makes Finding 4 a *reuse of a
  canonical primitive* rather than a new idea). No other duplication found.

## Execution status

**Re-audit (Phase 0) — completed.** No new findings beyond the original audit;
the area is covered by the other clusters (integrations-b/c/d, provider-ops,
protocol). No files were edited by this audit. The Claude quota-cache finding
(F1 in part 07) is executed as M-24; the Buddy/Claude client-version extractor
cleanup is executed as M-27; Kiro/Perch/OpenCode duplicates are executed as
M-34..M-39 (part 10).
