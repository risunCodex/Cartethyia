# Proposal — Model probe test: mode "ask detail" vs "fast minimal" + surface settings/provider detail

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** dashboard (settings + provider detail), console API (catalog routes), discovery/probing (backend), persistence (JSONB preferences, tanpa migrasi DDL)
**Method:** subagent audit — codegraph_explore + Read/Grep langsung pada `src/providers/discovery/`, `src/console/providers/catalog/`, `src/console/settings/`, `dashboard/src/features/settings/`, `dashboard/src/features/provider-detail/`

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.7 (D39–D43) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Model probe SUDAH ada di backend — lengkap, bukan dari nol

`ProviderProbingService.probeModel()` (`src/providers/discovery/probing-service.ts:185`) adalah one-shot probe penuh:

- resolve target wire (`resolveProbeTarget`, `probing-service.ts:207`), pilih account sehat (`selectProbeAccount`, `:217`), resolve adapter asli (`resolveProbeAdapter`, `:231`).
- Bangun canonical request via `buildProbeCanonicalRequest()` (`src/providers/discovery/probe-phases.ts:636`): prompt default *"What model are you, and what is your knowledge cutoff date? Answer in one sentence."* (`probe-phases.ts:652-653`), `max_tokens` default 256 (`:665`), **stream default true** (`:685`).
- Timeout: `AbortSignal.timeout(30_000)` (`probing-service.ts:285`), deadline `startedAt + 30_000` di dispatch (`:418`).
- Retry: kalau `!hasMeaningfulOutput(events)` (probe response kosong — reasoning models menghabiskan budget sebelum teks), retry sekali dengan `stream: true` + `max_tokens: 1024` (`probing-service.ts:431-455`).
- Ukur `latencyMs`, `ttfbMs`; ekstrak `sample` (`extractSample`, `probe-phases.ts:143`, cap 200 char); baca `reportedModel` dari raw bytes via `captureProviderExchange` (`probing-service.ts:604-605`); `providerMetadata` untuk Qoder IDE surface (`:608-609`).
- Menulis telemetry (`telemetry_events`, `probing-service.ts:532-548`) dan account health (`recordProbeHealth`, `:479-491`).

Batch: `probeAllModels()` (`probing-service.ts:1065`, concurrency 5, warm-up sequential) dan `probeAllAccounts()` (`:1123`, concurrency 10).

### 1.2 Console API sudah expose probe

`src/console/providers/catalog/routes.ts`:

- `POST /providers/:providerId/models/probe` (`routes.ts:267-277`) → `modelFactory.probeModel` — satu model.
- `POST /providers/:providerId/models/test-models` (`routes.ts:278-280`) → `probeAllModels` — batch semua model terdaftar.
- `POST /providers/:providerId/accounts/probe` (`routes.ts:281-291`) → `probeAllAccounts` — satu model melawan semua akun.
- Body `probeModelBody` (`routes.ts:119-130`): `modelId`, `serviceKind`, `route`, `wireFamily`, `accountId`, `prompt`, `reasoningEffort`, `maxOutputTokens`, `stream`, `surface`. **Tidak ada field mode/depth.**

### 1.3 Dashboard: dua jalur test yang berbeda

`dashboard/src/features/provider-detail/sections/Models.tsx` `ModelCard.runProbe` (`Models.tsx:791-893`):

- **Qoder/Qodercn** → `probeConsole.mutate` (console probe route `POST /providers/:providerId/models/probe`, `dashboard/src/hooks/providers.ts:125-148`) — karena IDE surface echo `providerMetadata`.
- **Semua provider lain** → `gatewayTest.test(copyId, model.outputLimit)` (`Models.tsx:861`) — `useGatewaySignedModelTest` (`dashboard/src/features/provider-detail/sections/gateway-model-test.ts:33-144`) memakai default API key tenant, hit `POST /v1/chat/completions` langsung (timeout 20s, `:26`), **bukan** console probe. Alasan di komentar (`gateway-model-test.ts:7-14`): probe internal memilih satu akun dan skip routing ladder (usage floor, credit order, cooldown), jadi laporan "Fail" palsu; lewat gateway = apa yang request asli lakukan.

