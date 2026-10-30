> # ARCHIVED — UNTRUSTED
>
> This file was archived on 2026-10-28. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. The live reference for the OpenCode free tier lives at
> `.skills/cartethyia-trace-replay/references/opencode-free-tier.md`.

# OpenCode free-tier wire

How Cartethyia talks to OpenCode's anonymous free tier: the endpoint shape,
the client fingerprint, the exact system prompt, the tool set, and how the
behavior was reverse-engineered. This consolidates the earlier research notes
into one current reference.

## What the free tier is

OpenCode serves a free model set anonymously. The gateway impersonates the
official CLI transport well enough that the upstream gate accepts the request:

- **Anonymous credential** — a sentinel, not a secret: the literal token
  `public` (`Authorization: Bearer public`), case-sensitive.
- **Streaming only** — `stream: false` is refused with `403 FreeTierError`.
- **Agent-shaped tools** — the request must carry the official agent tool set
  (13 definitions, verbatim descriptions/schemas).
- **A valid CLI-ish session** — `ses_` ids with a plausible inverted
  millisecond timestamp and counter 1–63.

## Endpoints (v2 family segment)

Free and Zen dispatch on the `/inference` origin using the 2.1 family-segment
paths, **not** the flat legacy shapes:

| Wire | Path |
| --- | --- |
| Chat | `/inference/openai/v1/chat/completions` |
| Responses | `/inference/openai/v1/responses` |
| Anthropic | `/inference/anthropic/v1/messages?beta=true` |
| System One | `/inference/v1/systemone` (flat — System One takes no family segment) |

Catalog listing stays on `/zen/v1/models`; `/inference/v1/models` answers 404.

## Request headers

