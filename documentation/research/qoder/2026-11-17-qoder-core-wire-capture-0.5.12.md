# Qoder worker core 1.1.86-hotfix.5 (desktop 0.5.12) — live wire capture (2026-11-17)

Capture method: the unpacked worker core
(`@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`,
version `1.1.86-hotfix.5`, the exact process the desktop app spawns as
`Qoder.exe … --sdk`) run standalone under plain Node, driven through
mitmproxy 8080 with `HTTPS_PROXY` + `NODE_TLS_REJECT_UNAUTHORIZED=0`. Auth came
from a real device-flow login performed inside the capture (approved by the
account owner) plus a PAT export for the exchange surface. All tokens redacted;
raw bodies and flows stay in scratch (`D:\tmp\mitm-qoder\capture\`). Scratch
tooling: `D:\tmp\mitm-qoder\run-capture.mjs`, `run-login.mjs`,
`show-flows.mjs`; addon `qoder-capture-addon.py` (JSONL + ordered headers +
TLS client-hello + body sha refs).

Static companion findings (same day, from the 0.5.12 unpack at
`D:\tmp\unpacked\qoder`): the worker's brand-constants region exposes every
env knob — `QODER_CONFIG_DIR`, `QODER_CLI_HOME`, `QODER_SDK_ACCESS_TOKEN`,
`QODER_PERSONAL_ACCESS_TOKEN` (env presence alone flips `authType` to
`qoder-pat`), `QODER_CLIENT_TYPE`, `QODER_BUSINESS_PRODUCT`, `QODER_BUSINESS_TYPE`,
`QODER_SCENE`, `QODER_SERVER_ENDPOINT`, `QODER_CENTER_ENDPOINT`, and
`QODER_DISABLE_UMID_REPORT`. Host tables: intl
`api1/api2/api3.qoder.sh`, `center.qoder.sh`, `openapi.qoder.sh`; CN all
`*.qoder.com.cn`; daily/test rigs separate. Credential store =
`qoder-cli-credentials.json` (scrypt+AES-encrypted) under the config dir.

## Login (device flow, live)

- Start URL `https://qoder.com/device/selectAccounts?challenge=…&challenge_method=S256&nonce=<uuid>&machine_id=<MachineGuid>&client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb&machine_token=<UMID>`.
  The client sends **the real UMID as `machine_token` at login start** — the
  repo's login only sends it when an operator overrides it.
- Poll `GET https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=…&verifier=…&challenge_method=S256`.
  Ordered request headers: `accept: application/json`, `x-request-id: <upper
  uuid>`, `cosy-version: 1.1.86-hotfix.5`, `cosy-clienttype: 5`,
  `cosy-machineos: x86_64_win32`, `traceparent`, `accept-language: *`,
  `sec-fetch-mode: cors`, `user-agent: undici`,
  `accept-encoding: br, gzip, deflate`. Cadence ≈1.2 s. Pending answer is
  **404** `{"errorCode":"NotFound"}`, not 202. Verifier observed length 118.
- Poll 200 body: `{id, token: "dt-…", user_id, code_challenge,
  code_challenge_method, nonce, expires_at, refresh_token_id, created_at}` —
  **no `refresh_token` field** (only `refresh_token_id`).

## Auth bootstrap order (intl, one session)

1. `GET center.qoder.sh/algo/api/v3/service/region/endpoints` — pre-auth, signed
   (`signature=<32hex>`, `date`, `login-version: v2`, `appcode: cosy`,
   `cosy-business-product: cli`, `cosy-scene: assistant`,
   `cosy-machinetoken=<machineId>` placeholder, `cosy-machinetype: 5`).
2. `POST {center|openapi}.qoder.sh/api/v1/jobToken/exchange` — body
   `{"personal_token":"pt-…","machine_id":"<MachineGuid>"}` (no machine_token
   key), UA `qoder/1.1.86-hotfix.5` (not undici). Response: `token: "jt-…"`,
   `refresh_token: "jrt-…"`, `expires_in`, `expires_at`.
3. `GET …/api/v1/userinfo` on center and openapi.
4. `GET center.qoder.sh/algo/api/v5/service/region/endpoints` — post-auth:
   `authorization: Bearer jt-…`, `x-gw-user-id`, and once the UMID bridge
   finishes, the identity flips to the real one: `cosy-machinetoken=P1gA…`
   (88 chars), `cosy-machinetype=<18 hex>`, `cosy-machinecode=<18 hex>`,
   `x-qoder-httpdns-ip=<resolved ip>`.
5. `GET center.qoder.sh/api/v3/user/status`,
   `GET center.qoder.sh/algo/api/v2/config/getDataPolicy?requestId=…&version=2`,
   `POST openapi.qoder.sh/api/v1/qcs/config/resolve`,
   `GET …/qcs/config/stream?ns=qodercli-feature-gates%2Centerprise-governance`,
   `GET api2.qoder.sh/algo/api/v2/model/list?Encode=*`.

Aliyun HTTPDNS (`203.107.1.1`, `resolvers-cn.httpdns.aliyuncs.com`, app id
`183012`) runs even with `HTTPS_PROXY` set, resolving
`api2/center/api1/api2/api3/openapi.qoder.sh` with signed queries; the pinned
result rides as `x-qoder-httpdns-ip` on some requests only.

Region-endpoint responses carry `x-cosy-encrypt: v1` and their bodies are the
same alphabet-scramble transform as request bodies — **responses are scrambled
too**, endpoint-specific (SSE chat responses are plaintext).

## Chat surface (live, 200 OK on `gfmodel`; `auto` slot returned the p4 pin)

`POST https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=*`

- **`Encode=*` (was `Encode=1` in the 0.5.7 capture) and the request body is
  the scramble transform only — no zstd layer.** 42,240 bytes scrambled text
  on the wire for a minimal prompt.
- Ordered headers: `accept: text/event-stream`, `authorization: Bearer
  COSY.<payload>.<sig>` (441 chars — the store session's COSY token, not the
  `dt-`), `cache-control: no-cache`, `content-type: application/json`,
  `cosy-business-product: cli` (app sends `app`), `cosy-business-type: agent`,
  `cosy-clienttype: 5` (app sends `10`), `cosy-data-policy: agree`,
  `cosy-date: <epoch s>`, `cosy-key: <172ch RSA/AES key>`,
  `cosy-machineid: <MachineGuid>`, `cosy-machinetoken: <real UMID 88ch>`,
  `cosy-machinetype: <18 hex>`, `cosy-scene: assistant` (app sends `app`),
  `cosy-user: <userId>`, `cosy-version: 1.1.86-hotfix.5`,
  `login-version: v2`, `x-model-key: <roster key>`, `x-model-source: system`,
  `cosy-machineos: x86_64_win32`, **`cosy-machinecode: <18 hex>` (new vs
  0.5.7)**, **`cosy-machinehostname: <hostname>` (new vs 0.5.7)**,
  `traceparent`, `x-qoder-httpdns-ip` (conditional),
  `accept-language: *`, `sec-fetch-mode: cors`, `user-agent: undici`,
  `accept-encoding: br, gzip, deflate`.
- Successful response: HTTP 200, `content-type: text/event-stream`, events
  wrapped as
  `data:{"headers":{"Content-Type":["application/json"]},"body":"{\"choices\":[{\"delta\":{…}},…\"object\":\"chat.completion.chunk\"}","statusCodeValue":200}`
  — the OpenAI-style chunk is a **stringified `body` field inside a Qoder
  envelope**. Plaintext (no scramble) on this endpoint.

## Queue envelope (the p4 pin, fully captured)

An upstream pin arrives as **HTTP 200 SSE**, not a 403:

```
data:{"headers":{"Content-Type":["application/json"],"Retry-After":["60"]},
      "body":"{\"code\":\"403\",\"message\":\"{\"code\":\"10605\",\"message\":\"{errorCode:0,
      isQueued:true, modelKey:auto, queueCount:1, …}\"}","statusCodeValue":…}
```

Triple-nested JSON, `code 10605`, `Retry-After: 60`. The client then polls
`GET api2.qoder.sh/algo/api/v2/service/ask/queue/status?requestSetId=<uuid>&modelKey=auto&queueType=p4`
(full COSY-signed header set plus **`x-session-id: <uuid>`** and
`accept-encoding: identity`); response
`{"subCode":"RESOURCE_LIMIT","isQueued":true,"modelKey":"auto","queueType":"p4","queueCount":1,"waitTime":60,"retryAfterSeconds":60,"serviceAvailable":true,"errorCode":0}`.
The in-bundle CLI waits ×retries on this (Cartethyia deliberately fail-fasts).

## Diff vs the gateway adapter (post-2026-11-11 alignment)

| # | Attribute | Adapter today | Core wire 1.1.86 | Action |
|---|---|---|---|---|
| 1 | Query `Encode` | `1` | `*` | adopt `*` |
| 2 | Request body | scramble → zstd | scramble only | drop zstd when `Encode=*` |
| 3 | `cosy-machinecode` | absent | 18-hex | add (from vendor bridge) |
| 4 | `cosy-machinehostname` | absent | real hostname | add |
| 5 | `cosy-machinetoken` | UMID when available | real UMID 88ch | already matching when bridge used |
| 6 | `cosy-machinetype` | 18-hex when available | 18-hex (numeric `5` only pre-auth) | keep |
| 7 | `cosy-version` | IDE fallback | `1.1.86-hotfix.5` (worker version) | adopt worker version |
| 8 | Refresh URL | `/deviceToken/refresh` (fixed this session) | literal exists in 0.5.12 table | done |
| 9 | Poll headers | bare | full Cosy set + `x-request-id` | add for fidelity |
| 10 | Poll cadence/verifier | 5 s / 64 chars | ≈1.2 s / 118 chars | optional fidelity |
| 11 | Poll pending | 202/404 | 404 only | keep (404 handled) |
| 12 | userinfo host | openapi only | center (region-resolved) + openapi | openapi worked; center optional |
| 13 | jobToken exchange | PAT surface exists | `{personal_token, machine_id}` | shape confirmed |
| 14 | Region responses | not consumed | scrambled (`x-cosy-encrypt: v1`) | only if adapter reads them |
| 15 | SSE envelope | handled | wrapped `data:{headers,body,statusCodeValue}` + 10605-as-200 | verify parser covers both |

## Unknown / next

- TLS ClientHello records were captured (39) but the addon's conn-id join to
  requests failed; correlate by SNI offline (`capture/flows.jsonl`) before
  claiming a JA3/JA4.
- `deviceToken/refresh` wire not yet observed live (tokens did not rotate
  during the session); the 0.5.12 table literal confirms the path, body shape
  still open — the repo sends `machine_id`/`machine_token` keys the client
  table does not contain.
- Desktop-app-identity chat (clienttype 10, product `app`, scene `app`) was
  captured on 0.5.7; the CLI core sends the cli/assistant/5 triple. The app
  passes its values via env to the same worker.
- mitmproxy re-encrypts to upstream, so server-side JA3 is mitmproxy's, not
  the client's; client-side hellos are in the capture.
