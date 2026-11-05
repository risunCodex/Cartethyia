# Audit Artifact Qoder Windows Desktop v0.5.3 (NSIS, Electron 43) — Report Lengkap

**Tanggal audit:** 2026-11-05
**Artifact:** `D:\tmp\unpacked\qoder\qoder-win-nsis\` (sudah di-unpack, statis)
**Metodologi:** string-scan statis, ekstraksi `app.asar` via parser asar minimal, verifikasi SHA-256 integrity, perbandingan dengan adapter Cartethyia (`src/providers/integrations/qoder/`). Tidak ada binary yang dijalankan.
**Status integritas:** ⚠️ **PENTING** — hampir semua file di dalam `app.asar` (99.7%: 6380/6396 file dengan integrity header) **tidak match SHA-256** yang tercantum di header asar. Ini bukan error unpacker — verifikasi dilakukan langsung di `app.asar` asli, dan hanya 16 file (hono types, office-reader `.stamp`) yang match. Implikasi: **kode di dalam asar sudah di-obfuscate/modifikasi pada saat build** (hash header menggambarkan file pra-transformasi, atau isi file di-track sebagai "transformasi" oleh tooling internal Qoder). Analisis di bawah ini dibangun dari string yang TERBACA di dalam file valid (`electronMain.js` 19.5MB dan chunks) + file SDK worker yang valid di `app/resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/` (34.8MB, `.obf.mjs`) — keduanya punya konten nyata dan konsisten.

---

## 1. Ringkasan Eksekutif

Qoder v0.5.3 (Electron 43.1.1, build 85766111, commit 26e9614, dibangun 2026-11-03) adalah desktop IDE dari Qoder (qoder.sh / qoder.com.cn). Permukaan jaringannya **bukan** di dalam `electronMain.js` secara langsung (file itu isinya mostly Zod/undici yang ter-obfuscate); **permukaan asli hidup di `@qoder-ai/qoder-agent-sdk` worker runtime** (`qoder-worker-runtime.obf.mjs`, v1.1.79-hotfix.11) yang di-bundle sebagai file unpacked, plus JS preload `pluginViewDiagramRuntime.cjs` (5MB) yang merujuk daemon bridge.

Temuan utama:

1. **Dua realm terpisah** (global `qoder` vs CN `qoder-cn`), dengan host berbeda per env (prod/daily/test) dan per peran (gateway api1/api2/api3/api2-v2, center, openapi, static, download).
2. **Chat modern (gRPC):** `model.chat.ChatService/ChatCompletionStream` di `https://<model-server>:443` (intl: `api2-v2.qoder.sh`, CN: `gateway.qoder.com.cn`). Proto ada di `dist/_worker/proto/chat.proto` (identik dengan yang di-vendor adapter Cartethyia).
3. **Chat HTTP (OpenAI-shaped):** `POST /model/v1/chat/completions` + legacy COSY `/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`.
4. **Signing WASM** `qoder_auth_wasm_bg.wasm` (QoderContext): `prepareInferRequest`, `prepareRequest`, `decrypt_server_response`, `credential_storage_encrypt/decrypt`, `generate_runtime_auth_fields`, httpdns. Ini adalah donor dari COSY signing yang di-port adapter (AES/RSA + alphabet scramble + header `Cosy-*`/`cosy-*`).
5. **Machine identity UMID** native: `runtime-info.exe` + `sgsdk.dll` (win32-x64), manifest target win32-x64, qoderCliVersion 1.1.79-hotfix.11; worker memverifikasi SHA256 file dan mengekstrak bundle `umid-win32-*` ke cache dengan nama yang di-hash.
6. **OAuth device flow** (bukan RFC 8628): PKCE S256 + machine_id di `/device/selectAccounts`, poll `/api/v1/deviceToken/poll`, refresh `/api/v1/deviceToken/refresh`, PAT→jobToken `/api/v1/jobToken/exchange`.
7. **Telemetry** OTel: endpoint default OTLP gRPC `http://localhost:4317`, Zipkin `http://localhost:9411/api/v2/spans` (env `OTEL_EXPORTER_*`).
8. **MCP**: `@modelcontextprotocol/*` v2025-ish (client/server/core/node/sdk) ada di node_modules asar; electronMain import client stdio/server/node.
9. **Permukaan lain:** updater (`download.qoder.com.cn/qoder-app/releases`), docs/llms.txt, marketplace `apphub/api/v1/marketplace/marketplace.json`, cloud agents `/api/v1/cloud`, OSS `qoder-ide.oss-accelerate.aliyuncs.com` & `static.qoder.com.cn`, security `qoder-security` (vendored binary `qodersec-launch`), office-reader (.NET WebAssembly + mammoth/docx/pdf).

**Poin penting untuk adapter Cartethyia:** banyak yang sudah cocok dengan donor (gRPC host/path, proto, model list path, device flow), tapi ada beberapa **beda halus** yang didokumentasikan di bagian 10 (client_type, version header, request path pattern, body keys, machineid derivation).

---

## 2. Identitas Artifact

| Atribut | Nilai | Sumber |
|---|---|---|
| productId / product | `qoder` / `Qoder` | `app/resources/product.json` |
| productVersion | **0.5.3** | `app/resources/build-manifest.json` |
| releaseChannel | stable | build-manifest |
| commit | `26e9614fa446884b6a6679160ef17a0ee6a830c5` | build-manifest |
| electronVersion | **43.1.1** | build-manifest |
| platform / arch | win32 / x64 | build-manifest |
| installerType | user | build-manifest |
| buildNumber | 85766111 | build-manifest |
| buildTime | 2026-11-03T07:59:11.277Z | build-manifest |
| appId | com.qoder.app | product.json |
| dataDirectoryName | com.qoder.app.stable | product.json |
| protocolScheme | qoder | product.json |
| desktopUpdateDownloadBaseUrl | `https://download.qoder.com.cn/qoder-app/releases` | product.json |
| app-update.yml | provider generic, url sama, `updaterCacheDirName: qoder-updater` | `app/resources/app-update.yml` |
| UMID manifest | target `win32-x64`, qoderCliVersion `1.1.79-hotfix.11`, sdkVersion `1.0.59-alpha.9`, files runtime-info.exe (480752 B, sha256 `2ff35e9d...`) + sgsdk.dll (7354928 B, sha256 `6347e229...`) | `app/resources/umid/manifest.json` |
| Worker runtime SDK | `qoder-worker-runtime.obf.mjs` 34.8MB, v1.1.79-hotfix.11, profile platform, target win32-x64, git 0eb78f0, build site global | `dist/_worker/runtime-info.json` |

### Struktur penting

