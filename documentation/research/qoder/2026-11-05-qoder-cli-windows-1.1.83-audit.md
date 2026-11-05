# Audit Qoder CLI Windows v1.1.83 (unpacked) — 2026-11-05

**Artefak:** `D:\tmp\unpacked\qoder\qoder-cli-windows-x64\` (hasil unpack `qodercli-windows-x64.zip`, v1.1.83)
**Metode:** statis penuh — string scan, grep, dan pembacaan file/source yang dapat dibaca. **Tidak ada binary yang dijalankan.**
**Sifat bukti:** logika jaringan asli CLI mayoritas ada di bytecode JSC (`bytecode/*.jsc`, ~40 MB) yang **tidak dapat dibaca ulang** (string pool hanya berisi identifier runtime JSC, bukan string aplikasi). Semua klaim di bawah ditandai berdasarkan di mana bukti ditemukan: **readable** (source JS asli yang ikut ter-unpack), **binary/bytecode** (hanya bisa dilihat byte/stringnya), atau **inferensi** (dari konvensi, nama, dan kebetulan).

---

## 1. Ringkasan eksekutif

Audit lengkap atas Qoder CLI Windows 1.1.83 (build Bun `qodercli.exe`, `.bun` section 133,7 MB) menghasilkan temuan inti berikut:

1. **Artefak adalah bundle Bun compiled dengan bytecode JSC.** `qodercli.js` (509 KB) berisi 26 seksi `// @bun @bytecode`; hampir semua modul logika di-*compile* ke bytecode JSC (431 file `.jsc`, 427 modul bytecode + 1 tanpa). Sebagian kecil modul ikut dalam bentuk source JS asli (mis. `modules/0013` — modul konfigurasi/lingkungan, `modules/0012` — loader native, `modules/0014` — redaksi/sanitasi log, `modules/0016` — brand + kunci telemetry OTel, plus dependensi pihak ketiga murni: zod, commander, semver, picocolors, dll).

2. **Permukaan jaringan yang *terlihat* di modul readable adalah konfigurasi host, bukan kode panggilan.** `modules/0013` mengekspos seluruh keluarga host: `api1/api2/api3.qoder.sh`, `center.qoder.sh`, `openapi.qoder.sh`, `daily-*`, `test-*`, `qoder.com`, `docs.qoder.com`, `daily.qoder.ai`, `test.qoder.ai`, plus URL update (`/upgrade`), marketplace (`/apphub/api/v1/marketplace/marketplace.json`), dan header `X-Qoder-HTTPDNS-IP`. Namun **tidak ada satu pun path `/algo`, gRPC, atau kosong COSY yang muncul di kode readable** — semua logika chat asli berada di bytecode.

3. **Tidak ditemukan jejak COSY/WASM signer di CLI ini.** Scan menyeluruh (`QoderContext`, `credential.wasm`, `qoder_auth_wasm_bg`, `prepareInferRequest`, `prepareRequest`, `generate_runtime_auth_fields`, `transformQoderBody`, `agent_chat_generation`, `ChatService`, `ChatCompletionStream`, `cosy`, `COSY`) menghasilkan **nol hit** di seluruh tree (qodercli.js, modules, assets, bytecode). `photon_rs_bg.wasm` terbukti murni pustaka image-processing (exports: blur, resize, watermark, crop, dll). Satu-satunya jejak "machine identity" di CLI hanyalah flag env `QODER_DISABLE_UMID_REPORT` dan kunci telemetry `machine_id_hash`/`machine_id_digest` — *bridge* umid asli (ELF/PE/Mach-O `runtime-info`) tidak ikut di-unpack dari zip ini (adapter Cartethyia menyimpannya di `vendor/qoder-umid/`).

4. **Aset `.mjs` yang ikut di-unpack adalah SDK server-side produk "Qoder Sites / Cloud Agents" (QCA), bukan klien chat CLI.** Mereka mendokumentasikan protokol modern yang berbeda: REST `/api/v1/cloud/*` + SSE `event_deltas[]=agent.message` + WebSocket realtime `/api/v1/forward/realtime?conversation_id=conv_*` (envelope `voice.realtime.v1`). Ini penting untuk perbandingan: **ada beberapa generasi permukaan Qoder**, dan CLI 1.1.83 yang satu yang kodenya tertutup bytecode.

5. **Kesimpulan untuk adapter Cartethyia:** keluarga host yang dipakai adapter (`api1/2/3.qoder.sh`, `center`, `openapi`) **sama persis** dengan konstanta CLI. Namun detail protokol (COSY AES/RSA manual, scrambled body, envelope `statusCodeValue`/`body`/`[DONE]`, gRPC `model.chat.ChatService/ChatCompletionStream` dengan `metadata.context/business`, job-token exchange) **tidak dapat diverifikasi langsung dari artefak ini** karena berada di bytecode; kesamaan yang tercatat sekarang berasal dari dokumen riset adapter sebelumnya (desktop client v1.1.81 `qoder-worker-runtime.mjs`, lihat `documentation/research/qoder/`), bukan dari zip 1.1.83 ini.

---

## 2. Identitas artefak

| Atribut | Nilai | Sumber |
| --- | --- | --- |
| Nama source | `qodercli.exe` | `manifest.json` |
| Versi | `1.1.83` | hardcoded di `modules/0012` (`let H="1.1.83"`), manifest run log `cli_version "1.1.83"` (`modules/0014`) |
| Format container | PE, section `.bun` (file_offset 85.822.464, size 133.765.086) | `manifest.json` |
| Bundle JS | `qodercli.js`, 509.000 byte, utf-8, offset 148.830.387 | `manifest.json` |
| Encoded | `bytecode_compiled: true`, `bytecode_module_count: 427`, `module_count: 428` | `manifest.json` |
| Module graph | 673 file, startup 8, loaders jsx 430/file 243, flags 2047 (termasuk `cross_compiled_bytecode`, `has_bytecode_string_table`) | `manifest.json` |
| Entry | `B:/~BUN/root/qodercli` (shebang `#!/usr/bin/env node`) | `manifest.json` modules[7] |
| Bytecode | 431 file `.jsc`, total 40.061.648 byte; `index.json` mencatat `header_valid_count: 0` (header JSC tidak valid untuk parsing mandiri) | `bytecode/index.json` |
| Aset | 243 aset decompressed (`assets.json`), termasuk native (libvips-42.dll, sharp-win32-x64.node, conpty.node, rg.exe), wasm photon_rs, dan file service `.mjs`/`.md`/`.ts`/`.json` | `assets/assets.json` |
| Perbedaan nama | `qoder_cli` = `qodercli` = `qoder-cli`; brand default di `modules/0016`: **"Qwen Code"** (`cliName "Qwen Code"`, `cliBin "qwen"`, `cliSlug "qwen-code"`) — garis keturunan sama dengan Qwen Code/opencode | `modules/0016` |

**Struktur bundle `qodercli.js`:** 26 seksi diawali `// @bun @bytecode`; seksi pertama berisi source asli (validasi nama direktori config) lalu sisanya campuran source asli modul inti (0013-style) dan stub bytecode yang tidak bisa dibaca.

---

## 3. Peta permukaan jaringan

### 3.1 Hostname yang muncul di artefak (readable, `modules/0013` + qodercli.js)

| Konstanta | Nilai | Keterangan |
| --- | --- | --- |
| `yb` | `qoder.sh` | suffix host inti |
| `xH` | `qoder.com` | website global |
| `SJ` | `docs.qoder.com` | dokumentasi |
| `Dd` | `api1.qoder.sh` | gateway/inference #1 |
| `Xo` | `api2.qoder.sh` | gateway/inference #2 |
| `Ed` | `api3.qoder.sh` | gateway/inference #3 |
| `Tc` | `center.qoder.sh` | center (jobToken v3) |
| `Sf` | `openapi.qoder.sh` | openapi/business |
| `bf` | `daily-api2.qoder.sh` | daily env |
| `Id` | `daily-center.qoder.sh` | daily env |
| `pE` | `daily-openapi.qoder.sh` | daily env |
| `Wa` | `test-api2.qoder.sh` | test env |
| `aM` | `test-repo2.qoder.sh` | test env |
| `DE` | `test-openapi.qoder.sh` | test env |
| `Xr` | `""` (kosong) | slot CN (bukan host literal) |
| `Jl` | `https://qoder.com` | website |
| `Yl` | `https://daily.qoder.ai` | daily env |
| `Xl` | `https://test.qoder.ai` | test env |
| `bJ` | `https://qoder.com/upgrade` | endpoint update |
| `TJ` | `https://qoder.com/apphub/api/v1/marketplace/marketplace.json` | marketplace plugin |
| `n` | `https://download.qoder.com/qodercli/tools` | unduhan tool (PortableGit.7z.exe, 7zr.exe) |
| `iyIA` | `https://raw.githubusercontent.com/qoder-cli/qoder/main/schemas/settings.schema.json` | skema settings |
| `Kl` | `X-Qoder-HTTPDNS-IP` | **header HTTPDNS** |

Env override yang diekspos modul config (semua `QODER_*`): `CENTER_ENDPOINT`, `VPC_ENDPOINT` + `ENV_VPC_ENABLED`, `SERVER_ENDPOINT`, `HTTPDNS`, `PERSONAL_ACCESS_TOKEN`, `JOB_TOKEN`, `SERVICE_ACCOUNT_KEY`, `MESSAGING_SOCKET` + `MESSAGING_SELF_TOKEN`, `REMOTE_CONTROL_SERVER`, `CLIENT_TYPE` (default `"5"`), `CLIENT_VERSION`, `BUSINESS_PRODUCT` (default `cli`), `BUSINESS_TYPE` (default `agent`), `SCENE` (default `assistant`), `DISABLE_UMID_REPORT`.

Fungsi `Kr()` mengembalikan triplet identitas per-request: `{ client_type: process.env[CLIENT_TYPE] ?? "5", business_product: … ?? "cli", business_type: … ?? "agent", scene: … ?? "assistant" }`.

### 3.2 Channel unduhan / update (bootstrap & qodersec launcher)

| Channel | URL manifest | URL binary |
| --- | --- | --- |
| Global | `https://download.qoder.com/qodercli/channels/1.1.41/manifest.json` | `https://download.qoder.com/qodercli/tools/...` |
| CN | `https://static.qoder.com.cn/qoder-cli-cn/channels/1.1.41/manifest.json` | `https://static.qoder.com.cn/...` |
| qodersec global | `https://qoder-ide.oss-accelerate.aliyuncs.com/security/qodersec/<ver>/codesec-cli-windows-<arch>.zip` | pin 0.9.5 |
| qodersec CN | `https://static.qoder.com.cn/security/qodersec/<ver>/...` | pin 0.9.5 |

(`assets/0230`, `assets/0232`; versi pin: QODERSEC_CLI_VERSION_GLOBAL/CN=0.9.5, QODERCLI_VERSION_GLOBAL/CN=1.1.41; binary CN = `qoderclicn`.)

### 3.3 Endpoint & method per surface (semua dari file readable)

**A. Cloud Agents "Managed" API (REST, `assets/0034` + `assets/0051`):**
| Method | Path | Catatan |
| --- | --- | --- |
| GET | `/api/v1/cloud/models?limit=100[&page=…]` | discovery model |
| POST | `/api/v1/cloud/agents` | `{name, model, system?, tools?, metadata?}` + `Idempotency-Key` |
| POST | `/api/v1/cloud/environments` | `{name, config:{type:"cloud"}}` |
| POST | `/api/v1/cloud/sessions` | `{agent, environment_id}` |
| POST | `/api/v1/cloud/sessions/{id}/events` | `{events:[{type:"user.message",content:[{type:"text",text}]}]}` |
| GET | `/api/v1/cloud/sessions/{id}/events?order=asc&limit=100[&page=…]` | history |
| GET | `/api/v1/cloud/sessions/{id}/events/stream?event_deltas%5B%5D=agent.message` | SSE deltas |
Auth: `Authorization: Bearer <QODER_PAT>` (PAT server-side), `Accept: application/json | text/event-stream`, opsional `Idempotency-Key`, `Last-Event-ID` untuk resume.

**B. Forward Realtime (WSS, `assets/0036` + `assets/0055`):**
| Method | Path | Catatan |
| --- | --- | --- |
| POST | `/api/v1/forward/realtime/conversations` | `{identity_id:"idn_…", template_id:"tmpl_…", title}` + `Idempotency-Key`; respon `conv_*`, `status:"ready"` |
| WSS | `/api/v1/forward/realtime?conversation_id=<conv_*>` | envelope `{version:"voice.realtime.v1", type, payload}` |

**C. Permukaan lain yang ditemukan di aset doc (bukan kode CLI):** `/functions/v1/app…` (routes aplikasi website), `https://oauth2.googleapis.com/token`, `https://api.github.com/user` dll (OAuth site SDK), `https://YOUR_SITE/functions/v1/app/auth/callback/{google,github}` (template).

**D. Endpoint chat yang diketahui dari riset adapter (cartethyia) — bukan tercatat di zip ini:**
- Legacy COSY: `POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
- Model list: `GET /algo/api/v2/model/list?Encode=1`
- Job token: `POST /algo/api/v3/user/jobToken?Encode=1` (intl) / `POST /api/v1/jobToken/exchange` (CN)
- Device token: `POST /api/v1/deviceToken/poll`, `POST /api/v1/deviceToken/refresh`
- IDE modern: `POST /model/v1/chat/completions`
- gRPC: `model.chat.ChatService/ChatCompletionStream` @ `api2-v2.qoder.sh:443` (intl) / `gateway.qoder.com.cn:443` (CN)

---

## 4. Analisis request

### 4.1 Header per surface

**Tabel header — SDK Cloud Agents (readable, `assets/0034`):**

| Header | Nilai | Kapan |
| --- | --- | --- |
| `Authorization` | `Bearer <QODER_PAT>` | selalu |
| `Accept` | `application/json` / `text/event-stream` | REST / SSE |
| `Content-Type` | `application/json` | saat ada body |
| `Idempotency-Key` | `[A-Za-z0-9._:-]{1,200}` | POST idempotent |
| `Last-Event-ID` | `evt_[A-Za-z0-9_-]{1,200}` | resume SSE |

**Tabel header — qodersec (bootstrap/launcher, readable):** memakai env (`QODERSEC_HOME`/`CODESEC_HOME` → `~/.qodersec`), bukan header khusus; download via `Invoke-WebRequest` (PowerShell) dengan `-TimeoutSec 900`.

**Tabel header — adapter Cartethyia (dari kode adapter, di luar zip):**

| Surface | Header & nilai |
| --- | --- |
| COSY legacy (HTTP) | `authorization: Bearer COSY.<payload>.<signature>`, `cosy-data-policy: agree`, `cosy-machinetype: 5`, `cosy-machineos`, `cosy-clienttype: 5`, `cosy-date` (epoch), `cosy-user`, `cosy-key` (RSA-PKCS1-encrypted AES key), `cosy-bodyhash` (MD5 body), `cosy-bodylength`, `cosy-sigpath`, `cosy-organization-id/tags`, `x-request-id`, `cosy-business-product/type/version/scene`, `cosy-version`, `login-version: v2`, `appcode: cosy`, `accept: application/json`, `accept-encoding: identity`, `date` (UTC string), `signature` (MD5(appcode&secret&date)), `content-type: application/json`, `user-agent: Go-http-client/2.0`; modern menambah `x-model-key`, `x-model-source`, `Accept: text/event-stream`, `Cache-Control: no-cache` |
| gRPC metadata | `authorization: Bearer <token>`, `x-request-id`, `x-session-id`, `cosy-version`, `cosy-clienttype: 5`, `cosy-machineos`, `cosy-machinehostname` (tanpa `cosy-machinetoken`) |
| Static (PAT→jobToken) | `cosy-machinetoken`, `cosy-machinetype: 5`, `cosy-machineid`, `cosy-clienttype: 5`, `cosy-version`, `login-version: v2`, `appcode`, `accept`, `accept-encoding: identity`, `date`, `signature`, `content-type`, `user-agent: Go-http-client/2.0` |

**Yang penting:** di CLI zip ini, **satu-satunya header kustom yang muncul di kode readable adalah `X-Qoder-HTTPDNS-IP`** (modul config). Tidak ada `cosy-*`, `x-model-key`, `x-request-id` (kecuali pola redaksi di `modules/0014`), atau `user-agent` kustom di kode readable — semua berada di bytecode.

### 4.2 Payload

**A. Cloud Agents Managed (readable):**
```json
{ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "<prompt>" }] }] }
```
Respon creation/list: `{id}`, `{data, has_more, next_page}`.

**B. Realtime envelope (readable):**
```json
{ "version": "voice.realtime.v1", "type": "text.message", "payload": { "text": "…" } }
```
Payload jenis: `audio.append` (Base64 PCM16 LE, 16 kHz, mono), `interrupt`, `ping`, `playback.started/ended/cancelled` (dengan `work_id`/`announcement_id`), `connection.close` (`request_id`). Batas: teks ≤16 KiB, frame ≤256 KiB, 2.048 pesan.

**C. Legacy COSY / IDE modern (dari adapter):**
- Legacy `buildQoderRequest`: `{model, request_id, request_set_id, chat_record_id, session_id, source_session_id, stream:true, reasoningEffort?, aliyun_user_type:"", chat_task:"FREE_INPUT", is_reply:true, is_retry:false, source:1, version:"3", session_type:"qodercli", agent_id:"agent_common", task_id:"common", code_language:"", chat_prompt, image_urls:null, chat_context:{chatPrompt, imageUrls:null, extra:{context:[], modelConfig:{key, is_reasoning}, originalContent:{text}}, features:[], text:{text}}, model_config:{key, display_name, format:"openai", model:"", api_key:"", url:"", is_vl, is_reasoning, max_input_tokens, max_output_tokens, source}, messages:[OpenAI-shaped], max_tokens, tools:[{type:"function",function:{name,description,parameters,strict}}], parallel_tool_calls:true, tool_choice?, parameters?}`
- IDE modern `buildQoderIdeRequest`: `{model, messages, stream:true, stream_options:{include_usage:true}, tools?, parameters?, reasoningEffort?, model_config?, metadata:{context:{request_id, request_set_id, session_id, source_session_id, task_id:"common", client_type:"5"}, business:{business_product:"cli", business_type:"agent", business_version, scene:"assistant"}}, max_tokens}`
- gRPC `ChatCompletionRequest` mirror dari body di atas (lihat §6).

---

## 5. Analisis response

### 5.1 SSE parser (readable, `assets/0049` + `assets/0035`)
- `readSSE(body)`: parser line-based; field `data`/`event`/`id`; frame ditutup baris kosong; komentar `:` dilewati; batas `maxFrameChars` 262.144; memakai `TextDecoder` streaming untuk UTF-8 terpecah.
- `consumeSSE(response)`: wajib `Content-Type: text/event-stream`; iterasi frame; jika callback mengembalikan `true` pada state terminal, stream berakhir; EOF tanpa terminal → `sse_incomplete`.

### 5.2 Alur event QCA (doc `assets/0056`)
- `event_start` (`event.id` + `event.type`), `event_delta` (`event_id` + `delta:{type:'content_delta', index, content:{type:'text', text}}`), buffered `agent.message` (pesan kanonik lengkap), event status/error. Idle = akhir eksekusi; EOF bukan bukti selesai. Resume via `Last-Event-ID`.

### 5.3 Envelope & chunk (adapter — bukan zip)
- Envelope SSE: `{statusCodeValue, body, …}`. `statusCodeValue != 200` → error (klasifikasi provider code; `10605 isQueued` → retry-after; 402/116 → entitlement/quota). `body === "[DONE]"` → akhir. `body` string → payload langsung. Ada `choices[]` → chunk OpenAI langsung.
- Chunk stream: `choices[].delta.{content, reasoning_content, tool_calls}`, `finish_reason`, `usage`; `raw_usage` event dengan kunci ber-newline literal (mis. `"data_policy_preferre\n\nnd_count"`) yang membuat parser SSE toleran-`JSON.parse` (escape newline dalam string).
- gRPC stream: chunk `{model, choices:[{index, delta:{content, reasoning_content, tool_calls[]}, finish_reason}], usage}`; `tool_calls` adalah repeated `Struct` (field `{fields:{...}}` Value-union, bukan JSON polos); finish_reason: `stop`→stop, `tool_calls`/`function_call`→tool_use, `length`→length; status gRPC: 16→401, 413→context length, 13+"quota"→429.

---

## 6. Proto & parser

**Di artefak ini: tidak ditemukan file `.proto`, string `package model.chat`, `ChatService`, `ChatCompletionStream`, `protobuf`, maupun `grpc`** (scan token di qodercli.js, modules, assets, bytecode semuanya 0 hit; string `rpc` yang muncul di libvips.dll adalah kebetulan substring binary).

**Proto gRPC Qoder ada di repo Cartethyia**, diturunkan dari desktop client v1.1.81 (`qoder-worker-runtime.mjs`) di `src/providers/integrations/qoder/chat-proto.ts` / `vendor/qoder-proto/chat.proto`:

```
syntax = "proto3"; package model.chat;
service ChatService { rpc ChatCompletionStream(ChatCompletionRequest) returns (stream ChatCompletionChunk); }
```
Struktur utama:
- `ChatCompletionRequest` (24 field): `model`, `repeated ChatMessage messages`, wrapper `temperature/top_p/max_tokens/n/seed/parallel_tool_calls`, `bool stream`, `repeated string stop`, `Reasoning reasoning`, `repeated Tool tools`, `google.protobuf.Value tool_choice`, `ResponseFormat response_format`, `StreamOptions stream_options` (`include_usage`), `map<string, ChatPatchList> patches`, `ChatMetadata metadata`, `Struct extras`, `CustomModelConfig custom_model`.
- `ChatMessage`: `cache_id`, `role`, oneof `text_content | parts_content`, `name` (StringValue), `repeated ToolCall tool_calls`, `tool_call_id`/`tool_call_call_id` (StringValue), `reasoning_content` (StringValue), `ReasoningItem reasoning_item`, `Struct extends`. `ContentPart` mendukung `text`, `image_url` (`url`+`detail`), `input_audio` (`data`+`format`), `cache_control`.
- `Tool`/`Function`/`ToolCall`/`FunctionCall`: mirror OpenAI; `arguments` = `google.protobuf.Value`.
- `ChatMetadata` = `WorkspaceMetadata` (file_count, languages, codebase_status, data_policy), `BusinessMetadata` (id, name, begin_at, product, version, type, stage, sub_task), `ContextMetadata` (request_id, session_id, task_id, request_set_id, machine_id, client_type, source_session_id), `UserMetadata` (user_id).
- Response: `ChatCompletionResponse` (non-stream) & `ChatCompletionChunk` (stream) — `code, id, object, created, model, choices[], usage, extras`; `StreamChoice` = `{index, delta: ResponseChatMessage, finish_reason}`; `ResponseChatMessage` punya `tool_calls` sebagai `repeated Struct`; `Usage` = prompt/completion/total + details (cached tokens, reasoning_tokens).

Parser kunci di adapter: `qoderEnvelopeToFrames` (envelope→frames), `escapeJsonRawNewlines`, `QoderToolCallBuffer` (stitching fragment `tool_calls` per `index`/`id`), `fromProtoStruct` (Struct→plain), `mapFinishReason`.

---

## 7. HTTP/2/3 & transport details

| Temuan | Status | Bukti |
| --- | --- | --- |
| `h2c`/`http3`/`alpn`/`undici`/`keepalive` di kode CLI | **Tidak ada** | scan 0 hit di qodercli.js & modules/; string hanya muncul di dependensi pihak ketiga (`assets/0205` package-lock, binary libvips.dll, photon wasm) |
| `fetch(` di bundle | 5 kemunculan | qodercli.js (kebanyakan di bagian SDK/service yang readable; transport CLI asli tidak terlihat) |
| `WebSocket` | 1 kemunculan | qodercli.js (SDK realtime) |
| `AbortController` | 4 | qodercli.js |
| `retry`/`timeout`/`signal` | 7/9/24 | qodercli.js |
| `X-Qoder-HTTPDNS-IP` | **ada** | header HTTPDNS kustom (modul config) — indikasi resolusi DNS by-pass |
| gRPC | dipakai adapter, bukan terlihat di zip | `@grpc/grpc-js` + `proto-loader`; channel options: `grpc.enable_http_proxy=0`, `grpc.default_authority`, `grpc.ssl_target_name_override`, `max_receive/send_message_length=32MiB` |

SDK Cloud Agents menggunakan `fetchImpl = globalThis.fetch` standar dengan `redirect:'manual'`, `signal` (AbortController), timeout header 15 s, dan batas response 2 MiB (JSON) — tidak ada HTTP/2/3 khusus; `wss:` untuk realtime.

---

## 8. Cosy/WASM signing & machine identity

### 8.1 Hasil scan (semua nol di artefak CLI)
`QoderContext`, `credential.wasm`, `qoder_auth_wasm_bg`, `generate_runtime_auth_fields`, `prepareInferRequest`, `prepareRequest`, `transformQoderBody`, `agent_chat_generation`, `ChatService`, `ChatCompletionStream`, `model.chat`, `cosy`, `COSY` → **tidak ada satu pun yang ditemukan** di `qodercli.js`, `modules/`, `assets/`, maupun `bytecode/`.

### 8.2 photon_rs wasm — BUKAN signer
`assets/0030-photon_rs_bg.wasm-bq08arze.qoder-native.txt` (magic `\0asm` v1) adalah `photon_rs` (Rust crate). Ekspor terverifikasi: `alter_channel`, `monochrome`, `sepia`, `grayscale*`, `threshold`, `box_blur`, `gaussian_blur`, `watermark`, `filter`, `crop`, `fliph/flipv`, `resize`, `rotate`, `resample`, `adjust_brightness`, `hue_rotate_*`, `saturate_*`, `duotone_*`, dll — murni image processing (bundling paket npm `photon_rs` + `@silvia-odwyer/photon`, terlihat juga dari `photon_rs.js`, `photon_rs.d.ts`, dan `_resolveFilename` untuk `@silvia-odwyer/` di `modules/0012`).

### 8.3 Jejak machine identity di CLI
- Env `QODER_DISABLE_UMID_REPORT` (modul 0013) — satu-satunya sebutan "umid".
- Kunci telemetry (modul 0016): `machine_id_hash`, `machine_id_digest`, `process_instance_id`, `organization_id`, `user_id` — telemetry mengirim hash machine id.
- **Tidak ada binary bridge** (`runtime-info`, umidpack) di zip ini; bridge umid vendor (ELF/PE/Mach-O + seed replay) ada di adapter Cartethyia (`vendor/qoder-umid/`, `qoder-umid.ts`).

### 8.4 COSY di adapter (referensi perbandingan)
- Signing: AES-128-CBC (key acak 16B, IV=key) untuk `info` (identity dict: name/aid/uid/yx_uid/organization_*/user_type/security_oauth_token/refresh_token); key dienkripsi RSA PKCS1 (public key embedded); `payload = base64({version:"v1", requestId, info, cosyVersion, ideVersion})`; `signature = MD5(payload \n cosyKey \n date \n body \n sigpath)`.
- Body: `transformQoderBody` — base64 lalu rotasi 3-segmen + substitusi alphabet `QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"` (`=` → `$`).
- Signature header statis: `MD5(appcode & secret & date)` dengan `QODER_APPCODE="cosy"`, `QODER_SIG_SECRET="d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="`.
- Job token: PAT (`pt-…`) ditukar lewat `POST …/jobToken?Encode=1` dengan body `{payload: JSON.stringify({personalToken, securityOauthToken:"", refreshToken:"", needRefresh:false, authInfo:{}}), encodeVersion:"1"}`.

