# Report 11 — providers integrations A (agentrouter→factory, shared)

Scope scanned completely (every `.ts` file read): `src/providers/integrations/{agentrouter,alibabacp,antigravity,buddy,claude,cline,cloudflareai,codex,commandcode,cursor,factory,shared}` — 88 files. Usage claims below were verified by grepping the whole repo (`src/`, `test/`, `scripts/`, `dashboard/src/`).

---

## DEAD-CODE (exported symbols never referenced anywhere else in the repo)

1. **`antigravityEndpointOrderIndex`** — `src/providers/integrations/antigravity/antigravity-protocol.ts:308`. Exported; the only repo reference is its own definition (the sibling endpoint-ordering functions are exercised by `test/providers/antigravity-parity.test.ts`, but this one is not). Fix: delete, or keep private if logging intends to use it.

2. **`buildExecHeartbeat`** — `src/providers/integrations/cursor/cursor-request.ts:311`. Exported; no reference anywhere. The live heartbeat is `buildHeartbeat` (line 302), used by `cursor.ts:751`. Fix: remove.

3. **`buildHostExecResult`** — `src/providers/integrations/cursor/cursor-request.ts:439`. Exported; no reference anywhere. Host-exec results are never encoded (the adapter relays them as canonical tool calls; `cursorVariantForExecArgs` only decodes). Fix: remove (also its `CursorHostExecResultVariant` type).

4. **`decodeMessageSparse`** — `src/providers/integrations/cursor/protocol/messages.ts:2287`. Exported; no reference anywhere. Fix: remove.

5. **`debugWalkTurnEnded`** — `src/providers/integrations/cursor/protocol/messages.ts:2343`. Exported; no reference anywhere (diagnostic leftover). Fix: remove.

6. **`decodeWrappedMessage`** — `src/providers/integrations/cursor/protocol/messages.ts:2368`. Exported; no reference anywhere. Fix: remove.

7. **`asyncStreamFrames`** — `src/providers/integrations/cursor/protocol/framing.ts:75`. Exported; no reference anywhere (the adapter uses the synchronous `streamFrames` via `decodeServerMessages` in `cursor-http2.ts:261`). Fix: remove.

8. **`CURSOR_WIRE_FAMILY`** — `src/providers/integrations/cursor/cursor-shared.ts:76`. Exported; sole reference is its own definition. The adapter is wired by `provider_id` lookup, not this constant. Fix: remove (and `WireFamily` import).

9. **`COMMANDCODE_CHAT_PATH` / `COMMANDCODE_RESPONSES_PATH` / `COMMANDCODE_MESSAGES_PATH`** — `src/providers/integrations/commandcode/commandcode.ts:41-43`. Exported; no reference anywhere. Dispatch maps every wire to `COMMANDCODE_GENERATE_PATH` (`commandcode.ts:670-677`). Fix: remove.

10. **`RUN_HEARTBEAT_INTERVAL_MS`** — `src/providers/integrations/cursor/cursor-http2.ts:300`. Exported; no reference anywhere. The real cadence is `CURSOR_HEARTBEAT_INTERVAL_MS` (`cursor.ts:74`). Fix: remove (stale twin).

11. **Connect framing dead exports** — `src/providers/integrations/shared/connect.ts:9,11,89,102`: `CONNECT_COMPRESSED_FLAG`, `CONNECT_END_STREAM_FLAG`, `frameConnectMessage`, `consumeConnectFrames`. Only `FrameBuffer` is imported (by `kiro.ts:45`); these four have no other reference. Fix: privatize or drop if kiro doesn't need them.

12. **`AGENTROUTER_BASE_URL`** — `src/providers/integrations/agentrouter/agentrouter.ts:21`. Exported but used only internally (line 80). Fix: drop `export`.

13. **Factory routing/upstream exports** — `src/providers/integrations/factory/factory.ts:109,126,157,182,203,269,297,316,333`: `FACTORY_DROID_UPSTREAMS`, `FactoryDroidUpstream`, `factoryApiProviderHeader`, `factoryBaseUrl`, `factoryInferenceRegion`, `factoryRegionUnavailable`, `factoryRoutingSourceHeader`, `factoryRegionCheckedApiProviderHeader`, `factoryRoutingHeaders`. None are referenced outside `factory.ts` (including tests). Fix: drop `export` from all nine; they are internal seams.

