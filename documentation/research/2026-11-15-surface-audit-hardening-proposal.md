# Surface API audit & hardening proposal — Messages, Responses, Completions

**Status:** proposal for review — nothing here is implemented yet.
**Scope:** the three public gateway surfaces (`/v1/messages`, `/v1/responses`,
`/v1/chat/completions`), their ingress validation, tool handling, and the
OpenCode tool-shaping layer. Reference points: **oh-my-pi** (OMP, a Rust+TS
coding-agent *harness* — the design ancestor of the toolset identity our
OpenCode integration mirrors) and **9router** (9R, a JS *router* with one
translator file per provider pair).

---

## 1. Lineage and what each ancestor teaches

| Project | Design | What it owns | What this audit takes from it |
| --- | --- | --- | --- |
| **oh-my-pi** (`Public/oh-my-pi`) | Agent **harness** — the client side. TS agent over an ~80k-line Rust core; 31 built-in tools; 60+ providers | The toolset identity, the system-prompt persona, sent-tool bookkeeping (`sent-tool-definitions.ts` re-declares withdrawn tools byte-identically for Anthropic's "tools stay declared" behavior), tool-argument repair | The *contract* our gateway must preserve for harness-shaped clients: tools that were once declared keep being declared, argument fragments pair with call ids, and the environment block rides the system prompt |
| **9router** (`Public/9router`) | **Router** — one translator per provider pair (`openai-to-claude.js`, `claude-to-kiro.js`, …), flat JS | Per-provider wire translation, no canonical model | Readability of a per-pair translation; the value of documenting each provider's tool mapping explicitly. Cartethyia deliberately chose the canonical-model design instead — harder to trace per pair, far less duplication |
| **Cartethyia** | **Canonical model + dialect codecs** — one neutral request/events model, three surface adapters, per-dialect validators, an evidence-gated quirk table | Everything between client and provider | The middle design. This audit hardens its ingress without changing the architecture |

The OpenCode free tier is where the lineage shows on the wire: the free gate
reads an agent-tool fingerprint (`edit, glob, grep, read, shell, skill,
subagent, webfetch, websearch, write, execute` — the OMP/Pi family toolset),
and our adapter currently *manufactures* that fingerprint for clients that do
not send it. That is the layer the operator wants gone (§6).

---

## 2. Architecture snapshot (as audited, 2026-11-15)

```
client wire ──▶ surface adapter ──▶ canonical request ──▶ dialect resolver / quirks ──▶ provider codec ──▶ upstream
   chat          chat/adapter        canonical-model      translation/quirks (evidence-         request/{chat,messages,responses}
   messages      messages/adapter    + tools + controls    gated strip/clamp table)             (per-family codecs)
   responses     responses/adapter                        + per-wire token bounds
```

| Piece | File(s) | Shape |
| --- | --- | --- |
| Surface adapters | `src/transport/surface/{chat,messages,responses}/adapter.ts` | `matchesBodyShape` + `parse` + `encode`/`encodeOutput` |
| Shared dialect validators | `src/transport/surface/dialects.ts` | `parseToolDefinition` (chat/messages/responses envelopes), `parseToolChoice` (strict-throw on Messages, lenient elsewhere), `parseReasoningIntent`, `parseResponseFormat` |
| Param quirks | `src/protocol/translation/quirks.ts` | evidence-gated table: per-provider `stripControls`, `clampMaxOutput`; per-wire token bounds (`defaultMaxTokens`, `minTokens`, tool-floor) |
| Tool machinery | `protocol/tool-identity.ts`, `tool-pairing.ts`, `tool-repair.ts`, `tool-repair-args.ts`, `tool-naming.ts`, `tool-schema.ts`, `translation/tool-id.ts` | call-id tracking, fragment pairing, argument repair, alias restore |
| OpenCode shaping | `src/providers/integrations/opencode/{provider,tool-definitions,prompt,fingerprint}.ts` | free-tier tool backfill, 128 clamp, prompt injection, forced stream, key reorder |
| Ingress guards (upstream of surfaces) | `transport/guards/` | body ≤ 16 MiB, API-key auth, admission, abuse bans |

The adapters are thin and honest; the validation weight lives in
`dialects.ts` + the provider codecs. That is the right shape — the findings
below harden those two layers without restructuring anything.

---

## 3. Findings and hardening proposals

Severity: **P0** = can produce a wrong/unsafe wire request today; **P1** =
degrades client experience or burns an upstream round-trip; **P2** =
hygiene/documentation.

### F-1 · Tool JSON-schema size and depth are unbounded at ingress — P0

`parseToolDefinition` accepts any `parameters` JSON and passes it through. The
only bound in the tree is OpenCode-specific
(`completeOpenCodeToolSchemas` → `completeRequiredSchema`). A hostile or
accidental tool definition can carry a megabyte-deep schema (the 16 MiB body
limit is the only ceiling), which then reaches every provider codec.

**Proposal.** Bound every tool definition at ingress, in `dialects.ts`, for
all three dialects: serialized schema ≤ 64 KiB, nesting depth ≤ 24, array
items ≤ 512, total tools ≤ 256 (the one upstream limit we know is OpenCode's
128 — the generic ceiling must sit above every known provider limit and the
per-provider clamps keep theirs). Violations answer `invalid_request` with a
field-specific message, never a silent drop (a dropped tool strands its
history). Files: `surface/dialects.ts`, new schema-measure helper in
`protocol/tool-schema.ts`. Tests: oversized/deep schema per dialect.

### F-2 · Duplicate and empty tool names pass ingress — P0

`parseToolObject` falls back to `type` for the name (hosted tools), then to
`undefined → drop`. Two failure shapes survive: (a) two tools with the same
name (last wins at providers; the pairing ledger pairs the first), (b) a name
that is empty after trim via the `function`-wrapper path. Proposal: reject
duplicates (`invalid_request`, naming the collision), reject empty/whitespace
names, and enforce the same name charset every provider eventually enforces
(`^[A-Za-z0-9_-]{1,128}$` — matches what OpenAI/Anthropic accept) with the
existing alias-restore path (`tool-naming.ts`) handling exotic client names.
Files: `dialects.ts`, `tool-naming.ts` tests.

### F-3 · `tool_choice` has no per-provider capability statement — P1

Ingress parses `tool_choice` per dialect (strict on Messages, lenient on
Chat/Responses — deliberate). But whether the *chosen provider* supports
`none`/`auto`/`required`/`{type:"function",…}` is unknown until upstream
answers; a provider that lacks it burns a round-trip and surfaces a raw 400.

**Proposal.** Add `toolChoice: "none" | "auto" | "required" | "named"` (or
`false`) to the capability table row, defaulting to full support, and let
`quirks.ts` strip unsupported shapes per provider with an evidence-only
comment — exactly the mechanism already used for `stripControls`. Files:
`provider-metadata.ts` (capability), `quirks.ts`, tests.

### F-4 · Sampling controls are not range-checked at ingress — P1

Messages/Chat accept any finite `temperature`/`top_p`/`top_k`
(`finiteNumber` only). Providers then reject out-of-range values with their
own codes. Proposal: canonical bounds at ingress — `temperature` ∈ [0, 2],
`top_p` ∈ (0, 1], `top_k` ≥ 1 — answering `invalid_request` naming the field
and the range, rather than clamping silently (a clamped sample is a different
generation the client did not ask for). Files: `surface/dialects.ts`
(`parseGenerationControls`). Tests: boundary values.

### F-5 · Responses `store`/`previous_response_id` passthrough is implicit — P1

The gateway is stateless across requests: `previous_response_id` and
`conversation` are parsed and forwarded, `store` is forced `false` only for
OpenCode. Any provider that honors `previous_response_id` against *its own*
store will work; one that expects the gateway to have stored the previous
response cannot (we never stored it). Proposal: state the contract explicitly
in `docs` and in `responses/parse.ts`: `previous_response_id` is forwarded
verbatim (provider-scoped store), the gateway keeps no response store, and
`store` defaults are provider-owned. Add a guard: `previous_response_id` +
any provider row that declares `stateless_responses: true` (new capability
flag) answers `invalid_request` up front instead of an upstream
"conversation not found". Files: `responses/parse.ts`, capability table,
`documentation/reference/` (wire contract).

### F-6 · Tool-result payloads are unbounded — P2

An ingress bound exists for the body (16 MiB) and for images
(`image-clamp.ts`), but a single `tool_result` text block can still be
hundreds of KiB (a `cat` of a minified bundle), which is the classic
context-window killer for the whole conversation. Proposal: an optional,
env-controlled truncation for tool results above N KiB with a marker suffix
(`[truncated N KiB — tool result]`), default **off** (no behavior change),
documented. Files: `canonical-model` content-part normalization or the
messages/chat parse path; env `CARTETHYIA_TOOL_RESULT_MAX_KB`.

### F-7 · Withdrawn-tool re-declaration parity with the OMP harness — P2

OMP's `sent-tool-definitions.ts` keeps the last wire definition per tool name
so a provider that requires withdrawn tools to stay declared
(Anthropic `tool_removal`) gets them re-declared byte-identically. Our
equivalent is `applyMessagesToolLedger` (Messages) — but there is no test
asserting the two behaviors match (declare → withdraw → re-dispatch keeps the
definition). Proposal: add the parity test; if the ledger drops definitions
the OMP harness keeps, extend the ledger. Files:
`surface/messages/parse.ts`, new test.

### F-8 · Argument-repair parity — P2

Same shape as F-7 for `tool-repair-args.ts` vs OMP's `tool-arguments.ts`:
both repair argument fragments (JSON split across stream deltas). Proposal:
a shared fixture test with OMP's documented failure shapes (truncated JSON,
split escapes, paired fragments) so repairs stay byte-compatible with the
harness clients that generated them.

