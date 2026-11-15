# Surface protocol & translation audit — unified hardening proposal

**Status:** proposal for review — nothing here is implemented yet.
**Scope:** the *shared translation layer* all three public surfaces
(`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) flow through —
`src/protocol/translation/`, `src/transport/surface/dialects.ts`, the
canonical tool machinery in `src/protocol/tool-*.ts`, and the capability /
quirk tables that declare provider differences. The goal is hardening in one
general, unified place per concern — never per-provider patches scattered
through integrations.

Reference points: **oh-my-pi** (OMP — a Rust+TS coding-agent *harness*; the
design ancestor of the toolset identity harness-shaped clients expect) and
**9router** (9R — a JS *router* with one translator per provider pair). The
OpenCode tool-shaping question is **explicitly deferred** (§7) and out of
scope for this document.

---

## 1. Lineage and what each ancestor teaches

| Project | Design | What it owns | Takeaway for the unified layer |
| --- | --- | --- | --- |
| **oh-my-pi** (`Public/oh-my-pi`) | Agent **harness** — TS agent over an ~80k-line Rust core; 31 built-in tools; 60+ providers | The toolset identity, system-prompt persona, sent-tool bookkeeping (`sent-tool-definitions.ts` re-declares withdrawn tools byte-identically for Anthropic's keep-declared behavior), tool-argument repair | The *client contract* the gateway must preserve for harness-shaped clients: declared tools stay declared, argument fragments pair with call ids, repairs stay byte-compatible. These become parity tests (F-7, F-8) |
| **9router** (`Public/9router`) | **Router** — one translator per provider pair (`openai-to-claude.js`, `claude-to-kiro.js`, …), flat JS | Per-provider wire translation, no canonical model | Readability of per-pair translation. Cartethyia's canonical model avoids the duplication but hides per-provider facts inside code — the unified fix is declaring those facts (capabilities + quirks), not adding translator files |
| **Cartethyia** | **Canonical model + dialect codecs** — one neutral request/events model, three surface adapters, an evidence-gated quirk table | Everything between client and provider | The middle design. This audit hardens the shared layers without changing the architecture |

---

## 2. The translation layer, as audited (2026-11-15)

```
client wire ──▶ surface adapter ──▶ canonical request ──▶ [L1 ingress contract]
                 (3 adapters)                          [L2 capability + quirk tables]
                                                       [L3 tool pipeline]
                                                       [L4 reasoning/thinking translation]
                                                       [L5 cache-control translation]
                                                       [L6 event/stream contract]
                                                       [L7 content bounds]
                                             ──▶ provider codec ──▶ upstream
```

| Layer | File(s) | State |
| --- | --- | --- |
| Surface adapters | `transport/surface/{chat,messages,responses}/adapter.ts` | thin; parse/encode delegation |
| L1 ingress validators | `transport/surface/dialects.ts` | `parseToolDefinition` (3 envelope shapes), `parseToolChoice` (strict on Messages, lenient elsewhere), `parseGenerationControls`, `parseReasoningIntent`, `parseResponseFormat` |
| L2 capability + quirks | `provider-metadata.ts` (`PROVIDER_COMPATIBILITY_PROFILES`), `translation/quirks.ts`, `translation/capabilities.ts` | evidence-gated table: `stripControls`, `clampMaxOutput`, per-wire token bounds (`defaultMaxTokens`, `minTokens`, tool floor); rule: a row only when a concrete upstream 400/422 proves it |
| L3 tool pipeline | `protocol/tool-identity.ts` (call-id tracking, emit ledger), `tool-pairing.ts`, `tool-repair.ts` + `tool-repair-args.ts` (argument repair), `tool-naming.ts` (alias restore), `tool-schema.ts`, `translation/tool-id.ts` | per-concern modules, no single documented pipeline |
| L4 reasoning/thinking | `translation/dialect/resolver.ts`, `dialect/{model-thinking,thinking-ladder,qwen,rules,types}.ts`, `translation/thinking.ts`, `protocol/reasoning*.ts`, `think-split.ts` | budget ↔ effort mapping per dialect family |
| L5 cache control | `translation/cache-controls.ts` | `prompt_cache_key` / `cache_control` / ephemeral blocks |
| L6 event contract | `protocol/canonical-model.ts` events, `transport/surface/*/encode.ts`, `stream-error-frames.ts`, `sse-decoder.ts` | canonical events → per-surface wire events |
| L7 content bounds | `protocol/image-clamp.ts`, body limit (16 MiB), `translation/attachment-integrity.ts` | images clamped; tool results and schemas unbounded |

The architecture is right: one canonical model, validators in one file,
provider differences as table rows. The findings below close the gaps layer
by layer — each fix lands in the *shared* file, never in an integration.

---

## 3. Findings and unified hardening proposals

Severity: **P0** = can produce a wrong/unsafe wire request today; **P1** =
degrades client experience or burns an upstream round-trip; **P2** =
hygiene/parity/documentation.

### L1 — the ingress contract

**F-1 · Tool JSON-schema size and depth are unbounded — P0.**
`parseToolDefinition` accepts any `parameters` JSON. The only schema bound in
the tree is OpenCode-specific. A megabyte-deep schema reaches every provider
codec. *Unified fix:* bound every tool definition at ingress for all three
dialects — serialized schema ≤ 64 KiB, nesting depth ≤ 24, array items ≤ 512,
total tools ≤ 256 (above every known provider limit; per-provider clamps keep
theirs). Violations answer `invalid_request` naming the field. Files:
`surface/dialects.ts`, measure helper in `protocol/tool-schema.ts`.

**F-2 · Duplicate and malformed tool names pass — P0.**
Two tools with one name (pairing ledger pairs the first, providers take the
last) and empty-after-trim names survive ingress. *Unified fix:* reject
duplicates and enforce the charset every major provider enforces
(`^[A-Za-z0-9_-]{1,128}$`), with `tool-naming.ts` alias-restore handling
exotic client names. Tests per dialect.

**F-4 · Sampling controls are not range-checked — P1.**
Any finite `temperature`/`top_p`/`top_k` passes; providers reject
out-of-range later. *Unified fix:* canonical bounds at ingress —
`temperature` ∈ [0, 2], `top_p` ∈ (0, 1], `top_k` ≥ 1 — answering
`invalid_request` naming field and range. Clamping silently is rejected on
purpose: a clamped sample is a generation the client did not ask for.

**F-10 · Ingress failures must be surface-native — P2.**
Messages maps its parse errors through `messages/errors.ts`; verify Chat and
Responses map theirs to their native shapes (OpenAI `{"error":{…}}`,
Responses error event). *Unified fix:* a parity test per surface per failure
class (missing model, bad tool_choice, bad schema) driven from the shared
validators.

### L2 — capability and quirk tables (the unified provider contract)

**F-3 · `tool_choice` has no capability declaration — P1.**
Ingress parses it per dialect, but whether the chosen provider supports
`none`/`auto`/`required`/named is unknown until upstream refuses.
*Unified fix:* a `toolChoice` capability on the provider row (default: full
support) + a quirks row shape that strips unsupported shapes per provider,
evidence-gated like `stripControls`.

**F-5 · Responses store/state semantics are implicit — P1.**
`previous_response_id`/`conversation` are forwarded; `store` is forced only
by one integration. The gateway keeps no response store. *Unified fix:* a
`statelessResponses` capability flag — when set, a request carrying
`previous_response_id` answers `invalid_request` up front instead of an
upstream "conversation not found" — plus the contract written into
`providers-families.md`.

**F-12 · Ad-hoc provider shaping lives outside the tables — P1 (the
unification core).**
The quirk table's own header states the rule: *"instead of scattering ad-hoc
`delete payload.x` fixes through adapters, each quirk lives in one table
row"*. Today shaping still leaks into integrations: OpenCode patches
payloads in `prePayload`, other integrations mutate bodies in adapters.
*Unified fix:* an audit pass listing every `prePayload`/`prepareRequest`/
adapter-body mutation in `src/providers/integrations/`, then classify each:
(a) proven quirk → table row, (b) wire-shape constant (endpoint/key order) →
codec or capability flag, (c) genuinely provider-specific logic → stays,
documented in `providers-families.md`. The deliverable is a table where a
provider's entire wire divergence is declarative and greppable — 9R's
per-pair readability without its duplication.

### L3 — the tool pipeline

**F-7 · Withdrawn-tool re-declaration parity with the harness — P2.**
OMP's `sent-tool-definitions.ts` re-declares withdrawn tools byte-identically
(Anthropic keeps them declared). Ours is `applyMessagesToolLedger`
(Messages) — no test asserts the parity (declare → withdraw → re-dispatch
keeps the definition). *Unified fix:* the parity test; extend the ledger if
it drops definitions the harness keeps.

**F-8 · Argument-repair parity — P2.**
`tool-repair-args.ts` vs OMP's `tool-arguments.ts`: both repair argument
fragments split across stream deltas. *Unified fix:* a shared fixture test
with the harness's documented failure shapes (truncated JSON, split escapes,
paired fragments) so repairs stay byte-compatible with the clients that
produced them.

**(F-1/F-2 also land here:** the bounds live in `tool-schema.ts`, the name
rules in `tool-naming.ts`, so every dialect and every codec inherits them.**)**

### L4 — reasoning/thinking translation

**F-13 · Effort/budget mapping lacks a cross-dialect parity test — P2.**
The dialect resolver maps `budget_tokens` ↔ `reasoning_effort` ↔ thinking
ladder per family; Messages folds `output_config.effort`/`task_budget` in;
Chat reads `reasoning_effort`. Each works; nothing pins the *matrix*
(every effort spelling × every dialect family × a reasoning-capable and a
non-capable model). *Unified fix:* a matrix test in
`translation/dialect/` so a new family cannot silently drop an effort
spelling.

### L5 — cache-control translation

**F-14 · Cache hints are dialect-asymmetric — P2.**
Chat takes `prompt_cache_key`/`cache_control: "auto"`, Messages takes
Anthropic ephemeral blocks; a caller on the "wrong" surface gets no cache
hint. *Unified fix:* document the mapping (or normalize in the canonical
model) and test that a stable prefix hint survives chat→messages and
messages→chat translations for providers that support both.

### L6 — the event/stream contract

**F-11 · Forced-upstream-stream aggregation is undocumented — P2.**
When a provider requires `stream: true` but the client asked for JSON, the
response layer aggregates SSE back to JSON generically. Correct; add it to
the wire-dialects doc so it is not mistaken for one integration's trick.

**F-15 · Usage and terminal-event emission parity — P2.**
`include_usage` handling, terminal stop reasons, and `transport_closed`
(cancel) semantics are implemented per encoder. *Unified fix:* one contract
test driving the same canonical event list through all three encoders
asserting identical usage numbers, stop semantics, and cancel behavior.

### L7 — content bounds

**F-6 · Tool-result payloads are unbounded — P2.**
A `tool_result` text block can carry hundreds of KiB (the classic context
killer). Images are clamped; tool results are not. *Unified fix:* optional
env-gated truncation above N KiB with a marker suffix
(`CARTETHYIA_TOOL_RESULT_MAX_KB`, default off — no behavior change), applied
in the canonical content-part normalization so all three dialects inherit it.

---

## 4. Priority and order

| # | Item | Layer | Severity | Effort |
| --- | --- | --- | --- | --- |
| 1 | F-1 + F-2 — tool schema bounds + name rules at ingress | L1/L3 | P0 | half day |
| 2 | F-4 — sampling range validation | L1 | P1 | 2 h |
| 3 | F-12 — ad-hoc shaping audit → table rows (the unification core) | L2 | P1 | 1 day |
| 4 | F-3 — tool_choice capability + quirk strip | L2 | P1 | half day |
| 5 | F-10 — surface-native error parity tests | L1 | P2 | 2 h |
| 6 | F-5 — statelessResponses flag + contract doc | L2 | P1 | half day |
| 7 | F-7 + F-8 — harness parity tests (withdrawn tools, argument repair) | L3 | P2 | 2 h |
| 8 | F-13 — reasoning matrix test | L4 | P2 | 2 h |
| 9 | F-15 — event contract test across encoders | L6 | P2 | 2 h |
| 10 | F-6 — tool-result truncation (env-gated, off) | L7 | P2 | 2 h |
| 11 | F-14 + F-11 — cache mapping + forced-SSE docs | L5/L6 | P2 | 1 h |

Every item lands on `dev` as its own commit with its own tests; nothing here
changes the canonical model, the architecture, or any single integration's
identity.

---

## 5. Deferred

- **OpenCode free-tier tool shaping** (the 11-tool backfill, clamp
  protection, prompt injection): explicitly deferred by the operator
  (2026-11-15) to a separate effort. It is an integration-local question —
  the unified layer above deliberately does not carry it. When it is taken
  up, the first step is a live verification of the free-tier gate (the code's
  403 evidence dates to 2026-10-14) against the operator's pass-through
  report of 2026-11-15.