14. **`exchangeCodeForToken` re-export** — `src/providers/integrations/codex/codex-oauth.ts:275` and `src/providers/integrations/antigravity/antigravity-oauth.ts:215`. Each function is used internally, but the trailing `export { exchangeCodeForToken }` is never imported elsewhere. Fix: remove the re-exports.

15. **`buddyAccountLabel`** — `src/providers/integrations/buddy/buddy-oauth-shared.ts:123`. Exported; used only internally (line 144). Fix: drop `export`.

16. **`workosToken`** — `src/providers/integrations/cline/cline.ts:31`. Exported; used only internally (line 49). Fix: drop `export`.

17. **`makeWorkBuddyModels`** — `src/providers/integrations/buddy/workbuddy/provider.ts:155`. Exported; used only internally (line 168). Fix: drop `export`.

18. **`antigravityThinkingBudget` / `signedAntigravitySessionId`** — `src/providers/integrations/antigravity/antigravity.ts:761,772`. Exported; used only inside `buildAntigravityEnvelope` (lines 891/898). Fix: drop `export` (keep as module-private).

---

## DUPLICATION (same logic written more than once; consolidation candidates)

1. **Credential-envelope decode + error wrap** — three near-identical copies:
   - `alibabaEnvelope` — `alibabacp/alibabacp.ts:61-77`
   - `factoryEnvelope` — `factory/factory.ts:351-366`
   - `cloudflareEnvelope` — `cloudflareai/cloudflareai.ts:55-74`
   Each checks empty secret → `GatewayError("invalid_request",400,…)`, try-decode, catch → wrap with `"(request {requestId}). Wrong key, right door — check the credential 🔑"`. Fix: add one helper (e.g. in `security/credential-codec.ts` or a small `envelope-errors.ts`) taking a decoder + provider label, used by all three.

2. **No-refresh-grant OAuth result mirror** — `alibabacp-oauth.ts:111-123` and `cloudflareai-oauth.ts:91-104` are byte-for-byte the same pattern (mirror `access` into `refresh`, far-future `expiresAt`, spread account label) with identical comments. Fix: extract a shared `durableTokenResult(access, label?)` helper.

3. **CLI header set duplicated** — `codebuddy/shared.ts:50-89` (CLI branch) and `workbuddy/shared.ts:98-133` (CLI branch) build the same identity envelope: `accept`, `user-agent: CLI/<ver> CodeBuddy/<ver>`, `x-requested-with`, `x-codebuddy-request`, `x-domain`, `x-agent-purpose`, `x-ide-name/type/version`, `x-product`, `x-no-enterprise-id`, `conversation`, root/parent request-id passthrough, `buddyCliTraceHeaders`, `buddyOAuthIdentityHeaders`, `buddyCliHeaders`. Fix: move the common CLI-branch assembly into `buddy-cli-headers.ts` (or a shared `buddyCliIdentityHeaders`), parameterized by the two version strings and domain.

4. **Gemini stream → canonical event emission** — `antigravity/antigravity.ts:290-350` (non-stream body) and `:395-488` (stream), versus `factory/factory.ts:546-588` (`geminiBodyToEvents`) and `:591-639` (`geminiStreamToEvents`). The thought/text/tool-call delta emission and the terminal construction are essentially the same block. Fix: extract a shared `emitGeminiResponse(output, seq)`/`emitGeminiTerminal(cand, usage, toolCount)` helper (in `protocol/response/gemini.ts` or a providers-shared module).

5. **Hand-rolled FNV hashes ×3** — `sessionIdentityDigest` (`antigravity.ts:680`, FNV-1a 64), `hashBody` (`fallback-credit.ts:127`, FNV-1a 32), `cursorAccountTag` (`cursor-quota.ts:228`, FNV-1a 32). There is already `sha256Hex` in `shared/hash.ts`. Fix: reuse `sha256Hex` (or centralize one FNV helper in `shared/hash.ts`).

6. **`commandcode` duplicate header builders** — `headers(sessionId, token)` (`commandcode.ts:414-426`) and `commandCodeIdentityHeaders(_token)` (`commandcode.ts:646-659`) build the same `x-command-code-version`/`x-cli-environment`/`x-taste-learning`/`x-project-slug`/`user-agent` set. `headers` ignores its token argument in favor of `authorization`, `commandCodeIdentityHeaders` ignores its token entirely and mints a fresh random `x-session-id` per call (contradicting its own "per-request as the CLI sends it" comment). Fix: delete `commandCodeIdentityHeaders` and give `headers` a `sessionId: string` produced once per dispatch by the caller (or pass `undefined` to omit).