```
qoder-win-nsis/
├── app-asar/…                        # isi app.asar (tercemar/obfuscated, USEDAKAN)
├── app/resources/
│   ├── app.asar                      # 196.9MB (header JSON @16, payload mulai @~1.7MB)
│   ├── app.asar.unpacked/node_modules/
│   │   ├── @img/{colour,sharp-win32-x64}      # native image pipeline
│   │   ├── @lydell/node-pty(+win32)           # PTY native
│   │   ├── @napi-rs/canvas-win32-x64-msvc     # skia canvas
│   │   ├── @silvia-odwyer/photon-node          # photon WASM (image ops)
│   │   ├── @qoder-ai/qoder-agent-sdk/dist/_worker/   # ⭐ SDK worker runtime
│   │   │   ├── qoder-worker-runtime.obf.mjs   # 34.8MB — permukaan jaringan
│   │   │   ├── proto/chat.proto               # ⭐ gRPC proto
│   │   │   ├── runtime-info.json
│   │   │   ├── builtin/{agent-creator,hook-config,sdk,skill-creator}/SKILL.md
│   │   │   └── vendor/{qoder-security,qoder-sites,ripgrep/x64-win32/rg.exe}
│   │   ├── aoq-electron-sdk/prebuilds/win32-x64/  # alivcffmpeg.dll, AoqClientSdk.dll, aoq_node_ext.node, PluginOpus.dll
│   │   ├── detect-libc, keytar, node-pty, semver, sharp
│   ├── umid/{runtime-info.exe, sgsdk.dll, manifest.json}
│   ├── product.json, build-manifest.json, app-update.yml
```

---

## 3. Peta Permukaan Jaringan (Host / Endpoint / Method)

### 3.1 Host per realm / env (dari worker runtime)

Konstanta `Mq, fw, vq, w9, S9, JYA, D9, Fq, Hce, GYA, PL, Jce, vJe, Gce, YYA, KE, Uq, Nq, Lq, ...` (global vs CN, `js` = China):

| Peran | Prod Intl | Prod CN | Daily Intl | Test Intl |
|---|---|---|---|---|
| gateway api1 | `api1.qoder.sh` | `gateway.qoder.com.cn` | `daily-api2.qoder.sh` | `test-api2.qoder.sh` |
| gateway api2 (model server utama) | `api2.qoder.sh` | `gateway.qoder.com.cn` | `daily-api2.qoder.sh` | `test-api2.qoder.sh` |
| gateway api3 | `api3.qoder.sh` | — | — | — |
| **model server v2 (gRPC)** | `api2-v2.qoder.sh` | `gateway.qoder.com.cn` | `daily-api2-v2.qoder.sh` | `test-api2-v2.qoder.sh` |
| center | `center.qoder.sh` | `gateway.qoder.com.cn` | `daily-center.qoder.sh` | `test-gateway.qoder.com.cn` |
| openapi | `openapi.qoder.sh` | `openapi.qoder.com.cn` | `daily-openapi.qoder.sh` | `test-openapi.qoder.sh` |
| dashboard | `qoder.com` | `qoder.cn` | `daily.qoder.ai` | `test.qoder.ai` |
| static/CDN | `static.qoder.com.cn/qoder-cli-cn` (CN) / `download.qoder.com` | | | |
| VPC user override | `vpc.qoder.com.cn` (CN) / kosong | | | |

Region (intl): `us → api1`, `sg → api2`, `jp → api3` (fallback list).

Map route (dari `Cde` + `yAe`):
- `inference` (chat HTTP): prod → `https://api2.qoder.sh` (CN: gateway), daily → daily-api2, test → test-api2.
- `securityInference` → host yang sama (api2/gateway).
- `center` (config service): prod → `https://center.qoder.sh` (CN gateway).
- `webSearch` → center host.
- `openapi` → openapi host.
- `base` → qoder.com / qoder.cn.

Endpoint config service: `/api/v3/service/region/endpoints` (V3) dan `/api/v5/service/region/endpoints` (V5), dengan header `x-gw-user-id` + Bearer + machine identity + response decryption. Ping: `/algo/api/v1/ping`.

### 3.2 Endpoint per permukaan (worker runtime + preload)

| Permukaan | Method & Path | Host (prod) | Catatan |
|---|---|---|---|
| Chat gRPC | `POST /model.chat.ChatService/ChatCompletionStream` | `api2-v2.qoder.sh:443` / `gateway.qoder.com.cn:443` | proto message `ChatCompletionRequest`; metadata `authorization`, `x-request-id`, `x-session-id`, `cosy-*` |
| Chat HTTP modern (probe IDE) | `POST /model/v1/chat/completions` | `api2-v2.qoder.sh` / gateway | OpenAI-shaped SSE chunks |
| Chat HTTP legacy COSY | `POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | api1/api2/api3 | free-tier; body di-sign WASM |
| Model list | `GET /api/v2/model/list?Encode=1` (opsional `&outerProviders=...`) | gateway | wasm signing + login + machine identity |
| Plan / Status / Quota | `GET /api/v2/user/plan`, `GET /api/v3/user/status`, `GET /api/v2/quota/usage` | openapi | response decryption |
| Usage presentation | `GET /sash/api/v2/me/usage` | openapi | |
| Daily check-in status/claim | `GET /sash/api/v1/me/daily-check-in/status`, `POST /sash/api/v1/me/daily-check-in/claim` | openapi | header `Cosy-ClientType:10` |
| Campaigns | `GET /sash/api/v1/me/campaigns`, `POST /sash/api/v1/me/campaigns/{id}/claim` | openapi | requireMachineIdentity |
| Device OAuth start | `GET /device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id[&machine_token]` | website | browser |
| Device token poll | `GET /api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` | openapi | 404 = belum siap |
| Device token refresh | `POST /api/v1/deviceToken/refresh` body `{refresh_token, machine_id, machine_token}` | openapi | |
| PAT→jobToken exchange | `POST /api/v1/jobToken/exchange` body `{personal_token, machine_id, machine_token}` | openapi | |
| jobToken refresh | `POST /api/v1/jobToken/refresh` body `{refresh_token}` | openapi | |
| User info / status augment | `GET /api/v3/user/status`, `GET /api/v1/organizations/{id}/tags` | openapi | |
| Business operation finish | `POST .../algo/api/v2/service/pro/sse/…` dengan `{payload, encodeVersion:"1"}` + `Encode=1` | gateway | wasm signing + machine identity |
| Queued model status | `POST …infer-queue-finish…` (path k0o) | gateway | `X-Request-ID`, `X-Session-ID` |
| Config service poll | `GET/POST /api/v3|v5/service/region/endpoints` (+ `x-gw-user-id`) | center | cache 86400s |
| Ping | `GET /algo/api/v1/ping` | gateway | probe |
| Cloud agents | `/api/v1/cloud` (prefix) | sitesOpenApiOrigin | |
| Marketplace | `GET /apphub/api/v1/marketplace/marketplace.json` | qoder.com / qoder.cn | |
| Docs | `https://docs.qoder.com/llms.txt` / CN `https://docs.qoder.cn/llms.txt`; static CN `https://static.qoder.com.cn/qoder-cli-cn/docs/llms.txt`; intl `https://download.qoder.com/qodercli/docs/en/llms.txt` | | |
| Externals registry | `https://download.qoder.com/qodercli/externals/registry.json` (intl) / `https://static.qoder.com.cn/qoder-cli-cn/externals/registry.json` (CN, env `QODERCLI_CDN_BASE_URL` override) | | |
| PortableGit tools | `https://download.qoder.com/qodercli/tools/PortableGit.7z.exe` (CN `download.qoder.com.cn`) | | |
| Updater | `https://download.qoder.com.cn/qoder-app/releases` | | electron-updater generic |
| OSS (security resources) | `https://qoder-ide.oss-accelerate.aliyuncs.com` (global) / `https://static.qoder.com.cn` (CN) | | untuk qoder-security assets |
| OAuth Google (lib) | accounts.google.com / oauth2.googleapis.com (bukan Qoder) | | bundled google-auth-library |