---

## 9. Perbandingan dengan adapter Cartethyia

### 9.1 SAMA

| Aspek | Nilai |
| --- | --- |
| Keluarga host intl | `api1/api2/api3.qoder.sh`, `center.qoder.sh`, `openapi.qoder.sh` identik dengan konstanta CLI (`Dd/Xo/Ed/Tc/Sf`) |
| Identitas per-request | `client_type: "5"`, `business_product: "cli"`, `business_type: "agent"`, `scene: "assistant"` — sama dengan `Kr()` CLI |
| Konsep token | PAT `pt-…`, device `dt-…`, job `jt-…`; exchange PAT→jobToken ada di dua sisi |
| `AgentId=agent_common`, `FetchKeys=llm_model_result`, `Encode=1` | dipakai adapter untuk path legacy; pattern ini memang idiom Qoder |
| Envelope response | `statusCodeValue`/`body`/`[DONE]` (idiom Qoder) |
| Body legacy | `model_config.key`, `chat_context.text.text`, `agent_id`, `task_id:"common"`, `session_type:"qodercli"`, `chat_task:"FREE_INPUT"` — mirror worker IDE |
| Telemetry | `gen_ai.*` attribute (OTel) + `machine_id_hash` |

### 9.2 BEDA

| Aspek | CLI 1.1.83 (artefakak) | Adapter Cartethyia |
| --- | --- | --- |
| Akses kode | Kode chat asli di bytecode (tidak terbaca); hanya config host readable | Sumber lengkap + terverifikasi live |
| Host CN | `Xr=""` (slot kosong di modul CLI) | `gateway.qoder.com.cn`, `openapi.qoder.com.cn` (dari donor hub lain) |
| Host gRPC | tidak terlihat | `api2-v2.qoder.sh` (intl) — host berbeda dari `api1/2/3` biasa |
| Signing COSY | tidak terverifikasi (bytecode) | manual AES-128-CBC + RSA PKCS1 + alphabet-scrambled body |
| WASM signer | tidak ada jejak di zip | tidak dipakai (manual) |
| Header COSY | hanya `X-Qoder-HTTPDNS-IP` terlihat; lainnya di bytecode | set lengkap (`cosy-key/bodyhash/bodylength/sigpath/user/date/data-policy/business-*`) |
| Header gRPC | n/a | `cosy-machineos`, `cosy-machinehostname`, `x-session-id`; tanpa machinetoken |
| Parse SSE | `assets/0049` parser generik (untuk SDK sites, bukan chat CLI) | parser toleran newline-dalam-JSON + envelope statusCodeValue |
| gRPC proto | tidak ada di zip | vendored dari client 1.1.81 (`chat.proto`) |
| Umid | hanya flag `DISABLE_UMID_REPORT` | bridge asli (`runtime-info` ELF/PE/Mach-O + seed replay) |
| OAuth | tidak terlihat (di bytecode) | device flow PKCE + `qoder://aicoding.aicoding-agent/login-success` / `qoder-work-cn://` |
| jobToken exchange | `center.qoder.sh/api/v1/jobToken/exchange` (v1, JSON plain `{personal_token, machine_id}`) | v1 — dulu v3 scrambled-COSY (`/algo/api/v3/user/jobToken?Encode=1`) |
| Versi UA | n/a | CLI/COSY/device `Bun/1.4.2`; IDE `Bun/1.4.4`; exchange `qoder/<v>`; openapi `Qoder`/`QoderWork` |

