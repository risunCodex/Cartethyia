# Puter free DeepSeek API — wire and limits (2026-11-18)

Evidence ledger for probing Puter's "free, unlimited DeepSeek API"
(https://developer.puter.com/tutorials/free-unlimited-deepseek-api/).
The tutorial covers the browser SDK only; this file records the server-side
HTTP wire reconstructed from the shipped SDK and verified live.

## Sources

| Source | How obtained |
| --- | --- |
| `https://js.puter.com/v2/` (666 KB) | string-scanned for transport, driver RPC body shape |
| `@heyputer/puter.js` 2.6.5 (npm src) | `Auth.js` sign-in/token flow, `/metering/usage` |
| `https://gui-cdn.puter.com/bundle.min.js` (3.3 MB) | GUI init flags (`disable_temp_users`), endpoints |
| Live probes | account session from the operator's `puter_auth_token` cookie (Netscape export) — value never committed |

## Wire

- **Chat transport:** `POST https://api.puter.com/drivers/call` with body
  `{auth_token, interface: "puter-chat-completion", driver: "ai-chat",
  method: "complete", args: {model, messages, tools, tool_choice, max_tokens,
  ...}}`. A missing token answers `401 token_missing` even with
  `test_mode: true`. Streaming rides `application/x-ndjson`.
- **Model catalog (public, no auth):** `GET
  https://api.puter.com/puterai/chat/models/details` → 950 rows with `context`,
  `max_tokens`, `tool_call`, `modalities`, `costs`, `release_date`,
  `serviceSpeedVariants`. 53 rows are DeepSeek; `deepseek/deepseek-v4.1-flash`
  reports `context: 1_000_000`, `max_tokens: 393_216`, `tool_call: true`.
- **Usage/balance:** `GET https://api.puter.com/metering/usage` →
  `allowanceInfo {monthUsageAllowance, remaining, unit: "credits"}` plus
  per-model token/cost counters.
- **Auth:** headless JWT = the `puter_auth_token` cookie from a signed-in
  puter.com session. The SDK's own sign-in is a browser popup to
  `puter.com/action/sign-in` (that page ships
  `disable_temp_users: true`, so temp-user creation is closed on the main
  domain); `POST /auth/signup` does not exist. No public programmatic
  signup was found.

## Live results (deepseek/deepseek-v4.1-flash)

| Test | Result |
| --- | --- |
| Basic chat ("Reply with exactly: pong") | 200 `pong`, 1.06 s, `prompt 36 / completion 34`, `usd_cents 0.00516` |
| Tool calling (`get_weather`, `tool_choice: auto`) | 200 `finish_reason: tool_calls`, args `{"city":"Paris"}` |
| Input ≈ 164k tokens (512 KB unique lines) | 200 `OK`, 3.55 s, `prompt_tokens 163_834`, 4.92 ¢ |
| Input ≈ 230k tokens (720 KB; prompt 66_905 + cached 163_584) | 200 `OK`, 3.1 s, 6.92 ¢ |
| Input ≈ 330k tokens (1.02 MB) | **402 `insufficient credits`** (money gate, not a context error) |
| Input ≈ 645k tokens (2.0 MB) | **402 insufficient credits** |
| `test_mode: true` | does not bypass the 402 for this driver |

### Second account (fresh 1,000-credit allowance, same wire)

| Input | Result |
| --- | --- |
| ≈ 254k tokens (793,633 chars: `prompt 23_639 + cached 230_400`) | **200 `OK`, 3.17 s**, 7.62 ¢ / 457 credits → **256k confirmed** |
| ≈ 297k tokens (930,035 chars: `prompt 43_298 + cached 253_952`) | **200 `OK`, 6.20 s**, 8.92 ¢ / 535 credits → **~300k confirmed** |
| ≈ 380k+ tokens | not attempted: allowance exhausted (`7.45 / 1000` credits left) |

Measurement note: the filler ratio is ~3.1 chars/token for the numbered-line
corpus (a first pass assumed 4 and mislabeled sizes); "cached" counts are
reported separately from `prompt_tokens` by this upstream, so total processed
≈ `prompt_tokens + cached_tokens`.

## Limits

- **Free monthly allowance: 1,000 credits per account = exactly $0.1667.**
  The conversion is `60 credits = 1 cent` — verified three ways to three
  decimal places (256k call: 457.36 credits / 7.62273 ¢ = 60.000; 300k call:
  535.14 / 8.91894 = 60.000; first account's whole session: 644.32 /
  10.7367 = 60.011). So one free account gets **~16.7¢ of model usage per
  month**, i.e. ~550k deepseek-v4.1-flash input tokens (30¢/M prompt,
  120¢/M output — the catalog's `costs`) or far less with heavy output.
- A request holds its full cost before running: with an exhausted balance
  every size answers 402 **before any context check** — both probe accounts
  ended at ~0 credits.
- **Context ceiling not found; 256k and ~300k proven.** Inputs of 164k,
  230k, 254k, and 297k tokens all answered `200 OK` with correct needle
  retrieval. 330k+ remains unproven only because the money gate fires first;
  the catalog's 1M `context` / 393k `max_tokens` claims stand unrefuted.
  Confirming above 300k needs a new account/allowance or a paid plan.

## For a Cartethyia adapter (if pursued later)

- Not OpenAI-compatible: the `drivers/call` envelope and response shape need
  a custom adapter (a generic `ApiKeyProviderSpec` cannot express it).
- "Free" = the account's monthly credit grant, not zero-metered traffic;
  usage meters every call in credits/cents. Expect ~1–2M input tokens per
  free account per month.