7. **`(context.outbound_fetch as unknown as typeof fetch)` cast repeated** — at least 10 occurrences: `antigravity.ts:237,548`, `factory.ts:492`, `cursor.ts:820,858`, `gemini.ts:214`, `perplexity.ts:79`, `kiro.ts:394`, `qoder.ts:1709`, `trae.ts:197`. Fix: add a typed helper on `ProviderDispatchContext` (e.g. `resolveOutboundFetch(context, fallback)`), so the double-cast lives in one place.

---

## BLOAT (over-long functions, redundant branches, copy-paste blocks)

1. **`clinePrePayload` unreachable defensive check** — `src/providers/integrations/cline/cline.ts:144-154`. Inside `if (needsMaterialize)` (which requires `model.includes("deepseek-v4-flash")`), the `if (!model) throw …` branch is unreachable — `model` is already a non-empty string at that point. Fix: remove the dead branch (and the "keep GatewayError reachable" comment).

2. **`turing-device-token.ts` no-op `requested` handling** — `src/providers/integrations/buddy/turing-device-token.ts:215-222`. The `void activeOrMine;` else-branch is a no-op; the whole `activeOrMine` binding is dead. The warning case is the only thing that matters. Fix: simplify to just compare and warn.

3. **`transformNdjson` catch-rethrow** — `src/providers/integrations/commandcode/commandcode.ts:582-587`: `try { evs = transformLine(...) } catch (e) { throw e; }` is a pointless rethrow. Fix: remove the inner try/catch.

4. **`AntigravityAdapter.dispatch` monolith** — `src/providers/integrations/antigravity/antigravity.ts:182-496` (~315 lines combining credential checks, URL resolution, session-state bookkeeping, project lookup, envelope build, failover, empty-stream recovery, plus both non-stream and stream response emission). The two emission halves duplicate factory's Gemini helpers (see DUPLICATION #4). Fix: extract the non-stream body→events and stream→events loops into private methods.

---

## ANTI-PATTERN (typing holes, error swallowing, unsafe patterns)

1. **Unbounded `rosterCache`** — `src/providers/integrations/cursor/cursor.ts:85`. `const rosterCache = new Map<string, {roster, fetchedAt}>()` has a TTL check on read but **no eviction and no size cap**; every distinct credential adds an entry forever, so account fan-out pins memory. Fix: bound it like the other caches (e.g. cap at 1024 entries, oldest-first eviction, matching `install-id.ts` / `antigravity-protocol.ts`).

2. **Repeated double-cast `as unknown as typeof fetch`** — see DUPLICATION #7. Beyond duplication, the pattern is a typing hole (casts `ValidatedOutboundFetch` through `unknown`). Fix: a single typed accessor so the cast is contained and reviewable.

3. **`Promise.withResolvers` cast** — `src/providers/integrations/commandcode/commandcode.ts:562` and `cursor/cursor.ts:563` both do `Promise.withResolvers<…>() as unknown as {…}`. If the runtime is guaranteed modern, the cast is unnecessary; otherwise it hides a shape mismatch. Fix: type the helper once (e.g. in `shared/`), or drop the cast if TS lib supports it.

---

## OPTIMIZATION-OPP (re-computation per call, avoidable allocation)

1. **Antigravity `websearch` re-dispatches a full canonical request** — `src/providers/integrations/antigravity/antigravity.ts:498-529` builds a `CanonicalRequest` and runs the whole `dispatch` pipeline (project lookup, session store, payload build, SSE parse) just to extract the `grounding:` terminal reason. Fix: call the low-level `buildAntigravityEnvelope` + send directly, or memoize the project id per token (already cached) to cut per-search overhead.

2. **`buddyGenerateVideo` creates a deadline lifecycle per poll iteration** — `src/providers/integrations/buddy/buddy-media.ts:366` calls `createUpstreamDeadlineLifecycle(context)` inside the `for(;;)` poll loop, plus `mediaIdentityHeaders` (async, builds conversation headers) per poll. Each poll re-allocates lifecycle + header objects up to 60 times. Fix: hoist lifecycle creation out of the loop; reuse one headers object per request.

3. **`TextDecoder` allocated per credential use** — ~10 sites (`antigravity.ts:198,540`, `codex.ts:368,697,818,989`, `buddy-identity.ts:54,103,173`, `buddy-chat-shared.ts:226`). Each dispatch allocates a fresh `TextDecoder`. Fix: hoist a module-level `const decoder = new TextDecoder()` (as `claude-cch.ts` already does for `TextEncoder`) or add a `decodeSecret(secret)` helper in `provider-contracts`.

