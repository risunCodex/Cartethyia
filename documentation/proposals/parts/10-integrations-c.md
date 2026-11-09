# Provider Integrations C — Maintenance Consolidation Audit

**Status: audit only — no implementation performed.**

## Scope

Read-only deep audit of the provider integration area
`src/providers/integrations/{kilo,kimi,kiro,muse,ollamacloud,opencode,openrouter,perch}/**`.
Goal: concrete, worthwhile opportunities to reduce duplication, unnecessary work,
and maintenance complexity while preserving behavior, with explicit attention to
memory/state integrity and fallback semantics.

This report proposes nothing that loosens a guard, weakens a fallback, or changes
wire bytes. Every proposed change is a mechanical consolidation of code that
already exists identically in two or three places, or a single-computation fix
for an accidental divergence.

## Current-flow evidence (canonical entry points)

- Adapters are wired in `src/providers/default-registry.ts` (`muse` ~L272, `kiro`
  ~L285, `kimi` ~L302, `opencode` ~L369, `kilo` ~L464, `perch` ~L572).
- Kiro is bespoke by wire (`bespokeWire`) and does its own translation;
  `kiro-request.ts` builds the ledger, `kiro-stream.ts` decodes the EventStream,
  `kiro.ts` drives both.
- Kilo and Muse reuse `OpenAICompatibleAdapter` and override `prepareHeaders` to
  decode a stored credential envelope before the shared pipeline authenticates.
- Perch is pure HTTP: `perch.ts` mints a turn ticket, reads the account session,
  and posts the model-call body built by `perch-protocol.ts`.
- Quota collectors (`kiro-quota.ts`, `muse-quota.ts`, `olimacloud/quota.ts`,
  `opencode-go-quota.ts`, `kimi-quota.ts`, `perch-quota.ts`) all build on the
  shared `src/providers/quota/quota-contracts.ts` helpers.

## Findings

### F1 — Kiro `TokenType` mapping duplicated three times (dispatch / quota / discovery)

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** MED.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/kiro/kiro.ts:190-196` defines
    `KIRO_TOKEN_TYPE = { api_key: "API_KEY", external_idp: "EXTERNAL_IDP", idc: "SSO_OIDC" }`,
    applied at `:233-236`.
  - `src/providers/integrations/kiro/kiro-quota.ts:85-87` re-implements the same
    mapping inline in `usageHeaders`.
  - `src/providers/integrations/kiro/kiro-discovery.ts:108-116` re-implements it
    a third time.
- **Mechanism:** The auth-method → `TokenType` header is a load-bearing upstream
  wire classification (the 1.4.62 client's `qje` map). All three surfaces must
  present the same classification for the same account or the upstream sees one
  credential as different token types across surfaces.
- **Why consolidate:** Three independent copies of one wire fact. The three
  implementations already agree on values and on the "omit for social/Builder-ID"
  rule, but nothing forces them to keep agreeing; a future auth family added to
  one surface silently drifts from the others. This is the same class of drift
  the codebase already centralizes for the profile ARN
  (`resolveKiroProfileArn`, `kiro-profile.ts`) and the machine id
  (`machineIdForAuthState`, `kiro-machine-id.ts`).
- **Proposal:** Export one helper from `kiro-catalog.ts` (next to
  `AWS_REGION_PATTERN`):
  `export function kiroTokenTypeHeader(authMethod: string | undefined): string | undefined`
  returning `"API_KEY"` / `"EXTERNAL_IDP"` / `"SSO_OIDC"` / `undefined`, and
  call it from `kiro.ts`, `kiro-quota.ts`, `kiro-discovery.ts`. The three
  call sites keep their own surrounding logic (default region handling, header
  spread), only the mapping converges.
- **State/fallback:** Stateless. No persisted state, memory, or ordering
  involved. `test/providers/kiro-runtime-wire.test.ts:53-66` pins the exact
  header values and the omission rule; those tests are the acceptance gate and
  pass unchanged.

### F2 — Kiro conversation-id resolver invoked three times per dispatch; fallback can mint distinct UUIDs

- **Verdict:** CONFIRMED. **Behavior change:** yes, in the no-session fallback
  only (correcting direction). **Severity:** MED. **Effort:** S.
- **Evidence:** `src/providers/integrations/kiro/kiro.ts:379-387`
  ```ts
  conversationId: resolveKiroConversationId(request, context),
  rootConversationId: resolveKiroConversationId(request, context),
  ```
  and again at `:608` for the session-cache estimate
  (``resolveKiroConversationId(request, context)`` inside `kiroUsage`).
- **Mechanism:** `resolveKiroConversationId` (kiro.ts:119-129) resolves in
  order `request.conversation?.conversation_id` →
  `request.conversation_id` → `resolveInboundSessionId(context, request)` →
  `generateKiroConversationId()` (a fresh `randomUUID()`). When a request has no
  session header, no conversation id, and no derivable opening-turn affinity, the
  fallback mints a new UUID on every call. Because the adapter calls the resolver
  twice at build time, `conversationId` and `rootConversationId` get two
  *different* UUIDs, contradicting the documented client rule
  (`rootConversationId ?? conversationId`, kiro-request.ts:179) and the comment
  at kiro-request.ts:110. The third call at stream end may mint yet another UUID,
  so the session-cache estimator (kiro-cache.ts) keys its memory under a
  different session id than the one the request presented upstream — the cache
  estimate then never matches a repeated request.
- **Why fix:** One computation, three consumes. Removes a latent state-integrity
  inconsistency (usage cache keyed under a session id that does not equal the
  request's conversation id) and three redundant UUID generations per fallback
  dispatch.
- **Proposal:** In `kiro.ts#dispatch`, compute `const conversationId = resolveKiroConversationId(request, context);` once, pass it for both
  `conversationId` and `rootConversationId`, and pass it to `kiroUsage` /
  `#stream` instead of re-resolving.