Artinya: **console probe route (`/models/probe`) hanya dipakai Qoder**; sebagian besar test model UI berjalan lewat gateway, bukan lewat probing service.

`test-models` (batch probe semua model) **tidak dipakai dashboard sama sekali** — grep `test-models` di `dashboard/` nihil; route hanya ada di backend (`routes.ts:278`).

### 1.4 Akun: test terpisah

`AccountRow.tsx` — tombol Test per akun (`AccountRow.tsx:252-264, 405-421`): `testQuota` (refresh quota/health, bukan probe model). Probe account batch hanya ada untuk Grok: "Test 407" (`AccountRow.tsx:423-439`; `ProviderDetailPage.tsx:404-432` `runGrokAccountProbe` → `useProbeAllProviderAccounts`, `providers.ts:166-182`).

### 1.5 Settings page: tidak ada section probe

`dashboard/src/features/settings/SettingsPage.tsx` — `SECTIONS` (`:84-113`, id: security/privacy/backup/operations/data-management), `PANEL_BODY` (`:857-863`), `SIDE_BY_SIDE` (`:876`). Tidak ada section/row terkait probe. Runtime settings backend (`src/console/settings/contracts.ts`, `RuntimeSettingsResponse` `:15-73`; `ConsoleSettingsPreferences` `src/persistence/schema.ts:1190-1291` — JSONB, `:1295`) tidak punya field probe. `loadProbePreferences` (`probe-phases.ts:540-603`) hanya membaca `responsesReasoningSummary` + `telemetryPayloads`.

### 1.6 Precedent untuk per-provider UI preference

Thinking effort & show filter per provider disimpan di localStorage `cartethyia:provider:${pid}:thinking-effort` / `:show-filter` (`ProviderDetailPage.tsx:115-152`), dengan `ThinkingSelect` di header Models section (`Models.tsx:154-193`). Ini pola yang bisa dipakai ulang untuk mode probe.

---

## 2. Masalah yang diminta diatasi

Requirement: *"settings > modelprobe test untuk provider detail, mode ask detail, fast minimal"* — tes/probe model bisa dijalankan dari settings dan/atau provider detail, dengan dua mode.

Masalah konkret pada kode saat ini:

1. **Tidak ada konsep mode probe.** Satu perilaku saja: stream penuh, prompt identitas, `max_tokens` 256 (retry 1024), timeout 30s, capture payload sesuai tenant prefs. Tidak ada jalur "cepat, minimal" yang menahan biaya (latency, token, telemetry body) saat operator cuma ingin cek koneksi.
2. **Tidak ada surface settings untuk probe.** Settings page tidak punya kontrol default mode/timeout; satu-satunya preference per-provider adalah thinking effort (localStorage).
3. **Jalur test UI terbelah.** Non-Qoder memakai gateway test (bukan probing service), Qoder memakai console probe; mode baru harus didefinisikan supaya konsisten di kedua jalur, atau konsolidasi.
4. **`test-models` route mati** — batch probe semua model sudah ada di backend tapi tidak ada tombolnya di UI.

---

## 3. Desain yang diusulkan

### 3.1 Definisi mode (contrast)

| Aspek | `ask detail` (default saat ini) | `fast minimal` (baru) |
|---|---|---|
| Prompt | identitas + knowledge cutoff (`probe-phases.ts:652`) | sama, atau `"ping"` yang lewat content-policy — **rekomendasi: prompt sama** supaya verdict kompatibel, lihat D42 |
| `max_tokens` | 256, retry 1024 | 16–32, tanpa retry |
| Timeout | 30s | **10s** (`AbortSignal.timeout(10_000)`) |
| Stream | true | true (TTFT tetap terukur) |
| Output | `sample` + `reportedModel` + `providerMetadata` + `searchResults` | hanya `ok`, `latencyMs`, `ttfbMs`, `statusCode`, `error`, `reportedModel` |
| Retry empty-content | ya (`probing-service.ts:431-455`) | tidak |
| Telemetry | penuh (`telemetry_events` + payload capture sesuai prefs, `probing-service.ts:532-597`) | tetap tulis `telemetry_events` (row ringkas), **skip payload body capture** |
| Account health | `recordProbeHealth` (`:479`) | tetap — verdict tetaplah verdict |
| Cocok untuk | diagnosa model (sample, reported model, reasoning) | smoke check koneksi/kuota cepat |

