# OpenCode free tier — wire, gate, and sentinel

Measured across 2026-10-14 → 2026-11-02. This is the consolidated research
reference for the OpenCode free tier: the exact wire our adapter/probe sends,
the gate's shape requirements and refusals, the verdict on anonymous auth, and
the evidence (capture, replay, live 200).

Measurements below are dated upstream observations, not a permanent contract;
revalidate before changing current behavior.

## Executive summary

- **The adapter/probe wire is not "wrong-shaped".** Every element the gate
  reads — 11 verbatim tools, `strict:false`, `stream:true`, session/project
  fingerprint, agent-shaped system prompt, 2.x key order — matches the real
  CLI wire.
- **The 429 we saw was not a wire refusal** — it was `FreeUsageLimitError`
  (account/IP quota state). Evidence: replaying the captured CLI flow verbatim
  (with the real account token) also 429s while the quota is exhausted, then
  returns **200** once it recovers; replaying with no `Authorization` at all
  also returns 200 on a healthy IP/quota.
- So "what gets refused" is not *what we send* but *quota state*. The only
  pure-wire refusals ever measured happen when we **alter** the shape below
  (tools/session/stream), not when we send it as-is.

---

## 1. What the probe/adapter sends (opencode free tier)

Source: `buildProviderProbeRequest("opencode")` (probe) — same structure as a
dispatch from `src/providers/integrations/opencode/provider.ts`.