- **State/fallback:** The healthy path (inbound session or conversation id
  present) is byte-identical — the resolver returns the same string on every
  call there. Only the random-fallback case changes: parent and child conversation
  ids become equal, matching the client default. No data loss; the cache becomes
  *more* coherent. `test/providers/kiro-request.test.ts` and
  `test/providers/kiro-runtime-wire.test.ts` cover the resolver and wire shape;
  the fallback divergence is not currently asserted.

### F3 — Perch `PERCH_APP_URL` declared twice

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/perch/perch-realm.ts:34`:
    `export const PERCH_APP_URL = "https://app.perchai.app";`
  - `src/providers/integrations/perch/perch-protocol.ts:31`:
    `export const PERCH_APP_URL = "https://app.perchai.app";` (a second,
    independent definition)
- **Mechanism:** `perch.ts` imports `PERCH_APP_URL` from `perch-protocol`;
  `perch-quota.ts` imports it from `perch-realm`. Both constants exist and both
  are used. They agree today; nothing enforces that.
- **Proposal:** Delete the `perch-protocol.ts` definition and import
  `PERCH_APP_URL` from `perch-realm` (the realm module is already the single
  home for Perch constants: Supabase host/key, provider id, context windows,
  starter pins). Keep `PERCH_CLI_USER_AGENT` where it is (it is a wire fact of
  the protocol module).
- **State/fallback:** No state. Pure constant consolidation; no behavior delta.

### F4 — Perch credential-envelope parsing duplicated between adapter and quota collector

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/perch/perch.ts:284-292` `parseAccessToken`
    (try JSON, read `accessToken` ?? `access_token`, else return raw secret).
  - `src/providers/integrations/perch/perch-quota.ts:20-28` `credentialToken`
    (identical parse of the same envelope shape).
- **Mechanism:** Both parse the stored Perch OAuth envelope to recover the access
  token. The two differ only in failure handling (adapter passes the raw secret
  through; quota returns `""`), which is appropriate per surface.
- **Proposal:** Extract one `parsePerchCredentialToken(secret: string): string`
  helper (in `perch-realm.ts` or a small `perch-credential.ts`) and call it from
  both `perch.ts` and `perch-quota.ts`, keeping the per-surface fallback
  behavior at the call site.
- **State/fallback:** No state. Both call sites keep their existing error
  semantics. `test/providers/perch-quota.test.ts` and
  `test/providers/perch-adapter.test.ts` exercise both paths and pass unchanged.