### 3.2 API

- `ProbeModelRequest` (`src/providers/discovery/discovery-types.ts:65-88`) ditambah `mode?: "fast" | "detail"` (absent = `"detail"` agar backward compatible; route schema `probeModelBody` di `routes.ts:119-130` ditambah `mode: t.Optional(literalUnion(["fast", "detail"]))`).
- `probeModel` (`probing-service.ts:185`) membaca `mode`:
  - `"fast"`: `maxOutputTokens` default 32 (kalau tidak di-set), timeout 10s, skip retry loop (`:431-455`), skip payload capture branch (`:549-597`) tapi tetap enqueue telemetry baris; `sample` dipotong 80 char (D40).
  - `"detail"`: perilaku sekarang persis.
- `probeAllModels` (`probing-service.ts:1065`) meneruskan `mode` ke tiap request (jika caller set di payload batch — lihat 3.3).
- Konsol: **jalur test non-Qoder tetap lewat gateway** (`gateway-model-test.ts`) untuk menjaga akurasi routing — tidak diubah oleh proposal ini (D41). Mode di sisi gateway diwujudkan sebagai argumen `useGatewaySignedModelTest.test(model, maxTokens, { fast: true })`: `max_tokens` kecil + `AbortController` timeout 10s.

### 3.3 UI

**Settings page** — section baru `"model-testing"` (tambah ke `SECTIONS` `SettingsPage.tsx:84-113` + `PANEL_BODY` `:857-863`; ikon baru di `SectionIcon` `:47-54`):

- Row "Default probe mode" → `Select` (`fast minimal` / `ask detail`), persist ke runtime settings backend (lihat 3.4) via `useUpdateRuntimeSettings` (`dashboard/src/hooks/settings.ts:28-40`).
- Row "Fast probe timeout" → `Select` 5/10/15s, default 10.
- (Opsional, rekomendasi: ya) Row "Test all models" adalah tindakan, bukan setting — tidak masuk sini; ada di provider detail.

**Provider detail** — header Models section (`Models.tsx`), sejajar `ThinkingSelect` (`Models.tsx:154-193`):

- `ModeSelect` baru (fast minimal / ask detail), **per-provider localStorage** `cartethyia:provider:${pid}:probe-mode` (pola sama `ProviderDetailPage.tsx:115-133`), default dari settings global.
- `ModelCard.runProbe` (`Models.tsx:791`) meneruskan mode: Qoder → `probeConsole.mutate` dengan `mode` di request; non-Qoder → `gatewayTest.test(copyId, outputLimit, { fast })`.
- Tombol **"Test all models"** baru di header Models section → `useProbeAllModels` (hook baru memakai `POST /providers/:providerId/models/test-models`, `routes.ts:278`) — menghidupkan kembali route mati; hasil per model di-render sebagai daftar ringkas (ok/fail + latency) di panel collapse di bawah grid.

### 3.4 Persistence

- `ConsoleSettingsPreferences` (`src/persistence/schema.ts:1190-1291`) + `RuntimeSettingsResponse` (`src/console/settings/contracts.ts:15-73`) ditambah:
  - `modelProbeMode?: "fast" | "detail"` (default pasti `"detail"` (D39))
  - `modelProbeFastTimeoutSeconds?: number | null` (default deployment 10)
