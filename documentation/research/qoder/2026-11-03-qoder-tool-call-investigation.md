# Qoder tool-call investigation — full postmortem (2026-11-03)

Investigation report for the Qoder tool-calling defects seen through the local
Cartethyia gateway (`CarteLocal` at `127.0.0.1:12800`). This document is the
single source of truth for the symptoms, hypotheses, evidence, root causes,
fixes, and verification of the 2026-11-03 session.

## TL;DR

Two independent defects caused Qoder tool calls to appear broken:

1. **Empty `arguments: ""` on some roster slots.** The upstream *does* send
   populated arguments; the gateway's SSE translator orphaned every argument
   fragment because continuation chunks echo `id: ""` (empty string), which
   was treated as a fresh call id instead of "no id". Fixed in `qoder.ts`:
   an empty `id` behaves like a missing one, so fragments re-join the pinned
   first-seen id per wire index.
2. **Streams appeared to "finish suddenly".** The empty-stream recovery
   (`fetchQoderIdeWithEmptyRecovery`) drained the *entire* upstream body before
   forwarding it, so every stream (Qwen and DeepSeek alike) arrived in one
   burst at the end. Replaced with `sniffQoderStream`: peek only the first
   chunks (≤ 64 KiB) to decide meaningful-ness, then forward the rest
   progressively.

Additional environment factor: the gateway only routed to the single active
account **Sunny Koding** (free tier, quota 0), which emits empty arguments on
every slot. Enabling the add-on account **Akun Ytprem** (100 credits) and
disabling the free account made the route deterministic.

## Symptoms

- `tool_calls` emitted with `arguments: ""` (empty) for some Qoder roster
  slots, with correct `finish_reason: tool_calls` and tool name.
- A DSML/leak text block occasionally appeared as visible content (earlier in
  the session; protocol-level fix, see commits).
- Streamed responses did not stream: all chunks arrived at once, after a long
  silence, then `[DONE]`.

## Environment & setup

- Gateway: Cartethyia dev (`bun run dev`), public `:12800` reverse proxy →
  backend `:12801`.
- Provider adapter: `src/providers/integrations/qoder/qoder.ts` — **IDE-first**
  (`surface === "ide"` → `/model/v1/chat/completions` on `api2-v2.qoder.sh`),
  COSY legacy fallback only on HTTP 402 + free-tier model.
- Qoder accounts in `provider_accounts`:
  - **Sunny Koding** — free tier (`PLAN_TIER_FREE`, quota 0), was the only
    active account; emits empty args on every slot.
  - **Akun Ytprem** (`7f9d9d0c-dbe6-4ee5-99f2-ec2457c568b5`) — add-on 100
    credits, was `disabled`; OAuth token `dt-…` (decrypted DB credential is
    byte-identical to the exported account file).
  - anjir baru, pleged lenger — disabled.
- Roster slots (virtual id → key): `qwen3.7-max`→`qmodel_latest`,
  `qwen3.7-plus`→`qmodel`, `qwen3.8-max`→`qmodel_38max`,
  `qwen3.8-flash`→`qfmodel`, `deepseek-v4.1-flash`→`dfmodel`,
  `lite-qwen-3.7-plus`→`lite`.

## Investigation timeline

### 1. Slot matrix (original)

Controlled battery against the gateway (one `bash` function tool, stream +
non-stream, 4 trials, `tool_choice`/`parameters`/`strict` variants):

| Slot | Arguments before fixes |
| --- | --- |
| `dfmodel` (`deepseek-v4.1-flash`) | ✅ populated |
| `lite` (`lite-qwen-3.7-plus`) | ✅ populated |
| `qmodel` (`qwen3.7-plus`) | ✅ populated |
| `qmodel_38max` (`qwen3.8-max`) | ✅ populated |
| `qfmodel` (`qwen3.8-flash`) | ❌ always `""` |
| `qmodel_latest` (`qwen3.7-max`) | ❌ always `""` |