4. **`collectImages` sequential fetches** — `src/providers/integrations/cursor/cursor.ts:232-244` awaits each URL image sequentially. Fix: `Promise.all` over the image parts (bounded by the image count).

---

## STALE (obsolete rows, leftover scaffolding, unused wire variants)

1. **Command Code wire-path constants** — `COMMANDCODE_CHAT_PATH/RESPONSES_PATH/MESSAGES_PATH` (`commandcode.ts:41-43`) describe a three-wire layout that dispatch no longer uses (everything goes to `/alpha/generate`). See DEAD-CODE #9. These are stale leftovers of the pre-`GENERATE_PATH` layout.

2. **`commandcode` `headers()` export** — kept alive only by `test/providers/commandcode-envelope.test.ts:22`; production uses `commandCodeIdentityHeaders`. One of the two is vestigial (see DUPLICATION #6) and the tests should be pointed at the surviving builder.

3. **AgentRouter beta literal vs canonical beta vocabulary** — `agentrouter.ts:32` hard-codes `"claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24"` while `claude-betas.ts:40-65` owns the authoritative beta names. These don't drift today, but the literal should reference `ANTHROPIC_BETA_CAPABILITIES` keys to avoid future divergence.

---

## OK — parts verified clean

- **`shared/install-id.ts`** — locations/writability fallback, bounded in-memory maps, first-writer-wins; clean.
- **`shared/claude-messages.ts`** — shared builder + `filterClaudeCustomHeaders` are referenced by anthropic/inferhub/factory/cloudflareai/agentrouter/claude; no dead exports found besides the `ensureAnthropicBeta` internal use.
- **`alibabacp`** — models catalog uses a row-tuple + mapper; `alibabaSpec`/`alibabaEnvelope` are coherent; region map is live.
- **`antigravity`** — protocol module is well-factored; project-id cache, endpoint stickiness, and session store are bounded; `collapseAntigravityVariant` is used by both quota and discovery.
- **`claude/`** — `claude-betas.ts` negotiation, `claude-credentials.ts` header build, `claude-cch.ts` attestation, `claude-slow-lane*.ts` registry are internally consistent; `claude-quota.ts` uses bounded TTL caches.
- **`cursor`** — session manager (`cursor-session-manager.ts`) is properly bounded (idle TTL, single lease release); `cursor-request.ts` builders are all exercised by the adapter except the two dead ones flagged; `cursor-catalog.ts` discovery is coherent.
- **`codex`** — session-state map is bounded (2000/TTL); identity headers and error mapping are shared and used; the 429 wait planner is pure and tested.
- **`cline`** — quota/identity headers are consistent; the seed rosters are used by discovery and the registry.
- **Buddy shared modules** — `buddy-oauth-shared.ts`, `buddy-discovery-shared.ts`, `buddy-quota-shared.ts`, `buddy-usage-shared/store.ts`, `buddy-catalog-shared.ts` are genuinely shared across cb/cbcn/workbuddy/workbuddycn and referenced; no dead exports there beyond `buddyAccountLabel`.
- **`commandcode`** — `discovery.ts` and `quota.ts` are used by `default-registry.ts`; the static catalog is superseded-by-discovery as documented.

---

## Summary counts

| Severity | Count |
| --- | --- |
| DEAD-CODE | 18 |
| DUPLICATION | 7 |
| BLOAT | 4 |
| ANTI-PATTERN | 3 |
| OPTIMIZATION-OPP | 4 |
| STALE | 3 |
| **Total** | **39** |

---

## Execution status

- **Area execution:** 31 file(s) changed in this scope during the cleanup pass; `bunx tsc --noEmit` clean and full backend suite green (4217 pass / 0 fail, protocol 591 pass / 0 fail).
- **Confirmed done (✅):** Buddy identity-header consolidation landed; envelope-decode helper candidates extracted; cline/commandcode/factory dead branches and exports partially handled.
- **Not done / skipped (⛔):**
  - #1 antigravityEndpointOrderIndex still exported ⛔
  - #4 decodeMessageSparse still exported ⛔
  - #5 hand-rolled FNV hashes — not verified
  - #8 rosterCache bound — not verified
- **Note:** this status reflects the orchestrator's verification of representative findings, not an item-by-item re-audit of every finding in this report.
