# Changelog

All notable changes to Cartethyia are recorded here. Entries are written for the
operator who reads them, not for the contributor who wrote the diff: what
changed, and what it means for an install. Migration numbers refer to files
that shipped at the time of the change. A fresh database builds from the
current baseline; an existing one applies the numbered files that followed it.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Device-code OAuth flows can now rotate egress through network pools.**
  Device-authorization start + token poll previously always dialed from the
  gateway's own egress, so every code minted on one host appeared to come from
  a single IP — which let Cursor/Grok/other device-code providers flag
  "multiple codes from one IP". A new `device_flow_proxy` routing setting
  (default `random`) routes those requests through a randomly selected active
  network pool (weighted, cooldown-aware; direct fallback when the tenant has
  no usable pool). `direct` restores the old single-address behavior. The
  setting is per-provider and per-tenant with a dropdown in the routing card;
  the resolved validated fetch is injected into the OAuth flow context so every
  device-flow client (Grok, Cursor, Codex, Kiro, Kimi, Kilo, Muse, Hermes,
  Factory, xAI, ZCode Start, Cline, Buddy, GitHub, Qoder) honors it.

- **Vercel AI Gateway provider added.** OpenAI-compatible bearer provider on
  `https://ai-gateway.vercel.sh/v1`, registered in the bundled catalog with
  three default rows (2026-11-11): the free-plan-serving
  `nvidia/nemotron-3.5-lightning-free` (1M ctx) plus the operator's billed picks
  `meituan/longcat-2.5` (vision, 1M ctx) and `inception/mercury-3` (1M ctx),
  with capabilities from the upstream's own listing. Other zero-priced listing
  rows (`reflection/beam*`, `humansand/ampersand-v0.1`,
  `stealth/glyph-cluster`) are refused on a free plan (verified live: 403
  `no_providers_available`), so they are intentionally not seeded. Live model
  discovery (`GET /v1/models`) adds everything else, keeping roster rows whole.
  Quota collector reads `GET /v1/credits` (USD balance + total spend) as a
  pooled credit window. No OAuth flow exists — keys are created via the
  Vercel CLI (`vercel ai-gateway api-keys create`) and pasted.

- **Free-pi and Perch client versions now ride the background version monitor.**
  `refreshProviderClientVersions()` previously skipped both because they were
  missing from `PROVIDER_VERSION_RESOLVERS` — their wire identities stayed on
  the launch-time pin forever. Both are now wired: free-pi sends the discovered
  `free-pi-cli` npm version (fallback raised to 0.6.18) in `x-client-version`,
  and Perch sends the discovered `perchai-cli` npm version (fallback raised to
  2.4.128) in its CLI user-agent. Freebuff Desktop stays intentionally pinned
  to the audited bundle build 0.0.201: no machine-readable public feed exists
  for the desktop line (GitHub releases are Codecane staging builds; npm
  `freebuff` is the CLI, a different product), so discovery would fake an
  identity the upstream gate could reject.

- **Qoder: dead chat surfaces removed, live COSY remains the one carrier.**
  The gRPC `ChatService` and IDE `/model/v1` surfaces (both dead upstream —
  UNIMPLEMENTED/404) are deleted along with the vendored proto, probe scripts,
  and wire tests. The parser (`qoderBodyToCanonicalEvents`, envelope frames)
  moved into `qoder-sse.ts` and now serves the sole live surface. The adapter
  dispatches COSY only.
- **Qoder: desktop-app outbound fingerprint mirrored.** `X-Qoder-HTTPDNS-IP`
  is emitted when the account's `auth_state` carries the HTTPDNS-route IP
  (parsed via `parseQoderOAuthState`, forwarded through `resolveQoderAuth` and
  `qoderOAuthAuth`); without it the header is omitted, matching a non-HTTPDNS
  client.
- **Network egress: unified client and TLS ClientHello profiles.**
  `src/network/` is restructured into `egress/`, `pool/`, `util/`, plus root
  shared modules (`client.ts`, `bidi.ts`, `ssrf.ts`, `verdict.ts`).
  `createNetworkClient()` is the single entry; `fetchWithTls(profile)` dials
  direct https with a chosen TLS fingerprint via a Node agent (verified: the
  `qoder-app` profile reproduces the captured desktop ClientHello suite order
  and ALPN). Streams keep flowing during profile dials (no full-body buffer).

### Fixed

- **OAuth callback listener no longer resets the callback connection.** The
  loopback listener called `server.stop(true)` synchronously from inside the
  request handler, closing the active connection before the success/denial
  Response was delivered — the callback tab saw HTTP 000 (connection reset),
  spuriously on local hosts and consistently on deployed/docker hosts. The
  release is now deferred one tick so the response flushes first; the port is
  freed immediately after. Verified live: HTTP 200 + completion. The listener
  still binds only `127.0.0.1`/`::1` (loopback), so browser-code logins from a
  machine other than the gateway's must use the dialog's manual paste path.