### 9.3 Analisis
1. **CLI 1.1.83 adalah klien modern/IDE-style, bukan klien legacy COSY.** Tidak adanya string `/algo`, `agent_chat_generation`, dan `cosy` di seluruh kode readable (dan di string pool bytecode yang hanya berisi nama runtime JSC) konsisten dengan CLI yang berkomunikasi lewat surface gRPC/OpenAI-style, sementara surface COSY legacy hidup di desktop worker (`qoder-worker-runtime.mjs` v1.1.81) yang di-reverse sebelumnya oleh tim.
2. **Host intl sama, host CN tidak terlihat di CLI** — modul CLI menyisakan `Xr=""` (kosong) yang kemungkinan diisi runtime/by-site (CN memakai binary terpisah `qoderclicn`, channel manifest sendiri).
3. **Adapter lebih lengkap** karena sumbernya donor hub (`Public/qoder2api-hub`) + verifikasi live 2026-11-02/04, sedangkan zip CLI ini hanya memberi konfirmasi independen untuk keluarga host & identitas per-request.
4. **Protokol umid** tidak terbukti ada di CLI 1.1.83 (hanya flag disable + telemetry hash); kemungkinan besar mekanisme device identity untuk CLI = kombinasi machine-id hash (telemetry) + token devais dari OAuth, bukan bridge runtime-info — perlu verifikasi dinamis.

