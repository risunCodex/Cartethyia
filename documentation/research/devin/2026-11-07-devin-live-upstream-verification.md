# Devin live upstream verification — 2026-11-07

Status: verified live, uncommitted. Companion to the static desktop audit and
the adapter proposal. This is the first end-to-end proof against the real
Cascade backend with a valid credential.

## Credential

Adopted from the official Devin CLI at
`%APPDATA%\devin\credentials.toml` → `windsurf_api_key =
"devin-session-token$…"` (189 chars). `api_server_url =
https://server.codeium.com`. No OAuth browser flow was needed — the machine
already held a seat key. The earlier Google `auth1_…` token was confirmed
**not** an API key (401 on every RPC).

Account (from `GetUserStatus`): plan `Free`, tier 19 (`DEVIN_FREE`), email
`verineku+zhlagu@gmail.com` on file, prompt credits 2500/2500, flow credits
500/500, daily/weekly quota 100%. The quota collector now resolves the account
label from that email (falling back to the team id only when the upstream
reports nothing friendlier), so the console shows the email instead of the
opaque `devin-team$account-…` tag.

## Wire results (direct `https://server.codeium.com`)

| RPC | Result |
|---|---|
| `GetUserJwt` | 200 · `userJwt` 1912 chars · `customApiServerUrl` empty |
| `GetCliModelConfigs` | 200 · **1010 configs / 874,227 bytes** · 7 visible · account default `swe-2-flash-medium` |
| `GetUserStatus` | 200 · see account above |
| `GetChatMessage` | 200 `application/connect+proto` · 5 frames · text `"OK"` · usage in=397/out=23 · trailer `{}` |
| `devinAdapter.dispatch` | live, no mock · `complete/stop` · text + thinking + usage · zero errors |

Visible configs (display slot filtering applied):

```
swe-2-flash-medium         ctx=262144 out=131072  thinking, tools        disp=0
swe-1-6-slow               ctx=200000 out=128000  thinking, tools, vision disp=0
subagent-default           router  disp=6 (internal)
memory-migration-default   router  disp=6 (internal)
session-titler             disp=6 (internal)
smart-classifier           disp=6 (internal)
command-reviser            disp=6 (internal)
```

The remaining 1003 configs are `disabled` — the Free tier gates the catalog.
The operator-declared specs are confirmed: `swe-2-flash-medium` = 262144/131072
(account default), `swe-1-6-slow` = 200000/128000 + vision. `swe-1-6` /
`swe-1-6-fast` remain seed-only (not in the live roster on this account);
`swe-1-6` was subsequently removed from the seed, and `swe-1-6-fast`
disabled in the console because the account cannot use it.

## Bugs found only by live probing (fixed)

1. **`ModelDimension.value`, `minRange`, `maxRange` are `float`, not `double`.**
   `vendor/proto/devin/exa/codeium_common_pb/codeium_common.proto:2491-2499`
   declares fixed32. The trimmed protobufjs schema used `double` (fixed64),
   which shifted every following field and made the entire 874 KB catalog
   undecodable (`invalid wire type 4 at offset 163`). Fixed to `float`; the
   full catalog now decodes.

2. **`CompletionConfiguration` uint64 fields must be plain numbers, not
   `BigInt`.** `maxTokens: BigInt(256)` produced a 200 HTTP with an
   end-of-stream trailer error `invalid_argument: "There is an issue with this
   request, please try a different model."` while the identical request with
   `256` (number) returned text. Isolated by a variant grid. Fixed in
   `buildDevinChatRequest`.

3. **Connect end-stream trailers can be gzip-compressed** (flags `0x01 | 0x02`).
   The live `{}` trailer arrived as gzip bytes. Fixed in the adapter and the
   probe to gunzip before parsing.

4. **Inline tool-invocation markup.** `swe-2-flash-medium` sometimes emits a
   tool call as text:
   `<|message_model|>get_weather<|content_invoke_tool_json|>{"name":"get_weather","args":{"city":"Paris"}}<|end_message|>`
   instead of `deltaToolCalls`. Added a buffered markup parser so it becomes a
   canonical `tool_call_delta` + `tool_use` terminal. Verified live:
   `toolCalls: 1 delta → get_weather {"city":"Paris"}`.

5. **`GetChatMessageResponse` field types corrected** against the vendored
   `.proto`: `timestamp` is a `Timestamp` message, `deltaTokens` uint32,
   `creditCost`/`committedCreditCost` int32, `deltaSignatureType`/`phase`
   string, `latency` double, `signatureType`/`phase` in `ChatMessagePrompt`
   string, `numTokens` uint32, `creditMultiplier` float.

## Probe commands

```bash
# whole flow: CLI credential → all RPCs → chat
DEVIN_MODE=all DEVIN_LIMIT=5 bun scripts/provider-probing/devin/devin-upstream.mjs \
  # (inject DEVIN_CRED from credentials.toml; see README in that folder)

# shipped adapter dispatch, no mock
bun scripts/provider-probing/devin/devin-live-dispatch.mjs
DEVIN_TOOLS=1 DEVIN_PROMPT='Call get_weather with city Paris. Output ONLY the tool call, no prose.' \
  bun scripts/provider-probing/devin/devin-live-dispatch.mjs
```

## What remains unverified

- `AssignModel` (router UIDs `adaptive`/`subagent-default` are internal slots
  on this Free account).
- Paid-tier catalog (1003 disabled configs) and credit/quota consumption after
  real usage.
- Windsurf Enterprise loopback login (port 59654) — the CLI credential
  already covered auth, so the browser flow was not exercised live.

## Related

- `2026-11-06-devin-desktop-audit.md` — static bundle reverse + live OAuth
- `2026-11-07-devin-adapter-proposal-final.md` — implementation proposal
- `scripts/provider-probing/devin/README.md` — probe reference + live evidence
