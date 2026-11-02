# Report 09 — transport/routing + surface

Scope: src/transport/routing/ (9 files) and src/transport/surface/ (20 files), read completely. Dead-code references checked against all of src/, test/, scripts/, dashboard/src/.

---

## Findings

### DEAD-CODE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | src/transport/routing/route-model.ts | 400 | export function capabilityUnsupportedError(...) — grep across the whole repo finds only the definition; no caller. | Remove, or privatize (non-exported) if it is meant as future API. |
| 2 | src/transport/routing/route-model.ts | 244 | export const ROUTING_STRATEGIES = providerRoutingStrategy.enumValues — never imported anywhere. Console duplicates the same line locally (src/console/providers/detail/routes.ts:15). | Remove the export (keep the local console copy or centralize once). |
| 3 | src/transport/routing/route-model.ts | 6 | export type { CallerIdentity }; re-export — the import at line 4 is unused inside the file, and all consumers import CallerIdentity directly from src/security/access-control. | Delete the import and re-export. |
| 4 | src/transport/routing/route-model.ts | 223 | export type RoutingRank — referenced only inside this same file (RoutingDecision). | Privatize (remove export). |
| 5 | src/transport/routing/route-model.ts | 11 | export type CapabilityProfile — referenced only inside this file (RouteCandidate). | Privatize. |
| 6 | src/transport/routing/route-model.ts | 274 | export type EligibilityReason — referenced only inside this file (EligibilityDecision). | Privatize. |
| 7 | src/transport/surface/messages/encode.ts | 36 | export function parseArgs — used only within this same file (lines 91, 171). | Privatize. |
| 8 | src/transport/surface/chat/encode.ts | 144 | export function finishReason — used only within this same file (lines 231, 484). | Privatize. |

### DUPLICATION

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | chat/parse.ts 64-76, responses/parse.ts 69-86, completion.ts 28-30, messages/parse.ts 366-381 | — | Four near-identical decode-body / unwrap-SurfaceInput helpers: decodeBody+requestBody, parseJsonBody+unwrapBody, bodyOf, asSurfaceBody — all share the Uint8Array→TextDecoder→JSON.parse / string→JSON.parse / pass-through shape and the {body,headers,path} detection. | Extract one unwrapRequestInput(input): unknown helper in surface/adapters.ts (or content-parts.ts) and route all four surfaces through it. |
| 2 | chat/parse.ts 122-157, responses/parse.ts 156-201 | — | File/document block parsing duplicated: file/input_file/document branches both call normalizeInlineFile then rebuild {kind: file/document, data, media_type, filename, file_id, url, source_type} with the same fallback/conditional spreads. | Extract a shared parseFileBlock(value, kind) in content-parts.ts, like normalizeInlineFile. |
| 3 | src/transport/surface/completion.ts | 38-45 vs 118-125 | The stop-reason table is written twice in the same file (module fn stopReason for encodeOutput; private method stopReason() for the stream encoder), and it re-implements the chat mapping already centralized in src/protocol/stop-reason.ts (chatFinishReason). | Delete both copies; call chatFinishReason(terminal.stop_reason) (with completion stop default). |
| 4 | src/transport/surface/messages/encode.ts | 243-245 | export function mapStopReason(reason) { return messagesStopReason(reason); } — a pure pass-through wrapper over src/protocol/stop-reason.ts. | Delete the wrapper; call messagesStopReason directly. |
| 5 | completion.ts 51-58, messages/encode.ts 254-274, chat/encode.ts 226-234 | — | The find-last-terminal-then-last-usage-prefer-terminal-usage triple-scan pattern is reimplemented in three surfaces (usage() / stopData / the tail of jsonCompletion). | Extract one terminalAndUsage(events) helper (e.g. in surface/ or protocol/) returning { terminal, usage }. |
| 6 | src/transport/surface/responses/encode.ts | 486-491 | The reasoning-summary separator rule ( \n\n when first chunk of a multi-part summary and not whitespace-prefixed) is hand-rolled here, duplicating part of reasoningSummarySeparator (surface/reasoning-summary.ts). | Reuse reasoningSummarySeparator (or extract the shared open-boundary rule). |
| 7 | src/transport/routing/route-catalog.ts | 723-754, 764-784, 794-820, 838-877 | Four copy-paste candidate-object builders (pool-account tenant candidate, pool-tenant candidate, credential-less candidate, account candidate) with identical spread patterns: wire_family, dialect, service_kind, endpoint, output_limit, capability_profile, free_tier, pool fields, providerLimitFor. | Extract a buildCandidate(model, {tenantId, account?, pools?, health?}) helper; the four blocks collapse to one call with options. |

