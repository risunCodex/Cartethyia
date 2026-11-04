# Qoder — Wire Reference & Adapter Alignment (konsolidasi 2026-11-05)

**Tanggal konsolidasi:** 2026-11-05
**Konsolidasi dari:**
- `qoder/2026-11-05-qoder-request-headers-per-surface.md` [21] (2026-11-05)
- `qoder/2026-11-05-qoder-live-wire-capture.md` [18] (2026-11-05)
- `qoder/2026-11-05-qoder-ide-http-wire-capture.md` [16] (2026-11-05)
- `qoder/2026-11-05-qoder-grpc-wire-capture.md` [13] (2026-11-05)
- `qoder/2026-11-05-qoder-ide-oauth-wire-capture.md` [17] (2026-11-05)
- `qoder/2026-11-01-qoder-chat-wire-verification.md` [2] — hanya Part B (QoderWake IDE surface) (2026-11-01)
- `qoder/2026-11-04-qoder-wire-delta-audit.md` [9] (2026-11-04)

> Konteks dari riset 2026-11-01 s/d 2026-11-05. Tanggal live probe dipertahankan per section.

## Daftar Isi
- [1. Ringkasan Permukaan](#1-ringkasan-permukaan)
- [2. Header per Permukaan](#2-header-per-permukaan)
- [3. Live Wire Capture — CLI (v1.1.83)](#3-live-wire-capture--cli-v11183)
- [4. Live Wire Capture — IDE/HTTP (`/model/v1`)](#4-live-wire-capture--idehttp-modelv1)
- [5. Live Wire Capture — gRPC (`ChatService`)](#5-live-wire-capture--grpc-chatservice)
- [6. Live Wire Capture — IDE OAuth (Qoder.exe NSIS)](#6-live-wire-capture--ide-oauth-qoderexe-nsis)
- [7. Wire Verification Awal — QoderWake IDE Surface (2026-11-01)](#7-wire-verification-awal--qoderwake-ide-surface-2026-11-01)
- [8. Adapter Delta Audit — Donor vs Gateway (2026-11-04)](#8-adapter-delta-audit--donor-vs-gateway-2026-11-04)
- [9. Perbandingan Metadata Server — IDE/HTTP vs gRPC](#9-perbandingan-metadata-server--idehttp-vs-grpc)
- [10. Evidence Ledger](#10-evidence-ledger)

---

## 1. Ringkasan Permukaan (2026-11-05)

Sumber: [21] §1, [17] §2, [21] §7; detail [16] §4 di §4.5.

### 1.1 Tabel permukaan & auth (2026-11-05)

Empat permukaan chat/jaringan utama beserta sumber header-nya ([21] §1):

| Permukaan | Sumber | Header inti |
|---|---|---|
| **Chat legacy COSY** | worker `F7i` + `prepareInferRequest` (WASM) | `authorization: Bearer COSY.<payload>.<signature>`, `cosy-key`, `cosy-bodyhash`, `cosy-sigpath`, `cosy-machinetype/5`, `cosy-clienttype/5`, `appcode: cosy`, `signature`, `cosy-version`, `login-version`, `date`, `accept`, `accept-encoding`, `content-type`, `user-agent` + machine headers dari UMID |
| **Chat HTTP modern** | worker `sendModelServerHttpChat` | `Accept: text/event-stream`, `Content-Type: application/json`, `Authorization: Bearer <token>`, `X-Request-ID`, `X-Session-ID` + pipeline: `Cosy-Version`, `Cosy-ClientType`, `Cosy-MachineOS`, `Cosy-MachineHostname`, `traceparent` |
| **gRPC** | worker `Qyl` + `vot` | metadata: `authorization: Bearer <token>`, `x-request-id`, `x-session-id`, `cosy-version`, `cosy-clienttype`, `cosy-machineos`, `cosy-machinehostname`, + trace |
| **IDE business API** | `_buildCosyHeaders` | `Authorization: Bearer`, `Cosy-Version`, `Cosy-MachineToken/Type/Code/Id/Hostname/OS`, `Cosy-ClientType: "0"`, `Accept-Language` |

Permukaan yang terekam live pada sesi IDE OAuth ([17] §2):

| Flow | Endpoint | Auth di header |
|---|---|---|
| 030/168/105 | `GET api1.qoder.sh/algo/api/v2/model/list?Encode=1` | COSY + `Cosy-User` OAuth |
| 218 | `POST api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?...` | COSY + `Cosy-User` OAuth |
| 029/167 | `GET api1.qoder.sh/algo/api/v1/ping` | Cosy identity (tanpa auth) |
| 028 | `GET api2.qoder.sh/algo/api/v1/ping` | Cosy identity |
| 006 | `POST openapi.qoder.sh/api/v1/qcs/config/resolve` | Bearer 34 |
| 079 | `GET openapi.qoder.sh/api/v1/qcs/config/stream?ns=qodercli-feature-gates` | Bearer 34 |
| — | `GET center.qoder.sh/...` (config/region) | — |

### 1.2 Perbedaan yang HARUS diperhatikan adapter (2026-11-05)

Ringkasan dari tabel lengkap [21] §7 (lihat §2.6):

- `Cosy-ClientType` berbeda per permukaan: worker 5/6, **IDE "0"**; adapter memakai 5 (header) dan 10 (campaign) — harus ikut surface.
- `Cosy-MachineHostname` di worker adalah hasil sanitize `os.hostname()` (hanya infer-sse); adapter saat ini hardcode `DESKTOP-QODER`.
- `cosy-version` worker = `1.1.79-hotfix.11`; adapter memakai `getQoderVersion()`.
- `x-model-key`/`x-model-source`: worker **tidak** mengirim pada permukaan HTTP modern (adapter mengirim — sebaiknya dihapus); namun di chat COSY live (1.1.83) **ADA** (`cmodel`/`system`) — lihat §3.6.
- Path model list tanpa `/algo` (`/api/v2/model/list?Encode=1`), sedangkan adapter memakai `/algo/api/v2/model/list?Encode=1`.

---

## 2. Header per Permukaan (2026-11-05)

Sumber: [21] utuh. Metode: pembacaan statis dari artifact yang sudah di-unpack (tidak ada binary yang dijalankan, tidak ada request langsung):
- Worker NSIS (`qoder-worker-runtime.obf.mjs` v1.1.79-hotfix.11) — source readable.
- IDE bundle (`agents-window.desktop.main.js` v1.38.0) — source readable.
- CLI zip (`qodercli.exe` v1.1.83) — bytecode JSC tidak readable; stub JS tanpa header.

> ⚠️ Tidak mengandalkan research lama — semua header di bawah ini ditelusuri langsung dari source/kode di atas.

### 2.1 Chat Legacy COSY (worker — yang WORK) (2026-11-05)

#### 2.1.1 Alur

```
F() → F7i(A=endpoint, e=bodyJson, t=modelKey, i=modelSource, r=authManager)
```

`F7i`:
1. `r.isServiceAccount()` → `U7i(r, "text/event-stream", r => r.prepareInferRequest(A,e,t,i))`
   - headers base: `{...Qte(A), "Content-Type":"application/json", Accept:"text/event-stream"}`
   - `Qte(A)` = `{Authorization: Bearer <token service account>}`
   - WASM `QoderContext("", "", {"uid":"","encrypt_user_info":"","key":""})` → `prepareInferRequest`
2. Non-service-account:
   - `o = dE(r => r.prepareInferRequest(A,e,t,i))` — WASM sign
   - `s = Jp(o.headers)` — Headers → object
   - **hapus** `cosy-machinetoken` dan `cosy-machinetype` dari `s` (jika ada)
   - `n = tct()` = `{Cosy-MachineToken, Cosy-MachineType}` (dari UMID)
   - `return {...s, ...n}` — timpa machine headers dari UMID
3. Pipeline `M.send({transport:"legacy", ...})` → `Jc`/`z9i`:
   - `SPl(E, s)` — inject trace (`traceparent`) jika belum ada
   - codebase headers jika workdirs + target org (`cosy-codebase-*`)
   - `injectClientIdentityHeaders: !r.isServiceAccount()`

#### 2.1.2 Header final (non-service-account, chat COSY)

```
authorization: Bearer COSY.<payload>.<signature>
cosy-key: <base64 RSA-encrypted AES key>
cosy-bodyhash: <md5(body)>
cosy-sigpath: <path setelah /algo, mis. /api/v2/service/pro/sse/agent_chat_generation>
cosy-machinetype: 5          # (dihapus dari WASM, ditimpa UMID)
cosy-clienttype: 5
cosy-version: 1.1.79-hotfix.11
login-version: v2
appcode: cosy
signature: <md5(appcode & secret & date)>
date: <RFC1123 UTC>
accept: application/json
accept-encoding: identity
content-type: application/json
user-agent: Go-http-client/2.0
# + dari UMID (tct):
Cosy-MachineToken: <machineToken UMID>
Cosy-MachineType: <machineType UMID>
# + dari pipeline (injectClientIdentityHeaders):
Cosy-Version: 1.1.79-hotfix.11        # HAt set-if-absent
Cosy-ClientType: 5                      # Jl().client_type
Cosy-MachineOS: x86_64_win32           # rYe
Cosy-MachineHostname: <sanitized>      # hanya saat requestClass=infer-sse
traceparent: <OTel traceparent>         # SPl / fO
# + opsional (codebase):
Cosy-Codebase-Status / Cosy-Codebase-Soft-Status / Cosy-Codebase-Tags
Cosy-Codebase-External-Id / Cosy-Codebase-Git-Remotes
```

### 2.2 Chat HTTP Modern (`/model/v1/chat/completions`) (2026-11-05)

#### 2.2.1 Konstruksi (worker `sendModelServerHttpChat`)

```js
const g = await vot(i, "http");   // token: security_oauth_token ?? access_token (refresh dulu)
headers = {
  ...A.requestHeaders,                 // headers custom tambahan
  Accept: "text/event-stream",
  "Content-Type": "application/json",
  Authorization: `Bearer ${g}`,
  "X-Request-ID": A.requestId,
  "X-Session-ID": A.sessionId,
}
// pipeline z9i nambah (injectClientIdentityHeaders=true):
//   Cosy-Version, Cosy-ClientType, Cosy-MachineOS, Cosy-MachineHostname (infer-sse)
//   + traceparent
```

#### 2.2.2 Header final

```
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <token>
X-Request-ID: <uuid>
X-Session-ID: <uuid>
Cosy-Version: 1.1.79-hotfix.11
Cosy-ClientType: 5
Cosy-MachineOS: x86_64_win32
Cosy-MachineHostname: <sanitized hostname>
traceparent: <OTel>
```

### 2.3 gRPC (`ChatService/ChatCompletionStream`) (2026-11-05)

#### 2.3.1 Konstruksi (worker `vot` + `Qyl`)

```js
const c = await vot(i, "grpc");       // token setelah refreshIfNeeded
metadata.set("authorization", `Bearer ${c}`);
metadata.set("x-request-id", A.requestId);
metadata.set("x-session-id", A.sessionId);
Qyl(metadata, g.client_type);          // lihat bawah
// trace:
const B = fO({});
for (const [k,v] of Object.entries(B)) metadata.set(k.toLowerCase(), v);
```

`Qyl(A, e)`:
```js
A.set("cosy-version", iYe);            // "1.1.79-hotfix.11"
A.set("cosy-clienttype", e);           // client_type (5/6)
A.set("cosy-machineos", rYe);          // "x86_64_win32"
const t = oYe();                        // sanitized hostname (atau "")
if (t) A.set("cosy-machinehostname", t);
```

#### 2.3.2 Metadata final

```
authorization: Bearer <token>
x-request-id: <uuid>
x-session-id: <uuid>
cosy-version: 1.1.79-hotfix.11
cosy-clienttype: 5
cosy-machineos: x86_64_win32
cosy-machinehostname: <sanitized hostname>   # opsional
traceparent: <OTel>
```

Channel options:
```
grpc.enable_http_proxy: 0
grpc.default_authority: <host>
grpc.ssl_target_name_override: <host>
grpc.max_receive_message_length: <besar>
```

### 2.4 IDE Business API (`_buildCosyHeaders`) (2026-11-05)

#### 2.4.1 `_buildCosyHeaders(e)` — dipakai semua request API/business

```js
const r = await this._machineInfoService.getMachineInfo(e);
const n = r.cosyVersion || this._productService.productVersion || this._productService.version;
const i = r.machineOS || this._getCosyMachineOS();
return {
  "Cosy-Version": n,
  "Cosy-MachineToken": r.machineToken,
  "Cosy-MachineType": r.machineType,
  "Cosy-MachineCode": r.machineCode,
  "Cosy-MachineId": r.machineId,
  "Cosy-MachineHostname": r.machineHostname,
  "Cosy-MachineOS": i,
  "Cosy-ClientType": "0",       // ⚠️ IDE pakai "0", bukan 5/6
};
```

`_getCosyMachineOS()`:
```js
const e = ua ? "windows" : Yi ? "darwin" : "linux";
let r = "x86_64";
if (arch === "arm64") r = "aarch64";
return `${r}_${e}`;
```

Machine info default (fallback):
```js
{cosyVersion:"", machineToken:"", machineType:"", machineCode:"",
 machineId:"", machineOS:"", machineHostname:""}
```

#### 2.4.2 Pola pemakaian

```js
// contoh user status:
headers = {
  Authorization: `Bearer ${n}`,
  ...await this._buildCosyHeaders(),
}
// contoh activities / quota reset / claim:
headers = {
  Authorization: `Bearer ${this._userInfo.token}`,
  ...await this._buildCosyHeaders(),
  "Accept-Language": this._getAcceptLanguageHeader(),   // "zh-CN" | "en-US"
}
// example voice polish:
headers = { "Content-Type": "application/json", ...(token ? {Authorization: `Bearer ${token}`} : {}) }
// example AOQ voice session (J$5):
headers = {
  Authorization: `Bearer ${accessToken}`,
  "X-Request-Id": requestId,
  "X-Asr-Session-Id": voiceSessionId,
  "X-Qoder-Voiceprint-Injection": voiceprintEnabled ? "auto" : "disabled",
  "X-IDE-Platform": "qoder",
  "X-Version": ...,
}
```

#### 2.4.3 Request service

- `useRawHeaders: true` → headers diberikan mentah (tanpa inject).
- Tanpa `useRawHeaders` → service inject default (token refresh, dll), request via sharedProcess (`sharedProcessService.getChannel("request").call(...)`).
- OpenAPI endpoint dari `getBaseUrl(yf.OpenApi)`, Inference dari `yf.Inference`, Center dari `yf.Center`.
- Remote control: `X-Qoder-Remote-Api-Version`.

### 2.5 CLI Headers (2026-11-05)

- Bundle = **bytecode JSC** (431 `.jsc`, 427/428 modul) — tidak readable; stub JS tidak membawa header.
- Yang ada di stub `qodercli.js`: `"Content-Type":"application/json"`, `"date"`, `"Authorization"`, `"accept"` — belum cukup.
- Kesimpulan: header CLI sebenarnya kemungkinan sama dengan worker (versi 1.1.83, `cosy-clienttype` 5, machine headers dari UMID) tapi **tidak bisa diverifikasi dari artifact ini** — perlu capture live atau decode bytecode.

### 2.6 Perbedaan yang HARUS diperhatikan (2026-11-05)

| Aspek | Worker/IDE (source) | Adapter Cartethyia | Rekomendasi |
|---|---|---|---|
| `Cosy-ClientType` | worker 5/6; **IDE "0"** | 5 (header), 10 (campaign) | ikut surface |
| `Cosy-MachineHostname` | sanitized `os.hostname()`, hanya infer-sse | hardcode `DESKTOP-QODER` | perbaiki ke sanitized |
| `cosy-version` | `1.1.79-hotfix.11` | getQoderVersion() | sesuaikan versi |
| `X-Request-ID` | uppercase? worker: `A.requestId` (UUID) + `x-qoder-request-id` fallback | `crypto.randomUUID().toUpperCase()` | periksa fallback |
| `signature` MD5 | `md5(appcode & secret & date)` | sama | ✓ |
| `x-model-key`/`x-model-source` | worker TIDAK kirim | adapter kirim | hapus |
| Model list path | `/api/v2/model/list?Encode=1` (tanpa /algo) | `/algo/api/v2/model/list?Encode=1` | sesuaikan |
| service account | headers beda (tanpa machine token) | support `requireAccountKind` | ✓ |

---

## 3. Live Wire Capture — CLI (v1.1.83) (2026-11-05)

Sumber: [18] utuh. Metode: `qodercli.exe` asli (unpacked, v1.1.83) dijalankan di bawah mitmproxy (CA ditanam di Windows root store). PAT `pt-...` via `QODER_PERSONAL_ACCESS_TOKEN`. Hit: `--list-models` + `--model cmodel --print`. Bukti: `D:\tmp\scratch\qoder-capture\flows\`.

### 3.1 Request COSY chat — `POST /algo/api/v2/service/pro/sse/agent_chat_generation` (2026-11-05)

Host: `api1.qoder.sh` (gateway api1; COSY chat pakai api1/api2/api3).

#### Headers (lengkap, asli)

```
Accept: text/event-stream
Authorization: Bearer COSY.<payload>.<signature>      [429 chars total]
Cache-Control: no-cache
Connection: keep-alive
Content-Type: application/json
Cosy-Business-Product: cli
Cosy-Business-Type: agent
Cosy-ClientType: 5
Cosy-Data-Policy: agree
Cosy-Date: 1793827197                                 [epoch seconds]
Cosy-Key: <RSA(PKCS1)-encrypted AES-128 key>          [172 chars]
Cosy-MachineCode: 0eabaf1474851a7db9                  [18 hex]
Cosy-MachineHostname: RisunAgent                      [hostname asli]
Cosy-MachineId: c9b9199d-f585-41f7-b973-be87f5b761db [UUID]
Cosy-MachineOS: x86_64_win32
Cosy-MachineToken: P1gAjtKuVynjbKWArTFOP5nVEbxvg452oPmzuAdPWQCFaCpq2rsArsPXvCSp6Yvc36qVx01lsoRc71t46Mt-gclg
                                                    [88 chars — UMID P1gA prefix]
Cosy-MachineType: dda315f11446756770                  [18 hex]
Cosy-Scene: assistant
Cosy-User: 01a15674-030b-7dde-a36e-e035e5f20e50      [userId]
Cosy-Version: 1.1.83
Login-Version: v2
X-Model-Key: cmodel
X-Model-Source: system
traceparent: 00-4eb2fbff0dac2ddbbe89665f42fd3e3b-9d85a0d29160d6db-01
User-Agent: Bun/1.4.2
Accept-Encoding: gzip, deflate, br, zstd
```

#### Body

Body ter-encode `transformQoderBody` (alphabet scramble: base64 → rotasi thirds → mapping alphabet custom, `=`→`$`). Tidak terbaca langsung; format plaintext-nya adalah request build `buildQoderRequest` (model_config, chat_context, messages, dst).

#### Response headers (metadata server)

```
Content-Type: text/event-stream;charset=UTF-8
Transfer-Encoding: chunked
Set-Cookie: acw_tc=...; HttpOnly; Max-Age=1800
ga-request-id: a2341f7c3552ee0e95136fe22f0fb3d7
sw-trace-id: 4eb2fbff0dac2ddbbe89665f42fd3e3b
x-request-id: 3a75b682-35e7-4691-b80e-11e83db1d081
entry-timestamp / leave-timestamp / req-cost-time / resp-start-time
req-arrive-time: 1793827204065
x-envoy-upstream-service-time: 51
```

### 3.2 Region endpoints — `GET /algo/api/v3/service/region/endpoints` (2026-11-05)

Host: `center.qoder.sh`.

```
Accept: application/json
Accept-Encoding: identity
Appcode: cosy
Content-Type: application/json
Cosy-Business-Product: cli
Cosy-Business-Type: agent
Cosy-ClientIp: c9b9199d-f585-41f7-b973-be87f5b761db   [UUID — header khusus]
Cosy-ClientType: 5
Cosy-MachineId: c9b9199d-f585-41f7-b973-be87f5b761db
Cosy-MachineOS: x86_64_win32
Cosy-MachineToken: c9b9199d-f585-41f7-b973-be87f5b761db  [UUID — bukan P1gA!]
Cosy-MachineType: 5
Cosy-Scene: assistant
Cosy-Version: 1.1.83
Date: Wed, 04 Nov 2026 21:19:53 GMT                    [RFC1123]
Login-Version: v2
Signature: <md5 32>                                    [appcode&secret&date]
User-Agent: Bun/1.4.2
```

Catatan: di permukaan ini `Cosy-MachineToken` = machineId (UUID), `Cosy-MachineType` = `5`. Berbeda dari chat COSY (P1gA + 18-hex).

### 3.3 jobToken exchange — `POST /api/v1/jobToken/exchange` (2026-11-05)

Host: `center.qoder.sh` (bukan v3!). Headers:

```
User-Agent: qoder/1.1.83
Cosy-ClientType: 5
Cosy-MachineOS: x86_64_win32
Cosy-Version: 1.1.83
X-Request-ID: 49D70ED7-77FD-4EB5-9E91-47FC46926627   [uppercase UUID]
Accept: application/json
Content-Type: application/json
```

Body:
```json
{
  "personal_token": "pt-SvqNIRMhkDgtNEwXhgtx2ehI_01a15674-4b70-7349-98e0-ebafdfa42d52",
  "machine_id": "c9b9199d-f585-41f7-b973-be87f5b761db"
}
```

Response 200 JSON 268B (token + expiry).

### 3.4 Config resolve — `POST /api/v1/qcs/config/resolve` (2026-11-05)

Host: `openapi.qoder.sh`.

```
Authorization: Bearer <token>   [34 chars]
Content-Type: application/json
User-Agent: Bun/1.4.2
Accept: */*
```

Body:
```json
{
  "namespaces": ["qodercli-feature-gates"],
  "keys": [],
  "context": { "platform": "windows", "clientVersion": "1.1.83", "clientType": "qodercli" }
}
```

Response: 200 JSON + `etag: "959568a71f5fd360cb899ba95cf7c612"`, `x-request-id`, `x-trace-id`.

### 3.5 Model list — `GET api1` (61KB response) (2026-11-05)

Endpoint: `/algo/api/v2/model/list?Encode=1`? — capture menunjukkan body roster lengkap di `032-api1.qoder.sh-GET-misc.txt` (61KB) dengan fields penting: `key`, `display_name`, `format:"openai"`, `source:"system"`, `enable`, `is_vl`, `is_reasoning`, `is_free`, `is_lite_plan`, `price_factor`, `max_input_tokens`, `context_config:{1M,200K,400K:{token_count,is_default}}`, `thinking_config:{enabled:{efforts:{high,medium,low,max,xhigh}}}` ( `minimal_version:{cli,jb_plugin,ide,qoder_wake}`, `promotion` (off-peak discount), `strategies:[{tag:"C4"}]`, `is_sensitive`, `is_editable`.

### 3.6 KOREKSI penting vs research lama (2026-11-05)

| Aspek | Live capture 1.1.83 | Adapter/probe kita | Aksi |
|---|---|---|---|
| `User-Agent` chat COSY | `Bun/1.4.2` | `Go-http-client/2.0` | **update** |
| `X-Model-Key` / `X-Model-Source` | **ADA** (`cmodel`/`system`) | sempat kuanggap tidak ada | **kembalikan** |
| `Cosy-MachineType` chat | 18-hex (`dda315f...`) | `"5"` | **update** (dari UMID) |
| `Cosy-MachineCode` chat | 18-hex (`0eabaf...`) | `"machine"` | **update** |
| `Cosy-MachineHostname` | `RisunAgent` (asli) | `DESKTOP-QODER` | **update** |
| `Cosy-MachineToken` chat | `P1gA...` 88 (UMID) | `P1gA...` generated | ✅ |
| `Cosy-Date` | epoch seconds | epoch seconds | ✅ |
| jobToken exchange host | `center.qoder.sh/api/v1/jobToken/exchange` | ada v3 center | **update ke v1** |
| `X-Request-ID` exchange | uppercase UUID | random | ✅ |
| Chat host | `api1.qoder.sh` (bukan api2) | api2 | catat |
| `Cosy-ClientIp` | ada (UUID) di region endpoint | tidak ada | tambah |
| `traceparent` | ada | tidak selalu | tambah |
| `Accept-Encoding` | `gzip, deflate, br, zstd` | identity | catat |

### 3.7 Rekomendasi perbaikan probe/scripts (2026-11-05)

1. `cosy-signer.ts`: `user-agent: Bun/1.4.2` (atau env `QODER_UA`), tambah `X-Model-Key`/`X-Model-Source` kembali (opsional di `listModels` + chat), terima `machine` dengan `type`/`code` 18-hex dari UMID.
2. `lib/shared.ts`: `machineId` default → pakai UMID (token `P1gA`, type/code 18-hex); hostname dari `os.hostname()` (sudah).
3. `jobToken exchange`: pindah ke `center.qoder.sh/api/v1/jobToken/exchange` dengan body `{personal_token, machine_id}` + header `X-Request-ID` uppercase.
4. gRPC: header machine mengikuti `Qyl` (sudah).
5. Tambah `Cosy-ClientIp` (UUID) di region endpoints/chat sesuai surface.

---

## 4. Live Wire Capture — IDE/HTTP (`/model/v1`) (2026-11-05)

Sumber: [16] utuh. Metode: direct hit ke `api2-v2.qoder.sh/model/v1/chat/completions` dengan OAuth `dt-` (account Sunny Koding) di bawah mitmproxy. TLS via `SSL_CERT_FILE`. Status: ✅ 200 + streaming; **bukan** COSY (tanpa scramble/signature). Bukti: `D:\tmp\scratch\qoder-capture-oauth\flows2\219-api2-v2.qoder.sh-POST-misc.txt`.

### 4.1 Request — headers lengkap (2026-11-05)

```
POST https://api2-v2.qoder.sh/model/v1/chat/completions

Accept: text/event-stream
Authorization: Bearer <dt-...>                    [34 chars — token doang]
Content-Type: application/json
Cosy-ClientType: 5
Cosy-MachineHostname: risunagent                  [lowercase hostname]
Cosy-MachineId: 3c76876a-14b9-4327-8637-922cc266aa3e
Cosy-MachineOS: x86_64_win32
Cosy-Version: 1.1.83
X-Request-ID: 4f78252e-7861-4248-9a01-159cfcf43c43
X-Session-ID: 82c09e489aba499ce03cd6044acac99b    [sha256(userId:model) 32-hex]
User-Agent: Bun/1.4.4
Accept-Encoding: gzip, deflate, br, zstd
```

Catatan: TIDAK ada `Cosy-MachineToken/Type/Code`, TIDAK ada `Cosy-Key`, TIDAK ada `signature`, TIDAK ada `appcode`. Ini murni Bearer.

### 4.2 Request — body JSON plaintext (2026-11-05)

```json
{
  "model": "cmodel",
  "messages": [{ "role": "user", "content": "..." }],
  "stream": true,
  "stream_options": { "include_usage": true },
  "metadata": {
    "context": {
      "request_id": "ad463452-fa95-41e8-9d1e-02b2edabeea7",
      "request_set_id": "c185744b-1661-48a8-bd50-fe6c22613100",
      "session_id": "82c09e489aba499ce03cd6044acac99b",
      "source_session_id": "",
      "task_id": "common",
      "client_type": "5"
    },
    "business": {
      "business_product": "cli",
      "business_type": "agent",
      "business_version": "1.1.83",
      "scene": "assistant"
    }
  },
  "max_tokens": 64,
  "tools": [],
  "parallel_tool_calls": true
}
```

### 4.3 Response — SSE (2026-11-05)

```
200
content-type: text/event-stream
cache-control: no-cache
req-cost-time: 7574
server: istio-envoy
x-envoy-upstream-service-time: 7507
alt-svc: h3=":443"; ma=86400         [HTTP/3 didukung server]
x-request-id: 4f78252e-...           [echo request id]
transfer-encoding: chunked
```

SSE frames:
```json
data: {"id":"ad463452-...","object":"chat.completion.chunk","created":1793828087,
       "model":"cmodel","choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"id":"...","model":"cmodel","choices":[{"index":0,"delta":{"role":"assistant","content":"1+1 adalah oper"}}]}
data: {"id":"...","model":"cmodel","choices":[{"index":0,"delta":{"role":"assistant","content":"asi pen"}}]}
...
data: [DONE]
```

### 4.4 Perbedaan IDE/HTTP vs COSY (2026-11-05)

| Aspek | IDE/HTTP (`/model/v1`) | COSY (`/algo/...`) |
|---|---|---|
| Auth | `Authorization: Bearer <token>` (34) | `Bearer COSY.payload.signature` (429) |
| Body | JSON plaintext | scramble alphabet (`transformQoderBody`) |
| `Cosy-MachineToken/Type/Code` | tidak dikirim | dikirim (P1gA + 18-hex) |
| `Cosy-MachineHostname` | `risunagent` (lower) | `RisunAgent` (title) |
| `Cosy-Key`/`signature`/`appcode` | tidak ada | ada |
| `X-Session-ID` | sha256 32-hex | — |
| Host | `api2-v2.qoder.sh` | `api1/2/3.qoder.sh` |
| `X-Model-Key/Source` | tidak ada | ada |
| `Content-Length` | 563 | 217000+ |

### 4.5 Kesimpulan untuk adapter (2026-11-05)

- **IDE/HTTP = permukaan sederhana**: Bearer + JSON plaintext + Cosy identity minimal (version/clienttype/machineid/machineos/hostname). Tidak perlu COSY.
- Auth: OAuth `dt-` langsung; PAT perlu exchange dulu.
- `alt-svc h3` → server siap HTTP/3, tapi request kita HTTP/1.1/2.
- Response stream OpenAI-standard (`chat.completion.chunk`).

---

## 5. Live Wire Capture — gRPC (`ChatService`) (2026-11-05)

Sumber: [13] utuh. Metode: grpc-js client (combined `chat.proto`), OAuth `dt-`, `grpc.enable_http_proxy` dibiarkan default (1) sehingga stream diterowongkan lewat mitmproxy → tertangkap sebagai HTTP/2 POST. `SSL_CERT_FILE` untuk CA. Status: ✅ 200, 33 chunks, model menjawab. Bukti: flow `221-api2-v2.qoder.sh-POST-misc.txt` (`D:\tmp\scratch\qoder-capture-oauth\flows3\`).

### 5.1 Request — HTTP/2 headers (2026-11-05)

```
POST https://api2-v2.qoder.sh/model.chat.ChatService/ChatCompletionStream
```

#### Headers (HTTP/2)

```
user-agent: grpc-node-js/1.14.7
content-type: application/grpc
te: trailers
authorization: Bearer <dt-...>            [34]
x-request-id: fca4b811-70cf-4f22-9e34-87756a71271b
x-session-id: 604ad8713035c13ae9c9b60134ef7e07
cosy-version: 1.1.83
cosy-clienttype: 5
cosy-machineos: x86_64_win32
cosy-machinehostname: risunagent
grpc-accept-encoding: identity,deflate,gzip
accept-encoding: identity
```

### 5.2 Request — body protobuf (5-byte frame) (2026-11-05)

```
length-prefix (5 byte): 00 00 00 00 D1  → 0xD1 = 209 bytes

message ChatCompletionRequest {
  model = "dfmodel"                                  (1)
  messages = [ { role:"user", text_content:"Halo, jawab singkat..." } ]  (2)
  max_tokens = { value: 128 }                        (5)
  stream = true                                      (6)
  tools = []                                         (16)
  stream_options = { include_usage: { value: true } } (20)
  metadata = {
    context = {
      request_id = "1d647e52-78c9-4960-b365-6ffd55e6609e"
      session_id = "604ad8713035c13ae9c9b60134ef7e07"
      task_id = "common"
      request_set_id = "97378dd2-10ce-45d1-84f7-c05b10f91ce"
      client_type = "5"
    }
    business = { product:"cli", type:"agent", version:"1.1.83", scene:"assistant" }
  }
}
```

### 5.3 Response (2026-11-05)

```
200
content-type: application/grpc
grpc-encoding: identity
grpc-accept-encoding: gzip
req-cost-time: 456
x-envoy-upstream-service-time: 455
alt-svc: h3=":443"; ma=86400        [HTTP/3 siap]
server: istio-envoy
x-request-id: fca4b811-...            [echo]
```

Body — stream frame protobuf:
```
frame: 00 00 00 00 54 → 0x54 = 84 bytes
  ChatCompletionChunk {
    id = "e1b41d94-3da0-4c7d-a3d3-b806a6c36fe8"
    object = "chat.completion.chunk"
    created = 1793828103
    model = "dfmodel"
    choices[0].delta = { content: "We" } / " need" / ...
  }
```

Terminal: `grpc-status: 0` (di trailer) + `grpc-message` kosong.

### 5.4 Metadata (initial) — dari server (2026-11-05)

```
content-type: application/grpc
req-cost-time: 456
req-arrive-time: 1793828770060
resp-start-time: 1793828770516
x-envoy-upstream-service-time: 455
alt-svc: h3=":443"; ma=86400
server: istio-envoy
x-request-id: fca4b811-...
```

Trailers: `x-request-id` (echo).

### 5.5 Kesimpulan (2026-11-05)

- gRPC wire = HTTP/2 + `application/grpc` + 5-byte length-prefixed protobuf frames.
- Metadata persis `Qyl` worker: authorization/x-request-id/x-session-id/cosy-version/clienttype/machineos/machinehostname.
- Tidak ada COSY signing di gRPC — murni Bearer.
- `grpc.enable_http_proxy` default (1) → bisa lewat proxy; worker/adapter set 0 (direct).

---

## 6. Live Wire Capture — IDE OAuth (Qoder.exe NSIS) (2026-11-05)

Sumber: [17] utuh. Metode: `Qoder.exe` (NSIS 0.5.3, Electron 43) direkonstruksi dari unpacked (trash shell + resources) dan dijalankan di bawah mitmproxy; OAuth `dt-...` (login via `qodercli login` device flow, session tersimpan). PAT tidak dipakai di sesi ini — `Cosy-User` mengonfirmasi akun OAuth. Bukti: `D:\tmp\scratch\qoder-capture-oauth\flows\`.

### 6.1 Ringkasan (2026-11-05)

- IDE (Qoder.exe) berjalan dengan OAuth session; chat COSY tetap default.
- **Tidak ada gRPC di capture** — gRPC memakai `grpc.enable_http_proxy:0` sehingga tidak lewat proxy. (Dibahas di §6.5.)
- Header model list dan chat COSY **berbeda satu sama lain** (lihat §6.3).

### 6.2 Permukaan yang terekam (2026-11-05)

| Flow | Endpoint | Auth di header |
|---|---|---|
| 030/168/105 | `GET api1.qoder.sh/algo/api/v2/model/list?Encode=1` | COSY + `Cosy-User` OAuth |
| 218 | `POST api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?...` | COSY + `Cosy-User` OAuth |
| 029/167 | `GET api1.qoder.sh/algo/api/v1/ping` | Cosy identity (tanpa auth) |
| 028 | `GET api2.qoder.sh/algo/api/v1/ping` | Cosy identity |
| 006 | `POST openapi.qoder.sh/api/v1/qcs/config/resolve` | Bearer 34 |
| 079 | `GET openapi.qoder.sh/api/v1/qcs/config/stream?ns=qodercli-feature-gates` | Bearer 34 |
| — | `GET center.qoder.sh/...` (config/region) | — |

### 6.3 Perbedaan header per permukaan (OAuth) (2026-11-05)

#### 6.3.1 Model list — `GET /algo/api/v2/model/list?Encode=1`

```
Accept: application/json
Accept-Encoding: identity
Authorization: Bearer COSY.<payload>.<signature>      [429]
Content-Type: application/json
Cosy-Business-Product: cli
Cosy-Business-Type: agent
Cosy-ClientIp: c9b9199d-f585-41f7-b973-be87f5b761db   [UUID]
Cosy-ClientType: 5
Cosy-Data-Policy: agree
Cosy-Date: 1793827655
Cosy-Key: [RSA 172]
Cosy-MachineId: c9b9199d-f585-41f7-b973-be87f5b761db
Cosy-MachineOS: x86_64_win32
Cosy-MachineToken: c9b9199d-f585-41f7-b973-be87f5b761db  [= machineId UUID!]
Cosy-MachineType: 5
Cosy-Scene: assistant
Cosy-User: 019e9c7a-dd32-785b-9d25-20cf08680239        [OAuth userId]
Cosy-Version: 1.1.83
Login-Version: v2
traceparent: 00-e1a83da6...-01
User-Agent: Bun/1.4.2
```

#### 6.3.2 Chat COSY — `POST /algo/api/v2/service/pro/sse/agent_chat_generation`

```
Accept: text/event-stream
Authorization: Bearer COSY.<payload>.<signature>      [429]
Cache-Control: no-cache
Content-Type: application/json
Cosy-Business-Product: cli
Cosy-Business-Type: agent
Cosy-ClientType: 5
Cosy-Data-Policy: agree
Cosy-Date: 1793827825
Cosy-Key: [RSA 172]
Cosy-MachineCode: 0eabaf1474851a7db9                  [18 hex]
Cosy-MachineHostname: RisunAgent
Cosy-MachineId: c9b9199d-f585-41f7-b973-be87f5b761db
Cosy-MachineOS: x86_64_win32
Cosy-MachineToken: P1gAjtKuVynjbKWArTFOP5nVEbxvg452oPmzuAdPWQCFaCpq2rsArsPXvCSp6Yvc36qVx01lsoRc71t46Mt-gclg  [UMID P1gA 88]
Cosy-MachineType: dda315f11446756770                  [18 hex]
Cosy-Scene: assistant
Cosy-User: 019e9c7a-dd32-785b-9d25-20cf08680239
Cosy-Version: 1.1.83
Login-Version: v2
X-Model-Key: cmodel
X-Model-Source: system
traceparent: 00-1395147099...-01
User-Agent: Bun/1.4.2
```

#### 6.3.3 Perbedaan kunci

| Field | Model list | Chat COSY |
|---|---|---|
| `Cosy-MachineToken` | UUID = machineId | UMID `P1gA...` 88 |
| `Cosy-MachineType` | `5` | 18-hex (`dda315f...`) |
| `Cosy-MachineCode` | (tidak ada) | 18-hex (`0eabaf...`) |
| `Cosy-MachineHostname` | (tidak ada) | `RisunAgent` |
| `Cosy-ClientIp` | ada (UUID) | tidak ada |
| `X-Model-Key`/`Source` | tidak ada | ada (`cmodel`/`system`) |

**Kesimpulan:** machine token/type **bukan satu nilai universal** — bervariasi per permukaan. Chat pakai UMID (P1gA + 18-hex), model list pakai UUID+5.

### 6.4 OAuth (dt-) vs PAT (pt-) (2026-11-05)

| Aspek | OAuth (`dt-`) | PAT (`pt-`) |
|---|---|---|
| jobToken exchange | **TIDAK** (langsung) | Ya (`POST center/api/v1/jobToken/exchange`) |
| `Cosy-User` | userId OAuth | userId dari exchange |
| Token di Authorization | `Bearer COSY...` (dengan `security_oauth_token` = dt-) | `Bearer COSY...` (dengan jobToken) |
| machine identity | sama (UMID/UUID) | sama |

### 6.5 gRPC — kenapa tidak muncul & cara men-capture (2026-11-05)

- gRPC channel options: `grpc.enable_http_proxy: 0` → koneksi TIDAK lewat mitmproxy (env HTTP(S)_PROXY diabaikan).
- Chat default di GUI = COSY (POST api1) — bukan gRPC.
- Untuk capture gRPC: perlu raw socket capture (tcpdump/wireshark) atau proxy transparan di level TCP; atau jalankan worker SDK dengan gRPC endpoint di bawah proxy yang memaksa (tidak didukung).
- Alternatif: replay proto langsung (sudah punya `chat.proto` + metadata `Qyl`).

### 6.6 Bukti & catatan (2026-11-05)

- Files: `D:\tmp\scratch\qoder-capture-oauth\flows\` (030, 218, 006, 029, 028, 079).
- GUI dijalankan dari `D:\tmp\unpacked\qoder\run-qoder-win\` (rekonstruksi).
- Error icon (`application-icons/qoder-light-windows.png` ENOENT) minor, tidak memengaruhi network.
- `Cosy-User: 019e9c7a-...` = account "Sunny Koding" (OAuth).

---

## 7. Wire Verification Awal — QoderWake IDE Surface (2026-11-01)

Sumber: [2] Part B. Reverse engineering dari QoderWake desktop app (macOS ARM64, v1.2.7, cf `Info.plist` `CFBundleShortVersionString` 0.1.19 / `QoderWakeRuntimeVersion` 1.2.7 / native build 39, built 2026-10-29) dan konfirmasi bahwa permukaan "IDE" Qoder (`/model/v1/chat/completions`) adalah chat path yang benar, menggantikan permukaan COSY legacy.

### 7.1 Artifacts (2026-11-01)

- Installer: `https://download.qoder.com/qoderwake/installers/latest/qoderwake_latest_darwin_arm64.dmg` (found via `qoder.com/en/download?product=qoderwake` page chunk 9774).
- Unpacked: `QoderWake.app/Contents/Resources/payload/` contains two bundled binaries: `qoderwake/qoderwake` (17 MB, daemon runtime) and `qodercli/qodercli-wake` (16 MB, bundled CLI runtime, version 1.1.76 per `installer-manifest.json`).
- `installer-manifest.json`: schema `qoderwake.nativeInstaller.v1`, product QoderWake, version 1.2.7, channels manifest at `https://download.qoder.com/qoderwake/channels/manifest.json`.
- `Info.plist`: daemon default port `19820`, deep-link scheme `qoder-wake`, runtime dir `.qoderwake`, bundle id `com.qoder.QoderWake.MenuBar`.

### 7.2 Wire findings (dari binary string extraction) (2026-11-01)

QoderWake memakai **skema COSY Bearer yang sama dengan plugin** (dari `qoderwake` binary):

```js
// identity object → AES-128-CBC (random key) → base64 `info`
// payload = b64( sortedCompact({ version:"v1", requestId, info, cosyVersion, ideVersion:"") })
// signature = md5(payload \n cosyKey \n timestamp \n body \n path)
// Authorization: `Bearer <prefix>${payload}.${signature}`  // prefix resolved at runtime
{
  "Cosy-User": ...,
  "Cosy-Key": ...,
  "Cosy-Date": timestamp,
  Authorization: `Bearer ${payload}.${signature}`,
}
```

Plus static identity headers: `Content-Type, Accept, Accept-Encoding, Cosy-Version, Cosy-MachineId, Cosy-MachineOS = ${process.platform}_${process.arch}, Cosy-ClientType, Login-Version: "v2"`.

Bundled CLI (`qodercli-wake`) memuat **kedua** surface chat:

| Surface | Path | Auth |
|---|---|---|
| Legacy COSY | `/algo/api/v2/service/pro/sse/agent_chat_generation` | COSY Bearer |
| IDE / model-server | `/model/v1/chat/completions` | plain `Bearer <dt-…>` |
| Model list | `/api/v2/model/list?Encode=1` | COSY signed GET |

### 7.3 Live behavior (real `dt-` OAuth account) (2026-11-01)

| Probe | Result |
|---|---|
| Legacy COSY chat (`qfmodel`) | `200` but `10605 isQueued` — server-side queue, parks request with `retryAfterSeconds` |
| IDE `/model/v1` chat (`qfmodel`) | `200` stream, **immediate**: OpenAI chunks, `model:"qfmodel"` |
| IDE model validation | `qwen3.8-flash` (virtual name) → `invalid_model_error "Unsupported model"` — virtual names must be resolved to roster keys first |
| Model list | `200` signed GET, full `{"chat":[...]}` roster with `context_config`, `is_free`, `display_name` |

Kesimpulan kunci:

1. **Gunakan IDE surface untuk chat.** Ia streaming seketika; surface COSY legacy menjawab `10605 isQueued` dan mengantrekan request. Default dispatch adapter harus `/model/v1/chat/completions`.
2. **Nama model di response** adalah roster key yang dikirim (`qfmodel`), bukan display name. Mengirim virtual name yang tidak ter-resolve membuat upstream menolak (`invalid_model_error`) atau fallback ke `auto`.
3. **QoderWake memakai ulang skema COSY** untuk endpoint non-chat dan surface modern untuk chat; signer Cartethyia (`qoderSignerFor`) sudah cocok 1:1 dengan skema COSY.
4. **Koreksi live catalog** (lihat `qoder-catalog.ts`):
   - `dfmodel` (DeepSeek-Flash) adalah **tidak lagi free** (`is_free:false`).
   - `kmodel_latest` display adalah **Kimi-K3.1-Pro** (bukan "Kimi-K3").
   - `mmodel` display adalah **MiniMax-M3.1-Flash** (bukan "MiniMax-M3").
5. IDE surface mengembalikan `usage:null` pada chunks bahkan dengan `stream_options.include_usage:true`; penggunaan token harus diambil dari frame terminal `[DONE]` atau event khusus jika diperlukan.

### 7.4 Outcome — adapter migrated ke IDE surface (verified) (2026-11-01)

Adapter (`src/providers/integrations/qoder/qoder.ts`) sekarang default chat dispatch ke IDE surface (`/model/v1/chat/completions`). Ketika surface itu menjawab penolakan entitlement (HTTP 402 / `{"code":116}`, terlihat pada akun free-tier), dispatch fallback otomatis ke surface COSY legacy (`/algo/.../agent_chat_generation`), yang streaming dengan kredensial sama — tapi hanya untuk baris model free-tier (`is_free: true`). Untuk model billed, 402/116 yang sama adalah kehabisan kuota sungguhan (daily exhaustion / cooldown Qoder berjalan dalam siklus 1 hari) dan dimunculkan apa adanya, sehingga state exhausted tidak pernah tertutupi fallback. Error 401/403/model dimunculkan apa adanya di kedua arah. `surface: "cosy"` tetap ada sebagai opsi force-legacy eksplisit. Verifikasi live end-to-end terhadap akun OAuth `dt-` riil:

- Streaming response selesai: `Pong! 🏓` text + reasoning trace.
- `stop_reason` sekarang benar `"stop"` (sebelumnya `none`). Ada dua root cause yang diperbaiki:
  1. IDE surface mengirim string kosong `finish_reason: ""` per delta, yang tertangkap sebagai finish reason riil dan membayangi frame terminal `[DONE]`. String kosong sekarang diperlakukan sebagai "no stop signal".
  2. `mapQoderFinishReason` tidak memetakan `"stop"` — ia hanya tahu `length`, `tool_calls`, `content_filter`. `"stop"` sekarang dipetakan ke `stop`.
- Penggunaan token dibaca dari event terminal `raw_usage.data` (bentuk OpenAI: `prompt_tokens`/`completion_tokens` + details). `raw_usage` tidak selalu dikirim; saat tidak ada, terminal tetap mensintesis `stop`.
- `decodeSseEvents` (`src/protocol/sse-decoder.ts`) sekarang memperlakukan baris non-SSE polos setelah event `data:` terbuka sebagai kelanjutan event itu, bukan gagal dengan "Malformed SSE line". Ini diperlukan karena IDE surface memancarkan satu event `data:` yang payload JSON-nya mengandung newline literal (mis. event terminal `raw_usage`).

Full backend suite: 4006 pass / 0 fail / 1 skip (13.03s, 348 files).

---

## 8. Adapter Delta Audit — Donor vs Gateway (2026-11-04)

Sumber: [9] utuh. Audit komprehensif dari unpacked Qoder desktop client (v1.1.81 bundle `qoder-worker-runtime.mjs`, 35 MB single-line) di ketiga transport — gRPC (`ChatCompletionStream`), HTTP IDE (`/model/v1`), dan legacy COSY (`agent_chat_generation`) — versus implementasi adapter Cartethyia. Tujuan: enumerasi setiap perbedaan wire agar gateway bisa dibuat 1:1 identik dengan client yang diekspektasi upstream. Audit dilakukan tiga subagent paralel, masing-masing merekonstruksi satu transport (body, headers, signing, response parsing) dari bundle via offset slicing (`scripts/scratch/qoder-bundle-slice.ts`).

### 8.1 Konteks: ECONNRESET (2026-11-04)

Gejala terlihat pengguna lewat gateway: **"Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly"** — tepat pada saat tool call diekspektasi, dan hanya di path gRPC billed (`qfmodel`, Qwen3.8-Flash). Path HTTP (lite/COSY) baik-baik saja. Retry loop lalu me-replay request; upstream sudah menolak/menutup stream.

Bug tool-call gateway (request missing `tools`, response deltas Struct-wrapped) sudah diperbaiki dan diverifikasi live hari itu juga. Audit ini menargetkan *sisa* delta: handshake level transport dan semantik channel yang bisa membuat upstream menjatuhkan koneksi di tengah stream.

### 8.2 gRPC transport — donor vs gateway (2026-11-04)

#### 8.2.1 Request builder (`QFn`)

Donor `QFn` (offset 19_833_906) menghasilkan:

```js
{
  model: A.model,
  messages: A.messages.map(JDl),
  tools: A.tools?.map(YDl) ?? [],
  stream: !0,                                   // plain bool
  stream_options: { include_usage: Iat(!0) },   // {value: true}
  max_tokens: cyl(e.max_tokens ?? A.max_tokens), // {value: int32}
  temperature: fat(e.temperature ?? A.temperature), // {value: double}
  top_p: fat(e.top_p),
  presence_penalty: fat(e.presence_penalty),
  frequency_penalty: fat(e.frequency_penalty),
  parallel_tool_calls: Iat(e.parallel_tool_calls), // {value: bool}
  response_format: qDl(e.response_format),
  reasoning: HDl(A),
  tool_choice: e.tool_choice === void 0 ? void 0 : Qat(e.tool_choice), // Value
  stop: Array.isArray(e.stop) ? e.stop : A.stop,
  patches: ODl(A.patches),
  metadata: {
    context: X6({ request_id: A.requestId, request_set_id: A.requestSetId,
      session_id: A.sessionId, source_session_id: A.sourceSessionId,
      task_id: A.taskId, client_type: t.client_type,
      context_length: e.context_length !== void 0 ? String(e.context_length) : void 0 }),
    business: A.business
  },
  extras: LDl(e),          // { top_k: oBA({top_k: e}) } only when top_k set
  custom_model: VDl(A.customModel)
}
```

Bentuk helper kunci (sudah dimirror di `qoder-grpc.ts`, diverifikasi live):

| Helper | Output shape | Gateway status |
| --- | --- | --- |
| `yG(s)` | `{value: s}` (StringValue) | ✅ used |
| `Iat(b)` | `{value: b}` untuk booleans (BoolValue) | ✅ used |
| `cyl(n)` | `{value: Math.trunc(n)}` (Int32Value) | ✅ used |
| `fat(n)` | `{value: n}` (DoubleValue) | ✅ used |
| `oBA(obj)` | `{fields: {k: Qat(v)}}` (Struct) | ✅ used |
| `Qat(v)` | `Value` union: `{stringValue}` / `{numberValue}` / `{boolValue}` / `{nullValue:0}` / `{structValue:{fields}}` / `{listValue:{values}}` | ✅ used |
| `jDl(tc)` | ToolCall: `{id: yG(id), call_id: yG(call_id), type: yG("function"), function: {name, arguments: Qat(args)}}` — `arguments` is a `Value`! | ⚠️ gateway sends `{stringValue}` inline, omits `call_id` |
| `YDl(tool)` | `{type:"function", function: X6({name, description: yG(desc), parameters: oBA(params), strict: Iat(strict)})}` | ✅ used (dengan `parameters` sebagai Struct) |

**Delta tersisa di request object:**

| Field | Donor | Gateway | Impact |
| --- | --- | --- | --- |
| `metadata.context.client_type` | `"6"` (desktop) / `"5"` (IDE) | `"5"` | Low; server may treat as different client family |
| `metadata.context.context_length` | only when `e.context_length` set, as STRING | always `String(contextWindow)` (1_000_000) | Low; declared window vs actual — server may size buffers accordingly |
| `reasoning` | sent when budget/effort present | not sent | Low for tool path |
| `extras` | `{top_k: {structValue: {fields: …}}}` when top_k set | never sent | Low |

#### 8.2.2 gRPC metadata headers — **primary suspect untuk ECONNRESET**

Donor `bDl` + `patchCompletionStream` (offset 19_832_730 / 19_848_342) men-set **tepat** key berikut (semua lowercase di wire):

```
authorization: Bearer <token>
x-request-id: <uuid>
x-session-id: <sessionId>
cosy-version: 1.1.80            ← q8e = S9 || "1.1.80"
cosy-clienttype: 6               ← ~l().client_type (desktop)
cosy-machineos: x86_64_win32    ← `${arch}_${platform}` dynamic
cosy-machinehostname: <sanitized hostname>   ← optional, W8e()
```

**Donor TIDAK mengirim:** `cosy-machinetype`, `cosy-machinetoken` di surface gRPC (itu HTTP-only, dan di sana pun dihapus untuk service accounts). Channel options (`NDl`, offset 19_832_962):

```js
{ "grpc.enable_http_proxy": 0,
  "grpc.default_authority": host, "grpc.ssl_target_name_override": host,
  "grpc.max_receive_message_length": 33554432,   // 32 MiB
  "grpc.max_send_message_length": 33554432 }     // 32 MiB
```

Gateway `qoderGrpcMetadata` saat ini mengirim:

```
authorization: Bearer <token>
x-request-id: <uuid>
x-session-id: <sessionId>
cosy-clienttype: 5
cosy-machineos: aarch64_macos        ← hardcoded, not host platform
cosy-machinetype: 5                  ← donor does NOT send
cosy-machinetoken: <auth.machineId>  ← donor does NOT send
```

Dan client gateway dibuat dengan channel options default (grpc-js default `max_receive_message_length` = 4 MiB).

**Ringkasan delta (metadata):**

| Header | Donor | Gateway | Likely effect |
| --- | --- | --- | --- |
| `cosy-version` | `1.1.80` | **missing** | Server-side client-class check could refuse/drop |
| `cosy-clienttype` | `6` (desktop) | `5` | Different client family; `5` may be treated as IDE |
| `cosy-machineos` | `x86_64_win32` (real) | `aarch64_macos` (hardcoded) | **Platform mismatch** — server may flag device anomaly |
| `cosy-machinehostname` | sanitized hostname | missing | Identity completeness |
| `cosy-machinetype` | — | `5` sent | Extra header donor doesn't send — may trip strict validation |
| `cosy-machinetoken` | — | random/device token sent | **Extra header** — if the server validates this against a known device and the value is bogus, it can drop the connection |

Dua header *ekstra* (`cosy-machinetype`, `cosy-machinetoken`) adalah kandidat terkuat untuk reject/reset sisi server: gateway mengirim nilai identity random/stale yang tidak pernah diekspektasi upstream di gRPC, sambil menghilangkan `cosy-version` dan mengirim machine OS palsu.

#### 8.2.3 Response parsing (sudah fixed)

- `delta.tool_calls` = repeated Struct → di-decode via donor `pat`/`Eat` (snake+camel) → `$Dl` memetakan ke `{index, id, type, function:{name, arguments}}` dengan `arguments` re-stringified. Gateway sekarang melakukan persis ini via `fromProtoStruct` (verified live).
- `finish_reason` string; `tool_calls`/`function_call` → tool_use; `"null"` non-terminal. Gateway cocok.
- Detail `usage`: `cached_tokens` + `reasoning_tokens` saja. Gateway cocok.

### 8.3 HTTP IDE transport (`/model/v1`) — donor vs gateway (2026-11-04)

Donor `PFn` (offset 19_865_358) body:

```js
{
  model, messages: A.messages.map(kyl).filter(Boolean), stream: !0,
  stream_options: { include_usage: !0 },        // ← PLAIN bool, not {value}
  metadata: { context: { request_id, request_set_id, session_id,
    source_session_id, task_id, client_type }, ...(business ? {business} : {}) },
  tools: Myl(A.tools),          // only when non-empty; PLAIN OpenAI shape
  ...(stop && {stop}), ...(max_tokens !== undefined && {max_tokens}),
  ...(temperature !== undefined && {temperature}),
  ...vyl(A.parameters),         // whitelist: top_p, top_k, presence_penalty,
                                //   frequency_penalty, parallel_tool_calls,
                                //   response_format, tool_choice, context_length,
                                //   seed, user, enable_thinking,
                                //   reasoning_budget_tokens, preserve_thinking
  ...(reasoningEffort && {reasoning_effort}),
  ...(patches && Object.keys(patches).length && {patches}),
  ...(customModel && {custom_model: Fyl(customModel)})
}
```

`Myl` (tools) — **plain OpenAI shape, tanpa wrappers**:

```js
A.tools?.map(e => ({ type: "function", function: {
  name: e.function.name,
  ...(e.function.description ? {description: e.function.description} : {}),
  ...(e.function.parameters ? {parameters: e.function.parameters} : {}),
  ...(e.function.strict !== void 0 ? {strict: e.function.strict} : {})
} }))
```

Headers (donor `Rat.openResponse` + `Hc` pipeline):

```
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <token>
X-Request-ID: <uuid UPPERCASE>
X-Session-ID: <sessionId>
Cosy-Version: 1.1.80
Cosy-ClientType: 5            ← Jl().client_type (IDE default)
Cosy-MachineOS: x86_64_win32
Cosy-MachineHostname: <sanitized>   ← only for requestClass "infer-sse"
traceparent: <otel>           ← when tracing enabled
```

Response parsing: SSE envelope `{statusCodeValue, body}` di-unwrap oleh `G6`; terminasi `[DONE]`; marker `[NOT_EXCEED_QUOTA]` / `[EXCEED_QUOTA]` / `[NOTIFICATIONS]` difilter; `delta.tool_calls` dibaca sebagai bentuk OpenAI polos; `finish_reason === "null"` diperlakukan non-terminal; tool deltas streaming sebagai fragmen (aturan empty-id continuation yang sama dengan gRPC).

**Delta tersisa (IDE):**

| Aspect | Donor | Gateway | Impact |
| --- | --- | --- | --- |
| `stream_options.include_usage` | plain `true` | likely `{value: true}` (to check) | JSON only — server tolerant, but align |
| `X-Request-ID` case | UPPERCASE | lowercase uuid | Cosmetic but visible to server |
| `Cosy-Version` | `1.1.80` | ? | Align to reported version |
| `Cosy-MachineOS` | real platform | ? | Align |
| `Cosy-MachineHostname` | sanitized hostname | ? | Align |
| `tool_choice`/`response_format` | passthrough verbatim from parameters | passthrough | ✅ |
| `reasoning_effort` | input camelCase → wire snake `reasoning_effort` | — | only when set |

### 8.4 Legacy COSY transport — donor vs gateway (2026-11-04)

Donor `_8r` (offset 34_437_636) body — **plain JSON, tanpa envelope**:

```js
{
  request_id, chat_record_id: request_id, request_set_id, session_id,
  source_session_id,
  stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false,
  source: 1, version: "3", agent_id: "agent_common", aliyun_user_type: "",
  chat_context: { text: <last user text>, features: [],
    extra: { context: [], modelConfig: {key, is_reasoning}, originalContent },
    chatPrompt: "", imageUrls: null },
  session_type: env.QODER_SESSION_TYPE ?? (dev ? "local" : "normal"),
  task_id: taskRouting.taskId ?? policyTaskId ?? "common",
  system: <string | array of {type:"text",text,cache_control?}>,
  messages: vUa(A),       // OpenAI-shaped, roles incl. tool/assistant tool_calls
  tools: HUa(A),          // PLAIN array: [{type:"function", function:{name, description: desc ?? "", parameters: params ?? {}}}]
  parameters: LUa(A),     // {temperature?, max_tokens, stop?, top_p?, top_k?,
                          //  reasoning_effort?, enable_thinking?,
                          //  reasoning_budget_tokens?, preserve_thinking?,
                          //  context_length?, tool_choice?}
  model_config: { key, display_name, outer_provider?|model:"", is_vl,
    is_reasoning, max_input_tokens, source: "system"|"custom_model",
    format: "openai", api_key: "", url: "" },
  custom_model: <undefined | {provider, model, type?, parameters:{api_key}, url?, style?}>,
  patches, business, custom_context
}
```

Signing: path chat **tidak** memakai `Authorization: Signature` HMAC; ia memakai **WASM `prepareInferRequest`** (Rust) yang membangun endpoint URL/query (`FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` — dirakit di dalam WASM, tidak terlihat di JS) dan menggabungkan headers. Identity headers via `iZt`/`oZt`/`sZt`:

```
Authorization: Bearer <token>            (from WASM context)
Cosy-Version: 1.1.81 / 1.1.80
Cosy-ClientType: <client_type>
Cosy-MachineOS: x86_64_win32
Cosy-MachineCode / Cosy-MachineToken / Cosy-MachineType: <machine identity>
Cosy-MachineId: <machineId>              (only when machineIdentityRequired)
Cosy-MachineHostname: <sanitized>        (infer stream only)
X-Request-ID: <uuid UPPERCASE>
```

Legacy HMAC signer (`ZKt` — `Signature <hmac>`, `X-Client-Timestamp`, `X-IDE-Platform: qoder_cli`, `X-Version`, `X-Machine-OS/Id/Type/Code`) ada di bundle tapi ini **path legacy terpisah**, bukan transport chat.

Response: SSE dengan envelope `{statusCodeValue, body}`; marker `[DONE]`, `[NOT_EXCEED_QUOTA]`, `[EXCEED_QUOTA]`, `[NOTIFICATIONS]#`; `finish_reason` dipetakan via `jUa` (`stop→end_turn`, `tool_calls/function_call→tool_use`, `length→max_tokens`, `refusal/content_filter/sensitive→refusal`, `null→null`); thinking via `delta.reasoning_content` / `reasoning_item`; tool deltas via `delta.tool_calls` (OpenAI shape, fragment streaming) atau legacy `function_call`.

### 8.5 Consolidated delta table — apa yang harus di-align (2026-11-04)

| # | Surface | Delta | Priority | Why it matters |
| --- | --- | --- | --- | --- |
| D1 | gRPC | Add `cosy-version: 1.1.80` metadata | **HIGH** | Client-class handshake missing |
| D2 | gRPC | **Remove** `cosy-machinetype` + `cosy-machinetoken` metadata | **HIGH** | Donor never sends them on gRPC; bogus device identity can trigger server drop |
| D3 | gRPC | Use real machine OS (`${arch}_${platform}`), not hardcoded `aarch64_macos` | **HIGH** | Platform mismatch may be flagged |
| D4 | gRPC | Set channel options: `enable_http_proxy:0`, `default_authority`/`ssl_target_name_override` = host, `max_receive/send_message_length: 32 MiB` | **HIGH** | Default grpc-js 4 MiB receive cap can abort large streams; proxy env could interfere |
| D5 | gRPC | Optionally send `cosy-machinehostname` (sanitized) | MED | Identity completeness |
| D6 | gRPC | `metadata.context.client_type` — decide `"5"` vs `"6"`; donor desktop uses `"6"` | MED | Client family semantics |
| D7 | gRPC | `metadata.context.context_length` only when known/application, as string | LOW | Declared window |
| D8 | gRPC | ToolCall `arguments` as `Value` (`{stringValue}`) + include `call_id` when present | MED | Message history fidelity |
| D9 | IDE | `stream_options.include_usage` plain `true` | LOW | JSON surface, tolerant |
| D10 | IDE | `X-Request-ID` uppercase; `Cosy-Version: 1.1.80`; `Cosy-MachineOS` real; `Cosy-MachineHostname` sanitized | MED | Server-side client fingerprint |
| D11 | COSY | Confirm gateway's COSY builder matches `_8r` (plain body, `agent_id`, `chat_context`, `model_config`, `tools` array, WASM-style identity headers) | MED | Free/lite path health |
| D12 | COSY | Confirm gateway does NOT use legacy HMAC `Signature` for chat | LOW | Only relevant if using legacy endpoints |

### 8.6 Root-cause hypothesis ECONNRESET (2026-11-04)

Path gRPC adalah path billed/tool. Kegagalan pengguna adalah **connection reset tepat saat output tool diekspektasi**. Berdasarkan audit:

1. **Paling mungkin:** metadata gRPC gateway membawa dua header yang tidak pernah diekspektasi upstream (`cosy-machinetype`, `cosy-machinetoken` dengan device token random/stale) sambil kehilangan `cosy-version` dan mengirim `cosy-machineos` palsu (`aarch64_macos` di host Windows). Saat request bertransisi ke turn tool-calling (response lebih besar/berbeda), validation/classifier sisi server bisa menolak dan me-reset koneksi — ECONNRESET mid-stream klasik.
2. **Berkontribusi:** default channel options grpc-js — `max_receive_message_length` 4 MiB dan tanpa authority/SSL overrides — berbeda dari donor (32 MiB + authority pinning); tool turn besar atau server yang menginspeksi authority bisa abort.
3. **Sekunder:** `metadata.context.context_length` selalu dikirim sebagai `1_000_000` besar, sedangkan donor mengirim hanya saat client mendeklarasikannya. Server yang mengalokasikan per window deklarasi bisa berperilaku berbeda.

Semua ini perubahan aman dan donor-faithful — tidak ada yang mengubah semantik yang terlihat client, dan semua terverifikasi di gateway live yang sudah bekerja.

### 8.7 Proposal — fix list P1–P7 (2026-11-04)

Proposal disimpan sebagai dokumen terpisah di `documentation/proposals/` (konvensi repo), bukan inline di sini:

- **`qoder-grpc-wire-alignment.md`** — P1–P4 (gRPC metadata + channel options + request metadata). **Primary** — path billed `qfmodel` dan tersangka ECONNRESET.
- **`qoder-ide-cosy-wire-alignment.md`** — P5–P6 (IDE headers, COSY body/headers). Secondary — path free/lite dan forced-IDE.

Ringkasan item kerja terurut (detail di masing-masing proposal):

#### P1 (gRPC metadata, `qoder-grpc.ts` / `qoderGrpcMetadata`)
- Tambah `cosy-version: "1.1.80"` (konstanta donor; pertahankan app-version adapter di `business.version`).
- Hapus `cosy-machinetype` dan `cosy-machinetoken` dari metadata gRPC.
- Hitung `cosy-machineos` dari `process.arch`/`process.platform` dengan mapping yang sama dengan donor (`arm64→aarch64`, `x64→x86_64`).
- Tambah `cosy-machinehostname` via sanitization yang sama dengan donor (normalize, ≤96 chars, else sha256 suffix) — pakai-ulang/ekstrak helper `machineHostname` yang ada dari `scripts/provider-probing/qoder/lib/shared.ts` ke source bersama.

#### P2 (gRPC channel options, `qoderGrpcClient`)
- Loloskan channel options ke `new ChatService(addr, creds, opts)`:
  - `"grpc.enable_http_proxy": 0`
  - `"grpc.default_authority": host`
  - `"grpc.ssl_target_name_override": host`
  - `"grpc.max_receive_message_length": 32 * 1024 * 1024`
  - `"grpc.max_send_message_length": 32 * 1024 * 1024`

#### P3 (gRPC request metadata)
- `context_length`: hanya set saat caller mendeklarasikan window (atau pertahankan, tapi konfirmasi perilaku server — prioritas rendah).
- `client_type`: pertahankan `"5"` kecuali ada bukti `"6"` diperlukan untuk surface billed; catat di komentar kode.

#### P4 (tool message history, `toProtoChatMessage`)
- Tambah `call_id: yG(call_id)` saat ada (donor `jDl`), dan pertahankan `arguments` sebagai `{stringValue}` (sudah).

#### P5 (IDE surface, `buildQoderIdeRequest` + headers)
Verifikasi kode gateway saat ini (2026-11-04) menunjukkan body sudah donor-exact untuk field penting: `stream: true`, `stream_options.include_usage: true` (plain), `tools` di-inject dari `buildQoderRequest`, `parameters` passthrough, `reasoningEffort`, `model_config`, `metadata.context`/`metadata.business`. Delta IDE tersisa:
- `X-Request-ID` → uppercase (donor `SK` menormalisasi ke upper).
- `Cosy-Version` → konstanta `"1.1.80"` (saat ini `getQoderVersion()`; putuskan apakah pin konstanta donor).
- `Cosy-MachineOS` → platform riil (sudah dinamis di COSY; pastikan path IDE memakai `qoderMachineOs()` yang sama).
- `Cosy-MachineHostname` → sanitized hostname (saat ini absent).

#### P6 (COSY surface, `buildQoderCosyRequest`/signer)
Verifikasi kode gateway saat ini: URL sudah donor-exact (`/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`), headers sudah Bearer + `Cosy-*` (BUKAN path HMAC `Signature` legacy), `cosy-machineos` dinamis, dan `cosy-version` dikirim. Delta COSY tersisa untuk diverifikasi terhadap donor `_8r`:
- Bentuk body: konfirmasi cocok dengan bentuk plain `{request_id, chat_record_id, request_set_id, session_id, source_session_id, stream, chat_task, is_reply, is_retry, source, version, agent_id, aliyun_user_type, chat_context, session_type, task_id, system, messages, tools, parameters, model_config, custom_model, patches, business, custom_context}` (tanpa envelope `{payload}`).
- `tools` sebagai array polos `[{type:"function", function:{name, description, parameters}}]` (donor `HUa`).
- Kehadiran `chat_context`/`model_config`/`session_type`.
- Machine-identity headers (`Cosy-MachineCode/Token/Type/Id/Hostname`) per donor `oZt`/`sZt`.

#### P7 (verification)
- Jalankan ulang matrix gateway live (tools full / no-choice / no-parallel / no-tools) setelah P1+P2; konfirmasi tidak ada ECONNRESET selama N run.
- Tambah regression test yang menegaskan key metadata gRPC (tepat set donor) dan channel options.

### 8.8 Actual code status vs proposal (checked 2026-11-04) (2026-11-04)

| Item | Donor | Gateway code (checked) | Proposal |
| --- | --- | --- | --- |
| gRPC `cosy-version` | `1.1.80` | **missing** | P1 |
| gRPC `cosy-machinetoken/-type` | not sent | **sent** | P1 (remove) |
| gRPC `cosy-machineos` | real platform | **`aarch64_macos` hardcoded** | P1 |
| gRPC `cosy-machinehostname` | sanitized | missing | P1 |
| gRPC channel options | 32 MiB + authority + no-proxy | **defaults (4 MiB)** | P2 |
| IDE `stream_options.include_usage` | plain `true` | ✅ plain `true` | — |
| IDE `X-Request-ID` | UPPERCASE | lowercase uuid | P5 |
| IDE `Cosy-Version` | `1.1.80` | `getQoderVersion()` | P5 (pin) |
| IDE `Cosy-MachineOS` | real | ? (same as COSY?) | P5 |
| IDE `Cosy-MachineHostname` | sanitized | missing | P5 |
| COSY URL | `agent_chat_generation?...` | ✅ exact | — |
| COSY auth | Bearer + `Cosy-*` | ✅ (not HMAC Signature) | — |
| COSY `cosy-machineos` | real | ✅ `qoderMachineOs()` | — |
| COSY body shape | plain `_8r` | to verify | P6 |
| gRPC tool request (tools/choice/parallel) | donor `QFn` | ✅ verified live | — |
| gRPC response tool_calls decode | Struct → JSON | ✅ fixed + tested | — |

---

## 9. Perbandingan Metadata Server — IDE/HTTP vs gRPC (2026-11-05)

Sumber: live direct hit ulang (cmodel, OAuth `dt-`, 2026-11-05) — IDE/HTTP
via `direct-ide-http.ts`, gRPC via `direct-grpc.ts`.

### 9.1 Tabel perbandingan

| Metadata | **IDE/HTTP** (`/model/v1`) | **gRPC** (`ChatService`) |
|---|---|---|
| model echo | `model: "cmodel"` (tiap chunk) | `model: "cmodel"` (di chunk) |
| **raw_usage / strategi** | ✅ KAYA (lihat 9.2) | ❌ tidak ada |
| usage | `raw_usage.data` (`input_tokens`, `output_tokens`, `cache_read/creation_input_tokens`) | `usage: {prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details, completion_tokens_details}` |
| server headers | `req-cost-time`, `x-envoy-upstream-service-time`, `alt-svc h3`, `server: istio-envoy`, `x-request-id` | sama persis |
| trailers | — (SSE) | `x-request-id` |
| latency | `ttft` 6222ms (di raw_usage) | `req-cost-time` 4732ms |
| `account_discount` | ✅ 0.9 | ❌ |

### 9.2 `raw_usage` — hanya di IDE/HTTP (opsional, tidak selalu dikirim)

Contoh A (2026-11-05, capture `flows2/219`):

```json
{
  "task_mode": "",
  "model": "3rd-claude5.1-fable",
  "model_level": "cmodel",
  "target": "a-f51-[inner-model-routify]-260806-W5XoKpMc",
  "provider_model": "claude-fable-5-1-cc",
  "account_discount": 0.9,
  "ttft": 6222,
  "data": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "input_tokens": 34,
    "output_tokens": 33
  }
}
```

Contoh B (2026-11-05, direct hit ulang — backend berbeda!):

```json
{
  "task_mode": "",
  "model": "aws-claude5.1-fable",
  "model_level": "cmodel",
  "target": "a-f51-[156808794280]-us-east-1-vC5Dah8=",
  "model_account": "taidong261103-1",
  "provider_model": "arn:aws:bedrock:us-east-1:156808794280:application-inference-profile/kdujtpi0bsz7",
  "account_discount": 0.95,
  "ttft": 3287,
  "data": { "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "input_tokens": 32, "output_tokens": 123 },
  "model_context": {
    "client_type": "unknown",
    "data_policy_preferred_count": 0,
    "from_model": "aws-claude5.1-fable",
    "has_data": true,
    "image_count": 0,
    "intention": "ignored",
    "router_strategy_name": "cmodel_default",
    "router_strategy_type": "single",
    "scheduler_times": 1,
    "target_id": "a-f51-[156808794280]-us-east-1-vC5Dah8=",
    "task_mode": "",
    "time_of_scheduler": 2,
    "use_bailian_safe_mode": false,
    "use_data_mask": false,
    "workspace_code_language": [],
    "workspace_file_count": -1
  },
  "supply_account": "156808794280",
  "supply_region": "us-east-1",
  "supply_model": "claude-fable-5-1"
}
```

Insight:
- Slot `cmodel` (Cantus) di-back model Claude 5.1 Fable, **tapi backend bisa
  berubah antar request**: contoh A via `3rd-claude5.1-fable` (inner-model
  routify), contoh B via **AWS Bedrock us-east-1**
  (`arn:aws:bedrock:...application-inference-profile/kdujtpi0bsz7`).
- `target`/`target_id` menamakan aturan routify; `router_strategy_name:
  cmodel_default`, `router_strategy_type: single`.
- `account_discount` bervariasi (0.9 / 0.95) — diskon akun.
- **`raw_usage` tidak selalu dikirim** — observasi live: muncul pada sebagian
  run, tidak pada run lain (opsional/probabilistik). Parser harus toleran.

### 9.3 Kesimpulan

- **IDE/HTTP jauh lebih kaya metadata strategi** — cocok untuk observability
  (provider asli, routing target, diskon, ttft), **ketika `raw_usage` hadir**.
- `raw_usage` **opsional/tidak konsisten** — jangan jadikan kontrak wajib.
- gRPC hanya memberi model echo + usage sederhana + timing server.
- Untuk menebak model asli per slot, **IDE/HTTP adalah satu-satunya surface**
  yang meng-expose `provider_model`/`supply_model` (konsisten dengan riset
  `raw_usage`, 2026-11-04).

---

## 10. Evidence Ledger (2026-11-05 / 2026-11-04 / 2026-11-01)

Digabung dari [18] (live CLI), [16] (IDE/HTTP), [13] (gRPC), [17] (IDE OAuth), [9] (delta audit), [21] (header per surface), [2] Part B (QoderWake).

### [21] — header statis per surface (2026-11-05)

| Klaim | Sumber |
|---|---|
| `F7i` header flow | `qoder-worker-runtime.obf.mjs`: `function F7i(A,e,t,i,r){...}` |
| `U7i` service account | `function U7i(A,e,t){...}` |
| `Qte` service bearer | `function Qte(A){...}` |
| `tct` UMID headers | `function tct(){...}` |
| `HAt` set-if-absent | `function HAt(A,e,t){...}` |
| `z9i` pipeline inject | `async function z9i(A,e,t){...}` (HAt Cosy-Version/ClientType/MachineOS/Hostname) |
| `sendModelServerHttpChat` | headers: Accept/Content-Type/Authorization/X-Request-ID/X-Session-ID |
| `Qyl` gRPC metadata | `function Qyl(A,e){...}` |
| `vot` token | `async function vot(A=IA(),e){...}` |
| `iYe`/`rYe`/`JAt` | blok `eQ=w(()=>{...})`: `x9||"1.1.79-hotfix.11"`, `${arch}_${platform}`, `G9i(Del())` |
| `Jl` client metadata | `function Jl(){...}` |
| `_buildCosyHeaders` (IDE) | `agents-window.desktop.main.js` |
| `_getCosyMachineOS` (IDE) | `_getCosyMachineOS(){...}` |
| `J$5` AOQ voice headers | `function J$5(t){...}` |
| `yf` enum | `yf.Inference/Center/OpenApi` |

### [18] — live CLI v1.1.83 (2026-11-05)

- Captures: `D:\tmp\scratch\qoder-capture\flows\` (flow bukti wire asli v1.1.83; termasuk `032-api1.qoder.sh-GET-misc.txt` untuk roster model 61KB).

### [16] — IDE/HTTP live (2026-11-05)

- Flow 219/220 `D:\tmp\scratch\qoder-capture-oauth\flows2\` (utama: `219-api2-v2.qoder.sh-POST-misc.txt`).

### [13] — gRPC live (2026-11-05)

- Flow `221-api2-v2.qoder.sh-POST-misc.txt` (`D:\tmp\scratch\qoder-capture-oauth\flows3\`).

### [17] — IDE OAuth live (2026-11-05)

- Files: `D:\tmp\scratch\qoder-capture-oauth\flows\` (030, 218, 006, 029, 028, 079).
- GUI dijalankan dari `D:\tmp\unpacked\qoder\run-qoder-win\` (rekonstruksi).
- Error icon (`application-icons/qoder-light-windows.png` ENOENT) minor, tidak memengaruhi network.
- `Cosy-User: 019e9c7a-...` = account "Sunny Koding" (OAuth).

### [9] — delta audit donor vs gateway (2026-11-04)

- Bundle: `D:\tmp\unpacked\qoder\Qoder-unpacked\npm-package\package\bundle\qoder-worker-runtime.mjs` (offset di tabel §8).
- Slice helper: `scripts/scratch/qoder-bundle-slice.ts`.
- Live gateway verification (tool fix): `scripts/scratch/qoder-gateway-live-test.ts`.
- Prior context: `2026-11-04-qoder-grpc-tools.md`, `2026-11-04-qoder-grpc-1m-context.md`.

### [2] Part B — QoderWake (2026-11-01)

- `D:\tmp\qoderwake_latest_darwin_arm64.dmg` (downloaded 2026-11-01)
- `D:\tmp\qoderwake-dmg\` (unpacked app)
- `D:\tmp\qoderwake-strings.txt` (553,784 strings dari `qoderwake`)
- `D:\tmp\qodercli-wake-strings.txt` (611,719 strings dari `qodercli-wake`)

---

*Dokumen konsolidasi — isi tabel, blok kode, dan bukti wire dipertahankan verbatim dari sumber; tanggal live probe dipertahankan per section (2026-11-05, 2026-11-04, 2026-11-01).*