---

## 10. Temuan menarik lain

1. **Garis keturunan Qwen Code**: `modules/0016` menampilkan brand default "Qwen Code" (`cliBin "qwen"`, `cliSlug "qwen-code"`, `.qwen` config dir di modul 0) meski binary bernama qodercli — CLI ini bercabang dari codebase Qwen Code / opencode (menguatkan dugaan "Qoder = Qwen Code fork dengan backend Qoder").
2. **Channel CN/Global terpisah penuh**: binary berbeda (`qodercli` vs `qoderclicn`), manifest berbeda (download.qoder.com vs static.qoder.com.cn), qodersec juga dual-channel. `QODER_SITE=CN` memilih semuanya.
3. **Header HTTPDNS kustom `X-Qoder-HTTPDNS-IP`** + env `QODER_HTTPDNS` — CLI bisa mem-*resolve* host sendiri (anti-DNS-blocking / partner ISP), pola yang dipakai layanan China.
4. **Telemetry OTel/`gen_ai` semantic conventions**: modul 0016 mendefinisikan atribut `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.input.messages`, `gen_ai.request.model`, `gen_ai.tool.*`, `gen_ai.usage.input/output_tokens`, plus `machine_id_hash`, `process_instance_id`. Ada telemetry event `server_request`, `llm_call`, `tool_call`, `attempt_failed` (dengan server_request_id, cache_read_input_tokens, dst).
5. **Sanitasi antikebocoran kredensial**: `modules/0014` berisi pola redaksi (`sk-ant-*`, `sk-*`, `key-*`, `Bearer …`, `Authorization:`, `password/passwd/secret/token/api_key/access_token/refresh_token`, AWS `AKIA…`, private key PEM) untuk log.
6. **Dir log run per-proses**: `modules/0014` menulis `qodercli.log` + `manifest.json` per run (`run_id`, pid, cli_version "1.1.83", env_flags), symlink `latest`.
7. **Worker + WASM shared library**: `modules/0009` (worker.js) memuat WebAssembly dengan `dylink.0` (WASI, `wasi_snapshot_preview1`), mendukung ekstensi native wasm — dipakai untuk runtime toolchain (mungkin `rg` / plugin).
8. **Plugin keamanan "qodersec"** (Go binary, v0.9.5, Apache-2.0) dengan hook SessionStart/PostToolUse (`Edit|Write|MultiEdit|NotebookEdit`, `Bash(git push *)`), L1/L2/L3 review, dan SCA cloud scan — di-download on-demand, cooldown 10 menit, lock dir.
9. **Marketplace plugin**: `https://qoder.com/apphub/api/v1/marketplace/marketplace.json` — mekanisme distribusi ` qoder-plugins`.
10. **Natives cache per-user**: dir `%TEMP%/qodercli-natives-v<verhash>-<userhash>` (modul 0012) untuk libvips/sharp/conpty/photon — transparan dan bisa di-extract ulang.

