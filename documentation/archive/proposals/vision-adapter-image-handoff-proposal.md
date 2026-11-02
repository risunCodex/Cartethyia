# Proposal — Vision Adapter: image handoff ke model vision global

**Status:** ✅ diimplementasikan (commit `33766b33`), proposal dipertahankan
sebagai catatan desain & keputusan.
**Tanggal:** 2026-11-01
**Scope:** request/degradation (preparer) + dispatch interno (attempt-loop) +
tenant preferences (schema) + dashboard (Settings / Combos & Routes).
Perilaku berubah luas — audit dulu, implementasi belakangan.

> **Catatan revisi (2026-11-01, setelah diskusi dengan Rover):** config bukan
> string tunggal, melainkan **daftar terurut** (`string[]`). Setiap entri adalah
> model vision; kalau model pertama tidak sehat (cooldown / quota / upstream
> error), handoff turun ke entri berikutnya. Ini memakai failover yang sudah ada
> di `runAttemptLoop`, jadi *tidak* menambah mesin fallback baru.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Bagaimana gambar menempuh pipeline

1. Surface adapter (`chat/parse.ts`, `messages/parse.ts`) mengubah blok gambar
   jadi `ContentPart { kind: "image"; payload }`.
2. `deriveRequiredCapabilities` (`src/protocol/translation/capabilities.ts:296`)
   memindai `summarizeParts` → `hasImage === true` → capability `"image"`
   masuk daftar `required`.
3. `plan()` (`src/transport/routing/router.ts`) memfilter candidate lewat
   `candidateSupportsRequest` → `routeCapabilitiesFor` → hanya candidate dengan
   `capability_profile.image === true` yang lolos untuk variant penuh.
4. `ProxyRequestPreparer.prepare` (`src/transport/request/preparer.ts:287`)
   menjalankan `degradedRequestVariants`: kalau tidak ada route image-capable,
   gambar di-strip jadi placeholder teks oleh `degradeMediaPart`
   (`src/transport/request/degradation.ts:208`) → `[image]`.
5. Hasil: model text-only (mis. mercury-3) menerima `[image]`, bukan gambar —
   persis bug yang dilaporkan.

### 1.2 Kenapa placeholder bukan handoff

`degradeMediaPart` mengganti part gambar dengan `{ kind: "text", text: "[image]" }`.
Tidak ada mekanisme "panggil model vision, dapatkan deskripsi, teruskan ke model
asli sebagai teks". Pipeline lurus: satu request → satu candidate → satu upstream.

### 1.3 Preseden yang dipakai: internal dispatch + fold-back

Ini sudah ada dan teruji, jadi vision adapter bukan medan baru:

- `prepareNativeService()` (`src/transport/request/preparer.ts:550`) —
  merencanakan sub-request ke model lain, mem-filter candidate lewat closure
  `eligible`.
- `runAttemptLoop()` (`src/transport/dispatch/attempt-loop.ts:212`) —
  admission lease → pool slot → reservation → upstream → `completeAttempt`.
  Retry, backoff, pool-cooldown, OAuth refresh jadi satu kebijakan.
- Dipakai `systemone.ts` (decision model), `websearch.ts`,
  `responses-compact.ts`, `token-count.ts`.
- `AntigravityAdapter.websearch` (`antigravity.ts:498`) — pola fold-back
  paling dekat: bangun sub-request, dispatch, baca event terminal, gabung hasil.

Jadi: vision adapter memakai `prepareNativeService` + `runAttemptLoop`, dan
menambahkan *satu* langkah fold-back yang belum ada — mengganti part gambar
dengan teks deskripsi di request induk.

### 1.4 Capability model

- `capability_profile` per model: `image`, `document`, `audio`, dst
  (`models` table + discovery `github-discovery.ts:91` `vision`).
- `routeCapabilitiesFor` (`capabilities.ts:164`) memetakan profile → route
  capabilities; `candidateSupportsRequest` dipakai router & planner.

