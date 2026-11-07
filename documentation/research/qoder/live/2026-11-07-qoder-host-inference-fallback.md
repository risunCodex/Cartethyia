# Qoder — Host Inference & Surface Fallback (2026-11-07)

> Live findings today: the old model-server host `api2-v2.qoder.sh` is **dead
> DNS**, the region endpoint sync (`/algo/api/v3/service/region/endpoints`)
> exposes surviving `inferNodes`/`fastMode`/`security` hosts, and the only chat
> surface verified **200 + full stream** is legacy COSY on
> `api1`/`api2.qoder.sh`. This document is the basis for the adapter decision:
> **api1 first → fallback**, optionally checking endpoint liveness.

## Summary

| Surface | Host | Status 2026-11-07 |
|---|---|---|
| gRPC model-server | `api2-v2.qoder.sh:443` | ❌ DNS NXDOMAIN (dead) |
| IDE HTTP `/model/v1` | `api2-v2.qoder.sh` | ❌ DNS NXDOMAIN (dead) |
| Legacy COSY `/algo` | `api1` / `api2` / `api3.qoder.sh` | ✅ **200 + stream** (model `auto`) |
| Endpoint sync | `center.qoder.sh/algo/api/v3/service/region/endpoints` | ✅ 200 (encrypted → decrypt) |

Consequence: the adapter default must **not** point at `api2-v2` (grpc/ide)
anymore. The live path is legacy COSY on `api1`/`api2`.

## 1. DNS evidence: `api2-v2.qoder.sh` is dead

- Google DoH: `Status:3` (NXDOMAIN) — `api2-v2.qoder.sh` does not exist in DNS.
- Cloudflare DoH: `Status:3`, Authority is the `qoder.sh` SOA
  (`vip7.alidns.com`).
- Local resolver and `114.114.114.114`: timeout (no answer).
- All candidates NXDOMAIN: `api1-v2`, `api3-v2`, `api4-v2`, `model.qoder.sh`,
  `models.qoder.sh`, `model-server.qoder.sh`, `api2-v3`, `api2-v2.qoder.com`,
  `qoder.model.aliyuncs.com`.
- Hosts alive: `api1/2/3.qoder.sh`, `center.qoder.sh`,
  `openapi.qoder.sh`, `qts2.qoder.sh`, `gateway.qoder.com.cn`.

## 2. Region endpoint sync — `/algo/api/v3/service/region/endpoints`

The new worker (`qoder-worker-runtime.obf.mjs` v1.1.79-hotfix.18) pulls its
host list from the center endpoint. Request: signed GET (COSY) to
`center.qoder.sh`. Response: **encrypted** — the body uses the scrambled
alphabet (not standard base64), not AES.

### Decrypt — inverse `transformQoderBody`

The sync payload characters exactly match the Qoder alphabet
(`QODER_ALPHABET` in `src/providers/integrations/qoder/qoder-cosy.ts`).
Decrypt is the inverse of `transformQoderBody`:

1. Map each character through the scrambled alphabet → standard base64 (`=` → `$`).
2. **Inverse rotate-thirds**: `original = lastThird + middle + firstThird`
   (encode does `reordered = last + middle + first`).
3. `Buffer.from(original, "base64").toString("utf8")` → JSON.

### Decrypted result (live, `dt-…` account), 2026-11-07

```json
{
  "centerNodes": ["https://center.qoder.sh"],
  "dataNodeMap": {
    "codebase": ["https://api1.qoder.sh"],
    "remote_agent": ["https://api2.qoder.sh"]
  },
  "inferNodes": ["https://api1.qoder.sh"],
  "nesNodes": ["https://api1.qoder.sh"],
  "openapiNodes": ["https://center.qoder.sh"],
  "security": ["https://api2.qoder.sh"],
  "fastMode": ["https://api2.qoder.sh"],
  "fallbackIpMap": {},
  "fallbackDomainMap": {}
}
```

Note: `y8i = "/api/v5/service/region/endpoints"` (v5 path also exists in the
worker; v3 is the one verified live).

## 3. Live surface probes (model `auto`, `dt-…` account)

### 3.1 HTTP `/model/v1` — FAILED on every alive host

- `api1/2/3.qoder.sh/model/v1/chat/completions` → **404**.
- `center.qoder.sh`, `qts2.qoder.sh`, `openapi.qoder.sh` → 404.
- `daily-api2`, `test-api2` → timeout.

Conclusion: the IDE HTTP surface is no longer served on any host that
resolves. It is not just the host that is dead — the path is absent.

### 3.2 gRPC `ChatCompletionStream` — FAILED on every alive host

- `api1/2/3`, `qts2`, `center`, `openapi` :443 → **`12 UNIMPLEMENTED`**
  (service `model.chat.ChatService` is not registered).
- `daily-api2`, `test-api2` → cancel/timeout.

Conclusion: the gRPC model-server is unavailable on any surviving host.

### 3.3 Legacy COSY `/algo` — ✅ 200 + full stream

- `api1.qoder.sh` & `api2.qoder.sh` + `agent_chat_generation` (signed COSY,
  encoded body) → **200**, stream 49+ frames, `reasoning_content` flows,
  `model:"auto"` echoed in chunks, `system_fingerprint` present.
- Bare/plain Bearer (no COSY) → `{"code":"101","message":"Signature invalid"}`.
- `POST /algo/api/v2/model/list` → 400 (must be a signed GET).

### 3.4 Additional notes

- `GET /algo/api/v2/model/list?Encode=1` on `api1` → **403** (needs
  signing), proving `api1` recognizes the path and is alive (not a 404).
- `chat_like` (`/api/v2/service/pro/invoke/chat_like`) = **rating/feedback**,
  not model invocation.
- The worker has `sendRemoteChatAsk` (WASM `prepareInferRequest`) — the
  invocation path modern clients use, but it requires a WASM QoderContext
  whose `initWasm()` hangs in a pure-import context (not pursued further;
  legacy COSY is proven sufficient).

## 4. Adapter design decision

**api1 first, then fallback** — following the existing
`qoderInferenceCandidates(intl)` order:

1. Primary: `api1.qoder.sh` (inferNodes from sync).
2. Fallback: `api2.qoder.sh`, then `api3.qoder.sh`.
3. When needed, check endpoint liveness first (signed GET
   `/algo/api/v2/model/list` → 200 means alive; 403 = alive but needs auth;
   404/conn = dead).

**Remove dead surface**: the default `surface: "grpc"` and the intl hosts in
`qoderGrpcHost(intl)` / `qoderIdeChatUrl(intl)` pointing at `api2-v2` must be
adjusted — that host is gone entirely, and no other host provides those
surfaces.

## 5. Evidence

- DNS: Google/Cloudflare DoH, `nslookup api2-v2.qoder.sh 8.8.8.8`.
- Endpoint sync: `https://center.qoder.sh/algo/api/v3/service/region/endpoints`
  (200, encrypted) — decrypted via inverse `transformQoderBody`.
- Chat probe: `api1/2.qoder.sh` legacy COSY → 200 + full stream (frames,
  reasoning, model echo).
- Other surfaces: 404 / UNIMPLEMENTED / timeout on all alive hosts.
- Worker: `qoder-worker-runtime.obf.mjs` v1.1.79-hotfix.18 (from Qoder 0.5.6
  mac-arm64, unpacked at `D:\tmp\unpacked\qoder\qoder-mac-arm64\`).