### 3.3 Permukaan lokal / internal

- **gRPC OTLP telemetry:** default `http://localhost:4317` (OTEL_EXPORTER_OTLP_ENDPOINT), Zipkin `http://localhost:9411/api/v2/spans`.
- **Daemon bridge SDK** (`remoteSdkDaemonBridge.js`): file 1396B di asar; bundle preload `pluginViewDiagramRuntime.cjs` merujuk `remoteSdkDaemonBridgePath` dan `sdkDaemonHookMockPreloadPath` (`qoderSdkDaemonHookMockPreload.js`, 7758B). Keduanya adalah bridge ke SDK agent daemon (child process / worker `qoder-worker-runtime`) — lihat §9.5. File aktual ter-obfuscate (`c()/f()/n()`), konten terverifikasi ada di asar namun isi final tidak readable.
- **WebSocket:** `ws` ada di node_modules; worker memakai fetch/undici; const `WebSocket` dipakai di beberapa tempat (MCP/kolaborasi).

---

## 4. Analisis Request

### 4.1 Header per permukaan

#### Chat gRPC (`vot`/`Qyl`/`openResponse`)
Metadata (gRPC) yang diset:
- `authorization: Bearer <access_token|security_oauth_token>`
- `x-request-id` (UUID, uppercase-normalized)
- `x-session-id`
- `cosy-version: 1.1.79-hotfix.11` (atau x9)
- `cosy-clienttype: <client_type>` (dari `Jl()`; default `5`; brand CN `6`; `assistant` scene → `5`)
- `cosy-machineos: x86_64_win32` (format `<arch>_<platform>`, arch: x86_64/aarch64)
- `cosy-machinehostname: <hostname sanitized>` (jika ada)
- Trace headers `traceparent` (dari OTel span), via `fO()`.

Channel options gRPC: `grpc.enable_http_proxy:0`, `grpc.default_authority`, `grpc.ssl_target_name_override` (host), `grpc.max_receive_message_length` di-set besar (adapter memakai 32MiB).

#### Chat HTTP modern (`openRoutedCall`, `sendModelServerHttpChat`)
Header:
- `Accept: text/event-stream`, `Content-Type: application/json`
- `Authorization: Bearer <token>`
- `X-Request-ID`, `X-Session-ID`
- Identity (`Cosy-Version`, `Cosy-ClientType`, `Cosy-MachineOS`, `Cosy-MachineHostname` saat `requestClass=infer-sse`)
- Trace headers `traceparent` dsb.
- Compression: `Accept-Encoding`/gzip via undici (onRequestCompression).

#### Chat legacy COSY (`prepareWasmInferRequest` / `YYe` + `z9i`)
- Header hasil `QoderContext.prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)`:
  - `authorization: Bearer COSY.<payload>.<signature>` (cara WASM; adapter: `Bearer COSY.<payload>.<signature>`)
  - `cosy-key`, `cosy-bodyhash`, `cosy-sigpath`, `cosy-machinetype/5`, `cosy-clienttype/5`, `appcode: cosy`, `signature` (MD5), dst. — lihat §8.
- Untuk service account (ent-prise): `Content-Type: application/json`, `Accept: text/event-stream`, tanpa header machine; jika bukan service account, `cosy-machinetoken` / `cosy-machinetype` dihapus lalu ditimpa dari UMID (`tct()`).

#### OpenAPI business (`openApiJsonRequest` / `fetchWithTrace`)
- `Accept: application/json`, `User-Agent: qoder/<version>`
- `Authorization: Bearer <token>` (jika ada)
- `Content-Type: application/json` saat body ada
- `X-Request-ID` di-inject (pipeline `kmA`), response decrypt via `decrypt_server_response`.

#### Model list (`/api/v2/model/list`)
- `withWasmSigning().requireLogin().withMachineIdentity()` → menambahkan signature `Sign` + machine headers.

#### Check-in `/sash`
- `Authorization: Bearer`, `Accept: application/json`, `User-Agent: Qoder`, `Cosy-ClientType: 10`, `Cosy-Version: <version>`, `Cosy-MachineId/Token/Type/Code/OS/Hostname` (jika native).

#### Endpoint center V5
- `x-gw-user-id: <userId>`, Bearer, machine identity, response decryption.

#### HMAC-canonical (untuk beberapa endpoint `X-Client-Timestamp` style)
Worker juga punya HMAC path (kode `oZt`): `X-Client-Timestamp`, `X-Request-Id`, `X-IDE-Platform: qoder_cli`, `X-Version`, `X-Machine-OS/Id/Type/Code`, `Authorization: Signature <sha256 hmac>` — signature string = `${method}\n${path}\n${requestId}\n${machineToken}\n${ts}\n${sha256(body)}` dengan key `sha256(cosy:ver:token)`; ini yang adapter sebut "legacy COSY sig path".

### 4.2 Payload

#### ChatCompletionRequest (gRPC / proto v1.1.79)
Model proto lengkap di §6. Struktur inti:
```jsonc
{
  "model": "…",
  "messages": [ { "role": "…", "text_content": "…" | "parts_content": { "parts": [...] },
                  "tool_calls": [], "tool_call_id": {"value":"…"}, "reasoning_content": {"value":"…"} } ],
  "stream": true,
  "stream_options": { "include_usage": {"value": true} },
  "max_tokens": {"value": N} | omit,
  "parallel_tool_calls": {"value": bool} | omit,
  "tool_choice": {"stringValue": "…"} | omit,
  "tools": [ { "type": "function", "function": { "name": "…", "description": {"value":"…"},
                "parameters": {"fields": {...}}, "strict": {"value": bool} } } ],
  "metadata": {
    "context": { "request_id": uuid, "session_id": "…", "task_id": "common",
                  "request_set_id": uuid, "client_type": "5", "source_session_id": "" },
    "business": { "product": "cli", "type": "agent", "version": "1.1.79-hotfix.11" }
  }
}
```

#### Chat HTTP modern (`/model/v1/chat/completions`)
OpenAI-shaped JSON, header X-Request-ID/X-Session-ID; response SSE `data: {...}` dengan `delta.content`, `delta.reasoning_content`, `delta.tool_calls`, `finish_reason`, `usage`, sentinel `[DONE]`.

#### Legacy COSY body
Body di-scramble alphabet (mapping `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/` → `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`), AES-128-CBC + RSA public key, `authorization` di-wrap. Detail di `qoder.ts` adapter (sudah port).

#### Device token exchange
- `POST /api/v1/jobToken/exchange` body: `{personal_token, machine_id, machine_token}`
- `POST /api/v1/deviceToken/refresh` body: `{refresh_token, machine_id, machine_token}`
- poll: query `nonce`, `verifier`, `challenge_method=S256`; response `{device_token, refresh_token, expires_at, refresh_token_expires_at}`.