---

## 11. Evidence ledger

| # | Klaim | Lokasi bukti |
| --- | --- | --- |
| E1 | Bundle 509 KB, 26 seksi `// @bun @bytecode` | `qodercli.js` (`grep -c '// @bun @bytecode'` = 26) |
| E2 | Entry `B:/~BUN/root/qodercli`, bytecode 427/428, flags cross_compiled_bytecode | `manifest.json` (baris 16-49) |
| E3 | Bytecode 431 `.jsc`, 40.061.648 byte, `header_valid_count: 0`, pool hanya nama runtime JSC | `bytecode/`, `bytecode/index.json`, scan ASCII/UTF-16 semua file |
| E4 | Host constants api1/2/3, center, openapi, daily-*, test-*, qoder.com, upgrade, marketplace, HTTPDNS header, env QODER_* | `modules/0013-chunk-1fm2tn0e.js` (source readable utuh; string `Dd="api1.qoder.sh"` dll) |
| E5 | Brand default "Qwen Code" + kunci gen_ai telemetry | `modules/0016-chunk-mmc0nqet.js` |
| E6 | Versi 1.1.83 + natives cache dir | `modules/0012-chunk-nxe9rqe3.js` (`let H="1.1.83"`), `modules/0014` (manifest cli_version) |
| E7 | Pola redaksi kredensial | `modules/0014-chunk-5314xwcn.js` (array `fe`) |
| E8 | Tidak ada cosy/grpc/proto/wasm-signer strings | `grep -rl` + scan token Python di seluruh tree → 0 hit (termasuk bytecode) |
| E9 | photon_rs wasm = image processing | `assets/0030-...wasm...` (export list), `assets/0027`/`0028` (.d.ts/.js) |
| E10 | Cloud Agents API endpoints/headers/token | `assets/0034-cloud-agents-xdn13d60.mjs`, `assets/0045-managed-transport...`, `assets/0051-api...md` |
| E11 | SSE parser generik | `assets/0049-sse-1zv83rbf.mjs` |
| E12 | Realtime WSS envelope & limits | `assets/0036-qca-realtime-vz207s5x.mjs`, `assets/0055-realtime-19nc7h33.md` |
| E13 | Alur event QCA & resume | `assets/0056-streaming-6v3g6pnn.md`, `assets/0052-chat-example-xxf37sx1.md` |
| E14 | Channel unduhan Global/CN & pin versi | `assets/0230-bootstrap-4kcewevm.cmd`, `assets/0232-qodersec-launch-f6epy55e.cmd` (URL manifest 1.1.41, qodersec 0.9.5) |
| E15 | Plugin security-scan & hooks | `assets/0227-plugin-x6mdn772.json`, `assets/0228-qoder-hooks-zdww60p0.json`, `assets/0242-SKILL-egyhfevc.md` |
| E16 | Adapter: realm & hosts CN | `src/providers/integrations/qoder/qoder-realm.ts` |
| E17 | Adapter: COSY signing & header set lengkap | `src/providers/integrations/qoder/qoder.ts` (`qoderBuildCosyHeaders`, `transformQoderBody`, `QODER_ALPHABET`, RSA key, `QODER_SIG_SECRET`) |
| E18 | Adapter: SSE envelope + tolerant parser | `src/providers/integrations/qoder/qoder.ts` (`qoderEnvelopeToFrames`, `escapeJsonRawNewlines`), `qoder-sse.ts` |
| E19 | Adapter: gRPC channel/metadata/stream map | `src/providers/integrations/qoder/qoder-grpc.ts` (channel options, `qoderGrpcMetadata`, `qoderGrpcToCanonicalEvents`, mapFinishReason) |
| E20 | Proto gRPC lengkap | `src/providers/integrations/qoder/chat-proto.ts` (sumber: vendor `chat.proto`, client v1.1.81) |
| E21 | Adapter: OAuth device flow & refresh | `src/providers/integrations/qoder/qoder-oauth.ts` (`QODER_DEVICE_TOKEN_URL`, dt-/drt-, refresh) |
| E22 | Adapter: umid bridge | `src/providers/integrations/qoder/qoder-umid.ts` (runtime-info ELF/PE/Mach-O, seed `.locale_cfg`, WSL) |
| E23 | Riset gRPC 1M ctx & wire audit | `documentation/research/qoder/2026-11-04-qoder-grpc-1m-context.md` (payload limits: `documentation/research/qoder/live/2026-11-05-qoder-payload-limits.md`; delta audit: `documentation/research/qoder/live/2026-11-05-qoder-wire-reference-adapter-alignment.md` §4) |

