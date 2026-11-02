# Report 07 — protocol

Scope: `src/protocol/` scanned completely (47 `.ts` files incl. `request/`, `response/`, `upstream/`, `translation/`, `translation/dialect/`). Every exported symbol was checked against the whole repo (`src/`, `test/`, `scripts/`, `dashboard/src/`). Line numbers cite the current file contents.

---

## Findings

### DEAD-CODE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 1 | `src/protocol/canonical-model.ts` | 598 | `hasEncryptedReasoning()` is exported but never imported anywhere (src/test/scripts/dashboard). The `hasEncryptedReasoning` names in `capabilities.ts`/`codex.ts` are unrelated locals. | Delete the export (keep the private `PartSummary` field, which is what the pipeline actually reads). |
| 2 | `src/protocol/codecs.ts` | 655 | `escapeHarmonyControlTokens()` has no production importer (only `codecs.test.ts`). Its only production use is inside `escapeHarmonyControlTokensDeep` (`escapeHarmonyWalk`). | Privatize; export only `escapeHarmonyControlTokensDeep`. |
| 3 | `src/protocol/codecs.ts` | 84 | `hash32()` exported but no external importer anywhere; used only inside `codecs.ts` (`hashId`, `hashToBase36`). | Privatize (remove `export`). |
| 4 | `src/protocol/response/messages.ts` | 142 | `CLAUDE_SERVED_BY_FALLBACK_CAPABILITY` is read by production code; its only consumers are a parity test (`claude-fallbacks-chain.test.ts:94,101`). The same literal `"server_side_fallback"` lives in `claude-betas.ts:63`. | Remove the constant and its comment, or have `claude-betas.ts` import it so the literal has one owner. |
| 5 | `src/protocol/registry.ts` | 157 | `preloadCodec()` has no production caller — `boot/` never warms codecs, although the doc comments (lines 114, 128) claim "warms it during boot" (they even name a nonexistent `preloadCodecs()`). Only `wire-family-codec-coverage.test.ts` calls it. | Either call it from `boot/app.ts` (honoring the documented intent) or drop the export. |

### DUPLICATION

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 6 | `src/protocol/request/chat.ts` | 82–93 | Structured-output wire projection `{type:"json_schema", json_schema/…}` is spelled three times. | `src/protocol/request/responses.ts` 391–402 (nested under `text.format`) and `src/protocol/request/codex.ts` 544–554 (same `text.format`). Extract one shared `projectResponseFormat(format, wire)` helper into `codecs.ts`/`translation/`. |
| 7 | `src/protocol/request/chat.ts` | 450–481 | The "tools → wire" mapping block (custom-tool arm, `isWebSearchTool` → `web_search_preview`, toolSchema passthrough, `function` shape) is copy-pasted three times with small spelling differences. | `responses.ts` 264–292 and `codex.ts` 432–468 (Codex uses `web_search` instead of `web_search_preview` and a slightly different `format`/`strict` shape). Extract one `projectToolForWire(tool, wireFamily)` helper; wire the per-family deltas through options. |
| 8 | `src/protocol/request/chat.ts` | 254–257, 298–301 | Reasoning text extraction `c.summary ?? (typeof c.payload === "string" ? c.payload : "")` is re-implemented in four places, all bypassing the existing shared `reasoningTextOf` (`reasoning-text.ts:23`). | `request/messages.ts` 377, 388 and `request/gemini.ts` 154. Note the precedence differs (`reasoningTextOf` prefers payload over summary; these prefer summary). Add a `reasoningTextOf(part, { preferSummary })` option and route all four call sites through it. |
| 9 | `src/protocol/request/chat.ts` | 107–158 | The file-part projection with the same "reference-only vs inline base64 → `data:` URI" logic is duplicated across all four request encoders. | `request/responses.ts` 216–236, `request/codex.ts` 291–312, `request/gemini.ts` 110–145. One shared `projectFilePart(part, wire)` helper. |
| 10 | `src/protocol/request/responses.ts` | 42–59 | Computer-use screenshot wire projection (`resolveImageSource` → `image_url`/`file_id`/`detail`, string fallback) is duplicated. | `request/codex.ts` 190–208 builds the same screenshot object; the inverse decode exists in `response/responses.ts` 36–46 (`computerOutputToContent`). Extract shared `computerScreenshotToWire`/`computerScreenshotFromWire` helpers. |
| 11 | `src/protocol/response/chat.ts` | 486–494 | The "Malformed SSE event" `GatewayError` factory (502/`platform_unavailable`/upstream origin) is duplicated verbatim. | `response/responses.ts` 335–343 and `response/gemini.ts` 123–131 have the same shape. Extract one `malformedSseError(message?)` helper (e.g. in `sse-decoder.ts`). |
| 12 | `src/protocol/translation/tool-id.ts` | 24–29 | Tool-id sanitization exists twice with different policies: `sanitizeToolId` strips invalid characters, while `codecs.ts` `normalizeAnthropicToolCallId` (217–241) replaces them with `_` and adds dedupe suffixes. Two code paths maintain the same contract independently. | Consolidate on one canonicalizer (likely the codec one) and have `sanitizeRequestToolIds` delegate to it. |