#### Business finish / model usage
- `payload: JSON.stringify({...})`, `encodeVersion: "1"`, query `Encode=1`.

#### Model list query
`/api/v2/model/list?Encode=1` + optional `outerProviders=<comma-separated>`.

---

## 5. Analisis Response (Parsing)

### 5.1 SSE (chat HTTP modern & legacy)
- Transport: `fetch` (Node/undici) dengan `Accept: text/event-stream`; pipeline `UmA` + `wAe` routing; `n.sse()` iterasi (untuk `inference.remoteChat.stream`).
- Event format: baris `data: …` dengan payload JSON; sentinel `[DONE]` menutup stream.
- Worker memakai `EventSourceStream` (undici) dan `createFastMessageEvent`; parse `data:` lines, chain `event:`, `id:`, `retry:`.
- Khusus Qoder: JSON dapat mengandung raw newline di dalam string → adapter Cartethyia `decodeQoderSseEvents` toleran (akumulasi hingga JSON lengkap / `[DONE]`).
- Error mapping: `4xx` → `auth_error`/`rate_limit`/`http_error`/`server_error`; retry policy per route (f9i).

### 5.2 gRPC stream
- `ChatCompletionStream` → stream `ChatCompletionChunk`; fields: `id/object/created/model`, `choices[].delta.content/reasoning_content/tool_calls/role`, `choices[].finish_reason`, `usage`.
- `delta.tool_calls` adalah repeated Struct (`google.protobuf.Struct`) → wrapper `{fields: {...}}`; worker & adapter map ke `{id, index, type, function:{name, arguments}}`.
- `Hyl` helper: `{id, object:"chat.completion.chunk", created, ...}` — normalize ke OpenAI chunk.
- Error gRPC: status 16 auth, 13 quota, `details` berisi 413 → context length; statuses dipetakan ke `GatewayError` di adapter.

### 5.3 Legacy COSY response
- Response juga di-encrypt/`decrypt_server_response` (WASM) — JSON di-dekripsi sebelum parse (untuk endpoint yang `withResponseDecryption`).
- SSE frame enveloped: `data:` berisi payload yang perlu decrypt setelah decode.

### 5.4 Error umum
- `401` → auth_error, `429` → rate_limit, `>=500` → server_error.
- `10605 isQueued` (legacy `/algo/api`) → request di-queue (parking) — alasan adapter pilih gRPC/HTTP modern dulu.
- `quota exceeded` (code 116) pada gRPC untuk free-tier → fallback ke legacy COSY.

---

## 6. Proto & Parser

### 6.1 `chat.proto` (ditemukan utuh)
Lokasi: `app/resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/proto/chat.proto` (322 baris, identik dengan `vendor/qoder-proto/chat.proto` di repo Cartethyia). Isi utama:
- package `model.chat`, java package `com.qoder.grpc.model.chat`.
- enum `ReasoningEffort` (0..6).
- `ChatCompletionRequest` (field 1..24): model, messages, temperature, top_p, max_tokens, stream, stop, presence_penalty, frequency_penalty, n, user, seed, reasoning, parallel_tool_calls, logit_bias, tools, tool_choice(Value), response_format, modalities, stream_options, patches(map<string,ChatPatchList>), metadata(ChatMetadata), extras(Struct), custom_model.
- `ChatMessage` (1..12) dengan oneof content_type (`text_content`/`parts_content`), name, tool_calls, tool_call_id, tool_call_call_id, reasoning_content, reasoning_item, extends.
- `ContentPart/ImageUrl/InputAudio/CacheControl/ReasoningItem/StreamOptions/Function/Advisor/ToolCall/FunctionCall/Reasoning/ResponseFormat/JsonSchema` lengkap.
- `ChatMetadata` → WorkspaceMetadata/BusinessMetadata/ContextMetadata(request_id, session_id, task_id, request_set_id, machine_id, client_type, source_session_id)/UserMetadata.
- `CustomModelConfig` (BYOK) field: name, url, style, provider, type, model, parameters.
- `ChatPatch`: cache_id, action, position, content, name, rename_to, description, parameters.
- Response: `ResponseChatMessage` (role, content, reasoning_content, tool_calls repeated Struct, reasoning_item(Value), extends), `NonStreamChoice`, `ChatCompletionResponse` (code,id,object,created,model,choices,usage,extras), `StreamChoice`, `ChatCompletionChunk` (sama), `Usage` + `PromptTokensDetails{cached_tokens,cacheable_tokens}`, `CompletionTokensDetails{reasoning_tokens}`.
- Service:
  ```proto
  service ChatService {
    rpc ChatCompletion(ChatCompletionRequest) returns (ChatCompletionResponse);
    rpc ChatCompletionStream(ChatCompletionRequest) returns (stream ChatCompletionChunk);
  }
  ```