The empty slots were initially misattributed to upstream behavior. Full matrix:
`2026-11-03-qoder-tool-call-matrix.md`.

### 2. IDE vs COSY surface comparison

Imported the **real 9router COSY signer**
(`Public/9router/open-sse/shared/qoder/cosy.js`, `encoding.js`, `constants.js`)
into `compare-ide-cosy2.mjs`. Findings:

- IDE surface (`api2-v2/model/v1`) with roster key `qmodel_latest` + `dt-*`
  → arguments **populated** (3/3 in the harness's first run; flaky parallel
  calls occasionally truncate).
- COSY legacy (`api3…/agent_chat_generation`) hangs/terminates from this host
  (connection not established); could not be verified here.
- The adapter is IDE-first; `endpoint_path` in the DB does not start with
  `http`, so `qoderIdeChatUrl(this.realm)` wins → `api2-v2` (IDE). The gateway
  takes the IDE path, not COSY.

### 3. Account routing diagnosis

- `provider_routing_settings` for `qoder`: `round_robin`, `rotate_count: 2`.
- Only **Sunny Koding** was `active`; the three add-on accounts were
  `disabled`, so every request landed on the free account → empty args
  everywhere.
- Enabled **Akun Ytprem** (literal SQL — `bun:sqlite` bound-parameter queries
  with `?` returned 0 rows / `undefined` for `provider_id='qoder'` and
  `id=?`; literal interpolation is required in scratch scripts).
- After enabling, `qwen3.8-max` and `deepseek-v4.1-flash` populated 3/3, but
  `qwen3.8-flash` and `qwen3.7-max` still empty.

### 4. Direct upstream ground truth

Direct IDE request (same `dt-*`, same body shape, `tool_choice: "required"`):

- `qfmodel` → **3/3 OK** (arguments `{"command": "echo hello"}`).
- `qmodel_latest` → 2/2 OK (one truncated parallel call counted as BAD).

Conclusion: the upstream **does** populate arguments on these slots. The empty
args are a gateway/adapter artifact.

### 5. Raw stream capture — root cause #1

Captured the upstream SSE for `qfmodel` (direct, decrypted DB token, adapter
shaped body):

```
frame 1: { tool_calls: [{ function: { arguments: "", name: "bash" }, id: "call_7b572c5c…", index: 0 }] }
frame 2: { tool_calls: [{ function: { arguments: "{\"command\": " }, id: "", index: 0 }] }
frame 3: { tool_calls: [{ function: { arguments: "\"echo hello" }, id: "", index: 0 }] }
…        (fragments until `}`)
```

The first chunk carries the real id; **every continuation chunk echoes
`id: ""`**. In `qoderBodyToCanonicalEvents`, `declaredId` was defined as
"`typeof id === 'string'`", so `""` counted as a declared id. Every fragment
was buffered under the call id `""`, separate from the real call
(`call_7b572c5c…`). At flush time the real call had `arguments: ""` and the
fragments under `""` were lost.

### 6. Streaming timeline — root cause #2

`capture-stream-timeline.mjs` recorded per-event arrival times through the
gateway:

```
Before fix (qwen3.8-flash): all 12 events at t=994ms, gap 0
Before fix (deepseek-v4.1-flash): all 15 events at t=1109ms, gap 0
Direct upstream (qfmodel): reasoning deltas 17–76ms apart, tool fragments ~30ms apart
```

Root cause: `fetchQoderIdeWithEmptyRecovery` called `drainQoderResponse`,
which reads the **entire** body before constructing a new `Response`, so the
canonical parser only ever saw the fully-buffered stream.

## Fixes

### Fix #1 — empty call-id fragments (src/providers/integrations/qoder/qoder.ts)