### 1.5 Konfigurasi global yang sudah ada

- `console_settings` (`schema.ts:1259`): `tenantId` PRIMARY KEY, `preferences`
  jsonb. Benar-benar per-tenant global. Sudah memuat `imageClampMaxBytes`,
  `upstreamTimeoutSeconds`, `forceDisableCooldown`, `invokeDisabled`.
- Dibaca lewat `preferencesReaderFor(db).readPreferences(tenantId)`
  (`src/persistence/tenant-preferences.ts:24`) — revision-keyed, memory hit,
  bukan round trip per request. Dipakai di dispatch path
  (`resolveTenantImageClampMaxBytes`, `tenant-preferences.ts:95`).
- `provider_routing_settings` (`schema.ts:724`) punya `tenantId` nullable;
  `tenant_id IS NULL` = baris global per provider.

---

## 2. Masalah yang diminta diatasi

1. Model text-only (mis. mercury-3) tidak boleh menerima placeholder `[image]`.
   Gateway harus mendelegasikan pemahaman gambar ke model vision yang
   dikonfigurasi (mis. deepseek-v4.1-flash) dan mengembalikan hasilnya sebagai
   teks/handoff ke model asli.
2. Konfigurasi **global** (satu setelan per tenant): kalau ketemu model yang
   tidak support image, pakai image adapter.
3. Deskripsi = penjelasan isi gambar saja, tanpa history.
4. Perilaku berubah luas — menyentuh inti degradation + dispatch, jadi audit
   dan migrasi wajib.

---

## 3. Desain yang diusulkan

### 3.1 Konsep "Vision Adapter"

Deklarasi **global per tenant**: "kalau request membawa gambar tapi model yang
dipilih tidak image-capable, teruskan gambar ke model vision ini, ambil
deskripsinya, dan suntikkan sebagai teks ke model asli".

Bukan combo role, bukan fusion.

### 3.2 Penempatan config: GLOBAL (dipilih)

Opsi yang dievaluasi:

**Opsi A — `console_settings.preferences.visionHandoffModels` (GLOBAL, daftar terurut) ✅ dipilih**
Satu field di preferences jsonb per tenant. Konsisten dengan
`imageClampMaxBytes` dan `upstreamTimeoutSeconds` yang sudah global.
Tidak ada migrasi SQL — jsonb sudah ada, cukup tambah field di tipe
`ConsoleSettingsPreferences`.

Nilai field adalah **array string terurut** (model id `provider/model`).
Urutan = prioritas fallback: jika model pertama tidak sehat, handoff mencoba
entri berikutnya. Empty array / absen = off (perilaku lama: placeholder
`[image]`).

**Opsi B — `provider_routing_settings.vision_handoff_model` (per-provider)**
Per provider, bisa beda adapter tiap provider. Tapi butuh migrasi kolom baru,
dan "global" yang diminta jadi terpecah per provider.

**Opsi C — combo role (`model_combos.members` jadi `{ model, role }`)**
Paling eksplisit "di Combos & Routes", tapi mengubah bentuk `members` dari
`string[]` → object (breaking, migrasi berat).

> **Rekomendasi: Opsi A (global).** Sesuai keputusan: global, satu setelan,
> default off. Opsi C ditolak eksplisit karena mengubah bentuk data combo.

```ts
// src/persistence/schema.ts — ConsoleSettingsPreferences
/** Model id (provider/model) yang dipakai untuk menjelaskan gambar ketika
 * model tujuan tidak image-capable. Setiap string adalah satu model vision
 * (provider/model); urutan = prioritas fallback. Empty array / absen = off
 * (perilaku lama: placeholder `[image]`). */
visionHandoffModels?: readonly string[];
```

Tidak ada migrasi SQL. Field jsonb baru, backward-compatible.

### 3.3 Yang TIDAK dilakukan (catatan dari 9router)