### F-9 · Chat shape matcher claims Claude-Code bodies on unknown paths — documented, add observability — P2

`ChatAdapter.matchesBodyShape` deliberately claims block-content bodies with
`max_tokens` when the route is unknown (the endpoint path wins on known
routes). Correct, but invisible: when it happens, nothing records it.
Proposal: one metric/log line ("ambiguous body routed to chat by path
fallback") so a client sending the wrong shape is diagnosable from the
gateway instead of from a support thread. Files: `surface/registry.ts` or
the route fallback site.

### F-10 · Ingress validation failures must be surface-native — P2

Messages parse failures throw plain `Error`s (`messages/errors.ts` maps
them); verify the Chat and Responses paths map their own parse errors to
their native shapes (OpenAI `{"error":{…}}`, Responses
`{"error":{code,…}}`) rather than leaking a Messages-shaped envelope.
Proposal: a parity test per surface per failure class (missing model, bad
tool_choice, bad schema). Files: `chat/parse.ts`, `responses/parse.ts`,
their `errors.ts`.

### F-11 · Forced-SSE aggregation — keep, document — P2

The response layer aggregates a forced upstream stream back to JSON for
non-stream clients (OpenCode free). This is correct and generic; add it to
the wire-dialects doc so it is not mistaken for OpenCode-specific.

---

## 4. The OpenCode tool-translation removal (operator request)

**Current behavior** (`integrations/opencode/provider.ts`): for free-tier
models the adapter

1. **backfills** the 11 free-agent tools verbatim when the client did not
   send them (`ensureFreeAgentRequest`) — the gate read the *definitions*, not
   just names (verified live 2026-10-14: a five-tool subset answered 403
   `FreeTierError`);
2. protects those names (and called tools) inside the 128-tool
   **clamp** (`clampOpenCodeTools`) — reproduced live 2026-10-16: a 128-tool
   Claude Code session lost its fingerprint tools to the clamp and died 403;
3. injects the minimal harness system prompt (`<env>` block) — the gate
   requires the `Working directory:` line (verified: a ~30-char placeholder
   passes);
4. forces `stream: true` + `include_usage`, v2 completion ceiling, chat key
   reordering.

**Operator report (2026-11-15):** pass-through now works — a client sending
its own tools with no backfill dispatches fine, so the gate appears relaxed
since the 2026-10-14 measurements. The operator wants the tool translation
gone: no tool backfill toward the agent set when the client did not ask for
it.

**Proposal — verify, then remove in stages:**

1. **Live verification first** (the code's 403 evidence is from 2026-10-14;
   the operator's pass-through report is 2026-11-15 — upstream moved):
   a. free model, client tools only (no backfill, no injected prompt),
      `stream: true` → expect 200.
   b. free model, **no tools at all** → expect 200 (the old gate refused
      tool-less dispatches).
   c. non-streaming free dispatch → expect 200 (the old gate refused
      `stream: false`; if it still refuses, forced stream stays).
   Record all three in the research note.
2. **Removal scope on a green (a)+(b):**
   - delete `ensureFreeAgentRequest` and the `prepareRequest` hook;
   - drop `FREE_AGENT_TOOL_NAMES` protection from `clampOpenCodeTools`
     (keep the called-tools protection — that one is structural, not
     gate-specific);
   - delete `OPENCODE_TOOL_DEFINITIONS` + `prompt.ts` injection *only if*
     (b) also passed without the injected prompt (the prompt gate and the
     tool gate are separate knobs — verify separately);
   - keep forced stream + ceiling until (c) passes;
   - kill-switch for one release: `CARTETHYIA_OPENCODE_AGENT_TOOLS=on`
     restores the old backfill verbatim, in case the gate re-tightens.
3. **On a red (a):** the gate is still live — document the operator's
   pass-through observation as tier- or date-dependent, keep the backfill,
   and add the live-verification dates to the comment so the next audit does
   not re-litigate blind.

Tests touched either way: the free-tier fixture tests that assert the 11-tool
backfill, and a new pass-through fixture.

---

## 5. What we take from each reference (and what we reject)

- **From OMP (harness):** the *client-contract* tests — withdrawn tools stay
  declared, argument fragments repair byte-identically (F-7/F-8). We do not
  adopt its runtime: a harness owns the toolset and the persona; Cartethyia
  is the pipe and must not grow an opinionated toolset of its own (which is
  also the operator's argument in §4).
- **From 9R (router):** per-pair readability. The canonical model stays, but
  every provider pair gets a short wire-contract block in
  `providers-families.md` (endpoint, tool_choice support, quirk list) so the
  translation is as greppable as 9R's files without becoming them.

---

## 6. Priority and order

| # | Item | Severity | Effort | Depends on |
| --- | --- | --- | --- | --- |
| 1 | §4 stage 1 — live verification of the OpenCode gate | P0 (blocks §4) | 30 min | — |
| 2 | F-1/F-2 tool-schema bounds + name rules at ingress | P0 | half day | — |
| 3 | F-4 sampling range validation | P1 | 2 h | — |
| 4 | F-3 tool_choice capability + quirk strip | P1 | half day | — |
| 5 | §4 stage 2 — OpenCode removal behind the kill-switch | P0/P1 | half day | item 1 |
| 6 | F-10 surface-native error parity tests | P2 | 2 h | — |
| 7 | F-5 Responses store/stateless contract + guard | P1 | half day | — |
| 8 | F-7/F-8 OMP parity tests | P2 | 2 h | — |
| 9 | F-6 tool-result truncation (env-gated, off) | P2 | 2 h | — |
| 10 | F-9 ambiguity metric, F-11 doc note | P2 | 1 h | — |

Everything lands on `dev` with its own commit and its own tests; nothing here
changes the canonical model or the architecture.