```ts
// `id` is only meaningful when non-empty: some Qoder slots echo
// `id: ""` on continuation chunks, and treating that as a fresh
// call id would orphan every argument fragment (the real call
// keeps its first-seen id, the fragments pile up under "").
const declaredId =
  typeof tc["id"] === "string" && (tc["id"] as string).length > 0
    ? (tc["id"] as string)
    : undefined;
```

Continuation fragments now fall through to the existing `index`-pinned id
mapping (or `lastSeenToolId`), so fragments rejoin the correct call.

### Fix #2 — progressive streaming (src/providers/integrations/qoder/qoder.ts)

- Replaced `drainQoderResponse` / `QoderStreamDrain` with `sniffQoderStream`:
  reads up to 32 chunks (or 64 KiB) of the body, decides `meaningful` by
  looking only for `"content":"` or `"tool_calls"` in peeked SSE frames
  (reasoning-only is NOT meaningful — empty-stream recovery must still replay),
  then returns a replay `ReadableStream` that re-emits the read bytes and
  continues the original body.
- `fetchQoderIdeWithEmptyRecovery` now returns the sniffed response
  immediately when meaningful; replay-only streams still retry up to
  `maxReplays`.

### Environment fix — account routing (database, not code)

- Enabled `Akun Ytprem`; disabled `Sunny Koding` so round-robin cannot land on
  the free account. Qoder now routes to Ytprem only.

## Verification

| Check | Result |
| --- | --- |
| `qoder/qwen3.8-flash` via gateway | ok=3/3 (was empty=3) |
| `qoder/qwen3.7-max` via gateway | ok=3/3 (was empty=2/noCall=1) |
| `qoder/qwen3.8-max` via gateway | ok=2/2, re-verified 3/3 |
| `qoder/deepseek-v4.1-flash` via gateway | ok=3/3 |
| opencode E2E `CarteLocal/qoder/qwen3.8-max` | tool `shell` ran, output `hello` |
| opencode E2E `CarteLocal/qoder/qwen3.8-flash` | tool ran, output `hello` |
| Streaming: `qwen3.8-flash` reasoning | 17–76ms gaps (was all at t=994ms) |
| Streaming: `deepseek-v4.1-flash` | single late burst — upstream behavior (DeepSeek emits reasoning in one chunk) |
| `bunx tsc --noEmit` | clean |
| `bun test test/providers/integrations/` | 124 pass, 2 skip, 0 fail |
| `qoder-continuation-args.test.ts` | 8/8 (added 2 regression tests for empty-id fragments) |
| `qoder-empty-stream-recovery.test.ts` | 3/3 |

## Changed files

- `src/providers/integrations/qoder/qoder.ts` — Fix #1 (empty id), Fix #2
  (sniff + progressive stream, removed drain code).
- `test/providers/integrations/qoder-continuation-args.test.ts` — regression
  tests: empty-id continuation rejoin; parallel calls with empty-id
  continuations keep distinct identities.
- `documentation/reference/known-issues.md` — issue #1 updated with account
  routing + empty-id root cause + streaming fix.
- `documentation/research/qoder/2026-11-03-qoder-tool-call-matrix.md` —
  matrix updated to populated; notes for root causes.

## Decisions

- **Sunny Koding stays disabled** (free tier → empty args). Qoder routes only
  to Ytprem. If Sunny is ever re-enabled, round-robin may land on it and the
  empty-args symptom returns for that request.
- COSY legacy surface remains unverified from this host (api3 connection
  hangs); the adapter does not use it for the tested accounts (IDE is
  default).

## Operational notes

- `bun:sqlite` bound-parameter queries (`?` placeholders) returned 0 rows for
  these tables when the parameter was a UUID / `provider_id` — use literal SQL
  interpolation in scratch/DB scripts.
- The IDE surface's parallel tool calls occasionally truncate a JSON fragment
  mid-call (BAD); single-call requests are stable.
- Qoder response `model` echo is the roster key (`qfmodel`, `qmodel_latest`,
  …), not the virtual id.
