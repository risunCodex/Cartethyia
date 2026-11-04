# Qoder — Payload Limits per Surface (konsolidasi 2026-11-05)

> ⚠️ Koreksi penting: riset 2026-11-04 menyebut batas gRPC ~8M chars (~1.9M token);
> stress test live 2026-11-05 menunjukkan batas aktual lebih rendah ~5.5M–6M chars.
> Keduanya didokumentasikan — dokumen ini memuat angka final + tabel historis.

## Daftar Isi
- [1. Ringkasan — Angka Kunci](#1-ringkasan--angka-kunci)
- [2. HTTP IDE Limit (`/model/v1`) — 2026-11-05](#2-http-ide-limit-modelv1--2026-11-05)
- [3. gRPC Limit (`ChatService`) — 2026-11-05](#3-grpc-limit-chatservice--2026-11-05)
- [4. Konteks 1M-Token — 2026-11-04](#4-konteks-1m-token--2026-11-04)
- [5. Koreksi Angka & Verdict](#5-koreksi-angka--verdict)
- [6. Implikasi Adapter (final)](#6-implikasi-adapter-final)

## 1. Ringkasan — Angka Kunci

*Sintesis [15]+[12]+[6] — 2026-11-04/05.*

- HTTP IDE cap ≈ 256 KiB (≈262K chars) — `500 internal server error` di atasnya
- gRPC cap ≈ 5.5M–6M chars (≈1.3M–1.4M token) — `413` di atasnya (11-05)
- gRPC = satu-satunya permukaan untuk konteks sangat besar (≥1M token)

## 2. HTTP IDE Limit (`/model/v1`) — 2026-11-05

*Sumber [15] — 2026-11-05.*

Metode: `direct-ide-http.ts` → `POST api2-v2.qoder.sh/model/v1/chat/completions`, OAuth `dt-`, model `dfmodel`, prompt file berukuran bervariasi.

### 2.1 Tabel hasil (8M → 8K chars)

| Ukuran prompt | Status | Catatan |
|---|---|---|
| 8,000,000 chars | **500** | `{"error":"internal server error"}` |
| 1,000,000 | **500** | |
| 524,288 (512K) | **500** | |
| 262,144 (256K) | **500** | |
| 262,000 | **500** | |
| 261,120 (255K) | **200** | ✅ |
| 256,000 (250K) | **200** | |
| 245,760 (240K) | **200** | |
| 229,376 (224K) | **200** | |
| 196,608 (192K) | **200** | |
| 131,072 (128K) | **200** | |
| 65,536 (64K) | **200** | |
| 32,768 / 16,384 / 8,192 | **200** | |

### 2.2 Kesimpulan

- **Limit body IDE/HTTP ≈ 256 KiB (≈ 262,000 chars)** — banget sekitar 256K.
- Di atas itu server jawab `500 internal server error` (bukan 413; ditolak di layer layanan/istio-envoy).
- Konfirmasi research lama: HTTP IDE surface cap ~256 KiB (~60K tokens).
- **8M chars mustahil di permukaan ini** — untuk konteks besar, gRPC (`api2-v2.qoder.sh:443`, proto `ChatService`) adalah satu-satunya (sampai ~8M chars / 1.9M tokens, dari riset 2026-11-04 — lihat koreksi di §3 dan §5).

### 2.3 Implikasi adapter

- Jangan kirim >~256K chars ke `/model/v1/chat/completions`.
- Route konteks besar ke gRPC.
- Perlu fallback/trim bila request > 256K ke surface IDE.

## 3. gRPC Limit (`ChatService`) — 2026-11-05

*Sumber [12] — 2026-11-05.*

Metode: `direct-grpc.ts` → `model.chat.ChatService/ChatCompletionStream` (`api2-v2.qoder.sh:443`), OAuth `dt-`, model `dfmodel`, prompt file bervariasi. gRPC langsung (tanpa proxy).

### 3.1 Tabel hasil (8M → 64K chars)

| Ukuran prompt | Status | Output |
|---|---|---|
| 8,000,000 chars | **413** | `13 INTERNAL: Stream error: 413 Upstream error [stream]`, chunks=0 |
| 6,000,000 | **413** | chunks=0 |
| 5,500,000 | **200** | chunks=152, answer ✅ |
| 5,200,000 | **200** | chunks=105, answer ✅ |
| 5,000,000 | **200** | chunks=141, answer ✅ |
| 4,000,000 | **200** | chunks=118, answer ✅ |
| 2,000,000 | **200** | chunks=197, answer ✅ |
| 1,500,000 | **200** | chunks=148, answer ✅ |
| 1,000,000 | **200** | chunks=197, answer ✅ |
| 524,288 | **200** | chunks=166 |
| 262,144 | **200** | chunks=203 |
| 65,536 | **200** | chunks=144 |

### 3.2 Kesimpulan

- **Limit gRPC ≈ 5.5M–6M chars** (≈ 1.3M–1.4M token). 5.5M masih jalan, 6M ditolak `413`.
- Jauh di atas IDE/HTTP (~256K chars).
- Konfirmasi: gRPC = satu-satunya permukaan untuk konteks sangat besar.
- Research lama menyebut ~8M chars / 1.9M token — live 2026-11-05 menunjukkan batas aktual lebih rendah (~5.5M–6M). Kemungkinan batas server berubah/bergantung model.

### 3.3 Catatan (context_length, dfmodel)

- `dfmodel` (DeepSeek-Flash) merespons normal di semua ukuran ≤5.5M (reasoning + answer).
- Reasonnya mengungkap "user pasted lorem ipsum" — model tetap menjawab.
- `context_length: "8000000"` dikirim di metadata (proto `context_length`), tapi server tetap menolak di 6M+.

### 3.4 Implikasi adapter

- gRPC: cap aman ~5M chars (1.25M token) per request.
- Trim/route ke gRPC untuk >256K chars; jangan harap >5.5M.
- Update riset lama: 8M → ~5.5M-6M.

## 4. Konteks 1M-Token — 2026-11-04

*Sumber [6] — 2026-11-04. Tabel verifikasi di bawah adalah catatan historis; angka gRPC ≥6M sudah dikoreksi oleh §3 (final: lihat §5).*

Qoder mengiklankan context window 1M-token (`context_config` / 1M/400K/200K) pada roster modelnya. **Permukaan HTTP IDE tidak bisa membawanya**: hard-fail dengan `500 {"error":"internal server error"}` begitu body request melebihi ~256 KiB (~60K token ASCII). **Permukaan gRPC (`model.chat.ChatService/ChatCompletionStream`) menerima body hingga ~8M karakter (~1.9M token)** — terverifikasi live, streaming 200 dengan chunk nyata. Jalur gRPC karenanya satu-satunya rute terbukti untuk context 1M-token yang sesungguhnya.

### 4.1 Kenapa HTTP cap ada

- 500 adalah limit layer HTTP, bukan error API Qoder: vocabulary error Qoder (`QoderApiError`) punya `80411 inputContentTooLong`, tapi tidak pernah muncul — request mati di layer proxy/body lebih dulu: `{"error":"internal server error"}`.
- Request gzip ditolak (`400 invalid_request_error`), jadi tidak ada jalan keluar kompresi di HTTP.
- Memecah konten lintas message tidak membantu — cap adalah total ukuran byte body.
- `parameters.context_length` / `metadata.context.context_length` (field yang diset client desktop dari selector context-window) juga tidak menaikkan cap.
- Qoder **tidak** menahan history per `session_id`: marker yang dikirim di turn 0 tidak dikenal di turn 1 ("I don't have to the first message of this…"). Jadi context 1M-token tidak bisa diakumulasi lintas turn — setiap request harus membawa context penuhnya inline.

### 4.2 gRPC surface — request/metadata/stream

Dari klien desktop Qoder yang di-unpack (worker runtime `qoder-worker-runtime.mjs`, v1.1.81, bundled `vendor/qoder-proto/chat.proto`):

```
service model.chat.ChatService {
  rpc ChatCompletion(ChatCompletionRequest) returns (ChatCompletionResponse);
  rpc ChatCompletionStream(ChatCompletionRequest) returns (stream ChatCompletionChunk);
}
```

- Endpoint: `https://{model-server-host}:443/model.chat.ChatService/ChatCompletionStream`
- Model-server host (prod): `api2-v2.qoder.sh` — host sama dengan permukaan HTTP IDE; perbedaan cap ada di transport (framing protobuf vs JSON).
- Auth: gRPC metadata `authorization: Bearer <token>` (token sama dengan HTTP), `x-request-id`, `x-session-id`, `cosy-clienttype`, `cosy-machineos`, `cosy-machinetype`, `cosy-machinetoken`.
- Klien desktop membangun request lewat `QFn()` (memetakan body berbentuk OpenAI ke proto, termasuk `metadata.context.context_length`); jalur gRPC dipakai saat transport dikonfigurasi `grpc` (`settings.transport.protocol = "grpc"`), dan opencode CLI punya flag `--context-window <size>` yang menyet `context_length` yang sama.

### 4.3 Implikasi untuk gateway

1. Untuk benar-benar mengirimkan context 1M-token, adapter Qoder harus mengirim **gRPC** (transport baru), bukan permukaan HTTP IDE.
2. Roster statis/dinamis sudah memilih `max_input_tokens` = window terlebar (1M). Dengan gRPC deklarasi itu menjadi nyata.
3. Pertahankan HTTP sebagai fallback untuk context kecil (< ~60K tokens) — lebih sederhana dan cepat; pindah ke gRPC saat body akan melebihi ~256 KiB.
4. Tidak ada akumulasi sisi-session, jadi request 1M-token harus satu panggilan gRPC dengan history penuh inline. Pada ceiling ~8M chars budget token praktis ≈1.9M token — cukup untuk 1M. (Catatan: ceiling aktual 2026-11-05 lebih rendah — lihat §3/§5.)

### 4.4 Evidence artifacts

- Klien ter-unpack: `D:\tmp\unpacked\qoder\Qoder-unpacked\npm-package\package\bundle\qoder-worker-runtime.mjs` (35 MB) dan `vendor/qoder-proto/chat.proto`.
- Probe scripts (scratch):
  - `D:\tmp\grpc-test\qoder-grpc-probe.ts` (gRPC live probe)
  - `scripts/provider-probing/qoder/chat/qoder-capacity-probe.ts` (HTTP live probe: context acceptance + session retention)
- Roster source of truth (live): `GET /algo/api/v2/model/list?Encode=1` — setiap slot lite-plan membawa `context_config: {1M, 400K, 200K}`.

## 5. Koreksi Angka & Verdict

*Sintesis [6] vs [12] — 2026-11-05.*

| Surface | Cap (11-04) | Cap (11-05, final) | Status |
| HTTP IDE | ~256 KiB | ~256 KiB | ✅ dikonfirmasi |
| gRPC | ~8M chars | ~5.5M–6M chars | ⚠️ dikoreksi (server berubah / bergantung model) |

## 6. Implikasi Adapter (final)

*Sintesis [15] §3 + [12] §4 + [6] §3 — 2026-11-05.*

- Jangan kirim > ~256K chars ke `/model/v1/chat/completions`
- Trim/route konteks besar ke gRPC; cap aman ~5M chars (~1.25M token)