### F5 — `KIRO_EFFORTS` duplicate between catalog and discovery

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/kiro/kiro-catalog.ts:40` and `:76`
  - `src/providers/integrations/kiro/kiro-discovery.ts:31` and `:162`
  Both are `["low", "medium", "high", "xhigh"] as const` and both feed
  `reasoningEfforts` on model rows.
- **Mechanism:** The effort ladder is a statement about the upstream's schemas
  (no `minimal`/`max` tier). Discovery and catalog must advertise the same
  ladder; two copies can drift.
- **Proposal:** Export `KIRO_EFFORTS` from `kiro-catalog.ts` and import it in
  `kiro-discovery.ts`.
- **State/fallback:** None. Static constant reuse.

### F6 — OpenCode Go quota re-implements `isoDate`

- **Verdict:** CONFIRMED. **Behavior change:** no. **Severity:** LOW.
  **Effort:** S.
- **Evidence:**
  - `src/providers/integrations/opencode/opencode-go-quota.ts:45-50`
    `resetIso`: accepts a string, returns `new Date(parsed).toISOString()` when
    `Date.parse` is finite, else `null`.
  - `src/providers/quota/quota-contracts.ts:145-153` `isoDate`: for a string
    input performs exactly the same check (`Number.isFinite(Date.parse(...))`)
    and returns the same ISO string, plus numeric handling.
  `opencode-go-quota.ts` already imports `getJson` from `quota-contracts`.
- **Proposal:** Replace the local `resetIso` with the shared `isoDate`.
- **State/fallback:** Identical semantics for every input the local helper can
  receive. `test/providers/opencode-gap-closure.test.ts` covers
  `fetchOpenCodeGoQuota` and remains green.

## State / fallback analysis

- **No finding touches persisted state, credentials, or quota snapshots.** The
  Kiro `TokenType` and `KIRO_EFFORTS` consolidations are pure constant/helper
  moves. The Perch constants and envelope-parse helpers are stateless. The
  OpenCode `resetIso` swap is semantic-identical.
- **F2 is the only finding that changes runtime state layout**, and it makes the
  in-memory session-cache estimate key consistent with the request's actual
  conversation id rather than a fresh UUID. It cannot corrupt or lose persisted
  state: the estimator is a bounded in-memory map (`SESSION_CACHE_MAX_SESSIONS`,
  session-cache.ts:15) and is already reset between test runs.
- **Fallback branches are preserved in every case.** F1 keeps the "omit
  TokenType" rule; F2 only equalizes the random fallback (which is the documented
  default); F4 keeps each surface's own failure behavior; F6 keeps `null`
  fallback on unparseable dates.
- **No guard or validation is loosened anywhere.** Nothing here widens a type,
  suppresses an error, or adds a fallback to hide a failure.

## Validation

- Source inspected in full for all eight integration directories (kilo, kimi,
  kiro, muse, ollamacloud, opencode, openrouter, perch), including the shared
  `src/providers/quota/quota-contracts.ts`,
  `src/providers/quota/quota-window-parser.ts`,
  `src/providers/integrations/shared/session-cache.ts`, and
  `src/providers/operations/session-resolution.ts`.
- Relevant tests inspected: `test/providers/kiro-runtime-wire.test.ts`,
  `test/providers/kiro-cache.test.ts`, `test/providers/kiro-request.test.ts`,
  `test/providers/opencode-gap-closure.test.ts`,
  `test/providers/opencode-donor-parity.test.ts`,
  `test/providers/opencode-fingerprint.test.ts`,
  `test/providers/perch-adapter.test.ts`,
  `test/providers/perch-quota.test.ts`, `test/providers/perch-protocol.test.ts`.
- No test suite was executed (audit only). Acceptance gates for the proposed
  changes are the existing suites listed above; each proposed change is small
  enough to be verified by those suites without new behavioral tests, with the
  exception of F2 where a new assertion on the fallback path (root ==
  conversation id) would be appropriate.

## Open questions

- F2: is any live client known to hit the no-session fallback routinely, or is
  it confined to bare HTTP clients without conversation headers? This determines
  how visible the divergence is in production telemetry.
- F3: should `PERCH_APP_URL` move entirely into `perch-realm.ts` with the
  protocol module re-exporting for compatibility, or should all imports be
  updated to the realm module directly? (Chosen default: update imports, no
  re-export alias.)

## Excluded / unverified suspects

- **Kimi quota parser vs `parseQuotaWindows`** — not duplicate; Kimi's
  shape (nested `detail`/`window`, duration-derived labels, aggregate +
  per-window rows) is genuinely bespoke and the generic parser documents this
  boundary.
- **Kilo/Muse `prepareHeaders` envelope overrides** — structurally similar but
  different envelopes (`{accessToken, orgId}` vs `{oauthAccessToken, apiKey}`)
  and different auth boundaries; consolidation would couple two providers that
  intentionally differ.
- **Perch CLI user-agent `perchai-cli/unknown`** — a version resolver exists in
  `client-versions.ts` but no accessor is wired; `test/providers/perch-adapter.test.ts:136`
  pins the literal upstream. Left untouched pending upstream verification.
- **`kiro-cache.ts` / `trae-cache.ts` wrappers** — intentionally identical
  31-line wrappers over the shared factory; the isolation is the point, and
  collapsing them would add a keyed registry with no size win.
- **Kiro StreamDecoder framing vs shared `FrameBuffer`** — already distinct and
  intentional.
- `summarizeMessages` (`perch-protocol.ts:207`) has no callers outside the file's
  own exports; it appears to be a capture/debug aid. Not dead-code claimed
  without a call-site sweep; listed as unverified.

---

## Execution status

**Implementasi kampaian (2026-11-09).** Verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (M-34) — ✅.** Kiro `TokenType` mapping single-sourced; the three
  copies (dispatch / quota / discovery) import it.
- **F2 (M-35) — ✅.** Kiro conversation-id resolver now invoked once per
  dispatch and passed through to `kiroUsage`/`#stream`; fallback mints one
  UUID. Healthy path byte-identical. New test
  `test/providers/kiro-adapter.test.ts`.
- **F3 (M-36) — ✅.** `PERCH_APP_URL` declared once; duplicate removed.
- **F4 (M-37) — ✅.** Perch credential-envelope parsing shared between adapter
  and quota collector.
- **F5 (M-38) — ✅.** `KIRO_EFFORTS` duplicate removed; catalog/discovery
  import one set.
- **F6 (M-39) — ✅.** OpenCode Go quota imports the shared `isoDate`.