### BLOAT

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | src/transport/routing/router.ts | 794-813 | The comment block Continuation affinity is applied first and absolutely. appears twice verbatim (794-803 and 804-813). | Delete the duplicate block. |
| 2 | src/transport/surface/messages/stream.ts | 423-469 vs 375-421 | finish() copy-pastes the whole terminal finalize sequence from push() terminal branch: closeOpenBlock → flushToolCalls(true) → closeOpenBlock → downgrade check → clears → message_delta → message_stop. | Extract a private finalizeTurn(): MessagesStreamEvent[]; call from both paths. |
| 3 | src/transport/routing/route-catalog.ts | 730, 771, 801, 845 | The same ...(model.outputLimit == null ? {} : { output_limit: model.outputLimit }) (and free_tier, dialect equivalents) appear four times. | Collapse via the shared candidate builder (DUPLICATION #7). |

### ANTI-PATTERN

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | src/transport/dispatch/stream-bridge.ts | 32-33, 43, 51 | options as never passed into ChatStreamEncoder/CompletionStreamEncoder/ResponsesEventEncoder/MessagesStreamEncoder constructors — a non-strict typing hole: createDispatchStreamEncoder takes Record<string, unknown> and the encoders take distinct typed option objects. | Give the encoders a common minimal option base type (or validate/narrow in the bridge) instead of as never. |
| 2 | src/transport/surface/responses/parse.ts | 275 | return action as unknown as ResponsesComputerAction — double cast after validation, bypassing the declared type. | Type map result as ResponsesComputerAction via the COMPUTER_ACTION_TYPES guard (a type predicate) rather than unknown→cast. |
| 3 | src/transport/routing/router.ts | 102, 133, 492, 496 | Multiple redundant casts of fields already declared optional: state.quota_windows as readonly ProviderQuotaWindow[] | undefined (line 102, field is already readonly unknown[] | undefined), candidate.quota_windows as ... (line 133), and routing as Record<string, Record<string, ProviderRoutingSetting>> twice in resolveProviderRouting (lines 492/496) despite providerRouting being typed ProviderRoutingMap. | Remove the casts; fix the typing so belowUsageFloor/creditPriority accept the declared types. |
| 4 | src/transport/routing/router.ts | 342-353 | EligibilityEvaluator.evaluate structurally casts candidate as RouteCandidate & { health_status?, cooldown_kind?, ... } — a wide undocumented extension of the candidate type. | Move these stamped fields onto a proper type (or a RouteCandidateWithHealth-style type shared with route-catalog.ts) instead of an inline anonymous cast. |

### OPTIMIZATION-OPP

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | src/transport/routing/router.ts | 837-846 | Promise.all(matching.map(async (candidate) => this.applyUsageFloorToCandidate(...))) performs one getCachedQuotaEntry (Redis read / DB fallback) per candidate — the same account is fetched repeatedly when a combo fans out to several models on one account. | Dedupe by account id before fetching (same pattern admission readAccountInflight already uses), then reuse the result across candidates. |
| 2 | src/transport/routing/router.ts | 334 | until <= Date.now() is evaluated inside the earliestResetMs loop — Date.now() recomputed per decision. | Hoist const now = Date.now() above the loop. |
| 3 | src/transport/routing/route-catalog.ts | 575-667 | Per candidate, the provider routing bucket is re-read by resolveSkipProxy, resolveUserAgent, resolveMaxInflight, resolveMaxInflightPerProxy, providerLimitFor — several separate lookups into providerRouting[tenantKey]. | Resolve the (tenant, provider) setting row once per candidate and pass it to the helpers. |

### STALE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | src/transport/routing/route-model.ts | 141-154 | An orphaned JSDoc block describing Providers whose routing defaults to skipProxy: true and a single owner manifest defaultSkipProxy flags in providers/metadata.ts — it has no code attached (it dangles above ProviderRoutingMap) and describes a mechanism that no longer matches the implementation (routing defaults come from DEFAULT_PROXY_SKIP_PROVIDER_IDS + settings rows). | Delete the orphan comment block. |
| 2 | src/transport/surface/responses/contracts.ts | 50 | Trailing orphan comment /** Stable typed failure for encrypted-reasoning policy violations. */ with nothing after it (the class it was meant to introduce is gone). | Delete. |
| 3 | src/transport/surface/messages/stream.ts | 207-212 | Two consecutive near-identical comments about empty text deltas (Empty deltas carry no visible content… at 207-209 and again at 210-212). | Keep one, delete the duplicate. |

---

## Verified OK

- routing/candidate-index.ts — snapshot-cached index (WeakMap), single-pass build, no per-request rescans; clean.
- routing/bounded-lru.ts — single shared LRU implementation; correct bounds; used by both route-catalog and round-robin.
- routing/round-robin.ts — clean; bounded map reused; next mutation is intentional state.
- routing/reservations.ts — expiry min-heap with bounded sweep and compaction; no leaks/errors swallowed.
- routing/plan-gate.ts — narrow, well-documented free-plan gate; no dead paths.
- routing/admission.ts — in-memory and Redis controllers share admissionDirective/capacityRejected; Redis chunked MGET avoids KEYS; good.
- surface/adapters.ts — surface detection reads all signals once, fixed precedence, documented disagreement reporting.
- surface/reasoning-summary.ts — shared separator/identity/boundary logic; correctly reused by chat and messages encoders.
- surface/content-parts.ts — textPart/normalizeInlineFile correctly shared by chat and responses parsers.
- surface/dialects.ts — tool/choice/reasoning/format parsers are the single shared source across all three surfaces.
- surface/responses/errors.ts and surface/messages/errors.ts — typed errors, no swallowed failures.
- surface/responses/wire-output.ts — clean projection; only producer is encode.ts.
- surface/messages/parse.ts — ledger (applyMessagesToolLedger) is the single owner of tool-round reconstruction; well documented.
- surface/chat/parse.ts — parseMessage/parseGenerationControls clean; no lost parsing.
- surface/chat/encode.ts — ChatStreamEncoder holds O(1) streaming state; jsonCompletion joins once; reasoning-summary reuse is correct.
- surface/messages/encode.ts — groupedBlocks joins fragments once (O(N)); blockFromPart handles round-trip keys.
- surface/responses/encode.ts — ResponsesEventEncoder has single response id/created pair (bug fixed per comment); closeAll/finalizeState are coherent.
- routing/router.ts — index-cached candidate lookup, single pass of evaluations, single rank sort; quota-floor and saturation are merged into one decision map; resolveMatchingCandidates correctly dedupes and preserves flatten-then-dedupe contract.

## Summary counts

| Severity | Count |
|----------|-------|
| DEAD-CODE | 8 |
| DUPLICATION | 7 |
| BLOAT | 3 |
| ANTI-PATTERN | 4 |
| OPTIMIZATION-OPP | 3 |
| STALE | 3 |
| **Total** | **28** |