- JSONB — **tanpa migrasi DDL**. `loadProbePreferences` (`probe-phases.ts:540`) boleh baca default mode juga agar backend konsisten saat UI tidak kirim.

### 3.5 Failure handling & guards

- `fast`: kesalahan apa pun → `{ ok: false, latencyMs, error }` (bentuk sudah ada, `probing-service.ts:226-242`); tidak ada retry; timeout 10s menghasilkan `AbortError` → error "The model test timed out." (`gateway-model-test.ts:132`).
- `detail`: retry + timeout 30s seperti sekarang.
- Guard: `mode: "fast"` dipaksa `stream: true` (TTFT butuh stream); kalau caller eksplisit `stream: false` + fast, tetap hormati `stream: false` tapi tanpa retry.

---

## 4. File yang tersentuh

| Area | File |
|---|---|
| Backend discovery/probing | `src/providers/discovery/discovery-types.ts` (field `mode`), `src/providers/discovery/probing-service.ts` (`probeModel`/`probeAllModels` fast path), `src/providers/discovery/probe-phases.ts` (default mode di `loadProbePreferences`) |
| Console API catalog | `src/console/providers/catalog/routes.ts` (`probeModelBody` + schema), `src/console/providers/catalog/contracts.ts` (interface `ProviderCatalogStore` bila perlu), `src/console/providers/catalog/model-operations.ts` / `store.ts` (penerusan mode) |
| Console settings | `src/console/settings/contracts.ts` (`RuntimeSettingsResponse`, `UpdateRuntimeSettingsRequest`), `src/persistence/schema.ts` (`ConsoleSettingsPreferences`), store settings (`src/console/settings/` — validasi) |
| Dashboard — settings | `dashboard/src/features/settings/SettingsPage.tsx` (section + panel baru), `dashboard/src/hooks/settings.ts` (tidak berubah — `UpdateRuntimeSettingsRequest` generik), `dashboard/src/data/contracts.ts` (tipe mirror) |
| Dashboard — provider detail | `dashboard/src/features/provider-detail/sections/Models.tsx` (`ModeSelect`, `runProbe`, "Test all models"), `dashboard/src/features/provider-detail/sections/gateway-model-test.ts` (opt `fast`), `dashboard/src/features/provider-detail/ProviderDetailPage.tsx` (localStorage mode), `dashboard/src/hooks/providers.ts` (`useProbeAllModels` baru) |
| Test | `test/console/providers/catalog/*` (mode fast/detail), `test/providers/discovery/*` (timeout/retry fast), `dashboard/test/features/provider-detail/*` (ModeSelect, test-all render) |

---

## 5. Migrasi & risk

- **Migrasi DDL: none** — JSONB `console_settings.preferences` menerima field baru tanpa kolom baru (schema.ts:1295). Backward compatible: request tanpa `mode` = `"detail"` (perilaku sekarang).
- **Behavior change:** default mode di Settings bila di-set ke `fast` mengubah perilaku tombol Test seluruh tenant (kebih cepat, output lebih sedikit). Guard: default biarkan `"detail"` sampai operator memilih fast (default off, sesuai proposal.md).
- **Risk jangkauan luas:** memodifikasi `probeModel` memengaruhi Qoder probe, Grok 407 probe (`ProviderDetailPage.tsx:404`), dan `probeAllAccounts` — semua memakai jalur yang sama. Fast path harus **opsional per request**, bukan mengganti default global di backend, supaya Grok 407 (yang butuh sample "407", `probe-phases.ts:94-140`) tidak rusak.
- **Risk jalur ganda:** fast mode di gateway test (`gateway-model-test.ts`) adalah implementasi kedua (frontend-only). Konsistensi perilaku (timeout/max_tokens) dijaga dengan konstanta bersama di satu file hook, bukan dua tempat tersebar.
- **Baseline test yang harus lulus saat eksekusi:**
  - `bunx tsc --noEmit` (backend strict)
  - dashboard typecheck
  - `bun run test:backend`
  - suite probe terkait: `test/providers/discovery/`, `test/console/providers/catalog/`
  - dashboard: `dashboard/test/features/provider-detail/`, `dashboard/test/features/settings/`
  - Angka pass/fail dicatat di Execution status setelah eksekusi.