Audit `9router/open-sse/services/combo.js` (referensi yang diberikan) memberi
dua pelajaran yang dipakai sebagai batasan, bukan sebagai desain:

- **Fusion ditolak.** `handleFusionChat` (`combo.js:820`) fan-out ke N panel
  model paralel lalu Judge mensintesis satu jawaban. Itu N+1 panggilan
  upstream per request, penalty straggler, dan Judge yang menimpa jawaban.
  Vision adapter melakukan **satu** panggilan tambahan, dan tidak pernah
  menimpa — model asli tetap yang menjawab.
- **Auto-switch capability dihindari.** `reorderByCapabilities` (`combo.js:86`)
  mengurutkan ulang combo agar model vision naik ke depan, yang berarti request
  bergambar berakhir **dipindah ke model lain**. Itu mengubah model yang
  menjawab. Desain kita mempertahankan model asli: gambar yang dipindah, bukan
  modelnya.
- Satu hal yang **diambil** dari 9router: `trailingUserItems` (`combo.js:117`)
  — hanya giliran user terakhir yang memicu kebutuhan modalitas, karena media
  di history lama tidak boleh mengunci pemilihan model. Sepadan dengan aturan
  kita "deskripsi tanpa history".

### 3.4 Alur runtime baru

Di `ProxyRequestPreparer.prepare`, **di dalam loop degradasi** — tepat ketika
variant yang menang mendegradasi capability `image` (artinya model terpilih
tidak image-capable):

1. Deteksi bahwa variant menang mendegradasi `image` (`variant.degraded`
   memuat `"image"`).
2. Resolve `visionHandoffModels` dari tenant preferences (global) — array
   terurut, prioritas fallback.
3. Kalau kosong → lanjut ke perilaku lama (`[image]`), selesai.
4. Kalau ada:
   a. Bangun sub-request vision:
      - `messages`: **satu** pesan user berisi part gambar + teks saudaranya
        pada pesan yang sama (tanpa history, tanpa tools, tanpa system).
      - `model` = model vision pada posisi pertama yang masih mungkin.
      - `stream = false` (non-streaming, satu panggilan).
      - Instruction singkat: minta penjelasan isi gambar.
   b. Dispatch lewat `prepareNativeService` + `runAttemptLoop` — jalur yang
      sama dengan `systemone.ts`, jadi admission, quota, cooldown, telemetry,
      dan retry policy sudah ikut.
   c. **Failover ke daftar**: kalau model pertama gagal (cooldown / quota /
      upstream error), `runAttemptLoop` memindahkan candidate yang gagal dan
      mencoba model berikutnya dari daftar — sama seperti combo fallback.
   d. Ambil teks hasil → **ganti setiap part gambar / placeholder `[image]`**
      di variant yang menang dengan `{ kind: "text", text: <deskripsi> }`
      (degradasi lain, mis. tools, tetap dipertahankan).
   e. Re-plan variant yang sudah text-only; kalau berhasil, pakai plan ini
      (degradasi `image` dihapus dari daftar degraded).
5. Lanjutkan planning seperti biasa — request sekarang text-only, model asli
   menjawab.

Deskripsi disuntik **menggantikan** part gambar, bukan ditambah sebagai pesan
baru, supaya posisi dan konteks pesan asli tetap terjaga.

> Catatan implementasi: `plan()` melempar `accounts_unavailable` (503), bukan
> `capability_unsupported`, saat tidak ada candidate yang mendukung capability
> yang diminta. Loop degradasi diperbaiki untuk meneruskan ke variant berikutnya
> pada kasus itu (hanya dari variant pristine) agar fallback `[image]` benar-benar
> tercapai — sebelumnya request bergambar ke model text-only berakhir 503.

### 3.5 Batas & guard

- **Non-streaming** (`stream = false`). Hasil harus utuh sebelum request induk
  dikirim; streaming tidak memberi manfaat ke caller dan menambah kompleksitas
  pengumpulan event.