### Headers

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-opencode-client` | `cli` |
| `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` | `ses_` + 12 hex + 14 base62 (counter 1–63) |
| `x-opencode-project` | 40 hex (hash) |
| `user-agent` | `opencode/latest/2.2.5/cli` |
| `traceparent` / `b3` | generated |
| `accept` | `application/json, text/event-stream` (free tier) |
| `authorization` | **not sent** (free tier) |

### Body (chat)

- Key order: `model, messages, tools, stream, stream_options, max_completion_tokens`
- `model`: free id (probe uses `big-pickle`)
- `messages`: 2 — `system` (agent prompt, see §3) + `user`
- `tools`: **11** verbatim tools (see §2), each
  `{type:"function", function:{name, description, parameters, strict:false}}`
- `stream: true` (free tier required; `false` → 403 `FreeTierError`)
- `stream_options: {include_usage: true}`
- `max_completion_tokens`: 32000 (v2 ceiling)

## 2. Tools (11, verbatim from the 2.2.0 capture, flow 4)

```
edit, glob, grep, read, shell, skill, subagent, webfetch, websearch, write, execute
```

- All 11 are **full definitions**, not just names: the gate compares a
  recognised tool's definition (description + schema), and a stub carrying only
  the name is refused (403).
- Each tool carries `strict: false`.
- This is exactly the tool set the real CLI sends (flow 4: 11, same order).
- The gate reads the tool set (not a single name): a 5-tool subset
  (`bash, edit, glob, grep, read`) → 403; the full set → 200.

## 3. System prompt

- **Present, and must look agent-shaped.** The gate reads presence/content, not
  a verbatim match.
- Adapter/probe send a coding-agent prompt (e.g. "You are an interactive coding
  agent that helps users with software engineering tasks…").
- The real CLI sends its own prompt (e.g. "You are an AI agent running in
  OpenCode…"). Different text; both accepted (200).

## 4. Probe/adapter vs real CLI capture (flow 4)

| Aspect | Probe/adapter | Real CLI capture (flow 4) | Effect |
|---|---|---|---|
| `authorization` | none | `Bearer st_…` (account token, redacted) | no effect — no auth also 200 |
| `user-agent` | `opencode/latest/2.2.5/cli` | `opencode/latest/2.2.0/cli` | no effect (range accepted) |
| `accept` | `application/json, text/event-stream` | `*/*` | no effect (SSE still) |
| `model` | `big-pickle` | `glm-5.3-flash-free` | different chosen id only |
| `messages` content | `hi` | `ping` + different system prompt text | no effect |
| HTTP-level headers | (fetch adds its own) | `connection`, `host`, `accept-encoding` | automatic, irrelevant |
| `tools` | 11, same order & definitions | 11, same | **identical** |
| body key order | same | same | **identical** |
| `stream` / `stream_options` | `true` / `include_usage` | `true` / `include_usage` | **identical** |

No single difference determines accept/refuse — both shapes reach 200 on a
healthy IP/quota.

---

## 5. The gate: shape requirements

Two classes can refuse a free-tier dispatch, and confusing them costs hours:

| Symptom | Cause | What to change |
|---|---|---|
| 403 `FreeTierError` from **every** header permutation, and the official client fails too | **Egress IP is blocked** | Nothing in the request. Change the egress IP. |
| 403 `FreeTierError` on one shape, 200 on another | Request shape (tools/stream/wire) | The request, per the rules below |

**The first check is: does the official client work from this host?**
Run `opencode run -m opencode/big-pickle "reply PONG"` with the real config
directory. If it also returns 403 `FreeTierError`, the block is at the IP
level for that tested path; further request-shape edits are not the next
experiment. Confirm with a controlled alternate egress before acting.
Confirmed 2026-10-17: the same byte-identical request returns **403 direct** and
**200 through a proxy** (exit `193.202.12.2`). Only the egress IP differed;
auth was never the variable.

Corollary for deployments: the observed datacenter egress was blocked. When
the same controlled test fails direct and succeeds through another exit,
changing `provider.ts` headers is not the remedy; use an authorized egress
path.

### Wire shape rules (observed 200 on 2026-10-17/18; revalidate)

- Dial the `/inference` origin with the **2.1 family-segment paths** (as
  shipped in `provider.ts`):
  - Chat: `https://opencode.ai/inference/openai/v1/chat/completions`
  - Responses: `https://opencode.ai/inference/openai/v1/responses` (free ids
    are chat-only, so this is informational)
  - Anthropic: `https://opencode.ai/inference/anthropic/v1/messages?beta=true`
  - System One: `https://opencode.ai/inference/v1/systemone` (flat — no
    family segment)
  The catalog stays on `/zen/v1/models`; `/inference/v1/models` answers 404.
- `stream: true` is required — `false` answers 403.
- **At least 3 tools.** The gate is a membership test, not an exact-match test:
  0/1/2 answer 403, 3 through 13 all answer 200. We send the full
  `FREE_AGENT_TOOL_NAMES` set from
  `src/providers/integrations/opencode/provider.ts` because the client does,
  not because the floor demands it.
- **`user-agent` must have a version segment**: `opencode/<channel>/<version>/cli`
  with the version ≥ **1.18.0**. Two segments (`opencode/latest/cli`) answers
  403; below the floor answers `426 UpgradeRequired`.
- **One affinity header carrying a well-formed `ses_` id** is required:
  `x-opencode-session`, `x-session-affinity`, or `x-session-id`. The id is
  `ses_` + 12 hex (counter **1–63**) + 14 base62. Counter 64 answers 403.
- `Authorization` is **not sent** on free dispatches (see §7).
- Everything else is optional: `x-opencode-client` (`cli` or `desktop`),
  `x-opencode-project` (40 hex, `global`, `prj_*`, or absent), `accept`,
  `content-type`, `traceparent`/`b3`.
- `x-opencode-request` is **not sent** — the current client no longer sends
  it and the v2 lane rejects it (403).
- The legacy lane `https://opencode.ai/zen/v1/chat/completions` answered **429
  `FreeUsageLimitError`** on 2026-10-18 — rate-limited, not refused. Treat it as
  a fallback whose quota is unknown, not as a dead lane.

Absent the fingerprint, a free-model request is refused:

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

HTTP **403**, `errorKind: authentication_failed`.

### Reading a non-403 answer

| Status | Meaning |
|---|---|
| **200** | The gate passed. This is the only proof. |
| `410 ModelDeprecated` | Model lookup failed **before** the gate. Says nothing about the gate. |
| `400 ModelProtocolUnsupported` | Gate passed; wrong wire. Free ids are chat-only. |
| `402 Insufficient account funds` | Gate passed; the bearer token is a real account. |
| `401 Missing API key` | No usable bearer at all. |

A `410` is **not** evidence the gate was passed — earlier notes in this repo
recorded it as such and sent an investigation down the wrong path.

### The trap: a clamp that keeps "used" tools drops the fingerprint

`ensureFreeAgentRequest` backfills missing fingerprint names, but
`clampOpenCodeTools` (cap `OPENCODE_MAX_TOOLS = 128`) runs on the payload and
keeps only tools referenced by the conversation. A client that arrives with its
own large catalog and references none of them gets **every fingerprint tool
trimmed away** — the backfill happened upstream of the clamp, so the wire ends
up with zero fingerprint tools and the dispatch 403s.

So the failure is not "the adapter forgot to add the fingerprint" — it added
them and then threw them away. Fixed 2026-10-16 by treating
`FREE_AGENT_TOOL_NAMES` as protected alongside called tools in the clamp.

**Any future trim/dedupe/filter over `payload.tools` must preserve that set.**
Regression test: `test/providers/opencode-tool-limit.test.ts`.

---

## 6. Replay evidence

The real session record is a Request Detail export whose
`payloads.providerRequest` is `{method, url, headers, body}` — replay that
verbatim, then A/B one field at a time.

| Arm | Result |
|---|---|
| 128 Claude Code tools, verbatim headers | 403 |
| + `authorization` | 403 |
| + `accept` | 403 |
| + auth + accept | 403 |
| fingerprint 11 only | **200** |
| 128 foreign tools + fingerprint 11 (139) | **200** |
| same request from a blocked IP | 403 |
| same request through a proxy | **200** |

The 11 fingerprint tools are accepted **alongside** the client's own tools — the
gate is a membership test, not an exact-match test.

Use `bun -e` with `fetch`, not `curl -o <file>`: on Windows the latter
intermittently returns exit 43 / HTTP 000 (schannel renegotiation) and looks
like an unreachable host.

Tooling: `scripts/provider-probing/opencode/replay-opencode.ts` replays a
captured flow verbatim (with the real `st_…` token) → **200**
`text/event-stream` for `glm-5.3-flash-free` (2026-11-02). Captured flow:
`D:\tmp\scratch\opencode-replay\flow4-chat.flow.json` + `flow4-req.json`
(65 KB; contains an account token — never commit it).

## 7. Anonymous `Bearer public` sentinel — verified live

Verdict: the free-tier gate accepts the anonymous `public` sentinel — and even
an absent `Authorization` — as long as the body/fingerprint is valid. The
sentinel is not a secret and does not need to be replaced with an account
token. The adapter sends no `Authorization` at all on free dispatches (the
`ANONYMOUS_ZEN_BEARER` sentinel was removed 2026-11-02).

The live test — replaying the same captured free-tier chat flow (flow 4, real
2.2.0 CLI, model `glm-5.3-flash-free`) with three auth variants on
2026-11-02, all answered **200 `text/event-stream`**:

| Variant | Result |
|---|---|
| `Authorization: Bearer public` (the anonymous sentinel) | 200 SSE |
| no `Authorization` header at all | 200 SSE |
| `Authorization: Bearer st_…` (the real account token) | 200 SSE |

Interpretation: the free-tier gate does not require an `Authorization` header.
It reads the body/tool fingerprint and the session/project headers. A *wrong*
bearer (e.g. a malformed token) still answers 401, so the gate is not blind to
auth — it just does not demand one for the anonymous free tier.

## 8. What did not affect the observed result

Observed by replay, so check these only when current evidence points to them:

| Suspect | Verdict |
|---|---|
| Exact version in the `user-agent`, above 1.18.0 (… 99.99.99) | Indifferent. But the **segment must exist** and the floor is 1.18.0. |
| `x-opencode-client: cli` vs `desktop` | Both accepted. |
| Session id value, when the shape is right | Any `ses_` id with counter 1–63. |
| Extra tool definitions beyond the fingerprint | Allowed; the gate is membership, not equality. |
| Tool order | Irrelevant. |
| `authorization` | Not sent on free dispatches. Absent passes; *wrong* answers 401. |
| `x-opencode-request` | Never sent (v2 lane rejects it). |
| Prompt size, turn count, `system` turns, `temperature`, `top_p`, missing token cap | All 200. |
| The egress IP | **Decisive.** Check this first. |

## 9. Why native egress matters — the TLS fingerprint

The gate does not only read headers. The official OpenCode clients run on Bun,
and their TLS ClientHello is part of the transport fingerprint. The reference
gateway went to the trouble of replaying Bun's hello with uTLS in Go; we are
on Bun, so `fetch()` already emits the exact hello:

| | Node `node:https` | Bun `fetch()` | Reference target |
| --- | --- | --- | --- |
| Cipher count | 52 (OpenSSL order) | 17 | 17 |
| Extensions | 12 | 13 | 13 |
| Curves | mixed | `4588-29-23-24` | `4588-29-23-24` |
| ALPN | — | `http/1.1` only | `http/1.1` |

Keeping validated egress on Bun's own `fetch` matches the reference transport
exactly: the Node-stack dialer would send a 52-cipher OpenSSL hello, which the
reference gateway considered worth ~900 lines of uTLS to avoid — and we get
the matching hello for free because the runtime is Bun. Pool egress is
preserved by passing the pool's proxy URL to `fetch` (`proxy` option), and
Bun's hello survives an HTTP CONNECT tunnel unchanged (measured).

## 10. Measured free quota ceiling per egress

How many consecutive hits a fresh egress tolerates before `429 FreeUsageLimitError`
appears — measured 2026-10-28 with the exact free-tier payload (11-tool set,
`stream:true`, 32000 ceiling):

- **Protocol:** sequential hits, ~400 ms apart, stop after 3× 429 in a row.
- **Fresh egresses (4 models):** `mimo-v2.6-flash-free` 38, `glm-5.3-flash-free`
  40, `deepseek-v4.1-flash-free` 39, `beam-free` 40.
- **Second fresh batch, 100K-character system prompt** (gate-required agent
  shape kept): 39/38/38/37.
- **The limit is by request count, not by tokens:** expanding the prompt from
  ~30 to 100K characters did not change the ceiling.
- **Observed ceiling is 40 hits** (range 37–40) per (model, egress) on a fresh
  egress — never more. Egresses that already carried traffic measured lower
  (≈15–19), so 40 is the clean maximum with a rolling window, not a hard
  guarantee across reused egresses. The 429 is transient and clears on the
  upstream's own schedule.
- A 429 on one proxy means nothing; a shape problem shows as 403/refusals
  across many egresses. Sweep the same payload across multiple egresses to
  isolate per-IP quota noise from real gate refusals.

---

## See also

- [Desktop 2.2.5 binary evidence + replay](./2026-11-02-desktop-2.2.5-binary-evidence.md)
  — binary unpack trail, live 2.2.0 CLI capture, constants, Grok bonus.
