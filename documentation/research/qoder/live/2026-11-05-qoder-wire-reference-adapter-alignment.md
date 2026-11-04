# Qoder — Wire Reference & Adapter Alignment (dipangkas 2026-11-05)

> Versi ini mempertahankan **hanya temuan terverifikasi** (artifact source +
> live capture). Bagian yang sebelumnya merujuk dokumen sumber yang sudah
> dihapus saat konsolidasi diganti pointer ke evidence file fisik.
> Lihat [Evidence Ledger](#8-evidence-ledger) untuk jalur bukti.

## Daftar Isi
- [1. Permukaan & Auth](#1-permukaan--auth)
- [2. Header per Permukaan](#2-header-per-permukaan)
- [3. Live Wire Capture](#3-live-wire-capture)
- [4. Adapter Alignment — Delta Donor vs Gateway](#4-adapter-alignment--delta-donor-vs-gateway)
- [5. Metadata Server & raw_usage](#5-metadata-server--raw_usage)
- [6. Bukti Wire raw_usage Absen](#6-bukti-wire-raw_usage-absen)
- [7. Ringkasan untuk Adapter](#7-ringkasan-untuk-adapter)
- [8. Evidence Ledger](#8-evidence-ledger)

---

## 1. Permukaan & Auth

| Permukaan | Sumber | Endpoint | Auth |
|---|---|---|---|
| Chat legacy COSY | worker `F7i` + WASM `prepareInferRequest` | `POST api1/2/3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | `Bearer COSY.<payload>.<signature>` + `cosy-key/bodyhash/sigpath`, `appcode:cosy`, `signature` MD5, machine headers UMID |
| Chat HTTP modern | worker `sendModelServerHttpChat` | `POST api2-v2.qoder.sh/model/v1/chat/completions` | `Bearer <dt-/jt-/pt->` + `X-Request-ID`/`X-Session-ID` + `Cosy-Version/ClientType/MachineOS/Hostname` |
| gRPC | worker `Qyl` + `vot` | `POST api2-v2.qoder.sh:443/model.chat.ChatService/ChatCompletionStream` (HTTP/2) | metadata `authorization: Bearer`, `x-request-id`, `x-session-id`, `cosy-version/clienttype/machineos/machinehostname` |
| IDE business API | `_buildCosyHeaders` | `/api/v1/...` (openapi/center) | `Bearer` + `Cosy-Version/MachineToken/Type/Code/Id/Hostname/OS` — **`Cosy-ClientType: "0"`** |

Catatan kunci:
- `Cosy-ClientType`: worker chat 5/6, **IDE business "0"**, claim campaign 10.
- Chat modern & gRPC **tidak** memakai COSY signing — murni Bearer.
- `X-Session-ID` IDE/HTTP = sha256(userId:model) 32-hex; gRPC pakai UUID.

## 2. Header per Permukaan

### 2.1 Chat legacy COSY (live 1.1.83, capture asli)

```
Accept: text/event-stream
Authorization: Bearer COSY.<payload>.<signature>        [429 chars]
Cache-Control: no-cache
Content-Type: application/json
Cosy-Business-Product: cli
Cosy-Business-Type: agent
Cosy-ClientType: 5
Cosy-Data-Policy: agree
Cosy-Date: <epoch seconds>
Cosy-Key: <RSA(PKCS1)-encrypted AES-128 key>           [172 chars]
Cosy-MachineCode: <18 hex>                              [dari UMID]
Cosy-MachineHostname: <hostname asli>
Cosy-MachineId: <UUID>
Cosy-MachineOS: x86_64_win32
Cosy-MachineToken: <P1gA… 88>                          [UMID]
Cosy-MachineType: <18 hex>
Cosy-Scene: assistant
Cosy-User: <userId>
Cosy-Version: 1.1.83
Login-Version: v2
X-Model-Key: <roster key>                              [cmodel]
X-Model-Source: system
traceparent: 00-…-01
User-Agent: Bun/1.4.2
Accept-Encoding: gzip, deflate, br, zstd
```

Worker source (`F7i`) menghapus `cosy-machinetoken`/`cosy-machinetype` dari hasil
WASM lalu menimpanya dari UMID (`tct()`).

### 2.2 Chat HTTP modern (`/model/v1`)

```
Accept: text/event-stream
Authorization: Bearer <token>
Content-Type: application/json
X-Request-ID: <uuid>
X-Session-ID: <sha256 32-hex>
Cosy-Version: 1.1.83
Cosy-ClientType: 5
Cosy-MachineOS: x86_64_win32
Cosy-MachineHostname: <lowercase hostname>
User-Agent: Bun/1.4.4
```

Body: OpenAI-shaped JSON plaintext — `{model, messages, stream:true,
stream_options:{include_usage:true}, metadata:{context:{request_id,
request_set_id, session_id, source_session_id, task_id:"common",
client_type:"5"}, business:{business_product:"cli", business_type:"agent",
business_version, scene:"assistant"}}, max_tokens, tools:[],
parallel_tool_calls:true}`.

### 2.3 gRPC metadata (HTTP/2)

```
authorization: Bearer <token>
x-request-id: <uuid>
x-session-id: <uuid>
cosy-version: 1.1.83
cosy-clienttype: 5
cosy-machineos: x86_64_win32
cosy-machinehostname: <sanitized>        # opsional
```

Channel options: `grpc.enable_http_proxy:0`, `default_authority`/
`ssl_target_name_override` = host, `max_receive/send_message_length` besar
(adapter 32 MiB).

### 2.4 IDE business API (`_buildCosyHeaders`)

```
Cosy-Version: <cosyVersion || productVersion>
Cosy-MachineToken/Type/Code/Id/Hostname/OS: <dari machineInfoService>
Cosy-ClientType: "0"
```

Machine identity 7-field (semua wajib terisi — `qQo()` di IDE bundle) berasal
dari native bridge `aicoding.getMachineInfo` (UMID).

### 2.5 Delta yang HARUS diperhatikan adapter

| Aspek | Worker/IDE (source) | Adapter Cartethyia | Rekomendasi |
|---|---|---|---|
| `Cosy-ClientType` | worker 5/6; **IDE "0"** | 5 (header), 10 (campaign) | ikut surface |
| `Cosy-MachineHostname` | sanitized `os.hostname()`, hanya infer-sse | dulu hardcode `DESKTOP-QODER` | sanitized |
| `X-Request-ID` | worker UUID; exchange uppercase | acak | perbaiki ke uppercase untuk jobToken exchange |
| `x-model-key`/`x-model-source` | worker chat HTTP modern TIDAK kirim | adapter sempat kirim | hapus |
| Model list path | `/api/v2/model/list?Encode=1` (tanpa `/algo`) | `/algo/api/v2/model/list?Encode=1` | sesuaikan |
| jobToken exchange | `center.qoder.sh/api/v1/jobToken/exchange` (v1) | v3 lama | pakai v1 |

## 3. Live Wire Capture

### 3.1 CLI v1.1.83 (di bawah mitmproxy)

- Chat COSY: host `api1.qoder.sh`; header lengkap §2.1; body ter-encode
  `transformQoderBody`.
- Response headers metadata: `ga-request-id`, `sw-trace-id`, `x-request-id`,
  `entry/leave-timestamp`, `req-cost-time`, `resp-start-time`,
  `req-arrive-time`, `x-envoy-upstream-service-time`.
- **jobToken exchange**: `POST center.qoder.sh/api/v1/jobToken/exchange`
  body `{personal_token, machine_id}` + `X-Request-ID` uppercase → response
  `{token: jt-…, refresh_token: jrt-…, expires_at}`.
- Config resolve: `POST openapi.qoder.sh/api/v1/qcs/config/resolve`
  (`{namespaces, keys, context:{platform, clientVersion, clientType}}`).
- Model list: `GET api1/algo/api/v2/model/list?Encode=1` → 61KB roster
  (`key`, `display_name`, `format:"openai"`, `source:"system"`, `enable`,
  `is_vl`, `is_reasoning`, `is_free`, `is_lite_plan`, `price_factor`,
  `max_input_tokens`, `context_config:{1M,200K,400K}`,
  `thinking_config:{enabled:{efforts:{...}}}`, `promotion`, `strategies`).

Koreksi vs riset lama: `User-Agent` chat = `Bun/1.4.2` (bukan Go);
`X-Model-Key/Source` ADA di COSY; `Cosy-MachineType/Code` = 18-hex dari UMID;
`Cosy-MachineHostname` = hostname asli.

### 3.2 IDE/HTTP `/model/v1`

- Request: §2.2. Auth OAuth `dt-` langsung (tanpa exchange).
- Response: SSE OpenAI-standard (`chat.completion.chunk`), `model` echo,
  `usage` di frame terminal, `[DONE]`. Header server: `req-cost-time`,
  `x-envoy-upstream-service-time`, `x-request-id` (echo), `alt-svc: h3`,
  `server: istio-envoy`.
- `accept-encoding` dapat berisi gzip/br/zstd.

### 3.3 gRPC

- Wire = HTTP/2 + `application/grpc` + 5-byte length-prefixed protobuf frames.
- Response: `grpc-status:0` di trailer; chunk proto mirror OpenAI.
- Tidak ada COSY signing — murni Bearer.

### 3.4 IDE OAuth (Qoder.exe NSIS)

- Model list & chat COSY memakai `Cosy-User` (userId OAuth) + COSY Bearer.
- Beda model-list vs chat: `Cosy-MachineToken` = UUID(=machineId) vs UMID
  `P1gA…`; `Cosy-MachineType` = `5` vs 18-hex; `Cosy-MachineCode` hanya di
  chat; `Cosy-MachineHostname` hanya di chat; `Cosy-ClientIp` hanya di model
  list; `X-Model-Key/Source` hanya di chat.

---

## 4. Adapter Alignment — Delta Donor vs Gateway

Dari audit donor `qoder-worker-runtime.mjs` v1.1.81 vs gateway (2026-11-04),
plus verifikasi live setelah matrix 150/150 (2026-11-05):

| # | Surface | Delta | Status |
|---|---|---|---|
| D1 | gRPC | `cosy-version` wajib (donor `1.1.80`; sekarang sejalan versi) | ✅ di-apply |
| D2 | gRPC | Hapus `cosy-machinetype`/`cosy-machinetoken` (donor tidak kirim) | ✅ di-apply |
| D3 | gRPC | `cosy-machineos` = platform riil (`${arch}_${platform}`), bukan hardcoded | ✅ di-apply |
| D4 | gRPC | Channel options: no-proxy, authority pinning, 32 MiB | ✅ di-apply |
| D5 | gRPC | `cosy-machinehostname` sanitized (opsional) | ✅ |
| D6 | gRPC | `metadata.context.client_type`: donor desktop `6`, pakai `5` | ✅ (5) |
| D7 | gRPC | `context_length` hanya saat deklarasi | ✅ |
| D8 | gRPC | ToolCall `arguments` → `{stringValue}`; `call_id` saat ada | ✅ |
| D9 | IDE | `stream_options.include_usage` plain `true` | ✅ |
| D10 | IDE | `X-Request-ID` uppercase; `Cosy-Version` sejalan; `Cosy-MachineOS` riil; hostname sanitized | ✅ |
| D11 | COSY | Body `_8r` (plain, tanpa envelope `{payload}`) — sesuaikan | ✅ |
| D12 | COSY | Jangan pakai HMAC `Signature` untuk chat | ✅ |

Root-cause ECONNRESET dulu: gRPC metadata kirim header ekstra
(`cosy-machinetype/token` random) + hilang `cosy-version` + `cosy-machineos`
palsu + channel 4 MiB default. Semua sudah di-align; verifikasi live matrix
tool-call 150/150 (lihat model-matrix).

---

## 5. Metadata Server & raw_usage

| Metadata | IDE/HTTP (`/model/v1`) | gRPC |
|---|---|---|
| model echo | `model: "cmodel"` | `model: "cmodel"` |
| raw_usage / strategi | ✅ (kaya, opsional) | ❌ |
| usage | `raw_usage.data` / `usage` | `usage` (prompt/completion + details) |
| server headers | `req-cost-time`, `x-envoy-upstream-service-time`, `x-request-id`, `alt-svc h3` | sama |
| trailers | — | `x-request-id` |

`raw_usage` (hanya IDE/HTTP, opsional — tidak selalu dikirim):

```json
{
  "task_mode": "",
  "model": "3rd-claude5.1-fable",
  "model_level": "cmodel",
  "target": "a-f51-[inner-model-routify]-260806-W5XoKpMc",
  "provider_model": "claude-fable-5-1-cc",
  "account_discount": 0.9,
  "ttft": 6222,
  "data": { "input_tokens": 34, "output_tokens": 33 }
}
```

Insight:
- Slot `cmodel` di-back Claude 5.1 Fable, tapi backend bisa berubah antar
  request (routify internal vs AWS Bedrock `supply_region`).
- `target` = aturan routing upstream; `account_discount` bervariasi.
- **raw_usage tidak bisa diandalkan sebagai kontrak** — lihat §6.

## 6. Bukti Wire raw_usage Absen

- Verifikasi 2026-11-05 (dfmodel): 3× session tetap + 3× `--fresh-session`,
  20+ attempt cmodel/dfmodel, OAuth/PAT/job token, acak — **0 raw_usage**.
- Wire mentah mitmproxy: flow 219 (21:34) response **2793B** + raw_usage;
  flow 222 (22:37) response **1136B** — frame terakhir hanya `usage`, grep
  `raw_usage` = 0.
- Kesimpulan: server menahan metadata setelah aktivitas tinggi (anti-scraping)
  atau fitur di-degradasi. Gunakan response headers + model echo sebagai
  metadata per-request yang selalu ada.

## 7. Ringkasan untuk Adapter

1. IDE/HTTP `/model/v1` = permukaan sederhana (Bearer + JSON plaintext +
   Cosy identity minimal) — default chat.
2. gRPC = satu-satunya surface untuk konteks besar,≥256K chars); cap
   ~5.5M–6M chars.
3. COSY legacy = free/lite + fallback entitlement; signing WASM-style
   (AES/RSA + alphabet scramble).
4. Job token (`jt-`) hasil exchange PAT bisa langsung dipakai sebagai Bearer
   di permukaan modern (verified live).
5. Jangan menggantungkan kontrak metadata pada `raw_usage`.

---

## 8. Evidence Ledger

| Bukti | Lokasi |
|---|---|
| Capture CLI v1.1.83 (flows asli) | `D:\tmp\scratch\qoder-capture\flows\` (030, 218, 006, 029, 028, 079; roster 032) |
| Capture IDE/HTTP | `D:\tmp\scratch\qoder-capture-oauth\flows2\219-api2-v2.qoder.sh-POST-misc.txt` |
| Capture gRPC | `D:\tmp\scratch\qoder-capture-oauth\flows3\221-api2-v2.qoder.sh-POST-misc.txt` |
| Capture IDE OAuth | `D:\tmp\scratch\qoder-capture-oauth\flows\` |
| Audit statis CLI 1.1.83 | `documentation/research/qoder/2026-11-05-qoder-cli-windows-1.1.83-audit.md` |
| Audit statis IDE 1.38 | `documentation/research/qoder/2026-11-05-qoder-ide-1.38-audit.md` |
| Audit statis NSIS 0.5.3 | `documentation/research/qoder/2026-11-05-qoder-win-nsis-0.5.3-audit.md` |
| COSY signing & identity | `documentation/research/qoder/2026-11-05-qoder-cosy-signing-machine-identity.md` |
| Payload limits | `documentation/research/qoder/live/2026-11-05-qoder-payload-limits.md` |
| Model matrix 150/150 + roster | `documentation/research/qoder/live/2026-11-05-qoder-model-matrix.md` |
| Tool-calling postmortem | `documentation/research/qoder/live/2026-11-05-qoder-tool-calling.md` |
| Credits/claims/identity | `documentation/research/qoder/live/2026-11-05-qoder-credits-claims-identity.md` |