- **Provider client-version pins refreshed to current upstream releases.**
  Re-fetched every `VERSION_SOURCES` feed live (2026-11-11) and raised the
  cold-process fallbacks that had drifted: antigravity 2.29.0 → 2.31.0,
  opencode 2.2.6 → 2.2.7 (plus the `OPENCODE_CLIENT_VERSION` parity mirror),
  codex 0.167.0 → 0.167.1, kiro 1.4.121 → 1.4.154, codebuddy 2.181.0 →
  2.183.0, codebuddyCn 4.12.3.42658816 → 4.12.4.43368774, claude
  2.1.319 → 2.1.322, kilo 7.8.27 → 7.8.28, muse 1.4.14-R7309.1 →
  1.4.15-R8339.1, hermes 0.23.0 → 0.23.1, cursor cli-3.29.9-306d153 →
  cli-3.29.15-86776fc (plus the adapter's `FALLBACK_CLIENT_VERSION`). Trae's
  fallback is raised to 3.6.13 (the current desktop build per the official
  winget manifest): the docs changelog renders as an SPA now, so its parser
  yields nothing and the pin carries the wire identity until a machine-readable
  feed exists again. Qoder, grok, cline, kimi, zcode, commandcode, and the
  freepi/perch/freebuff entries are unchanged: their pins already matched the
  fetched feeds, or (qoder) deliberately track the IDE build, not the npm CLI.

- **Qoder: legacy COSY response body streams while profiled.** The Node
  GET/HEAD-with-body dial path now bridges the response into a web stream, so
  SSE chat streams are consumed incrementally instead of buffering the whole
  payload before resolving.
- **Qoder: chat wire aligned 1:1 with the desktop-worker capture**
  (2026-11-11, app 0.5.7 / worker 1.1.79-hotfix.19). The COSY chat surface
  now sends `Cosy-ClientType: 10` (was `5`), `Cosy-Business-Product: app`
  (was `cli`), `Cosy-Scene: app` (was `assistant`), `User-Agent: undici`
  (was `Bun/1.4.2`), `Accept-Encoding: br, gzip, deflate` (was `identity`),
  `Content-Encoding: zstd` with a zstd-compressed body over the scrambled
  transform (was uncompressed), plus `traceparent` (W3C), `sec-fetch-mode:
  cors`, and `accept-language: *`. Verified live 2026-11-11: 5/5 roster keys
  answer 200 through the adapter path. The signature is computed over the
  scrambled body before zstd compression — signing over the zstd wire bytes
  returns `403 Signature invalid`, proving the server decompresses before
  verifying.
- **GitHub Copilot: complete profile selection.** `CARTETHYIA_GITHUB_COPILOT_MODE`
  now selects the OAuth app, token mint/refresh behavior, inference headers,
  model discovery, and quota identity together. `opencode-copilot` remains the
  default and uses the raw GitHub token; `vscode-client-real` mints and refreshes
  the short-lived Copilot token. Restart the process after changing the mode,
  then reconnect GitHub accounts. Cartethyia's `/auto` routing and GPT Luna
  session-token flow remain available in both profiles. Imported 9router GitHub
  credentials are rebound to the active profile during restore.
- **OAuth: structured account identity and unique fallback labels.** OAuth login,
  device polling, imports, and refreshes now preserve provider-reported email
  and display name when available, including WorkOS response shapes used by
  Cline and Factory Droid. Accounts whose upstream reports no identity receive
  per-provider numbered labels such as `hermes-1` and `hermes-2` instead of
  sharing the provider id. The account API and dashboard expose the resolved
  email/name while generated labels remain display-only for re-login identity.

### Fixed

- **Trae: terminal quota authentication failures invalidate the account.** When
  session usage and entitlement on both realms all return HTTP 401 with code
  `1001`, the account is marked `disabled` / `auth_invalidated` immediately with
  no recovery deadline. A successful surface or any other failure remains
  non-terminal. Automatic and manual OAuth refreshes stop for the invalidated
  account until re-authentication.

## [2.8.0] - 2026-11-09

### Added

- **Unified routing decision engine (feature-gated).** New full-request
routing decision (`CARTETHYIA_UNIFIED_ROUTING_DECISION` text flag, default
off; legacy behavior unchanged when off). When on: model-aware quota window
matching (a candidate is only compared to windows for the model being
routed), proactive exclusion of candidates whose quota evidence is known
exhausted or below the usage floor, and `quota_unknown` treated as eligible
but lower rank. Quota evidence older than the 6h freshness horizon is
downgraded to unknown. `ROUTING_RANK` is split into
`FRESH_KNOWN`/`FRESH_UNKNOWN`/`SLOW`/`COOLING`/`SATURATED`; candidates and
routed candidates carry a normalized `quota_fact` stamp; `EligibilityReason`
gains `plan_gate`, `quota_unknown`, and `capability_unsupported`. Coverage:
`test/transport/unified-routing-decision.test.ts`.
- **Provider accounts: `quota_plan_fetched_at` column.** Records when the
quota plan was last fetched (migration `0046_add_accounts_quota_plan_fetched_at.sql`
in both full and lite sets), written by the quota refresh pass.
- **Quota view: canonical `unknown` status.** `QuotaRefreshView.status` now
includes `"unknown"` — a successful read carrying no windows and no
timestamp is rendered as `unknown` instead of `ready`, so the dashboard and
routing share one wire representation for missing quota evidence.
- **Provider cards: Disabled corner ribbon.** A parked (disabled) provider now
shows a red `Disabled` ribbon; the `Friend` sponsor ribbon only appears while
the provider is enabled. A disabled founding provider reads as Disabled, not
Friend.
- **Cursor: stale or mixed tool-result replays are refused.** A continuation
request whose tool results do not match the trailing assistant/tool-result
pair of the pending Run (stale results, results from an older Run, or
unknown call ids) is refused with `400` instead of being silently rebased.
The request is rejected whole with the offending call ids in the error.
- **Vision handoff: dropped images are marked, not silently deleted.** When an
older image-carrying history turn is excluded from the handoff, its image
parts are replaced with a `[image omitted]` text marker instead of being
filtered out, so the main model knows something was there. Coverage:
`test/transport/vision-handoff.test.ts` (Option E of the vision-handoff
context-preservation proposal).
- **Freebuff provider adapter (new).** Full integration for Freebuff
(Codebuff Desktop): OAuth code-flow login (`freebuffOAuthClient`, device-flow
shape) with per-account Ed25519 device-key minting; static 13-row catalog plus
live `/models` discovery; quota collector reading the session-admission
entitlement (`freebucks` + per-model `rateLimit`); and a custom chat adapter
that runs the stateful preflight (session admission → agent-runs START →
chat → FINISH → session release) with the desktop identity-group headers and
the locked official 7918-char worker system prompt + 37-tool set. Wire facts
live-verified 2026-11-09 (see `documentation/research/freebuff/`). Coverage:
`test/providers/freebuff-{adapter,signature,discovery}.test.ts`.
- **Freebuff: session-active pill per account (provider detail).** The quota
collector now does a live `GET /api/v1/freebuff/session` (device-signed) and
emits one `session_active` window per active purchase (model + `expiresAt`).
The provider-detail account row renders a countdown pill — `Session · <model> ·
Expires in Nh Nm` — that re-renders every 30s from the absolute expiry, without
polling. Quota summary treats `session_active` windows as display-only. Coverage:
`test/providers/freebuff-discovery.test.ts` (session windows, expired skip,
no-device fallback).
- **Freebuff: virtual model ids.** The opaque `m-<hex>` roster keys are now
published as readable caller-facing ids (`deepseek-fast`, `solar-pro-4`,
`gpt-6-luna`, `claude-haiku-5.5`, …) across the catalog, discovery, quota
windows (so routing's `filterCandidateQuotaWindows` matches), and dispatch —
the roster key is resolved at call time. Probe prompts are minimal and unique
per model (`ping <modelId>`, no worker system template) to stay clear of the
admission policy gate that flags repeated identical probes.
Coverage: `test/providers/freebuff-discovery.test.ts` and
`test/providers/freebuff-adapter.test.ts`.

### Changed

- **Cursor: the live turn is excluded from rebased history.** `historyFromRequest`
skips the current live user/tool turn (it is sent as the prompt, not
replayed as history), so the upstream does not see the pending prompt twice.
- **OAuth disable and quota-refresh parking share one writer.** Account
disable and the quota-refresh parking path both converge on
`applyAccountVerdict` (status, last error, cooldown, health event, operator
disable preserved).
- **Cursor: held-Run idle TTL raised to 30 minutes.** A live Run now waits
30 minutes (matching the oh-my-pi donor) for the client's next tool-result
request before expiring, so a slow human-approved tool round no longer goes
cold mid-approval and forces a full-conversation resend.
- **Account error labels: `quota_unknown` and `plan_gate`.** Both are
rendered as status text (`Quota unknown`, `Plan blocked`); `quota_unknown`
is a retryable/eligible category, not an error pill.

### Fixed

- **CodeBuddy: JWT-derived identity headers.** `X-Id-Source` / `X-Auth-Method`
and the `X-Userinfo` envelope now fall back to the access token's JWT claims
(`id_source`, `token_source`) when `auth_state` has no pinned values — the
donor gateway (`codebuddy2api`) reads them from the JWT payload, so accounts
authorized before the fields existed still carry the identity markers. Coverage:
`test/providers/buddy-donor-gaps.test.ts`.
- **CodeBuddy: channel-check console retry.** A 400 carrying the `11128` /
`11-128` channel-check code plus the explanatory text now retries once against
the intl `/console/chat/completions` endpoint before surfacing the error —
matching the donor's recovery for the international profile. The detector is
ported from `codebuddy2api/upstream_compat`. Coverage:
`test/providers/buddy-donor-gaps.test.ts`.
- **CodeBuddy: gzip request body.** The CLI profiles (`cb`, `cbcn`) now gzip
the chat JSON body with `Content-Encoding: gzip` and request `Accept-Encoding:
identity`, matching the donor's `_json_request_kwargs` contract.
- **CodeBuddy: RE2 tool-schema normalization.** Escaped underscores (`\_`) in
tool parameter patterns are normalized to plain underscores before dispatch;
the upstream's RE2 validator rejects `\_` with a 400. Ported from
`codebuddy2api/upstream_compat`. Coverage:
`test/providers/buddy-donor-gaps.test.ts`.
- **CodeBuddy: reasoning-control validation.** `thinking.type` must be enabled,
adaptive, or disabled; `budget_tokens` (when present with enabled) must be an
integer >= 1024; `display` accepts only summarized. A malformed shape fails with
a named 400 instead of an opaque upstream error. The solver effort ladder is
unchanged — an unsupported effort still clamps to the nearest served level.
Coverage: `test/providers/buddy-donor-gaps.test.ts`.
- **Cursor: complete multi-round tool-result replays rebase instead of being
refused.** A continuation request whose `call_cursor_*` results all have a
matching tool call in the sent conversation (a full-transcript resend after
a gateway restart or an expired Run) now rebases into a fresh Run, including
conversations with several earlier tool rounds. Previously only a single
trailing assistant/tool-result pair qualified, so multi-round transcripts
were rejected with a 400 "no longer pending" error. A partial tail (a
result whose tool call is not in the conversation) is still refused, now
naming the missing call ids. Coverage: `test/providers/cursor-run-continuation.test.ts`.
- **Copilot thinking no longer renders as dozens of tiny blocks.** The
Messages encoders (streaming `MessagesStreamEncoder` and non-streaming
`groupedBlocks`) split a `thinking` block on every reasoning-item identity
change. Copilot streams one thought as many summary items, so a single
thought painted many small blocks with spurious breaks. Blocks now split only
on a strong boundary (a sentence ending before a capitalized continuation, or
a Markdown block marker); weaker boundaries merge into the open block with a
space. Coverage: `test/transport/surface/messages-stream-encoder.test.ts` and
`test/transport/reasoning-summary-separator.test.ts`.
- **Transport: upstream socket drops are normalized and retried once.** A
mid-response socket death (Bun `TypeError` with `code: ECONNRESET`) no longer
leaks to the client as a raw `ECONNRESET`/400 with origin `cartethyia` — the
dispatch loop materializes it as `transport_unavailable`/502/upstream before
classification, so telemetry, the captured Client Response, and the wire
agree. With a single-account provider (the common case) the socket drop now
receives one bounded extra dial; the fresh dial recovers the transient reset
(verified live 2026-11-09, 7/7 on the first retry). The keepalive=false
workaround for stalled pooled sockets is removed.
Coverage: `test/transport/failure-policy.test.ts` and the transport suite.
- **Copilot reasoning channel keeps source order when stripping double-wrapped
`<think>` tags.** The chat decoder's reasoning path split each delta with
`ThinkSplitter` and joined `${reasoning}${text}`, which reordered the stream:
untagged thought that preceded a tag fell after the tagged span. The channel
now strips paired tags statefully in source order (`ThinkingTagStripper`), so
a reasoning stream like `thought A <think>inner</think> thought B` reads
`thought A inner thought B` instead of `innerthought A thought B`. Coverage:
`test/providers/strip-thinking-tags.test.ts`.
- **Cursor wire aligned to the vendored `agent.proto`.** The Run-request
schema dropped invented fields that have no wire meaning (`unknown_flag`,
`field_12`, `run_id`, `conversation_group_id`, `selected_subagent_models`) and
gained `model_details` (#3), `mcp_file_system_options` (#6), and `skill_options`
(#7), matching the donor `oh-my-pi` proto. `CancelAction` is now sent empty per
the proto (the oneof presence is the signal). Proto vendored at
`vendor/proto/cursor/agent.proto`.
- **Cursor mixed-run tool-result replays rebase instead of refusing.** A
continuation whose results resolve to more than one live Run — the "mixes
live Cursor tool results" 400 — now cancels the resolved Runs and rebases the
complete transcript into a fresh Run, matching the donor's behavior instead of
stalling the client loop. A partial tail (a result with no matching call) and
a foreign-tenant call id remain hard refusals. Coverage:
`test/providers/cursor-run-continuation.test.ts`.
- **Freebuff OAuth device flow no longer hangs or logs out.** A device-key
registration refused by upstream (e.g. `account_suspended`) now surfaces its
real status (403) and message instead of a synthetic 401, and the dashboard's
device dialog reports the failure and closes instead of silently polling
forever on "Waiting for authorization…".
- **Freebuff quota reads are read-only.** `fetchFreebuffQuota` now reads
`GET /api/v1/freebuff/session` with the account's device identity from
`auth_state` instead of performing a session-admission probe, so a quota
refresh never spends a session, locks a model purchase, or hits the upstream's
gates. Accounts without a device identity report a clear error instead of a
synthetic probe.
- **Data-dir guard.** `resolveDataDir` ignores a literal `CARTETHYIA_DATA_DIR`
value of `"undefined"`, which previously made the process write gateway state
into a folder named `undefined/` in the working directory.
- **OAuth/Add-Account dialogs accept dragged credential text.** A redirect URL,
  token, key, or exported credential selected in the browser and dragged into
  the drop zone (instead of only a file) now lands in the field through the same
  parser as a paste — validity is still decided at Connect/Import/Add time, so
  invalid material is rejected there rather than stored.

### Removed

- **Proposal docs retired:** `documentation/proposals/docs-audit-why-install.md`
and `documentation/proposals/vision-handoff-context-preservation.md` were
removed from the proposals directory (the vision-handoff proposal's Option E
is now implemented; the audit was folded into its findings).
- **Completed planning proposals removed:** `documentation/proposals/codebase-cleanup-optimization-campaign.md`,
`documentation/proposals/proactive-quota-routing.md`, and the four part files
under `documentation/proposals/parts/` were removed — the campaigns they
describe are landed, so the proposals no longer document anything in flight.
- **Completed maintenance proposal removed:** `documentation/proposals/src-maintenance-deepscan.md`
and the 15 part files under `documentation/proposals/parts/` were removed —
the deepscan campaign is landed (see Maintenance above), so the proposal no
longer documents anything in flight. Deferred items are tracked in the
Maintenance entry, not in a stale proposal file.

### Maintenance

- **Source maintenance deepscan executed.** The composed audit
(`documentation/proposals/src-maintenance-deepscan.md`) was implemented
end-to-end across the campaign clusters: deduplication, dead-code removal, and
canonical-owner consolidation across boot/config, transport
(request/surface/dispatch/routing), providers (core, ops, integrations a–d),
console (domains a/b), network/security, persistence/observability, and
protocol. Highlights:
  - Routing: soft-cooldown candidates now rank `COOLING` (ordered after every
    healthy sibling); an all-soft pool answers 429 with the earliest reset
    instead of routing into a cooling account.
  - Routing: free-plan marker `FREE_PLAN_MARKERS` single-sourced; candidate
    construction deduplicated via `buildCandidateBase`; dead
    `EligibilityEvaluator.filter` removed.
  - Provider core: bundled-metadata lookups hoisted to module-load time; a
    canonical discovery-backed provider-id set replaces three re-spelled lists
    and a drifted test copy; dead `ProviderRegistry.snapshot`/`#revision`
    removed; JSON-credential token extraction single-sourced; provider-family
    id sets now import canonical exports (`TRAE_PROVIDER_IDS` added).
  - Provider ops: Claude module-local quota cache removed (shared two-tier
    cache owns dedup; debit-ahead survives sweeps); quota-window parsers share
    one field-resolution core; account+OAuth-state loading consolidated; five
    client-version extractors removed in favor of `defaultExtract`.
  - Integrations: Kiro conversation id resolved once per dispatch (single UUID
    fallback); Kiro TokenType/effort mappings single-sourced; Perch envelope/
    URL deduplicated; Trae region→host resolution centralized in
    `trae-realm.ts`; Qoder roster-context/output resolvers single-sourced,
    dead gRPC `_contextWindow` parameter dropped, empty-stream recovery net
    removed (test-only), claim/check-in normalization helpers shared; provider
    device-poll overrides and protobuf helpers deduplicated; Command Code and
    OpenCode Go quota reuse shared coercion/date helpers.
  - Console: loopback+drain-token gate (`requireLoopbackAdmin`), API-key
    family cache-invalidation, account-status PATCH validation, pool-response
    enrichment, live-cooldown SQL fragment, CSRF/mutation-limiter predicate,
    and the IP-ban duration list all single-sourced; dead console code removed
    (`summarizeUsagePerformance`, `injectorFor`, duplicate `numOrNull`).
  - Network/security: provider-scoped egress-verdict audit writers
    deduplicated; negative-auth-cache comment corrected.
  - Persistence/observability: telemetry write/reconciliation row mapping
    unified (backfill now fills `creditUsed`, `resolveMs`, `tokensPerSec`,
    `firstContentDeltaAtMs`, `lastEventAtMs`, `payloadCaptureState`,
    `degenerateStop`); dead file-based event-log reader removed; memory gauges
    consolidated to one canonical series.
  - Protocol: completion reasoning-effort parsing routes through shared
    `parseReasoningIntent` (accepts `"instant"`); `reasoningTextForReplay`
    single-sourced with summary-first precedence; the DSML/OMP/Qwen markup
    parser scaffold unified behind `MarkupStreamParser<T>`.
  - Validation: `tsc --noEmit` zero errors; full backend suite 4735 pass /
    1 skip / 0 fail. 59 findings executed (56 CONFIRMED, including M-44/M-62
    verified-promoted from PLAUSIBLE, plus the three protocol findings P-F1..3).
  - **Deferred findings closed (follow-up pass).** The four remaining findings
    were executed and verified against the same gates (typecheck zero errors,
    full backend suite green):
    - M-16: routing `plan()` now batch-reads quota evidence per lens
      (`getCachedQuotaEntries` one MGET + `readQuotaSnapshots` one query)
      instead of a serial read per candidate.
    - M-57: `getSelectionFailure` reads cooldowns and inflight counters in one
      `MGET` per key family, with a per-pool fallback on Redis error.
    - M-23: probe adapter load now uses `resolve(providerId, { force: true })`
      (single-flight, rebuilds against the current registration); the separate
      `loadOne` method was deleted.
    - M-59: the DNS cache uses `BoundedLruMap`; byte accounting uses the new
      shared `evictOldestEntry` helper (insertion-order eviction preserved).
      The API-key auth cache stays hand-rolled (deliberate exception).
    - M-42 (PAT-exchange): the claim and auth PAT→job-token exchanges now
      share `exchangeQoderPatForHost` — one v1 body + client-identity header
      set, parameterized by each site's verified host (`center.qoder.sh` vs
      the openapi host; both probed live, both accept the shared header set).
      The auth path keeps its `mapUpstreamHttpError` behavior; the claim path
      keeps its return-null behavior.

## [2.7.9] - 2026-11-08

### Added

- **Perch provider (Free Limited), pure HTTP.** Supabase GoTrue PKCE OAuth
implemented directly in Cartethyia (no captured external tokens), Starter
plan selection, turn-ticket mint, `/api/perch-terminal/model-call` SSE stream,
account quota, and model discovery. `pro` tiers were never hit and are
absent from the roster. No CLI process, desktop app, MCP, or ACP is
installed, spawned, or bundled as a transport. Evidence:
`documentation/research/perch/README.md`.
- **Perch Starter-pool model pins.** Beyond the Roost tiers, the Starter plan
pins a small model pool; the catalog now ships `glm-5.3-flash-starter`,
`deepseek-flash-starter`, `crouton-alpha`, and `beam-1.0-starter`
(all 1M context per the client's published cards). Verified live
2026-11-08: GLM 5.3 Flash, DeepSeek V4.1 Flash, and Crouton Alpha answer
200 and the server reports the pinned backing model; Beam was not verified
(turn rate limit). A pin is sent as `manualModelOptionId` +
`preferredModelId` with `strictManual: true` — `preferredModelId` alone is
ignored by the upstream (it falls back to the Roost default). The 1M tier
now also sends the canonical `standard_max` tier id instead of the label.
- **Unified provider system-prompt hook.** `ProviderAdapter.systemPrompt?()`
lets an adapter declare the system prompt its upstream fingerprints; the
probe path injects it as `request.system` instead of hardcoding anything in a
provider-detail test. Perch declares the 432-char Saffron prefix, which the
model-call body keeps as the opener even when the caller supplies its own
system turn. Other providers are unchanged.
- **Routing: a qualified `provider/model` not in the catalog now routes via
the provider's sibling candidate.** Previously any model missing from the
catalog was refused with `model_not_found` (404), even when the provider was
explicitly qualified and could serve arbitrary model ids (BYOK, custom
gateways, unfetched models). The engine now clones the provider's first live
candidate (inheriting endpoint, wire family, dialect, capabilities, tenant
scope) and retargets it at the requested model. Bare-model misses and
providers with no candidates still 404.
- **Inject System Prompt: preset preview + mode select, per-model removed.**
Every preset card (built-in and custom) now has a Preview button showing the
full prompt text in a dialog. Append/Override mode is selectable directly on
preset cards and on the global custom prompt (previously display-only). The
per-model scope section is removed from the dialog; global, provider, combo,
and alias scopes remain.
- **Combos page: system-prompt active pill on combo/alias rows.** A combo or
alias with an active injection (preset or custom) shows a green `Active`
pill next to its name with the preset name or Append/Override label.
- **Cursor model sweep live (2026-11-06): 1/47 PASS, 46/47 refused.**
Probe (`scripts/provider-probing/cursor/probe-cursor.ts`) now parses the
typed error detail (`Model unavailable on Free: …`) and resolves on
`turn_ended` instead of waiting for END_STREAM. Full 47-model sweep: only
`default` (Auto) serves; every named model answers `resource_exhausted`
(entitlement, not request shape).
- **Cursor native tool execution (no MCP fallback).** The adapter now executes
Cursor's host tools locally — `read`, `write`, `grep`, `shell`, `ls`,
`edit`, `find`, `delete` — instead of relaying them to the client or
refusing them. One canonical name per tool across both wire generations
(modern exec arms are namespaced `ct_*` internally). Every path resolves
inside the workspace root (escape → typed `rejected`/`permission_denied`);
shell runs via parsed argv with `shell: false` and pinned cwd. MCP is kept
for client-declared tools; `subagent`, `web_search`, `fetch` stay refused.
Harness (19 checks incl. parallel):
`scripts/provider-probing/cursor/harness/native-tool-harness.ts`; unit tests:
`test/providers/cursor-exec.test.ts`.
- **Cursor adapter aligns with the agent CLI wire (2026.11.05-86047df).**
Unpacked the `cursor-agent` npm runtime and audited hosts, endpoint
inventory, headers, and payloads against the adapter. Applied: `x-cursor-timezone`
(IANA zone) now sent on the Run stream and unary catalog calls, matching the
CLI's request middleware; `FALLBACK_CLIENT_VERSION` and `VERSION_SOURCES.cursor.fallback`
equalized on `cli-2026.11.05-86047df` (the CLI's build id). `x-cursor-checksum`
is a bridge-worker-only header in this build (not sent by the CLI's Run/API
path); it is kept for the IDE profile and documented. `x-cursor-team-id` and
bridge-worker/env headers (`x-cursor-client-os/arch`, `host-app-*`, `canary`)
are not adopted. Full evidence + decision log:
`documentation/research/cursor/2026-11-06-cursor-agent-cli-wire-audit.md`.
- **Test: HTTP/2 bidi streaming suite skips when the fixture CA is not
trusted.** `test/network/outbound-http2.test.ts` now requires the fixture CA
to be present in `NODE_EXTRA_CA_CERTS` (as the runner bundles it); running
`bun test` directly with a different extra CA skips the suite instead of
failing on the self-signed cert.
- **CodeBuddy/WorkBuddy rosters: `hy4free` added alongside `hy4`.** The
free variant mirrors `hy4`'s metadata on every buddy roster: intl
(cb/workbuddy) at 1M context / 64k output with tool calling and vision, CN
(cbcn/workbuddycn) at 960k / 64k, and the `high` reasoning effort ladder on
both realms.
- **OAuth browser dialog: drag-and-drop redirect URL files + field reset on
invalid paste.** The manual "Step 2" field now accepts a dropped file (a
saved redirect URL or raw code) straight into the same paste path, with a
highlighted drop zone. An invalid paste (a URL with no `code`, or a
provider error) resets the field instead of closing the modal, so the
operator can correct the paste without reopening the dialog.
- **Trae probing scripts: `scripts/provider-probing/trae/`.** `probe-trae-chat`
(chat/agent wire + SSE decode), `probe-trae-quota` (session/entitlement/pay
surfaces), plus `--models`/`--picker`/`--userinfo`/`--sweep`
(chat/agent sweep) roster and identity probes. All share the adapter's own
header builder and never print tokens.
- **Trae intl roster: search-agent configs and paygo rows added.** `search_agent`,
`search_agent_gpt-5.4`, `search_agent_gpt-5.3-codex`,
`search_agent_gemini_3_pro_with_g3f`, and `gemini-3.1-pro-paygo` join the
agent catalog (skipped rows that already existed: `gpt-5.4`, all `gpt-5*paygo`).
All verified live (2026-11-06) to stream on the agent surface with full
tool-calling support; specs mirror the upstream model each config resolves to.
- **Trae intl roster: models refused on the Free plan removed.** Live sweep
(2026-11-06) showed `gpt-5.2`, `deepseek-v4.1-flash`, `deepseek-v4-flash-0731`,
`deepseek-v4-pro-0813`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.5`,
`gemini-3.1-pro`, `gemini-3-flash-solo`, `minimax-m3`, `minimax-m2.7` all
answer `1005 {"plan":5}` on Free accounts; `search_agent`, `gpt-5-paygo`,
and `gpt-5.1-paygo` were dropped after review. The intl agent roster is now
the 7 verified-usable rows, and discovery no longer re-adds removed rows: the
intl discovery source is the agent picker (`batch_get_detail_param`,
`usage=chat_completion`) and only rows already in the static roster are kept —
a discovered id outside the roster is dropped instead of cloned from a
template, so a sync/update cannot republish models the account cannot serve.
- **Provider detail: one "Test all models" button drives per-card tests.** The
button directly triggers each model card's own test runner (cards register
their probe via the card→grid registry), so every card reports its own live
status inline. There is no dedicated batch API or SSE probe path — the
earlier experimental SSE batch route was fully reverted from the probing
service, store, and contracts.
- **Custom providers: advanced capability checklist saved into
`service_kinds`.** The dashboard's advanced capabilities (vision, tool
calling, reasoning, …) are stored on `CompatibilityProfile.service_kinds`
and enforced by backend validation. An absent `service_kinds` means "all
kinds" for backward compatibility; `llm` is always included, so an older
custom provider without capabilities still routes as a chat model.
- **Free-pi provider (bundled): adapter + OAuth + quota + live discovery.**
The free-pi backend (`api.freepi.ai`) is now a bundled provider serving the
OpenAI-completions wire with a JWT bearer. Login is GitHub device-code
(`freepi-oauth-capture.ts`); the quota collector reads `GET /me` (USD daily
budget, daily/bonus/premium credits); discovery reads `GET /client-version`
and keeps the whole live catalog, with the bare `deepseek-v4-flash` id
remapped onto the CLI default `deepseek/deepseek-v4-flash`. The adapter
registers an ad session (`/ads/next` + `/ads/impression`) before chat —
upstream answers `ads_required` unless a session has shown ads — and maps
`guest_unavailable`/`model_requires_credits` → quota, `model_at_capacity` →
capacity, `upstream_error` → platform unavailable. The static roster is the
offline fallback and carries only the four Free Unlimited rows
(`deepseek-v4.1-flash`, `glm-5.3-flash`, `particle`,
`deepseek/deepseek-v4-flash`); the v4 row was dropped per operator request.
Live-verified: guest sweep (4 free rows pass, 26 refused with
`guest_unavailable`), GitHub sweep (23/30 pass, 4 model_at_capacity, 2
credit-required, 1 upstream 404), and direct chat through the gateway.
- **Free-pi probing scripts.** `scripts/provider-probing/freepi/`:
`probe-freepi.ts` (guest/device identity, `/me`, `/client-version`, chat,
sweep), `freepi-oauth-capture.ts` (device-code login → JWT capture), and
`freepi-shared.ts` (upstream wire helpers). Tokens are never printed.
- **Probe scripts restructured: `scripts/scratch/` removed.** All scratch
files moved into `scripts/provider-probing/` by domain (qoder → grpc/direct/
tools/dev/inspect, trae stays in trae/), relative imports fixed, and
references updated everywhere. Duplicates merged: `export-provider-accounts.ts`
  - `qoder-export-accounts.ts` → `lib/export-accounts.ts` (generic helper) with
  the qoder wrapper; `qoder-raw-wire-probe.ts` + `qoder-toolcall-audit-probe.ts`
  → `qoder/inspect/qoder-wire-audit.ts`. The `README.md` layout now documents
  the full tree.

### Changed

- **Probe mode is global (Settings), not per-provider.** The fast/minimal vs
detail probe toggle now lives in the runtime settings
(`useRuntimeSettings().modelProbeMode`); per-provider headers and
localStorage flags were removed.
- **Qoder native device identity hardened: generated headers no longer sent,
disk cache + majority vote.** Adopted from the donor reference
implementation: a generated (software) identity is no longer sent as the
full `cosy-machine*` machine-header set — the upstream filters the daily
CREDITS campaign when a full set of derived headers appears (donor issue
#10), so generated identities now send only `cosy-machineid` + os +
hostname, while native UMID identities keep the full six-header set. A
per-realm disk cache (`machine_identity.json`) keeps the device identity
stable across container rebuilds, and fresh mints use a majority vote
(2–3 samples) to stabilize the bridge's VM-classification jitter. When the
bridge fails entirely, the cached identity (even expired) is preferred over
a generated one. The allocation path now skips a cached token that is
already bound to another account (unique-index invariant).
- **Free-pi upstream error codes align with gateway conventions.** `guest_unavailable`
and `model_requires_credits` now map to `policy_rejected` (403), and
`model_at_capacity`/`model_unavailable` to `platform_unavailable` (503),
so each `GatewayErrorCode` carries one consistent status.
- **Qoder machine identity now OS-derived; vendor bridge removed.** The
`vendor/qoder-umid/` tree (runtime-info ELF/PE/Mach-O binaries, mini-ELF
bundle) and `scripts/tools/extract-qoder-umid.ts` are deleted. Identity is
now derived deterministically from the host OS fingerprint + account uid
(donor-style `derive_id` pattern): UUIDv4-shaped machine id, base64url
machine token, 18-hex type/code. Same host + same account → same identity;
accounts are isolated by the uid salt. The Dockerfile's umid `chmod` step,
`CARTETHYIA_QODER_UMID_MINI`, and related docs/config are removed.

### Fixed

- **Recover is now offered for any account with a recorded failure category,
not only those parked in an account-wide cooldown.** The quota-check path
can stamp `rate_limit_transient` without moving status/`cooldownUntil`, so
a rate-limited account previously rendered "Rate limited" with no way to
clear it. `AccountRow` and the health dialog now show Recover whenever
`lastErrorCategory` is set (except `auth_invalidated`, which needs a
re-login).
- **Console probes now carry Perch's required system prompt in the compiled
binary.** `PERCH_SAFFRON_SYSTEM_PROMPT` used to be read from
`saffron-system-prompt.txt` via `readFileSync(import.meta.dir)`; the
standalone binary has no `.txt` asset, so it silently shipped a two-line
fallback and every provider-detail probe answered `403 perch_surface_required` while source-level probes succeeded. The prompt is
now a bundled TS literal (test asserts it matches the research copy), and
`PerchAdapter` uses `context.outbound_fetch` for ticket, account, and
model-call instead of `globalThis.fetch`. Verified live 2026-11-08 on the
exact console probe path with the DB credential: `standard 1m` → 200.
- **Fast probe uses `"ping"` with 64 max output tokens.** The fast probe
prompt is now `"ping"` (was `"How are you?"`) and
`PROBE_FAST_MAX_OUTPUT_TOKENS` is 64 (was 32), so quick checks stay cheaper
while remaining above entropy thresholds. The detail probe keeps the
identity prompt at 256 tokens.
- **Perch rate limits now cool the account so routing fails over.** Perch's
`turn_rate_limited` answers on every ticket mint while the window is
exhausted. The adapter now stamps every upstream verdict (`rate_limited`,
`policy_rejected`, `platform_unavailable`) with `origin: "upstream"` plus
`providerCode`/`providerId`, so the account health machine sees it; the
classifier maps `turn_rate_limited` to `rate_limit_transient` with a 24-hour
cooldown and routing picks a sibling account instead of hammering the same
key all day.
- **Free-pi device login keeps one account per GitHub user.** The device flow
used to label every login `freepi-device`; the OAuth identity fingerprint
collided on that static label, so a second login silently replaced the first
account. The JWT now resolves the GitHub identity (`sub` / `email`) into the
account label and `auth_state`, so different GitHub users land on different
rows — the same re-login identity fix as the Cursor fallback.
- **Perch browser login resolves the GoTrue user email as the account label.**
Without it the exchange fell back to the provider-id label and every Perch
login collided on one identity fingerprint, so a second login replaced the
first account.
- **Qoder probes default to the COSY surface.** The adapter and probe default
`surface` changed from `grpc`/`ide` to `cosy`; the `cmodel` identity-prompt
probe workaround is removed. `deepseek-v4.1-flash` and
`qwen3.8-flash` verified live (2026-11-07) at 200 via COSY.
- **Client-version fallbacks refreshed for every provider except Devin.** The
shared cursor client-version fallback and opencode fingerprint now match the
pinned versions; Devin stays static (its version is not fetched). The
version monitor tests were updated accordingly.
- **Recover surfaces for active accounts with per-model cooldowns.**
`isRecoverable` now includes cooldown state (`cooldownUntil` and a present
`activeModelCooldowns`), so Recover appears exactly where a refresh would
otherwise hit a per-model cooldown.
- **Refresh-token button removed from the dashboard.** The separate "Refresh  
token" button and its hook/type are gone from the account row; the backend  
`/console/api` refresh route is retained so API consumers and older  
dashboards keep working.

- **WorkBuddy removed; data migrates to CodeBuddy automatically.** The buddy
family is now `cb`/`cbcn` only — `workbuddy` and `workbuddycn` providers and
the TuringShield SDK (`vendor/turing-sdk/`, `turing-device-token.ts`) are
deleted. Migration `0045` repoints every dependent row (accounts, models,
routing settings, telemetry) from `workbuddy` → `cb` and `workbuddycn` →
`cbcn`, mirroring the opencode rename pattern. Device-token headers now fall
back to the captured token (auth_state / `CARTETHYIA_DEVICE_TOKEN_FILE`);
the qimei36 device binding is not carried over and is re-derived per account.
Cross-channel credential warning removed from the dashboard.
- **Assets: all raster images converted to WebP and resized to display**  
**needs.** The bundle drops from ~30 MB to ~3.4 MB (-89%). Console background  
3840×2160 JPEG (12.9 MB) → 1920×1080 WebP (179 KB); share backdrop  
2560×1440 PNG (7.5 MB) → 1920×1080 WebP (145 KB); story art and  
documentation screenshots recompressed (WebP q75-80, screenshots capped at  
1600px). Callers updated to the `.webp` paths; social-card dimensions in  
`dashboard-assets.ts` and README updated to the new 1200×393 output.

- **Trae: entitlement model refusals (`1005`/`4015`) surface as
`quota_exceeded`, not platform faults or auth failures.** Verified live
(2026-11-06): identical wire streams fine on a paid-capable account while a
Free account is refused with these codes, and the refused account's token
still answers `GetUserInfo` 200. They previously fell through to
`platform_unavailable` (502), which misattributed a quota/plan wall to a
transient fault.
- **Trae: the pay/quota collector now reaches the right host and parses the
real entitlement shape.** The intl pay default was the US host, which
refuses region `sg` (or region-unrecorded intl) accounts with `401 code 1001`; it now defaults to the SG host like the core does, and a recorded
`region` picks its own pay host via `TRAE_REGION_PAY_HOSTS`. The entitlement
parser read a shape that does not exist (`data.entitlement_list` /
`ent_title` / `total` / `remain`); it now reads the live
`user_entitlement_pack_list` (`display_desc`, `entitlement_base_info.quota`
caps, v2 `usage_summary` on CN), so Free/paid plans report their real caps.
- **Trae: the data-plane header builder no longer sends `x-ide-token` or
`store-country-code`.** The canonical client (Trae 1.107.1 bundle) does not
send them on chat/agent; they are OAuth/business-host headers that the quota
collector adds explicitly. The probe scripts match the adapter's reference
wire exactly.
- **Trae: harness-aligned semver + traffic headers.** The adapter now sends
`X-App-Version`, `X-App-Version-Code`, and `x-ide-version` (from
`getTraeVersion()`) plus `request-traffic-type` (`agent`/`chat` per surface),
matching the 3.6.13 harness inventory. Verified live via A/B sweep: outcome
identical with and without them (audit + evidence:
`documentation/research/trae/2026-11-06-trae-header-payload-builder-audit.md`).
- **Antigravity: replayed thinking without a signature is dropped on Claude
routes.** The upstream requires every replayed `thinking` block to carry a
`signature`; a Chat-surface client replays reasoning as a bare
`reasoning_content` string, so the replayed `thought` part was unsigned and
the upstream rejected the second turn of a session with `400 messages.N.content.0.thinking.signature: Field required`. Claude routes now
drop unsigned reasoning blocks (the donor's `drop-unsigned-thinking`
behavior); signed reasoning still replays. Gemini routes are untouched.
- **Antigravity/Gemini/Factory: reasoning signatures are preserved from
upstream responses.** `responseParts` now extracts `thoughtSignature` from
Gemini-family response parts and the adapters forward it on the canonical
reasoning event, so a signature received upstream survives the round trip
and replays correctly on the next turn.
- **Qoder: provider request/response capture now shows the gRPC chat call,
not the PAT exchange.** The payload-capture wrapper only saw HTTP `fetch`
calls, and Qoder's production chat transport is gRPC — so Request Detail's
Provider Request / Provider Response panels showed the PAT → job-token
exchange body (`center.qoder.sh/api/v1/jobToken/exchange`) for PAT accounts
and nothing at all for OAuth device-token accounts. The gRPC adapter now
fills the capture sink directly: the translated request line (grpc method,
host, allowlisted metadata, body) and a stream summary (chunk count, echoed
model, usage, stop reason, status). Credential headers (`authorization`,
`cosy-machinetoken`) are excluded, matching the HTTP capture allowlist.
- **Antigravity: tool schemas with `anyOf`/`oneOf`/multi-type are flattened
before dispatch.** The upstream (Claude-route) validates tool schemas as
strict JSON Schema draft 2020-12 and rejects *every* `anyOf` / `oneOf` /
multi-type `type: [...]` declaration — even a degenerate `anyOf` of two
identical string schemas — with `tools.N.custom.input_schema: JSON schema is invalid`, failing the whole request. Tools declaring unions (e.g. OMP's
`task` tool's `model` field) now ship the most permissive single type
(string when a choice is a string), recursively through `properties` and
`items`.
- **Qoder: prompt-cache hits are now estimated locally.** The upstream never
reports cache hits (verified live on gRPC and IDE HTTP: `cached_tokens`
absent, usage absent after terminal). Qoder now uses the shared session-cache
estimator the Trae and Kiro adapters use: the longest previously-sent
message prefix in the session counts as cached. The gRPC surface also had
to carry upstream usage on the terminal event (the upstream streams `usage`
in a trailing chunk after the finish reason, which the old code dropped) —
this restores usage telemetry and powers the estimate. Chat/Responses/
Messages surfaces all read `cached_input_tokens`, so the estimate shows up
everywhere usage does.
- **Qoder: model-server host `api2-v2.qoder.sh` is dead and routing now
falls back to the alive gateway set.** Live DNS verification (2026-11-07):
`api2-v2.qoder.sh` is NXDOMAIN on every resolver (Google/Cloudflare DoH,
local, CN), so the gRPC model-server and IDE `/model/v1` surfaces are
unreachable. The region endpoint sync
(`/algo/api/v3/service/region/endpoints`) decrypted to `inferNodes = [api1]`
etc. The adapter default surface is now legacy COSY (`cosy`), hosts are
tried in order (`api1` → `api2` → `api3`), and the intl gRPC/IDE host
constants point at `api1` instead of the dead `api2-v2`. Legacy COSY on
`api1`/`api2` verified live: 200 + full stream with model `auto`. Evidence:
`documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip` (`2026-11-07-qoder-host-inference-fallback.md`).

### Removed

- **WorkBuddy providers and the TuringShield SDK.** `workbuddy` /
`workbuddycn` integration folders, `turing-device-token.ts`, and
`vendor/turing-sdk/` are deleted. The device-token header path now uses the
captured token only; migration `0045` moves any stored WorkBuddy data onto
CodeBuddy (`cb`/`cbcn`).
- **Per-model system-prompt scope from the dashboard dialog.** The per-model
section is gone; custom prompts for models are no longer editable in the UI
(stored rows are untouched).
- **Dashboard cross-channel credential warning.** The interchangeable-token
warning (CodeBuddy/WorkBuddy) is removed along with the provider pair that
motivated it.

## [2.7.8] - 2026-11-05

### Fixed

- **BYOK custom providers: operator-selected wire is the contract.** A custom
provider created with "Chat completions" previously also advertised
`responses` (the OpenAI wire pair default), so discovery reclassified
gpt-5/gpt-6 ids onto `/v1/responses` — even when the upstream only serves
chat — and the model test timed out. `resolveByokWireProfile` now serves
exactly the selected family (`chat` → chat only, `responses` → responses
only, `messages` → messages only). VPS installs that selected chat were
unaffected; local installs whose model was re-fetched as responses were not.
- **Qoder gRPC stream: no usage after terminal.** The gRPC surface yielded
`usage` *after* the terminal event, which the strict Anthropic Messages
encoder rejected — the gateway then emitted a `transport_unavailable` error
frame after `message_stop`, so Anthropic clients saw "upstream closed the
stream before it finished" and retried in a loop. `usage` is now emitted
before finish only (the terminal carries usage itself). Chat and Responses
surfaces were unaffected.
- **Auth surfaces: 16px input font to stop iOS auto-zoom.** Login/setup
inputs inherited the 13px compact body token; iOS Safari auto-zooms into
any focused input under 16px, which read as the page zooming itself while
typing. `.auth-form-inner .form-input` now forces 16px.

## [2.7.7] - 2026-11-05

### Added

- **Qoder tool-call stitching fix (gRPC) — single + paralel.** Tool calls
streamed via `model.chat.ChatService` now splice correctly: continuation
fragments (`id: ""`) attach to the current announced call instead of getting
a fresh fallback id — upstream sends `index: 0` for every parallel call, so
index-based pinning misattributed arguments between calls. Verified live via
opencode → CarteLocal: single shell call and multi-call parallel blocks
(`echo parallel-A` + `echo parallel-B`) both execute with full arguments
(previously `Invalid arguments ... Missing key` and glued JSON
`{"command":"..."}{"command":"..."}`). Regression tests in
`test/providers/integrations/qoder-grpc-wire.test.ts`. Documented in
`documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip` (`2026-11-05-qoder-tool-calling.md`) §6.
- **Qoder adapter restructured into focused modules.** `qoder.ts` is now a
re-export barrel over `qoder-auth` (PAT→job-token exchange v1), `qoder-cosy`
(COSY signing), `qoder-chat` (legacy builder/transport), `qoder-ide`
(probe-only surface), and `qoder-adapter` (transport selection + surface
contract). Public imports unchanged.
- **Qoder User-Agent aligned to live captures.** CLI/COSY/device flow now use
`Bun/1.4.2`, the IDE surface `Bun/1.4.4`, the job-token exchange
`qoder/<version>` (was `Go-http-client/2.0`), and the openapi/business
surface `Qoder`/`QoderWork`. Disambiguation: `Bun/1.4.2` is the CLI/device
flow UA, `undici` is the **app/worker** UA (Electron-hosted Node undici) —
see `documentation/research/qoder/2026-11-11-qoder-worker-chat-wire-capture.md`.
- **Qoder PAT→jobToken exchange moved to the v1 endpoint.** intl now uses
`POST center.qoder.sh/api/v1/jobToken/exchange` with a plain JSON body
`{personal_token, machine_id}` and uppercase `X-Request-ID` (was the v3
scrambled-COSY endpoint). `userId` falls back to the machine id (v1 does not
return it) — sufficient for Bearer surfaces; COSY signing uses it as the
identity placeholder.
- **Qoder machine identity headers from the real runtime.** `qoderMachineHeaders`
now reports `cosy-machineos`/`cosy-machinehostname` from the actual platform
(was hardcoded `x86_64_linux`/`DESKTOP-QODER`); COSY chat headers include the
machine id set. gRPC version metadata is no longer hardcoded (follows
`getQoderVersion()`), and `X-Session-ID` is consistent across transports
(`sha256(userId:model)`).

### Changed

- **Qoder gRPC `tool_choice=required` is omitted.** The gRPC surface rejects
it with 400/406/422 on most models (verified in the live 150/150 matrix);
the neutral prompt carries the intent instead. `auto`/named choices are still
sent.

### Added

- **Qoder gRPC transport as the default billed surface.** The gateway now
dispatches Qoder chat through `model.chat.ChatService/ChatCompletionStream`
— the only proven carrier of real 1M-token context (the HTTP IDE surface
caps at ~256 KiB). The proto is embedded as a generated TS source, so it
works from source, dist, and the standalone binary. Free-tier rows (`lite`)
keep routing to the legacy COSY surface, which serves them without credits.
- **Antigravity &amp; Codex web search.** `antigravity/gemini-2.5-flash` and
`codex/gpt-5.6-luna` are registered as `websearch` routes. The Gemini/CCA
`googleSearch` hosted tool is now emitted for `web_search` tool requests —
upstream answers with real grounding chunks (previously empty).
- **OpenCode websearch plugin injection.** The OpenCode injector writes a
`plugins/<provider>-websearch.js` plugin that routes OpenCode's websearch
tool through the gateway's `/v1/search`, reading the provider block from
opencode.jsonc as the single source of truth; apply writes it, reset removes
it, and the provider key follows the selected websearch provider name.
- **Higher server body ceiling.** `CARTETHYIA_SERVER_MAX_BODY_BYTES` defaults
to 16 MB so a 1M-token request fits the gateway's own ingress.
- **Qoder probe reports the real serving model metadata.** Provider tests for
Qoder default to the modern `/model/v1` surface, whose `raw_usage` names the
model that actually served the turn (`provider_model`, `supply_model`,
`target`, …) — the production transports (gRPC/COSY) echo only opaque roster
keys. Test Model now shows e.g. `qwen3.7-plus` / `bailian-qwen3.7-plus-free-260401`
instead of the roster key, and a probe can still pin a specific surface via
the `surface` override.
- **Qoder cmodel probe prompt workaround.** The gRPC surface refuses one
roster row (`cmodel` / Cantus) with an upstream 406 when probed with the
identity prompt; its probe uses `halo gpt` instead — a greeting that
*asserts* the wrong identity, which the upstream guardrail allows (it only
blocks identity *questions*), and the model corrects it on its own
(*"saya Claude, asisten AI buatan Anthropic"*). Verified consistent 3/3
live probes. Other models and providers are unaffected.
- **Qoder probe metadata research.** `documentation/research/qoder/2026-11-04-qoder-probe-provider-metadata.md`
captures the IDE surface's `raw_usage` provider metadata for every roster key
(real supply model, region, target) — verified live across multiple probes.
Documents that `raw_usage` is intermittent (re-probe to capture), that slots
like `fast`/`performance` rotate their backing model, and that routed
profiles (`ultimate`, `smodel`, `cantus`, `performance`) expose
`supply_account` / `supply_region`.
- **Qoder credit usage in the Requests table.** COSY terminal frames report
`credits`; they are now normalized into `credit_used`, so Qoder requests
show their credit spend (Coins column) like buddy already did.
- **Qoder daily-credits claim revalidated with the real UMID.** The daily
CREDITS campaign is now `act-20261102-503` (was `act-20261027-489`). A
claim with the **real Windows UMID** (`vendor/qoder-umid/umidpack/runtime-info.exe`)
succeeded (`CLAIMED` +100, ALL_MODELS, 30 days) on an account that was
previously same-person blocked on the old campaign — `addOnQuota` went 100 →
  200. Confirmed the CREDITS campaign only surfaces with the genuine UMID
  headers (generated identity keeps it hidden) and that the sash API host is
  `openapi.qoder.sh` (not `qoder.com`), with response shape
  `{ showCampaign, claimable, campaigns }` and claim by `campaignId` UUID.
  Documented in `documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md`
  (Part F).
- **Qoder UMID bridge fallback via the vendored mini-ELF.** When the native
vendored ELF is absent (slim Docker containers), `qoder-umid.ts` now
extracts `vendor/qoder-umid/qoder-umid-mini.tar.gz` (static glibc bundle) to
`$XDG_CACHE_HOME/cartethyia/umid-mini` and runs it with the staged
`LD_LIBRARY_PATH` — so containers get a genuine UMID instead of falling back
to the generated identity. Bridge priority: native ELF/Mach-O → mini-ELF →
WSL/PE (Windows) → generated.
- **Manual Qoder credits claim in the console.** New `POST /accounts/:id/claim-qoder-credits`
endpoint (mirrors ZCode's `claim-gifts`) mints/binds a native UMID, lists
the sash campaigns with UMID headers, and claims the CREDITS
`CLAIM_BENEFIT` campaign by `campaignId`. The provider-detail account row
gets a "Claim credits" button for qoder/qodercn accounts. Result states:
claimed / already_claimed / nothing / error; quota cache/snapshot invalidated
on a successful grant. PAT (`pt-…`) accounts are exchanged to a job token
first — the exchange now binds the machine identity (`machine_id` +
`machine_token`) like the real client, and the platform machine id
(`%APPDATA%/Qoder/cache/machine_token.json`) is used in the Cosy headers, so
the request matches the signature the server expects.
- **Qoder probe tooling reorganized and deduplicated.** The 22 probe scripts
under `scripts/provider-probing/qoder/` were consolidated to 13: one
canonical chat probe (`chat/probe-qoder.ts`) absorbs the transport,
response-shape, cross-model, business-header, legacy-reply, and lite-1M
probes via flags (`--surface`, `--model-echo`, `--cross`, `--headers`,
`--lite`); entitlement/roster/account-info merge into
`quota/qoder-entitlement-probe.ts` (`--header-mode`, `--full`, `--roster-key`);
gRPC meta absorbs the modelname probe (`--echo-only`); context and
session-retention merge into `chat/qoder-capacity-probe.ts` (`--mode`).
New shared helpers `lib/shared.ts` (machine identity, headers, body
builders, SSE reader, account loader, redacting printer) and
`lib/grpc.ts` (gRPC client factory) eliminate the duplicated code — no
`any` casts, one version constant, verified typecheck and runtime.
- **Custom User-Agent override in Routing Strategy.** The Client identity box
now has a free-text custom User-Agent input that overrides the provider's
native identity (persisted to new `provider_routing_settings.custom_user_agent`
— migration `0043`). Empty uses the native identity (shown as the default);
"Reset" clears the override. Dispatch applies the custom value even when the
provider would otherwise stamp its own header. Routing only sees it when
set — otherwise native/route identity applies. The Advanced section
(collapsed by default) keeps the per-proxy max inflight control and locks
the Client identity box while open.

### Fixed

- **Qoder roster: only `lite` is free.** `qfmodel` is billed — upstream's live
`is_free` flag for it is a plan-tier marker, not a zero-cost tier (a free
account gets `quota exceeded` 116). The static roster no longer marks it
free; live discovery still honors upstream's own flag.
- **Qoder probe reports the upstream model echo.** The gRPC surface has no
HTTP body for `readReportedModel`, so provider Test Model returned no
`reportedModel` for Qoder. The adapter now emits a `response_start` event
with the echoed model, and the probe falls back to reading it from the
canonical events — Test Model now shows the real model the upstream ran
(e.g. `smodel` → `azure-gpt6-astra`).
- **Qoder gRPC proto path on Windows.** The proto is materialized from the
embedded source (no `file:` URL path issues), fixing `no such file or directory` at runtime.
- **Quota and usage floor no longer exclude accounts from routing.** The
router previously dropped candidates whose quota window was exhausted or
below the configured floor (`quota_exhausted`), which could make a model
unreachable even when the operator wanted it tried — including free-tier
models and Qoder `qwen3.8-flash`. Quota is now an ordering-only signal
(`creditPriority`): exhausted/below-floor accounts stay eligible and are
ordered behind unknown/positive accounts, and the upstream is the one that
answers (its refusal is then classified into a cooldown as before). Removed
`belowUsageFloor`/`earliestWindowResetMs` and the floor branch from
`EligibilityEvaluator`; updated docs (`04-usage-floor.md`, architecture) and
routing tests accordingly.
- **Per-IP abuse ceiling tuned to 540 requests/minute.** The default
`IP_RATE_MAX_PER_WINDOW` and the service fallback were 240 requests per
60 s window (4 RPS/IP), which internal/gateway-originated traffic could hit
and lock out legitimate requests with `rate_limited` 429. Raised to 540
(9 RPS/IP); ban threshold follows (1080). `.env.example`,
`documentation/reference/configuration.md`, and comments updated. API keys
remain unlimited by default (`requestsPerMinute` null when unset).
- **Qoder UMID mini-ELF preferred in containers.** `qoder-umid.ts` now
detects containers (`/.dockerenv`, `/.containerenv`, or cgroup matches) and
uses the `qoder-umid-mini.tar.gz` bundle (static glibc, mints `isVm:false`)
instead of the native ELF, so a containerized deployment is not flagged as a
  VM. `CARTETHYIA_QODER_UMID_MINI=1` forces mini on any Linux host; `=0`
  disables the auto-detection. Non-container Linux hosts keep the native ELF.
- **Test runner parallelism capped.** `scripts/test/run.ts` now passes
`--parallel=<n>` where `n = min(availableParallelism(), 4)` (override with
`CARTETHYIA_TEST_JOBS`), so the suite no longer pins every core (Bun 1.4+
defaults to all CPUs). Verified: 16-core host runs at 4x PARALLEL; env
override honored.

## [2.7.6] - 2026-11-04

### Added

- **CLI tools streamlined to four supported CLIs.** The console's CLI tools
registry is trimmed to Claude Code, Codex, Kilo, and OpenCode (the removed
tools were guide-only and had no real injector). Each tool gained a SDK
picker (OpenAI Compatible, OpenAI Responses, Anthropic Messages, Gemini),
multi-select model picker that appends to the config, a semi-flat config
preview, and a YOLO mode toggle (default on). Applying a config preserves
existing provider entries and backs up the previous file with a `.bak`.
- **Dialog unsaved-change protection is now reusable.** Forms register their
dirty state through `useDialogDirty`; the dialog then blocks backdrop
clicks, the close control, and Escape while edits are unsaved, shakes the
panel, and warns. API-key forms and the preset editor use it.
- **The inject-system-prompt dialog auto-saves.** Every dropdown/toggle/text
change persists immediately; the Save changes button is gone.
- ZCode Start Plan as a separate `zcode-start` provider with device sign-in,
JWT import, model-scoped quota grants and activation/expiry times. Manual
gift claims distinguish claimed, already-claimed, CAPTCHA, partial and failed
outcomes. Daily automatic claims are off unless explicitly enabled with
`CARTETHYIA_ZCODE_AUTO_CLAIM=true` and skip disabled/cooling accounts.
- **Qoder claim300 Pro-Trial device/login scripts.** `scripts/provider-probing/qoder`
gains a device-flow login (UMID-backed, mirroring the desktop IDE's claim
flow) and a URL-only helper for fresh Google SSO accounts, plus PAT minting
and the research breakdown of the farm injector / UMID packaging.
- **GitHub Copilot wire mode switch.** `opencode-copilot` is the default wire
for Copilot accounts, with `vscode-client-real` opt-in (matching the real
VS Code extension transport).
- **Telemetry records degenerate stops.** A short output ended by `stop`
(rather than `length`/`tool_calls`) is now recorded as a degenerate stop, so
truncation-like completions are visible in telemetry instead of being
indistinguishable from normal stops.
- **Research and probe tooling.** Qoder IDE 1.38 unpack (Inno 6.4 via
innoextract 1.13) with dynamic-endpoint wire, Copilot wire audit, OpenCode vs
Copilot wire comparison, Antigravity wire verification, and backend probes
(`scripts/provider-probing/…`) for the live surfaces.

### Fixed

- Commandcode Go uses the CLI generation envelope and NDJSON stream. Streamed
responses preserve buffered text, selected model identity and typed aborts.
Billing uses the account's organization and reports monthly credits,
purchased/free balances, five-hour/weekly limits and reset times separately.
A model entitlement refusal rests that model, not the valid account.
- Start Plan routing and dashboard availability respect grant activation,
expiry and model scope; alternative grants do not create a false account-wide
zero balance. Claims refresh both cached and persisted quota, and a daily
automatic pass drains eligible accounts across bounded pages.
- Built-in Start Plan quota windows use the short Start label while preserving
referral grant names. Quota timeout, network and JSON failures stay distinct.
- Reject ZCode Start business-error envelopes returned with HTTP 200 instead
of decoding them as successful empty completions.
- Summarize Start Plan badges as one name plus the extra-plan count and show
grant/period headings without model captions. Preserve upstream names in
titles and keep future quota windows visible. Manual gift claims remain in
provider account details rather than quota cards.
*(contributed by @TuruGasik in PR #13)*
- **Qoder tool-call arguments are stitched even when continuation chunks echo
an empty `id`.** Some Qoder roster slots (`qfmodel`/`qmodel_latest`)
re-identify every continuation fragment with `id: ""` (the first chunk
carries the real call id). The translator treated the empty string as a
fresh call id, so every argument fragment was buffered under `""` and lost —
the call was emitted with empty arguments. An empty `id` now behaves like a
missing one, so fragments re-join the pinned first-seen id per wire index
(regression tests in `test/providers/integrations/qoder-continuation-args.test.ts`).
- **Qoder IDE requests ship the toolset.** The modern IDE surface
(`/model/v1/chat/completions`) now includes `tools` in the body; without it
the upstream sees no toolset and answers with a DSML text block (or claims
no tool exists) instead of structured `tool_calls`.
- **Qoder DSML fuzzy dialect is dropped entirely.** The protocol-level
DSML-injection path is gone; tool calling is structured-only, so no text
fragment can be misread as a tool call.
- **Qoder bubbles reasoning effort for non-reasoning models and declares 1M
context.** Non-reasoning models no longer carry `reasoningEffort`, and the
IDE request declares the full 1M window.
- **GitHub Copilot not-licensed is a ban, not a cooldown.** A `not-licensed`
verdict now disables the account (no cooldown), so it stops being re-dialled
repeatedly.
- **GitHub Copilot reasoning separator keeps a space.** The chat surface writes
a space before the reasoning block instead of a blank line, matching the
reference output.
- **Free-tier models ignore the operator's usage-floor threshold.** A model the
provider marks free is exempt from the usage-floor cutoff (free tier lands on
any account regardless of credit balance).
- **`service_tier` is forwarded only to providers that support it.** Providers
without the field no longer receive a stale/unknown tier.
- **Dashboard model test/lab use the catalog output limit.** The model-test and
lab screens no longer apply a hard cap independent of the model's catalog
output limit.
- **Vision handoff bounds the context it passes.** The trailing conversation
carried to the vision model is bounded by the vision model's window instead
of the whole session.
- **Dashboard shows banned share keys and persists provider display mode.** The
share-keys list surfaces banned keys, and the provider grid/display selection
persists across sessions.
- **Cached input and share-family budgets are normalized.** Usage accounting
normalizes cached input tokens and share-family budget keys so they compare
correctly across request shapes.
- **Provider cache split is preserved; local rejections stop cooling accounts;
BYOK base-URL root is fixed; the providers list paginates.** The per-account
cache split no longer collapses, local (client-side) rejections no longer
cool accounts, a pasted BYOK endpoint resolves to its root for discovery, and
the providers list has a working pagination toggle.
- **Combos/aliases grid, share-template lifetime totals, and admission bucket
key.** The combos/aliases page uses a 2-column grid and fixes the Select
`asChild` warning; share template lifetime totals render correctly; the
admission bucket is keyed by the right scope.
- **Antigravity system prompt generalized.** The adapter no longer assumes a
single fixed wording; the reference wording is preserved in a comment.
- **Antigravity quota windows no longer fabricate credit pairs.** Fractional
allowance windows report a percentage without inventing a used/limit pair,
and per-model windows are skipped when the summary endpoint already covers
the family (rendering both doubled every row an operator saw).
- **Usage floor shows the lowest independent window.** When an account has no
pooled balance, the usage floor shows the lowest independent window's
remaining percentage instead of claiming zero credits.

## [2.7.5] - 2026-11-03

### Added

- **Wire dialect layer for chat/messages codecs.** A dialect (DeepSeek,
Qwen, OpenAI/Anthropic defaults) now resolves per model below the wire
family, giving provider-specific quirks a home instead of scattered
`if (providerId === …)` branches: `reasoning_content` field naming,
`max_tokens` vs `max_completion_tokens`, `tool_choice` support, system
message cardinality, assistant-content-required tool-call turns, Qwen
`enable_thinking`, and in-band tool-call scanning (`<tool_call>` JSON for
Qwen, DSML for DeepSeek). The resolver (`resolveDialect`) is data-driven
with precedence DB override → `ModelDefinition.dialect` → heuristic → family
default, and defaults are frozen to today's behavior (byte-identical
payloads). Migration `0040` adds `models.dialect`. See
`documentation/features/09-wire-dialects.md`.
- **Data-driven thinking/effort ladder.** The hardcoded per-model reasoning
effort clamps are replaced by a declarative rule table that resolves each
model + wire family to a `ThinkingConfig` (supported efforts + transport
mode: OpenAI effort, Anthropic budget/adaptive, Gemini level). One canonical
clamp (`clampThinkingLevelForModel`) drives chat/responses/messages, and a
clamped effort raises the output floor (`outputFloorFor`) so answers don't
truncate. Declared efforts (`reasoningEfforts` / `ModelDefinition.thinking`)
win over the table; defaults are byte-identical to before. No migration. See
`documentation/features/10-thinking-effort-ladder.md`.
- **Quota windows are filtered by the requested model family.** Providers that
report separate quota per model family (Antigravity: Gemini vs Claude/GPT;
Grok: per-product buckets) no longer block every model when one family is
exhausted. A candidate's quota windows are filtered to the ones that apply
to the dispatched model before the usage floor / exhausted-window check, so
a Claude-exhausted account still routes Gemini requests (the false 429 that
used to fire is gone). The filter is provider-specific and falls back to all
windows for providers without per-family quotas.
- **`bun run dev` now restarts the full stack on any source change.** The
dev supervisor (`scripts/dev/supervisor.ts`) previously hot-reloaded via
Bun's `--hot`, which swaps only the changed module — boot-time state
(workers, registries, scheduler leases) was never rebuilt. `dev` now runs
the supervisor, which watches the source roots (`src/`, `scripts/`,
`dashboard/src/`), SQL migrations, and dependency manifests every
`DEV_WATCH_MS` (default 3000 ms) and restarts the whole stack in place
behind the holding proxy. Manifest changes reinstall deps with the lockfile
frozen; migration changes re-run at boot. `DEV_WATCH_MS=0` disables
polling and keeps the CTRL+R-only behavior.
- **Grok request compression (zstd) and richer Responses fields.** The Grok
adapter now sends the request body zstd-compressed with
`Content-Encoding: zstd` (matching the Grok Build CLI), and the accepted
field set is widened to the Responses session/linkage fields
(`previous_response_id`, `conversation`, `stream_options`,
`prompt_cache_retention`, `moderation`, `user`, …) plus the hosted tool set
(`web_search`, `x_search`, `image_generation`, `collections_search`,
`file_search`, `code_execution`, `code_interpreter`, `mcp`, `shell`,
`tool_search`) — anything else normalizes to a flat `function` tool.
Discovery no longer keeps a process-global model cache: the per-account
catalog can differ by plan, so account B's sync no longer clobbers account
A's limits/reasoning menus. Grok quota probe now uses a streamed
`grok-4.7` probe prompt engineered to produce the literal `407` signal
("Type the number 407."), and a `402` spend/entitlement wall is classified
as `spending-limit` instead of a reading failure.
- **System Prompt presets and per-modal/provider references.** A tenant can save
reusable system-prompt presets and reference them per model, per provider, or
globally. Combos/aliases inject the preset for their requested model (its own
preset, or the global fallback). The Inject System Prompt panel exposes preset
cards, add/remove, and a multi-preset picker; disabling a preset no longer
clears its text — a separate Clear button does.
- **Share-template concurrency scope: global or per key.** A share template's
"Concurrent" limit is now explicit. `family` (default) keeps today's behavior —
one shared admission counter and cap across every recipient of the template.
`per_key` copies the cap onto each child at issue, so every recipient gets its
own limit; a per-key child with no cap is unlimited on its own slot. Migration
`0037` adds `api_keys.concurrency_scope` for both dialects. The API key form
and the share page show the active scope.
- **Vision adapter: hand images to a configured vision model instead of a
`[image]` placeholder.** When a request carries images but the selected model
is not image-capable, the gateway now forwards the image to an ordered list of
configured vision models (global setting `visionHandoffModels`), asks the
image *contents* — no chat history — and injects the description as text into
the original model's request. The original model still answers; only the image
travels. If a listed vision model is unhealthy (cooldown, quota, upstream
error), the handoff falls through to the next model on the list. If no vision
model succeeds or none is configured, the request falls back to the legacy
`[image]` placeholder and never fails because of the handoff. Config lives in
the runtime Settings (global per tenant), no migration required; the Settings
page gains a "Vision handoff models" card with multi-select, ordered picks.
- **Qoder IDE stream decoding is tolerant of upstream JSON quirks.** A new
Qoder-specific SSE decoder (`decodeQoderSseEvents`) replaces the generic
`decodeSseEvents` for the IDE surface: upstream emits `data:` frames whose
JSON payload contains literal newlines and control bytes inside string values
(e.g. `raw_usage`), which the generic decoder rejected as "Malformed SSE
line". The tolerant decoder keeps event boundaries correct while passing
those embedded bytes through, eliminating the malformed-line 500s on
auto/efficient/sonus streams.
- **Qoder response start echoes the upstream's real model key.** The
`response_start` event now carries the model the upstream chunk actually names
(`azure-gpt6-astra`, `cmodel`, `lite`, …) instead of the virtual requested id,
so reported models match reality. The requested path stays routable and
unchanged for dispatch.
- **Qoder thought-only streams are replayed instead of ending empty.** When the
upstream answers with reasoning but no text content (Sonus/Cantus thought-only
turns), the adapter replays the request (max 2 attempts) via
`fetchQoderIdeWithEmptyRecovery` to salvage a content-bearing answer, instead
of surfacing an empty completion.
- **Qoder Sonus/Cantus default to `reasoning_effort: high`.** When the caller
sends no reasoning intent, the IDE request now carries `reasoningEffort: high` for the two models that need the explicit push (verified live: Sonus
streams thinking only when an effort is present); DeepSeek-family models that
think by default are left untouched.
- **Qoder `lite` is now a real caller-facing id.** The free-tier plan package
slot is published as `lite-qwen-3.7-plus` (virtual id) instead of the opaque
`lite` roster key — 1M ctx, 64k output ceiling, free tier, multimodal input —
while dispatch still routes to the `lite` slot upstream. The alias/virtual
layer carries the rename; no schema or migration is involved.
- **Providers page: Models card gains a Show filter.** A selector next to the
Thinking effort toggle switches the grid between **All models** (default) and
**Free tier** — the latter hides every row the provider does not publish as
free (including the disabled group). The choice persists per provider in
localStorage, and both selectors use the compact `sm` size so the header stays
tight on mobile.
- **Providers page: Accounts toolbar is compact and one-row.** The account
toolbar now lays out in a single row — compact search on the left, then
Test all / Recover / Enable / Disable / Export / Delete in a stable order,
with sort/select pinned to the right edge. The search no longer stretches
full width on desktop, and the row wraps cleanly on narrow viewports with no
empty gutter.
- **Vision handoff models appear immediately after saving.** The card's model
list is now kept in sync with the runtime-settings query after it resolves
(cold cache), so a just-saved model is visible without a hard refresh — the
previous initializer froze the list on first render while the query could
still be loading.
- **Gateway-signed model test asks for a real sample.** The provider detail
"Test" button now sends a 256-token budget and a prompt asking the model to
identify itself and its knowledge cutoff, producing a useful sample instead of
a canned `ping` echo.
- **Provider list carries overview counts.** `GET /providers` items now include
`accountCount`, `activeAccountCount`, and `modelCount`, computed from two
grouped SQL queries instead of per-provider loops. The dashboard renders the
connection/model badges from these list fields, so the page no longer fires
per-card model/account fetches (2N requests → 1) and providers' heavy
per-account usage reads are gone from the card path.
- **Server-side batch-delete endpoints.** `POST /accounts/batch-delete` (tenant)
and `POST /global/accounts/batch-delete` (platform admin) delete many accounts
in a single statement, one audit row, and one cache-invalidation pass, and
return `{ ok, deleted, missing }` with per-id 404s surfaced in `missing`.
- **Daily-growth runs as a background job.** `POST /quota/daily-growth`
enqueues and returns immediately with `{ jobId }`; `GET /quota/daily-growth/status/:jobId` reports `queued | running | done | failed`
with per-account errors. Bounded concurrency 3, per-leg budget + timeout
signal, and an in-flight guard so a concurrent sweep/route cannot stamp the
same account twice in one window.

### Changed

- **Qoder dispatch defaults to the modern `/model/v1` surface with a legacy
COSY fallback.** The adapter now tries the IDE wire (`/model/v1/chat/completions`)
first — it echoes the real model key and carries 1M context + `xhigh`
reasoning — and automatically falls back to the legacy COSY surface only when
the modern surface answers an entitlement refusal (HTTP 402 / `{"code":116}`,
seen on free-tier accounts) **and** the dispatched model is a free-tier row
(`is_free: true`). For a billed model the same 402/116 is genuine quota
exhaustion (Qoder's daily exhaustion / cooldown run on a 1-day cycle) and
surfaces as-is, so the exhausted state is never masked by a fallback. A
401/403/model error is surfaced as-is and is not masked by a legacy retry.
`surface: "cosy"` remains as an explicit force-legacy option. The legacy body
is now 1:1 with the IDE worker: top-level `model` (roster key) and
`reasoningEffort` (camelCase, mapped from canonical intent) are sent alongside
`model_config.max_input_tokens` for the widest discovered window.
- **Qoder device login matches the desktop IDE byte-for-byte.** The PKCE
verifier now uses the IDE's own alphabet (`A-Za-z0-9-._~`, 43–128 chars), the
nonce is a full UUID, the client id is always sent (intl `e883ade2-…`, CN
`e93fe488-…`), and the machine id defaults to the platform hardware id
(Windows `MachineGuid`, macOS `IOPlatformUUID`, Linux `/etc/machine-id`) with
`.` machine\_id`/`machine\_token `override via device-flow parameters to reuse an IDE-held device identity. Qoder token refresh now works through the working deviceToken endpoint (`POST /api/v1/deviceToken/refresh\`) instead of throwing
"no refresh grant".
- **Qoder client identity matches the IDE build.** `cosy-machineos` is derived
from the runtime arch/OS (not a fixed macOS string), `cosy-machinehostname` is
normalized to the IDE's header-safe form, and the COSY version pins the IDE's
`1.1.80` (not the newer CLI's).
- **Qoder browser-session PAT claimer.** New probe
`scripts/provider-probing/qoder/qoder-browser-pat-claimer.ts` (removed in the
2.7.7 probe-tooling reorg — browser/cookie tooling retired) listed, created,
and revoked Personal Access Tokens (`pt-…`) from the Qoder web console using
an exported browser session cookie (Netscape cookies.txt). It handled the
console's CSRF double-submit pair (`window.csrfToken` + the
`qoder_csrf_token` cookie), capped expiry at the console's 1-year maximum, and
wrote the minted PAT only to `--out` — never to stdout. This provides the
durable identity path: a PAT is exchanged by the adapter into a per-request
job token, versus the device token the OAuth flow issues.
- **Routing prefers accounts with remaining credit, free tier to any account.**
Within the same rank group, the gateway now orders accounts with remaining
pooled credit first, then unknown-quota accounts, then known-zero last. A
model the provider marks as free (`free_tier`) is exempt: it may land on any
account regardless of credit balance. The rule applies to every provider —
Qoder included — because both signals are already per-candidate. The rank
(fresh → slow → cooling → saturated) remains the primary sort key; credit only
breaks ties inside one rank.
- **Address parsing behind the admin gates and SSRF policy is now one
implementation.** Three previously separate parsers (SSRF allowlist, trust
boundary, drain admin gate) each had their own IPv4/IPv6/CIDR logic with
subtle differences (IPv4-mapped spellings, bare-CIDR handling, dotted-quad
IPv6). A single `src/network/ip-utils.ts` now serves all of them with each
consumer's semantics preserved exactly — fail-closed stays fail-closed,
allowlist strictness is unchanged, and the client-IP canonicalization key is
byte-identical — pinned by a 45-spelling parity test. No operator-visible
change; this closes the gap where the three gates could disagree on the same
address.
- **Estimated token counts now appear in usage/telemetry.** When
`/v1/messages/count_tokens` answers from the local estimator (model on a wire
family without a native count endpoint), the request previously vanished from
telemetry entirely — no row, no latency sample, no Console Log line, because
the handler finalized nothing. It now flows through the same telemetry
finalizer as every other request (status completed, estimated usage with
null cost), so the usage page counts it and the latency histogram no longer
has a blind spot for that route.
- **Native service routes share one request-handling core.** Image generation,
systemone, and the Responses-compact dispatcher now use the same shared
helpers (credential resolution, scope check, body validation, fetch context,
usage read-back) as the token-count and websearch routes instead of private
copies that had already drifted — image/embedding JSON responses now carry
`cache-control: no-store`, which their private serializer forgot.
- **Routing eligibility types match reality.** The evaluator no longer casts
the route candidate to an anonymous structural extension: the post-catalog
shape (`RoutedCandidate`) is a shared type, `quota_windows` is properly typed
end-to-end, and dead defensive fields (`account_locked`/`locked`, producible
by nothing) with their unreachable rejection reason are gone.
- **Messages OAuth thinking-budget requests fail fast and clearly.** An OAuth
request whose thinking budget cannot fit under the OAuth `max_tokens` ceiling
used to be encoded with a max\_tokens above the ceiling and rejected by
Anthropic with an opaque upstream error; it now returns a clean local 400
naming the budget/ceiling conflict.
- **PKCE verifier for the Qoder device flow is fully CSPRNG.** The verifier
bytes already came from `randomBytes`, but its length (43–128) was drawn from
`Math.random` — RFC 7636 requires the whole verifier to come from a secure
generator. It is now a fixed 64 characters (inside the IDE's own range, so
fingerprinting fidelity is kept) from CSPRNG end to end. Note this refines
the device-login entry above: the alphabet stays byte-identical with the
IDE, the length is now a fixed 64 instead of variable.
- **Cursor roster cache is bounded.** The per-account model-roster cache was
unbounded, keyed by the raw credential, and never evicted expired entries —
token rotation grew it without limit. It is now capped at 1024 entries with
oldest-first eviction and keyed by a hash of the credential instead of the
token itself.
- **SSE streams reconnect with backoff and close server-side.** All console SSE
hooks share one EventSource wrapper with exponential backoff + jitter (2s →
60s cap, reset on open) and the visibility gate. Streams gain a max lifetime
(45 min) and idle timeout (5 min, heartbeats don't count) that send a
terminal `close` event, so abandoned tabs stop holding subscriptions and
timers forever. Notifications/share-stats sampling is process-wide (one
sampler → subscriber set) instead of per-connection timers; the encoder is a
shared module-level `TextEncoder`.
- **Update delivery is unified.** The notifications stream's `update-available`
event drives the update badge/dialog; the old 30-min release poll is now a
cold-start fallback fetch only. The 3s `/updates/status` poll remains only
while an install is applying (the gateway restarts mid-install, so SSE is not
reliable there).
- **Usage-page streams merged.** In-flight and requests streams are one
connection with one preflight (backend `/live/in-flight/stream` tags frames by
kind); the two pool-health hooks are unified and the dialog uses live health
events instead of a 10s poll.
- **The route snapshot rebuilds eagerly in the background.** Invalidation marks
the snapshot dirty and schedules a debounced (\~500ms) background rebuild;
requests keep serving the last-completed snapshot while it runs (single-flight
guarded). The rebuild cost is off the page-open request path.
- **Foreground-aware scheduling (InvokeGuard).** A process-local gauge counts
console requests and proxy in-flight activity; the scheduled-task registry and
sweep runner defer ticks/waves while foreground is busy (bounded pause, not
skip). Account-health sweep interval 30s → 60s, OAuth/buddy sweeps get pass
budgets, and the client-version monitor's first external check moves to 90s.
- **Startup defers heavy work.** The bundled model catalog (73 providers'
integration modules) is resolved and seeded on the first snapshot build
instead of before listen; console/worker integration modules (buddy/qoder/
cline/kiro) are lazy-imported off the boot graph; thinking/dialect resolver
and BYOK-fingerprint caches are size-bounded; `pino-pretty` moves to
devDependencies. `CARTETHYIA_DISABLED_TASKS` is documented.
- **Bulk account actions are concurrency-bounded.** Dashboard delete/recover/
enable/disable run 3 at a time instead of all-at-once.
- **Gzip skips small responses.** Console responses under 1KB are no longer
compressed (the sync-gzip cost exceeds the bytes saved); SSE stays excluded.
- **Telemetry flush floor raised.** Under load the flush floor is 200ms instead
of 50ms, so flushes collide less with console reads.

### Fixed

- **Vision handoff no longer forwards a giant session to the main model.** A
handoff on a large CLI session (700+ tool-result turns, multi-megabyte body)
replaced the image parts but still sent the whole transcript — including
hundreds of tool results — to the text-only model verbatim. Upstreams reset
or reject such payloads (502/ECONNRESET) even though the handoff only needs
to describe the attached image, appearing as "broken on large sessions"
(small fresh chats worked). The handoff now condenses the request first: for
a huge session it keeps only the system prompt plus the active
image-carrying turn; small requests pass through untouched. The description
is also explicitly framed as an automated vision-model description, so the
main model no longer treats it as prose the user typed.
- **Postgres traffic telemetry no longer falls back to SQLite SQL.** The
dialect check (`isPostgres`) reported Postgres for any handle whenever the
process env was `CARTETHYIA_DB_MODE=full`, so a SQLite handle received
SQLite bucket/percentile expressions (`strftime`, `::` casts) and every
canonical telemetry read (chart buckets, summary percentiles, provider usage
matrix) failed with `unrecognized token: ":"` under a full-mode process. The
dialect is now the only authority (`instanceof PgDialect` plus the
constructor-name check — both survive minification); the env fallback is
gone. A regression test builds a SQLite handle while the process mode is
full and asserts the SQLite branch still runs.
- **Postgres usage flush no longer emits a duplicate `VALUES` alias.** The
source subquery already carries its alias (`AS v(id, delta)`), and the
statement template appended another `v`, producing `... AS v(id, delta) v`
— a syntax error that silently stopped
`api_keys.lifetime_tokens_consumed` from ever advancing (the lifetime budget
reader then saw a frozen number). The source is now named once per dialect:
SQLite keeps the trailing alias, Postgres keeps its own.
- **A quota-cache miss no longer erases stamped quota windows.** The
model-family filter routed `applyUsageFloorToCandidate` through
`filterCandidateQuotaWindows(cached?.quota.windows ?? [], candidate)`, so a
cache miss became an empty array that overwrote the candidate's carried
`quota_windows` (violating the miss-must-not-erase-stamp invariant). The
filter now runs only when a reading exists; a miss leaves the candidate's
windows untouched.
- **CodeBuddy/WorkBuddy adapters close the eight wire gaps found by unpacking
the CodeBuddy CLI 2.179.2.** The reference CLI's chat request is the
authority, and the gateway now matches it:
  - `cache_retention` is injected on every buddy chat body (`long` by default;
  `short` when `CODEBUDDY_DISABLE_PROMPT_CACHING_1H` is set).
  - `X-Agent-Purpose` is no longer hardcoded to `conversation`; it is sent
  only when a purpose exists (`person_agent` under `PERSONAL_AGENT_ROLE`, or
  the inbound `x-agent-purpose` header).
  - `X-Private-Data` is no longer sent as a constant `false`; it is emitted
  only when the dispatch is actually private (`auth_state.privateData`).
  - The OAuth identity family is now sent: `X-User-Id` prefers the JWT `sub`
  over the internal account id, and `X-Userinfo` (base64 `{uin, owner_uin?, id_source?, token_source?}`), `X-Auth-Method`, and `X-Id-Source` are added
  when their identity fields exist.
  - `X-Root-Request-ID` and `X-Parent-Conversation-ID` are forwarded only when
  the caller supplies them (subagent/root chains).
  - The `x-stainless-*` fingerprint is no longer sent on CLI chat — the CLI's
  chat transport is axios, not the OpenAI Node SDK. The desktop identity is
  unchanged.
  - The intl `auto` alias now resolves to `default-model` (confirmed from live
  CLI session logs), matching the CN `auto` → `default` behavior.
- **GitHub Copilot adapter closes the Messages-wire and capability gaps found
by auditing the official Copilot Chat 0.72.0 extension (VS Code 1.144).**
  - Discovery now routes `/v1/messages`-only rows (the premium Claude family)
  to the native Messages wire instead of dropping them, and prefers chat
  when a row supports both.
  - `reasoning_effort` ladders from `/models` are carried onto the model
  definition, so clamping honors the model's real effort list
  (`claude-fable-*` declares `max`) instead of the provider-wide `high` cap.
  - Upstream `token_prices` (per-1M-token rates) now feed the model cost so
  the real per-account price is shown.
  - Headers were bumped to the current extension identity (`GitHubCopilotChat/0.72.0`,
  `vscode/1.144.0`) and `x-interaction-id`,
  `x-vscode-user-agent-library-version`, and `anthropic-beta`
  (`interleaved-thinking-2025-05-14`, Messages wire only) are now sent.
  - Model exclusions were pruned: `kimi-k3-base`, `kimi-k3-copilot`, and the
  `mai-code-1-flash-*` family are now available (the `gpt-5.6-luna` family
  stays excluded — it is not routable).
- **Responses wire requests a detailed reasoning summary by default when
reasoning effort is set.** GitHub Copilot's `gpt-6-luna` (and similar
Responses-only reasoning models) only stream `response.reasoning_summary_text.delta`
when the request body asks for a summary (`reasoning.summary`); when the
caller requested an effort but expressed no summary preference, the encoder
sent `effort` alone, so the reasoning summary that exists upstream never
reached the client. The encoder now defaults to `summary: "detailed"` when
effort is set (an explicit `summary`/`summary_mode` still wins). Verified
live against Copilot's `/auto` → `/responses` path.
- **GitHub Copilot Auto → Responses no longer 500s on unrepairable tool
arguments.** A `github/gpt-6-luna` request that carried a tool call whose
argument was not near-JSON (e.g. a multiline `*** Begin Patch` fragment) hit
a 500 `internal_error` after the `/auto` selection succeeded: the Responses
encoder's `repairToolArguments` called `jsonrepair` outside its try/catch,
so the throw bubbled through `preparePayload` into the generic error
middleware. The raw argument is now returned unchanged when repair fails,
matching the documented non-object policy; the request streams normally.
- **Provider list/detail and Usage pages no longer scan the whole telemetry
window.** Three heavy DB reads were behind the slow page loads:
  - `listAccounts`/`listAllAccounts` read **today's** per-account usage via
  `breakdownTelemetry("account")`, which scanned every of today's events and
  capped at 100 groups — so accounts past the cap silently read as "no usage
  today". The read is now scoped to the accounts on the page
  (`(tenant_id, account_id, created_at)` range), so one page costs one
  index-only scan, no top-N ceiling.
  - The provider usage matrix (`providerUsageMatrix`) and `usageBy`/top-model
  breakdowns filtered on `tenant_id` + `created_at` alone; new indexes
  `telemetry_events_tenant_provider_created_idx` and
  `telemetry_events_tenant_model_created_idx` (migration 0039) make the
  per-provider/per-model cards index-only range scans instead of window
  scans.
  - Usage analytics read-through TTL raised from 10s to 30s, so the dashboard's
  5–10s polls hit Redis (or the in-process fallback) and answer with a
  `304` instead of recomputing the window aggregates on every poll.
  - The provider list and flat model picker only need "which providers have
  accounts" and active-account counts; they were paying for full per-account
  usage/inflight/pool derivation via `listAllAccounts`. A new lightweight
  `listAllAccountSummaries` (provider id + status only) serves both, so
  opening the Providers page no longer triggers every account's usage read.
- **Cursor continuation rebases when the pinned account becomes unroutable.**
A tool result pinned to a Cursor account that had since cooled (quota
exhausted) refused with a hard 400 "no longer routable", so a complete
conversation replay could not switch to another provider/model. The router
now treats a rebaseable continuation as a fallthrough: when the pinned
account is blocked but the request replays the whole conversation, the plan
falls back to normal routing and the adapter starts a fresh Run on an
eligible account with the recorded history.
- **Chat reasoning deltas under `reasoning_summary`/`reasoning_text` (and
object shapes) are surfaced.** The chat SSE decoder only read plain-string
`reasoning_content`/`reasoning`, so upstreams like GitHub Copilot's
GPT-6-Luna, which emit reasoning under other keys (sometimes as
`{summary}`/`{text}` objects), silently dropped it. `readReasoningText`
now accepts `reasoning_summary`, `reasoning_summary_text`,
`reasoning_text`, and object/array shapes, so reasoning reaches the client.
- **Trae free-tier quota (`4008`) is a 1-day model cooldown.** It fell to
the generic quota arm (1h account-wide fallback), so the account re-entered
rotation inside Trae's daily reset window and reproduced the refusal every
few minutes — the "cooldown not holding" report. It is now classified as a
model-scoped `model_unreachable` backoff of 24h (Trae's quota resets
daily), so a model stays parked for the day instead of flapping, and the
account keeps serving its other models.
- **Dashboard: device-code login button renamed "Device OIDC" → "Device
Code".** The provider-detail account action now labels the RFC 8628
device flow correctly; the social pill (Google/GitHub) again renders in
the accent tone.
- **SSE decoder no longer splits JSON on literal blank lines inside string
values.** Qoder's IDE surface emits terminal `raw_usage` events whose keys
contain literal newline bytes (e.g. `"time_of_\nscheduler"`). A blank line
inside a string was treated as an event boundary, splitting the JSON and
dropping the terminal finish reason/usage. The decoder now only treats a
blank line as a boundary when the accumulated payload is a complete JSON
value (bracket-depth scan that skips strings).
- **Qoder 116 is classified as account-scoped quota, not platform fault.**
The account-error classifier now treats code `116` (quota exceeded, seen on
free-tier accounts hitting the modern surface) like `110`/`112`: the model
cools while the account keeps serving its other models.
- **Qoder PAT accounts now report quota.** The quota collector sent a raw PAT
(`pt-…`) as the bearer to `/api/v2/quota/usage`, which the business API
rejects with 401 `TOKEN_EXPIRE` — so a PAT account showed no balance. The
collector now exchanges a PAT for a job token (`jt-…`) first (device tokens
are used directly), mirroring dispatch. Verified live 2026-11-02: the
`that sepa` account now reads its `addOnQuota` (100 granted credits) instead
of an unreadable body.
- **Persisted quota snapshots keep balances across restarts.** Quota reads
were cached in an in-process TTL only, so after a restart the console showed
no balance for every account until the sweep re-read them (Buddy kept its
numbers via its usage-snapshot table; everyone else lost them). The account
row now stores the last successful quota read as `quota_snapshot` (jsonb),
written by the same refresh path that persists the plan, and the console
falls back to it when the cache is cold — a page open right after a restart
renders the last known balance instead of nothing, and the sweep refreshes
  it. A failed fetch leaves the previous snapshot in place, like the plan
  column. Applies to every provider, not just Qoder.
- **Qoder umid bridge binaries are made executable before running.** The
`umidpack` runtime-info files ship without the exec bit (git mode 100644)
and nothing else in the delivery path set it, so fresh Linux/macOS installs —
including the Docker image — could not spawn them (`[qoder] elf mint failed`,
EACCES). The bridge now self-heals with a best-effort `chmod 755` before
spawning, and the Dockerfile marks the POSIX binaries executable at build.
- **Trae region-unavailable refusals cool the account for a day.** Upstream
error `4013` ("AI service is not available in the current region now.") fell
through to the generic 502 platform-fault path, which cooled the account for
30 seconds without mutating it — the account was re-dialled on every request
inside the closed region window. It is now classified as a hard, account-wide
24-hour cooldown.
- **Qoder quota refusals cool only the errored model.** Qoder's quota verdicts
(code `110` "Billing daily count exceeded" and the exhausted-quota upstream
499 close) were treated as account-wide quota exhaustion, parking every model
on the account when only one model's spend cap was hit. They are now
model-scoped: that model cools for a day while the account keeps serving its
other models.
- **Notifications popover loads system health lazily.** The shell no longer
polls `/system/health` every 10 seconds for the whole page lifetime. The
popover fetches on first open (usually already cached from the shell's
version read), reuses that payload on every open, and refreshes only while it
is open — closing it stops the polling. This fixes the panel showing "System
health unavailable" with every metric Unavailable.
- **Telemetry reconciliation counted zero completed files.** The reconciliation
state row incremented `files_completed + 0` instead of `+ 1`, so the
"files completed" counter never moved regardless of how many drain files were
processed.
- **The usage chart's "cached" series plotted total input tokens.** The console
usage chart read the wrong SQL aggregate for its cached-token series, so the
cached share of the prompt was drawn as the full input line.
- **DNS resolution failures are classified deterministically.** Two stacked
5-second DNS timeout timers in the pooled dial path raced each other, so a
stalled lookup could surface as a 502 `transport_unavailable` or a 499/504
abort-shaped error depending on which timer won. The inner deadline (which
owns the correct classification) is now the only one.
- **A login ban's human-readable label can no longer be forged in the audit
trail.** The API-key ban endpoint stored a client-supplied free-text
`reasonLabel` in the audit record — attacker-controlled text next to the
machine-readable reason operators use for forensics. The label is now derived
server-side from the ban reason, and unknown/custom reasons simply carry no
label.
- **Leftover dead code from earlier passes is removed, and stale docs with
it.** Unused codec preload hooks (whose docs claimed a boot warm-up that
never existed), a dead capability-unsupported error constructor, a dead
antigravity endpoint-order helper, dead SSE header writes the framework
discarded, a stale "15 minutes" payload-retention comment (it has been an
hour for a while), a defensive double-cast with an unreachable fallback in
the codec's string sanitizer, a redundant three-way branch in the Anthropic
cache-control builder, and duplicated FNV-1a hash implementations — all gone,
with the type-level duplicates (`BackupExportResult` near-miss naming)
renamed so the next grep finds one of each.
- **Context-size overflow guarded.** Output-token limits are bounded against the
model catalog, preventing context-size booming (int32 overflow).
- **Daily check-in ledger rows follow account deletion.** Migration `0041` adds
the missing FK (`daily_checkin_ledger.account_id` → `provider_accounts.id`,
`ON DELETE CASCADE`) on both Postgres and SQLite, so deleting an account no
longer orphans its daily markers.
- **Reset-credits reads are cached.** `GET /accounts/:id/resets` serves a
short-TTL per-account cache instead of hitting upstream on every dialog open,
with a timeout signal on the warm path.

### Removed

- **`src/network/response-headers.ts`.** The denylist response-header stripper
has no caller: caller-facing responses are built from scratch by the proxy
projection, and upstream response headers are never forwarded wholesale, so
the strip set was unreachable. The invariant ("upstream headers are never
forwarded wholesale") is now documented at the projection site. If a raw
passthrough transport is ever added, resurrect the strip set from git
history.

## [2.7.4] - 2026-11-01

> **Instalasi ulang.** `2.7.4` tersedia di registri npm. Jika instalasi yang
> sudah ada bermasalah setelah `npm update` — terutama error integritas
> (`shasum`/`integrity` mismatch) saat `npm install` — **uninstall dulu lalu
> install ulang**:
>
> ```sh
> npm uninstall -g cartethyia
> npm install -g cartethyia
> ```
>
> Data aman: konfigurasi, database, dan state tersimpan di direktori data
> gateway (`~/.config/cartethyia` / `~/.cartethyia`), bukan di dalam paket,
> sehingga uninstall/reinstall tidak menghapus apa pun.

### Added

- **API-key bans with reasons, durations, and a Banned Users dialog.** A ban is
distinct from revoke/disable: it records *why* (`ban_reason`) and — with the
new `banned_until` column (migration `0034`, both databases) — can be timed,
so a temporary ban lapses on its own without SQL. The ban flow now offers the
duration choices the old model-abuse surface used (1h/6h/12h/1d/7d/permanent,
default 1h) in both the API Credentials ban modal and the request-detail ban
action. Banned keys are rejected by the auth path exactly like revoked keys;
unban clears all three ban columns with no leftover metadata. The API
Credentials header gains a **Banned Users** dialog listing active bans
(key, reason, lapse countdown) with per-row Unban — the surface the old
model-abuse layer used to own.
- **Proxy pools behave like accounts in the provider detail.** Pool-as-account
rows (`kind: "pool"`, for ip-scoped credential-less providers like OpenCode
Free) now join the owning pool's live health: real status, last error,
cooldown, today/lifetime usage from telemetry, and active provider
rate-limit markers that render as a "Rate-limited"/"Egress blocked" badge
with the reason and reset time. They gain the same Health (pool event modal)
and Test (provider probe) actions as real accounts.
- **Proxy pool routing is transparent and operator-controllable.** The Routing
Strategy card now surfaces and edits the tenant's pool-selection mode
(least loaded / round robin / random) with the pools-per-rotation stepper and
an explanatory dialog, and the Proxy page shows a read-only pool-routing
badge. The card is regrouped under Provider accounts / Proxy pools headers
with status chips, and the account toggle is renamed "Rotate accounts" so it
no longer reads as pool round robin.
- **A pool's provider cooldown markers clear when the pool recovers.** Dispatch
success, manual Clear/Recover, and the expiry sweep now drop the owning
provider's cooldown markers, so a healthy pool no longer shows a permanent
"1 cooldown" badge (previously the mirror was write-only).
- **PostgreSQL → embedded SQLite migration tool.** `scripts/migrate-pg-to-sqlite.ts`
copies a full-mode deployment (every public table, including telemetry) from
Postgres into the lite backend's SQLite file, rebuilding the target through
the SQLite migration set and verifying per-table counts,
`foreign_key_check`, `integrity_check`, and that a stored credential still
decrypts. Sealed credentials stay verbatim under the same encryption key, so
the cutover does not re-encrypt anything.
- **Migration `0035` (both databases): `provider_pool_accounts.status` uses the
`health_status` enum.** The table was created with a `text` column plus a
CHECK; it now matches every other health-state column. A dead `pool_account`
member of the `health_entity_kind` enum (never written by the code) was
removed so the schema and the committed migrations agree again.
- **Qoder adapter defaults to the IDE model-server surface.** Chat now streams
from `/model/v1/chat/completions` (immediate, no server-side queue); the
legacy COSY surface stays selectable as an explicit fallback. Virtual names
are resolved to roster keys before dispatch, the catalog is synced to the
live roster (`dfmodel` no longer free, Kimi-K3.1-Pro / MiniMax-M3.1-Flash
display fixes), and the SSE decoder tolerates JSON events split across lines.

### Changed

- **Share stats and usage are computed in SQL, not from a bounded page.** A
busy share family no longer freezes its KPI cards at 500 requests/errors: the
totals, 24-hour chart, and client-IP breakdown are SQL aggregates over the
whole retained window. Client IPs are ranked by request volume (highest
first), and inactive addresses are hidden by default behind a "Show inactive"
toggle.
- **Share KPI lifetime numbers come from the durable rollup.** The all-time
requests/errors/tokens a share page shows are read from
`telemetry_usage_totals` (charged at write time) instead of re-aggregating
the retained telemetry window on every tick; today/month figures stay bounded
window reads, and the client-IP ranking is bounded to a 7-day window. The
share-stats cache TTL is 300s, so the cold recompute runs at most once per
family per five minutes — eliminating the per-minute CPU/IO spikes a busy
family caused.
- **Read-through caching works without Redis.** When no Redis is configured,
the console's read-through cache serves from a process-local store with the
same TTL instead of recomputing a telemetry aggregate on every poll.
- **Quota aggregation is unified across the server and the dashboard.** A
single `quotaPillSummary` drives the account-row quota pill, Command Code
credits are correctly pooled, a zero ceiling reads as a spent balance, and
remaining-only pooled windows (no limit) still count — fixing quotas that
rendered as "0 of 0" or disappeared (Qoder free-tier exhausted, CodeBuddy
credits).
- **Readiness distinguishes overload from dependency failure.** A readiness
probe that times out under load now surfaces as a 503 `overloaded` with a
retry-after hint ("The gateway is overloaded"), while "dependencies are not
ready" is reserved for real failures (connection refused, migrations missing).
- **Telemetry window scans and SQLite percentile queries are cheaper.** The
usage and health endpoints reuse one combined scan instead of running
several, and the SQLite percentile path avoids redundant window materialization.
- **Postgres pool default raised to 16 (from 8).** Combined with the consumer
fixes above, a 16-connection ceiling sustains a hundred concurrent requests;
the production override was removed so the code default governs.
- **Live SSE streams pause when the tab is hidden.** Notifications, in-flight,
pools, requests, logs, and share-stats streams close their EventSource while
the tab is hidden and reopen on visibility, cutting idle background load to
zero. Share-stats and memory sampling cadences move from 10s to 30s.
- **Error messages carry a warmer tone; codes reworked.** GatewayError call
sites were swept for consistent `{requestId}` inclusion, overlap fixes, and
warmer wording; deduplicated codes including `route_unavailable`,
`model_not_allowed`, and `rate_limited`.
- **Qoder: machine headers do not gate daily credit grants.** The earlier
native-identity work was based on a campaign assumption that the operator
corrected: identity does not gate credits. The per-account Native Identity
dialog and button are removed (the identity seed itself remains for
deterministic replay on other surfaces).
- **Customization presets.** A render-preset dropdown (Off, Pretty, Extreme)
plus a low-device switch that forces every glass surface solid; the Extreme
preset renders near-solid everywhere with no backdrop read.
- **Bans are per-key and live in Request Detail, not API Credentials.** The
API Credentials "Ban" modal is gone; banning happens from a request's Detail
drawer (reason + duration). A banned child key of a share template disables
only that child — the template and its other children are unaffected. The
Banned Users dialog still lists and lifts bans.
- **Qoder daily check-in claims CREDITS-kind campaigns only.** Promo banners
are no longer claimed (they reported "claimed" with 0 credits), and
`already_claimed` is only reported for a CREDITS campaign — fixing accounts
that showed a permanent false "already claimed".
- **Quota overview backfills cold caches on page open.** Accounts whose quota
cache entry is missing (e.g. a large Qoder roster the sweep's per-pass cap
cannot keep warm) get a bounded background refresh instead of rendering a
blank badge until the next sweep pass.
- **Buddy model discovery merges `/v3/config` and the personal-models
catalog.** Both scopes are fetched and combined (dedupe by model id) —
mirroring the upstream codebuddy2api aggregation — so models present in only
one catalog are no longer lost.

### Fixed

- **Migration drift between the schema and the committed migrations.** The
schema declared a `pool_account` member of `health_entity_kind` nothing ever
writes, and `provider_pool_accounts.status` was a `text` column in the
migration but an enum in the schema. The dead enum member is gone and
migration `0035` converts the column, so `check:migrations` passes again
(36 migrations).
- **Pool health modal "Failed to load pool health events" for OpenCode.** The
dashboard dialed `/routing/pools/...` while the pools router is mounted at
`/network/pools`; both the health-events and provider-probe hooks now use the
correct prefix.
- **Share page 500-stuck** (see Changed — SQL aggregates).
- **SQLite JSONB `auth_state` read as a string** on OAuth paste import.
- **Low-device rendering switch** now matches the published dataset attribute,
and the Extreme preset renders near-solid everywhere with no backdrop read.

## [2.7.3] - 2026-10-30

> **Instalasi ulang.** `2.7.3` di-registri npm telah diperbarui sekali setelah rilis
> pertama (tarball baru memuat perbaikan qimei36 dan glass-blur). Jika instalasi
> yang sudah ada bermasalah setelah `npm update` — terutama error integritas
> (`shasum`/`integrity` mismatch) saat `npm install` — **uninstall dulu lalu
> install ulang**:
>
> ```sh
> npm uninstall -g cartethyia
> npm install -g cartethyia
> ```
>
> Data aman: konfigurasi, database, dan state tersimpan di direktori data
> gateway (`~/.config/cartethyia` / `~/.cartethyia`), bukan di dalam paket,
> sehingga uninstall/reinstall tidak menghapus apa pun.

### Added

- **Inject System Prompt — tenant-scoped, three precedence levels.** A new
Overview panel lets a tenant append (or override) a custom system prompt
globally, per provider, or per exact model, resolved most-specific-wins with
a follow-global/custom toggle on every provider. Append is idempotent and
lands after all existing system content; override replaces only the caller's
system content, never the provider's own mandatory identity prompt. Providers
whose upstream validates their fixed system prompt as a channel identity
(CodeBuddy, CodeBuddy CN, WorkBuddy) receive the tenant text wrapped in
`[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Ccartethyia%3Asystem-prompt%3E]]` markers after their identity prompt — appended
in the same turn, which the upstream accepts. Settings persist in a dedicated
`tenant_system_prompts` table (migration `0031_tenant_system_prompts` for
both Postgres and SQLite; 5 MB text cap per scope), read through the
revision-keyed cache so edits are live on the next request, with console
routes (`GET/PUT/DELETE /system-prompt`) and per-scope append/override,
`.txt`/`.json` import, and search in the dashboard. Design record:
`documentation/proposals/inject-system-prompt.md`.
- **Invoke kill switch moved into API Credentials.** The tenant-wide
"deny all keys" breaker is now a Disable/Enable Invoke button in the API
Credentials header instead of a standalone Overview card, confirm-gated:
disabling refuses every `/v1` request with 503 while the dashboard stays
reachable to re-enable.
- **Content-derived dashboard build ID.** Every production build fingerprints
its emitted assets and embeds the ID as a `cartethyia-dashboard-build` meta
tag; the server echoes it as `X-Cartethyia-Dashboard-Build` on HTML
responses. Comparing that ID (plus the content-hashed CSS URL) tells you
exactly which build a deployment serves.
- **GitHub Copilot Auto routes from the selection itself.** The `/auto`
selection response names the model *and* its supported endpoints, so the
adapter picks the Responses-vs-Chat wire from the selection and drops the
follow-up `/models` round trip on the hot path (older responders without
endpoints still fall back to the roster lookup).

### Changed

- **Adaptive Postgres pool.** The pool defaults to 8 connections with a
30-second shrinker that trims idle connections down to a configurable floor
(`DATABASE_POOL_IDLE_FLOOR`, default 2), so a burst of dashboard or proxy
load no longer leaves a hundred idle sockets pinned forever.
- **Routing: one CallerIdentity, one RoutingDecision per candidate.** The
layered re-filtering in route planning (usage floor → slow lane → health →
plan gate → capability, each with its own re-sort) is merged into a single
per-candidate decision and one rank sort (fresh → slow → cooling →
saturated). Provider rotation now only reorders within the same rank, so a
cooling account can never float back to the front. Candidates carry the
account's owning tenant, and admission buckets scope shared accounts
globally while tenant-owned accounts are scoped per owner — two tenants can
no longer drain each other's concurrency ceiling on an account only one of
them owns.
- **Overview polish.** The Compression panel's transforms render as contained
sub-cards with active/off badges and use the shared banner primitive for the
quality warning; the gateway-endpoint, remote-support, and status blurbs
read like an operator wrote them.

### Fixed

- **Cursor continuations survive a model switch.** A continuation pinned to an
account that no longer serves the (translated) model used to fail with a
strict 400. Pin-empty continuations that carry complete history are now
rebaseable: they fall through to normal routing and start a fresh Run, while
live pending calls stay hard-pinned so nothing leaks across accounts.
- **A changed model cooldown invalidates the route snapshot.** Cooldown
overrides took effect on the next snapshot rebuild rather than the next
request; a cooldown mutation now invalidates the snapshot immediately.
- **Share links can mint at most one child key per canonical client IP.**
Enrollment links are public and IP rotation previously let one attacker mint
unbounded children; dedupe now keys on the canonical client address.
- **Share usage accounting survives key deletion.** Revoked or deleted child
keys kept their spend counted in family totals (template counter + telemetry
sums), quota windows render distinct resets, and a template can cap its
active children (`max_children`, migration `0030`) with recipients listed
server-side paginated/sortable and a batched bulk-revoke endpoint.
- **Share template policy is no longer duplicated into children.** Children
inherit policy at resolution time instead of carrying a copied row
(migration `0029` nulls the duplicated columns; restore normalizes), and the
API key list orders parents before their share children.
- **The chat wire emits only its selected token-limit field.** A request
carrying `max_completion_tokens` echoed that alias alongside the bounded
`max_tokens`, and a strict upstream refused the double field; the alias is
now deleted in either direction.
- **DeepSeek-style reasoning replay stays present on resold models.** Models
served through a DeepSeek-family upstream kept their reasoning replay
marker even when the canonical surface stripped it, avoiding upstream
rejections on follow-up turns.
- **The OAuth browser dialog no longer completes on a stale account
snapshot.** (pre-2.7.2 carry-over, recorded here for completeness.)
- **Buddy device binding survives account export/import.** The buddy family
(CodeBuddy, CodeBuddy CN, WorkBuddy, WorkBuddy CN) binds a per-account
device identity (`qimei36`, sent as `X-Device-Id-List`) that defaults to a
derivation from the internal account id. Export/import mints a new account
id, so a re-imported account silently changed device identity and the
upstream channel check (11128) rejected it. The export now materializes the
resolved binding into the exported auth state whenever the account does not
already pin one, so a re-import presents the exact same device.
- **The dashboard's glass blur now survives production builds.** The standard
`backdrop-filter` is declared after its `-webkit-` counterpart in every
glass surface, so a compliant browser applies the standard declaration last
instead of the prefixed one; a cascade test locks the ordering on both
stylesheets. (This is the build-blur fix, formerly diagnosed as a cache
issue.)
- **Qoder native machine identity, persisted per account.** The original
campaign investigation attributed grant visibility to a native UMID, so
pooled accounts gained `provider_accounts.native_identity` (migrations
`0026_add_qoder_native_identity` for both Postgres and SQLite, DB-enforced
one-slot-per-env uniqueness), a Drizzle-backed identity store with
in-process allocation (`qoder-native-identity-store.ts`), and check-in
behavior that persists the selected identity. Later same-account controls
corrected that conclusion: machine headers do not gate daily CREDITS grants.
The seed remains useful for deterministic identity replay on other surfaces;
see `archive/research/12-Qoder-30-10-2026-umid-and-identity-findings.md`.
- **Qoder identity mint pipeline.** `qoder-umid.ts` mints genuine device
identities by replaying the vendor bridge (`vendor/qoder-umid/umidpack/` —
Linux ELF ×86-64/aarch64, macOS Mach-O ×86-64/arm64, Windows PE + sgsdk.dll,
plus the 3.7 MB mini-bundle rootfs), with flock-serialized seed staging on
WSL and a documented generated-identity fallback. `scripts/tools/extract-qoder-umid.ts`
re-extracts the bundle from an official client.
- **Native identity management in the dashboard.** A per-account
Native Identity dialog (qoder/qodercn account rows): bound status and slot,
copy/paste JSON export-import for moving an identity between installs, and
regenerate. Console routes carry per-account auth (platform admin for shared
accounts, tenant scope otherwise), and backup export/restore round-trips
`native_identity` verbatim.
- **Qoder research record.** The reverse-engineering evidence now lives in-tree:
the daily-credit campaign recipe (`archive/research/08-Qoder-29-10-2026-daily-credit-campaign.md`),
the UMID bridge and corrected identity findings
(`archive/research/12-Qoder-30-10-2026-umid-and-identity-findings.md`), the Pro-trial
activity-claim endpoints found by unpacking the shipped client
(`archive/research/11-Qoder-30-10-2026-trial-activity-claims.md` — including
the content-length-string signature scheme, the claim-API family, and the
provision matrix whose cause remains unknown), and the
relocated Buddy device-binding research
(`archive/research/09-Buddy-30-10-2026-device-binding.md`).
Skills updated so future sessions inherit the proven method: provider catalog
gains `references/qoder-identity-and-claims.md` (mint/replay/exchange rules,
claim-safety order, the DEAD `pro-upgrade` surface), and reverse-engineering
notes the two techniques that cracked it (literal-window grepping; capturing
the client's own signed request by hooking its shared-process bundle, restored
byte-for-byte afterward).

### Changed

- **Antigravity's static catalog matches the roster.** The offline model list
is pruned to the ids the account actually serves — the Gemini text SKUs
(`gemini-2.5-flash`, `gemini-2.5-flash-thinking`, `gemini-3-flash`,
`gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`,
`gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-4-argon`,
`gemini-4-carbon`), the Claude SKUs (`claude-sonnet-4-6`,
`claude-opus-4-6`, `claude-sonnet-5-5`, `claude-opus-5-5`), and the
`tab_flash_lite_preview` laptop-class SKU — plus the image-generation rows
`gemini-3.1-flash-image` and the new `gemini-3-pro-image` (same limits and
capabilities as its 3.1 sibling). Rows Antigravity no longer lists
(`gemini-3.1-pro`, `gemini-3.6-flash`, `gemini-3.7-flash`,
`gpt-oss-120b`) are gone; live discovery still finds any id not seeded here.
- **Qoder check-in speaks the desktop identity.** Campaign requests now carry
the desktop client's header set (`User-Agent: Qoder`, `cosy-clienttype: 10`,
`cosy-version` from the shared version source); without them the server
answers `showCampaign: false` and hides every campaign. OAuth state parsing
is shared with the adapter so account-state reads cannot drift, and an OAuth
device login that cannot resolve the account's user id fails loudly instead
of storing an identity-less credential every request would 401.
- **Scratch/handoff documentation is now in-tree as research, not feature
guides.** The earlier Buddy device-binding note moved to
`documentation/archive/research/09-Buddy-30-10-2026-device-binding.md`
(unverified-historical status); `handoff.md` records the check-in working
state, the hard-won facts, and the parked macOS-binary item.

### Fixed

- **A settled relay deploy closes its dialog.** Deploying a relay left the
modal open after it succeeded, so the operator stared at a form whose job
was already done (and whose token had been cleared, so a second deploy
from there was impossible anyway). A success now closes it: the relay is
registered as a pool and the list behind the dialog shows it. A failure
that invalidates the session — a revoked or mistyped Cloudflare token,
which signs the console out behind it — closes too, since retrying inside
the form can only repeat it. An ordinary failure stays open, because a
taken project name or a transient error is one edited field from
succeeding.
- **Glass surfaces keep their blur on a built dashboard.** Every glass surface
is driven at runtime by the Customization sliders (`--blur-cards`,
`--blur-cards-depth`) through `backdrop-filter: blur(calc(…))`, which no
fixed utility can express — so those rules live in the authored sheets and
land in `@layer base`. Tailwind declares `@layer utilities` last, and a later
layer wins the cascade regardless of specificity, so the filter was dropped
on every real build: cards, the sidebar, and the composer rendered with no
blur at all, while their `color-mix` background (already `!important`) still
painted. That is why it read as "the transparency setting is ignored" rather
than "the blur never applied", and why it never reproduced under
`bun run dev`, whose CSS injection does not carry the production layer
order. The runtime blur declarations are now `!important` like the
backgrounds they sit beside, and `dashboard/test/glass-cascade.test.ts`
locks it: a rule that loses the cascade fails the suite.
- **Backup export no longer buffers a whole tenant in memory.** An export read
every table into one array and stringified the document in one gulp; a
deployment whose `api_keys` held 331k minted share children was OOM-killed
during a routine backup. Every table is now read through a keyset-paged walk
(500 rows per page on its primary key; tables without a declared `id` page on
their composite natural key; contract-bounded singletons read in one capped
statement), telemetry events page through their own cursor, and the document
is assembled incrementally — the dashboard's plain download streams the body
frame by frame, and the compressed and `/admin/export-backup` paths gzip it
in a single pass. `MAX_ROWS_PER_TABLE` remains an explicit cap on every
table, not a size threshold, and the file a stream produces is the same
document the buffered export wrote.
- **Telemetry reads no longer break the PostgreSQL wire at six-figure id
sets.** Family-wide share reads expanded every minted child key into one
bind parameter each (~90k params on `api_key_id IN (…)`), which passed the
65,535-parameter Bind cap and ended in `08P01 bind message has N parameter formats but 0 parameters` — a crash systemd restarted into a loop. Every
id-set membership filter is now sent as a single `= ANY($n::uuid[])`
parameter (chunks of individual placeholders on SQLite), deduplicated, and
guarded at 200k distinct ids with a handled `TelemetryQueryInputError`
instead of an unbounded wire write. A filter is never silently skipped for
being too large.
- **Share family reads scale with the result, not the family.** Family
statistics, shared-key summaries, per-key token sums, and share-link
recipient counts resolved the whole key family in TypeScript — enumerating
tens of thousands of child rows and building multi-megabyte cache keys on
every share-page view — which grew memory and dashboard lag the longer the
server lived. A family is now addressed by its template key and rendered as
a constant-wire `EXISTS` against `api_keys`, recipient counts are one SQL
aggregate, and the stats cache key hashes `templateKeyId#memberCount` rather
than every family id.
- **An unhandled promise rejection no longer kills the gateway.** A rejected
promise nothing awaited (a sweep, a cache warm, a ballooned query) was
fatal by default; the listener now logs it and stays up instead of handing
systemd another restart.
- **Qoder daily check-in could answer "unavailable" for an account whose grant
was live.** The campaign probe raced its own enumeration: with a bound
identity the check-in now tries it first, falls back only on its error, and
settles the winning env slot atomically — a repeat run reuses the identity
that already won instead of re-rolling through one that had been consumed.

## [2.7.2] - 2026-10-29

### Added

- **Codex CLI remote model mapping.** Codex now participates in the CLI Tools
remote-routing table like Claude Code: the Codex page gains the "CLI asks
for → Cartethyia routes to" mapping surface, and the inbound User-Agent
(`codex-tui/…`, `codex-cli/…`) is recognised for `routing:cli_mapping`.
The Codex `review` slot is first-class with its real source model
(`codex-auto-review`), so the Guardian approval-review model can be routed to
a serving provider instead of answering `accounts_unavailable`.
- **Ollama Cloud provider catalog.** A static floor for the six public models
(gemma4:31b, gpt-oss:20b/120b, nemotron-3-nano:30b/-super/-ultra) with
live limits from the public roster, so the provider works before discovery
runs.

### Changed

- **BYOK providers can set a route client identity.** The Routing Strategy
"Client identity" control now applies to custom (BYOK) providers too: Codex
/ Claude Code / None. The operator's explicit choice wins over the adapter's
default, and `None` is honored as no identity at all.

### Fixed

- **Qoder "insufficient tool messages" after cancelled/compacted parallel
calls.** An assistant `tool_calls` turn whose sibling call had no result
used to be withheld while the surviving `tool` result turn was still sent,
producing an orphan `tool` turn the upstream rejected
("Messages with role 'tool' must be a response to a preceding message with
'tool_calls'"). The assistant `tool_calls` emit and the `tool` result turns
now share one source of truth, so a transcript is never half-stripped.
- **Responses parallel `function_call` items fold into one assistant turn.**
Clients that send several `function_call` input items back-to-back (opencode,
Codex) decoded into separate canonical assistant turns, so the Qoder/OpenAI
wire saw an assistant `tool_calls` turn before the previous one's results —
rejected as "An assistant message with 'tool_calls' must be followed by tool
messages responding to each 'tool_call_id'". Consecutive tool-call turns now
merge (a leading `reasoning` item included).
- **Responses `additional_tools` item no longer rejects Codex auto-review.**
Codex's Guardian approval reviewer declares its review tools with an
`additional_tools` input item; parsing it threw
("Unsupported Responses input item type"), which failed the whole
auto-review request and made every permission escalation look like an
infrastructure error. The item is client-side metadata and is now skipped
safely.
- **Responses "Encrypted reasoning" robust to non-string payloads.** A
reasoning item whose `encrypted_content` is not a string no longer throws;
it falls back to the readable reasoning, and the encoder only emits
`encrypted_content` when it is a string.
- **Trae context-overflow streams classify as 413.** The upstream error code
4026 ("context length exceeded") now maps to `context_length_exceeded`
(413) instead of `platform_unavailable` (502).
- **OAuth browser login no longer completes on a stale account snapshot.** The
dialog used a cached account baseline from an earlier login, so a second
login could report success before anything happened. The baseline is now
taken only after a fresh refetch, and each attempt opens a unique popup so a
leftover window is never reused.
- **Qoder parallel tool echoes are recovered, not leaked.** When Qoder echoes
several tool calls as text (`[assistant 请求调用工具] …` JSON) with
unescaped inner quotes, the whole block used to be dropped and shown as
visible text. Multi-call echoes now salvage into real tool calls, and the
same recovery applies to the thinking channel (`reasoning_content`), so
DeepSeek-planned parallel batches run instead of leaking.
- **Routing no longer dials a cooling account through continuation affinity.**
A multi-turn request carrying tool results was pinned to the account that
owns the live session *before* health was checked, so a session whose
account had hit quota kept being dialed and reproduced the refusal — the
"still hit a cooled-down account" report. The pin now evaluates eligibility:
a hard-cooling account answers `429` with the real reset, and a
disabled/locked one answers a clear `400`.
- **Qoder upstream 499 refusals cool the account as quota.** Qoder closes an
exhausted-quota stream with an nginx-style 499, which read as a malformed
request (non-retryable, no cooldown) and kept the account in rotation. 499
scoped to qoder now classifies as `quota_exceeded` with a cooldown.
- **Qoder OAuth accounts recover from a cold credential cache.** The loader
stores `auth_state` as JSON text, so the adapter received `undefined` after
a cache eviction and refused with "missing its user identity; sign in
again". The state parser now accepts the JSON-string form too.
- **Qoder tool-protocol echoes fail closed instead of leaking.** When Qoder
echoes a tool-call block (`[assistant 请求调用工具] …`) that cannot be
recovered — malformed inner JSON, unescaped quotes that do not repair —
the turn now fails with a 502 instead of surfacing the protocol text as
visible content and leaving the model looking successful while nothing ran.
- **Qoder echo recovery holds long, fragmented streams.** A valid echo split
across hundreds of tiny stream deltas used to trip the 200-frame hold cap
and was released as visible prose — the leak. The cap now counts only
frames that add no bytes, so a growing echo is held until recovery, and
salvaged arguments are validated (malformed arguments are rejected, not
passed through).
- **Qoder tool-style tag echoes are recovered.** The model sometimes echoes a
tool call as an XML-like tag (`[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cexecute%20code%3D%22...%22%20%2F%3E]]`) instead of a JSON
array. These now recover into structured tool calls instead of leaking as
visible text.
- **Qoder wrapped `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Ctool_call%3E]]` echoes are recovered.** The model also wraps
each echoed call in `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Ctool_call%3E]]…[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3C%2Ftool_call%3E]]` blocks; the stream hold-back
now keeps tag-style candidates (not just JSON) so a long, fragmented wrapped
echo is recovered instead of released as visible text.
- **Qoder XML-style echoes use one generic parser.** Self-closing tags
(`[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cexecute%20code%3D%22%E2%80%A6%22%20%2F%3E]]`), paired blocks (`[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Ctool_call%3E]]…[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3C%2Ftool_call%3E]]`), and
angle-wrapped JSON (`<{…}>`/`<[…]>`, including a double-brace artifact)
are handled by a single parser, and the stream hold-back keeps angle-wrapped
candidates until their closing `>` so long fragmented echoes recover instead
of leaking.

## [2.7.1] - 2026-10-28

### Fixed

- **Qoder: index-less continuation fragments and plain-text leak markers keep
their arguments.** Two upstream shapes still dropped tool arguments after
the first fix: continuation chunks that omit `index` entirely (no pinned id
to join, so encoders dropped the nameless fragment), and the INTL leak
marker `[assistant 请求调用工具] …` when it arrives as plain text rather than
DSML markup (it was never buffered, so it never reached recovery). The
translator now falls back to the most recently seen call id for index-less
fragments (mirroring the generic chat parser), and accumulates non-DSML
text so the leak marker is recovered at end of stream with full arguments —
the "assistant talks, then calls a tool with {} arguments" reports.
- **Routing no longer redials an account whose cooldown deadline has elapsed
but has not been swept yet.** A row still in `cooldown` status used to read
as healthy the moment its `cooldown_until` passed, so requests landing in
the window between the deadline and the next 30s recovery sweep reproduced
the refusal that cooled the account — logging a fresh `cooldown → cooldown` health row for each one (the "still hit a cooled-down account"
report). The snapshot builder now stamps a `cooldown` row regardless of
whether its deadline is expired; the sweeper remains the only exit, so the
account is not served again until it is genuinely recovered.
- **Qoder billing-limit refusals no longer invalidate the credential.** Qoder
answers an exhausted daily billing allowance with
`{"code":"110","message":"Billing daily count exceeded"}` on a 403 wrapper.
The status-only fallback read the 403 as a credential fault, so a healthy
account was parked as `auth_invalidated` — the console's "Re-login
required" — and operators were sent to re-authenticate a credential that was
never rejected. The `110` code and the "Billing daily count exceeded" phrase
now classify as quota (an account cooldown), and unknown numeric provider
codes are never treated as credential evidence — the safe unclassified
cooldown is the default for a code we do not recognise.
- **Qoder streaming tool calls no longer lose their arguments.** The upstream
identifies one streamed call by OpenAI chunk shape — `id` + `name` in the
first chunk, then only the wire `index` on every continuation fragment. The
qoder translator synthesized a fresh `call_[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cindex%3E]]` id per chunk instead of
pinning the first id, so every continuation arrived nameless under an
unestablished identity and was dropped by the encoders. Clients saw tool
calls whose `arguments` were always `{}` (agent harnesses rejected every
native bash/write/read call as "missing required field"). The translator now
pins the first id per wire index and hands retries the same behavior as the
generic chat parser.
- **Capability degradation no longer strips tools as collateral.** When the
only capability a route cannot serve was ordered after `tools` in the
degradation chain (an image attached to a text-only model such as Mercury
3), the surviving cumulative variant had already lost the tool catalog — the
tool-capable model then received a transcript of `[tool:[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cname%3E]]]` text
placeholders with no tool definitions and imitated them instead of
structurally calling tools. Degradation now tries each single-capability
loss against the pristine request first, so the smallest surviving
degradation wins (e.g. drop only the image, keep tools) before the
cumulative chain runs as fallback.
- **Trae stream refusals are classified, not blanket-routed.** Upstream
`1001 "we are not able to authenticate you"` now surfaces as an account-scoped
`authentication_failed` (401 + credential evidence) instead of a generic 502
platform fault, and `4008 "exceeded the quota"` as `quota_exceeded` (429).
Error objects carried in frame bodies (HTTP 200 with `{"code":…,"message":…}`)
are detected too, not only named `error` events — the wrong classification was
hiding the real cause and could drag the proxy pool into the story.
- **The health classifier recognizes Trae's 1001 verdict.** A numeric upstream
code was previously excluded from the credential arm, so `1001` fell through
to the `unknown` fallback that never mutates — the account stayed in rotation
and was re-dialled on every request despite the upstream's auth verdict. Trae
`1001` is now `auth_invalidated` (account-scoped, routing-visible), so the
account cools/excludes and failover moves to a sibling.
- **Trae prompt-cache estimation is re-adopted and scoped per (session,
model).** Trae's agent surface never reports cache usage, so repeated
prefixes are estimated locally from per-session history; two models sharing a
conversation id cannot cross-hit, and the assessed usage rides the terminal
event so non-streaming telemetry records real counts.
- **Buddy desktop device-token follows the official `token || error`
contract.** The desktop client sends `X-Device-Token` on every realm (Intl
included) and never omits both it and the error header: when no real token
exists it sends `X-Device-Token-Error: sdk_not_initialized`. The buddy
providers now do the same instead of dropping the header (or sending it only
on CN).
- **A first-event timeout is a deadline, not a client cancel.** The
empty-stream watchdog used to classify a silent upstream (e.g. a provider
holding the request in a queue) as `transport_closed` 499 — "cancelled by
client" — hiding a real upstream wait behind a cancellation. It is now
`deadline_exceeded` 504 with upstream origin, matching the streaming
stall/first-chunk watchdogs.
- **Qoder recovers single-object leak echoes.** The INTL leak marker could be
followed by one JSON object (`{"name":…,"arguments":…}`) instead of an array;
that shape was rejected, so the whole block was released as prose and the
marker leaked to the client as visible text. `parseLeakedToolCalls` now
normalizes a single object into a one-entry array.

### Added

- **Provider Detail "Activity Matrix" usage card.** A collapsible card at the
top of the provider page condenses the last 1–366 days of usage into a
calendar heatmap (Mon–Sun weeks, `GET /console/api/providers/:providerId/usage/matrix?days=N`, aggregated directly
from `telemetry_events` — no migration). Summary strip totals requests,
tokens, cached tokens, and estimated cost. Cells are tinted by the day's
dominant model with a stable per-model color (hashed hue), hover shows a
native day tooltip broken down per model, and an expandable "Usage by model"
list ranks models by tokens with colored share bars.
- **Inception Labs (Mercury 3) as a bundled free-tier provider.** `inception`
ships with `mercury-3` pinned to the free tier — one million token context,
131072 max output, reasoning and tool calling, zero price. It appears under
Free Limited Providers in the console. A 429 from the per-minute window
cools the account for one minute (upstream `Retry-After` still wins) instead
of the generic fifteen-minute guess, so a throttled account recovers as soon
as the window resets.
- **A `random` pool-group selection strategy.** Pool selection previously only
knew the ordered scans, so a burst always hit the same first pools and
burned them one by one while siblings sat idle — the "all pools cooling,
fresh ones unused" pattern. `random` shuffles the eligible pools per request
(still skipping cooldown/blocked pools and falling through full ones). Set
it per tenant via the pools strategy endpoint; migration `0025` ships for
both backends.
- **Pool cooldown and probe verdicts survive refresh and restart.** A probe
429 now writes a cooldown marker the console shows, markers persist across
restarts, and blocked egress verdicts are restored at boot — a spent or
retired egress is not re-picked after a restart.
- **Qoder daily check-in (streak / 100 Credits per day).** Qoder accounts now
ride the same daily check-in machinery as the Buddy family: the quota sweep
claims the grant once per day, and a manual trigger is available through the
account quota surface. Legacy `/sash/.../daily-check-in` status/claim is
tried first; when the international realm does not expose it (404), the
CREDITS-kind activity campaign is claimed instead. Streak days and the 100
credit grant are reported in the sweep log.
- **OpenCode free tier aligned 1:1 with the reference bridge (v2).** Flat
`/inference` dispatch paths, the minimal free-tier prompt, native proxy
egress, and pool bulk actions in the console.
- **Validated direct egress uses native fetch by default**, with per-provider
opt-in and opt-out.
- **The TuringShield SDK is bundled** under `vendor/turing-sdk/` (WorkBuddy
desktop 5.8.4 extract) so buddy providers generate real `X-Device-Token`
values without any environment setup — `CARTETHYIA_TURING_SDK_PATH` remains
an override. Per-provider payload profiles (WorkBuddy vs CodeBuddy product
identity on channel 400111) make tokens differ between providers, and the
Dockerfile ships the vendor directory into both builder and runtime stages.
- **Per-account device binding (`qimei36`).** Buddy desktop chat now sends
`X-Device-Id-List: {"qimei36":"…"}` resolved per account — explicit
`auth_state.qimei36` wins, otherwise a deterministic sha256 of the account id
(32 hex, stable across restarts, no DB write). Every pooled account presents
a distinct device alongside the machine-bound Turing token.
- **Mistral catalog expanded to models verified live.** The static roster was
re-checked against a live key: `codestral-2508/latest`,
`mistral-code-latest`, the ministral family, `voxtral-small-2507/latest`,
the `mistral-medium-latest` aliases, `mistral-vibe-cli-*`, and
`magistral-*` now ship, while rows that answer 403
(`tier_not_allowed` — e.g. `mistral-large*`) or 400 (`invalid_model` —
Labs, embed/OCR/transcribe/TTS/realtime) are excluded, so every model the
catalog offers can actually serve.

### Fixed

- **Qoder (INTL) tool calls and structured output are more robust.** Adapted
from the reference bridge: DeepSeek multi-turn replays `reasoning_content`
on every assistant turn once the conversation has a reasoning trace (absent
is refused upstream — the source of occasional failures that passed on
retry); tool-call echoes are recovered in every marker variant the model
emits, with trailing DSML tags stripped; structured tool turns fall back to
prose when a call lacks an id; and image parts are sent as structured
`image_url` parts instead of being silently dropped (the upstream reads
message content, not the top-level field). Verified live on
`qoder/deepseek-v4.1-flash` and `qoder/qwen3.8-flash` only.
- **Health events no longer depend on database defaults.** SQLite lacks
`gen_random_uuid()`/`now()`, so ids and timestamps are now supplied in code
— event rows survive and the activity panel stays truthful in Lite mode.
- **`bun run dev` stays quiet while the backend restarts.** A refused Vite
proxy connect answers a graceful 502 JSON instead of a wall of
`ECONNREFUSED` logs; `VITE_NO_BACKEND_PROXY=1` removes the proxy entirely
for pure dashboard work.
- **Egress blocks are scoped to IP-limited providers.** A free-tier refusal
only retires the egress address for providers whose limits follow the
address; for everyone else the refusal belongs to the account dialed, so a
shared proxy is never sidelined for an account-keyed refusal.
- **OpenCode registry wire-path maps synced to the v2 family segment**, and
the system-one surface stays on the flat `/inference` path (verified live).
- **Upstream 429 free-limit probes are labelled as rate limits**, not generic
failures, so the health panel draws them correctly.
- **DSML tool-call recovery matches the reference bridge's edge semantics**
with parity tests.
- **Boot path hardening.** The 30s task cadence is staggered and the prior
listener stops on hot reload; task registration is idempotent, shutdown
flush bypasses backoff, the install-id knob is governed, a single share
store is used, and the inflight catalog store is cached.
- **Buddy providers no longer hit load-time import cycles** (leaf CN catalog
module).
- **The gateway surfaces the upstream's full error prose** instead of
truncating it to 500 bytes, and an upstream socket drop is classified as
`502/upstream` — not `500/cartethyia`.
- **Vercel relay deployments are public again.** The deploy flow left the
project under Vercel's SSO Protection, so a deployed relay answered 401 for
anonymous traffic — "deploynya sukses tapi gak public". Deploys now set
`ssoProtection: null` (via the project settings PATCH) so the front door
serves any caller.
- **Hosted relay dials are direct fetches, not CONNECT.** A relay front door
(Vercel/Workers/Deno) answers application HTTP and refuses CONNECT, but the
validated egress handed the relay URL to the runtime fetch as its `proxy`
option, so every relay dial failed with "Proxy refused to open a tunnel:
400 Bad Request" — including pool health checks and the Add Proxy "Test
URL" probe. Relay dials now fetch the relay directly, carrying the target
origin/path in `x-relay-target`/`x-relay-path`, and the relay worker strips
`content-encoding`/`content-length` from the upstream response — Vercel
Edge already decodes the stream it hands back, so re-sending gzip headers
made callers decompress twice (ZlibError on gzip targets). Verified live:
the canary probe reports healthy and gzip/OpenCode targets return 200
through a deployed relay.

### Changed

- **Network egress unified on one native-fetch path** — the node dialer is
gone; validated direct egress and proxy egress share the same transport.
- **Transport wiring consolidated.** One `GatewayHandlerDeps` and one
`nativeCompletionBase`; dead dispatch fields and an unused
`providerAdapters` fallback were removed.
- **Quota shared cache and refresh moved to the providers layer**; transport
and workers no longer reach into console code.
- **Protocol layer now owns translation, reasoning, and upstream parsing** —
the protocol-to-transport/provider inversions are gone.
- **Backend monoliths split**: pure classification and catalog helpers were
extracted from the large services.
- **Dashboard monoliths split**: Proxy, Usage, and Accounts pages are section
components; the dead toolbar and EffortPicker were dropped and usage periods
are single-sourced.
- **Test layout aligned with the `src` module tree.**

### Removed

- **Buddy redeem, travel, lottery, and trial-claim worker tasks.**
- **The request-lifecycle-derived in-flight gauge.**
- **The model-abuse ban surfaces the strike layer owned.**
- **Orphaned start and watch-traffic scripting.**
- **The `reports/` artifact directory.**

### Performance

- **Client identity is resolved once per request**, and the route snapshot is
warmed at boot instead of on first request.
- **The worker scheduler injects a lease-acquire timeout.**

### Tests

- Dropped heavy e2e gateway suites, low-value suites with sibling coverage,
duplicated assertions, a stale unit bucket, and donor-referencing provider
suites; CLI port-startup moved to integration scope.

### Documentation

- README polished with a development/testing section; skill pages point the
engineering completion section at the verification owner; stale test
references and architecture wording fixed; references refreshed for the
relocated translation, quota, and governance paths.

## [2.7.0] - 2026-10-27

### Removed

- **The process-wide concurrency cap.** The gateway bounded in-flight
requests twice: admission bounded the tenant and each key from Settings,
and a second ceiling derived from the memory limit refused beyond it. The
second one was never a number an operator set, and it was the smaller of
the two — 64, raised to 502, still below what Settings allows — so a
tenant configured to 100 was refused by a constant the Settings page never
mentions. The 503 named the gateway rather than any configured limit,
which read as a broken setting when the constant was. Removed: the guard
middleware, its controller, the derivation and its ceiling constant, the
`CARTETHYIA_PROCESS_CONCURRENCY_LIMIT` override, and the gauge. What
governs admission now is the tenant ceiling and each key's own limit, both
set in Settings, which is where an operator already looks. An install that
had set the removed variable can drop it; it is no longer read.
- **The model-abuse strike and ban layer.** A request naming a model the key
may not use collected a strike, and ten strikes inside thirty minutes
banned the client address *and* the key for six hours with
`403 model_abuse_banned`. No setting exposes it and the request-rate
ceiling does not interact with it, so an operator who set rate limits to
unlimited still had callers banned by a counter they could not see. A
model the key may not use is already refused with 404; escalating that
refusal into a ban answered the same question twice. Removed: the strike
service and its stores, the ban check on the request path, the console's
ban list and lift, the four `CARTETHYIA_MODEL_STRIKE_*` /
`CARTETHYIA_MODEL_BAN_*` knobs, and the error code.

### Fixed

- **The memory limit no longer pretends every host is a 512 MiB container.**
Where no cgroup limit is discoverable — native installs, macOS, Windows —
the fallback was a fixed 512 MiB. On a desktop that described nothing: the
pressure check logged "RSS 430 MiB exceeds 80% of the 512 MiB limit" with
gigabytes free, and the process concurrency derived from the same number
admitted 16 requests. The fallback is the host's real memory now.
- **Qoder tool calls carry their arguments.** A call came back correct in
name with an empty `arguments`, so it could not run, and the emptiness
read as a translation defect. The causes were on the request side. Tool
history was sent as structured turns on a realm that does not read them,
so a past call was dropped and the model had no record of what it had
asked for; it now goes into the turn's text, with the marker and JSON
shape the upstream has been trained to read back. Each message also
carried a `contents` array alongside `content`, describing every turn
twice in two shapes; the reference sends `{role, content}` and nothing
else. `model_config` now declares `format: "openai"`, and a named
`tool_choice` is sent as a bare string because the object form is ignored.
- **Qoder recovers a call written into its thinking.** Tool-call markup that
reached the thinking channel was passed through as visible tags, and
leftover closing tags — often without the `DSML` marker at all — survived
because the parser keys on that marker. Both channels are now buffered and
parsed, and a turn whose thinking carried the call reports `tool_calls`
rather than the upstream's own `stop`. A call echoed back with its inner
quotes unescaped is salvaged rather than rejected, since that is not valid
JSON at either level.

### Added

- **The in-flight snapshot reports how long the oldest flight has been
open.** A count cannot tell a healthy queue from a leak: six flights are
six requests in progress or six that never finished. The age separates
them — a flight far past its own deadline is the backstop's worklist, so
an age that grows beside a flat count shows a sweep that is not running.
- **The abuse layer records why it refuses.** Rejections are counted under
`cartethyia_ip_abuse_refusals_total` with a `reason` label, because
rate-limited and banned are different problems with different remedies and
must not be one number.

### Changed

- **Tailscale reports a live serve, and names the address.** Stopping the
tunnel emptied `serve status` while the node stayed online, so the toggle
stayed on and the link kept pointing at an address that no longer
resolves. Active now requires both halves. Where there is no address, the
console says why — the auth URL, the backend state — instead of showing an
empty field.

## [2.6.8] - 2026-10-27

### Fixed

- **CommandCode generates on the CLI surface.** Every completion was posted
to `https://api.commandcode.ai/provider/v1/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cwire%3E]]` — the catalog surface,
which answers `GET /models`. The reference client generates on
`/alpha/generate` for every model and does not vary the path by the wire a
row declares, so requests were reaching a surface the CLI never calls to
generate. All catalog and discovered rows now dispatch there; the wire
family still decides how the body is shaped, so no body translation
changed. Each request also sends `x-session-id`, which the upstream
expects on every generate call.
- **Qoder sends assistant tool calls.** A request with tools failed
upstream with "Messages with role 'tool' must be a response to a preceding
message with 'tool_calls'": the translator emitted every assistant turn as
text only, so the calls were dropped while their results were still sent.
Replaying the recorded request showed 862 calls in and 0 out; they are now
sent as `tool_calls` and as `tool_use` blocks, using the block shape the
upstream reference bridge produces.
- **Qoder replays `reasoning_content` for the DeepSeek family.** Those models
tie multi-turn consistency to the field: an assistant turn that thought has
to be replayed with it or the upstream refuses the whole history, showing
up as occasional failures that sometimes pass on retry. The translator
flattened assistant turns to text only, dropping it from all 919. Matched
on the upstream key as well as the display name, and kept it only for these
models, as the reference bridge does.

## [2.6.7] - 2026-10-27

### Fixed

- **One stalled lease no longer stops every scheduled task.** `runOnce`
latched the process-wide `busy` gate and then awaited `lease.tryAcquire`
with no bound. A lease store that never answered left `busy` set forever,
and because the gate is shared across every task name rather than
per-name, every later tick of every task returned at it: the whole
registry stopped running. That included `inflight-backstop`, whose entire
job is to clean up after something that never finishes — so one stalled
acquisition is what let stale in-flights sit until restart.

  The acquisition is bounded at 5s and treated as a skip, which is what
  `tryAcquire` already documented without enforcing. Skipping releases the
  gate, and every path that latches it without running the task now goes
  through one `releaseGate`.
- **A banned buddy account is disabled again.** The ban detector matched on
the message, but the provider's message for a ban is the same two words it
uses for a refused request: "request illegal". The actual verdict ("Your
account has been restricted due to unusual activity") lives in
`displayMsg`, which the message extractor never reads, so the ban was
never detected: no `policy_blocked_banned`, no disable, and the account
kept serving. The body is now read too — from `upstreamBody` or
`details.raw` — including each language of the `displayMsg` map and an
appeal-bearing `actions` entry.

## [2.6.6] - 2026-10-27

### Fixed

- **Hide to tray no longer exits while the gateway is still serving.** The
tray polled `/health` every 10s and closed itself after 3 consecutive
misses, with a 2s probe budget. A gateway that is answering, but slowly,
misses every probe exactly like a gateway that is gone: under a large
prompt or a synchronous GC, `/health` cannot answer inside 2s, so three
polls in a row missed and the icon exited while the gateway was still
serving. `carte --tray` looked fine only because it starts idle and never
carries that load.

  The miss count is now a wall-clock window: a gateway that is truly gone
  stays unreachable and still closes the tray promptly, while a gateway that
  is merely busy answers often enough to reset the clock. The probe budget is
  15s — far longer than a healthy answer takes, far shorter than the poll
  interval.

### Added

- **Tests for the in-flight backstop sweep, which had none.** The sweep is
the only thing that reaps a flight whose finalizer never ran. These pin
that a flight past its deadline plus the hard grace is released, that one
inside the window is not, that a deadline moved by a live stream is
followed, and that reaping is idempotent.

## [2.6.5] - 2026-10-27

### Fixed

- **A synchronous GC ran while requests were in flight.** `main.ts` passed
every dependency to `createGatewayApp` except the runtime sampler, so the
app's `bindInFlight` call no-op'd on an optional dependency and the sampler
kept its `() => 0` placeholder. `cartethyia_process_in_flight` reported zero
forever while `proxy_in_flight` — the registry the placeholder was meant to
read — reported real flights.

  `checkIdleReclaim` gates on `inFlightSource() > 0`, so a permanently-zero
  source told the gateway nothing was in flight and let it run a synchronous
  `Bun.gc(true)` under load. A synchronous collection stalls concurrent
  requests: latency pinned to the request deadline and clients cancelled en
  masse with 499.

  Both classes behaved exactly as written — only the wire between them was
  missing — so it is pinned by a composition test that reads `main.ts` and
  requires the field.

## [2.6.4] - 2026-10-27

### Fixed

- **A full max-inflight is no longer an account rate limit.**
`provider_capacity_exhausted` is raised by this gateway's own routing when
every account serving a model is at its max-inflight — the credential is
fine, the ceiling is what rejected the request. But it is a 429 whose text
says "rate limit", so it matched the rate-limit arm and cooled the account
for the full 15-minute window. Every account then read `cooldown` at once,
so all of them looked busy while requests piled up. Now classified as
capacity with zero cooldown and no account penalty.
- **A refused CONNECT tunnel is a pool failure, not an account failure.**
`Proxy CONNECT failed: 403 Forbidden` fell through to the unclassified
provider arm, which cooled every account behind that pool — so one dead
front door on one provider took unrelated providers down with it. Now
scoped to the pool.

### Changed

- **`policy_blocked` split into a ban and a request refusal.** One category
served two shapes needing opposite remedies:
  - `11140` whose body names a restriction on the account ("Your account has
  been restricted due to unusual activity") is now
  `policy_blocked_banned`. It disables immediately with no window — and no
  window is what keeps it disabled, since the recovery sweep only revives a
  disabled row whose deadline has elapsed.
  - `11-128` and safety reviews are now `policy_blocked_invalid_request`.
  The credential is fine, so this mutates nothing: the only correct move is
  to stop retrying verbatim.

  Told apart by the body, not the code alone, and gated on the buddy family,
  so an unrelated upstream saying "restricted" cannot disable accounts.
- **The usage floor shows inactive accounts separately.** "Pooled credits"
counted active accounts only and silently dropped the rest, so the pooled
number looked wrong with nothing to explain it. The inactive count is now
shown alongside.

### Added

- **The accounts toolbar is flat.** The bulk actions (Recover, Enable,
Disable, Export, Delete) had lived behind an "Actions" chevron, so most of
what the toolbar could do was invisible until accounts were selected. They
are now persistent buttons that grey out when they do not apply, so the
toolbar's shape never depends on what is selected.
- **A static JWT's issuer is shown** on the account health modal, under
Credential management. Read from the `iss` claim at registration, since the
secret is unreadable afterwards. Only shown when the payload carried the
claim. Accounts registered before this release show no issuer until re-added.

## [2.6.2] - 2026-10-26

### Added

- **Buddy hardening against the reference gateway.** CodeBuddy and WorkBuddy now
speak like the official clients: official identity prompts, the DeepSeek
Harness channel-identity scrub, dashed-UUID message ids on the WorkBuddy
desktop path, request markers on the CLI identity, and a pinned macOS SDK
fingerprint. See `.skills/cartethyia-provider-catalog/SKILL.md` for the
donor-hardening workflow.

### Fixed

- **Restored rows land under the restoring tenant.** A restore now writes every
row under the receiving tenant, and telemetry dedupe keys are computed after
the remap instead of against the backup's tenant.
- **The update and already-running paths can be read.** Two exits happened too
fast to be read, and both made a failed action look like a successful one.

  An update that could not install still printed "this process will exit now"
  and exited, so a version that never changed looked updated. The notice now
  names what actually blocks the install — npm replaces the package by
  renaming its directory, which Windows refuses while any process holds it,
  and the hold can outlive the process that took it — and prints the command
  to run by hand. The menu holds the notice for 30 seconds instead of
  exiting, and the installer stops `cartethyia`/`carte` first so the rename
  has a chance.

  A second instance reported "already running" and exited immediately, so a
  double-clicked shortcut or a re-run in a terminal that is already serving
  closed the window before the reason could be seen. It now waits 30 seconds
  before closing.

## [2.6.1] - 2026-10-26

### Fixed

- **Hide to Tray starts the gateway again, and opens the console.** Launched
from the menu it failed with `ENOENT: scandir 'B:\migrations\lite-sqlite3'`.
The compiled gateway binary resolves its assets from
`CARTETHYIA_PACKAGE_ROOT`, and a compiled Bun executable has a virtual
`import.meta.dir` (`B:/~BUN/root/cartethyia`), so an unset root fell back to
the drive root. Only the local and VPS installers ever set it, so an npm
install never had one — and the compiled binary is the default gateway
executable whenever `dist/cartethyia` exists. Both the npm launcher and the
CLI entrypoint now set it, covering `carte --tray` and the menu's handoff
alike.

  Hide to Tray now also opens the dashboard once the handoff reports ready. It
  is the one menu action that ends with no menu and no console in front of the
  operator, so it should leave them somewhere; every other action stays in the
  menu or is an explicit "Open Console" press. It waits for readiness, so a
  failed handoff does not point the browser at a gateway that never started.

## [2.6.0] - 2026-10-26

This is the lightweight-runtime release: a 1-core / 2 GiB deployment should
again serve its users with the dashboard open, without adding RAM. It closes
the regression traced to 2.5.10's raw-file analytics reader and removes the
per-request costs that made a saturated box worse the more it was asked to do.

Migrations `0020_add_telemetry_event_analytics.sql`,
`0021_add_api_key_concurrency_tolerance.sql` and
`0022_add_inferhub_config_key.sql` ship in both
`migrations/full-postgres/` and `migrations/lite-sqlite3/`. An existing
database applies them in order; a fresh one builds from the current baseline.

### Added

- **`carte telemetry reconcile --apply|--verify`.** Recovers events that
reached the raw JSONL mirror but not the SQL analytics table — the window
left behind by any earlier release, and by a crash between the raw append
and the SQL commit. It streams each raw file from a committed byte offset,
inserts at most 500 events per transaction, and never touches lifetime usage
totals (those events were already charged). `--verify` only reports: rows
missing from SQL, rows whose content conflicts, and SQL-only rows by hour.
Conflicts are reported, never overwritten. A second concurrent run is
rejected by lease.
- **Optional multi-process operation.** `CARTETHYIA_PROCESS_COUNT` (1–16) and
`CARTETHYIA_PROCESS_INDEX` (0–N-1) run several gateway processes over one
database. Count above 1 requires Linux, `CARTETHYIA_DB_MODE=full`, and a
*reachable* Redis; boot fails with a named reason rather than starting a
fleet that cannot coordinate. Lite stays single-process. Single-process
deployments are unchanged.
- **`CARTETHYIA_PROCESS_CONCURRENCY_LIMIT`** (1–64) overrides the derived
in-flight ceiling. An override above the derived value is logged as
intentional, so a box running hotter than its memory suggests is a recorded
decision rather than an invisible one.
- **Buddy image and video models are routable.** `hy-image-3.5` (cb/workbuddy)
and `kling-video-v3` (video, `/videos/generations`) are published upstream
but were absent from the catalog, so a request for them resolved to nothing.
On the CN realm `hunyuan-image-alpha` is published the same way, and the CN
adapter now routes image generation instead of sending it to
`/chat/completions`.
- **A repeatable catalog capture.** `scripts/tools/capture-buddy-catalogs.ts`
regenerates `data/provider-catalogs/` from a live directory read; earlier
captures were produced by a script that was never committed and so could not
be reproduced. `--check` reports drift without writing.
- **An InferHub market module.** Price and availability for every upstream
InferHub publishes, read **on demand only** — when an operator opens the
Providers page or the InferHub detail page. There is no poller, no scheduler,
no SSE consumer and no background refetch: the store's fresh read misses
without fetching, so a page nobody opens costs nothing upstream. A snapshot
past its window is served with `stale` and `ageSeconds` rather than hidden,
and a failed refresh never blanks good data. Available at
`/console/api/inferhub/*` (global admin only, because the `config_read` key
is one shared operator credential) and rendered as a per-provider section on
the InferHub detail page plus a strip on its card. InferHub is the only
provider with a pricing surface, because it is the only one that publishes
per-ask prices that move.

  The `config_read` key is stored **encrypted on its own table**
  (`inferhub_config_keys`, migration 0022), not in
  `provider_accounts.auth_state` — that field is documented as the per-account
  non-secret config and travels with the account through backup/restore. Only
  its last four characters are ever returned by the API.
- **A tenant kill switch.** `invokeDisabled`, a per-tenant preference, refuses
every `/v1/*` request with 503 while it is on. Nothing is dispatched
upstream, and no account, key or model is changed — the console stays
reachable, which is the point: an operator must be able to stop traffic and
still reach the UI that turns it back on. 503 rather than 403 because nothing
about the request is invalid. Stored on the existing
`consoleSettings.preferences` JSONB, so no migration, and enforced in the
auth guard after the key resolves, so one tenant switching itself off does
not stop the others the gateway serves. The dashboard toggle sits on the
overview beside the gateway endpoint card and presents the positive state
("invoke on"), inverting on write.
- **Configurable concurrency tolerance.** The slack above each key's
concurrency limit — previously always zero — is settable, so the effective
ceiling is `limit + tolerance` and only requests past it are refused. It
lives in two places with distinct scopes: `CARTETHYIA_CONCURRENCY_TOLERANCE`
as the deployment-wide default, and a per-tenant value in Settings (migration
  21. for per-tenant tuning. A per-key `max_concurrent_tolerance` column
  shipped earlier in this release and is dropped again by migration 0023: the
  two stacked, with the key's own value winning, which made the tenant-wide
  number look broken for any key that had quietly been given an override. See
  the Changed entry below. Both the Settings row and the Edit API Key modal
  spell out the resulting effective max as the sum, because reading the two
  numbers separately is how an operator thinks they have 5 slots when they
  have 8, or the reverse. NULL means no allowance, and the tenant preference
  is kept as the fallback so nobody already using it loses it.
- **Cursor native tool calls relay.** A Cursor host-exec frame (`read_args`,
`shell_args`, `pi_read_args`, …) becomes an ordinary tool call for the client
to answer, with MCP as the fallback. `protocol/tool-canonical.ts` is one join
point for `agent.v1.ToolCall`'s ~30 arms across three unrelated generations
(legacy natives, the modern exec family, MCP): one table maps a wire arm to a
canonical identity and decode/encode are written once against it, so a new
variant is one row rather than a new converter. Arguments are canonicalised
to OpenAI-style snake_case recursively at that boundary — the point where a
Cursor call becomes a tool call every other protocol can read. Results carry
provenance so they encode back into the arm they arrived on; without it
`pi_read` in and `read` out silently breaks the client's own tool loop. Only
a tool the request actually declared may relay.

### Fixed

- **The landing and share headers point at `risunCodex/Cartethyia`.** The
landing nav's "Community" item was a link to the old repository, and the
GitHub badge — shared by the landing and share pages — linked to and counted
`risunCode`, the account GitHub hid. Both now link to the primary repository,
the star and fork badges count it instead of the mirror, and the console's
version badge opens its releases page. `risunCode` stays reachable as a
labelled secondary entry in the source menu, listed after the primary. The
landing nav also gains a real GitHub item and the community item now points at
Discord, which is what it always claimed to be.
- **Runtime logging goes through the logger.** Three modules called
`console.warn` directly (qoder and trae quota misses, the trusted-proxy
collapse warning), which bypasses level filtering, sanitization and the
console's own log view — so the message written for an operator was invisible
in the dashboard that operator reads. All three use `log.warn`. The
`ip-boundary` case was exempted on the stated ground that importing the
logger would make it unimportable; the logger pulls in only pino, the console
log ring and its own sanitizer, none of which import the boundary, so there
was no cycle to avoid.

  
- **Console analytics read SQL instead of scanning raw files.** This is the
regression: 2.5.10 restored the raw JSONL reader as the analytics source,
so usage, charts, breakdowns, health and the requests list each read the
whole retained window from disk on every call. `telemetry_events` was
already written transactionally by the production path and already holds the
same bounded metadata, so the read side now queries it: aggregates execute
in SQL, list and detail use keyset pagination, and percentiles are ranked by
the database instead of by shipping latency arrays into JavaScript. For the
measured 20-user case this is the difference between 122 ms and 2.665 ms.
- **A 304 no longer pays for a scan.** `usageRequests()` read the event files
*before* the ETag read-through, so a cache hit still cost the full read. The
file access moved after it.
- **Metadata capture mode truly stores no bodies.** Stream diagnostics
JSON-serialized every event into a 512 KiB transcript and buffered a 512 KiB
copy of the client response even when the tenant's mode was `none` or
`metadata`. Both are now gated on the resolved capture mode; terminal event,
usage and every timing field are still recorded. Provider-exchange capture in
`metadata` mode records stage presence and sizes instead of parsing and
slicing the provider request body.
- **1 MiB means 1 MiB of UTF-8.** Payload caps were counted in UTF-16 code
units, so a CJK-heavy body was truncated at roughly a third of the intended
budget. Budgets are now `Buffer.byteLength` and truncation never splits a
code point. The provider tee floor in `full` mode rose from 256 KiB to
1 MiB.
- **Early rejections and discovery probes honor the tenant's capture policy.**
Both bypassed mode, depth and retention and fell back to the 16 MiB default
body cap, so a tenant who configured `none` could still have bodies written.
- **Privacy and crash consistency for telemetry writes.** Event rows now take
`id = requestId`, giving a stable cross-process idempotency boundary backed
by a unique `(tenant_id, request_id)`; the raw writer appends to a
process-owned file instead of using positioned writes with truncate, so two
processes cannot interleave into one file. A repeated insert charges usage
once, and a crash between the raw append and the SQL commit is recovered by
`reconcile`.
- **Memory admission measured against the real limit.** The headroom guard
compared RSS against `os.totalmem()` — the host, not the container — so on a
capped box it never shed and the process OOM'd instead. It now compares
against `resolveMemoryLimitBytes()` (override → cgroup → 512 MiB fallback).
The in-flight ceiling is derived from that limit and the configured body
size: `floor(limit × 0.25 / (2 × body))`, so at 2 GiB with a 4 MiB body an
instance admits 64, with a 50 MB body 5. Rejected requests no longer
decrement a count they never incremented.
- **Retention only reaps hours that are closed.** Pruning could delete a raw
file whose hour could still receive appends, silently losing events. It now
skips the current and preceding UTC hour and recognises both the new
writer-UUID filenames and the two legacy formats.
- **Buddy catalogs corrected against a live directory read.** Limits and
capability flags had drifted on both realms — 17 rows on the shared
international roster and 13 on CN. The largest: `gpt-5.4` was published at
1,050,000 / 128,000 where upstream reports 272,000 / 72,000; `grok-4.7` at
500,000 output where upstream reports 128,000; `kimi-k3` at 1,048,576 /
131,072 with vision off where upstream reports 1,000,000 / 32,000 with
vision on. 1,050,000 appeared on seven international rows and is reported by
no endpoint. Added `fast-model`, `balanced-model`, `primary-model` and
`gpt-6-astra` (international) and `kimi-k3-1`, `minimax-m2.7` (CN), which
were live but had no row, so asking for them resolved to nothing. Removed 16
CN rows upstream no longer publishes — they survived only because a
reference fallback table listed them, and a fallback row for a retired model
routes to an id that answers 400.
- **The concurrency slot is refunded to the key it was charged to.** A share
child reserves under its own id while the reservation is recorded against its
parent, so the counter was incremented under one key and decremented under
another — in both stores, on both the reconcile and the release path. The
child's count never fell, so after `limit` requests it was permanently full
and refused everything. That is the "never invoked again" symptom, and it
looked like a scope bug ("someone else's usage affects me") because the leak
is invisible from outside: each individual rejection was correct, and the
only clue was a key that would not admit again. The reservation now records
the key it was charged to and refunds that one.
- **Antigravity ships tool schemas instead of empty objects.** Two gaps on the
tools wire, together making a declared tool arrive as `{"type":"object"}`
with every property gone. `normalizeAntigravityToolSchemas` was **dead
code** — it existed, was documented and had unit tests pinning it, but
`buildAntigravityEnvelope` called `buildGeminiPayload` first and that
builder's sanitizer has no `parametersJsonSchema` key in its allowlist, so
the wrapper and the schema inside it were both dropped. It now runs before
the builder, which is the only order that works. Separately, the
canonicalizer never looked under `parametersJsonSchema` at all, so a Cloud
Code Assist-shaped declaration resolved to `{}` before Antigravity saw it.
The new envelope-level test is the one that would have caught this; the
existing unit tests all passed while the helper was unused.
- **A rate limit whose body states its own window is honored.** A
`limit_window_minutes: 43200` body was cooling for the 15-minute fallback
regardless, because the message names no window and parsing prose found
nothing — so an account re-entered rotation minutes later on a limit that
resets in ~23 days, turning one refusal into a retry loop against an account
that cannot serve. The classifier now reads structured reset fields as a
third source of evidence beside the header and the prose, and the longest
honest statement wins (`resets_at`, `resets_in_seconds`, `reset_in_seconds`,
`retry_after_seconds`, minute-valued windows, from the top level or a nested
`error`). It parses `details.raw` when no caller passed a body, because that
is where the upstream JSON actually reaches the classifier — requiring
callers to thread a parsed body would have left the live dispatch path fixed
by nothing. Bounded to a day, matching the failure policy's own cap. A stale
`resets_at` in the past is not a window.
- **A rate limit that does not move the account is still logged.** A
`rate_limit_transient` seen on a stream frame carries no credential detail,
so it classifies at provider scope and `mutatesAccount` is false.
`recordAccountFailure` returned on that flag before writing anything, which
meant the request table showed a rate limit while the account's health log
was empty — the symptom with no recorded cause. Not mutating is correct here
(the upstream's own remedy only works if the account keeps serving), so the
fix is to log, not to cool. The table renders such a row as `logged · ACTIVE`
rather than `ACTIVE → ACTIVE`, which read as a broken transition.
- **The default gateway key is created unlimited.** First boot seeded it with
`requestsPerMinute: 240` — a ceiling the operator never chose, on the key
that carries every early request, so the first sign of the limit was a
refusal with no visible cause. Now unset, which admission and the UI both
read as unlimited, matching the empty field and "Unlimited…" the Edit API Key
modal already shows.
- **Codex model discovery is wired, and no longer bets on one path.**
"codex publishes no model-listing endpoint" was wrong twice over. Discovery
was never wired: `discoverCodexModels` existed and was tested, but the
registry entry had no `loadModelDiscovery`, so the service took the branch
that reports none exists — Codex does publish one, we simply never asked.
And the single registry path was a single point of failure: the donor now
tries `/codex/models` then `/models`, so one upstream shape change no longer
removes discovery entirely and surfaces as a claim about the provider rather
than about the path we happened to ask.
- **Cline seeds the roster its account actually serves.** It inherited the
shared OpenRouter free roster alongside Kilo and OpenRouter. One list for
three providers is right for a catalog fact and wrong for an account fact:
probed with a live key, `/models` names 17 `:free` ids while the account's
own `free` bucket names 5, and **the two sets do not intersect**. Every id
Cline seeded was one its account cannot route, so it was offered, chosen and
failed at dispatch — and nothing prunes a builtin row, so they stayed. Cline
now declares its own 5 free and 15 `cline-pass` rows read from
`/ai/cline/recommended-models`, with `proOnly` on the pass rows so a
subscription-only row says so on the card instead of 401ing at request time.
Kilo and OpenRouter keep the shared list; those ids are verified and served
under those accounts.
- **Hermes: the missing free row, and longcat's vision.** Probed live against
`/v1/models` (424 models). `ornith/ornith-1.5-122b:free` was absent from the
static roster while being live, free and answering 200 on dispatch, so
asking for it resolved to nothing. `meituan/longcat-2.5-preview:free` was
published without vision although the live `architecture.input_modalities`
lists `image` for it, so images were being stripped that the model accepts.
`meituan/longcat-2.0:free` stays excluded and the exclusion is now verified
rather than assumed — it is in the live catalog as free, but dispatch answers
404 "This model is no longer free". All 7 static rows now agree with the live
catalog on context, output, vision, toolCall and reasoning.
- **Repeated thinking text no longer leaks across surfaces.** Reasoning text is
extracted once and guarded against re-emitting the same block on a loop,
instead of each surface reading whichever of summary/payload happened to be
set. Chat, Codex and Messages now agree on one source, so a stream that
restarts a thinking block no longer duplicates it.
- **The shell follows the viewport instead of stopping at 1560px.** Zooming out
does not make the CSS viewport smaller — it makes it wider (50% zoom turns a
1920px screen into 3840 CSS px), and the capped, centred frame simply stopped
growing and parked every extra pixel as empty margin on both sides. That is
what read as "the page does not adjust its width": zooming out showed more
blank space, not more page. The cap is gone, and the sidebar column now
scales with the frame instead of being pinned at 272px, which meant the
content absorbed all the growth and the rail looked bolted on. **The sidebar
track is now capped** at `min(280px, 18%)` with a 252px floor — without a
ceiling it kept growing with the frame, so a wide monitor got ~500px of nav,
far past the width its labels need; the cap hands the rest to the content.
- **The donate dialog puts the QR beside the text again.** `lg:donate-qr-grid`
produced no rule at all: Tailwind only generates variant prefixes for
utilities it owns, and `.donate-qr-grid` is defined in `app.css`, so the
`lg:` form matched nothing and the dialog stayed a single stacked column at
every viewport. The breakpoint moves into the stylesheet as a plain `@media`
block.
- **InferHub per-model health is read by `id`, not `slug`.** `/api/status` keys
per-model health by `id` (`ag/claude-opus-4-6-thinking`); reading `slug`
matched nothing, so all 270 models reported a null success rate — shown as
"unknown" and sorted last, which made the quality ranking useless. 95 of 270
now carry a rate.
- **The InferHub market group memo no longer sits below an early return.** The
`useMemo` was below the "no data yet" returns, so the render that finally had
a summary ran one more hook than the render that did not; React reads a
changed hook count as a changed hook order and threw "Rendered more hooks
than during the previous render", blanking the provider detail page. Also
stops the error surface rendering twice: two boundaries were nested and the
boundary printed both `componentStack` and `error.stack`, which name the same
failure.
- **A lite-mode gateway no longer grows while idle.** A gateway with no
traffic climbed from roughly 120–150 MiB to 802 MiB over about seven hours.
Nothing was unbounded — every cache has a cap and every idle timer writes to
a stable key — so the growth came from statements the SQLite backend never
released. Drizzle compiles a fresh statement per execution
(`SQLiteBunSession.prepareQuery`), `Database.prepare` caches nothing, and
nothing ever finalized one, so each of the ~19 scheduled sweeps compiled a
new statement (and five closures) per tick. Four changes: the backend's
`prepare` wrapper now returns a compiled statement it already holds, keyed by
translated SQL and evicted oldest-first at 256 entries; the three per-request
auth statements use `Database.query`, which carries bun's own cache; `close`
clears that cache and calls `close(true)`, so statements are finalized and
the connection released instead of deferred until they are collected; and
idle reclaim runs whether or not `CARTETHYIA_FORCED_GC` is set — the flag
exists because a synchronous collection stalls concurrent requests, which
cannot happen on a path gated on zero requests in flight. Measured over 500
iterations of two queries, native statement compilations fell from 1000 to 0.

  SQL that the backend rewrites is deliberately not cached: it inlines a value
  into the text, and both rewrites (`now()`, `gen_random_uuid()`) differ per
  call, so caching one would have pinned a query to the value its first
  execution happened to inline.
- **"Sustained memory growth" is no longer raised on a ratio alone.** The alert
fired at 20% growth over a 60-second window, which reported a 2607% leak for
what was a baseline jump: the window's oldest sample predated an idle
reclaim, so a gateway that had just given memory back read as having grown
27×. Growth now also requires at least 64 MiB of absolute increase, so a
post-reclaim recovery or a startup fluctuation is silent. The message keeps
its percentage, because that is the readable part.

### Changed

- **Per-plan admission no longer runs `KEYS`.** `snapshotAccountInflight()`
issued `KEYS admission:inflight:*` plus an unbounded `MGET` on every
`RoutingEngine.plan()` whenever any bounded candidate existed — an O(keys)
scan on the request path. It is replaced by `readAccountInflight(candidates)`,
which reads exactly the deduped candidate buckets via bounded `MGET` chunks
and issues no command at all for empty input. `KEYS` and `SCAN` are now
absent from the request path.
- **Route resolution is O(candidates), not O(candidates × models).** The
model string was re-parsed and the candidate list rescanned for every
candidate on every plan. A per-snapshot index is built once and reused.
- **Payload compression moved off the event loop.** `gzipSync` ran
synchronously per capture, and a byte-loop FNV checksum walked every frame
byte on the hot turn. Compression now runs in one worker per process with at
most two active jobs — never a worker per capture — and checksums use a
chunked native path. The frame is built in a single copy instead of two
`Buffer.concat` passes.
- **Payload writer backlog is bounded.** An unbounded promise chain could
queue without limit; the writer now caps at 32 queued items / 64 MiB, and a
full backlog produces a typed drop (`payloadCaptureState: failed_backlog`, no
`telemetry_payloads` row, `cartethyia_payload_backlog_dropped_total`) rather
than growing until the process dies. The attempt loop also keeps only the
last fired capture instead of every attempt's.
- **Maintenance tasks coordinate across processes.** Previously one process
could start retention while another was mid-run. A Redis lease now serialises
the side-effecting tasks (payload cleanup, retention, session sweep, account
health, OAuth and quota refresh, client-version monitor); the lease is
token-checked on renew and release, never unconditionally deleted. Within a
process, one task runs at a time and a busy tick skips rather than queues, so
there are no catch-up storms.
- **`/v1/models` is cached** for 3 s (256 entries), invalidated by api-key,
provider, model, alias and backup-restore changes, and published across
processes when Redis is configured.
- **Log payloads are bounded.** Every safe-copy and stringify path now
short-circuits when the level is filtered out — `logError` included — and
structural sanitization caps depth, array length, key count, string length
and total nodes with stable `[truncated]` markers.
- **Amortized in-memory work.** RPM pruning no longer copies the surviving
suffix on every prune; reservation cleanup is expiry-ordered instead of
scanning the whole map; round-robin and capability caches share one bounded
LRU whose capability key includes the modality set, so a modality edit
invalidates.
- **Concurrency tolerance lives on the key.** It moved from the runtime
settings modal to the key it widens: the tolerance was tenant-wide while the
limit is per key, so an operator tuning one key's concurrency had to look in
two places and add the numbers up in their head. Both remain — the key's own
value wins and the tenant preference is the fallback — but the field now sits
beside `Max concurrent requests` in the Edit API Key modal, followed by the
effective max spelled out as the sum.
- **Cursor dials direct and Trae proxies by default.** Cursor's upstream is
reached over its own HTTP/2 path that an egress proxy in front of it breaks,
so making the operator discover that after the first failures is the wrong
default. Trae is the opposite: it applies account-level ban/detection
heuristics to the request origin, and a direct egress makes every account in
the pool leave from one identifiable address, so the pool is what gets
flagged rather than one account. Direct stays available as an explicit
`skipProxy` patch — the default moved, it is not a lock.
- **Trae's international realm defaults to the SG core instead of US.** Region
routing is a property of the account, not the deployment: an account
provisioned into `sg` only authenticates against the SG host, and sending it
to the US core answers `1001 "we are not able to authenticate you"`. Accounts
whose region was captured still resolve to their own host, so this decides
only accounts with no recorded region — and SG serves the wider international
roster. US is demoted to the first fallback rather than removed. The
`store-country-code` header falls back to `sg` with it, since that header is
part of the identity the commercial surface checks and has to agree with the
host it is sent to. The request-body `region` tag stays `US`: it is a
realm-level value upstream does not enforce for auth, and changing it without
evidence would be a guess.
- **The ban-duration menu opens downward.** It used `bottom-full`, so it
rendered above the split control and read as belonging to whatever sat above
it rather than to the caret that opened it.
- **Account ids are no longer capped at 100.** The quota refresh, batch
enable/disable and daily-growth route each refused more than 100 with
"exceeds the limit of 100", so refreshing a several-hundred-account fleet
meant hand-batching in the UI. The work was already drained through a bounded
worker pool — 5 at a time — which is what actually protects the upstream, so
the cap protected nothing. The frontend's matching batching is gone with it,
and `useRefreshAllQuotas` reports checked-of-total so a large run shows
progress instead of looking hung.
- **InferHub sends `X-Session-Id`, discovers models live, and maps its own
errors.** The session id comes from the shared affinity resolver rather than
a new one, so a conversation that repeats its opening turn keeps one upstream
pin instead of re-pinning every request. `/v1/models` is now the primary
model source, with Claude ids re-derived onto the Messages wire because the
generic loader only ever emits chat/responses and the chat wire strips
thinking server-side; a failed or empty read falls back to the committed
list, since a `config_read` key is rejected by the inference host with 403,
which is not "InferHub has no models". InferHub failure codes land on
existing error classes; no new code.
- **The InferHub static fallback is a fallback, not a catalog.** The committed
list was a hand-kept snapshot of a marketplace that republishes 270 model
rows across 21 upstreams, so it was stale the moment it was written and wrong
in ways nobody notices: an id that no longer exists still routes, and a new
one is invisible. It is now 95 verified rows across 12 prefixes (ag, ali,
alicn, cb, cbcn, cc, cmc, cx, grok, mm, mmcn, ocg), every slug checked to
exist upstream before being written. Context, output, modalities and the
reasoning scale come from each upstream's own row: rows stating no context or
output cap are recorded as null rather than guessed, vision follows the
published `modalities` (43 of 95 do not accept images and no longer claim
to), and reasoning follows `reasoningLevels` — a row with no scale exposes no
effort control, because claiming one lets the console offer an effort the
provider ignores. Live discovery remains the primary source.
- **The console sidebar drops its placeholder items.** The Tools group held two
"Coming soon" entries and a hardcoded "Soon" badge; the placeholders are gone
and the expandable item remains.
- **Concurrency slack is tenant-wide only; the per-key override is gone.**
`api_keys.max_concurrent_tolerance` is dropped by migration
`0023_drop_api_key_concurrency_tolerance.sql` (both dialects) and the field
is removed from the API-key contract, store, auth snapshot, and the Edit API
Key modal. The two numbers used to stack, with the key's own value winning,
so raising the tenant-wide allowance in Settings appeared to do nothing for
a key that had quietly been given an override. Admission now reads one
value: the tenant's `concurrencyTolerance` above a key's own limit. A key
that had an override falls back to the tenant value — the behaviour every
other key already had. Dropped rather than left behind: a column nothing
reads is still one an operator finds in a backup or a query and trusts.
- **The Settings page is one column, every section on the page.** The page
previously hid sections behind a tab strip, then behind a two-up grid; both
are gone. Security and Privacy share a row because both are short, and every
other section takes a row of its own, in order: Backup, Operations, Data
Management. Operations keeps its own grouping — Routing, Admission, Request
handling, Response shaping — as headings inside its card rather than as four
separate sections, which turned one populated card into four sparse ones.
- **Runtime settings state their deployment default as a number.** Each bounded
dropdown used to offer a bare "Deployment default", asking the operator to
accept a value they could not see. The settings route now returns a
`defaults` object resolved from the same functions the request path uses —
`resolveUpstreamTimeoutMs()`, `payloadRetentionMs()`,
`resolveTelemetryRetentionDays()`, `IMAGE_CLAMP_MAX_BYTES` — so the choice
reads "Deployment default (75 seconds)", "(15 min)", "(10 MB)", and a
changed env still shows the truth. The two-state settings read `Off` / `On`
rather than naming their effect: "Enforced" gave no clue which way the
setting was set.
- **The deployment payload-retention default is one hour, not fifteen
minutes.** `payloadRetentionMs()` fell back to 15 minutes, which is shorter
than the gap between noticing a bad response and opening the request drawer:
the frame was already gone by the time anyone looked for it. A captured
frame is the only record of what a request actually sent and received, so
the window is the time an operator has to go back and read it. The cost is
disk, which Data Management reports and a tenant can reclaim on demand.
`CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS` still overrides it, and the
seven-day ceiling is unchanged.
- **Data Management reports the tenant's retention window, not the
deployment's.** The panel resolved `payloadRetentionMs` once at registration
and answered every tenant with the deployment default, so a tenant
configured for 60 minutes was told 15. `DataManagementConfig.payloadRetentionMs`
is now a resolver taking the tenant id, and `/usage` passes the caller's
tenant through. The panel's four cards — the two disk buckets, the health and
error log, and flush — share one grid, and each card's action is pinned
bottom-right so the buttons line up however the card notes wrap.

### Notes

- **VPS capacity numbers are not yet measured.** The formulas, defaults and
correctness gates are implemented and tested on a 12-core / 16 GiB host; the
1-core / 2 GiB acceptance matrix has not been run, so this release claims no
concurrency or throughput figure for that box. `reports/F2-RESULTS.md`
records what was measured and what was not.
- **Migration and cutover order** for an existing install: drain and stop the
old writers, apply migrations 0020 through 0023 in order, run
`carte telemetry reconcile --apply` then `--verify`, then start the new
processes. Running old file-only writers beside new SQL readers is an
unsupported window. Migration 0021 adds `max_concurrent_tolerance` to
`api_keys` — a NULL on a pre-migration key means no allowance, so existing
behaviour is unchanged until a value is set. Migration 0022 creates
`inferhub_config_keys`, which is empty on upgrade: the market module reports
"no key configured" until an operator adds one. Migration 0023 drops
`max_concurrent_tolerance` again: the per-key override is gone, so a key
that had one now uses the tenant-wide `concurrencyTolerance` instead. An
operator relying on a per-key value should set the tenant-wide number to
match before applying it, or that key's effective ceiling drops to the
tenant value the moment the migration lands.
- **The raw JSONL mirror is retained** as the at-least-once recovery source.
SQL uniqueness plus backfill dedupe is the consistency boundary; torn raw
tails are skipped and conflicts are reported rather than silently
overwritten.
- **One CLI test is skipped, not deleted.** The SGR mouse-click test hung
intermittently under a full parallel run and passed reliably in isolation, so
it failed for a reason other than the behaviour it asserts. The click targets
a hardcoded screen row (14) while an action's row is `headerLines + 3` and
`renderWordmark()` emits 9 lines with colour and 0 without it, so the literal
matches only one of those; deriving the row from the rendered header fixed
the isolated runs (6/6, both colour modes) but not the suite, which points at
the PTY under load rather than the arithmetic. It is skipped with this
diagnosis recorded because the path is real behaviour worth testing.
`menuResult` also gained bounded waits — it awaited two promises that resolve
only if the child happens to print the marker, so an unresolved one hung
until Bun's timeout; it now fails in 5s naming the phase that never arrived.
- **The InferHub market is on demand by explicit decision.** No background
worker, no scheduler task, no SSE consumer, no `refetchInterval`. If
per-tenant cost later makes page-load fetches too expensive, the next step is
a longer `staleTime`, not a periodic fetch.
- **Continuous integration runs green for the first time on this branch,**
which took fixing the suite rather than the product. Every failure was a
test asserting something that belongs to the machine it runs on — CI is an
unprivileged Linux runner with no `.env`, while development happens on a
workstation that has one. 74 failures, one cause at a time.

  The largest was a missing fixture, not a defect: `.env` is gitignored, so CI
  had no `CARTETHYIA_ENCRYPTION_KEY` and every test that seals a credential
  died with "required" — 65 failures. The test runner already redirects
  config, data and telemetry roots into a per-run sandbox; it now generates a
  throwaway key there when the environment carries none, reusing the
  installer's own generator so the encoding cannot drift. An explicit variable
  still wins, so an operator's real key is never reached for.

  The rest were host dependencies. The VPS installer writes unit files to
  `/etc/systemd/system/`, which needs root, so those writes are redirected
  into the sandbox. The HTTP/2 fixture binds 443, also privileged; it cannot
  move to an ephemeral port because the port is part of the SSRF policy under
  test, so the bind is probed and the streaming suite reports `skip` — not six
  passes for tests that never ran, which is what returning early would have
  reported. `dns.setServers` is process-global and was poisoning the shared
  worker, so the DNS suite no longer touches it and supplies the lookup
  instead.

  One production change came out of it: `homeDir` re-exported `os.homedir()`,
  whose value is cached at first use. A test pointing `HOME` at a temp
  directory had its first path resolve correctly and every later one resolve to
  the process-start home — and on Linux that is the only value it ever
  returns, so a CLI-tool injector wrote to the real home while the assertions
  read a directory `afterEach` had already removed. It now reads
  `HOME`/`USERPROFILE` per call, which is what that module's contract already
  claimed. Production behaviour is unchanged: those variables are still what
  decide the directory.

## [2.5.10] - 2026-10-25

### Fixed

- **Trae Agent streams keep complete, isolated tool calls.** An opening tool
frame carrying both an id and arguments now emits both instead of dropping
the first arguments; the adapter also accepts `chunk.tool_calls`, and its
tool-id index is scoped to one stream so a later request cannot inherit an
earlier request's call id. Trae's portable Agent requests again carry the
donor's `x-ide-token` beside `Authorization: Cloud-IDE-JWT`, and an SSE
error with an empty message now reports its upstream numeric code.

  The portable `llm_utils_chat` path remains the supported surface. Native
  Solo task attribution and Max mode are not implemented. A live
  `deepseek-v4-pro-0813` check streamed `OK` with usage using a synthetic
  derived device identity, but returned upstream `4015` with the tested
  account's original numeric device id; this release does not claim that
  identity restriction is resolved.
- **Remote Support runs on every host.** The service used to shell out to a
Windows-only `.cmd`/`.ps1` launcher pair, and if the npm tarball shipped
without them (or on macOS/Linux at all) every Overview card reported
"Launcher not found" or "Remote support is currently scripted for Windows
hosts only." The launcher pair is deleted; the service now spawns
`cloudflared` and `tailscale` directly with `child_process.spawn`,
detached from the gateway so a gateway restart cannot kill a live session.
State and logs live under the per-user config dir
(`[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cconfig%3E]]/remote-support/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Ctool%3E]].{pid,url,log,err}`).
- **`.env.example` no longer advertises defaults the gateway contradicts.** The
sampled `CARTETHYIA_UPSTREAM_TIMEOUT_MS` was `120000` and the sampled
`CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS` was `60000`, but `CONFIG_SPEC`
shipped them as `75000` and `900000` with rationale comments explaining why
the lower / higher value matters (keeping the upstream deadline inside the
client's own budget; letting an unknown failure cool off instead of thrashing
through retries). An operator who copied `.env.example` wrote a configuration
the maintainers had explicitly documented as inferior. Both sample lines now
match the spec defaults and carry the one-line rationale inline.

### Changed

- **`compiledBinaryPath()` and the health checks live beside what ships.** The
helper the CLI launcher resolves the compiled binary from moved from
`scripts/build/compile.ts` into `src/config/package-paths.ts`, and the
health-check module moved from `scripts/health.ts` into
`scripts/cli/health.ts`. The `files` whitelist is back to its pre-2.5.6
shape (`scripts/cli/`, `src/`, `migrations/`, `dist/dashboard/`,
`.env.example`, `README.md`) — a shipped module no longer imports anything
outside the whitelist. Adapted from the proposal in risunCodex PR #3 by
@elliottophellia.
- **Packaging regressions can no longer sneak past checkout tests.**
`test/cli/package-manifest.test.ts` asks `bun pm pack` what would publish,
walks every import of every shipped file, and fails on any relative import
that would dangle, any bare import that is a devDependency rather than a
runtime dependency, and any `bin`/install-lifecycle target that is not in
the tarball. Replaces the earlier hard-coded whitelist string-list guard.
- **CLI menu leads with the version checker, tray drops its background check.**
The console menu now carries a dedicated `Version Checker:` line in the
header that reads `up to date`, `could not reach the registry`, or
`X.Y.Z → Y.Y.Z available`. When something newer is published an
`Update to X.Y.Z` row joins the menu and the arrow-key cursor lands on it
by default — Enter still has to be pressed, so a reflex keystroke cannot
install anything, but attention goes where it matters. Items reorder to
`Open Console / Hide to Tray / Backup / Reset / [Update] / Exit`. The tray
no longer polls the npm registry on open: the version row is a
non-background info label that opens the GitHub releases page on click,
because the previous behaviour surfaced a cue the operator did not ask for
and could not act on from inside the tray anyway.
- **Primary GitHub repository is `risunCodex/Cartethyia`.** The original
`risunCode/Cartethyia` was hidden from public view by GitHub and is kept
as the historical `GITHUB_ALT_REPO` for operators who still have access.
Every public surface — the install script's default clone URL, the console
update-indicator fetch, the README's install block, the installation docs,
the tray's releases link — points at `risunCodex` now, so a fresh install
reaches a repository the public can actually see.
- **Robustness guards: programmatic walkers replace trust-but-no-verify.** A
batch of CI-only tests captures the current legitimate exceptions as
inline-reason allowlists and fails on any new drift. There is no runtime
behavior change; these only make a future regression fail in CI rather
than ship.
  - `test/config/spec-env-example-bijection.test.ts` loads `CONFIG_SPEC` and
  `.env.example`, asserts the symmetric diff matches the allowlist, and
  checks every shared key's spec default agrees with the sampled value.
  This is the test that would have caught the two defaults fixed above
  before shipping.
  - `test/config/no-direct-env-reads.test.ts` walks `src/` for
  `process.env.CARTETHYIA_*` reads that bypass the spec and fails on any
  new one. Seven legitimate direct reads (boot-time, module-local
  telemetry, deployment-injected paths) are named with their reason;
  adding a knob now means declaring it in the spec or extending the
  allowlist deliberately.
  - `test/cli/no-dynamic-imports-in-shipped.test.ts` scans every shipped
  `.ts` for `await import("[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cliteral%3E]]")` and fails unless the file carries
  a `// dynamic-import-ok:` banner (for lazy-registry files like
  `default-registry.ts`, `buddy/capabilities.ts`, `cli/main.ts`,
  `install/install.ts`) or the call has a `// dynamic-import: [[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Creason%3E]]`
  comment above it. Three incidental dynamic imports were converted to
  static while writing the walker: a redundant `postUpstreamJson`
  re-import in the GitHub adapter, a `readdir` import in the event-day
  index, and `buildProviderProbeRequest` in the pool store.
  - `test/providers/registry-integration-parity.test.ts` invokes every
  declared loader on every provider in `PROVIDER_CAPABILITIES` and
  asserts the imported module exposes the promised named export. Catches
  the 2.5.8/2.5.9 shape of bug where an adapter loads but model-discovery
  throws `TypeError` at first request because the registry referenced
  the wrong export name. Also walks `src/providers/integrations/` and
  reports any file nobody imports.
  - `test/providers/registry-metadata-bijection.test.ts` asserts every
  registry id has a `BUNDLED_PROVIDER_METADATA` row and vice versa, and
  that every metadata row has a non-empty `baseUrl` and `displayName`.
  A new provider cannot be added halfway anymore.
  - `test/meta/no-real-fs-writes.test.ts` fails any test that references
  `homedir()`, `USERPROFILE`, `AppData`, a `~/.[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Ctool%3E]]` path, or imports
  from `src/console/cli-tools/injectors/*` without also stubbing
  `process.env.HOME`. Prevents the class of bug where a developer's own
  `~/.codex/config.toml` is rewritten by `bun test`.

## [2.5.9] - 2026-10-24

### Fixed

- **Imported Cline accounts stop asking to re-authenticate.** A 9router /
Omniroute export of a Cline connection carries both an `apiKey` (sk\_...) and
an OAuth access/refresh bundle for the same account. The importer forced the
credential kind to `oauth` because Cline was in the OAuth-preferred set, so
dispatch wrapped the api key as `Bearer workos:sk_...` and Cline refused it
with "Unauthorized: please make sure you're using the latest version of
Cline and re-authenticate". The api key is now stored as `api_key`, dispatch
sends it as a bare `Bearer`, and the refresh token still travels so the
account can rotate to OAuth later without losing it. An explicit
`authType: "oauth"` still forces the oauth path.
- **An OAuth account with no stored expiry refreshes on first use.** An OAuth
row whose `provider_oauth_states.expires_at` is `NULL` but which carries a
refresh token (hand-pasted bundles, migrated accounts) had its `dueAt` left
undefined, so dispatch sent the pasted access token untouched. If that token
had already expired on another install, the upstream answered "re-authenticate"
before the refresh grant was ever used. Dispatch now treats this shape as
due immediately. A failed refresh keeps the already-decrypted token in place
so the upstream's own 401 remains the authoritative verdict, not a
credential-less gateway error raised before the request leaves.

### Changed

- **Buddy catalogs tracked.** Added `kimi-k3.1-pro` and
`kimi-k3.1-pro-highspeed` to the shared WorkBuddy / CodeBuddy roster and the
CodeBuddy CN roster (1,000,000 ctx, 64,000 out). Highspeed is tagged
Pro-only on the international realm, matching every other `BUDDY_PRO_ONLY`
entry's shape. Removed `kimi-k3-1` from CodeBuddy CN, `deepseek-v4.1-pro`
and `deep-model` from the shared buddy roster, and `minimax/minimax-m3.1-flash:free`
from the OpenRouter-backed free roster (Cline, Kilo, OpenRouter).

## [2.5.8] - 2026-10-24

### Fixed

- **The npm CLI finds its runtime modules.** `carte` imported
`scripts/build/compile.ts` and `scripts/health.ts`, both missing from the
2.5.7 tarball — so `carte` crashed with "Cannot find module '../build/compile'"
immediately after `cartethyia setup`. Both folders are now packaged.

## [2.5.7] - 2026-10-24

### Fixed

- **The npm package installs again.** Cartethyia 2.5.6 accidentally registered
the source-checkout installer as an npm lifecycle script. That installer
requires an explicit deployment target and a `.git` checkout, neither of
which belongs to `npm install -g cartethyia`; its supporting directory was
also excluded from the tarball. The lifecycle hook is removed. The documented
flow is unchanged: install globally, run `cartethyia setup`, then run `carte`.

## [2.5.6] - 2026-10-24

### Added

- **Remote support is a card on the Overview.** The Overview grows a Remote
Support card ahead of API Credentials, holding one row per publisher:
cloudflared and Tailscale. Each row carries the publisher's own logo, a
toggle, and the address it published.

  Turning a publisher on launches it **detached**, so the tunnel is not a child
  of the gateway: a gateway restart, a hot reload, or a Ctrl-C in the owning
  terminal cannot kill a live support session. The launch waits for an address
  and reports it in the card; until one arrives the row says
  "Waiting for address…" beside a Cancel button.

  The product never installs anything. A publisher that is not on PATH is
  reported as missing with its own install hint, and installation is detected
  once per process rather than re-probed on every poll.

### Fixed

- **Switching between thinking models no longer breaks WorkBuddy/CodeBuddy
history.** Clients that replace an earlier model's reasoning with an
unavailable placeholder could produce an empty assistant turn that the
upstream rejected with `11151 "history not found"`. Those bare turns are
now removed while tool calls and verifiable reasoning remain intact.
- **A backup can restore into a fresh tenant.** Current exports deliberately
omit the tenant row, but the restore previously created it only when that
row was present in the file. Restoring could therefore fail on the
`api_keys` foreign key before any configuration was written. The receiving
tenant is now ensured before child rows are inserted; an existing tenant is
left unchanged.
- **Restore failures retain the original bulk-insert error.** When both the
bulk write and the row-by-row diagnostic fail, the reported error now names
the bulk failure and retains the diagnostic error as its cause instead of
hiding a connection or transaction fault behind a derived row error.
- **A revoked share link says so, and says what to do.** The gateway already
refused a revoked link, but the public page titled every refusal
"Link not available" — so a revoked key and a paused key read identically to
a recipient while asking for opposite things. The heading now names the cause
(`Key revoked`, `Key paused`, `Link expired`), and the revoked copy states
that a revoked key cannot be re-enabled and a new link is needed. A revoked
link also clears the key this browser kept, so a dead credential is not left
on screen.
- **Tailscale's own setup step is surfaced.** Tailscale requires "serve" to be
enabled on the tailnet, and until it is, the launch fails with a message from
Tailscale itself. That message is now shown in the card as a setup notice,
with a link straight to the enable page, instead of a generic failure.
- **Tailscale stop and status are detected from Tailscale.** Tailscale runs as
a system service, so the launcher's pid file could not describe it: stopping
left the tunnel serving, and status reported it stopped while it was up.
Stopping now resets the serve, and status asks Tailscale whether a serve is
live.
- **The Remote Support toggle reflects the click, not just the poll.** The
toggle read server state alone, so turning a publisher off left it showing
"on" until the next poll landed. It now follows the click immediately and
falls back to the last server reading if the action fails.
- **CodeBuddy tool calls written as markup are recovered.** A tool call
serialized as DSML markup instead of a native tool block reached the client
as literal text. It is parsed back into a real tool call; the tool-name
allowlist stays strict only when the caller supplied one.
- **Encrypted reasoning is replayed under the id it was issued for.** Codex
rejected a turn whose reasoning item id had been re-derived
(`item_id did not match the target item id`). The id the payload arrived with
is now carried through unchanged, and a payload with no surviving id is
dropped rather than sent with a made-up one.
- **A share link no longer clears the key's name.** Creating or rotating a
share link left the key list showing a key with no name. The list is now
refreshed after either action.

### Changed

- **Backup export and restore do less waiting.** Independent table reads run
concurrently, and restore groups compatible rows into bulk inserts with a
savepoint-protected per-row fallback for precise diagnostics.
- **Model and account probes keep their concurrency windows full.** Workers
start the next probe as soon as one finishes rather than waiting for the
slowest member of a fixed batch. Both probe paths now run one sequential
warm-up first to prime credentials and connections before concurrent work.
- **The QRIS support card is inline on the share page.** It used to open as a
modal; it is now a card on the page itself, image left and copy right, with a
download button, and it keeps its two-column layout on a narrow screen.
- **The share page's kawaii styling is themed.** The leading and tracking steps
it needed as bracketed literals are named tokens now, which also clears the
styling ratchet's last two entries.

## [2.5.5] - 2026-10-23

### Added

- **Payload retention is a per-tenant choice.** Captured bodies used to be kept
for 15 minutes for every tenant, in a resolver the configuration spec did not
even declare. Settings -&gt; Privacy now offers 15 minutes, 30 minutes, 1 hour,
6 hours, 12 hours, 1 day, and 7 days, and the deployment variable
(`CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS`) becomes the default rather than
the only value. Seven days is the ceiling.

  A longer window costs disk, and the panel says so from one hour up: every
  captured request keeps a gzipped copy of up to four bodies, so a week of
  retention is a week of bodies on disk.
- **Model-abuse bans can be scoped and timed.** A ban used to be address-only
and always one duration. It is now keyed on the address **and** the API key
that was used, so banning one caller behind a shared address or a share link
leaves every other caller on that address working. Durations are 1 hour,
6 hours, 12 hours, 1 day, 7 days, and Permanent; the request-detail button
bans for one hour and the caret beside it opens the rest.

  "Ban every key from this IP" is still available, and is now an explicit
  choice rather than the only behaviour — which is what an operator wants when
  the address, not the credential, is the problem. The ban list names the key
  each ban is scoped to and says "This key only" or "All keys from this IP".

  **One gap, stated rather than hidden:** a share key's children are issued per
  recipient, so a banned recipient can enroll a new child key from the same
  address and continue. Closing that would ban every recipient behind the same
  NAT — the exact collateral this scoping exists to avoid.
- **The request list updates as requests finish.** The Usage page request list
polls no more: each completed request pushes to the open dashboard over SSE
and the list refetches immediately.
- **Usage cards open on millions.** The four token cards defaulted to raw
counts, which overflowed the card on a busy tenant. They now open on `M`, and
a value too small for the chosen unit falls back to its exact count instead of
reading `0M`.

### Fixed

- **`forceDisableCooldown` reaches hard cooldowns.** The override was stamping
the very flags the eligibility evaluator uses to exclude a hard cooldown, so
it only ever affected soft cooldowns — which were already eligible. An account
parked for a spent quota or a policy block is now reachable, which is the case
an operator actually wants to override.
- **A saved setting takes effect immediately.** Two preferences are read on the
request path from the cached route snapshot, and a save did not invalidate it:
the row was correct while `/v1/*` kept using the revision built before the
save, so the toggle looked broken. Settings now invalidate on save.
- **Cursor's exhausted accounts cool down.** `quota_exceeded` was wrapped as a
transport failure regardless of what Cursor put in `stop_details`, so the
classifier never saw it and an out-of-quota account was never parked. The
real code is now read and promoted, so quota and authentication failures cool
the account they came from.
- **Share child keys get their own rate window.** RPM and concurrency ran on the
parent's counter, so one recipient hitting its limit cooled every other
recipient of the same link. Each child now has an independent window and
slot. Token budgets stay on the parent — that shared pool is the operator's
control.
- **A captured body is no longer dropped on write.** The frame's key list named
four body surfaces while the record builds five, so the fifth was serialized
and then discarded: a capture whose client response sat in the legacy slot
came back with that panel empty.
- **Disk housekeeping reports what is really there.** The panel counted payload
frames reclaimable after 15 minutes even when a tenant had chosen a longer
window, so it offered a reclaim that always reported nothing to reclaim. It
now judges against the longest retention a tenant may choose. The same bound
covers the prune pass, which could otherwise delete a file still holding
frames their rows addressed.
- **Provider max-inflight and API-key concurrency no longer share an error
code.** Both rejections arrived as `capacity_exhausted`, so the two settings
that cause them were indistinguishable on the wire: an operator who raised
the provider's max-inflight saw no change when the ceiling that fired was the
API key's own `max_concurrent`, and the other way around. Routing exhaustion
is now `provider_capacity_exhausted`, and the key's message names the key
rather than the provider.

  The routing error also carries `providerId`, `model`, `maxInflight`, and
  `candidate_count`. A plan that held a single candidate now says so, because
  that is a routing or eligibility fact — raising the ceiling does not fix it.
- **Max inflight says what it bounds.** The routing card labelled the field
"Max inflight / account" and then described it as a "Shared provider
ceiling". It is per account: each account enforces its own limit, so a full
account spills to the next. The subtext now says that.
- **A tunnel's forwarded client address is no longer thrown away.** With
`TRUSTED_PROXY_CIDRS` unset, a request arriving from a loopback peer
(`127.0.0.1`, `::1`, or the mapped `::ffff:127.0.0.1` Bun reports on Windows)
now has its forwarded client headers believed. That is the shape of
cloudflared, an SSH forward, and a local Caddy or Nginx — and when their
headers were ignored, every caller behind one was recorded as the loopback
address.

  That collapse was the dangerous direction: per-IP abuse throttling and
  model-abuse bans are keyed on this address, so one caller reaching the limit
  banned every other caller behind the same tunnel. The audit trail also showed
  one address for everyone.

  A **public** peer's headers are still ignored, so a client cannot name its own
  address. Setting `TRUSTED_PROXY_CIDRS` overrides the loopback arm entirely: a
  configured boundary is `trusted` or `platform`, and neither reaches it.
- **A misconfigured tunnel now says so.** A forwarded client header arriving from
a loopback peer that the boundary will not trust logs one warning naming the
fix and the shared-fate consequence, instead of silently degrading.
- **Legacy tool parameter roots are accepted.** Some clients send a tool's
`parameters` as an empty root, or as a property-name → schema map with a
per-field boolean `required` flag and no `{"type":"object", …}` wrapper.
Upstreams reject both as `invalid_function_parameters` (CodeBuddy `11129`).
The root is now rewritten into an explicit object schema, with the legacy
flag hoisted into `required` — and a field the caller did not flag stays
optional. A root that already holds schema keywords is left untouched:
guessing there would rewrite a valid schema into a wrong one.
- **A provider code hidden in an escaped envelope is found.** A provider may
embed its error object as a string rather than nesting it, so the code that
decides whether an account is cooled was invisible and a blocked account
stayed in rotation failing every request. Both the escaped and doubly-escaped
spellings are now read, as a fallback behind the real nested code.
- **Escaped-underscore schema keys no longer collide away.** A `\_` in a
property name is stripped, which can collapse two distinct keys onto one; they
are now merged with `allOf` (which accepts boolean schemas, so neither
constraint is lost) instead of one silently overwriting the other.
- **A queued upstream request is no longer reported as a refusal.** Qoder
answers `403` with `{"code":"10605","isQueued":true,"retryAfterSeconds":N}`
when it has accepted a request and is holding it until capacity frees up. The
status said "forbidden", so the gateway classified it as one and the client
ended its turn on a request that was only waiting. It is now
`upstream_queued` (503), carrying the interval the upstream stated, and it
fails over to another account first — one that is very likely not queued.

  Recognized conservatively: an explicit queue flag, the `10605` code, or a
  message that is *about* a queue. A body that merely mentions the word does
  not qualify, so an unrelated failure is never turned into "wait and retry".
- **Qoder accounts report whether they belong to an organization.** Read from
the userinfo profile with upstream's own precedence: an organization id or
name, a `userType` naming a team or enterprise, or a shared credit pool. Any
one is enough, because an enterprise account whose `userType` still reads
personal is enterprise as soon as it carries an organization. Both the
snake_case and camelCase spellings are read, since the OAuth and PAT login
paths do not agree on one.

  This is the classification and the label; no console surface renders it yet.
- **Buddy accounts send their enterprise identity.** An enterprise account is
billed from its organization's credit assignment rather than a personal
package, and the upstream reads that from the request: `X-Enterprise-Id` and
`X-Tenant-Id` name the organization, and `X-Private-Data` says the account is
not personal. Both were missing on chat — `X-Private-Data` was hardcoded to
`false`, which the code already flagged as unfinished.

  The enterprise is resolved from `auth_state.enterpriseId` first, then from a
  claim on the access token, so accounts authorized before this existed are
  picked up too. An account with no evidence stays personal: claiming an
  enterprise it does not belong to is the kind of mismatch that draws a channel
  check, and personal is what the gateway already sent.

  The token claim is read from a list of plausible spellings rather than one
  name, because the upstream's token shape is not pinned anywhere this codebase
  can verify.
- **Error codes and messages are unambiguous.** A scan of every rejection site
found codes doing double duty, and messages a client could not act on:
  - `model_abuse_banned` answered in Indonesian — the only non-English message
  on a client-facing surface. It is now English, and names that the ban is
  scoped to this address **with this key**.
  - Two `/admin` and backup-export refusals answered `invalid_request` when
  nothing was wrong with the body: a loopback-only endpoint refused a
  well-formed request (`policy_rejected`), and a bad drain token is a
  credential failure (`authentication_failed`).
  - Z.AI authentication answered `400` where every other authentication
  failure is `401`, sending clients to fix a body that was never the problem.
  - Every IP-abuse refusal carried `details.reason: "admission-unavailable"`,
  which is the label for an unreachable store — so a ban, a rate limit, and
  an outage were indistinguishable. They are now `ip-banned` and
  `ip-rate-limited`.
  - Seventeen codes had no plain-English definition in the Usage page and fell
  through to a mechanical underscore-to-space rendering. All are defined;
  `quota_exceeded` now says which layers can produce it and points at
  `details.reason` to tell them apart.

  Two guards now hold this: a table asserting one code means one status, and a
  scan of every public message for non-English text. Both read `src/` directly,
  so a new inconsistent site is caught the day it is written rather than
  whenever someone re-reads a hand-collected list.

### Changed

- **Compatibility shims are gone.** Backward-compat paths removed across the
board: the `jsonb-file` payload storage type and its binary length header,
the legacy backup rewrites (user-agent mapping, `bypass_proxy`,
`model_allowlist`/`model_denylist`, label-based default-key promotion), and
the resolver prefs behind the retired telemetry compaction. Two environment
variables (`CARTETHYIA_TELEMETRY_WINDOW_MINUTES`,
`CARTETHYIA_TELEMETRY_COMPACT_MAX_FILES`) are no longer accepted — they were
inert, so a deployment still setting them boots unchanged only if it drops
them.
- **The disk panel's buckets are renamed to what the files are.** `Hourly request files` and `Daily summaries` are now `Request event files` and `Day indexes`, matching the per-day index. Event files were never individually
reclaimable; they go with their index at retention.
- **The gateway's 401 no longer tells you to rotate.** Rotation moved to the
public model surface, where the seeded default key is what normally fails. On
a proxy request it sent operators to rotate a key they were never using.

### Performance

- **Environment resolvers are read once.** Ten cooldown resolvers read
`process.env` on every call, and several hot paths called them twice for one
value — including the classifier that runs on every failed upstream request.
Each now caches per process. The model catalog also fetches providers and
accounts in parallel instead of sequentially.

### Documentation

- **One index, one skill set.** The documentation is deduplicated onto single
owning pages, the skill folders are consolidated from twelve to nine with
their unique material folded into the pages that own it, and historical
narrative that had drifted from the code is pruned. `documentation/archive/`
is now marked off-limits and says why: those records were true when written
and are not kept in sync, so reading one as current is worse than reading
nothing.

## [2.5.4] - 2026-10-22

### Added

- **LarRouter is a bundled provider.** An OpenAI-compatible reseller at
`https://larprouter.com/v1`. It is discovery-backed, so its 13 models and
their context windows come from its own `/v1/models` rather than from a
catalog row that would drift.
- **Proxy lists can be pasted in.** Resellers hand out proxies in three shapes
— a JSON array, bare URIs, and `host:port:user:password` rows — and none is
what `POST /network/pools` takes. `POST /console/api/network/pools/import`
accepts all three, so an operator pastes the file instead of converting it.
Unparseable lines are reported per line rather than failing the import.
- **`carte autostart` registers the tray with the OS.** The tray only runs
while someone starts it, which is not much use for a gateway meant to be
always-on. Windows gets a Run value, macOS a launch agent, Linux a desktop
entry — each in the user's own location, so nothing needs elevation. It is
opt-in and reversible: `carte autostart off` removes it, and
`carte autostart status` reports which entry exists.
- **More providers report quota.** Cursor, Trae and Qoder gained endpoint
quota reads, so their accounts show remaining allowance in the console
instead of only failing at dispatch. Trae reads the account's provisioned
region host and authenticates its commercial surface with `Cloud-IDE-JWT`;
Grok reports both its rate-limit window and its request bucket.
- **A language switch and a donation button in the console topbar.** The
language control is a placeholder: the locales are listed and the current
one is marked, but no translation catalogue is wired up yet, so the console
stays in English. Choosing a locale is not offered as a working feature.

### Fixed — the Cursor tool loop

- **A replayed Cursor conversation no longer dies on "tool call no longer
pending".** The Cursor tool loop spans two client requests: the model calls a
tool, the gateway holds the Run open, the client sends the result. When the
gateway restarts between those legs — or the idle Run is reaped — the client
resends its complete recorded transcript, and that resend used to fail with
a 400 telling the client to resend what it had just sent.

  A replay whose every tool result is answered by a tool call present in the
  same conversation — and whose call ids exist nowhere in the process — is now
  rebased into a fresh Run from the recorded history instead of refused. The
  refusals that protect other tenants stay: a tail-only continuation, a
  request with no continuation scope, and a call id that is still live under
  another tenant's session, which would mean adopting someone else's Run.
- **Cursor's host tools execute on the client instead of being refused.**
Cursor's edge asks its local executor for native tools — shell, file write,
file read. This gateway answered those frames with an explicit error, so the
model saw "Cursor host tools are not executed by this gateway", circled, and
fell back to the MCP-channel equivalent only on a later try.

  A host exec the client itself declared is now forwarded as a tool call: the
  client runs its own `_bash` / `_write` / `_read`, and the Run receives the
  variant's typed result frame (`shell_result` / `write_result` /
  `read_result`) plus `stream_close` — the frames Cursor's own executor sends,
  not the generic `mcp_result` that leaves the server unmatched. Argument
  names follow the schema the client's tool declared, so a tool that rejects
  unknown properties still accepts the forwarded call. Exec variants without a
  faithful result frame (grep, ls, subagent, …) and host calls to tools the
  client never declared keep the explicit refusal.

### Fixed — usage telemetry

- **The Usage page no longer reports zero, and no longer loses its history.**
Request events were written to a file per 15-minute window — 96 a day — and
a periodic job folded those into a per-day summary and deleted the source
files. Which of them was still being written was guessed by comparing file
names, and that guess was wrong often enough to fold and unlink a file the
writer was still appending to. Its requests never reached the summary, so an
install could show no traffic at all while serving it.

  Events now append to one file per UTC day, `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cday%3E]].events.jsonl`, which is
  never rewritten or removed while the day is open. Beside it,
  `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cday%3E]].index.json` carries the totals, the per-name breakdown, per-hour
  slots for the chart, and a byte watermark of how much of the event file has
  been counted. Progress is tracked by that offset, not by name, so there is
  nothing left to guess.
- **Usage, breakdown, and the traffic chart read the index instead of the
requests.** A read used to parse every file in the period and filter in
memory, so its cost grew with traffic. It is now a few small JSON reads.
The request list and the detail drawer still read the events, and do so
backwards from the end of the file, so a page of the newest rows no longer
parses the whole day.

  Totals are accumulated, never averaged — a period that reported 2B input
  tokens still reports 2B. Folding runs on read as well as on schedule, so a
  request made moments ago appears immediately; folding twice is harmless
  because it is a sum.
- **Costs are summed as numbers.** Costs arrive as strings from `numeric`
columns and from restored rows, and adding one to a number concatenates
instead of summing — three requests produced `000.0009660.0010320.001008`,
which the console rendered as an empty cost. Both accumulation points now
coerce.
- **Per-key daily and monthly token limits read the current totals again.**
They were reading the old per-day summary format, which nothing writes any
more, so a key that had already spent was admitted as if it had spent
nothing. They read the index now.
- **Retention deletes whole days**, taking the event file and its index
together. Removing one without the other was a trap: an index with no events
reports totals for requests that are gone, and events with no index are
invisible to every usage read.

### Fixed — Cline quota refresh

- **A Cline account on an API key is no longer cooled every minute.** The
scheduled quota sweep built its refresh dependencies without the
provider-specific credential envelope, so the collector received the raw
stored secret. An `sk_...` key with no envelope takes the OAuth branch, gets
`workos:` prepended, and Cline refuses it with "please make sure you're using
the latest version of Cline and re-authenticate".

  The account was therefore marked `quota_fetch_failed` and cooled on every
  sweep while refreshing cleanly from the console — which runs the same code
  with that one field set. Confirmed against a live key: the unmarked
  credential fails with exactly that message, the marked one returns no error.

  Both paths now share one marker function, so a third caller cannot omit it.

## [2.5.3] - 2026-10-21

### Fixed — performance

- **The usage list slowed down as an install aged, regardless of user count.**
Hourly telemetry files were never deleted, so every read scanned every file
ever written: the cost tracked total volume, not the number of users. An
install serving 20 users got slower purely by serving them longer — 122 ms at
42 files, 2.3 s at 720.

  Telemetry is now compacted. Past `CARTETHYIA_TELEMETRY_COMPACT_AFTER_DAYS`
  (default 7), hourly request files are folded into one per-day summary per API
  key, and beyond `CARTETHYIA_TELEMETRY_RETENTION_DAYS` they are deleted. On a
  30-day, 822 MB, 2.16M-request dataset: 30 files, 14 KB, and a 2.0 ms
  aggregate read instead of 2,665 ms.

  **Compaction is accumulation, not sampling.** A summary carries running sums,
  so a period that reported 2B input tokens still reports 2B after its rows are
  folded — verified exactly on the dataset above. Latency keeps an exact mean
  and a bucketed (approximate) percentile.

  **Request Detail is expected to stop working for compacted requests — this
  is by design, not data loss.** Past the compaction age an individual request
  no longer exists anywhere, so its detail returns 404. The message now says
  so and names the knob to keep requests longer, rather than the bare "not
  found" that reads like lost history. The four payload panels were already
  short-lived independently of this: captured bodies expire 15 minutes after
  capture, long before any compaction.

  What is not preserved for a compacted window: the request list, per-request
  filters (status, model, IP), and the detail drawer. Totals in Usage, per-key
  spend, and quota accounting are unaffected.

### Added — operational settings

Three settings that were deployment-only env vars are now editable per tenant
under **Settings → Operations**, without a restart.

- **Force disable cooldown.** Routes to accounts that are cooling down,
including ones already parked. Off by default, and the page says why: a
cooled-down account was parked because the upstream refused it, so dialing it
anyway reproduces that refusal on every attempt — and if every candidate is
cooling, the request fails instead of waiting for a reset.

  The override is **read-only**: the cooldown is still recorded, still shown in
  Health, and still recovered by the sweep, so turning it back off needs no
  cleanup. Per-(account, model) cooldowns are still enforced — those are
  usually a named quota with a stated reset, where ignoring it only buys
  repeated refusals. Shared accounts (no tenant of their own) are covered when
  any tenant asks, since parking one stops everyone.
- **Upstream timeout**, in seconds (5–600). Applied when the request is
dispatched, so it can only shorten a deadline that has already started.
- **Max attachment size**, in MB (0.06–100), per image. An oversized inline
attachment is refused before send rather than after the upstream rejects it:
a block too large poisons every retry and every replayed turn, because the
upstream rejects the whole request rather than the one block. A refused block
becomes a visible placeholder, never a silent drop, so the model is not left
answering a question whose attachment vanished. Applies to the Messages and
Gemini wires.

  Raising this asserts your upstreams accept more than the 10 MB default;
  lowering it is the safer direction. It is per tenant precisely because it is
  a promise about a provider, not a global resource bound — unlike the ingress
  body limit below, which cannot be per tenant at all.
- **Telemetry compaction age**, in days (1–365). Hourly files hold every tenant
together, so the largest age across all tenants wins: compacting later than
asked only costs disk, while compacting earlier would destroy rows someone
expected to keep.

### Fixed

- **Every Settings section is on the page at once.** Security, Privacy,
Operations, and Data render in one scroll instead of one at a time, so a
setting is found by looking rather than by knowing which heading concealed
  it. The nested cards are gone too — the page rendered a card inside a card,
  doubling borders and padding. Sections keep their ids, so a link to
  `#operations` still lands in the right place.
- **Upstream timeout, compaction age, and attachment size are dropdowns in a
grid** rather than free number fields. Each is a bounded value the backend
clamps anyway, so offering the reachable range says what is actually
available instead of accepting anything and correcting it out of sight. A
value already stored that is not among the offered choices is still listed,
because otherwise the control renders empty for a setting that is in force —
which reads as unset and invites changing something already correct.
- **The backup size limit no longer claims 8 GiB the install cannot accept.**
It promised a ceiling far above the listener's own body cap, so the number
described a limit nothing could reach: an upload above the listener's cap was
cut off before that check ran, failing as a reset connection rather than the
413 the constant promised. The bound now follows
`CARTETHYIA_SERVER_MAX_BODY_BYTES`, so the message matches what happened and
raising that variable is what admits larger backups.

### Not a setting: the request body limit

`CARTETHYIA_SERVER_MAX_BODY_BYTES` (default 4 MB) stays a deployment variable,
and that is deliberate. It is enforced at ingress — before authentication, when
the tenant is not yet known — because it is what stops an oversized request
before it is read into memory. A per-tenant override would require accepting
and buffering the body first in order to learn whose limit applies, which is
exactly what the limit exists to prevent.

### Changed

- **Grok reports both of its quota numbers, and they disagree.** The CLI plane
returns a token bucket on every response (`x-ratelimit-limit-tokens: 1000000`), but that figure is eventually consistent — it can still read full
right after a request — and it is not the one that binds. The real free
allowance is 600k per rolling 24 hours, and upstream states it only in the
body of a 429: `tokens (actual/limit): 603024/600000`.

  The header is now read as the everyday indicator and listed first; the
  authoritative figure from a refusal is appended beneath it. Neither replaces
  the other, because a merged number would look precise and be neither. Reading
  the bucket costs one cheap request (~360-480 tokens), since no quota endpoint
  exists — `grok.com/rest/*` exposes none and `/v1/models` carries no headers.

  A refusal is reported as a balance, not a read failure: an account that is
  out of free usage was measured perfectly well, and calling that an error
  would show a broken read on a healthy account.
- **Cursor, Trae and Qoder report a quota balance.** All three had no
collector, so the console showed nothing — and no balance is indistinguishable
from no quota left to anything reading the account.
  - **Cursor** reads `{base}/auth/usage` and `cursor.com/api/usage-summary`.
  The summary wins when it answers: `/auth/usage` is the pre-usage-based-plans
  request counter and reports a permanently-zero bucket on exactly the plans
  that have a dollar cap. The legacy surface is still read, because it is the
  only one an api-key account can reach.
  - **Trae** reads `get_session_usage` on the core host and `ide_user_ent_usage`
  on the pay host, per realm. The two are independent: a dead pay host does
  not erase a readable meter, because "no quota" is what the router parks on.
  - **Qoder** reads `/api/v2/quota/usage` on the openapi host, pooling the plan
  allowance, granted credits and — for team accounts — the shared org pool.
- **A Trae quota exhaustion that arrives as HTTP 502 is classified as quota.**
Trae answers an exhausted quota with status 502 and the body `Your requests have exceeded the quota.` The status was what misled the classifier: 502 read
as a gateway failure, so it was recorded as `server_error` with a 30-second
cooldown that never touched the account. The account therefore stayed in
rotation and every other model on it kept being invoked inside a window the
provider had already closed. The body is the verdict, not the status, so this
is now read as `quota_exhausted` and flags account-wide.
- **`nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` and
`longcat-2.5-preview-free` are no longer catalogued for OpenCode.** The live
Zen roster no longer lists them. A row the provider's own roster has dropped
can vanish from the wire without notice, which makes it a stale row — one
that fails at dispatch with a 404 rather than at catalog load. Removed from
the free and Zen catalogs alike; `big-pickle` and the rest of the shared Zen
listing remain.
- **An unclassified upstream failure cools the account down for 15 minutes.**
It was 60 seconds, which returned the account to rotation and re-dialled an
upstream that had just answered something this gateway does not understand,
so one unknown error was retried every minute. It is still a cooldown with a
deadline, never `disabled`, so nothing here can strand an account.
- **The upstream request timeout is 75s, down from 120s.** Clients cap lower
than the old default, and a provider that has not answered within 75s is
queued or stuck — failing over to another account beats spending the
caller's whole budget on one attempt.
- **A timeout is no longer counted as a gateway error.** `504` is a deadline
that expired, not a malfunction: the request deadline, the stream-stall
watchdog, an HTTP/2 read-idle or WebSocket receive timer. Timeout
requests are still recorded, still rendered, and still filterable — they
are simply not counted against the gateway's error rate, which otherwise
tracks provider latency rather than gateway health.

### Added

- **Restore can be narrowed to selected tables.** Picking a backup file now
opens a dialog listing every table it carries, with row counts and a
checklist that defaults to all of them. **Restore now** proceeds to the
password prompt; **Cancel** abandons it. A table left unchecked is left
exactly as it is — selection is a filter, not a rewrite, so "restore one
table" no longer overwrites the rest with the file's older copy.
- **A Data Management section reports what the gateway keeps on disk.**
Hourly request files, daily summaries, and payload frames are each measured
separately, with how much is reclaimable right now. **Reclaim** drops files
the gateway no longer reads, and **Flush** drains queued telemetry, usage,
and health writes immediately rather than waiting for the interval.

  Every action touches files only, never database rows. Hourly files are
  refused: they are the only copy of their requests until compaction folds
  them up, so deleting one would lose real history. The card says so instead
  of offering a button that would fail. Payload frames go whole or not at all,
  because frames are appended to a file — one is dropped only once nothing in
  it is still live.

### Fixed

- **Remote Routing stayed off after being switched on.** The API-key update
path validated `scopes` and passed them to the store, but the store's update
allowlist never included the column, so a grant like `routing:cli_mapping`
was accepted and silently dropped. The toggle appeared to save and the badge
stayed "no CLI scope".
- **The Force-disable-cooldown toggle could not be switched.** Its button sat
inside a `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Clabel%20htmlFor%3E]]` pointing at that same button, so one click
activated the control twice — the label forwarded the activation and the
click reached the button as well. Both calls read the same state and both
asked to flip it, so it flipped twice and landed back where it started.
- **Settings text no longer fights itself.** A field's label, its value, and
its help text were all 12px, so one field was three equal blocks with no
order; the label and value are 13px now. Backup headings were 18px while the
card above them was 14px, so "Backup" read larger than the card it sat
inside. And `text-subtitle` was in use where no such size exists, so those
headings fell back to the browser default — the class name looked right,
which is why it went unnoticed.
- **Privacy settings are stacked rather than side by side.** Reading a field
two-up meant zig-zagging across for the label and back for the control.

### Changed — payload frame storage

- **Captured payload frames are stored as text lines instead of binary
records.** A frame used to be a 4-byte binary length header followed by gzip
bytes, which made it opaque: reading one meant decoding a big-endian length
and gunzipping exactly that many bytes, and the file could not be inspected
at all. A frame is now base64 of the same gzip bytes, newline-terminated, so
the file is a text file whose records are delimited by `\n`. It is still
compressed, so disk use is unchanged apart from base64's ~33% overhead.

  Frames already on disk keep the old shape and are still read: their rows
  point at them, and they expire on their own within the retention window, so
  both shapes are tolerated rather than migrated. New files use `.jsonl`; the
  prune pass recognises both extensions, because abandoning the old ones would
  leave them on disk indefinitely.
- **A Qoder model that declares `is_vl: false` is now excluded from image
routes.** The router's capability profile granted image support to every row
on a canonical-codec provider regardless of what the catalog declared, so
the declared modality never mattered and an image was forwarded to an
upstream that rejects it. An explicit declaration now wins; the codec grant
is the fallback for rows carrying no modality metadata.
- **Request Detail's Provider Request and Provider Response panels were often
empty.** Two causes. The client response was stored twice — once under its
own key and once under the legacy alias — and the alias was charged against
the shared byte budget ahead of both provider panels, so a large request
consumed the whole budget before they were reached. And the provider tee was
hard-capped at 256 KiB at every capture depth, so raising the depth to
Maximum still produced a quarter-megabyte translated request. The alias is
now accounted last, and the tee follows the depth (256 KiB / 2 MiB / 4 MiB).
- **A queued upstream is no longer reported as a dead credential.** Qoder
answers `403 {"code":"10605", ... "isQueued":true, "queueCount":1395}` when
it is busy. The generic 403 arm claimed it as `auth_invalidated`, so a
healthy account was parked as "Re-login required" purely because the
provider had a queue, and an operator was sent to re-authenticate a
credential that was never rejected. It is now a model-scoped capacity
cooldown. Real credential rejections are still recognised.
- **WorkBuddy's User-Agent used the product brand instead of the wire token.**
It sent `WorkBuddy AI/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cv%3E]]` where an official client sends
`workbuddy-ai/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cv%3E]]`. The international gateway answers the branded spelling
with 403 code `11140`, the same refusal a wrong-brand header gets.
- **Cline `api_key` accounts read their quota properly.** They were reported as
"Quota endpoint is not available" with no upstream call, because the key was
sent as `Bearer workos:sk_...`. Cline answers that with "make sure you're
using the latest version of Cline and re-authenticate" — a message that names
a version problem, so it read as the upstream refusing the client rather than
a misformed header. Verified against a live key: `/users/me` returns 200 with
a bare `Bearer sk_...` and 401 once `workos:` is prepended.

  These accounts now use the same quota surface as OAuth, with the key as its
  own bearer token. Two cases that used to look identical are now told apart:
  a live key on an account with no plan reports no quota and no error, while a
  rejected key reports a real failure. Account tests — per account or all at
  once — go through this same path.
- **Trae `gpt-5.4` reports a 1M context window.** It was filed at 272k.
- **`deepseek-v4.1-flash` and `hy4-preview` are image-capable.** Corrected
across the Trae, CodeBuddy/WorkBuddy, OpenCode and TokenHarbor catalogs.

### Changed — routing defaults

- **Antigravity, Trae, Kilo Code, GitHub Copilot and Kiro now dispatch direct
by default**, joining Hermes, Cline and InferHub. Each is credential-keyed,
so a rotating egress address buys nothing. Not a hard lock: an explicit
routing row still wins, so any of them can be put behind a pool.

## [2.5.2] - 2026-10-21

### Breaking changes — manual step after upgrading

- **The default API key may need rotating once.** The key format changed to
`pn-carte-`; keys minted before it carry the old `carte_` prefix. Old keys
keep working — lookup is by hash, never by prefix — so nothing is rejected
outright. The failure is quieter than that: a caller still holding a key
recorded under the old format (a CLI config, a client that saved it, a
`.env` written by an earlier version) keeps sending a credential that no
longer matches anything, and Model Lab reports only "Request failed".

  If Model Lab or a client fails after upgrading, open **API Keys**, rotate
  **Default Cartethyia API key**, and paste the new key where the old one was
  used. The 401 now says so instead of "unknown, revoked, or expired".

  **Fresh installs are unaffected** — they generate a key in the current
  format at first boot. Only installs carried forward from an earlier version,
  or ones that saved the key somewhere, need the step.

### Changed

- **A 401 for a bad key now says what to do.** It was `invalid_request`, a code
named after the shape of the request, which sent callers hunting for a
malformed body when the credential was the problem. It is
`authentication_failed` now, and the message names the rotate step above
instead of telling an operator to issue a new key — something that cannot be
done to the default key, which has no delete and only rotates.
- **`.env.example` no longer suggests seeding `CARTETHYIA_API_KEY`.** The
console generates and shows the default key at first boot; putting it in the
environment means the secret sits in a file that gets copied around. The
variable still works, it is simply no longer offered as a default.

### Fixed

- **Kiro's `claude-haiku-5.5` reported the 4.5 limits.** It carried 200K/64K,
copied from the `claude-haiku-4.5` row directly above it, while every other
5.x model in the same file uses 1M/128K. Haiku moved to the million-token
window and the doubled output ceiling with the rest of its generation, so the
ceiling was half what the model accepts.
- **Four more catalog rows carried a neighbour's limits.** `claude-sonnet-4.5`
claimed a 1M window in Kiro, Claude and Cloudflare while Opus 4.5 and Haiku
4.5, in the same files, were 200K — the 4.5 trio predates the million-token
window, which arrives with Opus 4.6. Inferhub's `cc/claude-sonnet-4-6`
claimed 64K while the Opus 4.6 row above it was 128K.
- **Nine withdrawn free rows left the OpenRouter-backed catalog.** Gemma 4
(both rows), Nemotron 3 Super, both Laguna rows, both Inkling rows, Xing4.0
and `openrouter/auto` are gone from the shared free roster, so one removal
covers Cline, Kilo Code and OpenRouter. `openrouter/auto` published no
limits of its own anyway — a router's pricing is -1 — so the committed row
was a guess about a window decided at dispatch.
- **Error and empty states are centered everywhere.** The shared primitives in
`ui/state.tsx` were already centered, so the ones that read as left-aligned
were the call sites not using them: Accounts rendered no empty branch at all
when a filter matched nothing, Studio's "No chats yet." was a bare `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cp%3E]]` in a
column, and every state inside a dialog or scroll region reserved the
route-level 220px centering floor, turning a one-line message into a
scrollbar. Badges, toasts and inline form errors stay left-aligned, which is
correct for something sitting in a row.
- **A Cursor quota refusal no longer reports the word "error".** Cursor delivers
`resource_exhausted` as a failed terminal event, not as a thrown error, and
the probe verdict read only the terminal's `stop_reason` — a canonical
one-word label. The toast's entire body was `error`. The verdict now reads
`stop_details`, which is where the adapter parks the upstream sentence and
where the live dispatch path already read it; the two paths disagreed about
the same provider response.

  The same gap had a worse effect: `recordProbeHealth` only recorded a failure
  when a dispatch error existed, so an exhausted account was **recovered** —
  consecutive failures zeroed and its cooldown cleared. A failed terminal is
  now routed through `terminalFailure`, the same function the live path uses,
  so both classify it identically.
- **A probe records all four payload stages.** The probe's capture passed only
the request and the client response, and built its exchange wrapper with body
capture off, so the provider-response tee always resolved to null. Every
probe row reported the middle two stages as absent — a constant, not a
measurement, which made the stage markers useless for the diagnosis they
exist for. Measured: the bitmask went from 9 to 15.

  The client events were also passed as `responseBody`, the legacy alias, which
  lit the client stage over a body that was never captured. They now go to the
  dedicated client surface.
- **A throttled account is no longer counted as healthy on the provider list.**
A model-scoped backoff leaves `status: "active"`, so a card built from status
alone read "1 Healthy · 1 Cooling" for a single account that could not serve
the model being asked for. Cooldown and Cooling are now one badge, and
neither is counted under Healthy — the counts are mutually exclusive and add
up to the account total.

### Added

- **The update badge opens a dialog instead of a release page.** Pointing it at
GitHub told an operator a release existed and left them to work out the
install themselves, on a page that does not mention it. The dialog shows what
is running against what is published, gives the command, and copies it.

  A release alert in the notifications bell now opens the same dialog rather
  than the release page; other alert kinds keep their link.

  **It also opens on its own**, once per release. An operator on an old version
  is the one least likely to go looking, so waiting for a click defeats the
  point. But a dialog returning on every navigation punishes whoever already
  decided not to upgrade, so dismissing records the version and the prompt stays
  away until a newer one is published. The badge still opens it on demand.
- **The dialog says why the console cannot just install it.** npm cannot replace
the package directory while a process is executing out of it — on Windows the
rename fails with `EBUSY` — so a button that tried would fail in a way that
looks like a gateway bug. The command is the honest offer, and the dialog
explains why.

### Changed

- The update command lives in one place (`NPM_UPDATE_COMMAND`) so the console,
the CLI's printed instructions, and the docs cannot disagree about the flag.

## [2.5.1] - 2026-10-21

Version housekeeping, plus one fix for the tray.

### Fixed

- **Closing the terminal no longer takes the gateway down with it.** "Hide to
tray" started the gateway attached to the tray process, so the gateway died
whenever the tray did — and the tray died with the terminal that launched it,
which is why the icon appeared and then nothing was serving. The gateway is
now started detached, so it outlives both.

  Detaching it costs the exit path nothing: `stopGateway` drains over HTTP
  before it ever reaches for `kill()`, so **Exit** in the tray still stops the
  gateway. What detachment does remove is the ability to wait on the child's
  exit, so the tray polls `/health` instead — measured: with the tray killed,
  the gateway keeps answering.

### Changed

- **`dist/` is rebuilt**, so the bundled dashboard and binary match 2.5.0
rather than the 20 October build they were carrying. The provider icons, the
"Jinhsi" sidebar badge, and the corrected CPU tile were all in the tree but
not in the shipped artifacts.

### Fixed

- **The dashboard manifest carries the release version.** `dashboard/package.json`
was left at 2.5.0 when the root moved to 2.5.1. Nothing publishes that package,
so nothing broke — but a check asserts the two agree, and it would have failed
on the next bump.
- **The styling-ratchet regeneration command in its own comment was wrong.** It
named a `--scope`/filter invocation the test runner does not accept, so
following it produced a usage error and no manifest. It now names the command
that actually runs, and records that a relative root silently truncates every
path key, which reads as a tree with no debt.

## [2.5.0] "Jinhsi" - 2026-10-21

Release preparation includes 69 commits since 2.4.6.

### Added

- **The Notifications bell streams gateway alerts.** While the console is
open, it samples gateway memory every 10 seconds and checks for new releases
every minute. It reports high RSS (85% of system RAM) and sustained RSS growth
(20% over a minute), plus available updates. These are live-only server
notifications; they are not persisted, and a stalled GitHub check does not
block memory sampling.
- **The providers page can hide providers with no account.** A 73-row catalog
where an operator has connected three still meant scrolling past seventy
cards to reach their own, so a new toggle filters to configured providers.
Credential-less providers (OpenCode Free, Exa, Parallel) stay visible: they
have no account because none is usable, not because one was never added, so
hiding them would hide a working route. The preference is per browser
(localStorage) and shared across tabs, like the existing privacy toggles.
- **Console JSON responses carry a strong `ETag` and answer `304`.** A dashboard
poll for an unchanged window now costs a conditional request instead of the
whole payload — roughly 200 bytes instead of 8.8 KiB to 150 KiB per poll. The
cached usage endpoints (summary, chart, by-dimension, cache, requests) and
`/console/api/system/health` all participate. Health is now cached on the same
10-second Redis read-through as its siblings; it previously re-parsed 24
hourly telemetry files on every page load.
- **Dashboard assets are precompressed at build time.** `dashboard/vite.config.ts`
emits a `.gz` beside every built text asset (gzip level 9, paid once per
deploy) and writes `dist/dashboard/precompressed-assets.json`. The gateway
serves the `.gz` when the client offered gzip, with `vary: accept-encoding`
and the same immutable cache header; a build without them still serves the
plain file.
- **Two indexes** for the tenant-scoped provider reads:
`providers_tenant_id_idx` (migration `0013`) and
`provider_accounts_tenant_id_idx` (migration `0014`), in both dialects.
Neither table had an index serving the bare `tenant_id IS NULL OR tenant_id = ?` that the provider list and the account listing use.
- **Buddy providers can present a real CLI identity.** The CLI identity this
gateway sent was a hybrid no official client produces: `X-IDE-Type: CLI`
alongside desktop browser transport, and with every CLI-only marker missing.
The complete CLI contract is now available — the `X-Agent-*` envelope,
`X-IDE-Version` (which CodeBuddy never sent at all), the eight
`x-stainless-*` fingerprints, `traceparent`, and b3's parent span — and
`x-product` is the official `SaaS` rather than an invented `WorkBuddy`.

  **Nothing changes by default.** Identity is exactly the header a wrong value
  can get an account blocked on, so a provider only flips when an account or an
  operator opts in; unset leaves every header byte-identical to before.
- **Cursor is a bundled provider.** It speaks Connect-RPC over protobuf on a
bidirectional HTTP/2 stream, so it is reached through validated HTTP/2 egress
rather than `fetch`, and its Run origin is resolved per dispatch from
`GetServerConfig` instead of being a configured base URL.

  Its tool loop spans **two client requests on one upstream Run**: the first
  returns a tool call and the second submits that tool's result on the same Run,
  so the Run — and the account and pool slot it holds — outlive the request that
  opened them. A continuation is authorized by server-recorded tenant, API key,
  provider, and account, not by the call id alone; a mismatch is refused, and a
  call that is no longer pending fails explicitly rather than starting a Run the
  model is not waiting on. An unanswered Run expires on its own
  (`RUN_IDLE_TTL_MS`) so a tool round the client never answered cannot hold a
  stream and a slot indefinitely.

  Only an `mcp_args` call whose namespace and function name match a tool the
  request declared is executed. Cursor's own shell, filesystem, and workspace
  tools are answered `rejected`, never run. Images are sniffed and size-checked
  before the Run is dialed, and image URLs must be HTTPS and are not followed
  through redirects. Unrecognized bytes are rejected even when labelled as a
  supported image type.

  There is no quota collector and no static catalog: no Cursor quota endpoint is
  established, and the roster is per-account and per-plan. See
  [Cursor provider](documentation/features/cursor-provider.md).
- **Trae is a working provider, on both realms.** `trae` and `traecn` are two
providers, not one region flag: separate core, account, and pay hosts, and a
CN `Cloud-IDE-JWT` against an intl `Bearer` plus a live client version — the
CN host answers 4015 without it. Login is the browser PKCE flow the login page
actually runs (login host resolved via `GetLoginGuidance`, callback path
`/authorize`, `AuthCode` redeemed through `public/oauth/ExchangeToken`),
refresh is rotation-aware, and a personal access token imports as a
refreshable credential. A port collision during login is now a 409
`oauth_callback_port_unavailable` instead of a hang; `CARTETHYIA_OAUTH_CALLBACK_PORT`
(default `59653`) moves it.

  Dispatch selects the region host per account — an SG token is refused by the
  US core with 1001 — and follows the row's own endpoint, which matters because
  Trae serves two **disjoint** surfaces: chat
  (`/api/ide/v1/llm_raw_chat`, keyed by `model_name`) and agent
  (`/api/agent/v3/llm_utils_chat`, keyed by `config_name` plus `config_source`).
  The picker's models live only on the agent surface, so the intl catalog is
  agent-only. Tool calling works there: `parameters` is a JSON *string* upstream,
  responses nest under `function_call`, and fragmented deltas are reassembled by
  index.
- **Qoder publishes names you can call.** Upstream keys are opaque slots
(`dfmodel`, `cmodel`), so the catalog now publishes caller-facing names
(`deepseek-v4.1-flash`, `cantus`) and dispatch translates them back; a slot
with a known name appears under that one id only. A second realm, `qodercn`,
has its own gateway host, OAuth client, roster, and icon. The roster reads the
**selectable** context maximum rather than the active one — 180k was being
published where 1M is selectable — and the live list is cached 300 s per realm.
- **`/v1/embeddings`, `/v1/audio/transcriptions`, and `/v1/audio/speech`** are
open as **passthrough** surfaces. The gateway routes them, applies admission,
leasing, failover, and accounting, and forwards the body untouched — no
bundled adapter implements them, because there is no wire here to translate.
They are useful against a compatible upstream you configure yourself, and a
model row carrying the matching service kind is all that is needed. These
three had previously been listed in the route table with no handler behind
them, so they advertised a surface that 404d; a test pinned that absence, and
both are updated.

  A **custom** provider is read as able to serve every service kind, so all
  three are reachable without touching the manifest. The widening is taken from
  the canonical tuple rather than a second list, so a surface added later is
  reachable immediately instead of silently excluded.
- **`/v1/images/generations` and `/v1/videos/generations`** are exposed on the
gateway. Both take an opaque body and let the provider's own adapter shape it,
so what a model accepts is what that provider accepts. Images are served by
Gemini, Antigravity, Codex, and the Buddy family. Video is declared only by
CodeBuddy and WorkBuddy, via `seedance-2.5`, submitted as an async task the
adapter polls to completion rather than returning a clip inline. A **custom**
provider is not limited to either list — `providerServiceKinds` grants an
unregistered upstream all three kinds, so any OpenAI-compatible host you point
at can serve both routes, and a remote that lacks them answers with its own
error rather than a gateway refusal.
- **`models.free_tier`** (migration `0019`, both dialects): whether the provider
publishes a model as free. Nullable and three-valued — `true` free, `false`
billed, `NULL` unstated — because Qoder omits `is_free` on several rows and
collapsing that absence into `false` would assert a fact nobody measured. The
dashboard shows it as a tier badge, and the badge never moves a row between
catalog groups.
- **An L2 cache with cross-process invalidation.** `src/persistence/shared-cache.ts`
adds `readShared`/`writeShared` for small values and
`publishInvalidation`/`subscribe` for large derived ones — the route snapshot
costs 11 SELECTs, so a console write now broadcasts instead of every process
re-deriving it. Wired into auth (keyed by token hash), the settings revision,
and the route snapshot. Inert without Redis: `REDIS_URL` is what makes it
cross-process, and without it behavior is exactly today's in-process caching.

### Changed

- **Copilot Luna Auto now exposes one canonical efficient model id.**
`gpt-6-luna` selects the `efficiency` tier. The separate
`gpt-6-luna-low`, `gpt-6-luna-medium`, and `gpt-6-luna-high` catalog entries
are removed; the latter two no longer appear from account discovery either.
- **Chat decoding recovers tool calls when an upstream emits the captured
`<tool_calls:…>` envelope as assistant text.** Previously the XML-like call
and argument tags appeared in the answer and no tool ran. Complete envelopes
are now recovered across SSE chunk boundaries; only names declared by the
request can become calls, and the same markup in the reasoning channel is
removed without executing it. An incomplete envelope is neither run nor
surfaced.
- **gzip now applies only where it said it did.** The compression wrapper is
scoped by a path allowlist (`/console/api/` and `/metrics`) inside
`gzipResponse`. Elysia merges a child instance's `hoc` into the root app, so
the wrapper was running for every route in the process — `/v1/models` was
being compressed as a side effect, contradicting the module's own docstring.
`/v1/*` is now left alone. Responses with no body, and bodies over a new
1 MiB ceiling, are also passed through: the ceiling bounds the synchronous
`gzipSync` stall on a multi-megabyte backup export.
- **Background work is less frequent.** Measured on an idle gateway with no
traffic, PostgreSQL transactions per 5 minutes fell from **138 to 56** (about
28/min to 11/min). Six buddy growth tasks move from hourly
to daily (each is a once-per-day claim, already ledger-guarded, so 23 of 24
passes found nothing); `buddy-trial` 6 h → 24 h; `account-enrichment-sweep`
30 s → 10 min; `console-session-sweep` 1 h → 12 h (sessions live 48 h);
`client-version-monitor` 15 min → 30 min, matching its own resolver cache
TTL; `pool-agent-sweep` 1 min → 5 min. `quota-refresh-sweep` refreshes
entries at least 8 minutes old instead of 4 — half the 15-minute cache TTL,
so an account is refreshed about twice per window rather than three times.
- **The share stats rollup is cached for 10 s, not 2 s**, and the share SSE tick
moves to 10 s to match. At 2 s the cache expired on every tick, so every push
re-parsed the retained telemetry window.
- **The catalog re-seed is gated on a revision signal.** Every snapshot rebuild
used to re-run the bundled catalog seed — a `DELETE` per provider plus a full
upsert — and `account-health-sweep` invalidates the snapshot on any cooldown
recovery, so a 30-second timer could push that onto the next proxy request.
The re-seed now runs only when a provider was registered, edited, or retired.
- **The dashboard reuses cached data more aggressively.** The default
`staleTime` rises from 10 s to 60 s, and to 5 minutes for the CLI tool
registry and runtime settings. Hover prefetch now targets what each
destination renders (settings and keys, providers, pools) rather than
`system.health`, which none of those pages display.

  settings. Account, credential, key, share, audit, quota, and payload reads are
  never persisted, so the snapshot holds no unmasked values at rest. Logout and
  401/403 clear the persisted snapshot alongside the in-memory cache.
- **Five dependencies nothing imported are gone.** `@bufbuild/protobuf`,
`@electric-sql/pglite`, `impit`, `exact-mirror`, and `undici` had zero real
imports anywhere: every `protobuf` hit was prose in a comment, the grok quota
decoder is hand-rolled, lite mode already used `bun:sqlite`, and `impit`
alone carried eight platform-specific optional binaries. `exact-mirror` still
installs because elysia declares it a required peer — that is elysia asking,
not this project.
- **Buddy model discovery asks `/v3/config` first.** Both reference gateways
treat it as the primary catalog and the personal-models path as the narrower
fallback; this gateway only ever called the latter. The old path still
answers whenever the new one does not, so a host serving only it behaves
exactly as before. The live model list will move — the last snapshot lists
`gpt-6-astra`, which the bundled catalog omits today.
- **`workbuddycn` probes the CN directory path.** It was asking a CN host for
the international path, which the CN edge answers with 500 rather than 404 —
so the failure read as an upstream outage instead of a wrong path. CN billing
also moves to `www.codebuddy.cn`, the host the reference bills that realm on,
while `X-Domain` stays the domain recorded at login.
- **Qoder output ceilings are per model, not one clamp.** A hardcoded 32k
applied to every row alike, which is what made the whole catalog look capped
at a single number. Upstream states no output limit at all, so the ceiling now
comes from the row: 384k for DeepSeek-V4, 512k for MiniMax-M3, 131k for GLM.
- **API keys are `pn-carte-` and share keys `sh-carte-`, both with a 16-character
tail.** Personal keys were `carte_` and share keys `sh-carte_`, each with a
12-character tail. The separator is now a hyphen and the tail is 16
characters — 12 bytes base64url-encoded, which is exactly 16 with no padding.
Keys already issued keep the prefix they were created with: nothing resolves a
key by its prefix, so no stored credential stops working, and regeneration is
what moves a row to the new form.
- **Qoder's plan refusal is scoped per model.** Code `112` was treated as
`auth_invalidated`, which cooled the whole account for what is a statement
about one model on one account. It now enters the model-scoped unreachable
ladder (6 h, doubling, capped at 24 h). An insufficient-quota refusal still
cools the account, because that one really is about the account.
- **Cursor's client version is discovered, not pinned.** `x-cursor-client-version`
is `cli-[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cversion%3E]]-[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Csha7%3E]]`, and both halves come from the official download API
— the only source that returns them together. The constant that was previously
hardcoded is now only what a cold process sends before the first fetch.
- **Health writes no longer invalidate the whole route snapshot.**
Classification carries whether a write is visible to routing, and the
model-scoped path — which touches neither `status` nor `cooldownUntil` —
reports false. OAuth credentials are also cached with a TTL bound to token
expiry, removing a SELECT plus a decrypt from every attempt.
- **Claude caching anchors on the last system block.** The breakpoint moved from
the first block to the last, so a stable prefix actually stays stable. Expect
one cache-miss wave on upgrade as fingerprints change.
- **Hermes egress and identity.** The egress pool is skipped by default
(Cloudflare answers 403 for pool addresses) and the Client-identity control is
locked to the adapter's own User-Agent. `stepfun/step-5-preview:free` is
removed — retired upstream, now a 404 — and `poolside/laguna-xs-2.1:free`
drops from 131072 to 32768 output tokens.

### Fixed

- **Console recovery clears stale login lockouts.** The local `carte` reset
previously removed console users but left the per-login failure buckets in
`console_lockouts`; recreating the account from the same IP therefore stayed
temporarily blocked. The reset now clears both in one transaction.
- **A probe no longer retires an egress on the first connection failure.**
`bun run probe:egress` reported "fails the first time, works on retry"
because one dead socket ended the probe: a cold dial has to resolve the
proxy, open the CONNECT tunnel, and finish a TLS handshake, and any of those
can be refused or reset once and then accepted on the very next attempt.
Transport failures are now retried up to three times.

  A real refusal is *not* retried — a `403 FreeTierError` is an answer about
  the address, not a failure, so a blocked egress still reports immediately
  instead of spending three attempts proving it. Our own deadline is not
  retried either, so a slow address is reported slow rather than consuming the
  whole budget re-dialling it. Measured against a dead endpoint: 53 ms and one
  attempt before, 1271 ms and three attempts now; a genuine 403 still answers
  in 888 ms with a single attempt.
- **`GET /console/api/backup/export?compressed=1` is no longer double-encoded.**
The route declares an opt-out instead of `content-encoding: gzip`: the bytes
are base64 of a gzip stream, and a client told "this is gzip" tried to inflate
the base64 text and failed. The compressed download works again.
- `/console/api/system/usage/requests` now honours `limit` on every page, not
only the first: a cursor page used to fetch the whole retention window.
- Single-event detail reads no longer parse the retention window to find one row.
- The per-account check-in marker is read in one batch (`MGET`, or one
`WHERE account_id IN (...)`) instead of one round trip per account.
- Provider deletion bumps the catalog revision, so the next snapshot rebuild
prunes the deleted provider's models.
- **Two streaming-contract tests no longer hang.** They waited for the provider
generator to advance before issuing the read that would let it advance: the
stream is demand-driven, so the generator parks after each chunk until the
next pull. Both now keep a second read outstanding — still never cancelled,
which is the property under test — and each passes in about a second instead
of timing out at 15 s. No production code changed; the deadlock was in the
test.
- **Built assets are now recognised as hashed, so they cache correctly.** The
filename check only matched the old `app.a1b2c3d4.js` spelling and never the
hyphenated `app-BCnqn3N3.js` that Vite actually emits — measured against a
real build it matched **0 of 288 files**. Every bundle was therefore served
with a one-hour revalidating header instead of `immutable`, so the browser
re-downloaded the whole dashboard after every deploy, and no asset was served
from its precompressed sibling. Both separators are now matched, with a
generated-looking check so plain words like `console-backgrounds.jpg` are
still excluded.
- **Cursor responses are no longer discarded.** `decodeServerMessages` was
dropping the final frame because Cursor sets `END_STREAM` on the frame that
carries the answer — every response was thrown away and the Run looked like a
heartbeat deadlock. Refusals arrive as Connect JSON envelopes inside a 200
stream and are now raised as `quota_exceeded`/502 instead of being read as
success, and a Run with a pending tool call is no longer torn down before the
result comes back. Separately, `grok-4.6` is no longer rewritten to
`cursor-grok-4.6` upstream; that rewrite made every Grok Run answer
"AI Model Not Found".
- **A failed credential lookup no longer leaks, and no longer 500s.** The log
line carried the SQL statement **and the API key hash** at request rate. It is
now a sanitized message, a 503 `accounts_unavailable` instead of a 500, a 1 s
short-circuit so a degraded store does not stampede, and a flush backoff.
- **A single `apiKey: sk-…` credential line is stored as a key.** It was
previously saved as the literal `key: value` line, so the key was lost and
every dispatch using it failed auth.
- **Discovery reads what the provider states.** Output limits were falling back
to 64,192 on a 384k model because `max_completion_tokens` was not read;
`capabilities.input` and declared `reasoning`/`tool_call` were pinned instead
of parsed. All three now come from the upstream row.
- **"None" in Client identity now sticks.** Selecting it fell back to the
previous value because an empty emission was rejected unconditionally; it is
now accepted only when the caller published a labelled empty option, which is
what the identity dropdown does. The API-format dropdown keeps the old rule.
- **"Test all" reports progress, not a verdict.** It showed pass/fail per
account while still running, so a partial sweep read as a result. It now shows
`Tested N/M`.
- **The memory watcher reads memory that is actually current.** The
notifications feed sampled RSS through `health`, which is cached for 10 s —
and it samples on that exact cadence, so consecutive samples could be the same
cached bytes. A growth trend over identical samples cannot fire, and a spike
could be reported up to 10 s late with a value from before it. It now reads
process memory directly, which costs nothing and is never stale. The cached
`health` read is unchanged for the dashboard tile, which is what the cache is
for.
- **CPU load no longer reports a fake 0.0% on Windows.** `loadavg()` is
`[0, 0, 0]` on every Windows build — there is no such syscall and Node returns
a zeroed tuple rather than failing — so divided by cores it produced a
confident "0.0%" on a busy gateway, which reads as idle. Reported as
unavailable instead, and the tile says load average is not reported on this
platform.

## [2.4.6] — 2026-10-18

### Changed

- **`scripts/` is grouped by what ships.** `scripts/cli/` is now the only
directory in the npm package's `files` array, so the boundary between "runs on
the operator's machine" and "runs in the repository" is visible in the tree
instead of in a hand-maintained list. The list had already drifted: it shipped
`scripts/operations/restart.ts`, which imports `scripts/build/binary.ts` — a
directory that was not shipped, so the file was broken in every published
tarball. `tray-assets/` moved into `scripts/cli/tray/assets/` for the same
reason: only the CLI ever read it.
- **`scripts/cli/cli.ts` is nine files.** It had grown to 743 lines and twelve
functions covering dispatch, the gateway lifecycle, the menu, the tray, and
the admin calls, with `startMenu` alone at 203 lines. Dispatch is `main.ts`;
one file per subcommand under `command/`; the gateway lifecycle under
`gateway/`; the enquirer prompts, wordmark, and background spawn under `ui/`;
and the helpers under `support/`.
- **`scripts/shared/env.ts` is four files.** It held the dotenv reader, the TCP
probe, the Bun version check, the PostgreSQL detector, and the per-OS hints in
one 269-line module, so `doctor` pulled in the dotenv parser to ask a question
about a socket. Now `support/env.ts`, `support/services.ts`, `support/bun.ts`,
and `support/platform.ts`.
- **Directory names say what they hold.** `build/` and the two operations that
run the compiled artifact are `binary/`; the browser automation under `dev/`
is `qa/`, leaving `dev/` for the dev server; `test/` is `ci/`, which stops it
from reading as the repository's own `test/` directory. `build/binary.ts` is
`binary/compile.ts`, which is what it does.

### Added

- **`cartethyia doctor`.** `doctor.ts` shipped in the package but no `case` in
the dispatcher reached it, so the command answered "Unknown command". It is
wired now, and `bun run doctor` still works.

### Fixed

- **`carte --tray` reports success instead of timing out.** The tray is spawned
detached with no stdio, so it reports readiness through a one-shot signal
file the launcher polls. Nothing wrote that file: the 2.4.3 tray refactor
dropped the call while keeping the waiter, so every `carte --tray` waited out
its 60 s deadline and then reported that the tray had failed — while the tray
was running.
- **The tray is spawned with no console window.** The launcher still used
`cmd /c start "" /b`, and `cmd` is a console application: it allocated the
console the whole change was meant to avoid, and it also exited immediately
with code 0, which the launcher read as "the tray died". It now goes through
`wscript.exe` and the same hidden-window VBS that "Hide to tray" uses.
- **`carte` exits in 640 ms instead of 30.7 s.** The graceful-drain wait in
`gateway/stop.ts` arms a 30 s timeout and never clears it, so the event loop
stayed alive for the full 30 s after the gateway was already gone.
- **The launcher resolves the package root and Bun correctly from `bin/`.**
Moving the launchers one level deeper left `packageRoot` pointing at
`scripts/`, and the launcher runs under Node, so `process.execPath` is
`node.exe` rather than the Bun the child needs. Bun is now resolved from
`PATH` (or `CARTETHYIA_BUN`).

## [2.4.5] — 2026-10-18

### Fixed

- **Update prints the command instead of failing with EBUSY.** An in-process
`npm install --global` can never succeed: the process running the install is
itself executing out of the package directory npm has to rename, and on
Windows that rename fails with `EBUSY` and npm exits `14`. Stopping the
gateway was not enough, because the CLI and the tray still run from that
directory.

  Update now stops everything and prints the command to run, which is what
  9router does:
  ```text
  Update available: 2.4.4 → 2.4.5
  
  Run this now that Cartethyia has stopped:
  
     npm install --global cartethyia@latest --prefer-online
  ```

  `cartethyia update` behaves the same way. `npmUpdate()` is deleted: it could
  only ever fail, and reporting its exit code as "update finished" is what made
  a failed install look successful.

## [2.4.4] — 2026-10-18

### Fixed

- **An update now actually takes effect.** `npm install --global` cannot replace
the package directory while a process is running out of it: on Windows the
rename fails with `EBUSY` and npm exits `14`. The update ran with the gateway
and the menu still alive, so the install failed and the failure was reported
as success — "Update to 2.4.3 installs now", with the install left on 2.4.2.
Both the menu and the tray now stop the gateway before the install and start
it again afterwards, and a non-zero npm exit is reported with its code and
the current version is restored rather than leaving nothing running.

## [2.4.3] — 2026-10-18

### Fixed

- **The tray no longer leaves an empty console window.** On Windows the tray
was a Node process holding a `systray2` helper, and Windows Terminal kept a
tab open for it for the tray's whole lifetime. That window belongs to the
terminal, not to the process — `MainWindowHandle` reads 0, so it cannot be
found and hidden from inside, and neither `windowsHide` nor
`detached: true` removes it.

  The tray is now platform-specific (`scripts/cli/tray.ts`): on Windows it is a
  PowerShell `NotifyIcon` (`scripts/cli/tray.ps1`) driven over JSON lines on
  stdin/stdout, started with `-WindowStyle Hidden` so it owns no console at
  all. macOS and Linux keep `systray2`, which attaches no console there. This
  is the arrangement 9router uses.

### Changed

- `scripts/cli/cli.ts` drops the `systray2` dependency from its tray path, and
the tray helpers that existed only to launch and stop a Node tray process
(`waitForTrayStartupSignal`, `launchUpdatedTray`, `waitForTray`, `stopTray`)
are gone.

## [2.4.2] — 2026-10-18

### Fixed

- **"Hide to tray" now actually runs the gateway in the background.** The handoff
was handing a live gateway to a tray that adopted it, which meant the tray
owned nothing and the port was empty after choosing it. It now follows the
same shape as 9router: spawn a detached `tray` process that starts and owns
the gateway from scratch, then drain this one so the new process can claim the
port. The tray is a normal first-class run rather than an adopted orphan, so
Exit, update, and `cartethyia stop` all behave the same whether the gateway
was started from the menu or from `carte --tray`. The adoption path is gone.

## [2.4.1] — 2026-10-18

### Fixed

- **`carte` on a fresh install runs setup instead of crashing.** With no config
file, the menu booted the gateway immediately and the operator got a stack
trace about `CARTETHYIA_DB_MODE` being required — naming an environment
variable, not "you have not set this up". It now detects a missing config (or
a config with no database mode) and runs setup first, then starts.
`cartethyia start` still requires setup to have run, because it is the
foreground server command, not the entry point.

## [2.4.0] — 2026-10-18

### Added

- **`cartethyia stop` stops a gateway this shell did not start.** The drain
token was regenerated on every start and `runtime.json` was deleted on
shutdown, so the token `stop` read could never match the gateway actually
running — it reported "no gateway found" or a 401 against a live process.
The token is now created once per install and kept, so the menu, the tray,
and `start` all authenticate with the same secret. `stop` also waits for the
port to stop answering before reporting success; a 202 is not a stop.
- **Backup writes a file, not a settings page.** `POST /admin/export-backup`
writes a gzipped config backup to the download directory. The dashboard
export requires the console password, which is exactly what a locked-out
operator does not have; this route is gated by loopback plus the install
token instead. It exports the `config` section only — `telemetry_events`,
`telemetry_usage_totals`, and `telemetry_payloads` are per-request history,
are the bulk of the file, and are not what an operator is recovering.
Restore stays a console action.
- **`POST /admin/reset-console-account`** deletes every console user, which puts
`requiresSetup()` back to true so `/console` asks for a new account. A
forgotten password previously had no recovery: `/change-password` needs the
current password and first-boot setup only runs when no user exists. Gated
by loopback, a constant-time token, and the literal body
`{"confirm":"RESET"}`. Providers, API keys, and routing are untouched.
- **`carte` opens an arrow-key menu.** It lists Open Console, Reset console
password, Backup, Visit repository, the update row, Hide to tray, and Exit.
Built on `enquirer`, so it works over SSH and headless with no desktop
environment.

### Changed

- The gateway runs detached with its output in `gateway.log`, so the menu owns
the terminal instead of competing with startup logging.
- The tray's three version rows collapse into one that carries the running
version and either "up to date" or "update to X".
- `scripts/cli/cli.ts` splits by responsibility into `menu.ts` (key capture and
confirmations), `runtime-state.ts` (the install token), `version.ts`, and
`wordmark.ts` (the ANSI banner). `scripts/media.ts` moves to
`scripts/operations/media.ts`. `bun run test --scope scripts` covers the CLI.

### Fixed

- **The gateway dies with the menu.** Ctrl-C used to leave it running, so the
next `carte` reported "already running on port 12800". The gateway was
spawned detached and unref'd, and `kill()` from an exit handler does not stop
a detached child on Windows — measured: the call ran and the gateway kept
serving. It is now a child in this process group, so Ctrl-C reaches it
directly and `process.on("exit")` covers a closed terminal or a crash.
"Hide to tray" still hands it over untouched.
- **An adopted tray's Exit stops the gateway.** "Hide to tray" hands the
running gateway to a tray that adopts it, so the tray holds no child process
and Exit only closed the icon, leaving the gateway listening. It now drains
through the loopback endpoint.
- Starting while a gateway is already running reported "stopped before
becoming ready (exit code 1)", naming neither the port nor the cause. It now
says the gateway is already running on that port and how to resolve it.
- The wordmark repeated down the terminal because the header was printed
inside the menu loop while `enquirer` redraws its frame per keypress.
- A start failure printed "Cartethyia failed to start:" with an empty message.
It now names the exit code and the usual cause.

## [2.3.4] — 2026-10-18

### Fixed

- The **menu now receives Enter.** `carte` rendered its menu but never got a
second keypress: the gateway was spawned with `stdin: "inherit"`, so it held
the descriptor and swallowed everything after the first key. The gateway
does not read stdin and the menu is the only consumer, so it now spawns
with `stdin: "ignore"`. Arrow keys move the selection and Enter chooses.

### Changed

- `scripts/cli/cli.ts` (794 lines) is split by responsibility: `menu.ts`
owns key capture, `runtime-state.ts` owns the `runtime.json` drain token,
and `version.ts` owns the installed/published version and `npm update`.
No command or flag changes.
- `scripts/media.ts` moves to `scripts/operations/media.ts`, beside the other
provider-facing operations. Run it as `bun run scripts/operations/media.ts`.
- `scripts/how-to-gen-media.md` is deleted; nothing referenced it.
- `bun run test --scope scripts` is a new scope covering `test/scripts/`. It
pins the three CLI behaviours that regressed in 2.3.x: the non-interactive
menu guard, the drain-token round-trip, and a corrupt state file reading as
"no background gateway".

## [2.3.3] — 2026-10-18

### Added

- `cartethyia stop` stops a gateway left running by the menu's **Hide to
background**. That process is not a child of the stopping shell, so it
cannot be signalled directly: the drain token is written to `runtime.json`
in the config directory (mode `0600`, outside `.env` because it authorises a
shutdown) when the menu detaches, and `stop` posts it to the loopback
`/admin/drain` endpoint. The file is removed once the drain is accepted, so
a stale token never outlives its gateway. Without it `stop` reports that no
background gateway was found instead of guessing at a process.

### Fixed

- "Hide to background" no longer prints a command that did not exist. It
previously told the operator to run `cartethyia stop`, which was never
implemented — the only way to stop a hidden gateway was to find the process
by hand.

## [2.3.2] — 2026-10-18

### Added

- `carte` now opens an arrow-key menu instead of going straight to a
system-tray icon: Open Console, Settings, Hide to background, Check for
updates, and Exit. It is built on stdin raw mode, so it adds no menu
dependency and works over SSH, on a headless box, and on Windows where the
tray icon lands in the hidden-icons overflow and is never seen.
`carte --tray` still starts the icon for anyone who prefers it.

### Fixed

- `carte --tray` releases the launching terminal. The Node launcher used to
stay alive after the gateway was ready, which kept the shell open; it now
exits once the console URL has been shown. On Windows the child is spawned
through `cmd /c start "" /b` so it gets its own console group and closing
the terminal no longer signals the gateway.

## [2.3.1] — 2026-10-18

### Fixed

- `ws` is bumped to `8.22.0`. The pinned `8.18.3` carried two advisories —
uninitialized memory disclosure and memory exhaustion from tiny fragments —
and npm reported no fix because the dependency was exact-pinned. Only
`src/network/pool/resolver.ts` imports it, for the proxy-pool egress probe.
- Installing the package locally no longer reads as a broken install. The
commands live in `./node_modules/.bin/`, which is not on `PATH`, so
`cartethyia` and `carte` did not resolve after `npm install cartethyia`.
The install instructions now say `--global` is required, name `npx cartethyia` as the local-install path, and point Linux and macOS users at
npm's EACCES guidance for a global install that needs `sudo`.

## [2.3.0] — 2026-10-18

### Added

- Usage now includes average routing/preparation delay and period-bound P50,
P95, and P99 request latency in its summary cards.
- Buddy accounts now report **real** credit usage: per-day and per-model
deductions read from the billing meter's usage-detail endpoint and stored, so
the Quota page shows what the upstream actually deducted instead of only the
synthetic activity events the gateway reports itself.
- Six optional Buddy growth tasks — streak makeup, milestone redeem, streak
lottery, cat travel, first-buddy adoption, and the trial/gift/compensation
claims — one per upstream capability. Each is switchable individually with
`CARTETHYIA_DISABLED_TASKS`, claimed at most once per account per day, and
never allowed to mark an account unhealthy.
- A Buddy request that arrives without a cache key now gets one that is
isolated per account (`wb2a-[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cuid%3E]]-[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Chash%3E]]`). The same conversation id on two
pooled accounts used to produce the same key, so one account's prefix cache
could be reused — and billed — against another's. A key the client supplied
is kept.
- `POST /admin/tasks/{name}/run` triggers one scheduled task immediately. It
uses the same loopback-and-token gate as the drain endpoint, answers 202
once the run has started, and 409 when that task is already running.
- `bun run probe:egress` asks a provider whether it will serve a given egress,
from a list of proxies, from a file, or from stdin. It sends the provider's
own dispatch through the same validated fetch and pool agent the gateway
uses, because a neutral canary cannot answer the question: a refused OpenCode
address still answers its model listing with 200. See
`documentation/archive/opencode-egress-probing.md`.
- A provider's Routing Strategy card has **Max inflight / proxy**: how many
concurrent requests one proxy pool may carry *for that provider*. It is a
third ceiling beside the per-account one and the pool's own capacity, not a
replacement for either, so a pool can be busy with other providers while this
one still has its own share. Default is unlimited, which keeps no counter and
costs nothing until an operator sets a value. Migration `0010` adds the
column.

### Changed

- Newly issued personal API keys use `carte_` followed by 12 random characters;
- A fresh database builds from the current baseline. An existing database
applies the numbered files that followed it, recorded in
`cartethyia_schema_migrations`. A ledger that names a retired file is
rejected: recreate the database and recover through backup/restore, which
maps retired routing and pool fields into the current schema.
- A chat turn is dispatched once, to the route its model selects. The gateway
no longer executes a model-emitted `web_search` call against a configured
search provider: a hosted search declaration is forwarded to the upstream
that owns it, and `POST /v1/search` on a `websearch` catalog row is the only
way to run a search.
- The offline model catalog is a packed, brotli-compressed binary blob
(`src/providers/discovery/catalog/catalog-blob.ts`, built by
`scripts/generate/models-catalog.ts`) instead of the `base-models.json` plus
`scripts/generate/models-dev-snapshot.ts` pair, both now removed. Boot cost
drops from parsing 8090 JSON rows into live objects to one brotli decompress
(~3 ms) and typed-array views: ~140 KB of source where the JSON was 969 KB,
with no per-row object until a row is asked for.
- OpenCode's fetched free models now publish the upstream's real limits. The
dispatch listing (`/zen/v1/models`) carries no limits, so absent rows used to
be published with an invented 200k/64k; the catalog now takes them from
`models.opencode.ai` (e.g. `ling-3.1-flash-free` 262144/32768, `exo-free`
1048576/131072). Editing an auto-fetched model on a bundled provider also
works, where it previously answered `Model not found`.
- An OpenCode free-tier (`opencode`) dispatch is refused with 403
`FreeTierError` when the **egress IP** is blocked, and no request change
helps: the official 2.0.32 client, its stored OAuth token, and a third-party
gateway all reproduce the same refusal from an affected host, while the
byte-identical request answers 200 through a proxy. A datacenter egress is
refused, so this provider needs an egress proxy rather than a header fix. The
request contract itself is unchanged: `Authorization: Bearer public`, the
11-tool agent set, and `stream: true`.

### Fixed

- The OpenCode archive is reorganised around one canonical document,
`documentation/archive/opencode-free-tier.md`: the measured contract, the two
failures that look identical (shape vs egress), a runnable replay recipe, a
dated timeline, a corrections ledger of every claim this investigation got
wrong, and what is still open. The other documents are now marked as history
or method and link to it, and their stale values are corrected in place.
- The OpenCode dispatch identity now sends `x-opencode-client: cli`, matching the
captured 2.x dispatch, the local 2.0.26 CLI captures and the reference
gateway. It previously sent `desktop` on the strength of a code comment that
no source in the archive supports. The gate accepts both, so this was never a
refusal — it was the adapter claiming a client identity it does not have.
- The OpenCode gate's minimum header set is measured: **`user-agent` plus one
of `x-opencode-session`, `x-session-affinity`, or `x-session-id`**. Every other
header — including `authorization` — is individually droppable without a
refusal, but `x-opencode-session-id` alone does not satisfy the check, and the
session value must be a well-formed `ses_` id (`not-a-session` and empty both
answer 403). We keep sending the client's full set; the finding is about which
header a change must not drop.
- More of the OpenCode gate is measured, mostly as things it does **not**
check: prompt size, 20-turn history, a system turn, `temperature`, `top_p`, a
missing token cap, absent or malformed trace headers, and `x-opencode-request`
all answer 200. `/zen/v1` answers `429 FreeUsageLimitError` rather than the 403
the capture records — the lane is alive and rate-limited. Volume is not the
trigger either: 12 sequential and 8 concurrent dispatches through fresh
proxies all answered 200.
- The OpenCode free-tier tool threshold is measured at **3**, not the 10–11 the
archived capture recorded: 0/1/2 tools answer `403`, and 3 through 13 all
answer `200`. Streaming remains mandatory (`stream: false` → 403). We still
send the client's full 13 — the lower floor is a fact about the gate, not a
reason to send less.
- OpenCode's free-tier User-Agent rule is measured: the gate requires
`opencode/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cchannel%3E]]/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cversion%3E]]/cli` with a **version segment** and a floor of
**1.18.0**. `opencode/latest/cli` — the value the archived capture records —
now answers `403 FreeTierError`, and anything below the floor answers
`426 UpgradeRequired` with the upstream's own explanation. Above the floor the
exact number is indifferent (1.18.0 through 99.99.99 all pass). Our adapter
already sends the three-segment form; the capture document now carries a
warning so nobody follows it into a 403.
- The OpenCode free-tier refusal was measured against five fresh egresses: the
session counter window is **1–63** (64 and above answer `403 FreeTierError`),
the 64-hex internal session literal is refused, and `x-opencode-client`,
the session-id/affinity split, and three project-header shapes all pass. The
refusal therefore follows the egress address, not the request. Recorded in
`documentation/archive/opencode-session-identity.md`.
- `x-opencode-project` is sent as 40 hex, hashed from the project identity, in
the shape the 2.x client emits. The literal `global` was a value that passed
one probe, not the client's own shape, and the gate fingerprints this header
beside the session id.
- OpenCode session ids are capped at the counter window the free-tier gate
accepts. The client's own generator lets the counter grow without bound, so a
burst of more than 63 dispatches inside one millisecond produced ids outside
the accepted window — and a pool produces exactly that burst. On overflow the
timestamp advances one millisecond instead. The bundle trace, the generator,
and what is still unverified are recorded in
`documentation/archive/opencode-session-identity.md`.
- The model probe now sends the same request shape a real dispatch does:
`stream_options.include_usage` is attached, the sampling temperature is no
longer pinned, and the output allowance is sentence-sized instead of 1024.
The probe's whole purpose is to predict what live traffic will do, and it was
a different request — which is how a provider could reject the share page with
`400 request illegal` while accepting the probe.
- A quota fetch that failed for this sweep no longer raises a `Quota unreachable` pill on the account row. The account routes fine — only its
allowance is unknown, and the next sweep retries. A real refusal
(`quota_exhausted`) still shows, because it does not clear on its own.
- The Usage request list's reported-model toggle now reads **Show reported** /
**Hide reported**, matching the mask toggle beside it instead of naming a
state.
- `muse-spark-1.2-contributor-free` is back in the OpenCode free catalog on the
Responses wire. It was dropped as deprecated, but it answers `200` with the
agent tool set; the `403 FreeTierError` it returns without tools is the
free-tier gate judging the request shape, not the model. Its sibling
`muse-spark-1.3-contributor-free` is genuinely retired (`410 ModelDeprecated`)
and stays out.
- The model an upstream reports in its own response is now recorded separately
from the one the request asked for (migration `0012`, `telemetry_events.reported_model`).
A provider that answers a `muse-spark` request as `deepseek-v4.1-flash` is
telling the operator something the request cannot, and the two values were
previously conflated. The probe toast shows it under a cog beside the sample,
and Usage shows it on a third line behind a **Reported** toggle that defaults
off. Taken verbatim — no prefix stripping, no comparison — and absent when the
response named no model.
- Testing a pool against OpenCode now **enforces** its verdict: a `blocked`
answer retires that egress for the provider, so the next dispatch skips it,
and any other answer clears a previous block so a replaced proxy returns to
rotation without a separate button. Before this the verdict was recorded and
the pool stayed in rotation, which is why a pool could read `OpenCode blocked`
and still receive traffic.
- A provider probe verdict is stored on the pool row (`network_pools.provider_probe_*`,
migration `0011`) instead of in the operator's browser. It used to live in
`localStorage`, which made it decorative: another machine saw nothing, the
gateway saw nothing, and admission kept routing through a pool the badge
called blocked. The row records the endpoint the verdict was measured
against, so re-pointing a pool reports "never probed" rather than a colour
about an address that no longer exists.
- The Proxy Pool tester no longer answers a question nobody asked. A probe
verdict is keyed to the endpoint it was measured on, so re-pointing a pool at
a new proxy drops the old verdict instead of showing `OpenCode blocked` for an
address that is gone. The edit form tests the endpoint **being typed** rather
than the saved one. And the probe timeout rises from 20 s to 45 s: four
concurrent probes measured 16.7 s on a healthy egress, which left a working
proxy intermittently reported as `unreachable`.
- An OpenCode probe no longer reports a usable egress as `unreachable`. The
probe sent an empty `messages` array, on the theory that the IP gate runs
before the body is read; it does not. A healthy address answered
`400 messages must not be empty`, and every non-2xx that was not the
free-tier refusal was mapped to `unreachable` — so four proxies that serve a
real dispatch were shown as "OpenCode unreachable", blaming them for the
probe's own request. The probe now sends one short turn, and any 4xx from the
upstream's own validation reads as accepted. A spent rate is reported as
`throttled` rather than lumped in with failures.
- A request no longer ends on the first refused proxy. `opencode` is
credential-less, so its route plan holds a single candidate carrying every
eligible pool, and pool selection happens inside one attempt. The attempt
loop judged "this is the last candidate" as terminal, which was true on the
first failure — so a 403 `FreeTierError` flagged the egress and then failed
the request while a healthy pool sat in the same candidate. A failure the
pool caused now retries the same candidate against a different pool.
- When every pool is refused, the answer is `503 proxy_pool_blocked` and says
the upstream refuses them, instead of a cooldown message asking the operator
to wait for a timer that never fires. Pool exhaustion and a provider's own
per-proxy share now answer `proxy_pool_capacity_exceeded` and
`proxy_pool_provider_capacity_exceeded` respectively, so the fix each one
needs is named.
- An existing database now receives the unique index the bundled model seed
upserts on. A database created before that index existed died at boot with
`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`
and never listened. Migration `0008` adds it; a fresh baseline already has
it, so the statement is a no-op there.
- A second GitHub Copilot account now adds a row. The device dialog polled
faster than GitHub allows, so the approval never produced a token, and the
login lookup sent Copilot headers to `api.github.com/user`, which answers
  400. Without a login every account shared one label and the next login
  replaced the row it should have added.
- An OpenCode dispatch carrying more than 128 tool definitions is clamped
before it is sent. Definitions the conversation already called are kept;
the rest fill the remaining slots. Upstream refuses the unclamped list.
- A payload capture now keeps the Buddy conversation and tracing headers the
channel check reads, so a `conversation id missing` refusal can be told
apart from a header that was never sent.
- Tool arguments that are not strict JSON are repaired before the client
parses them. Copilot streams a raw control character or a trailing comma;
the client used to report the failed parse as a missing tool.
- The console log reads a request across the full width, leads with a status
badge, and keeps the newest line at the top. Nothing is truncated, and a
request that has not finished yet no longer prints a row of dots.
- `POST /v1/messages/count_tokens` now answers for any routed model. A route
with no Anthropic Messages row (a combo of chat-family providers, for
example) used to fail with `capability_unsupported`, which left Claude Code
unable to decide whether a context still fit. Those models now get a local
estimate — characters ÷ 4 with a flat reserve per image, counting `system`,
tool rounds, and `tools` — the same basis the reference gateways use. A
Messages route still forwards the count, so the provider's own number wins.
- A Buddy rejection that is about the request, not the account, no longer cools
the account down. `11148` (broken tool sequence), `11135` (unreadable image),
`11133` (a parameter the model rejected), `11101` (a body that failed to
parse), `12153` (a dead session), and `14017` (trial not yet activated) are
deterministic for that body, so parking the credential only burned a healthy
account on a request that fails the same way everywhere else.
- A quoted `11128` in an outbound Buddy message is rewritten to `11-128`. The
upstream blocks any request whose body contains that exact digit run — it is
the code of the block itself — so a client that pasted the error was refused
again for mentioning it.
- The proactive token refresh now includes accounts that are cooling down.
Their token still expires while they are parked, and a refresh that lands
during the cooldown is what lets them serve the moment it ends. Disabled
accounts stay excluded.
- Buddy model discovery drops completion, NES, and codewise rows, rows whose
declared output is 256 tokens or less, and `text-to-image` rows. Listing them
offered a chat route that only answers 400.
- A Buddy request carrying more than 16 images keeps the first 16 and replaces
the rest with a note, instead of sending a body the upstream rejects outright.
- The gateway refuses a 65th concurrent `/v1` request with 503 and a
three-second retry hint. Per-key and per-tenant caps still apply; this is the
process-wide ceiling they do not provide.
- Log lines written on a telemetry failure are scrubbed of bearer tokens, JWTs,
provider key prefixes, and inline base64 images before they are written.
Captured request bodies are unchanged — those stay verbatim so a failure can
still be read.
- A Buddy `max_tokens` above the model's catalog output limit is clamped down
to that limit, the same way an unsupported effort is clamped to the nearest
level the ladder serves. Both are repaired at the gateway rather than
refused: the client asked for an answer, and the gateway is the side that
knows the limit. A model with no measured ladder is left alone.
- A Buddy account with no device token in its auth state falls back to the
file the desktop client writes (`CARTETHYIA_DEVICE_TOKEN_FILE`, default
`/app/data/device_token`). The read is cached for five minutes and a file
larger than 1 KB is ignored. A missing file is the normal case and sends no
header.

  
- Streaming tool calls now retain the upstream completion event, so completed
tool-call turns end with `tool_calls` instead of a synthetic stream error.
- PostgreSQL and SQLite baselines now include provider account identity
enrichment fields. Databases created from an older baseline are rejected
instead of repeatedly failing the enrichment sweep.
- SQLite and PostgreSQL baselines now include alias and combo ordering columns,
so first-boot routing lists load successfully.
- Backup restore now maps legacy ciphertext with the active encryption key,
skips rows for retired providers with a warning, and includes the current
model-combo ordering column in both database baselines.
- A stored background is shown by default unless it was explicitly hidden.
- Alibaba Coding Plan is grouped with well-known API-key providers, and its
import-only credential action is labeled "Add API key" rather than OAuth.
- The Usage page no longer reports an unreceived in-flight snapshot as zero.
- Proxy imports work on Lite databases by restoring network-pool health and
accounting columns omitted by the SQLite transport migration.
- CodeBuddy CN requests are clamped against the CN effort ladder instead of the
international one. The realm was never threaded through, so a level the CN
backend serves (`max` on DeepSeek V4.1 Flash, `medium` on GLM 5.1) was
silently downgraded to what the international backend accepts. CN-only model
ids also get an output limit now, so a raised effort no longer answers inside
a budget sized for the lower one.
- A model the upstream does not serve stops being redialed: Buddy business code
`11102` (and the `service info not found` / `model ... not supported` wordings)
now cools just that (account, model) pair, escalating 6h → 24h per repeated
report and resetting after a success. The account stays routable for every
other model.
- `auto` and `default-model` resolve to one upstream model instead of being two
independent rows, so two clients naming the same backend model no longer get
separate routing and cooldown keys.
- Database suites no longer fail on a machine with no test database, and
`CARTETHYIA_DB_MODE` is restored rather than deleted by the dialect tests —
the deletion leaked into other files sharing the worker and made them fail
with "CARTETHYIA_DB_MODE is required".
- Buddy chat requests now send the conversation and tracing header family the
upstream's channel check reads: `X-Conversation-Request-ID` (the turn-level
aggregation key the reference marks mandatory), `X-Conversation-Message-ID`,
`X-Root-Request-ID`, `X-Trace-ID`, and the B3 trace headers. Without them the
upstream answered `400 · 11128 "conversation id missing"` and refused the call
as not sent from an official client.
- The gateway endpoint on the Overview page uses the origin the dashboard is
actually served from. It was rewritten to the gateway's default port, so any
deployment listening on another port or behind a TLS-terminating proxy
advertised an endpoint that did not answer.
- A request now records **why** its telemetry drawer is empty. The four payload
panels read blank whether capture is switched off, the tenant is missing, the
attempt was not the terminal one, the capture-preference read failed, or the
storage write failed — so an operator debugging remotely, without access to the
server's logs, could not tell "capture is off" from "capture is broken". The
reason is in `payloadCaptureState` on the request row and in the request-list
and request-detail responses.
- The Quota page no longer refreshes accounts by itself. It loads once and then
only on an explicit refresh: the page used to poll (every 2s while accounts
were warming, every 60s otherwise) and to enqueue a refresh for every account
whose cached value had aged out, so a single page open hit every provider's
quota endpoint at once. The periodic sweep already keeps quota warm; the page
is a viewer, not a second scheduler.
- "Test all" now runs three accounts at a time instead of all of them at once.
Firing every account simultaneously is a burst the provider's own quota
endpoint rate-limits, which failed accounts that pass individually.

## 2.2 Zhezhi

Released 2026-10-12.

### Added

**Providers**

- 28 providers added, in three auth shapes.
- **API key, live discovery.** `groq`, `together`, `deepinfra`, `siliconflow`,
`siliconflow-cn`, `novita`, `venice`, `nanogpt`, `baseten`, `synthetic`,
`stepfun`, `sakana`, `helmcode`, `coralbricks`, `aiand`, `wafer-serverless`,
`qianfan`, `coreweave`, `qwen-portal`, `zhipu-coding-plan`, `umans`,
`minimax`, `minimax-code`, `minimax-code-cn`, `firepass`. Each lists its
models from the provider's own `/v1/models` rather than a restated catalog,
with limits and pricing resolved from the bundled `base-models.json` rows.
- **OAuth.** `factory` signs in with the WorkOS device-code grant and
keeps a real refresher — the access token expires with its JWT, and the
organization claim that Factory requires on every call travels with it.
`cloudflareai` and `alibabacp` take a pasted credential
instead: the gateway needs the account and gateway slugs that form its base
URL, and the Alibaba plan needs the region that selects which of two hosts
serves it. Neither has a refresh grant, so neither registers a refresher.
- Static model rosters for `factory` (59), `cloudflareai` (11), and `alibabacp`
(21). None of the three publishes a model-listing endpoint this gateway can
call — Factory's roster is client-side and narrowed per account, Cloudflare's
lives behind the account slugs in its URL, and the plan key lists nothing — so
the catalog is the list. Context and output come from the bundled
`base-models.json` rows; capability is declared per row, never inferred.
- Provider-specific wire rules that are not a bare bearer: `coreweave` sends the
`OpenAI-Project` header from account state, `qwen-portal` coalesces multiple
system messages into one (the portal answers 500 otherwise), `minimax*` and
`umans` serve Anthropic Messages rather than OpenAI chat, and `firepass`
carries a Kimi context cap.
- The dashboard's **Fetch models** control now appears for any provider that
registers a discovery resolver, instead of only for custom ones. A bundled
provider with no resolver still shows no button; nothing that worked before
changes.
- Three routing defaults change for every provider that has no routing row.
Max inflight is unlimited rather than 5, so a provider an operator never
configured is no longer capped — and the rejections that produced read as
`capacity_exhausted`, a capacity claim about a limit nobody set. A ceiling an
operator did set still holds. A bare API key with no client identity of its
own now identifies as the Claude Code CLI (`claude-cli/[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cversion%3E]] (external, cli)`, on the live version) instead of a frozen Codex literal, which named a
different vendor's client on requests that mostly reached neither upstream.
Cline continues to skip the proxy by default, unchanged.
- Model sync no longer needs a stored account. A usable one is used when there
is one; the fetch is attempted either way, and a provider that does require
auth answers 401 itself. Previously the gate answered a local 409 — "Model sync
needs a usable account first" — which blocked most providers, since they
publish their model list without auth.
- `gpt-6-luna` joins the CodeBuddy and WorkBuddy rosters at the shared 1,050,000
context window. Both read one shared list, so the row reaches each site at its
own endpoint path. CodeBuddy CN keeps its separate roster and is unchanged.
- `dashscope` (Alibaba DashScope, mainland) on `coding.dashscope.aliyuncs.com`,
a bearer key distinct from the Token Plan. Eight models ship as a static
floor; `/v1/models` discovery adds whatever the plan currently serves.

**CLI and system tray**

- The package installs globally as `cartethyia` and `carte`. `cartethyia setup`
still runs the configuration wizard; `carte` starts Cartethyia in the system
tray instead of a foreground terminal.
- The tray menu carries the running version, a link to the repository, a version
tracker that reads the npm registry, and entries for the Console, a password
reset, and backup/restore — both of which open Console Settings, so neither
action duplicates a flow the Console already owns. Exit drains the gateway
through the authenticated `POST /admin/drain` route and waits for in-flight
requests instead of killing the process.
- Choosing the update entry installs `cartethyia@latest` through npm and relaunches
the tray, confirming readiness over a one-shot signal file before the old
process exits. An install that fails restarts the current version instead of
leaving the operator with nothing running.
- Tray launches detach and hide their window, so no console stays attached
behind the tray icon; the launching terminal prints `Loading Cartethyia…` and
the URL once `/health` reports ready.

**Media generation**

- `POST /v1/images/generations` is a separate service from chat, with its own
dispatch path and body envelope. Chat turn headers, turn metadata, and routing
hints are not sent on it.
- Provider-owned image wires: Gemini asks `:generateContent` for `IMAGE` and
reads `inlineData`; Antigravity streams its agent envelope and reads
`inlineData`; Codex sends a Responses `image_generation` tool on a dedicated
image path and decodes streamed frames.
- A video generation route is mounted, and a custom provider can declare image
or video as a service kind.
- Buddy image models are served by CodeBuddy and WorkBuddy only.
- CodeBuddy image generation now uses its native image endpoint; WorkBuddy
retains its chat-carried image path. Model Lab exposes image/video generation
controls, including size and count selection where supported, and keeps media
placeholders visible while generation is in progress.
- `scripts/operations/media.ts` provides reusable CodeBuddy image/video commands, including
automatic video task polling by default and `--no-wait` for returning a task
ID.
- Buddy image generation has been verified; Buddy-family video generation has
**not** succeeded end to end. The `/v2/videos/generations` submission path is
configured, but the actual task polling endpoint remains unknown. The
current sibling poll URL is an unverified inference, not a confirmed provider
contract.

**Providers**

- Web-session providers (Claude Web, Grok Web, Kimi Web) use pasted sessions and
static catalogs. Grok accepts only `bash`, `readFile`, `webSearch`, and
`browsePage`; Kimi accepts no function tools.
- The provider list gains collapsible sections, and custom providers render in
their own section again.
- Direct egress resolves through the OS resolver, so a pool on a VPN is not
misclassified as a dead proxy.

**Web search**

- Declaring a web-search tool no longer affects chat route selection or request
shaping. The gateway resolves a configured fallback provider only after the
selected model emits a `web_search` function call, then continues the model
turn with the result. The direct `POST /v1/search` API is unchanged.
- Web-search capability is a property of the provider rather than a column on the
model row and is consulted only when resolving a tool invocation, not when
planning a chat request.
- Hosted search tools are translated per wire instead of forwarded verbatim —
Codex receives `{"type":"web_search"}`, an OpenAI wire receives
`web_search_preview`, and a bare `web_search` declaration on
`/v1/chat/completions` is recognized rather than dropped.
- The provider-detail "Test search" control reports the probe's latency, result
count, and normalized hits (or the upstream error) instead of a pass/fail line.

**Console**

- A batch account import is one round-trip instead of one per account.
- Backup export writes compressed raw connections.
- The dashboard adds a privacy mode that masks proxy and account values, and the
quota controls get their own panel.

**Durability**

- A schema change must land in both migration sets. Every file in
`migrations/full-postgres/` needs a same-named file in
`migrations/lite-sqlite3/`, and `test/persistence/sqlite-baseline.test.ts`
fails when one is missing — the parity check previously compared `0000` only, so
a forward migration could ship for PostgreSQL and never reach an existing SQLite
database.

### Changed

- `scripts/` is grouped by purpose rather than by mixed role: `cli/` (the global
commands, launchers, setup wizard, and doctor), `operations/` (start, restart,
health sweeps), `install/` (the host-level shell installer), `build/`, `generate/`,
`dev/`, `test/`, and `shared/`. `scripts/ci-run-tests.ts` is now
`scripts/test/run.ts`, `scripts/install-lite.sh` is `scripts/install/lite.sh`,
and `scripts/internal/env.ts` is `scripts/shared/env.ts`. No script changed
behavior; only its path did.
- The release build sequence moved out of a chained `package.json` string into
`scripts/build/build.ts`, which names each step and stops at the first failure
instead of relying on `&&`.
- The npm package description is now a full paragraph naming the proxy, both
protocols, and the delivery engine behind the endpoint, instead of a single
line.
- Documentation no longer embeds a copy of the Lite installer.
`documentation/installation.md` links the canonical
`scripts/install/lite.sh` and describes what it does; the inlined copy had
already drifted from the script it claimed to reproduce.
- A fresh profile's glass is retuned so cards read as glass over the page
background while the chrome framing them stays lighter. Cards ship clarity 45 /
blur 20 (an 11px backdrop blur), sidebar and topbar clarity 25 / blur 10
(7.5px) — was 70/5 and 67/67, which made the chrome the blurriest surface on
screen. Existing saved profiles keep their own values; only the default moved.
- DeepSeek now dispatches on its Anthropic Messages wire
(`https://api.deepseek.com/anthropic` + `/v1/messages`, `x-api-key`) instead of
the OpenAI chat wire. The `/v1/models` OpenAI-compatible discovery still reads
from the provider's bare host, so the two surfaces stay separate. The Anthropic
adapter takes an explicit provider id so the registry's identity check and the
provider-keyed quirks resolve against DeepSeek, not the Anthropic builtin.
- The dashboard stylesheet cutover is complete. `console.css`, `landing.css`, and
`share.css` are gone; the tree is `tokens.css` (tokens), `base.css`
(reset/elements), and `app.css` (the irreducible set plus the shell frame). One
dialect styles every surface: token → utility → primitive. The type scale is
role-named (`micro`/`badge`/`caption`/`body`/`body-lg`/`lead`/`title`/`display`/
`hero`) at a 2px spacing step, and radii, shadows, stacking, and named viewport
breakpoints are tokens rather than literals. All 464 static inline styles are
gone, and 462 arbitrary literal utilities are down to 79, both held by a
ratchet that no file may exceed (`dashboard/style-guard.json`).
- The tinted inline banner is now one block, `components/patterns/banner.tsx`,
instead of six call sites each writing its own `color-mix(in srgb, …)`. The
tint is `.banner` in `app.css`, keyed by `data-tone`, so a tone change is one
rule and a fourth tone is one selector. The alphas had already drifted per
site — 40% line / 8% wash against 45% on the setup chips — which is what a
per-site decision looks like once nothing holds it together. Callers pass
`surface="raised"` when the banner sits on a card, so the translucent wash
cannot composite against the card's own colour. The setup chips, which fill
with `surface-2` rather than washing, take a `--color-warning-line` token
instead of the block; rendering is unchanged there.
- `Model Lab` is the Studio surface: the old playground is retired from both the
console and the dashboard (`0011_drop_studio_sessions.sql`), and routed models
are chatable.
- Buddy protocol, cache, quota, and tool recovery are aligned across the
CodeBuddy, CodeBuddy CN, and WorkBuddy variants.
- Stop-reason mapping is consolidated per wire family.
- The default gateway API key is identified by a new `is_default` column
(`0004_api_keys_is_default.sql`) rather than by its label, so renaming cannot
break the Studio lookup, and a partial unique index rejects a second live
default per tenant. The migration promotes a key seeded by an earlier build.
- Docker Compose reads its bundled Redis address from `CARTETHYIA_REDIS_URL`, so a
host-oriented `REDIS_URL=redis://localhost:6379` in `.env` cannot enter the
container. PostgreSQL remains external.
- Invalid-model IP bans use a 30-minute sliding window: ten hits inside it ban the
address for 6 hours. A valid request no longer resets the count.
- Payload frames are gzipped at the write, and the storage check widens to the new
encoding; a frame written before this stays readable.
- Documentation is split into `reference/` (indexes, one page per layer) and
`features/` (narrative per feature), with the entry pages at the root.
- The agent guide names `agent-browser` as the mandatory tool for UI verification
and consolidates the gate list into one owner.

### Removed

- The pasted web-session providers `claude-web`, `grok-web`, and `kimi-web`, with
the `shared/web-session` module only they used. `mimodesktop` and `mimostudio`
are the remaining signed-in-session providers and now share the console's
"Web Session Providers" section on their own.
- The console command palette: its `⌘K` shortcut, its topbar button, and the
component behind them. The sidebar is the navigation surface.

### Fixed

**Providers**

- A rejected credential now says what the operator can actually do. `Re-login required` was rendered for every `auth_invalidated` account, which is only
true of an OAuth one; a BYOK API key has no login to return to, and the row
sent the operator after a sign-in button their provider does not have. An API
key now reads `Replace API key`.
- A declared endpoint path is no longer rewritten against the provider's base
URL. The strip existed so `https://api.openai.com/v1` plus
`/v1/chat/completions` would not join into `/v1/v1/chat/completions`, and it
hid the fact that 13 bundled providers declared exactly that doubled path. The
specs now declare the path below the version root they actually sit under, so
a wrong path reaches the operator as the wrong URL instead of being quietly
corrected into a different address.

**Providers**

- `deepseek-flash` joins the DeepSeek catalog. Like the other V4 flash rows it
takes image parts, unlike `deepseek-v4-pro` which stays text-only; all three
resolve 1M context and 384k output from the base catalog.
- OpenRouter ships its `:free` tier as a default catalog and fetches it live.
A committed list is only a snapshot — OpenRouter rotates the tier within days —
so discovery filters the provider's own listing down to the `:free` rows and
marks each one a free-tier row, the same shape the OpenCode Zen free fetch
uses. `apodex/apodex-1.1-mini:free` is the one live `:free` model left out of
the committed list, because the base catalog has no pricing row for it under
any provider and a guessed number would read as a measurement.
- The Mistral catalog drops `mistral-small-latest` and both Magistral rows.
Mistral's own model overview deprecates Magistral Medium and Small in favour
of Mistral Medium 3.5 and Mistral Small 4, so listing them advertised models
the provider is actively retiring.
- Antigravity serves `claude-opus-5-5` and `claude-sonnet-5-5` at 1M context
and 128k output, the same figures the Claude integration carries. The output
cap they actually enforce on Antigravity's own host is unverified: the 4.6
rows are pinned at 64000 because that host was observed rejecting anything
higher, and no 5.5 request has been captured, so a matching ceiling would
need its own wire-profile entry rather than a catalog row.
- Kilo Code joins the console's "Free Limited Providers" section alongside Cline.
Both resell the OpenRouter catalog, so their free allowances are metered
against one upstream.

**Web search**

- The keyless Parallel route no longer depends on one response shape. The public
MCP answers a `tools/call` with the same payload twice — once in
`result.structuredContent`, once JSON-encoded in the text block at
`result.content[0].text`. Only the first was read, so an upstream that drops it
turned every credential-free search into a 200 with zero results and no error.
The text block is now the fallback, and a non-JSON block (a rate-limit notice,
a refusal) reads as an empty result set rather than a failed request.

**Console**

- Two controls that carried only the `btn*` marker classes rendered with no
styling at all, because those names exist for tests and one container query
and nothing in the stylesheet paints them: the credential notice's external
"Sign in" link and the add-account dialog's "Import file" label. The button
atom's recipe is now exported and composed by both.
- A provider whose identity is fixed shows a real disabled dropdown. The
hand-built stand-in carried the select's marker class without the utilities
the real trigger owns, so the value and its chevron stacked as loose text.
- The routing slider is sized to sit beside the text inputs in its row rather
than tower over them (20px track, 12px thumb).
- "Paste" and "Import file" moved out of the credential textarea's row to their
own line, right-aligned. Sharing the row took ~120px from the textarea and
left the actions floating beside a six-row input.
- Backup export, restore, and delete-all focus the console password field when
the dialog opens. The field asked for React `autoFocus`, which fires once at
mount and is then overridden by the modal focus hook — the hook reads
`[data-autofocus]`, and no caller had used it, so the dialog opened focused on
the panel instead of the one field all three flows require.
- Disabled models leave their origin group and collect under their own
"Disabled models" section at the end of the list. Source and enabled state are
separate axes — a built-in row can be disabled and a fetched one can be too —
so a group the operator has mostly switched off no longer fills the top of the
list with entries that cannot be routed.
- Every provider now carries a "Fetch models" button, including one that
publishes no model-listing endpoint. The button used to be hidden for those,
which left the operator with no way to find out why their provider listed
nothing. Syncing one now names the actual reason: add an account first when
there is no credential, and a "no listing endpoint" message when a credential
exists and the catalog is the compiled one. A fetch that genuinely found
nothing is still reported as a successful zero, which is a different thing.
- Gemini serves `POST /v1/search`. It already grounded through Google Search,
but every Gemini model was registered as an ordinary chat row, so the search
route had no resolvable target and the Search tab listed nothing. The two
grounding models — `gemini-2.5-flash`, the adapter's own fallback, and
`gemini-3-flash-preview` — are registered on the websearch service kind under
their real names, at the per-model `:generateContent` path grounding posts to.
- A provider with no account is no longer skipped when the compiled catalog is
seeded. It shipped with no models at all until an account was added, and the
orphan prune in the same walk never ran for it, so a row left behind by an
older catalog survived forever. That is what left the `gemini-search` alias
in the catalog with a route pointing at a model id nobody serves; it is gone.
- The Add Custom Provider dialog's two switches move to the right edge of their
rows. They were sitting in the row body, left of the label.
- The console no longer abbreviates OpenAI as `[OI]` in any label or in-code
reference. The one remaining spelling is a literal upstream header name, which
is a wire value rather than a label.

**Packaging**

- The root manifest version was `2.2.0` while the dashboard manifest carried
`2.2`, so the version guard failed and the Console and tray header disagreed
with the published package. The root is now `2.2`.

**Gateway**

- A pasted full endpoint in a BYOK Base URL no longer breaks discovery. The model
list was derived from the whole pasted path, so
`https://api.deepseek.com/anthropic/v1/messages` discovered at
`…/anthropic/v1/messages/models` (404). The endpoint tail is now stripped and the
root is used, the connection test says what it corrected, and the dashboard form
shows the root to save. The wire derivation is unchanged — a `messages` base still
reads `x-api-key`.
- `search:invoke` is now revocable. It was implicitly re-granted on every read, so
no key could hold `routing:invoke` without search.
- A context-window overflow reported only in prose is classified as
`context_length_exceeded` (413) instead of a generic `400`, and is retryable — an
overflow is a property of the chosen route's window, so failover tries a sibling
on a larger window verbatim. Only exhausting the candidates returns the 413.
- A reseller suffix on a model id (`:free`, `@variant`) no longer hides its limits.
Stripped provider-scoped first, so OpenRouter's own row still wins.
- A mistyped Redis IP-abuse key is deleted and the request is recounted; a live ban
or limit still applies. Redis being unreachable remains a 503.
- Buddy credit exhaustion is a hard `quota_exhausted` cooldown for 12 hours, and a
buddy-family channel rejection (`400 · 11128`) parks the account for 6 hours
instead of leaving it in rotation. The existing sweep restores both.
- Inline `[[ORCA_RICH_MD:f726c9dee63380489ab8d1f404a4f110:inline-html:%3Cthink%3E]]` tags split across SSE chunks stay one reasoning span across
chat, completion, Responses, and Messages.
- A plain-HTTP `CARTETHYIA_PUBLIC_ORIGIN` keeps the console session cookie
non-Secure even when the production binary has `NODE_ENV` baked in.
- A regional model rejection now cools the account; a proxy VPN hang is recorded as
such.
- The buddy family keeps its variant's fixed leading system prompt — replacing it
with the caller's system text made every request fail as an unapproved channel.

**Console and dashboard**

- The default gateway API key renames. A later clause had dropped `label` from the
PATCH exactly when an `isDefault` key was given a different name, so the update
reached the store with an empty `set(...)`.
- The Usage page counts cached tokens, not whole requests — a request with any
cache hit had its entire input counted as cached.
- Account rows, proxy masking, the usage headline, and the quota panel are
tightened; nested cards stay clear and proxy tables stay consistent.
- Active OAuth and JWT account badges are distinguished.
- Model Lab turns stay readable after reload.
- System health is restored and the background toggle behaves.
- A late import, `tailwind-merge`, dropped a role font size when a colour utility sat
beside it — `cn("text-badge", "text-text-secondary")` silently emitted only the
colour.

**Removed**

- `scripts/commands/grok-health-sweep.ts`, an unreferenced operator tool that
probed Grok accounts one by one for the `407` exhaustion signal. Nothing ran it
and nothing imported it. The 407 probe itself is unchanged —
`src/providers/discovery/probe-phases.ts` and its coverage in
`test/providers/grok-feature-probe.test.ts` remain — so the gateway reads Grok
exhaustion exactly as before.
- The Cursor and Devin providers, with their adapters, OAuth clients, quota
collectors, discovery, catalog metadata, and dashboard icons. On the next boot
each unowned `providers` row is retired and its builtin model rows cascade away;
telemetry history is untouched.
- The Studio playground surface and its sessions table.
- Verified dead exports: `getCachedQuota`, `resetBackgroundQuotaRefreshesForTests`,
`resetSweepLogMemory`, `setPoolForTesting`, `isToleratedMissingExtension`,
`byteLength`, `groupEvents`, `installIdPath`, `DEFAULT_PROVIDER_ROTATE_COUNT`, and
the `ApiKey` type that duplicated `apiKeys.$inferSelect`.

### Migration notes

- `0004_api_keys_is_default.sql` — the default gateway API key is identified by a
column, not its label. An install keeps its existing key; a second live default
per tenant is rejected.
- `0005_payload_jsonl_storage.sql` — widens the payload-frame storage check to accept
gzipped frames. On SQLite the table is rebuilt and its rows kept.
- `0010_account_identity_enrichment.sql` — adds the account identity a batch import
now returns in one round-trip.
- `0011_drop_studio_sessions.sql` — drops the retired Studio sessions table.
- `0013_default_provider_user_agent.sql` — the route-identity column default
becomes the Claude Code CLI identity, and rows still holding the retired
frozen default are converted. A row with exactly that value cannot be
distinguished from an operator who deliberately picked Codex, so only that
one string is rewritten; any other stored identity is untouched.

Each has a same-named SQLite twin under `migrations/lite-sqlite3/`.