---

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.7 (D39–D43). Tidak ada yang menunggu jawaban.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D39 | Default global = `detail` saat unset; `mode` absent = `detail`. | Default off. |
| D40 | `fast` mengembalikan `sample` dipotong **80 char** (Opsi B). | Konfirmasi "model menjawab" dengan biaya kecil. |
| D41 | Jalur ganda dipertahankan: non-Qoder tetap `gateway-model-test.ts` + opt `fast`. | `gateway-model-test.ts:7-14`: probe internal skip routing ladder → "Fail" palsu. |
| D42 | Prompt `fast` = prompt identitas yang sama, hanya batasi token. | Lolos content-policy (`probe-phases.ts:629-635`). |
| D43 | "Test all models" **dihidupkan** (`POST /models/test-models`). | Route sudah ada; mode fast membuatnya murah. |

Semua `D39`–`D42`, "default pasti `"detail"` (D39)", "sama, atau `"ping"`
… lihat D42", "`sample` dipotong 80 char (D40)",
"lih D41", dan "kalau tidak … proposal bisa dipangkas" di §1–§5 dibaca melalui
tabel ini. Koreksi terkait: §3.4 `modelProbeMode` default pasti `"detail"`, §3.2
fast pasti menyertakan sample 80 char, §3.3 tombol "Test all models" wajib ada.

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C3 + C6 + C2.

| Area | Status | Bukti |
| --- | --- | --- |
| Mode `fast` / `detail` | ✅ | `ProbeModelRequest.mode?` (absent = `detail`); fast 32 token / 10s / tanpa retry / tanpa payload capture / sample 80 char / `recordProbeHealth` tetap; `loadProbePreferences` default `detail`. |
| Settings `model-testing` | ✅ | `SettingsPage.tsx` section baru + row default mode & fast timeout, persist JSONB C2. |
| `ModeSelect` per-provider | ✅ | localStorage `cartethyia:provider:${pid}:probe-mode`; `model-probe-mode.test.tsx`. |
| "Test all models" | ✅ | `POST /models/test-models` dihidupkan, `ProbeAllModelsResult` diproyeksikan ke panel collapse. |
| Jalur gateway non-Qoder | ✅ | `gateway-model-test.ts` opt `fast` (32 token / 10s abort / sample 80 char); jalur dipertahankan (D41). |
| Konsolidasi ke console probe (alternatif) | ⛔ | **Sengaja ditolak (D41)** — `gateway-model-test.ts:7-14`: probe internal skip routing ladder → "Fail" palsu. |

Keputusan D39–D43 diterapkan seluruhnya.

**Validasi akhir (2026-11-06, terukur):**
| Suite | Baseline | After-state |
| --- | --- | --- |
| `bun run test:backend` | 4484 pass / 4 skip / 0 fail (404 file) | **4564 pass / 4 skip / 0 fail** (411 file, +80) |
| `bun test test/protocol` | 606 pass / 0 fail | **606 pass / 0 fail** |
| `bun test` (cwd `dashboard/`) | 656 pass / 0 fail (55 file) | **701 pass / 0 fail** (61 file, +45) |
| `bunx tsc --noEmit` (root) | exit 0 | **exit 0** |
| `bunx tsc --noEmit` (dashboard) | exit 0 | **exit 0** |
| `bun run check:migrations` | — | **45 migration match schema.ts** (drift nol) |

Suite klaster: C1 99/0 + 1452 providers /0; C4 206/0 + 356/0 gabungan;
C5 40/0 backend + 7/0 dashboard; C3 320/0 console + 397/0 discovery;
C6 701/0 dashboard. Warning `act(...)` di `providers-unconfigured-filter.test.tsx`
adalah peringatan React (bukan fail) dan sudah ada sebelum perubahan ini.
