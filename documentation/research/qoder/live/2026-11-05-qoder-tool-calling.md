# Qoder — Tool-Calling: Probe, Postmortem & Matrix (konsolidasi 2026-11-05)

## Daftar Isi
- [1. Ringkasan — Pola Delta & Fix](#1-ringkasan--pola-delta--fix)
- [2. Probe Live — IDE/HTTP + gRPC (2026-11-05)](#2-probe-live--idehttp--grpc-2026-11-05)
- [3. Postmortem — 2026-11-03 (full)](#3-postmortem--2026-11-03-full)
- [4. Matrix Historis — via CarteLocal (2026-11-03)](#4-matrix-historis--via-cartelocal-2026-11-03)
- [5. Implikasi Adapter (final)](#5-implikasi-adapter-final)
- [6. Fix Live 2026-11-05 — gRPC tool-call stitching (single + paralel)](#6-fix-live-2026-11-05--grpc-tool-call-stitching-single--paralel)

## 1. Ringkasan — Pola Delta & Fix

- Pola delta id kosong (`id: ""` pada continuation chunk) — **dikonfirmasi di kedua surface** (IDE/HTTP dan gRPC), konsisten dengan pola yang dulu memicu postmortem 2026-11-03.
- Fix adapter: empty `id` = missing id, sehingga continuation re-joins ke pinned first-seen id per wire `index`.
- Fix streaming: `sniffQoderStream` (peek ≤64 KiB, forward progresif) menggantikan `drainQoderResponse` (yang sempat mengakibatkan stream tiba sekaligus di akhir).

## 2. Probe Live — IDE/HTTP + gRPC (2026-11-05)

**Sumber:** probe live `direct-toolcall.ts` (2026-11-05): request dengan satu tool `get_weather` (schema: `{city: string}`) + prompt "Panggil tool get_weather dengan kota Jakarta". OAuth `dt-`, model `cmodel` (Cantus). Surfaces: IDE/HTTP (`/model/v1`) + gRPC (`ChatService`); COSY di-skip.

### 2.1 Hasil (kedua surface 200/0, tool args populated)

| Surface | Status | finish_reason | Tool call |
|---|---|---|
| IDE/HTTP | 200 | (none / tidak di-frame) | ✅ `get_weather` + `{"city":"Jakarta"}` |
| gRPC | grpc-status=0 | `tool_calls` | ✅ `get_weather` + `{"city":"Jakarta"}` |

Kedua surface menghasilkan **pola delta yang sama persis**:

```
chunk[0]: delta.tool_calls = [
  { id: "toolu_01GCv7qcjRJuVqvfqhDQ91gr", index: 0, type: "function",
    function: { name: "get_weather", arguments: "" } }
]
chunk[1] (lanjutan): delta.tool_calls = [
  { index: 0, type: "function",
    function: { name: "", arguments: "{\"city\": \"Jakarta\"}" } }   ← id kosong!
]
```

Fragmen args perlu di-stitch: `id` hanya muncul di chunk pertama; lanjutan membawa `index` + `function.arguments`. Fallback id = `call_<index>`.

### 2.2 Catatan gRPC

- gRPC mengirim `delta.tool_calls` sebagai **repeated Struct wrapper** (`{fields: {id: {stringValue}, function: {structValue...}}}`) — harus di-unwrap (`fromProtoStruct`) sebelum baca id/index/function.
- Setelah unwrap, shape sama persis dengan IDE/HTTP.

### 2.3 Body tool (request)

OpenAI-shaped, didukung dua surface:
```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a city",
    "parameters": {
      "type": "object",
      "properties": { "city": { "type": "string", "description": "City name" } },
      "required": ["city"]
    }
  }
}
```
- IDE/HTTP: `tools` + `tool_choice:"auto"` + `parallel_tool_calls:true` (JSON body).
- gRPC: `tools` (proto) + `tool_choice:{stringValue:"auto"}` + `parallel_tool_calls:{value:true}`.

### 2.4 Implikasi adapter

- Parser tool-call delta umum untuk dua surface: stitch by `index`, id first-seen, arguments accumulate.
- gRPC wajib unwrap Struct (`fromProtoStruct`) — adapter sudah punya (`qoder-grpc.ts` `fromProtoStruct`).
- `finish_reason=tool_calls` hanya muncul eksplisit di gRPC (IDE/HTTP menutup via `[DONE]` + raw_usage).

---
*Script: `scripts/provider-probing/qoder/direct/direct-toolcall.ts` (`--surface ide,grpc`).*

## 3. Postmortem — 2026-11-03 (full)

**Sumber:** investigasi defect tool-calling Qoder lewat gateway lokal Cartethyia (`CarteLocal` di `127.0.0.1:12800`), 2026-11-03. Dokumen ini adalah sumber tunggal kebenaran untuk gejala, hipotesis, bukti, root cause, fix, dan verifikasi sesi 2026-11-03.

### 3.1 TL;DR (dua defect)

Dua defect independen membuat tool call Qoder tampak rusak:

1. **Empty `arguments: ""` pada beberapa roster slot.** Upstream *memang* mengirim arguments terisi; SSE translator gateway meng-orphan setiap fragmen argument karena continuation chunk meng-echo `id: ""` (string kosong), yang diperlakukan sebagai id call baru, bukan "tidak ada id". Diperbaiki di `qoder.ts`: empty `id` berperilaku seperti missing id, sehingga fragmen re-joins ke pinned first-seen id per wire index.
2. **Stream tampak "selesai mendadak".** Empty-stream recovery (`fetchQoderIdeWithEmptyRecovery`) meng-drain *seluruh* body upstream sebelum di-forward, sehingga setiap stream (Qwen dan DeepSeek) tiba dalam satu burst di akhir. Diganti `sniffQoderStream`: peek hanya chunk pertama (≤ 64 KiB) untuk menilai meaningful-ness, lalu forward sisanya secara progresif.

Faktor environment tambahan: gateway hanya merutek ke satu akun aktif **Sunny Koding** (free tier, quota 0), yang memancarkan empty arguments di setiap slot. Mengaktifkan akun add-on **Akun Ytprem** (100 credits) dan menonaktifkan akun free membuat rute deterministik.

### 3.2 Symptoms

- `tool_calls` dipancarkan dengan `arguments: ""` (kosong) untuk sebagian roster slot Qoder, dengan `finish_reason: tool_calls` dan tool name yang benar.
- Blok teks DSML/leak kadang muncul sebagai konten terlihat (lebih awal di sesi; perbaikan level protokol, lihat commits).
- Respons stream tidak streaming: semua chunk tiba sekaligus, setelah kesunyian panjang, lalu `[DONE]`.

### 3.3 Environment & setup (CarteLocal, account, roster slots)

- Gateway: Cartethyia dev (`bun run dev`), reverse proxy publik `:12800` → backend `:12801`.
- Provider adapter: `src/providers/integrations/qoder/qoder.ts` — **IDE-first** (`surface === "ide"` → `/model/v1/chat/completions` di `api2-v2.qoder.sh`), COSY legacy fallback hanya pada HTTP 402 + model free-tier.
- Akun Qoder di `provider_accounts`:
  - **Sunny Koding** — free tier (`PLAN_TIER_FREE`, quota 0), dulu satu-satunya akun aktif; memancarkan empty args di setiap slot.
  - **Akun Ytprem** (`7f9d9d0c-dbe6-4ee5-99f2-ec2457c568b5`) — add-on 100 credits, dulu `disabled`; OAuth token `dt-…` (credential DB terdekripsi identik byte dengan file akun yang diekspor).
  - anjir baru, pleged lenger — disabled.
- Roster slots (virtual id → key): `qwen3.7-max`→`qmodel_latest`, `qwen3.7-plus`→`qmodel`, `qwen3.8-max`→`qmodel_38max`, `qwen3.8-flash`→`qfmodel`, `deepseek-v4.1-flash`→`dfmodel`, `lite-qwen-3.7-plus`→`lite`.

### 3.4 Timeline — root cause #1 (empty id) & #2 (streaming)

Langkah investigasi menuju root cause:

1. **Slot matrix (original):** baterai terkontrol melawan gateway (satu tool `bash` function, stream + non-stream, 4 trials, varian `tool_choice`/`parameters`/`strict`):

| Slot | Arguments before fixes |
| --- | --- |
| `dfmodel` (`deepseek-v4.1-flash`) | ✅ populated |
| `lite` (`lite-qwen-3.7-plus`) | ✅ populated |
| `qmodel` (`qwen3.7-plus`) | ✅ populated |
| `qmodel_38max` (`qwen3.8-max`) | ✅ populated |
| `qfmodel` (`qwen3.8-flash`) | ❌ always `""` |
| `qmodel_latest` (`qwen3.7-max`) | ❌ always `""` |

Slot kosong awalnya salah diatribusikan ke perilaku upstream. Matrix penuh: `2026-11-03-qoder-tool-call-matrix.md`.

2. **IDE vs COSY surface comparison:** signer COSY asli 9router (`Public/9router/open-sse/shared/qoder/cosy.js`, `encoding.js`, `constants.js`) diimpor ke `compare-ide-cosy2.mjs`. IDE surface (`api2-v2/model/v1`) + roster key `qmodel_latest` + `dt-*` → arguments **populated** (3/3 di run pertama harness; panggilan paralel flaky kadang truncate). COSY legacy (`api3…/agent_chat_generation`) hang/terminates dari host ini; tidak bisa diverifikasi. Adapter IDE-first; `endpoint_path` di DB tidak diawali `http`, jadi `qoderIdeChatUrl(this.realm)` menang → `api2-v2` (IDE). Gateway mengambil path IDE, bukan COSY.

3. **Account routing diagnosis:** `provider_routing_settings` untuk `qoder`: `round_robin`, `rotate_count: 2`. Hanya **Sunny Koding** yang `active`; tiga akun add-on `disabled`, sehingga setiap request mendarat di akun free → empty args di mana-mana. **Akun Ytprem** diaktifkan (SQL literal — `bun:sqlite` bound-parameter dengan `?` mengembalikan 0 rows / `undefined` untuk `provider_id='qoder'` dan `id=?`; interpolasi literal wajib di skrip scratch). Setelah aktif, `qwen3.8-max` dan `deepseek-v4.1-flash` populated 3/3, tapi `qwen3.8-flash` dan `qwen3.7-max` masih empty.

4. **Direct upstream ground truth:** request IDE langsung (sama `dt-*`, body shape sama, `tool_choice: "required"`): `qfmodel` → **3/3 OK** (arguments `{"command": "echo hello"}`); `qmodel_latest` → 2/2 OK (satu truncated parallel call dihitung BAD). Kesimpulan: upstream **memang** populate arguments di slot-slot ini; empty args adalah artefak gateway/adapter.

**Root cause #1 — raw stream capture.** Capture SSE upstream untuk `qfmodel` (langsung, token DB terdekripsi, body berbentuk adapter):

```
frame 1: { tool_calls: [{ function: { arguments: "", name: "bash" }, id: "call_7b572c5c…", index: 0 }] }
frame 2: { tool_calls: [{ function: { arguments: "{\"command\": " }, id: "", index: 0 }] }
frame 3: { tool_calls: [{ function: { arguments: "\"echo hello" }, id: "", index: 0 }] }
…        (fragments until `}`)
```

Chunk pertama membawa id asli; **setiap continuation chunk meng-echo `id: ""`**. Di `qoderBodyToCanonicalEvents`, `declaredId` didefinisikan sebagai "`typeof id === 'string'`", jadi `""` dihitung sebagai id yang dideklarasikan. Setiap fragmen di-buffer di bawah call id `""`, terpisah dari call asli (`call_7b572c5c…`). Saat flush, call asli memiliki `arguments: ""` dan fragmen di bawah `""` hilang.

**Root cause #2 — streaming timeline.** `capture-stream-timeline.mjs` mencatat waktu kedatangan per-event lewat gateway:

```
Before fix (qwen3.8-flash): all 12 events at t=994ms, gap 0
Before fix (deepseek-v4.1-flash): all 15 events at t=1109ms, gap 0
Direct upstream (qfmodel): reasoning deltas 17–76ms apart, tool fragments ~30ms apart
```

Root cause: `fetchQoderIdeWithEmptyRecovery` memanggil `drainQoderResponse`, yang membaca **seluruh** body sebelum membangun `Response` baru, sehingga parser kanonik hanya melihat stream yang sudah ter-buffer penuh.

### 3.5 Fixes (qoder.ts)

**Fix #1 — empty call-id fragments (src/providers/integrations/qoder/qoder.ts)**

```ts
// `id` is only meaningful when non-empty: some Qoder slots echo
// `id: ""` on continuation chunks, and treating that as a fresh
// call id would orphan every argument fragment (the real call
// keeps its first-seen id, the fragments pile up under "").
const declaredId =
  typeof tc["id"] === "string" && (tc["id"] as string).length > 0
    ? (tc["id"] as string)
    : undefined;
```

Continuation fragments kini jatuh ke pemetaan id yang di-pin `index` (atau `lastSeenToolId`), sehingga fragmen bergabung kembali ke call yang benar.

**Fix #2 — progressive streaming (src/providers/integrations/qoder/qoder.ts)**

- `drainQoderResponse` / `QoderStreamDrain` diganti `sniffQoderStream`: membaca hingga 32 chunk (atau 64 KiB) body, memutuskan `meaningful` hanya dengan mencari `"content":"` atau `"tool_calls"` di peeked SSE frames (reasoning-only TIDAK meaningful — empty-stream recovery harus tetap replay), lalu mengembalikan `ReadableStream` replay yang men-ulang byte terbaca dan melanjutkan body asli.
- `fetchQoderIdeWithEmptyRecovery` kini mengembalikan respons sniffed segera saat meaningful; replay-only streams tetap retry hingga `maxReplays`.

**Environment fix — account routing (database, bukan code)**

- `Akun Ytprem` diaktifkan; `Sunny Koding` dinonaktifkan agar round-robin tidak mendarat di akun free. Qoder kini merutek hanya ke Ytprem.

### 3.6 Verification

| Check | Result |
| --- | --- |
| `qoder/qwen3.8-flash` via gateway | ok=3/3 (was empty=3) |
| `qoder/qwen3.7-max` via gateway | ok=3/3 (was empty=2/noCall=1) |
| `qoder/qwen3.8-max` via gateway | ok=2/2, re-verified 3/3 |
| `qoder/deepseek-v4.1-flash` via gateway | ok=3/3 |
| opencode E2E `CarteLocal/qoder/qwen3.8-max` | tool `shell` ran, output `hello` |
| opencode E2E `CarteLocal/qoder/qwen3.8-flash` | tool ran, output `hello` |
| Streaming: `qwen3.8-flash` reasoning | 17–76ms gaps (was all at t=994ms) |
| Streaming: `deepseek-v4.1-flash` | single late burst — upstream behavior (DeepSeek emits reasoning in one chunk) |
| `bunx tsc --noEmit` | clean |
| `bun test test/providers/integrations/` | 124 pass, 2 skip, 0 fail |
| `qoder-continuation-args.test.ts` | 8/8 (added 2 regression tests for empty-id fragments) |
| `qoder-empty-stream-recovery.test.ts` | 3/3 |

### 3.7 Changed files, Decisions, Operational notes

**Changed files**

- `src/providers/integrations/qoder/qoder.ts` — Fix #1 (empty id), Fix #2 (sniff + progressive stream, removed drain code).
- `test/providers/integrations/qoder-continuation-args.test.ts` — regression tests: empty-id continuation rejoin; parallel calls with empty-id continuations keep distinct identities.
- `documentation/reference/known-issues.md` — issue #1 updated with account routing + empty-id root cause + streaming fix.
- `documentation/research/qoder/live/2026-11-05-qoder-tool-calling.md` — matrix updated to populated; notes for root causes.

**Decisions**

- **Sunny Koding stays disabled** (free tier → empty args). Qoder routes only ke Ytprem. Jika Sunny di-re-enable, round-robin bisa mendarat di sana dan gejala empty-args kembali untuk request itu.
- COSY legacy surface tetap unverified dari host ini (koneksi api3 hang); adapter tidak menggunakannya untuk akun yang diuji (IDE adalah default).

**Operational notes**

- `bun:sqlite` bound-parameter queries (`?` placeholders) mengembalikan 0 rows untuk tabel-tabel ini saat parameter berupa UUID / `provider_id` — gunakan interpolasi SQL literal dalam skrip scratch/DB.
- Parallel tool calls di IDE surface kadang truncate fragmen JSON di tengah call (BAD); single-call requests stabil.
- Echo `model` respons Qoder adalah roster key (`qfmodel`, `qmodel_latest`, …), bukan virtual id.

## 4. Matrix Historis — via CarteLocal (2026-11-03)

**Sumber:** verifikasi live lewat gateway dev (CarteLocal di `127.0.0.1:12800`): chat completions dengan satu tool `bash` function, varian `tool_choice`, stream + non-stream, 4 trials per kombinasi. Termasuk koreksi 2026-11-04.

### 4.1 Hasil (6 slot) — 2026-11-03

| Model (virtual → roster key) | Arguments | Verdict |
| --- | --- | --- |
| `qoder/deepseek-v4.1-flash` → `dfmodel` | ✅ populated | works |
| `qoder/lite-qwen-3.7-plus` → `lite` | ✅ populated | works |
| `qoder/qwen3.8-max` → `qmodel_38max` | ✅ populated | works |
| `qoder/qwen3.7-plus` → `qmodel` | ✅ populated | works |
| `qoder/qwen3.8-flash` → `qfmodel` | ✅ populated (after fix) | works |
| `qoder/qwen3.7-max` → `qmodel_latest` | ✅ populated (after fix) | works |

### 4.2 Apa yang dicoba untuk empty ones — 2026-11-03

Semua kombinasi semula tetap memancarkan `tool_calls` dengan `arguments: ""`:

- `tool_choice`: `auto`, `required`, object `{type:"function",function:{name}}`, via `parameters.tool_choice` passthrough
- `parallel_tool_calls`: true / false
- `parameters`: `enable_thinking:false`, `reasoning_effort:"none"`
- `max_completion_tokens` vs `max_tokens`
- `tools` dengan/tanpa `description`, dengan `strict:true`
- stream dan non-stream (non-stream: tanpa `tool_calls` sama sekali)

Bacaan historis saat itu (sebelum koreksi): finish reason benar `tool_calls` dan tool name tiba — hanya arguments yang kosong; diatribusikan sebagai perilaku upstream/model pada roster slot tersebut, bukan bug bentuk request atau adapter, karena bentuk request identik menghasilkan arguments populated di `dfmodel`, `lite`, `qmodel`, `qmodel_38max`.

### 4.3 Koreksi (2026-11-04) — empty args adalah bug adapter, bukan upstream

> **Correction (2026-11-04):** the conclusion below ("upstream/model
> behavior") was **wrong** — the empty arguments were gateway adapter bugs
> (free-account routing, empty-`id` continuation handling, and, on the billed
> gRPC path, a missing `tools` request + Struct-wrapped response decoding).
> All are fixed. The matrix below is retained as the historical record.

Perbaikan di hari yang sama (2026-11-03, setelah root cause ditemukan) dan konsekuensinya:

- **Update (2026-11-03, later) — root cause found and fixed:** perilaku empty-args di `qfmodel`/`qmodel_latest` adalah bug adapter, bukan upstream: slot-slot itu meng-echo `id: ""` di setiap continuation chunk (chunk pertama membawa id `call_…` asli). Translator memperlakukan string kosong sebagai id call baru, sehingga setiap fragmen argument di-buffer di bawah `""` dan hilang — call asli dipancarkan dengan arguments kosong. Fix: empty `id` kini berperilaku seperti missing id (continuation re-joins ke pinned first-seen id per wire index). Setelah fix, kedua slot mengembalikan arguments populated (3/3 trials OK) lewat gateway dan end-to-end via opencode.
- **Update (2026-11-03, streaming):** empty-stream recovery semula membaca seluruh body upstream sebelum forward (`drainQoderResponse`), sehingga setiap stream tampak selesai dalam satu burst di akhir. `fetchQoderIdeWithEmptyRecovery` kini hanya sniff chunk pertama (hingga 64 KiB) untuk menilai meaningful-ness dan meneruskan sisanya secara progresif (`sniffQoderStream`); reasoning-only streams tetap di-replay. Setelah fix, gateway meneruskan chunk upstream saat tiba (terukur: `qfmodel` reasoning deltas tiba 17–76 ms terpisah vs semua di `t=994ms` sebelumnya). DeepSeek reasoning masih tiba dalam satu burst akhir karena upstream memancarkannya begitu — itu perilaku upstream, bukan adapter.

### 4.4 Notes — 2026-11-03

- Echo `model` respons adalah roster key gaya `dfmodel` (`qfmodel` dst.), sehingga perilaku empty-args berkunci pada roster slot, bukan virtual id.
- Fix buffer/stitch di `qoderBodyToCanonicalEvents` (lihat commit history) bersifat ortogonal: merekonsiliasi fragmented streaming args; tidak bisa menciptakan args yang tidak pernah dikirim upstream.
- Jika deployment membutuhkan tool calling di slot kosong, workaround-nya adalah merutek ke slot yang populate args (`dfmodel`, `lite`, `qmodel`, `qmodel_38max`). Jangan beri `qfmodel`/`qmodel_latest` caller yang bergantung pada eksekusi tool.

## 5. Implikasi Adapter (final)

Sintesis [22] §4 + [4] §Fixes + [5] §Notes.

- **Terapkan empty-id handling di semua surface (gRPC + IDE/HTTP).** Pola `id: ""` pada continuation chunk dikonfirmasi identik di kedua surface (probe 2026-11-05). Satu parser delta umum: stitch by `index`, id first-seen, arguments accumulate; untuk gRPC, unwrap Struct (`fromProtoStruct`) sebelum parsing. Empty `id` harus diperlakukan sebagai missing id, bukan id call baru — jika tidak, setiap fragmen argument ter-orphan.
- **Jangan jadikan non-stream sebagai path tool-calling (tanpa tool_calls).** Non-stream terbukti tidak membawa `tool_calls` sama sekali; tool calling hanya valid di path streaming (SSE IDE/HTTP atau gRPC), dengan `finish_reason=tool_calls` (eksplisit di gRPC; IDE/HTTP menutup via `[DONE]` + raw_usage).
- **Roster slot (bukan virtual id) menentukan perilaku args.** Echo `model` adalah roster key (`qfmodel`, `qmodel_latest`, …), dan perilaku empty-args berkunci pada roster slot. Routing harus menghindari slot yang dikenal memancarkan empty args bila caller bergantung pada eksekusi tool, serta menghindari akun free tier (Sunny Koding) yang memancarkan empty args di setiap slot.

---

## 6. Fix Live 2026-11-05 — gRPC tool-call stitching (single + paralel)

**Konteks:** ditemukan live via `opencode` → CarteLocal → Qoder gRPC (`ultimate`). Gejala: tool call terkirim dengan `arguments: {}` (`Invalid arguments for tool "shell": command: Missing key`); untuk paralel, args call ke-2 tergabung ke call ke-1 (`{"command":"..."}{"command":"..."}`).

### 6.1 Wire nyata (raw dump gRPC, `QODER_RAW_TOOLCALL=1`)

Single call — announce lalu fragmen:

```
{id:"toolu_bdrk_...", name:"shell", arguments:""}      ← announce (bawa id+name)
{id:"", arguments:'{"command": "'}                       ← continuation (id kosong)
{id:"", arguments:'"'"}                                  ← sambungan
```

Paralel — index SELALU 0, args berfragmen, announce menyela:

```
{id:A, index:0, args:""}                                 ← announce A
{id:"", index:0, args:'{"city": "Jakar'}                 ← fragmen A
{id:"", index:0, args:'ta'}
{id:"", index:0, args:'"}'                               ← A lengkap
{id:B, index:0, args:""}                                 ← announce B
{id:"", index:0, args:'{"city": "Band'}                  ← fragmen B
```

### 6.2 Root cause & fix

- `index` **tidak unik per call** (selalu 0) — pinning by index salah arah.
- Args datang sebagai **banyak fragmen kecil**, bukan satu potongan.
- Fix (`qoder-grpc.ts` — `resolveQoderToolFragmentId`): fragment **dengan id** = announce → menjadi `lastSeenToolId` (active call); fragment **tanpa id** = milik active call. Hanya `arguments` non-kosong yang diferuskan sebagai fragmen args (announce bawa `""` yang harus diabaikan).

### 6.3 Verifikasi (harness opencode → CarteLocal)

| Case | Sebelum | Sesudah |
|---|---|---|
| Shell single call | `arguments:{}` → Missing key | ✅ jalan, output benar |
| Multi-call paralel satu blok (shell×2) | args tergabung `{...}{...}` (gagal 5×) | ✅ keduanya jalan: `parallel-A` & `parallel-B` |
| write/edit/read/glob/grep/execute | — | ✅ (lihat `D:\tmp\harness-test\README.md`) |

Test regresi: `test/providers/integrations/qoder-grpc-wire.test.ts` — `resolveQoderToolFragmentId` single & paralel. Full suite: **1397 pass / 0 fail**. Server dev restart dengan fix.
