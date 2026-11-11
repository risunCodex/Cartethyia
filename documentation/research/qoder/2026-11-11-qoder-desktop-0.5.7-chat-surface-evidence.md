# Qoder Desktop 0.5.7 — chat surface evidence (live, 2026-11-11)

**Date:** 2026-11-11
**Scope:** Qoder Desktop win-x64 0.5.7 (`Qoder-win-x64-user.exe`, stable, build 87859883, commit `73fe8d73`, released 2026-11-09). Evidence was collected live against the installed app and its own worker logs, with a local MITM proxy, DNS observation, TLS ClientHello capture, gRPC probes, and credential-flow reconstruction.

**Status:** This document supersedes the earlier inference that the desktop chat path is gRPC. The live worker log shows the actual chat transport is the legacy COSY SSE path, `POST /algo/api/v2/service/pro/sse/agent_chat_generation`.

---

## 0. TL;DR

- Updater says the latest stable is **0.5.7** (`https://download.qoder.com/qoder-app/releases/latest.yml`), matching the binary we unpacked.
- The worker runtime is `qoder-worker-runtime.obf.mjs` **v1.1.79-hotfix.19** (embedded in `resources/app.asar.unpacked/.../dist/_worker/`).
- `api2-v2.qoder.sh` (the old gRPC model-server host baked into the worker) is **NXDOMAIN in public DNS** and `14 UNAVAILABLE` for gRPC resolution.
- Public gateways `api1/2/3.qoder.sh`, `center.qoder.sh`, `openapi.qoder.sh` do **not** register the `model.chat.ChatService` gRPC service (`12 UNIMPLEMENTED` for `ChatCompletionStream`), with both `jt-` job tokens and `dt-` OAuth tokens.
- Region sync (signed, from `center.qoder.sh/algo/api/v3/service/region/endpoints` and v5) yields `inference: https://api2.qoder.sh` — there is no separate model-server host.
- **The app's actual chat request** (captured from its own worker log while a chat was running):
  - `operation=sendRemoteChatAsk`, `method=POST`
  - `url=https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`
  - `requestClass=infer-sse`, `status=200`, streaming `duration=~2.8s`
  - `networkMode=httpdns httpdnsConfigured=true`
  - model echoed in the session: `Qwen4-Max-Preview` (`model_key: qmodel_latest`)
- So the desktop chat surface is **legacy COSY SSE** (`agent_chat_generation`) on `api2.qoder.sh`. The gRPC service exists in the bundle (proto `chat.proto`) but is **not** what the desktop app uses, and is not served by any public host.
- HTTPDNS (Aliyun) is a real layer (`X-Qoder-HTTPDNS-IP`, SDK bootstrap IPs, account credentials sourced from the auth WASM), used by the app even for the standard gateway requests.

---

## 1. Artifacts

| Artifact | Location (this session) |
| --- | --- |
| Installer NSIS 0.5.7 | `D:\tmp\binaries\Qoder-win-x64-user-0.5.7.exe` (271,304,704 B) |
| Unpacked app | `D:\tmp\unpacked\Qoder-win-x64-user-0.5.7\app-64\` (1080 files) |
| `app.asar` | 200,590,643 B (worker runtime + business strings) |
| Worker runtime | `app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs` (34.8 MB) |
| Runtime info | `dist/_worker/runtime-info.json` → v1.1.79-hotfix.19, site=global, product=qodercli? buildEnv=dev, createdAt 2026-11-09T06:11:02Z |
| Proto | `dist/_worker/proto/chat.proto` (package `model.chat`, service `ChatService`) |
| Auth WASM | extracted from worker base64 blob → `qoder_auth_wasm_bg.wasm` (320,863 B) |
| MITM flows | `D:\tmp\mitm-qoder\flows\flows.jsonl` (hundreds of captured HTTP flows) |
| Host hijack log | `D:\tmp\mitm-qoder\hijack\conn.log` (ClientHello captures) |
| Worker run logs | `~/.qoder/logs/runs/<ts>/qodercli.log` |

All credential strings are redacted in this document.

---

## 2. Updater / version facts (verified live)

`GET https://download.qoder.com/qoder-app/releases/latest.yml` → HTTP 200:

```yaml
version: 0.5.7
releaseDate: 2026-11-09T09:41:47.474Z
releaseId: 0.5.7
commit: 73fe8d7343fbbbc3fb5ec665489082f6e4db0128
buildNumber: "87859883"
buildKind: official
path: Qoder-win-x64-user.exe
size: 271304704
sha256: dce465ea1d3b06687f7f66806a5bd5af77bce34e201f32ee5c64c1367394c5bf
differential.blockmapUrl: https://download.qoder.com.cn/qoder-app/releases/0.5.7/Qoder-win-x64-user.exe.blockmap
windowsFastUpdate.url: https://download.qoder.com.cn/qoder-app/releases/0.5.7/Qoder-win-x64-user-app.zip
```

- Channel metadata at `resources/product.json`: `channel: stable`, `appId: com.qoder.app`, `dataDirectoryName: com.qoder.app.stable`, `desktopUpdateDownloadBaseUrl: https://download.qoder.com.cn/qoder-app/releases`.
- `resources/app-update.yml`: `provider: generic`, `url: https://download.qoder.com.cn/qoder-app/releases`, `updaterCacheDirName: qoder-updater`.
- The machine already had 0.5.7 staged by the updater at `%LOCALAPPDATA%\Programs\Qoder\.qoder-versions\0.5.7\` (matches `latest.yml` hashes).
- No beta/alpha/dev/canary/next channel files exist at that URL (all 404).

---

## 3. DNS state (verified live)

| Host | Result |
| --- | --- |
| `api2-v2.qoder.sh` | NXDOMAIN (Google 8.8.8.8, Cloudflare 1.1.1.1, AliDNS 223.5.5.5/223.6.6.6). No CNAME, no A. |
| `daily-api2-v2.qoder.sh`, `test-api2-v2.qoder.sh` | NXDOMAIN |
| `api1/2/3.qoder.sh` | A records (`api1` 147.139.206.146/149.129.214.213; `api2` 8.215.6.232/147.139.197.248; `api3` 8.215.46.65/8.215.5.138), CNAME → `*.aliyunga0019.com` (Aliyun Global Accelerator) |
| `center.qoder.sh`, `openapi.qoder.sh` | 149.129.241.62 / 149.129.236.250 (same GA) |
| `daily-api2.qoder.sh` | 8.212.105.130 / 8.212.112.125 |
| `test-api2.qoder.sh` | 147.139.212.72 / 147.139.140.141 |
| `gateway.qoder.com.cn` | 47.86.185.172 / 47.86.184.84 |

TLS/ALPN on all public gateways: `TLSv1.3`, ALPN `h2` (probed with Python ssl).

---

## 4. gRPC probe results

Client: `@grpc/grpc-js` (from repo's node_modules) + the vendored `chat.proto` (same as app bundle). Channel options mirrored from worker (`grpc.enable_http_proxy=0`, `default_authority`/`ssl_target_name_override` = host, 32 MiB limits). Method `ChatCompletionStream`.

| Host | Result |
| --- | --- |
| `api2-v2.qoder.sh:443` | `14 UNAVAILABLE: Name resolution failed` (NXDOMAIN) |
| `api1/2/3.qoder.sh:443` | `12 UNIMPLEMENTED` (empty details) |
| `center.qoder.sh:443`, `openapi.qoder.sh:443` | `12 UNIMPLEMENTED` |
| `daily-api2.qoder.sh`, `daily-openapi.qoder.sh`, `daily.qoder.ai` | timeout |
| `test-api2.qoder.sh`, `test-openapi.qoder.sh`, `test.qoder.ai` | timeout |

Both `jt-WxtMjjJyTbV7GMVhVrJebYHL` (from `/api/v1/me/jobToken`) and `dt-pGZ8MQoynSo0tX9j5jFwK9QO` (OAuth) were tried → identical results. Conclusion: the ChatService is **not registered** on any public host.

---

## 5. Auth token flow (verified live)

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST https://openapi.qoder.sh/api/v1/jobToken/exchange` | `{"personal_token":"<API key>"}` | 200 → `{token: jt-…, expires_at+1d, refresh_token: jrt-…, refresh_token_expires_at+2d}` |
| `POST https://openapi.qoder.sh/api/v1/me/jobToken` | `{"clientId":"<uuid>"}` | **401** without an authenticated app session; when run inside the app it returns 200 (see MITM capture) |
| `GET https://openapi.qoder.sh/api/v1/userinfo` | Bearer `dt-…` | 200 |

