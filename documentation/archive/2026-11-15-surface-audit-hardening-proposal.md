# Surface protocol & translation audit — unified hardening proposal (v2)

**Status:** APPROVED and EXECUTED (2026-11-15). Every finding below has landed
on `dev` as its own commit with its own tests, against the F-41 contract
suite; the suite's divergence rows flipped to the fixed behavior as each
commit landed. The single rolling remainder is §3/L2 **F-18**: the first
tranche (the `default_payload` / `requires_upstream_stream` verbs + the grok
migration) landed with the existing payload tests as its parity harness; the
remaining adapters (buddy, cline, opencode, kimi, zcode-start-plan,
agentrouter) mutate from request/candidate-derived values and migrate one at
a time with their own snapshot parity. §5's deferred item is unchanged.
**Scope:** the *shared translation layer* all three public surfaces
(`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) flow through —
`src/protocol/translation/`, `src/transport/surface/dialects.ts`, the
canonical tool machinery (`src/protocol/tool-*.ts`), the capability/quirk
tables that declare provider differences, and the three response encoders.
**Method:** architecture walkthrough + three parallel read-only audit passes
(L1/L7 ingress & bounds, L2/L4 tables & reasoning, L3/L5/L6 pipeline &
encoders), every finding carrying file:line evidence. One integration's
free-tier tool shaping is explicitly deferred (§5).

---

## 1. Lineage and what each ancestor teaches

| Project | Design | Takeaway for the unified layer |
| --- | --- | --- |
| **oh-my-pi** (OMP — Rust+TS coding-agent *harness*) | Owns the toolset identity, sent-tool bookkeeping (`sent-tool-definitions.ts`: withdrawn tools re-declared byte-identically), tool-argument repair | The *client contract* harness-shaped clients expect: declared tools stay declared, fragments pair, repairs are byte-compatible → parity tests (F-23, F-26) |
| **9router** (9R — JS *router*, one translator per provider pair) | Per-pair translation, no canonical model | Per-pair readability without duplication → provider divergence must become *declarative* (capability/quirk rows), not more code (F-18) |
| **Cartethyia** | Canonical model + dialect codecs + evidence-gated quirk tables | The middle design. This audit hardens the shared layers without changing the architecture |

---

## 2. The translation layer, as audited

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

| Layer | File(s) |
| --- | --- |
| Surface adapters | `transport/surface/{chat,messages,responses}/adapter.ts` |
| L1 ingress validators | `transport/surface/dialects.ts`, per-surface `parse.ts` |
| L2 capability + quirks | `provider-metadata.ts` (compatibility profiles), `translation/quirks.ts` (ParamQuirk + WireTokenBound), `translation/capabilities.ts`, `translation/dialect/rules.ts` |
| L3 tool pipeline | `protocol/tool-identity.ts`, `tool-pairing.ts`, `tool-repair.ts` + `tool-repair-args.ts`, `tool-naming.ts`, `tool-schema.ts`, `translation/tool-id.ts`, `request/messages.ts` (tool ledger) |
| L4 reasoning/thinking | `translation/thinking.ts`, `translation/dialect/{resolver,model-thinking,thinking-ladder,qwen,rules,types}.ts`, `protocol/reasoning.ts`, `reasoning-text.ts`, `think-split.ts` |
| L5 cache control | `translation/cache-controls.ts`, `request/{chat,codex,messages}.ts` encoding sites |
| L6 event contract | `protocol/canonical-model.ts` events, `transport/surface/*/encode.ts` + `stream.ts`, `protocol/sse-decoder.ts`, `stream-error-frames.ts`, `stop-reason.ts`, `providers/provider-usage.ts` |
| L7 content bounds | `protocol/image-clamp.ts`, `transport/surface/content-parts.ts`, body limit (16 MiB) |

**The one meta-finding all three audit passes agree on:** the same logical
field gets *different verdicts per surface* (validated here, garbage-forwarded
there, silently dropped in a third), and the same *rule* is implemented at one
call site instead of at the canonical/encoder boundary where the codebase
already concentrates dialect logic. The hardening thesis: one contract per
concern, one shared file per rule, one parity test suite pinning the three
encoders to identical behavior.

---

## 3. Findings

Severity: **P0** = can produce a wrong/unsafe wire request today; **P1** =
degrades client experience, burns an upstream round-trip, or produces
surface-divergent verdicts; **P2** = hygiene/parity/documentation.

### L1 — the ingress contract

**F-1 · Tool JSON-schema size/depth/count are unbounded — P0.**
`parseToolDefinition` accepts any `parameters` JSON; the only bound in the
tree is integration-local. A megabyte-deep schema reaches every provider
codec. *Fix:* at ingress for all three dialects — serialized schema ≤ 64 KiB,
depth ≤ 24, array items ≤ 512, tools ≤ 256 (above every known provider
limit; per-provider clamps keep theirs). Files: `surface/dialects.ts`,
`protocol/tool-schema.ts`.

**F-2 · Tool names: duplicates, empties, charset — P0.**
Two tools with one name (the pairing ledger pairs the first, providers take
the last); empty-after-trim names survive the wrapper path. *Fix:* reject
duplicates and enforce `^[A-Za-z0-9_-]{1,128}$` with `tool-naming.ts`
alias-restore for exotic client names. Tests per dialect.

**F-3 · Malformed tool entries: silently dropped on Chat/Responses, thrown on
Messages; empty-array handling diverges — P1.**
The Chat adapter flatMaps non-parsing tools away; Responses filters; Messages
throws. A typo'd tool vanishes (the client believes the model can call it).
Empty `tools: []` is dropped by Chat, forwarded by Responses. *Fix:* shared
`parseToolsArray(value, dialect)` in `dialects.ts` — non-array 400s
everywhere, every entry must parse or 400, empty normalizes to undefined
everywhere.

**F-4 · Tool-call `arguments` are never validated as JSON, and the type
diverges per surface — P1.**
Chat keeps a raw string verbatim (`"not json{"` forwarded); Responses accepts
`arguments: 42`; Messages takes an object. *Fix:* shared
`normalizeToolCallArguments` — string must JSON.parse (empty → `"{}"`),
object → stringified, anything else 400. The canonical `toolCall.arguments`
stays a JSON string.

**F-5 · Tool pairing is enforced only on Messages — P1.**
Chat forwards `role:"tool"` without `tool_call_id`; Chat/Responses never run
the ledger; Messages throws `tool_result has no matching tool_use`. A tool
result with no preceding call is exactly the transcript providers reject
with opaque errors. *Fix:* extract the validation half of
`applyMessagesToolLedger` into a shared `protocol/tool-ledger.ts`
`validateToolPairing(messages, mode)` and run it on all three surfaces
(repair-or-throw, matching `canContainToolResult`).

**F-6 · `tool_choice` is never cross-checked against declared tools; empty
names accepted — P1.**
`{type:"function",function:{name:"nope"}}` with no matching tool is forwarded
verbatim; `name: ""` passes the string reader; `allowed_tools` entries are
unchecked/uncounted. *Fix:* shared `validateToolChoice(choice, tools)` —
named/allowed entries must be non-empty and within the declared tool names
(plus hosted types), `allowed_tools` ≤ 32, mismatch → 400 naming the missing
tool.

**F-7 · Non-object tool schemas silently coerced to `{}` — P2.**
A JSON-Schema-legal boolean root (`true`), array, or string becomes an empty
parameter schema with no signal. *Fix:* reject non-record schema roots with
a 400 naming the tool (no supported upstream wire accepts boolean schemas).

**F-8 · Responses flat tool with no schema key ships the whole tool object as
the parameter schema — P2.**
The `: item` fallback turns `{type:"function",name:"f",description:"d"}` into
a schema containing `name`/`description`/`type` — `invalid_function_parameters`
downstream. *Fix:* `{}` only for hosted/native types; a function tool with no
schema key is malformed → 400.

**F-9 · Hosted/native tool declarations lose their wire fields — P2.**
An `mcp` tool's `server_label`/`server_url`/`allowed_tools` and a
`web_search` tool's `search_context_size`/`filters` are dropped at parse —
the type is forwarded unconfigured. *Fix:* a `hosted_fields` allowlist per
native type on `ToolDefinition`, preserved through supporting encoders,
dropped with a debug log otherwise.

**F-10 · Sampling bounds diverge per surface — P2.**
Chat allows `max_tokens: 0` and non-integers and never reads `top_k`;
Responses requires integer ≥ 1; nothing bounds above. *Fix:* shared
`parseSamplingControl` — `max_tokens`/`max_completion_tokens` integer
1..1_048_576, `temperature` 0..2, `top_p` 0..1, `top_k` integer 1..128
(read it on Chat too); out-of-range → 400 naming field and value.

**F-11 · `stop` validation divergent and unbounded; Responses drops it — P1.**
Chat accepts any all-string array unbounded; Messages forwards any array
(numbers/objects included); the Responses extension whitelist has no `stop`
— silently dropped. *Fix:* shared `parseStopSequences` — strings only, each
1..64 chars, ≤ 4 entries, else 400 on all three surfaces.

**F-12 · `response_format` bounds missing; unknown type silently ignored —
P2.**
Unknown `type` is silently dropped (json-mode-less output for a typo'd
client), `json_schema.name` may be empty/unbounded, schema unbounded. *Fix:*
unknown type → 400; `json_schema` requires a record schema, non-empty `name`
≤ 64, the F-1 schema bounds. Applies to the Responses `text.format` alike.

**F-13 · Unknown reasoning effort silently dropped on Chat/Responses, hard
error on Messages; budget unvalidated — P2.**
`reasoning_effort: "maximum"` disappears (no thinking where thinking was
requested); `budget_tokens: -5` passes Chat. *Fix:* present-but-unknown
effort → 400 naming the value; `budget_tokens` integer ≥ 1024 when present;
surfaces map effort→budget via the shared level-to-budget table.

**F-14 · Unknown content-part types and empty media parts: three verdicts —
P2.**
Chat rejects unknown part types; Responses forwards them as extension
blocks; `{type:"image_url"}` with no URL and empty `data` audio pass
everywhere. *Fix:* one shared part policy — unknown type → 400 everywhere
(or one documented quarantine rule); image parts require non-empty
`url`/`data`/`file_id`, audio/file non-empty `data`/`file_id`.

**F-15 · Empty conversation accepted everywhere — P2.**
`messages: []` with only a system turn (or zero turns) parses on all three
surfaces and dies upstream with provider-specific errors. *Fix:* shared
final check — at least one non-system message (or a continuation reference)
after hoisting, else `invalid_request`.

**F-16 · `service_tier`: three verdicts for one field — P2.**
Unknown tiers forwarded as an extension on Chat, silently dropped on
Responses, restricted on Messages. *Fix:* one shared rule (reject or
uniformly forward) — pick one and delete the per-surface branches.

### L2 — capability and quirk tables (the unified provider contract)

**F-17 · The universal thinking-sampling strip leaks a Messages-only rule
onto chat wires — P1.**
`applyParamQuirks` strips `temperature`/`top_p`/`top_k` whenever thinking is
enabled, on every wire family (chat-wire adapters call it), while the rule
is Anthropic-scoped by contract ("Anthropic rejects sampling params
alongside thinking"). OpenAI chat wires legally accept both. *Fix:* gate the
strip on wire family at the adapter stage; golden test: chat-wire dispatch
with `reasoning_effort: high` + `temperature: 0.7` keeps its `temperature`.

**F-18 · Ad-hoc payload mutations inside adapters — the unification backlog —
P1.**
The quirk table's own rule ("one table row, never scattered adapter fixes")
is satisfied by the *evidence* but not by the *location*. Enumerated backlog
(live error codes cited in each):

| Integration | Site | Shapes |
| --- | --- | --- |
| opencode | provider prePayload | `store:false`, forced stream, `include_usage`, v2 ceiling, key reorder, prompt injection; 128-tool clamp |
| buddy | chat prePayload + validators | `max_completion_tokens`→`max_tokens` rename, tool_choice object→string (11101), `image_url` string→object, developer→system (11128), forced stream, reasoning_summary juggling, agent-field deletes, message repack; inline thinking validation; `sol` model forces a raised effort |
| cline | cline adapter | synthetic system message; deepseek-v4-flash forced stream + effort `"none"` + 256 floor |
| grok | grok adapter | forced stream, `store:false`, effort gate per model, forced `include`, `previous_response_id` delete, field allowlist |
| github | github adapter | effort cap `max/xhigh`→`high` (duplicates the ladder clamp) |
| kimi | kimi adapter | `metadata` injection + `max_tokens` clamp |
| zcode-start-plan | provider mutatePayload | system dress, `metadata.user_id`, default max_tokens |
| codex | codex adapter | `prompt_cache_key`/retention/client_metadata injection |
| agentrouter | agentrouter adapter | model id overwrite |

*Unified fix:* extend `ParamQuirk` with the verbs these already prove —
`setControls` (forced stream/store), `renameControls`, `forceModel`,
`allowlistFields`, `validateControls` (schema facts), a `stripOnModel`
matcher — and migrate one adapter at a time with snapshot-parity tests (the
table must produce byte-identical outbound bodies to the old prePayload).
`prePayload` survives only for identity/header dressing.

**F-19 · `tool_choice` support is a dialect rule but not a route capability —
P1.**
A dialect policy marks `supportsToolChoice: false` and drops the field, but
`deriveRequiredCapabilities` never inspects `request.tool_choice` — a named
`tool_choice` silently downgrades on such a candidate. *Fix:* derive
`tool_choice` as a `RequiredCapability` resolved against the dialect policy;
router test asserts a typed `capabilityUnsupported("tool_choice")`, never a
silent drop.

**F-20 · Stateless Responses is a one-off delete, not a capability — P2.**
One adapter deletes `previous_response_id` inline ("the proxy does not
persist responses → 404"). *Fix:* a `statelessResponses` capability on the
profile; the Responses codec strips the field once, declaratively; stateful
routes preserve it verbatim. Written into `providers-families.md`.

**F-21 · The gemini wire family has no token-bound row — P2.**
The per-wire token bounds cover chat/messages/responses only; a gemini-wire
request passes the bounds layer untouched. *Fix:* add the row once a live
400 proves values; until then an explicit "no proven bound" comment so the
gap is declared, not accidental.

**F-22 · System-shape and forced-stream facts are per-adapter code — P2.**
Forced `stream = true` appears in four adapters independently; one
integration's free-gate fact ("stream:false is ALWAYS refused with 403")
meets the evidence bar but can only be expressed as adapter code. *Fix:*
`requiresUpstreamStream?: boolean` and `systemShape?: "messages" |
"system-string" | "system-blocks" | "instructions"` on the dialect policy /
profile; the codecs own the reshaping once.

### L3 — the tool pipeline

**F-23 · Withdrawn-tool re-declaration does not exist — P1.**
The only "tool_removal" in the tree is a *skip* rule (the messages request
builder). A client that widens then narrows its tool set leaves history
calling a tool the current request no longer declares; strict wires reject
or hallucinate against it. OMP's harness solves exactly this with a
last-sent-definitions registry. *Fix:* a `SentToolDefinitions`-style
registry in `protocol/request/` — history-declared names absent from
`request.tools` are re-emitted verbatim (Chat: appended `tools[]`; Messages:
appended blocks; Codex: re-declared in the instruction list). Test: history
calls `tool_a`, current request omits it → every wire re-declares it
byte-identically to the request that introduced it.

**F-24 · Identity-key aliasing exists only on the Messages encoder — P1.**
`toolIdentityKey` collapses `call_`/`fc_` spellings, and Messages keys by
identity — but the Chat and Responses encoders key by raw id. One logical
call delivered under two spellings emits **two** tool calls on
Chat/Responses (the client executes the same action twice). *Fix:* route
both encoders through `toolIdentityKey` while emitting the first-seen raw
id. Contract test: `fc_abc` then `call_abc` → exactly one call per surface.

**F-25 · Composite prefixes do not collapse — P2.**
The single-pass prefix strip means `fc_call_x` vs `call_x` stay distinct,
defeating the duplicate-emission ledger for exactly the composite shape
Responses bridges produce. *Fix:* strip any leading sequence of known
prefixes. Test: claim `call_x` then `fc_call_x` → duplicate detection fires.

**F-26 · Argument repair is applied on Chat only — P1.**
The jsonrepair-based argument repair runs on the chat encoder and the
inbound request path; the Messages encoder returns the raw string on parse
failure (a non-object `tool_use.input`); the Responses encoder forwards
deltas verbatim. The exact near-JSON the module documents produces
wire-invalid output on two of three surfaces. *Fix:* one repair at the
canonical/encoder boundary — inside the Messages argument parse and
Responses finalization. Test: truncated `{"a": 1,` streamed through all
three encoders yields the same repaired output.

**F-27 · OAuth tool-name restore blindly unprefixed when the alias registry
misses — P2.**
The OAuth unprefix fallback strips `_` whenever the alias map (a WeakMap
keyed by request object identity) misses — and the tool-call repair returns
a *new* object, so the miss is structural. A caller tool legitimately named
`_bash` comes back as `bash`. *Fix:* record aliases on the canonical request
(first-class field, not a side WeakMap) and make the fallback compare
against the request's declared tool list. Test: `_bash` survives repair →
decode as `_bash`.

### L4 — reasoning/thinking translation

**F-28 · Two rank ladders kept in sync by hand — P2.**
The effort ladder and a separate effort-rank table (which adds `off`/`none`
and shifts `instant`) are both indexed for clamp vs floor comparisons on the
same strings. A tier inserted in one table silently corrupts clamp
direction. *Fix:* derive the rank table from the ladder programmatically +
one explicit non-ladder ranks map. Test: keys minus the non-ladder entries
equal the ladder in order.

**F-29 · Dialect thinking-format and control-mode enums overlap with no
cross-mapping — P2.**
`thinkingFormat` and `ThinkingControlMode` resolve independently per
(dialect, wire) with no consistency check. *Fix:* one `mode` per resolution
in the thinking config, or a compat table asserted by a cross-product test.

**F-30 · Reasoning injection keyed on raw model strings, outside the
capability gate — P1.**
One helper force-injects thinking + a raised effort whenever the outbound
model string starts with a family prefix — even when the canonical request
carries no intent; a replay-presence helper regex-matches model strings.
Both create reasoning the capability preflight never assessed. *Fix:* ladder
rule fields (a `requiresEffort` + the already-exported default effort) and a
`reasoningReplay` dialect flag. Test: a family model with no intent gets the
ladder default; a non-matching model gets neither.

**F-31 · A wire's budget floor contradicts the ladder's own budgets — P2.**
The canonical ladder publishes budgets a wire declares invalid (an adapter
400s any budget below 1024 while the ladder defines 256/512) — an unmapped
(ladder level × wire) cell that fails instead of clamping. *Fix:* a
declarative `minBudgetTokens` per dialect consumed by a shared clamp before
validation. Test: a sub-floor budget clamps to the floor (or a typed 400
naming the mapping).

**F-32 · An effort cap duplicates the ladder clamp — P2.**
`max/xhigh → high` as adapter code; the generic ladder clamp + rules already
express it. *Fix:* a ladder rule for the provider family and delete the
prePayload mutation.

**F-33 · The reasoning matrix has no test — P2.**
Every effort spelling × dialect family × capable/non-capable model: no test
drives the matrix. *Fix:* a matrix test so a new family cannot silently drop
a spelling.

### L5 — cache-control translation

**F-34 · Cache hints are rewritten per dialect and consumed by no builder
literally — P1.**
The Anthropic mapping ignores the hint shape entirely (every hint maps to the
same trailing ephemeral block); Chat marks nothing for `stable_prefix`; the
Codex path invents a literal cache-key string from the hint. Caller intent
(explicit breakpoint positions) is lost on the wire that supports it best.
*Fix:* consume the hint — breakpoint lists map to cache-control on the
Nth-from-last cacheable block; `stable_prefix` → one trailing breakpoint;
delete the synthesized key strings. Test: one canonical request, four wires,
asserted placements.

### L6 — the event/stream contract

**F-35 · A client-cancelled or upstream-dropped stream looks like success on
Chat — P1.**
An aborted terminal → `finish_reason: "stop"` on Chat (a complete answer!),
`response.incomplete` on Responses, `null` stop_reason on Messages. Agents
treat truncated output as a finished turn. *Fix:* per-state terminal
mappings (aborted ≠ stop); Chat emits no finish chunk (or an explicit
cancelled marker) for aborted. Test: the aborted terminal through all three
encoders with the divergence documented in one table.

**F-36 · Chat non-stream drops unnamed tool calls but keeps
`finish_reason: "tool_calls"` — P1.**
The exact dangling-stop bug Messages guards (downgrade when zero calls
survive) ships on the chat non-stream path; the chat stream path emits
nameless `function` deltas with no filter at all. *Fix:* mirror the
Messages rule in both chat encoders (count dropped, downgrade the reason;
withhold argument-only deltas until a name arrives).

**F-37 · The Messages stream wipes all per-call state on the first tool
result — P1.**
Interleaved parallel streams (delta A, delta B, result A, delta B) re-open a
second `tool_use` block for B — duplicate ids, double execution on strict
clients. *Fix:* per-call reset only (match the Responses encoder's
park/suspend semantics). Test: interleaved deltas assert one block start per
call id.

**F-38 · Two incompatible `response.error` payload shapes in one encoder —
P2.**
The push path emits one shape (`category`+`message`); the fatal encoder
emits another (`origin`+`code`+`details`). Clients keying on `code` cannot
classify mid-stream errors. *Fix:* one builder both paths call.

**F-39 · The SSE decoder merges truncated events into one payload — P2.**
Continuation heuristics append bare lines to open data, so corruption decodes
as a *merged* delta instead of an error — defeating the decoder's own header
policy ("a corrupt stream must never decode as valid deltas"). *Fix:* bound
the continuation rule (cannot start a fresh frame; cap continuations; throw
on stream-end with incomplete JSON). Tests: truncated-then-fresh-event,
keep-alive, CRLF.

**F-40 · Usage parity: Chat drops usage on cancel/abort, Messages always
attaches, Responses never maps cache-write tokens — P2.**
Same canonical terminal, three billing/visibility outcomes; cache-write
tokens are priced but invisible on two surfaces. *Fix:* one per-surface
"usage on terminal state" policy in the usage mapper + cache-write in the
Responses usage where the wire has a slot. Test: same event list
(complete/aborted/cancelled) through all three encoders.

**F-41 · Cross-surface contract test suite — the deliverable that pins
everything — P0 (test infrastructure).**
One suite feeding identical canonical event lists through all three encoders:
stop-reason parity, usage parity, tool-call parity, error-shape parity.
Intentional divergences are pinned and documented; everything else is drift
and fails. F-24, F-26, F-35, F-36, F-40 are all instances of one root cause
(a rule implemented at one call site instead of the canonical boundary) —
this suite is what makes that class of bug impossible to reintroduce.

### L7 — content bounds

**F-42 · Inline documents/files/audio have no size ceiling — P2.**
The clamp policy is image-specific; a 40 MB base64 PDF (once the body cap is
raised per deployment) poisons every retry and replay. *Fix:* generalize
into an attachment clamp (e.g. 32 MB decoded) applied at the inline-file
normalizer + the audio sites; over-limit → deterministic 400 naming kind and
size. Images keep their existing policy.

**F-43 · Tool-result payloads are unbounded — P2.**
A `tool_result` text block can carry hundreds of KiB — the classic context
killer. *Fix:* optional env-gated truncation above N KiB with a marker
suffix (env `CARTETHYIA_TOOL_RESULT_MAX_KB`, default off), applied in
canonical content-part normalization so all three dialects inherit it.

---

## 4. Priority and order

| # | Item | Layer | Severity | Effort |
| --- | --- | --- | --- | --- |
| 1 | F-41 — the cross-surface contract test suite (pins every divergence; everything else lands against it) | L6 | P0 | 1 day |
| 2 | F-4 + F-5 + F-3 — tool arguments normalization, pairing ledger everywhere, tools-array verdict parity | L1/L3 | P0/P1 | 1 day |
| 3 | F-23 — withdrawn-tool re-declaration registry | L3 | P1 | half day |
| 4 | F-1 + F-2 — tool schema bounds + name rules at ingress | L1/L3 | P0 | half day |
| 5 | F-35 + F-36 — abort/terminal semantics + unnamed-call dangling finish | L6 | P1 | half day |
| 6 | F-24 + F-25 + F-26 — identity aliasing everywhere + composite prefixes + repair everywhere | L3/L6 | P1 | half day |
| 7 | F-17 — thinking-strip wire-family gating | L2 | P1 | 2 h |
| 8 | F-6 + F-11 + F-13 + F-16 — tool_choice cross-check, stop bounds, reasoning strictness, service_tier | L1 | P1/P2 | half day |
| 9 | F-18 — the ad-hoc mutation migration backlog (adapter by adapter, snapshot parity) | L2 | P1 | multi-day, rolling |
| 10 | F-19 + F-20 + F-22 — capability flags (tool_choice, statelessResponses, systemShape/requiresUpstreamStream) | L2 | P1/P2 | 1 day |
| 11 | F-28..F-32 — reasoning ladder unification + parity | L4 | P2 | 1 day |
| 12 | F-7..F-9, F-12, F-14, F-34, F-37..F-40 — the P2 tail | mixed | P2 | rolling |
| 13 | F-42 + F-43 — attachment clamp + tool-result truncation (env-gated, off) | L7 | P2 | 2 h |

Every item lands on `dev` as its own commit with its own tests. Nothing here
changes the canonical model, the architecture, or any integration's identity;
the F-18 migration is the only multi-day item and is rolling by design.

---

## 5. Deferred

- **One integration's free-tier tool shaping** (agent-tool backfill, clamp
  protection, prompt injection): deferred by the operator (2026-11-15) to a
  separate effort. First step when taken up: live verification of the gate —
  the code's 403 evidence dates to 2026-10-14, the operator's pass-through
  report to 2026-11-15.

---

## 6. Method note

Findings were produced by three parallel read-only audit passes over the
translation layer (ingress & bounds; tables & reasoning; pipeline &
encoders), each returning file:line evidence, then consolidated per layer.
The OMP harness (`Public/oh-my-pi`) and 9R (`Public/9router`) were consulted
as design references only; neither is part of this repository.