| Header | Value |
| --- | --- |
| `authorization` | `Bearer public` (free model) |
| `accept` | `application/json, text/event-stream` |
| `content-type` | `application/json` |
| `x-opencode-client` | `cli` |
| `x-opencode-session` | root session (`ses_…`) |
| `x-opencode-session-id` | child session (client's own, else root) |
| `x-session-affinity`, `x-session-id` | root session |
| `x-opencode-project` | 40-hex project id |
| `user-agent` | `opencode/latest/<version>/cli` (live from the npm feed; fallback `2.1.1`) |
| `traceparent` / `b3` | W3C / zipkin trace ids |

`x-opencode-request` is deliberately **not** sent (refuses with 403).

## Body shape

```json
{
  "model": "big-pickle",
  "messages": [
    { "role": "system", "content": "You are an interactive coding agent that helps users with software engineering tasks.\n<env>  Working directory: /workspace</env>" },
    { "role": "user", "content": [{ "type": "text", "text": "Reply with OK." }] }
  ],
  "tools": [ { "type": "function", "function": { "name": "edit", "description": "…", "parameters": {…}, "strict": false } }, /* 13 tools */ ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_completion_tokens": <model output ceiling or 32000>
}
```

- **System prompt is minimal**: the gate only requires the `<env>` block with a
  `Working directory:` line — the value itself can be a placeholder. Measured
  floor: `<env>Working directory:</env>` (29 chars) and
  `<env>Working directory:x</env>` (30 chars) pass; shorter or altered forms
  (`Working dir:`, `Working:`, `working directory:`, `Workingdirectory:`,
  `<env>x</env>`) are refused across all tested egresses. The shipped prompt
  is the marker line plus the env block (~183 chars). No model identity, no
  skills, no style rules — the model must not claim an OpenCode identity.
- **Tools**: 13 agent definitions (`edit`, `execute`, `glob`, `grep`,
  `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`,
  `websearch`, `write`, `patch`), captured verbatim from the official client.
- **Completion ceiling**: the model's own `output_limit` wins; fallback is
  32000.

## Gate behavior observed

| Case | Result |
| --- | --- |
| Missing/partial tool set | 403 `FreeTierError` |
| `stream: false` | 403 `FreeTierError` |
| Non-canonical session id | 403 `FreeTierError` |
| `x-opencode-request` sent | 403 `FreeTierError` |
| System content without `<env>` + `Working directory:` | 429 `FreeUsageLimitError` |
| Per-egress usage window exhausted | 429 `FreeUsageLimitError` (transient, resets on the upstream's schedule) |
| All requirements met | 200 |

The 429 is a **usage-limit signal, not a payload rejection**: the same bytes
succeed from another egress. Treat it per-pool, never as a code bug.

## How it was reverse-engineered

1. **Donor diff** — compare against the Go reference gateway: endpoints,
   headers, tool assets, prompt text, session derivation.
2. **Raw probes without the gateway** — Bun native `fetch` with the `proxy`
   option, exact adapter shapes, no gateway layers in between.
3. **Multi-egress sweeps** — the same payload across 40 proxies isolates
   per-IP limit noise from real gate refusals (a 429 on one proxy means
   nothing; 0/4 across four proxies means a shape problem).
4. **Gateway vs raw diff** — telemetry (`networkPoolId`) showed the gateway
   *selected* a pool but, after the native-fetch refactor, never actually
   dialed through it: the proxy URL was not forwarded. Fixed by carrying
   `proxyUrl` on the pool agent and passing it to `fetch`.
5. **Prompt trimming** — binary-search the system content: full prompt, base
   without env, env-only, `<env>` + `Working directory:`, `<env>` alone,
   marker alone, empty. Only the `<env>` + `Working directory:` combination
   passed consistently.
6. **Version probe** — user agent 2.1.1 / 2.2.0 / 2.2.1 / 2.3.0 all behave
   identically; the gate does not pin the version, so the live feed is safe.
7. **Live verification** — the model below was exercised through the shipped
   code path (raw, via proxy) with the minimal prompt.

## Current verification

`big-pickle`, raw dispatch via an example HTTP proxy (`http://pool.example:8080`),
minimal prompt, 13 tools, 32000 ceiling:

```
status 200
data: {"id":"mai-api-…","object":"chat.completion.chunk","model":"big-pickle",…}
```

## Measured limits (research)

How many consecutive hits a fresh egress tolerates before `429 FreeUsageLimitError`
appears — measured 2026-10-28 with this exact payload:

- **System prompt:** `<env>Working directory:x</env>` (30 chars)
- **Tools:** the 13 verbatim agent definitions (see `tool-definitions.ts`)
- **Body:** `stream: true`, `stream_options.include_usage: true`,
  `max_completion_tokens: 32000`, `Authorization: Bearer public`
- **Protocol:** sequential hits, ~400 ms apart, stop after 3× 429 in a row

| Model | Fresh egress | OK hits before 429 |
| --- | --- | --- |
| `mimo-v2.6-flash-free` | `egress-a` | 38 |
| `glm-5.3-flash-free` | `egress-b` | 40 |
| `deepseek-v4.1-flash-free` | `egress-c` | 39 |
| `beam-free` | `egress-d` | 40 |

A second fresh batch measured the same 4 models with a **100K-character system
prompt** (gate-required `<env>` kept at the end):

| Model | Fresh egress | OK hits before 429 |
| --- | --- | --- |
| `mimo-v2.6-flash-free` | `egress-e` | 39 |
| `glm-5.3-flash-free` | `egress-f` | 38 |
| `deepseek-v4.1-flash-free` | `egress-g` | 38 |
| `beam-free` | `egress-h` | 37 |

**The limit is by request count, not by tokens:** expanding the prompt from
30 to 100K characters did not change the ceiling. Observed ceiling is **40
hits** (range 37–40) per (model, egress) on a fresh egress — never more.
Egresses that already carried traffic measured lower (≈15–19), so 40 is the
clean maximum with a rolling window, not a hard guarantee across reused
egresses. The 429 is transient and clears on the upstream's own schedule.

## Why native egress matters — the TLS fingerprint

The gate does not only read headers. The official OpenCode clients run on Bun,
and their TLS ClientHello is part of the transport fingerprint. The reference
gateway went to the trouble of replaying Bun's hello with
uTLS in Go; we are on Bun, so `fetch()` already emits the exact hello:

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

## The gate is egress-keyed, not header-keyed

On 2026-10-16 the deployed gateway got 403s from a datacenter egress. Every
permutation of the client fingerprint (`cli`/`desktop` marker, user-agent
1.18–2.0.32, with/without headers) still produced 403, including the official
CLI after a successful OAuth login. The **same byte-identical request** then
returned 200 through an HTTP proxy with exit IP `203.0.113.10`:

```
big-pickle /inference/v1/chat/completions   200  (8.1 s)
big-pickle /zen/v1/chat/completions         200  (8.1 s, legacy shape)
```

Conclusions that came out of that:

- The gate is keyed on the **egress IP**, not on the client fingerprint. The
  client version and the `cli`/`desktop` marker are not checked.
- `Bearer public`, the agent tool set, and `stream: true` are required.
- A `410 ModelDeprecated` is **not** evidence the gate passed — model lookup
  runs before the gate; only a 200 proves it.
- A datacenter egress (Railway and similar) is blocked outright — opencode
  needs an egress proxy, which is why pools matter.

## Reference comparison highlights (Go reference)

| Aspect | Ours | Reference |
| --- | --- | --- |
| Anonymous credential | `Bearer public` | `Bearer public` |
| `x-opencode-client` | `cli` | `cli` |
| Session shape / counter window | `ses_` 12 hex + 14 base62, counter 1–63 | same |
| `x-opencode-project` | bare 40-hex | same |
| Tool definitions | 13 verbatim | 12 embedded (5 core enforced) |
| `stream: true` forced | yes | yes |
| `x-opencode-request` | never sent (v2 rejects it) | never on v2 lane |
| `Accept` | `application/json, text/event-stream` | same |
| Session derivation | time-bucketed (cache affinity) | hash-based (multi-key isolation) |
| Free-model rule | `-free` suffix + known/block lists | name contains "free" or zero cost |
| Fallback lane | `/inference` only | `/zen` v1 first, then `/inference` |

Already shipped from that comparison: the Go-plan quota collector
(`opencode-go-quota.ts`), the `Accept` value, and the refused-model override
`CARTETHYIA_OPENCODE_UNAVAILABLE_FREE`. The `/zen` v1 fallback was declined:
it would need a second client identity, and our own measurements record that
lane answering 429.

## Quick raw replay

The shortest path to a real `200` is an executable script inside the repo —
no copying of the 13 tool definitions by hand, the module builds them from the
same source the gateway uses.

Save as `opencode-replay.ts` at the repository root and run
`bun opencode-replay.ts` (edit `PROXY` and `MODEL` first):

```ts
import { opencodeSystemPrompt } from "./src/providers/integrations/opencode/prompt.ts";
import { buildOpenCodeHeaders } from "./src/providers/integrations/opencode/fingerprint.ts";
import { OPENCODE_TOOL_DEFINITIONS } from "./src/providers/integrations/opencode/tool-definitions.ts";

const MODEL = "big-pickle";
const PROXY = "http://pool.example:8080"; // an HTTP CONNECT proxy

const tools = Object.entries(OPENCODE_TOOL_DEFINITIONS).map(([name, def]) => ({
  type: "function",
  function: { name, description: def.description, parameters: def.parameters, strict: false },
}));

const body = JSON.stringify({
  model: MODEL,
  messages: [
    { role: "system", content: opencodeSystemPrompt() },
    { role: "user", content: [{ type: "text", text: "Reply with OK." }] },
  ],
  tools,
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 32000,
});

const res = await fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
  method: "POST",
  proxy: PROXY,
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer public",
    ...buildOpenCodeHeaders(),
  },
  body,
});

console.log(res.status, (await res.text()).slice(0, 300));
```

A raw `curl` works too, but the `tools` array must carry the 13 verbatim
definitions — a stubbed version will be refused with 403 `FreeTierError`.

## Owning code

| Concern | File |
| --- | --- |
| System prompt assembly / injection | `src/providers/integrations/opencode/prompt.ts` |
| Client fingerprint, session/project ids, version | `src/providers/integrations/opencode/fingerprint.ts` |
| Free-tier detection, endpoint paths, body shaping, ceiling | `src/providers/integrations/opencode/provider.ts` |
| Tool definitions | `src/providers/integrations/opencode/tool-definitions.ts` |
| Native egress with proxy forwarding | `src/network/outbound-fetch.ts`, `src/network/pool/agent.ts` |
| Probe wiring (output ceiling) | `src/providers/discovery/probe-phases.ts`, `probing-service.ts` |