### BLOAT

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 13 | `src/protocol/request/messages.ts` | 561–908 | `canonicalToClaudeMessagesPayload` is ~350 lines with long inline conditional-spread sections (thinking block selection 812–870, extension control handling 871–897, stop-sequence handling 794–811). | Extract `buildAnthropicThinkingSection`, `applyMessagesControlExtensions` and `applyStopSequences` locals; behavior unchanged. |
| 14 | `src/protocol/response/chat.ts` | 243–619 | `decodeChatSseStream` is ~377 lines; the "push split → yield reasoning/text deltas" block appears 6× (334–361, 500–538, 551–577) with the same event shape. | Extract `yieldSplit(seq, split)` local generator/helper and a tiny `yieldReasoning`/`yieldText` emitter. |
| 15 | `src/protocol/response/codex.ts` | 379–670 | `CodexStreamFrameProcessor.process` is a ~290-line if/else chain; the `output_item.done` branch alone is ~90 lines with repeated `#openItems.delete`/`#openItemsByOutputIndex.delete` (569–587). | Split per-frame-type handlers into private methods; collapse the `delete` block (all branches do the same two deletes). |
| 16 | `src/protocol/response/messages.ts` | 256–264 | `deltaStopDetails` extraction repeats `(json as Record<string, unknown>)` casts four times plus two nested `isRecord` ternaries. | Read `json.delta` once into a typed local, then one `isRecord` check. |

### ANTI-PATTERN

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 17 | `src/protocol/codecs.ts` | 410–418 | `toWellFormedString` uses an unsafe double cast (`value as unknown as { toWellFormed?: () => string }`) and keeps a regex fallback for runtimes without `String.prototype.toWellFormed`. Every supported runtime (Node ≥ 18) implements it, so the fallback is dead and the cast is a safety hole. | Drop the fallback branch; call `value.toWellFormed()` directly. |
| 18 | `src/protocol/request/messages.ts` | 351 | `normalizedId = idMap.get(part.call_id) as string` casts without a guard right after a `idMap?.has()` check; the `?`/`else` branches make the `Map.get` result possibly `undefined` at runtime. | Use `const mapped = idMap.get(...); if (mapped !== undefined) normalizedId = mapped;` — no cast. |
| 19 | `src/protocol/request/chat.ts` | 411 & `src/protocol/translation/dialect/…` | In-place mutation of already-pushed wire objects: `last["reasoning_content"] = reasoningContent` (chat.ts 411), `stablePartitionToolUse` mutates `blocks` in place (messages.ts 431–450), `applyCodexResponsesLiteShape` mutates the body (codex.ts 638+). All are documented, but none are typed as mutable and a future caller could alias the same array. | Prefer building new objects; where mutation is deliberate, name it (e.g. `mutateCodexResponsesLiteShape`) and keep it private to the encoder. |

### OPTIMIZATION-OPP

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 20 | `src/protocol/translation/dialect/thinking-ladder.ts` | 184–221 | `resolveThinkingForModel` re-runs the `THINKING_LADDER_RULES` regex table on every encode (called in `chat.ts` 194, `responses.ts` 71, `messages.ts` 693, and again on retries/variants). No memoization. | Add a `WeakMap`/module-level cache keyed by `modelId|wireFamily|declared?.efforts` length — the rule table is pure and deterministic. |
| 21 | `src/protocol/request/messages.ts` | 574 | `imageCount = allParts(request).filter((part) => part.kind === "image").length` allocates a full flattened part array per request; `summarizeParts` already walks the same parts once and memoizes per request. | Add an `imageCount` field to the `PartSummary` memo and read it here instead of re-flattening. |
| 22 | `src/protocol/codecs.ts` | 664–681 | `escapeHarmonyWalk` always builds fresh containers, so a request with no Harmony tokens gets a brand-new object graph (identity churn) unlike `toWellFormedWalk`, which returns the original when unchanged. | Track `changed` like `toWellFormedWalk` and return the original reference when no leaf was rewritten. |