---

## 12. Yang belum bisa diverifikasi

1. **Logika chat asli CLI** (surface mana yang dipakai: gRPC vs IDE HTTP vs COSY legacy; header persis; body persis) — berada di `bytecode/*.jsc` yang tidak bisa dibaca tanpa runtime Bun + kunci string table (`header_valid_count: 0`, pool hanya nama runtime JSC). Manifest menandai `has_bytecode_string_table`, jadi ada string table terpisah yang tidak diekstrak.
2. **Kosong COSY di CLI 1.1.83** — absen di kode readable, tapi tidak bisa diklaim "pasti tidak dipakai" karena bytecode tertutup; yang bisa diklaim hanya "tidak ada jejak di bagian yang terbaca".
3. **`Xr=""` (host CN)** — nilai sebenarnya (kemungkinan `gateway.qoder.com.cn` dll) tidak ada di konstanta CLI; kemungkinan di-set saat runtime/site.
4. **Alur OAuth device flow CLI sendiri** (PKCE, redirect uri, endpoint poll/refresh) — hanya terlihat di adapter, bukan di zip ini.
5. **Umid bridge di CLI** — hanya flag `DISABLE_UMID_REPORT` + telemetry hash yang terlihat; apakah CLI memanggil binary `runtime-info` tidak bisa diverifikasi.
6. **Header gRPC persis CLI** (mis. `x-session-id`, `cosy-machinehostname`) — berasal dari adapter (client 1.1.81), bukan dari zip 1.1.83.
7. **Perilaku HTTP/2/3 CLI** — tidak ada indikasi di kode readable; transport fetch Bun (undici-like) tidak terlihat.
8. **Harga/kuota** — tidak ada logika kuota di artefak ini (qodercli murni klien).
9. **Verifikasi dinamis** — apa pun di luar pembacaan statis (menjalankan qodercli.exe, replay network) sengaja tidak dilakukan.

---
*Akhir audit. Semua jalur file relatif terhadap `D:\tmp\unpacked\qoder\qoder-cli-windows-x64\` kecuali disebut lain.*