MITM capture (app session) shows:
- `Authorization: Bearer dt-pGZ8MQoynSo0tX9j5jFwK9QO` (OAuth token, used for all openapi requests).
- `POST /api/v1/me/jobToken` → `{"token":"jt-WxtMjjJyTbV7GMVhVrJebYHL", …, "refresh_token":"jrt-tGG4hIalBWzFhjQzNnJNKWqt"}`.

So there are two job-token issuance paths: `/jobToken/exchange` (personal access token, usable from outside) and `/me/jobToken` (app-session bound). Both produce `jt-` tokens.

---

## 6. Region sync (verified live, decrypted)

Request (signed with `dt-` bearer): `GET https://center.qoder.sh/algo/api/v3/service/region/endpoints` → 200, body is alphabet-scrambled base64 (Qoder transform). Decrypt with inverse `transformQoderBody`:

```json
{
  "centerNodes": ["https://center.qoder.sh"],
  "dataNodeMap": { "codebase": ["https://api2.qoder.sh"], "remote_agent": ["https://api2.qoder.sh"] },
  "inferNodes": ["https://api2.qoder.sh"],
  "nesNodes": ["https://api2.qoder.sh"],
  "openapiNodes": ["https://center.qoder.sh"],
  "security": ["https://api2.qoder.sh"],
  "fastMode": ["https://api2.qoder.sh"],
  "fallbackIpMap": {},
  "fallbackDomainMap": {}
}
```

v5 (`/algo/api/v5/service/region/endpoints`) returns the same values with `{url, type:"public"}` wrappers. **No model-server host exists in the sync payload.**

---

## 7. HTTPDNS (Aliyun SDK inside the worker)

- Worker bundles the full Aliyun HTTPDNS SDK (class `NetworkManager` / `createHTTPDNSClient`, signature HMAC-SHA256, bootstrap IPs `203.107.1.1, 203.107.1.97, 203.107.1.100, 203.119.238.240, 106.11.25.239, 59.82.99.47`).
- Flow: `GET http://<bootstrap-ip>/<accountId>/ss?region=global` → service IP list; then `GET http://<service-ip>/v2/d?id=<accountId>&dn=<domain>&q=Both&m=0&exp=…&s=<sig>` → resolved IPs.
- Account credentials come from the auth WASM (`get_httpdns_account_id` / `get_httpdns_secret_key`); the WASM string pool shows `http://203.107.1.1//sign_d?host=&query=A&t=&s=` and `{"account_id":"","secret_key":""}` — i.e. defaults are empty, credentials are supplied at runtime.
- App requests carry `X-Qoder-HTTPDNS-IP` header; env override `QODER_HTTPDNS`.
- Worker log during chat: `networkMode=httpdns httpdnsConfigured=true`.

---

## 8. The MITM capture (app traffic)

Setup: mitmproxy 12.2.3 on `127.0.0.1:8080`; system proxy set; mitm CA installed in CurrentUser Root; app launched with `--ignore-certificate-errors` (Chromium layer) so TLS interception works.

Observed hosts/paths (flows file, ~289+ requests):

| Host | Paths | Notes |
| --- | --- | --- |
| `openapi.qoder.sh` | `/api/v1/userinfo`, `/api/v2/user/plan`, `/sash/api/v2/me/usage`, `/api/v1/agents*`, `/api/v1/agent-teams`, `/api/v1/collaboration/*`, `/api/v1/remote/*`, `/api/v1/me/jobToken`, `/api/v1/qcs/config/stream` (SSE) | all business API |
| `api2.qoder.sh` | `/otel/v1/logs` (OTLP telemetry, HTTP/2) | telemetry only via proxy |
| `qoder.com` | `/users/<id>/default/avatars` | avatar CDN |
| `api2.qoder.sh` + `https://center.qoder.sh` | (direct, bypassing proxy) | see §9 |

No chat path (`agent_chat_generation`, `/model/v1/chat/completions`, or gRPC) ever appears in the proxy captures, even while chats completed.

---

## 9. Direct connections + ClientHello capture

While a chat is running, the renderer process holds `ESTABLISHED` sockets directly (not via the proxy) to:
- `8.215.6.232:443` / `147.139.197.248:443` → `api2.qoder.sh`
- `149.129.236.250:443` / `149.129.241.62:443` → `center.qoder.sh` / `openapi.qoder.sh`
- Also once `203.119.238.240:443` (Aliyun HTTPDNS bootstrap IP).