### STALE

| # | File | Line | What | Suggested fix |
|---|------|------|------|---------------|
| 23 | `src/protocol/translation/capabilities.ts` | 256–268 | `ensureMaxTokensForThinking` throws `invalid_request` when `budget + buffer > maxAllowed`, but both production callers (`messages.ts` 681, 714) pass `Number.MAX_SAFE_INTEGER` as `maxAllowed`, so the throw is unreachable in practice. | Either pass real ceilings (OAuth vs API-key), or drop the throw and let the `Math.min` clamp — otherwise the "hard failure" path is dead code. |
| 24 | `src/protocol/translation/cache-controls.ts` | 107–119 | `anthropicCacheControl`'s `hint.kind === "breakpoint"` branch returns the identical `{ cache_control: control }` as the trailing fallback (118); the breakpoint list is never consulted. The branch is a no-op duplicate. | Remove the redundant branch; if per-block breakpoint handling is intended, wire `hint.list` into the messages builder (`request/messages.ts` currently ignores it). |
| 25 | `src/protocol/gateway-error.ts` | 98–110 | `LEGACY_ORIGIN_LABELS` stripping is a compatibility shim for messages stamped by older builds. Current shapers never stamp `"Cartethyia Error:"`/`"Upstream Error:"`/`"Network Error:"` (origin now travels in `error.origin`). | Verify no persisted/queued error message can still carry a legacy label; if none can, delete the strip and its tests. |

---

## Summary per severity

| Severity | Count |
|----------|-------|
| DEAD-CODE | 5 |
| DUPLICATION | 7 |
| BLOAT | 4 |
| ANTI-PATTERN | 3 |
| OPTIMIZATION-OPP | 3 |
| STALE | 3 |
| **Total** | **25** |

---

## OK — verified clean

- `sse-frame.ts` / `sse-decoder.ts` — compact, single shared implementation; line/event bounds and abort wiring are correct; `TEXT_ENCODER` is shared rather than duplicated.
- `upstream-parsing.ts` — small pure parsers, one authoritative priority chain; no duplication with `failure-policy.ts`.
- `image-clamp.ts` — policy-only module, well-tested, no duplicated math (`base64DecodedByteLength` is the single impl).
- `gateway-error.ts` — typed error core is tight; allowlist/redaction is centralized.
- `tool-identity.ts` — the chunk-array join cache and emission ledger are well-reasoned and shared by chat/messages/responses; no sibling copies found.
- `canonical-model.ts` — the `canContainToolResult`/`toolResultParts`/`summarizeParts` predicates are genuinely shared and used everywhere the same rule applies.
- `dsml.ts` / `think-split.ts` / `omp-tool-call-markup.ts` / `qwen.ts` — each in-band parser is purpose-built; their `#settledEnd`/`flush` patterns are structurally similar but per-dialect and already consolidated behind `createInbandScanner`.
- `registry.ts` — lazy dynamic import + single cache is correct; the only issue is the unused `preloadCodec` (finding 5).
- `messages-errors.ts` / `stream-error-frames.ts` — both delegate to the shared `failure-policy` classifiers; no duplicated classification logic.
- `stop-reason.ts` — single data table for chat/messages stop reasons; responses/gemini/codex keep their own small mappings (they have genuinely different vocabularies).
- `translation/dialect/` — the declarative resolver/rules/thinking-ladder split is clean; `model-thinking.ts` is the single clamp source and `reasoning.ts` re-exports it via a documented shim.
- `translation/quirks.ts`, `normalize.ts`, `capabilities.ts` — declarative tables, single owners; `WIRE_TOKEN_BOUNDS` is the one place max-token bounds live.
- `upstream/post-json.ts` / `send-claude-messages.ts` — small executors with proper deadline/abort cleanup; no divergence between the Claude paths.
