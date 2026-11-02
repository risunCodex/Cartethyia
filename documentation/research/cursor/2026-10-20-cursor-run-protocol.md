# Cursor Run protocol — evidence ledger

This is a dated evidence ledger, not a guarantee of the current upstream
contract. Revalidate before using its model roster, entitlement, or client
version observations to change current behavior.

Build pinned: `CursorSetup-x64-3.24.18.exe` (installer inspected statically only;
never launched). Donor protocol source: `Public/cursor-opencode-provider`
v0.8.3. Wire client version observed live: `cli-2026.10.19-6bbf2c4`.

## Question

Why does a Cursor Run stream open (HTTP 200) and then produce nothing?

## Observed flow

1. `GetServerConfig` → agent origin (`https://agentn.global.api5.cursor.sh`,
   region `ap-southeast-1`).
2. `POST /agent.v1.AgentService/Run` over validated HTTP/2, `endStream: false`,
   `application/connect+proto`, gzip-capable.
3. Response: frame 1 = heartbeat. Frame 2 = the answer, and **Cursor sets
   `END_STREAM` on it**.

## Proven

| Finding | Evidence |
|---|---|
| `END_STREAM` marks the response end, not a payload boundary | Live dump: frame#2 `flags=3` (GZIP\|END_STREAM), 1391 B, contained the answer. `decodeServerMessages` returned before decoding it, so every response was dropped. |
| A refusal is a Connect **JSON** error envelope inside a 200 stream | `{"error":{"code":"resource_exhausted", ... "debug":{"error":"ERROR_RATE_LIMITED_CHANGEABLE"}}}`. Not protobuf, not a trailer. |
| Client heartbeat cadence is 5s | Donor `session.ts` `heartbeatMs: 5_000`. `RUN_HEARTBEAT_INTERVAL_MS = 20_000` in our tree was declared and never used. |
| A Run still owing an unanswered tool call is *held* | `#startRun`/`#continueRun` `finally` used to terminate it; the continuation leg then resolved no call. |
| A tool probe needs `continuation_scope` | Without it the adapter rejects the call as "tool call is not answerable". |

## Entitlement, not request shape

`resource_exhausted` / *"Named models unavailable"* is returned for **every**
named model — `grok-4.6`, `grok-4.7`, `claude-opus-4-8`, `claude-haiku-4-5` —
across all declared variants, with and without `parameters`, with and without
`max_mode`. Only `default` (Auto) serves.

Swept with `scripts/tools/probe-cursor.ts` (the `--params`/`--max-mode`
flags and a temporary variant sweep). Identical refusal on ~9 combinations per
model means no parameter, variant, or flag fixes it: it is the account's plan.

Distinct refusal seen earlier: `ERROR_RATE_LIMITED_CHANGEABLE`
"You've hit your free requests limit" — usage exhausted, retryable next cycle
(reset 11/10/2026), also `resource_exhausted`.

## Model ids

- `default` is the Auto model. `auto` is our alias, mapped at dispatch.
- Named models are used verbatim. `grok-4.6` used to be rewritten to
  `cursor-grok-4.6`, which answered *"AI Model Not Found"* — wrong; removed.
- Donor README documents `grok-4.7-500k` / `grok-4.7-500k-fast` as max-mode
  variants; `maxContext` is 256k in this account's roster.

## Still unknown

- Whether a paid plan serves named models through this same request shape
  (unverified; only the free-plan account was available).
- Image **URL** fetch (HTTPS) — unit-tested, not hit live. Only data-URL input
  was proven live.