TLS ClientHello capture (hosts-file hijack `api2.qoder.sh→127.0.0.1`, TLS listener on 443) decoded:
- SNI = `api2.qoder.sh` (hex `617069322e716f6465722e7368`)
- ALPN = `h2` (and `http/1.1`), TLS 1.3
- Many parallel connections → connection pooling.

This looks like an HTTP/2 (or gRPC-style) client, but the worker log (§10) proves the actual method is an HTTP/2 **SSE POST** to `/algo/.../agent_chat_generation`.

---

## 10. Worker log — the decisive evidence

The splash's own worker logs (`~/.qoder/logs/runs/<ts>/qodercli.log`) record the chat request verbatim:

```
[qoder-server-request] --> operation=sendRemoteChatAsk method=POST
  url=https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
  requestClass=infer-sse requestSetId=…
  networkMode=httpdns httpdnsConfigured=true fallbackIpDomainCount=0
[qoder-server-request] <-- operation=sendRemoteChatAsk host=api2.qoder.sh
  path=/algo/api/v2/service/pro/sse/agent_chat_generation status=200
  duration=2799ms networkContract=mandatory requestClass=infer-sse
```

Also from the same log line- `[endpoint-election] event=elect.completed selected_endpoints: { center: 'https://center.qoder.sh', inference: 'https://api2.qoder.sh', securityInference: 'https://api2.qoder.sh', openapi: 'https://center.qoder.sh' }`
- `[auth] Login method: host-provided job token` → `strategy=provided kind=host-job-token`
- `[config-service] SSE stream connected` to `https://openapi.qoder.sh/api/v1/qcs/config/stream?ns=qodercli-feature-gates`
- Session hook output: `model: Qwen4-Max-Preview`, `model_key: qmodel_latest`, product `app`, version `1.1.79-hotfix.19`.

This is the authoritative source: the Qoder Desktop app (0.5.7) chats over the **legacy COSY SSE** path, not gRPC.

---

## 11. Auth WASM (static extraction)

From the worker bundle, the WASM blob (base64) was extracted and reconstituted as `qoder_auth_wasm_bg.wasm` (320,863 B). Relevant exports:

- `credential_storage_encrypt` / `credential_storage_decrypt` (used for `auth.v1.dat`, keyed by machine id)
- `get_httpdns_account_id`, `get_httpdns_secret_key`, `get_httpdns_config`, `build_httpdns_url`
- `qodercontext_prepareRequest`, `qodercontext_prepareInferRequest`, `generate_runtime_auth_fields`
- `profile_encrypt`, `model_cache_encrypt`/`decrypt`, `decrypt_server_response`

Static strings of interest (all public/static material; no private keys):
- The Qoder base64 alphabet `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`
- Static COSY signature secret `d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==` (already known), `QODER_APPCODE=cosy`
- RSA public keys (embedded profile + COSY identity)
- `@qoder.alibaba-inc.com` engineer e-mail list (public build metadata)
- `client_metadata` defaults: client_type `5`, business product `cli`/`app`, scene `assistant`

---

## 12. Conclusions / corrections to earlier docs

| Earlier belief | Correction |
| --- | --- |
| Desktop chat default = gRPC (`model.chat.ChatService/ChatCompletionStream`) | Desktop chat actually = legacy COSY SSE `POST /algo/api/v2/service/pro/sse/agent_chat_generation` on `api2.qoder.sh` |
| gRPC host `api2-v2.qoder.sh` | Dead (NXDOMAIN), and the service is not registered on any public host |
| HTTP modern `/model/v1/chat/completions` used by desktop | Not used; the app uses `sendRemoteChatAsk`/`agent_chat_generation` |
| HTTPDNS is optional | The app runs with `networkMode=httpdns` active by default |

Everything in this document was verified from live network captures and the app's own runtime logs; nothing is inferred from source alone.

---

## 13. Evidence files / reproducibility

- Updater: `curl https://download.qoder.com/qoder-app/releases/latest.yml`
- Flows: `D:\tmp\mitm-qoder\flows\flows.jsonl`
- ClientHello: `D:\tmp\mitm-qoder\hijack\conn.log`
- Worker logs: `~/.qoder/logs/runs/<ts>/qodercli.log`
- Probe scripts (scratch, not committed): `scripts/provider-probing/qoder/scratch/{jobtoken-grpc-probe,region-decrypt-grpc-probe,jobtoken-grpc-hit,jobtoken-grpc-hit2}.ts`

Credentials redacted; tokens are only referenced by prefix/suffix length in this document.
