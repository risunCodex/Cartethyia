# 02 — Protocol Area Deep Audit (src/protocol/**)

## Scope

Read-only audit of `src/protocol/**`: the canonical model, request/response
codecs (chat, messages, responses, codex, gemini), SSE framing/decoding,
error classification, tool-call identity/repair, reasoning/thinking layers,
translation dialects, and upstream helpers. Goal: concrete, worthwhile
bloat/duplication/maintenance reductions that preserve behavior, prioritizing
memory/state integrity and valid fallback behavior over cleanup.

Method: CodeGraph symbol/call-path mapping first, then direct reads of every
file under `src/protocol/` (44 TS files, ~13k lines) plus the transport-surface
adapter boundary to verify cross-layer contracts. No files were edited.

## Current-flow evidence

- Canonical path: surface adapters (`src/transport/surface/*/adapter.ts`) parse
  wire bodies into `CanonicalRequest` (`src/protocol/canonical-model.ts`), the
  dispatch path applies translation/repair (`src/protocol/translation/**`,
  `src/protocol/translation/tool-repair.ts`, `src/protocol/translation/tool-id.ts`),
  then wire codecs in `src/protocol/request/**` encode, and
  `src/protocol/response/**` decode upstream JSON/SSE into
  `CanonicalEvent[]`. `src/protocol/registry.ts` loads the per-family codec
  modules. SSE line decoding is already consolidated in the single shared
  `sse-decoder.ts`; terminal-event assembly is already consolidated in
  `canonicalTerminal` (`codecs.ts`); tool-call *tracking* is consolidated in
  `tool-identity.ts` (`createToolCallTracker`, `createToolEmitLedger`); cache
  breakpoint marking is consolidated in `markLatestBreakpoint`
  (`translation/cache-controls.ts`); content-part → wire projection reuses
  `resolveImageSource`/`splitDataUrl` (`codecs.ts`).
- The remaining duplication is therefore concentrated in three places that this
  audit confirms as real: (1) the reasoning-effort vocabulary, (2) the
  reasoning-text reader used when replaying prior turns to upstreams, and
  (3) the streaming in-band tool-markup parser scaffold.

## Findings

### F1 — Reasoning-effort vocabulary exists in three copies; the completion surface copy has already drifted

**Verdict: confirmed structural duplication with one live drift. Severity: MED. Effort: S. Behavior change: YES (restores a valid effort on the completion surface).**

Evidence:

- `src/protocol/canonical-model.ts:55` — canonical vocabulary:
  `REASONING_EFFORTS = ["none", "instant", "minimal", "low", "medium", "high", "xhigh", "max"]`.
- `src/protocol/translation/thinking.ts:16` — ladder copy (no `"none"`):
  `REASONING_EFFORT_LADDER`.
