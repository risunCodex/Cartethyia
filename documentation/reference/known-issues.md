# Known Issues

A list of known issues, their root causes, and workarounds/solutions.
Each entry is written from a real case; keep it until the issue is truly gone
from the field.

---

## 1. Empty tool-call arguments (`{}`) on Anthropic wire via @ai-sdk/anthropic

**Symptom.** Clients using `@ai-sdk/anthropic` (e.g. opencode with provider
`CarteLocal` configured as `aisdk:@ai-sdk/anthropic`) sometimes receive a tool
call with an empty `input: {}` and reject it with `Invalid arguments for tool
"shell": command: Missing key` (or `Arguments provided: {}`). It is
**intermittent**: simple tools (`read`, `echo hi`) usually work; complex
commands or `edit` with a large payload sometimes fail.

**Not a gateway bug.** The Qoder wire is verified to send structured
`tool_calls` with full arguments (raw probes of `qfmodel`/`dfmodel` show a
complete `joinedArgs`, `leaked=false`). The `MessagesStreamEncoder` (Anthropic
Messages) is also correct and tested: arguments stream as `input_json_delta`,
zero-arg calls become `input: {}`. So the `{}` arriving at the client is
**model/upstream behavior** occasionally emitting a tool call without
arguments — not an adapter fault.

**Why only aisdk anthropic?** The Anthropic wire requires `tool_use.input` to
be an object; when the model sends no arguments, the aisdk client rejects a
tool that requires keys (`command`, `oldString`, etc.). The OpenAI-compatible
format is more tolerant of empty arguments, so the symptom does not appear
there. **This is not a Claude Code CLI issue** — Claude Code uses the same
Anthropic wire, but its parser/tolerance differs.

**Workaround (recommended).** Configure the opencode provider as
`@ai-sdk/openai-compatible`:

```jsonc
"CarteLocal": {
  "name": "CarteLocal",
  "package": "aisdk:@ai-sdk/openai-compatible",
  "settings": {
    "baseURL": "http://127.0.0.1:12800/v1",
    "apiKey": "pn-carte-..."
  }
}
```

Verified: read, shell (including complex commands with `&&`/pipes), and edit
all work with fully populated `input`.

**Status.** Upstream/model known issue; not a Cartethyia bug. Monitor: if the
model stops emitting `{}`, revisit the workaround.

---

## 2. Intermittent "Encrypted reasoning must remain a string artifact" on Responses surface

**Symptom.** With `CarteLocal` configured as `@opencode/ai/providers/openai/responses`,
opencode intermittently fails with `Error: Encrypted reasoning must remain a string
artifact`. It does not reproduce on every request — simple turns and multi-turn
tool flows usually pass.

**Not a gateway bug.** The gateway's Responses encoder only sets
`encrypted_content` when the upstream content part carries it; Qoder never
sends encrypted reasoning (its `reasoning_content` is a plain string, verified
in `readReasoningText`). Simple, tool, and multi-turn Responses flows all work.
The failure is intermittent and appears to be a client/opencode quirk with the
`openai/responses` package while handling reasoning artifacts.

**Workaround.** Use a non-Responses package: `@opencode/ai/providers/anthropic`
(SDK resmi, verified) or `@opencode/ai/providers/openai-compatible` (verified).

**Status.** opencode/client quirk; not a Cartethyia bug. Monitor: if it
persists on later opencode versions, revisit.

---

## 3. 60s hang on `/v1/messages` when upstream Qoder goes silent

_(Documented from an earlier investigation; full details to follow.)_

---

## 4. Codex "insufficient tool messages" after cancelled/compacted parallel tool calls

**Symptom.** Codex (wire `responses`, profile `carte-ds`/`carte-qwen`) runs
parallel tool calls, but on some continuations the next request fails with
`insufficient tool messages following tool_calls message`. Tool calls execute,
then the turn continuation errors.

**Root cause (fixed).** The gateway's `buildQoderRequest` only emits an
assistant `tool_calls` turn when every call on that turn has a matching result
somewhere in history (`everyCallHasResult`). When a parallel call is cancelled
or its result is lost to compaction, the assistant turn's calls are withheld —
but the matching `tool` result turn was still emitted on its own. That produces
an orphan `tool` turn with no preceding call, which upstream rejects with
"Messages with role 'tool' must be a response to a preceding message with
'tool_calls'" — the same failure the client surfaces as "insufficient tool
messages".

**Fix.** The assistant `tool_calls` emit and the `tool` result turns now share
one source of truth (`emittableCallIds`). A result whose call is not on the
wire has its `tool` turn dropped too, so the transcript is always consistent:
no `tool` turn ever appears without a preceding assistant `tool_calls` turn.
Regression covered by `qoder-intl-tool-history.test.ts` ("a cancelled parallel
call drops its orphan tool turn with the assistant calls").

**Status.** Fixed in `main` (uncommitted changes at the time of writing).
Monitor Codex continuation flows to confirm the intermittent error is gone in
the field.

---

## 4. 503 "dependencies are not ready" during a burst is really overload

**Symptom.** Under a sustained burst (e.g. 20+ concurrent requests), the gateway
starts answering every /v1/* and /console/api/* call with 503
"gateway's dependencies are not ready � Warming up". The database and Redis are
fine.

**Root cause.** The readiness guard probes dependencies on a 5-second memo TTL.
When the Postgres pool is exhausted (all backends checked out), the probe's
SELECT 1 waits for a backend and times out � so the memo records a
"not ready" result, and every request in the window is shed. That is a
capacity problem, not a dependency failure.

**Current behavior (after fix).** A probe that times out under load is now
surfaced as 503 overloaded ("The gateway is overloaded � retry shortly")
with a retry-after hint, distinct from a genuine dependency failure ("not
ready" is reserved for hard failures � connection refused, migrations missing).

**Workaround / tuning.** The gateway's Postgres pool size defaults to 16
(`DATABASE_POOL_MAX`, read in `src/persistence/db-pg.ts`). If bursts queue on
the pool, fix the consumer that holds connections (a query/SSE recompute)
before raising it — keep it comfortably below the server's
`max_connections` (default 100) so background sweeps and the console are never
starved. The production VPS instance uses the default (no env override).
