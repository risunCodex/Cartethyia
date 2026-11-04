# Known Issues

A list of known issues, their root causes, and workarounds/solutions.
Each entry is written from a real case; keep it until the issue is truly gone
from the field.

---

## 1. Empty tool-call arguments (`{}`) on Qoder — RESOLVED (adapter bug, not upstream)

**Was:** intermittent empty `input: {}` on the Anthropic wire for Qoder models
(`Invalid arguments for tool "shell": command: Missing key`), originally
misattributed to upstream/model behavior.

**Real root causes — all fixed in the gateway (2026-11-03/04):**
- Free-tier account routing landed on an exhausted/free account (quota 0),
  which emitted empty arguments on every slot.
- Empty `id: ""` continuation fragments were treated as a fresh call id, so
  argument fragments were orphaned (fixed in `qoder.ts`).
- Billed gRPC path: the request never sent `tools`; response
  `delta.tool_calls` arrived Struct-wrapped and was dropped; a `tool_use`
  finish counted as failed → retry/reset (fixed in `qoder-grpc.ts`).

**Status: RESOLVED.** Live-verified end-to-end — tool calls stream with full
arguments, no retry, no reset. The workaround (routing to "populated" slots /
`openai-compatible`) is no longer needed. Evidence:
`documentation/research/qoder/2026-11-03-qoder-tool-call-investigation.md`,
`documentation/research/qoder/2026-11-04-qoder-grpc-tools.md`,
`documentation/research/qoder/2026-11-04-qoder-wire-delta-audit.md`.

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

**Verification update (2026-11-02).** Re-tested the Responses surface with the
`aisdk:@ai-sdk/openai` package against `cb/deepseek-v4.1-flash` on the local
gateway: a full 4-turn session (glob/read/write/shell, one session) completed
with no `Encrypted reasoning must remain a string artifact` error. The
intermittent quirk did not reproduce in this session; keep monitoring on longer
multi-turn flows.

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

## 5. 503 "dependencies are not ready" during a burst is really overload

**Symptom.** Under a sustained burst (e.g. 20+ concurrent requests), the gateway
starts answering every /v1/* and /console/api/* call with 503
"gateway's dependencies are not ready — Warming up". The database and Redis are
fine.

**Root cause.** The readiness guard probes dependencies on a 5-second memo TTL.
When the Postgres pool is exhausted (all backends checked out), the probe's
SELECT 1 waits for a backend and times out — so the memo records a
"not ready" result, and every request in the window is shed. That is a
capacity problem, not a dependency failure.

**Current behavior (after fix).** A probe that times out under load is now
surfaced as 503 overloaded ("The gateway is overloaded — retry shortly")
with a retry-after hint, distinct from a genuine dependency failure ("not
ready" is reserved for hard failures — connection refused, migrations missing).

**Workaround / tuning.** The gateway's Postgres pool size defaults to 16
(`DATABASE_POOL_MAX`, read in `src/persistence/db-pg.ts`). If bursts queue on
the pool, fix the consumer that holds connections (a query/SSE recompute)
before raising it — keep it comfortably below the server's
`max_connections` (default 100) so background sweeps and the console are never
starved. The production VPS instance uses the default (no env override).