- **Tanpa history.** Hanya pesan pembawa gambar. Deskripsi = "jelaskan isi
  gambar", bukan "jawab pertanyaannya".
- **Sekali per request.** Tidak ada handoff berantai. Kalau semua adapter di
  daftar tidak image-capable → batalkan handoff, jatuh ke `[image]`.
- **Gagal → jangan gagalkan request induk.** Upstream error/4xx/5xx saat
  handoff: log + fallback ke placeholder `[image]` (perilaku lama). Ini guard
  paling penting — handoff adalah peningkatan, bukan prerequisite.
- **Slot sendiri.** Sub-request mengambil admission & pool slot sendiri lewat
  `runAttemptLoop`, bukan meminjam slot induk — menghindari deadlock dan slot
  induk tergenggam sambil menunggu handoff. Deadline dibagi.
- Hanya user-message image parts. Tool-result image dan system image di luar
  scope.
- Tidak mengubah `degradeMediaPart` untuk audio/document.

### 3.6 Dashboard

- **Settings** (global): card "Vision handoff models" — dropdown multi-model
  image-capable, bisa dipilih beberapa, urutan = prioritas fallback; kosong =
  off.
- Indikator di Request Detail: request yang di-handoff ditandai, bukan lagi
  sekadar `degraded: ["image"]`.

### 3.7 Telemetry & observability

- Field/event `handoff_vision`: `{ from_model, to_model, image_count, char_count }`.
- Log warn throttled (pola `shouldWarnDegradation`) saat handoff menghasilkan
  deskripsi kosong.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Schema (tipe jsonb, tanpa migrasi SQL) | `src/persistence/schema.ts` (`ConsoleSettingsPreferences`) |
| Console settings contracts/store | `src/console/settings/contracts.ts`, `src/console/settings/store.ts` |
| Preferensi dispatch | `src/transport/request/tenant-preferences.ts` |
| Preparer (hook handoff) | `src/transport/request/preparer.ts` |
| Degradasi | `src/transport/request/degradation.ts` |
| Dispatch interno | `src/transport/request/preparer.ts` (`prepareNativeService`), `src/transport/dispatch/attempt-loop.ts` |
| Dashboard | `dashboard/src/features/settings/*`, contracts |
| Telemetry | `src/observability/event-log.ts` + fields |

---

## 5. Migrasi & risk

- **Tidak ada migrasi SQL.** `console_settings.preferences` sudah jsonb;
  penambahan field backward-compatible dan default off.
- **Perilaku berubah luas:** request yang tadinya jatuh ke `[image]` kini bisa
  melakukan satu panggilan upstream tambahan (laten + biaya token vision).
  Guard: hanya saat dikonfigurasi, default off.
- **Test yang perlu ditulis:**
  1. preparer: request bergambar + adapter terkonfigurasi → sub-request
     dipanggil → part gambar diganti teks deskripsi;
  2. preparer: adapter tidak terkonfigurasi → perilaku `[image]` lama;
  3. handoff gagal → fallback placeholder, request induk tidak gagal;
  4. tanpa history: sub-request tidak memuat pesan selain pembawa gambar;
  5. tidak ada recursion (adapter = model asli);
  6. non-streaming: sub-request dikirim dengan `stream = false`.

---

## 6. Keputusan (dari diskusi)

| # | Keputusan |
| --- | --- |
| 1 | Sub-request **non-streaming** (`stream = false`) |
| 2 | Deskripsi = **jelaskan isi gambar saja, tanpa history** |
| 3 | Config **GLOBAL** per tenant (`console_settings.preferences`), Opsi A |
| 4 | Handoff pakai **slot sendiri** (admission terpisah) |
| 5 | Nama field: **`visionHandoffModels`** (array terurut, prioritas fallback) |
| 6 | TimerMulti**: handoff bisa punya beberapa model vision; kalau model 1 tidak sehat, turun ke model berikutnya |

Fusion dan combo-role **tidak** diimplementasikan (lihat §3.3).