### 6.2 Parser kunci
- **tool_calls**: fragment delta (id/index/name/arguments) di-forward verbatim; client stitch by index/id. Worker state machine `vTe`/`Qat`.
- **JSON-RPC MCP**: `@modelcontextprotocol/client/server` dengan method seperti `initialize`, `notifications/initialized`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` (dari set `IVl` di worker — ini dipakai untuk forward header internal MCP: `X-Qoder-Model`, `X-Qoder-Session-Id`, `x-internal-session-id`, `x-internal-model-key`, `x-internal-business-id`, `X-Session-ID`, `X-RequestSet-ID`).
- **Event loop / streams**: `TransformStream` (stdin→stdout untuk MCP stdio), `ReadableStream` SSE; `pipeline` (undici) untuk fetch.
- **EventSource** spec: buffer, BOM check, crlf, last-event-id, retry.

---

## 7. HTTP/2/3 & Transport Details

- **Utama: `fetch` bawaan Node** (undici) — terdapat `setGlobalDispatcher`, `fetch/Headers/Response/Request/FormData/WebSocket/EventSource` exports undici di worker bundle. HTTP/2 dipakai oleh undici (internally), tidak ada HTTP/3 yang terlihat.
- **gRPC**: `@grpc/grpc-js` setara (worker pakai `grpc` di bundle; `acquireRoutedClient` → `new A.model.chat.ChatService(host, credentials.createSsl(), options)`); channel options `grpc.enable_http_proxy` & `ssl_target_name_override`.
- **HTTP proxy**: `grpc.enable_http_proxy:0` (proxy dimatikan untuk gRPC); fetch HTTP pipa `wAe` punya `bodyReplayable`, `idempotent`, stream timeouts.
- **IPv4/IPv6** helper `isIPv4`; HTTPDNS (`X-Qoder-HTTPDNS-IP` + `build_httpdns_url`, `get_httpdns_config/account_id/secret_key` dari WASM) — untuk resolusi host via DNS vendor.
- **WebSocket**: `ws` di node_modules (dipakai preload/plugin runtime; bukan transport chat utama).
- **Compression**: gzip/brotli via undici; `onRequestCompression`.
- **Timeouts**: `connectTimeoutMs`, `responseHeadersTimeoutMs`, `establishmentTimeoutMs`, `bodyIdleTimeoutMs`, `firstPayloadTimeoutMs`; retry addressFailover, maxAttempts, minRouteAttemptMs.
- **Cache endpoint**: `endpoint-cache` (ttl 86400s), polling `K8i=300000ms`, fallback ranking.

---

## 8. Cosy / WASM Signing & Machine Identity

### 8.1 WASM auth module
- Nama modul: `qoder_auth_wasm.js` + `qoder_auth_wasm_bg.wasm` (dari folder `pkg` relatif terhadap worker; juga bisa di-embed sebagai base64 — path `kol()`/`Dol`).
- Ekspor WASM (via `l1i`): `QoderContext`, `ProfileEncryptor`, `RequestResult`, `prepareInferRequest`, `prepareRequest`, `decrypt_server_response`, `credential_storage_encrypt/decrypt`, `generate_runtime_auth_fields`, `get_httpdns_account_id/config/secret_key`, `build_httpdns_url`, `get_profile_key_fingerprint`, `model_cache_encrypt/decrypt`, `profile_encrypt`.
- `QoderContext` di-bangun dengan `(machineId, cosyVersion, userInfoJson, clientInfoJson)`; `qxe()` memanggil `new i.QoderContext(...)`, `prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)` → `{url, headers, body}`.
- `prepareRequest(endpoint, path, method, mode, body, headersJson)` dengan mode `auth` / `sign` / `Get`/`PUT`.
- `generate_runtime_auth_fields(userInfo)` → `{encrypt_user_info, key}` (dipakai refresh).
- `decrypt_server_response` dipakai pada response business endpoint; `credential_storage_*` untuk menyimpan credential terenkripsi di disk.
- **HTTPDNS**: `build_httpdns_url` + `X-Qoder-HTTPDNS-IP`, `get_httpdns_account_id/secret_key`.

### 8.2 Header Cosy yang dihasilkan
Header dari WASM (`prepareInferRequest`/`prepareRequest`) + worker layer:
- `authorization: Bearer COSY.<payload>.<signature>`
- `cosy-key`, `cosy-bodyhash`, `cosy-sigpath` (mis. `/algo/api/v2/...`),
- `cosy-machinetype/5`, `cosy-clienttype/5` (brand CN `6`),
- `appcode: cosy`, `signature` (MD5 dari payload),
- header machine identity tambahan: `cosy-machineid`, `cosy-machinetoken`, `cosy-machinetype`, `cosy-machinecode`, `cosy-machineos`, `cosy-machinehostname` (dari UMID + client metadata).
- Identitas waktu: `cosy-version` = `1.1.79-hotfix.11` (worker) — adapter memakai 1.1.80/1.1.81.

### 8.3 Machine identity — UMID
- `app/resources/umid/manifest.json`: target win32-x64; runtime-info.exe (480,752 B) + sgsdk.dll (7,354,928 B); sha di-verifikasi oleh worker (`ztt` membandingkan SHA256 file seperti yang ada di manifest).
- Worker runtime: `umid` service (`j8i="umid"`), versi skema 1 (`V8i=1`), schema `{version, environment, platform, arch, info:{machineToken, machineType, machineCode, vmInfo:{isVm, brand, percentage, vmTypeCode}}}`.
- Binary di-embed (base64) atau diekstrak ke cache `umid-win32-<env>-<hash16>`, dengan binDir `runtime-info.exe` + `sgsdk.dll` (Windows). Memanggil `runtime-info.exe <env>` (env code — di adapter `ENV_CODE=3`); platform Linux/darwin menggunakan ELF/Mach-O (di luar artifact ini).
- Derivation `machine_id` lokal: hardware (`system()`/uuid/serial) → `sha256("qoder-machine-id:v1:<platform>:<uuid-lower>")` atau random UUID; disimpan di credential storage (`o8i`).
- UMID service refresh: stale 120s, update 10s, retry; cache disk restore; disable via env `DISABLE_UMID_REPORT=1|true|...`.
- Machine headers di HTTP: `Cosy-MachineId: <uuid>`, `Cosy-MachineToken: <machineToken>`, `Cosy-MachineType`, `Cosy-MachineCode`, `Cosy-MachineOS`, `Cosy-MachineHostname`.

---

## 9. SDK Internal

### 9.1 `@qoder-ai/qoder-agent-sdk` (dalam asar)
- `package.json` (970B) dan `dist/index.js` (230KB) di dalam asar **tidak match integrity header** — isi terbaca adalah Zod/Playwright (konten ter-transformasi). Yang valid & berguna adalah bagian unpacked: `dist/_worker/` (worker runtime) + `dist/protocol/index.js` (1500B) + `dist/runtime-manifest.json`.
- `runtime-manifest.json`: name `qoder-worker-runtime`, version `1.1.79-hotfix.11`, profile platform, target win32-x64, entrypoint `qoder-worker-runtime.obf.mjs`, git commit `0eb78f0`, build site global, productName qodercli; copiedPackages: `@img/colour`, `@img/sharp-win32-x64`, `@lydell/node-pty*`, `@silvia-odwyer/photon-node`, `detect-libc`, `keytar`, `node-addon-api`, `semver`, `sharp`; assets ripgrep `vendor/ripgrep/x64-win32/rg.exe`.
- Worker runtime berisi seluruh logika: endpoint config, auth (device flow, PAT exchange, service account), machine identity, grpc client, SSE, signing WASM, MCP server/client, telemetry OTel, model catalog, queueing, web security (qoder-security), plugin SDK, remote control, business metadata.
- Export SDK (dari `electronMain.js` import): `getSessionMessages`, `getSubagentMessages`, `listSubagents`, `renameSession`, `deleteSession`, `getSessionInfo`, `validatePlugin`, dsb.

### 9.2 `@modelcontextprotocol/*`
- Ter-depend: `client`, `core`, `node`, `sdk`, `server` (masing-masing dengan zod v4 bundled).
- `client` dist ada `index.cjs`/`index.mjs` (246/238KB) + `stdio.cjs/mjs` (6KB) dan `ajvProvider`/`cfWorkerProvider`.
- Electron main import: `@modelcontextprotocol/client`, `@modelcontextprotocol/client/stdio` (`getDefaultEnvironment`), `@modelcontextprotocol/server` (`createMcpHandler`, `Server`), `@modelcontextprotocol/node` (`toNodeHandler`, `localhostHostValidation`, `localhostOriginValidation`).
- Worker menyet header internal MCP (lihat §4.1): `X-Qoder-Model`, `X-Qoder-Model-Safety-Tag`, `X-Qoder-Session-Id`, `x-internal-session-id`, `x-internal-model-key`, `x-internal-business-id`, `X-Session-ID`, `X-RequestSet-ID` — dipakai untuk metode whitelist `IVl` (`initialize`, `notifications/initialized`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`).
- Transport yang terlihat: stdio (client/stdio), HTTP streamable (node server handler dengan hono/http2), SSE (EventSource di client). Tidak ada `SSEClientTransport`/`StreamableHTTPClientTransport` eksplisit di dist client, tapi `node`/`server` package menyediakan `toNodeHandler` + `localhostHostValidation` (MCP server lokal di localhost).

### 9.3 `aoq-electron-sdk`
- package.json 982B (konten juga tidak match sha). Native unpacked: `prebuilds/win32-x64/{alivcffmpeg.dll, AoqClientSdk.dll, aoq_node_ext.node, PluginOpus.dll}` — SDK audio/video (AoQ = Alibaba aMedia? kemungkinan untuk voice/real-time). Preload `pluginViewDiagramRuntime.cjs` tidak memakai; kemungkinan plugin UI.
- `js/AoqSdk.js` & `ts/IAoqClientEngine.ts` di dalam asar tercemar (Playwright/Zod), jadi API publiknya tidak bisa diverifikasi dari file ini.

### 9.4 Lainnya
- `eventsource` (npm) + `eventsource-parser` — dipakai worker undici + MCP.
- `jose` (JWT/OAuth), `ws` (WebSocket), `node-pty` (terminal), `keytar` (keychain), `sharp`+`@napi-rs/canvas`+`photon-node` (image), `croner`, `cross-spawn`, `yaml`, `zod`, `zod-to-json-schema`, `mammoth`/`xlsx`/`pdfjs-dist` (office/pdf), `electron-updater` (dari package root `app.asar` node_modules — `builder-util-runtime` ada).
- `hono` + `@hono/node-server` → server HTTP lokal (MCP node handler).

### 9.5 Daemon bridge & remote control
- `remoteSdkDaemonBridge.js` (1396B) dan `qoderSdkDaemonHookMockPreload.js` (7758B) adalah file main-process yang di-obfuscate dengan string-library `c()/f()/n()`; konten byte valid sesuai header asar (tapi hash tidak match karena transformasi build). Fungsionalitas diinfer dari pemanggil:
  - `pluginViewDiagramRuntime.cjs` (preload, 5MB): `remoteSdkDaemonBridgePath: v0(c5,...)` dan `sdkDaemonHookMockPreloadPath: v0(c5,...)`; `enterpriseDwsRuntime:{enabled, baseUrl: flx()}`; `remoteControl:{instanceId, scopeDatabaseProcessFactory, processFactory}`; `QODER_DEV_SHARED_BINARIES`.
  - Artinya: preload men-spawn daemon SDK (worker runtime) sebagai child process `serviceName` + `execArgv`, dengan `--account-stdin` pipe (matching `y8i` di worker) dan daemon bridge (hook mock preload) di-inject; kemungkinan besar ini adalah **SDK agent remote-control + session scope database** (`remoteControlScopeDatabase.js` 16KB, `remoteControlProcess.js` 7KB).
  - `dataDirectoryProcess.js` (6.7KB) — proses untuk data directory (progress page `dataDirectoryProgress.html`).
  - `pluginHost.js` (59KB) — host plugin (validate/install/runtime).
- Tidak ditemukan JSON-RPC end-to-end yang jelas untuk daemon; antara main↔worker memakai IPC/custom protocol internal (tidak dapat di-decode fully).

---

## 10. Perbandingan dengan Adapter Cartethyia

### 10.1 Tabel SAMA vs BEDA

| Aspek | Qoder desktop 0.5.3 (audit) | Adapter Cartethyia (qoder/*) | SAMA/BEDA |
|---|---|---|---|
| gRPC service path | `/model.chat.ChatService/ChatCompletionStream` | sama | **SAMA** |
| gRPC host prod | intl `api2-v2.qoder.sh`, CN `gateway.qoder.com.cn` | sama (`qoderGrpcHost`) | **SAMA** |
| proto | `chat.proto` 1.1.79-hotfix.11 | vendored di `vendor/qoder-proto/chat.proto` (dari v1.1.81) | **SAMA** (struktur identik) |
| gRPC metadata | `authorization Bearer`, `x-request-id`, `x-session-id`, `cosy-version`, `cosy-clienttype`, `cosy-machineos`, `cosy-machinehostname` | sama persis (qoderGrpcMetadata) | **SAMA** (versi beda) |
| cosy-version value | `1.1.79-hotfix.11` (worker) | `1.1.80` (metadata), `1.1.81` (business version), getQoderVersion() | **BEDA (versi)** |
| cosy-clienttype | brand `5` (intl), `6` (CN); scene `assistant` → 5 | `5` (gRPC metadata), `10` untuk campaigns | **SAMA 5; BEDA 10 vs worker** (worker pakai 10 untuk /sash campaign) |
| HTTP chat modern | `POST /model/v1/chat/completions`, `X-Request-ID`, `X-Session-ID`, Bearer | `QODER_IDE_CHAT_PATH` sama; `qoderIdeChatUrl` | **SAMA** |
| Legacy COSY path | `/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | `QODER_CHAT_PATH` identik | **SAMA** |
| Model list | `GET /api/v2/model/list?Encode=1` (+outerProviders) | `QODER_MODELS_PATH` identik | **SAMA** |
| Signing | WASM `QoderContext.prepareInferRequest` (AES-CBC + RSA, alphabet scramble, header kosy) | Donor `qoder.ts` COSY (AES-128-CBC + RSA key, alphabet `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`) | **SAMA** (wan port sama) |
| Cosy keys | `cosy-key`, `cosy-bodyhash`, `cosy-sigpath`, `cosy-machinetype/5`, `appcode:cosy`, `signature` MD5 | Sama di adapter | **SAMA** |
| Header machine | `Cosy-MachineId`, `Cosy-MachineToken`, `Cosy-MachineType/Code/OS/Hostname` | `qoderMachineHeaders` menghasilkan persis header ini (cosy-*) | **SAMA** |
| Machine id derivation | `sha256("qoder-machine-id:v1:<platform>:<uuid>")` + random fallback | adapter: `machineId` UUIDv4-ish dari donor hub, native UMID token `P1gA...` | **BEDA (format token)** — worker: UMID machineToken dari runtime-info (umidpack); adapter: native UMID bridge + generated `P1gA` |
| Device OAuth | `client_id` dari `_$d1` (obfuscated, tidak terbaca), PKCE S256 + machine_id, redirect `qoder://aicoding.aicoding-agent/login-success` (intl) / `qoder-work-cn://` (CN) | clientId intl `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`, CN `e93fe488-5778-4c35-a6fc-0f54ed7b3139`, redirect sama | **SAMA redirect; BEDA clientId** (tidak bisa dibandingkan — ter-obfuscate) |
| Device poll/refresh | `/api/v1/deviceToken/poll`, `/api/v1/deviceToken/refresh` (body incl machine_id+machine_token) | sama | **SAMA** |
| PAT→jobToken | `POST /api/v1/jobToken/exchange` `{personal_token, machine_id, machine_token}` | intl & CN kini v1 (`center`/`openapi`/api/v1/jobToken/exchange`, JSON plain) — dulu intl v3 `https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1` | **SAMA (v1)** setelah fix 2026-11-05 |
| jobToken refresh | `/api/v1/jobToken/refresh` `{refresh_token}` | tidak ada di adapter (tidak terpakai) | **BEDA** |
| Quota/plan | `/api/v2/user/plan`, `/api/v3/user/status`, `/api/v2/quota/usage`, `/sash/api/v2/me/usage` | adapter `qoder-quota.ts` (baca jika perlu) — endpoint sama ASCII | **SAMA** |
| Check-in | `/sash/api/v1/me/daily-check-in/status` + `/claim`, campaigns `/sash/api/v1/me/campaigns` | `qoder-checkin.ts` persis (status/claim/campaigns) | **SAMA** |
| Campaign headers | `Cosy-ClientType:10`, `Cosy-Version`, UA `Qoder` | `buildCampaignHeaders` (10) | **SAMA** |
| Updater | `download.qoder.com.cn/qoder-app/releases` | tidak relevan | — |
| Marketplace | `/apphub/api/v1/marketplace/marketplace.json` | tidak di adapter | — |
| HTTPDNS | `X-Qoder-HTTPDNS-IP`, wasm httpdns | tidak di adapter (belum) | **BEDA** |
| Telemetry | OTLP localhost:4317 / Zipkin localhost:9411 | OTel juga (adapter tidak mengarah ke localhost Qoder) | **BEDA** |
| MCP | @modelcontextprotocol v2025, stdio/node/http | tidak di adapter | — |
| Office reader | .NET wasm + pdf/mammoth | tidak di adapter | — |
| Machine hostname default | `cosy-machinehostname` dari `os.hostname()` sanitized | adapter sanitized `qoderMachineHostname()` — dulu hard-code `DESKTOP-QODER` (fixed 2026-11-05) | **SAMA** |
| `X-IDE-Platform` | `qoder_cli` (HMAC path) | tidak di adapter (adapter tidak pakai HMAC canonical) | **BEDA** |
| `X-Client-Timestamp` signature | `Authorization: Signature <hmac>` | tidak (adapter pakai COSY Bearer) | **BEDA** |
| gRPC payload metadata business version | `1.1.79-hotfix.11` | `1.1.81` (donor) | **BEDA (versi)** |

### 10.2 Analisis

1. **Adaptor sudah sangat akurat** terhadap donor desktop: host gRPC, path legacy, proto, device flow, campaign headers, model list — semua cocok. Ini konsisten dengan riwayat riset Cartethyia (source donor `qoder2api-hub` + unpacked 1.1.81).
2. **Perbedaan utama karena versi**: worker ini `1.1.79-hotfix.11`, sedangkan adapter memakai `1.1.80/1.1.81`. Header `cosy-version` dan `business.version` harus disamakan bila ada server yang memvalidasi; tidak ada bukti di artifact bahwa versi tersebut di-reject.
3. **Perbedaan klaim yang signifikan**:
   - `PAT→jobToken exchange` — adapter memakai endpoint v3 lama `center.qoder.sh/algo/api/v3/user/jobToken`; worker memakai `/api/v1/jobToken/exchange` di openapi. **Keduanya mungkin valid** (dua generasi), tapi bila job exchange v1 ada di openapi, itu lebih modern. Adapter CN sudah memakai openapi v1.
   - machine identity: worker tidak memakai format `P1gA` (token=88 base64url) — itu dari donor hub; worker pakai UMID runtime-info token. Adapter mendukung native bridge (umidpack) dan fallback `P1gA` — kompatibel karena hanya dikirim sebagai `Cosy-MachineToken`, tidak di-parse server (kemungkinan).
   - `cosy-clienttype:10` di campaigns, `5/6` di chat — adapter sudah benar.
4. **Yang belum ada di adapter** (peluang riset lanjut): HTTPDNS signature (`X-Qoder-HTTPDNS-IP` + WASM), HMAC canonical (`X-Client-Timestamp`/`Signature`), `jobToken/refresh`, `/sash/api/v2/me/usage`, `x-internal-*` MCP headers, updater, `apphub`, `qoder-security` offline scanning.
5. **Catatan keamanan**: `app.asar` hampir seluruhnya tidak match SHA — artinya sistem build Qoder melakukan transformasi (kemungkinan obfuscation + inline) yang tidak tercermin di header integrity. Kartografi di laporan ini bersumber dari byte yang ada di disk (worker unpacked + preload), bukan dari hash build.

---

## 11. Temuan Menarik Lain

1. **`qoder-security` vendor** — bundle keamanan terpisah: bin `qodersec-launch`, `qodersec-update`, `bootstrap.cmd/sh`, `security-scan-settings` + `rg.exe` (ripgrep). Ini menunjukkan fitur scan security (map file, pattern) di dalam IDE.
2. **`qoder-sites`** — asset untuk pengembangan "sites" (Qoder Cloud sites): `cloud-agents.mjs`, `conversation-stream.mjs`, `qca-realtime.mjs`, SSE chat, websocket, OIDC/password application-auth. Endpoint `sitesOpenApiOrigin` + `/api/v1/cloud`.
3. **Office-reader .NET WASM** — `OfficeReader.wasm`, `DocumentFormat.OpenXml.wasm`, `dotnet.*` + `pdfjs-dist` serta `mammoth`, `xlsx`. Ini adalah renderer file office asli (docx/pdf/xlsx) yang berjalan di browser worker.
4. **Perangkat lunak MCP**: server node (hono + http2) dengan `localhostHostValidation`/`localhostOriginValidation` — artinya Qoder menjalankan MCP server lokal (stdio/HTTP) di localhost, dan proxy ke model via header `X-Qoder-Model` dll.
5. **Telemetry OTel** ter-bundle penuh: OTLP gRPC/http + Zipkin + console; default localhost 4317/9411 — cocok untuk observability lokal; di produksi kemungkinan env override.
6. **`enterpriseDwsRuntime`** di preload diagram — runtime enterprise (DWS) dengan `baseUrl`; kemungkinan Qoder Enterprise / dedicated workspace server (config `QODER_DEV_SHARED_BINARIES`).
7. **`remoteControlScopeDatabase` + `remoteControlProcess`** — sinkronisasi session/scope antar proses (file lock `qoder-branch-operation.lock`, `qoder-work-session-product-mode-repair.sql`).
8. **`X-Qoder-HTTPDNS-IP`** — DNS resolver HTTP sendiri (untuk CN/GFW workaround).
9. **`/algo/api/v1/ping`** probe + endpoint cache `endpoint-cache` + `vpc.qoder.com.cn` — untuk region/self-host VPC.
10. **`static.qoder.com.cn/qoder-cli-cn`** & `download.qoder.com/qodercli` — CDN untuk tooling (PortableGit, docs, externals).
11. **`keytar`** (keychain), `node-pty` (+conpty), `sharp`/`@napi-rs/canvas`/`photon-node` — native modules untuk image + terminal.
12. **`qoder_auth_wasm`** module di-embed base64 atau file — detail di §8.1.

---

## 12. Evidence Ledger

| Klaim | File / Offset / Pencarian |
|---|---|
| Identitas build | `app/resources/build-manifest.json` (baris 1-15); `app/resources/product.json`; `app/resources/app-update.yml` |
| UMID manifest | `app/resources/umid/manifest.json`; runtime-info.exe PE32+ x64, sgsdk.dll PE32+ DLL — `file` output |
| gRPC path & proto | `app/resources/app.asar.unpacked/.../dist/_worker/proto/chat.proto` (baris 1-322); `qoder-worker-runtime.obf.mjs` — `ChatCompletionStream` (3x), `ChatService`, `model.chat`, `acquireRoutedClient`, `ChatCompletionStream(A.grpcRequest,A.metadata)` |
| Host mapping | `qoder-worker-runtime.obf.mjs` — blok `Mq/fw/vq/w9/S9/JYA/D9/Fq/Hce/GYA/PL/Jce/vJe/Gce/YYA/KE/Qq/Nq/Lq`, `Cde`, `Uel`, `yAe`, `W8e`, `oBa` (dashboard origins), `clg` (sites APIs: api.qoder.com / api.qoder.com.cn) |
| Model server host | `function oWi()` (env `QODER_MODEL_SERVER_HOST` fallback `yIl[env]`), `function Mot()` (`/model/v1/chat/completions`), `function XTn()` (`:443`) |
| gRPC metadata | `function Qyl()` (`cosy-version/clienttype/machineos/machinehostname`), `vot()` (`authorization Bearer`), `l.set("x-request-id")`, `l.set("x-session-id")` |
| HTTP chat modern headers | `sendModelServerHttpChat` (`Accept: text/event-stream`, `X-Request-ID`, `X-Session-ID`), `Ghl` (path detection) |
| COSY/wasm | `qxe()`, `HYe()`, `k6()`, `h8i()`, `prepareInferRequest`, `prepareRequest`, `decrypt_server_response`, `credential_storage_*`, `generate_runtime_auth_fields`, `get_httpdns_*`, `QoderContext` (5 refs), `qoder_auth_wasm_bg.wasm` url, `kol()`/`Dol()` embed path |
| Machine identity | `Col()`/`r8i()` (SHA256 `qoder-machine-id:v1`), `o8i`/`s8i` (auth-storage), `Wxe` UMID class + schema `nsl` (machineToken/Type/Code/vmInfo), `ztt/Yol/b8i` (verify/extract bundle), `T8i="umid-win32-"`, `tct()` (`Cosy-MachineToken/Type`), `Ssl()` (`Cosy-MachineId/Token/Type`) |
| Device OAuth | `Rpl()` (`/device/selectAccounts?` + `machine_id` + `client_id`), `Ppl/kpl` (client id obfuscated), `pollForCompletion` (`/api/v1/deviceToken/poll`), `refreshDeviceToken` (`/api/v1/deviceToken/refresh`), `exchangePersonalToken` (`/api/v1/jobToken/exchange`), `refreshJobToken` (`/api/v1/jobToken/refresh`) |
| Business endpoints | `Vyg/qyg/Wyg/Kyg`, `AKt` (`withResponseDecryption`), `/sash/api/v1/me/campaigns`, `rKt`, `buildCampaignHeaders` mirror di adapter |
| Endpoint config/ping | `ant="/api/v3/service/region/endpoints"`, `W8i="/api/v5/service/region/endpoints"`, `lnt="/algo/api/v1/ping"`, `GK()` (`/algo` suffix ensure), `Z8i` (`x-gw-user-id`) |
| MCP | electronMain import list (`@modelcontextprotocol/*`), worker `IVl` set, `kdt` TransformStream, `hVl` header list, `toNodeHandler`/`localhostHostValidation` |
| Telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` default `http://localhost:4317`, `OTEL_EXPORTER_ZIPKIN_ENDPOINT` default `http://localhost:9411/api/v2/spans` (3-7 refs) |
| Updater | `product.json` desktopUpdateDownloadBaseUrl; `app-update.yml` |
| CDN/docs/marketplace/externals | `jYA`, `XYA`, `zYA`, `_YA`, `VZu`, `qZu`, `n2A` (PortableGit), `S5r` (settings.schema.json) |
| OSS | `lDa` (`https://qoder-ide.oss-accelerate.aliyuncs.com`, `https://static.qoder.com.cn`); `KR0`/`n7f` (OSS URL validation + signed URL format) |
| HMAC canonical | `oZt.applyHmac` (`X-Client-Timestamp`, `X-Request-Id`, `X-IDE-Platform: qoder_cli`, `X-Machine-*`, `Authorization: Signature`), `vkg()` → `cosy` (base64 reversed `Y29zeQ==`) |
| Preload daemon bridge | `pluginViewDiagramRuntime.cjs` (`remoteSdkDaemonBridgePath`, `sdkDaemonHookMockPreloadPath`, `enterpriseDwsRuntime`, `remoteControl`) |
| Integrity skew | verifikasi SHA-256 computed vs header di 6396 file: hanya 16 match (0.3%) |
| Worker identity | `dist/_worker/runtime-info.json` (versi/commit/packages) |

---

## 13. Yang Belum Bisa Diverifikasi

1. **`remoteSdkDaemonBridge.js` / `qoderSdkDaemonHookMockPreload.js`** — isi ter-obfuscate (`c()/f()/n()` string library) sehingga protokol IPC daemon tidak bisa di-decode penuh; hanya inferensi dari pemanggil preload.
2. **Client ID OAuth** (`Ppl`/`kpl`) — disimpan lewat `_$d1` (XOR obfuscation), tidak terbaca; tidak bisa dibandingkan dengan `e883ade2...`/`e93fe488...` milik adapter.
3. **`app.asar` mismatch integrity** — tidak bisa dipastikan apakah Qoder sengaja men-transformasi file (obfuscation) atau header integrity bukan SHA dari konten final; konsekuensi: hash build tidak bisa diverifikasi dari file yang ada.
4. **`@qoder-ai` package.json / dist/index.js** — konten asli tidak readable (tercemar konten Zod/Playwright); hanya worker unpacked yang valid.
5. **`aoq-electron-sdk`** — API publik / fungsi AoQ tidak bisa dibaca (konten tidak valid); native DLL ada.
6. **`qoder_auth_wasm_bg.wasm`** — file WASM tidak ditemukan sebagai file terpisah di unpacked (di-embed base64 di worker bundle); tidak diekstrak (binary, di-skip). Algoritma AES/RSA/alphabet diverifikasi via behavior + adapter donor, bukan dari byte WASM.
7. **HTTP/3** — tidak ditemukan referensi (hanya HTTP/1.1 + HTTP/2 via undici/grpc); tidak ada bukti HTTP3.
8. **Detail `qoder-security`** — hanya binary launcher + assets; isi scanning engine tidak di-audit.
9. **`startDeviceFlow` browser URL** — `Ppl/kpl` tidak terbaca; redirect scheme diambil dari `qoder-realm` adapter (intl `qoder://aicoding.aicoding-agent/login-success`, CN `qoder-work-cn://`).
10. **MITM/run-time behavior** — tidak dijalankan; seluruh analisis statis.

---

*Ditulis oleh subagent audit reverse-engineering Cartethyia. Sumber utama: `qoder-worker-runtime.obf.mjs` (unpacked), `proto/chat.proto`, `app/resources/umid/manifest.json`, `product.json`, `build-manifest.json`, `app-update.yml`, preload diagram, dan adapter Cartethyia `src/providers/integrations/qoder/`.*