- `src/transport/surface/completion.ts:208-215` — a third, hand-rolled copy:
  `new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])`.
  **This copy is missing `"instant"`** (present in the canonical tuple), so a
  completion request carrying `reasoning_effort: "instant"` silently drops the
  reasoning intent (the check fails, `reasoning` becomes `undefined`, and the
  caller's effort never reaches any upstream), while the chat and messages
  surfaces accept it via `parseReasoningIntent` (`src/transport/surface/dialects.ts:226-255`,
  membership via `CANONICAL_REASONING_EFFORTS` derived from the canonical tuple at
  `dialects.ts:166`).
- `src/protocol/codecs.ts:582-591` (`CODEX_WIRE_EFFORT_VALUES`) is a genuinely
  distinct wire mapping (Codex tier strings with a `"medium"` fallback) and is
  out of scope for consolidation.

Mechanism: `completion.ts` reimplements the parsing that `parseReasoningIntent`
already provides (including the `reasoning_effort` / `reasoning_level` alias)
instead of calling it, using a locally frozen literal list. The other surfaces
already route through the shared parser, so the completion surface is the only
one with its own vocabulary copy.

Proposal: replace the inline set + parse block in `completion.ts` with the
shared `parseReasoningIntent(body)` (plus the completion-specific extension
fields that follow), or at minimum import the canonical
`REASONING_EFFORTS`/`CANONICAL_REASONING_EFFORTS` for membership. Owner:
`src/transport/surface/completion.ts`. Bounded change: one function body.

State/fallback integrity: no shared mutable state; canonical request is built
once per request. Behavior change is strictly additive (a previously dropped
valid effort now flows); invalid efforts still yield `undefined` exactly as
today. Memory risk: none.

Fallback risk: none — the shared parser is already the hot path for chat and
messages and is covered by surface tests.

Verification: add/update a completion-surface test asserting
`reasoning_effort: "instant"` (and every canonical value) is preserved into
`CanonicalRequest.reasoning.effort`, and that the alias `reasoning_level`
still parses identically to the chat surface. Run `test/transport/` surface
tests plus `test/protocol/codecs.test.ts`.

### F2 — Reasoning-text replay reader is inlined five times with the opposite precedence of the canonical reader

**Verdict: confirmed duplication of one contract, with two competing precedences. Severity: MED. Effort: S. Behavior change: NO (consolidate under the existing replay precedence).**

Evidence:

- Canonical reader `reasoningTextOf` (`src/protocol/reasoning-text.ts:23-30`)
  deliberately prefers `payload` → `summary` and is used by the transport
  encoders (`transport/surface/messages/encode.ts:115`,
  `transport/surface/messages/stream.ts:235`, `transport/surface/chat/encode.ts:117`,
  `transport/dispatch/streaming/encoder.ts:282`).
- The request builders each inline `summary ?? payload` — the opposite
  precedence — in five places:
  - `src/protocol/request/chat.ts:256` and `:300` (twice in one function, plus
    `hasReasoning` computed twice at `:263`/`:304`);
  - `src/protocol/request/messages.ts:377` and `:388`;
  - `src/protocol/request/gemini.ts:159`;
  - `src/providers/integrations/qoder/qoder-chat.ts:162`.
- These inline readers are not interchangeable with `reasoningTextOf`: on a
  part that populates both fields they select different text, and the request
  side may deliberately want the full digest (`summary`) when replaying to an
  upstream. Unifying them onto `reasoningTextOf` would change upstream-visible
  bytes for such parts, which is why the proposal preserves the replay
  precedence rather than flipping it.

Mechanism: five copies of
`.map((c) => c.summary ?? (typeof c.payload === "string" ? c.payload : ""))`
with minor variance (`stringValue` vs `typeof`; `?? payload` vs `?? ""`), all
computing "the visible reasoning text to send back to the provider".

Proposal: add one exported helper beside `reasoningTextOf` — e.g.
`reasoningTextForReplay(part)` with explicit summary-first precedence — and
replace the five inline readers with it; also collapse the duplicate
`hasReasoning` computations in `request/chat.ts` into one pass. Owner:
`src/protocol/reasoning-text.ts`. Bounded change: one new function + five call
sites.

State/fallback integrity: pure functions on immutable parts; no state.
Consolidation is byte-for-byte identical when the helper reproduces the exact
summary-first expression (including the `""` vs `undefined` fallback per call
site — verify each site's fallback when adopting the helper).

Fallback risk: none if the helper preserves each site's exact current
expression; the risk is only in *unifying precedence*, which this proposal
explicitly does not do.

Verification: golden tests over the existing decoder/builder fixtures (chat,
messages, gemini, qoder) asserting byte-identical outbound bodies before/after;
`test/protocol/` suites plus `test/transport/surface/` and the qoder adapter
tests.

### F3 — Streaming in-band tool-markup parser scaffold is triplicated (DSML / OMP / Qwen)

**Verdict: confirmed structural duplication of the streaming scaffold; grammar contracts differ and must stay separate. Severity: MED. Effort: M. Behavior change: NO.**

Evidence:

- `src/protocol/dsml.ts:78-174` (`DsmlStreamParser`),
  `src/protocol/response/omp-tool-call-markup.ts:33-135`
  (`OmpToolCallMarkupParser`), and
  `src/protocol/translation/dialect/qwen.ts:19-87` (`QwenToolCallScanner`)
  each implement the same ~90-line scaffold: append chunk to a pending buffer,
  scan for the earliest opener, settle visible text up to a safe end
  (`#settledEnd` holding back a possible trailing opener fragment), parse a
  complete block when its closer appears, fail open past a block-size cap, and
  `flush()` the tail.
- The grammars are genuinely different (DSML XML-style strict blocks with
  allowlist rejection; OMP `<tool_calls:8hex>` envelopes with hex markers; Qwen
  `<tool_call>` JSON blocks), and subtle semantics differ: OMP *discards* an
  unterminated envelope at flush, DSML *passes it through* as text, and Qwen
  holds an opener fragment. These must be preserved as parameters of a shared
  scaffold, not silently unified.

Mechanism: three copies of the same stateful prefix-buffer loop; each has
already accumulated its own edge-case exceptions, so future fixes are made
three times (e.g. the Qwen `isPossibleOpener` refinement vs OMP
`#couldBeOpening` vs DSML `#settledEnd`).

Proposal: extract a generic `MarkupStreamParser<T>` scaffold
(openers/closers, block-size cap, fail-open policy, flush policy, call-id
factory) in `src/protocol/`, and convert the three grammars into thin
configuration + parse-block functions. Keep each grammar's flush/fail-open
semantics as explicit options. Bounded change: one new module, three reworked
classes, no changes to callers (`createInbandScanner` in
`translation/dialect/inband.ts` and the chat decoder keep the same surfaces).

State/fallback integrity: all three parsers are per-stream instances with no
shared state; the scaffold must keep each instance's buffer private. The
fail-open cap (`MAX_THINK_BLOCK_BYTES`, `DEFAULT_MAX_BLOCK_BYTES`, OMP's
unterminated-discard) is the state-integrity boundary — preserve the exact cap
and behavior per grammar.

Fallback risk: medium during the refactor, because these parsers are subtle
and stream-stateful; mitigated by existing direct tests (`test/protocol/dsml.test.ts`,
`test/protocol/translation/dialect-inband.test.ts`) plus the chat-decoder
stream fixtures, which must stay green unchanged.

Verification: run `test/protocol/dsml.test.ts`, `dialect-inband.test.ts`,
`chat-decoder.test.ts`, `responses-decoder.test.ts`; add a small chunk-split
property test feeding every boundary fragment (split across opener, marker tail,
closer) to the shared scaffold to prove identical output to the three current
implementations.

## State / fallback analysis

- All three proposals touch pure, per-request or per-stream code; none holds
  process-global mutable state beyond existing bounded caches
  (`THINKING_RESOLVE_CACHE`, `DIALECT_RESOLVE_CACHE` — already bounded LRUs,
  untouched). No memory- or state-integrity change is proposed.
- Fallback behavior is preserved by design: F1 only widens acceptance on one
  surface; F2 keeps the exact per-site text selection; F3 parameterizes the
  per-grammar fail-open/flush policies rather than unifying them.
- Nothing in this report loosens a guard, widens a type, or suppresses an
  error. Excluded suspects below are excluded precisely because unifying them
  would change error semantics or fallback behavior.

## Validation

Existing coverage used as the baseline (all must stay green, unchanged):
`test/protocol/` — `codecs.test.ts`, `sse-decoder.test.ts`, `chat-decoder.test.ts`,
`responses-decoder.test.ts`, `dsml.test.ts`, `tool-call-id-clamp.test.ts`,
`tool-identity.test.ts`, `stream-errors.test.ts`, `wire-family-codec-coverage.test.ts`,
`wire-token-bounds.test.ts`, `reasoning-leak.test.ts`, `rewrite-depth.test.ts`,
`attachment-integrity.test.ts`, `cache-controls.test.ts`, `gemini-usage.test.ts`,
`image-clamp.test.ts`, `clamped-effort-output-floor.test.ts`,
`ensure-max-tokens-thinking.test.ts`, `messages-thinking-display.test.ts`,
`responses-reasoning-text-boundary.test.ts`, `tool-dialect-shapes.test.ts`;
`test/protocol/translation/` — `dialect.test.ts`, `dialect-inband.test.ts`,
`thinking-ladder.test.ts`; plus `test/transport/surface/` and the qoder adapter
tests for F2.

Proof per finding: F1 — new completion-surface effort-parse test + existing
surface tests. F2 — byte-identical golden fixtures for the five request
builders. F3 — existing parser tests plus a chunk-split equivalence property
test.

## Excluded / unverified suspects

- **Tool-call ID normalization** — three implementations with different
  contracts and safety boundaries:
  `normalizeAnthropicToolCallId` (`src/protocol/codecs.ts:211`, rewrite +
  seen-map dedupe for the Anthropic 64-char contract),
  `clampToolCallId` (`codecs.ts:176`, prefix+hash clamp for Responses), and
  `sanitizeToolId`/`generateToolCallId` (`src/protocol/translation/tool-id.ts:24/36`,
  char-strip + deterministic generation for pre-dispatch tenant preferences).
  They run on different paths and in different orders (preparer sanitize runs
  before the Messages builder's normalize); merging would change IDs visible to
  upstreams and risk call/result pairing. Excluded.
- **Upstream error-envelope classifiers** — `gatewayErrorFromStreamError`
  (`src/protocol/stream-error-frames.ts:49`, shared by chat/responses/codex),
  `mapClaudeStreamError` (`src/protocol/messages-errors.ts:78`), and the inline
  classifier in `decodeGeminiStreamEvent` (`src/protocol/response/gemini.ts:138-171`)
  look similar but differ in detail keys (`providerStatus` vs `status`), raw
  capture, message extraction (`extractUpstreamMessageText` vs
  `extractUpstreamMessage`), and `upstreamMessageAsIs` handling. Unifying
  would change public error envelopes; excluded.
- **JSON parse-with-fallback helpers** — `parseArguments` (`codecs.ts:492`),
  `tryParseJsonObject` (`codecs.ts:679`), gemini's local `parseJsonObject`
  (`request/gemini.ts:256`), and kiro's `parsePayload`
  (`src/providers/integrations/kiro/kiro-stream.ts:270`) return different
  fallbacks (`{}`, `undefined`, `{content}`, `undefined`) by design; exclusion.
- **Tool-round repair policies** — `repairMissingToolResponses`/`dropOrphanToolResults`/
  `dropIncompleteToolRounds` (`src/protocol/translation/tool-repair.ts`),
  `repairOrphanedCodexToolExchanges` (`src/protocol/request/codex.ts:54`), and
  `applyMessagesToolLedger` (`src/transport/surface/messages/parse.ts:513`)
  implement deliberately different policies for different wires (synthesize vs
  fold-to-note vs strict ledger, different strictness). Excluded.
- **Already consolidated (no finding)** — SSE line decoding
  (`sse-decoder.ts`), `canonicalTerminal`, `markLatestBreakpoint`, tool-call
  tracking/ledger (`tool-identity.ts`), usage mapping/merging
  (`provider-usage.ts`, `mergeResponsesUsage`), `getResponseId`/`getModel`
  (chat vs completion are separate wire shapes with separate encoders; the
  `modelFor`/`usage()` duplication in `completion.ts` is small and surface-bound
  — not worth a shared helper).
- **Unverified** — the `request/chat.ts` vs `transport/surface/chat/encode.ts`
  tool-call reconstruction (surface encode re-emits from canonical events; the
  request builder emits to upstream) was read but not traced end-to-end for
  byte equivalence; out of scope for this audit's conclusions.

## Open questions

1. Is `"instant"` intended to be accepted on the completion surface (alignment
   with chat/messages), or was its omission deliberate? F1 assumes the former;
   the canonical tuple and the chat surface already treat it as valid.
2. Should the request-side replay readers keep summary-first precedence as a
   named contract (F2), or is payload-first correct everywhere? The canonical
   reader's documentation says payload-first is deliberate for *display*; the
   request side is a different contract (replay) and is left unchanged here.
3. F3: is the ~150-line scaffold extraction worth the refactor risk given the
   three grammars are stable and well-tested? The maintenance argument is
   three-way fix propagation (each parser has already received parallel
   edge-case fixes).

## Execution status

Implementasi kampaian (2026-11-09), verified against the full backend suite
(4735 pass / 1 skip / 0 fail) and `tsc --noEmit` (zero errors in scope):

- **F1 (P-F1) — ✅.** The completion surface now routes reasoning-effort
  parsing through the shared `parseReasoningIntent`; `reasoning_effort:
  "instant"` and every canonical `REASONING_EFFORTS` value (plus the
  `reasoning_level` alias) are accepted and preserved. Invalid/non-string
  efforts still yield `undefined`. Test added
  (`test/transport/surface/completion-reasoning-effort.test.ts`).
- **F2 (P-F2) — ✅.** `reasoningTextForReplay` added with summary-first
  precedence; all five inlined replay readers now call it, each keeping its
  exact fallback. The duplicate `hasReasoning` in `request/chat.ts` was
  collapsed. Tests extended (`test/protocol/reasoning-leak.test.ts`).
- **F3 (P-F3) — ✅.** Generic `MarkupStreamParser<T>` extracted; DSML/OMP/Qwen
  parsers are thin configs. Per-grammar semantics preserved (DSML pass-through
  + cap fail-open, OMP discard-on-flush, Qwen hold-opener). Property test added
  proving chunk-split equivalence at every boundary.
