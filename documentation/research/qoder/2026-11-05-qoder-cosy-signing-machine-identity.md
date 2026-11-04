# Qoder — COSY Signing & Machine Identity (konsolidasi 2026-11-05)

**Tanggal konsolidasi:** 2026-11-05
**Sumber:**
- [11] `2026-11-05-qoder-cosy-wasm-deepdive.md` — deep-dive alur COSY + WASM signing (worker NSIS 0.5.3; sumber dihapus saat konsolidasi — isi substantif dipertahankan pada dokumen ini)
- [2] `2026-11-01-qoder-chat-wire-verification.md` (2026-11-01) — **Part A saja** (native plugin vs adapter; sumber dihapus saat konsolidasi)
- Rujukan silang: [23] NSIS §8 (`2026-11-05-qoder-win-nsis-0.5.3-audit.md`), [14] IDE §8 (`2026-11-05-qoder-ide-1.38-audit.md`), [1] credits Part C/E/G (`2026-11-05-qoder-credits-claims-identity.md`)

## Daftar Isi
- [1. Ringkasan — Kenapa COSY adalah satu-satunya yang WORK](#1-ringkasan--kenapa-cosy-adalah-satu-satunya-yang-work)
- [2. Alur COSY Penuh — dari Worker NSIS](#2-alur-cosy-penuh--dari-worker-nsis)
- [3. Native Plugin vs Adapter — 2026-11-01](#3-native-plugin-vs-adapter--2026-11-01)
- [4. Machine Identity — UMID](#4-machine-identity--umid)
- [5. Detail yang Beda dengan Adapter Cartethyia](#5-detail-yang-beda-dengan-adapter-cartethyia)
- [6. Rekomendasi untuk Adapter](#6-rekomendasi-untuk-adapter)
- [7. Evidence](#7-evidence)

---

## 1. Ringkasan — Kenapa COSY adalah satu-satunya yang WORK

*(Sumber: [11] §1 — 2026-11-05)*

Dari worker NSIS 0.5.3 (`qoder-worker-runtime.obf.mjs` v1.1.79-hotfix.11, 34.8MB), COSY adalah satu-satunya permukaan chat yang hidup dan dipakai default. gRPC/IDE HTTP ada tetapi bukan jalur chat utama.

### 1.1 Status permukaan chat (COSY aktif; gRPC untuk 1M ctx; HTTP modern ada)

| Permukaan | Fungsi worker | Status |
|---|---|---|
| **Legacy COSY** | `F()` → `F7i()` → `prepareInferRequest()` → `M.send({transport:"legacy"})` | **AKTIF** — default untuk non-service-account, yang `infer-sse` |
| gRPC | `ChatCompletionStream` via `acquireRoutedClient` | ada, tapi bukan default chat; dipakai untuk 1M ctx (per riset adapter) |
| HTTP modern | `Mot()` = `https://<model-server>/model/v1/chat/completions` | ada; requestClass `infer-sse` |
| Model list | `act()` → `prepareRequest(A,e,"GET","auth")` | aktif, `/api/v2/model/list?Encode=1` |

### 1.2 Bukti dua path dikenali (`Ghl()`)

`Ghl()` membuktikan dua path chat sama-sama dikenali:
`/algo/api/v2/service/pro/sse/agent_chat_generation` dan
`/model/v1/chat/completions`.

---

## 2. Alur COSY Penuh — dari Worker NSIS

*(Sumber: [11] §2–§3 — 2026-11-05)*

### 2.1 Gerbang: `F()` (sendRemoteChatAsk)

```
F():
  o = X1({operation:"sendRemoteChatAsk", route:E})        // resolve route
  d = wnt(o, E)                                           // route detail
  I = F7i(o, w, p, f, r)                                  // ⭐ sign + headers
  E = I.headers                                            // hasil WASM
  SPl(E, s)                                                // inject trace (kalau belum ada)
  if serviceAccount: skip codebase headers
  else if workdirs && targetOrg: applyCodebaseHeadersForWorkdirs(E, n)
  M.send({ url:I.url, transport:"legacy", body:I.body, headers:E, ... })
    dispatch: { endpointType:"infer", method:"POST", requestClass:"infer-sse",
                injectClientIdentityHeaders: !r.isServiceAccount(), ... }
```

### 2.2 Signing: `F7i` (persis donor adapter)

```
F7i(A, e, t, i, r):            // A=endpoint, e=bodyJson, t=modelKey, i=modelSource, r=authManager
  if r.isServiceAccount():
    return U7i(r, "text/event-stream", r => r.prepareInferRequest(A,e,t,i))
  n = tct()                      // {Cosy-MachineToken, Cosy-MachineType} dari UMID
  o = dE(r => r.prepareInferRequest(A,e,t,i))   // WASM sign
  s = Jp(o.headers)              // Headers → object
  for k in Object.keys(s):
    if ["cosy-machinetoken","cosy-machinetype"].includes(k.toLowerCase()):
      delete s[k]                // hapus token/type dari hasil WASM
  return {...s, ...n}            // timpa dari UMID
```

- `dE` = factory; kalau `QoderContext` invalid → auto-recover via `h8i()`.
- `U7i` (service account):
  ```
  headers = {...Qte(A), "Content-Type":"application/json", Accept:"text/event-stream"}
  ctx = new QoderContext("", "", Hxl)      // Hxl = {"uid":"","encrypt_user_info":"","key":""}
  i = ctx.prepareInferRequest(...)
  ```
- `Qte(A)` = `{Authorization: Bearer <serviceAccountPrincipal.token>}`.

### 2.3 QoderContext (WASM) — konstruksi

```
qxe(A, e, t):
  nge = {machineId:A, cosyVersion:e, userInfoJson:t}
  r = JSON.stringify(Jl())          // clientInfoJson
  K1 = new QoderContext(A, e, t, r)

Jl():                               // client metadata → param ke-4
  client_type    = env[QODER_CLIENT_TYPE] ?? (A ? wzt : GaA)
  business_product = env[QODER_BUSINESS_PRODUCT] ?? (A ? y0e : Szt)
  business_type  = env[QODER_BUSINESS_TYPE] ?? Dzt
  scene          = env[QODER_SCENE] ?? yzt
```

- `HYe()` (async factory): `getMachineId()` → `getVersion()` → `new QoderContext(machineId, version, Rol, JSON.stringify(Jl()))` — `Rol` = userInfo kosong seperti di atas.

### 2.4 Header yang dihasilkan

Dari WASM `prepareInferRequest`:
- `authorization: Bearer COSY.<payload>.<signature>`
- `cosy-key`, `cosy-bodyhash`, `cosy-sigpath`, `cosy-machinetype/5`,
  `cosy-clienttype/5`, `appcode: cosy`, `signature` (MD5), `cosy-version`,
  `login-version`, `date`, `accept`, `accept-encoding`, `content-type`, `user-agent`

Dari layer worker (injectClientIdentityHeaders, `HAt` set-if-absent):
- `Cosy-Version` = `iYe` (1.1.79-hotfix.11)
- `Cosy-ClientType` = `Jl().client_type` (5 intl / 6 CN)
- `Cosy-MachineOS` = `rYe` (`x86_64_win32`)
- `Cosy-MachineHostname` = `oYe()` (sanitized) hanya saat `requestClass="infer-sse"`
- `Cosy-MachineToken/Type` = dari `tct()` (UMID) — **menimpa** hasil WASM

Trace: `fO()` (OTel traceparent) via `SPl` (inject kalau belum ada).

### 2.5 Codebase headers (fitur baru, belum di adapter)

`applyCodebaseHeadersForWorkdirs(A, e)`:
- hanya kalau `ou().isTargetOrganization()`
- per workdir: `dUn(A)` (git remotes) → `uUn(e)` (hash) → cache mem/file → miss = `getOrFetchStatus(A)`
- set header: `cosy-codebase-status`, `cosy-codebase-soft-status`, `cosy-codebase-tags`, `cosy-codebase-external-id`, `cosy-codebase-git-remotes` (+ `Cosy-Codebase-*`)

### 2.6 Alur non-chat yang ikut sign

- **Model list** (`act`):
  - service account → `{url: GK(A,e), headers: {...Qte(t), Accept:"application/json"}}`
  - lain → `dE(t => t.prepareRequest(A, e, "GET", "auth"))` → `Jp(i.headers)`
- **OpenAPI/business** (`v7i`): `U7i(r, "application/json", r => r.prepareRequest(A,e,t,"auth",i,void 0))`
- **Upload image**: `prepareRequest(...,"PUT","auth")` + header `AI-CLIENT-TIMESTAMP` (timestamp detik).
- **Refresh auth fields**: `generate_runtime_auth_fields(userInfo)` → `{encrypt_user_info, key}`.
- **Response decryption**: `decrypt_server_response(A)` dipakai untuk response business endpoint.

---

## 3. Native Plugin vs Adapter — 2026-11-01

*(Sumber: [2] Part A — 2026-11-01)*

Audit plugin JetBrains Qoder (produk jar `instrumented-qoder-product-2026.1030.84844323.jar`, native payload `qoder-2026.1030.1.zip`, commit `acc39d3`, built 2026-10-30 15:32:57) terhadap `src/providers/integrations/qoder/qoder.ts`. String statis diekstrak dari native `Qoder.exe` (x86_64) ke `D:\tmp\qoder-strings.txt` (713,985 entries). Tidak ada binary yang dieksekusi.

### 3.1 Verified matches (adapter == native)

| Wire element | Evidence |
|---|---|
| Body alphabet transform | Alphabet string byte-identical in binary: `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!` (line 560198) |
| COSY token shape | `Bearer COSY.%s.%s` (line 85969) — matches `qoderBuildCosyHeaders` `authorization` |
| Go static headers | `appcode`, `date`, `signature = md5(cosy&<b64secret>&<date>)` — matches `qoderStaticHeaders`; `Login-Version` present in binary (line 85783) |
| Client triplet | `"client_type":"%s","client_version":"%s","os":"%s"` (line 87157) — matches `client_type/client_version/os` JSON triplet |
| PAT exchange | `jobToken response missing id/securityOauthToken (id=%q token=%q)` (line 87338) — matches `exchangeQoderPat` shape check; `login_with_qoder_pat` (line 86183) |
| CN PAT path | `qodercn pat exchange server error: %s` (line 86909) — confirms CN PAT exchange exists (adapter uses `openapi/api/v1/jobToken/exchange`) |
| COSY Bearer scheme | Already verified live against `api2.qoder.sh` (see [credits/claims/identity](2026-10-29-qoder-credits-claims-identity.md)) — same scheme the chat adapter sends |

### 3.2 Header delta — present in native, absent from chat adapter

| Header (binary) | Adapter chat request |
|---|---|
| `Cosy-ClientIp` (line 85783) | not sent |
| `X-Qoder-Routing-Policy-Id` (line 86516) | not sent |
| `X-Qoder-Remote-Protocol-Version` (line 86733) | not sent |
| `X-Model-Name` (line 85716) | adapter sends `x-model-key` / `x-model-source` instead (different name) |
| `Cosy-MachineCode` (line 85929) | only in `qoder-checkin` (UMID); not merged into chat dispatch |
| `Cosy-MachineHostname` (line 86179) | sent in chat dispatch (`qoder.ts:1152`, `qoderMachineHostname()`); also used by `qoder-checkin` |
| `Content-Length` | native sets it explicitly (`Content-Length: %v`, line 86306); adapter lets `fetch` set it — functionally equivalent |

Non-issue: native header casing is PascalCase (`Cosy-Key`, `Cosy-User`,
`Cosy-Date`); adapter sends lowercase. HTTP header names are case-insensitive,
and Go's client canonicalizes them, so this is cosmetic.

Adapter-only headers not visible in the native string pool: `cosy-bodyhash`,
`cosy-bodylength`, `cosy-sigpath`, `cosy-business-product/type/version`,
`cosy-scene`, `cosy-organization-tags`. These come from the COSY Bearer
implementation, which has been verified working against the live host; their
absence from the string pool is not evidence they are wrong (Go builds header
names and values from variables, so they may not appear as contiguous
literals).

### 3.3 Signature schemes — dua path (COSY Bearer vs ...)

1. **COSY Bearer** (chat request, `qoderBuildCosyHeaders`): md5 chain over
   `payload \n cosyKey \n date \n body(latin1) \n sigPath`, RSA-encrypted AES
   key, `Bearer COSY.payload.sig`. Ini adalah scheme yang dipakai native client
   untuk trafik chat `/algo` dan terverifikasi berfungsi.
2. **Gateway HMAC "Signature"** (endpoint non-chat, mis. activity claim) —
   didokumentasikan di [credits/claims/identity](2026-10-29-qoder-credits-claims-identity.md):
   `bodyHash = sha256(String(contentLength))` (hash dari *string panjang*),
   `sts = ${method} ${path} ${requestId} ${machineToken} ${ts} ${bodyHash}`,
   `sig = HMAC-SHA256(secret, sts)` dengan
   `secret = sha256("cosy:" + ideVersion + ":" + machineToken)`. Ini scheme
   terpisah dari COSY Bearer dan tidak dipakai chat adapter.

Temuan lama "signature men-hash content-length string" merujuk ke scheme
gateway HMAC, bukan chat signer COSY Bearer. Chat adapter benar men-hash body
mentah: itulah yang dilakukan COSY Bearer.

### 3.4 machineId semantics

- **Native:** hardware-derived (`GetMachineId`, disk serial + MAC,
  `device info machineSerialNum is: device info diskSerialNumber is`), satu per
  mesin fisik, stateless/token adalah fungsi murni dari hardware.
- **Adapter:** jalur OAuth memakai `auth_state.machineId` jika ada, selain itu
  UUID turunan per-akun (`sha256("qoder-machine-v1:" + accountId)`); jalur PAT
  mencetak UUID acak dengan TTL 1 jam. Ini deviasi yang disengaja untuk
  pooling: akun pool tetap memakai satu sidik jari device stabil per akun
  lintas restart, bukan tampak sebagai device baru tiap kali, tetap berbeda per
  akun (ditetapkan di
  [UMID/identity findings](2026-10-29-qoder-credits-claims-identity.md):
  permukaan claim daily-credit tidak mengunci pada identitas asli).

### 3.5 Live probe results (2026-11-01, real OAuth account)

| Probe | Endpoint | Result |
|---|---|---|
| Plugin COSY, adapter's exact header set | `api2.qoder.sh/algo/.../agent_chat_generation` | **200 + streaming `choices[].delta.reasoning_…`** — chat works with the adapter's headers as-is |
| Plugin COSY + native-only headers (`Cosy-ClientIp`, `X-Qoder-Routing-Policy-Id`, `X-Qoder-Remote-Protocol-Version`) | same | **200 + streaming** — same behavior; those headers are not a prerequisite for chat (an earlier 103 duplicate was an upstream duplicate-guard on an identical record id, not a header rejection) |
| IDE modern path, plain `Bearer <dt-…>` + `X-Request-ID`/`X-Session-ID` | `api2-v2.qoder.sh/model/v1/chat/completions` | **200**, `event: error provider_error "All models failed"` — token accepted (no 401/403), but model-server surface failed at provider level with model `auto` |
| IDE modern path + `cosy-version`/`cosy-clienttype`/`cosy-machineos`/`cosy-machinetoken`/`cosy-machinetype` | same | same `provider_error "All models failed"` |

Kesimpulan utama:

- Jalur chat COSY Bearer plugin **bekerja end-to-end dengan set header adapter
  saat ini**; streaming token asli.
- Tiga header khusus native tidak memengaruhi penerimaan chat — menambahkannya
  tidak mengubah apa pun yang teramati.
- Surface IDE mengautentikasi token `dt-` yang sama sebagai plain Bearer, tetapi
  probe "all models failed" awal disebabkan model dikirim sebagai `auto`/nama
  virtual — upstream menolak nama virtual yang tak ter-resolve
  (`invalid_model_error`) atau jatuh ke `auto`. Mengirim roster key yang
  ter-resolve (mis. `qfmodel`) langsung streaming (lihat Part B).

---

## 4. Machine Identity — UMID

*(Sumber: [23] §8.3 + [14] §8.1 — 2026-11-05; rujukan [1] — 2026-10-29 → 2026-11-04)*

### 4.1 Komponen (runtime-info, sgsdk.dll, seed replay)

Dari audit NSIS [23] §8.3:
- `app/resources/umid/manifest.json`: target win32-x64; `runtime-info.exe` (480,752 B) + `sgsdk.dll` (7,354,928 B); SHA256 diverifikasi worker (`ztt` membandingkan hash file terhadap manifest).
- Worker runtime: layanan `umid` (`j8i="umid"`), versi skema 1 (`V8i=1`), schema `{version, environment, platform, arch, info:{machineToken, machineType, machineCode, vmInfo:{isVm, brand, percentage, vmTypeCode}}}`.
- Binary di-embed (base64) atau diekstrak ke cache `umid-win32-<env>-<hash16>`, dengan binDir `runtime-info.exe` + `sgsdk.dll` (Windows). Memanggil `runtime-info.exe <env>` (env code — di adapter `ENV_CODE=3`); platform Linux/darwin memakai ELF/Mach-O (di luar artifact ini).
- Machine headers di HTTP: `Cosy-MachineId: <uuid>`, `Cosy-MachineToken: <machineToken>`, `Cosy-MachineType`, `Cosy-MachineCode`, `Cosy-MachineOS`, `Cosy-MachineHostname`.

Dari audit IDE [14] §8.1 — verifikasi di bundle, `qQo(t)` memeriksa kelengkapan `cosyVersion && machineToken && machineType && machineCode && machineId && machineOS && machineHostname`:

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
  "Cosy-…": …  // terpotong
};
```

- Sumber: `machineInfoService` → `sendRequestToExtension({method:"aicoding.getMachineInfo", params, targetRemoteAuthority})` → native bridge (umid). Ini persis mekanisme yang adapter rekonstruksi (`qoder-umid.ts`: runtime-info ELF/PE/Mach-O + seed replay → cosy-machineid/machinetoken/machinetype/machinecode).
- Cache: `qoderAuth` (localStorage key), proses auth shared (`authSharedProcessService`), fallback kosong `{cosyVersion:"",machineToken:"",machineType:"",machineCode:"",machineId:"",machineOS:"",machineHostname:""}`.
- `getCachedLoginMachineIdentity()` → `_readPersisted...` (persisted). Kegagalan `requireComplete:true` → throw.

### 4.2 Derivation `machine_id` lokal

- Hardware (`system()`/uuid/serial) → `sha256("qoder-machine-id:v1:<platform>:<uuid-lower>")` atau random UUID; disimpan di credential storage (`o8i`).
- UMID service refresh: stale 120s, update 10s, retry; cache disk restore; disable via env `DISABLE_UMID_REPORT=1|true|...`.

### 4.3 Verdict server (real vs generated UMID)

Keputusan server mana yang menerima UMID asli vs yang dihasilkan — verdict live per campaign (termasuk temuan bahwa CREDITS hanya terlihat dengan real UMID, dan bahwa permukaan claim daily-credit tidak mengunci pada identitas asli) — dijelaskan lengkap di **Dokumen 09: [`2026-11-05-qoder-credits-claims-identity.md`](2026-11-05-qoder-credits-claims-identity.md) Part C.3/F.2** (sebelumnya `2026-10-29-qoder-credits-claims-identity.md`). Rujuk ke sana; tidak diduplikasi di sini.

### 4.4 Policy per-campaign

Analisis pola same-person/claim-id per campaign dan titik putusnya (worker vs VPS) — **Dokumen 09: [`2026-11-05-qoder-credits-claims-identity.md`](2026-11-05-qoder-credits-claims-identity.md) Part E**. Rujuk ke sana; tidak diduplikasi di sini.

---

## 5. Detail yang Beda dengan Adapter Cartethyia

*(Sumber: [11] §4 — 2026-11-05)*

| Aspek | Worker (source) | Adapter | Catatan |
|---|---|---|---|
| `cosy-version` | `1.1.79-hotfix.11` | `getQoderVersion()` (1.1.80/81) | sesuaikan bila divalidasi |
| client_type | `Jl().client_type` (5/6) | `5` (header cosy) | sama utk intl |
| machine token | `tct()` dari UMID runtime-info | `qoderMachineHeaders` (native/generated P1gA) | format beda utk fallback |
| codebase headers | ada | **tidak ada** | Fitur baru |
| `x-model-key`/`x-model-source` | **tidak ada** (modelKey/source masuk WASM) | adapter menambah header terpisah | bisa jadi noise |
| injectClientIdentityHeaders | flag per request (false utk model-list service account, upload) | selalu inject | sesuaikan |
| `Cosy-MachineHostname` | hanya saat `infer-sse` | selalu dev `DESKTOP-QODER` | ganti ke sanitized hostname |
| model list | `GET /api/v2/model/list?Encode=1` | sama (`QODER_MODELS_PATH` = `/algo/api/v2/model/list?Encode=1`) | ⚠️ BEDA prefix: worker TANPA `/algo` |
| jobToken exchange | `/api/v1/jobToken/exchange` openapi | intl pakai v3 center | 2 generasi; worker lebih modern |

---

## 6. Rekomendasi untuk Adapter

*(Sumber: [11] §5 — 2026-11-05; [2] A.2 — 2026-11-01)*

1. **Hapus `x-model-key`/`x-model-source` headers** — worker tidak mengirimnya;
   modelKey/modelSource hanya argumen WASM. (Selaras delta A.2: native memakai
   `X-Model-Name`, bukan nama berbeda ini.)
2. **`Cosy-MachineHostname`**: pakai `os.hostname()` sanitized, bukan hardcoded
   `DESKTOP-QODER`.
3. **Model list path**: pastikan `/api/v2/model/list?Encode=1` (tanpa `/algo`).
4. **Perhatikan `injectClientIdentityHeaders`** — jangan inject machine headers utk
   service-account dan model-list.
5. **Codebase headers** (`cosy-codebase-*`): baru, belum di-port — opsional.
6. **`cosy-version`**: samakan dengan versi donor terbaru.

---

## 7. Evidence

*(Sumber: [11] §6 — 2026-11-05; [2] §Evidence — 2026-11-01)*

| Klaim | Lokasi di worker |
|---|---|
| `F7i` sign flow | `function F7i(A,e,t,i,r){...}` |
| `U7i` service account | `function U7i(A,e,t){...}` |
| `Qte` service bearer | `function Qte(A){...}` |
| `tct` UMID headers | `function tct(){...}` |
| `dE` / `h8i` / `k6` factory & recovery | `function dE(A){...}` dst |
| `qxe` / `HYe` context builder | `function qxe(A,e,t){...}`, `function HYe(){...}` |
| `Jl` client metadata | `function Jl(){...}` |
| `HAt` set-if-absent | `function HAt(A,e,t){...}` |
| `Qyl` gRPC metadata setter | `function Qyl(A,e){...}` |
| `Cde` route table | `Cde={prod:{...},daily:{...},test:{...}}` |
| `Uel` region map | `Uel={us:..., sg:..., jp:...}` |
| `_0` env parsing | `function _0(){...}` |
| model list path | `Jxt="/api/v2/model/list?Encode=1"` |
| `Ghl` path detection | `function Ghl(A){...}` |
| codebase headers | `applyCodebaseHeadersForWorkdirs` |
| HMAC canonical | `oZt` / `X-Client-Timestamp` / `Authorization: Signature` |

File bukti audit native plugin ([2] §Evidence):

- `D:\tmp\qoder-jetbrains-unpacked\qoder-jetbrains\lib\instrumented-qoder-product-2026.1030.84844323.jar`
- `D:\tmp\Qoder.exe` (extracted native x86_64 binary, string source)
- `D:\tmp\qoder-strings.txt` (713,985 extracted strings)
- `D:\tmp\binaries-qoder-2026.1030.1.zip` (config.json/env.json)
- `D:\tmp\qoderwake_latest_darwin_arm64.dmg` (downloaded 2026-11-01)
- `D:\tmp\qoderwake-dmg\` (unpacked app)
- `D:\tmp\qoderwake-strings.txt` (553,784 strings from `qoderwake`)
- `D:\tmp\qodercli-wake-strings.txt` (611,719 strings from `qodercli-wake`)
