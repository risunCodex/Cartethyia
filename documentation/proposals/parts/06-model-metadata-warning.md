# Proposal — Model warning metadata (`!` indicator) di provider detail

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** schema (migration), console API contract, dashboard UI (provider-detail Models section), provider catalog seed; tidak menyentuh routing.
**Method:** audit langsung (Read/Grep/codegraph_explore) pada 6 area: dashboard Models section, schema + migrations, console model API, precedent badge/tooltip, qoder fallback/refusal, seeder/discovery.

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.6 (D33–D38) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Render model di provider detail
- Model dirender oleh `ModelCard` di `dashboard/src/features/provider-detail/sections/Models.tsx:747-1173`, dikelompokkan oleh `MODEL_GROUPS` (`Models.tsx:85-115`) dan digrid oleh `ModelGrid` (`Models.tsx:1196-1296`).
- Card sudah membawa *badge/pill* per fakta model, semua dengan tooltip native `<span title=…>`:
  - `Pro` pill untuk `proOnly` — `Models.tsx:949-956`.
  - `Free tier` pill untuk `freeTier` — `Models.tsx:963-970`.
  - Dot `AlertCircle` (`.estimate-dot`) untuk `limitsEstimated` — `Models.tsx:1023-1031`, style di `dashboard/src/styles/app.css:1613-1616`, teks tooltip di `dashboard/src/lib/format/tokens.ts:151-154`.
- Tidak ada komponen tooltip library; pola repo adalah atribut `title` native + `cursor-help` + `aria-label` (lih. `Models.tsx:1024-1030`, `AccountStatusBadge.tsx:35,63,114` yang memakai `Badge` dengan prop `title`).

### 1.2 Schema model sekarang
- Tabel `models` (`src/persistence/schema.ts:413-481`) kolom relevan: `pro_only boolean` (3-nilai, `schema.ts:452`), `free_tier boolean` (3-nilai, `schema.ts:461`), `dialect text` (`schema.ts:467`), `modalities jsonb` (`schema.ts:431`), `cost jsonb` (`schema.ts:434`).
- Precedent JSONB: `modalities`, `cost`, `model_cooldowns` (`schema.ts:252`), `model_block_hits` (`schema.ts:264`).
- Source-of-truth statis per model ada di `ModelDefinition` (`src/providers/provider-model-definition.ts:37-121`) dan `ModelHelperRow` (`:151-208`); `defineModel` meneruskan `proOnly`/`freeTier`/`dialect` opsional (`:308-310`).

### 1.3 Migration flow
- Dua set migration paralel, **forward-only** (baseline 0000 di-immutable):
  - `migrations/full-postgres/0000_baseline.sql` (`models.modalities jsonb`, baris 90-93).
  - `migrations/lite-sqlite3/0000_baseline.sql` (`models.modalities text` — JSON disimpan sebagai text, baris 82-85).
- Pola kolom baru: `ALTER TABLE "models" ADD COLUMN IF NOT EXISTS …` — lih. `0017_add_models_pro_only.sql`, `0019_add_models_free_tier.sql`, `0040_add_models_dialect.sql`. Terbaru: `0043_add_provider_custom_user_agent.sql` (dua set). Migration berikutnya `0044_…`.

### 1.4 Console API — model list & update
- DTO: `ModelCatalogEntry` (`src/console/providers/catalog/contracts.ts:306-361`) — sudah punya `proOnly?`, `freeTier?`, `limitsEstimated?`.
- Proyeksi DB→DTO: `mapModelRow` (`src/console/providers/catalog/store-helpers.ts:299-349`), meneruskan `proOnly`/`freeTier` hanya jika `true` (`:343-346`).
- Update: `ModelMetadataOverride` (`contracts.ts:402-410`), `UpdateModelMetadataRequest` (`:420-422`), `ProviderCatalogStore.updateModelMetadata` (`:814-818`), implementasi `DrizzleProviderCatalogStore.updateModelMetadata` (`src/console/providers/catalog/store.ts:554-609`) — semantik “absent field = leave stored value alone”.
- Validasi: `validateModelMetadata` (`src/console/providers/catalog/model-operations.ts:38-50`).
- Route: `PATCH /providers/:providerId/models` memakai `setModelEnabledBody` (+ `metadata` opsional) — `src/console/providers/catalog/routes.ts:138-143,292-314`; `registerModelsBody` di `:114-118`.
- Mirror dashboard: `dashboard/src/data/contracts.ts:65-91` (type-only re-export), `ModelMetadataPayload` di `dashboard/src/hooks/providers.ts:20-27`, `useUpdateModelMetadata` (`:212-234`), `assertModels` di `dashboard/src/data/assert.ts:288-301` (validasi minimum, tidak strict terhadap field baru).

### 1.5 Qoder fallback / refusal (fakta yang mau dikomunikasikan)
- **Fallback model:** id virtual yang tidak dikenali roster dijawab upstream dengan fallback ke `auto` — komentar di `src/providers/integrations/qoder/qoder-ide.ts:424-425`; translasi virtual→roster key di `qoder-adapter.ts:167-184` dan `qoder-virtual.ts:76-89`.
- **Refusal / plan:** `refusal` adalah terminal verdict *sukses* (bukan error) di gRPC — `qoder-grpc.ts:785-791`; map finish reason `refusal` di `qoder-ide.ts:161-169`. Free-tier row `lite` ditolak gRPC (`quota exceeded` 116) dan harus lewat COSY — `qoder-adapter.ts:83-86`.
- **Cache reliability / serving-model metadata:** upstream hanya melaporkan model yang benar-benar melayani via `raw_usage` (keys `provider_model`, `target`, `supply_model`, `router_strategy_name/type`, `model_level`, `scheduler_times`) — `QODER_PROVIDER_META_KEYS` di `qoder-ide.ts:177-189`; disurface verbatim di probe (`src/providers/discovery/probing-service.ts:604-623`, `ProbeModelResult.providerMetadata`).
- Discovery qoder di-cache 300 detik per realm — `qoder-catalog.ts:401-443`.

### 1.6 Seeder & discovery (pemilik baris `models`)
- `seedBundledModels` (`src/providers/operations/provider-catalog-seeder.ts:8-97`) menulis `proOnly`/`freeTier`/`dialect` dari `ModelDefinition` (`:58-62,90-92`).
- Discovery upsert di `probing-service.ts:923-957` (metadata) dan `:968-985` (set upsert: `cost`, `proOnly`, `freeTier`, `dialect`, `source`).

### 1.7 Test yang mengunci perilaku ini
- `test/console/model-metadata-override.test.ts:128-179` mem-pin `mapModelRow` (unsized row, pro-flag).
- `dashboard/test/features/models-show-filter.test.tsx:12-51` membangun `ModelCatalogEntry` stub untuk `ModelGrid`.
- `test/providers/buddy-pro-only-realm.test.ts:16-29` mem-pin `proOnly` per roster.

---

## 2. Masalah yang diminta diatasi

1. Tidak ada cara untuk menampilkan **peringatan per model** di provider detail; fakta “provider mungkin fallback model”, “cache reliability bisa degraded”, “model refusal” saat ini hanya ada sebagai komentar kode (1.5) dan metadata probe yang sesaat, bukan sebagai data persisten yang bisa dilihat operator.
2. Yang ada sekarang hanya flag boolean 2-perilaku (`proOnly`, `freeTier`) — tidak bisa membawa pesan atau kategori multiple per model.
3. Requirement menuntut: data **bawaan DB** (bukan hardcode UI), **migration**, dan desain **general/reusable** untuk semua provider (qoder hanya iterasi pertama).

---

## 3. Desain yang diusulkan

### 3.1 Data: kolom `warning_metadata` di tabel `models`
- **Postgres:** `warning_metadata jsonb` (nullable, default `NULL`).
- **SQLite:** `warning_metadata text` (JSON string, mengikuti pola `modalities` text — lih. 1.3).
- Shape JSON (dict, bukan array, supaya bisa di-extend per-row):

```ts
// Type kanonik di src/providers/provider-model-definition.ts (ModelDefinition) dan
// diproyeksi ke ModelCatalogEntry (contracts.ts).
interface ModelWarning {
  /** Kategori stabil, machine-readable; bukan enum tertutup di tahap awal. */
  readonly kind: "fallback_model" | "cache_reliability" | "model_refusal" | string;
  /** Kalimat manusiawi yang dirender di tooltip, mis. "Provider may fall back
   *  to another model for this slot." */
  readonly message: string;
  readonly severity?: "info" | "warn" | "critical"; // default "warn"
  /** Kapan dicatat (ISO). Akan diisi seeder saat upsert. */
  readonly updatedAt?: string;
}

interface ModelWarningMetadata {
  readonly warnings: readonly ModelWarning[];
}
```

- **Nilai `NULL` = tidak ada peringatan** (bukan array kosong) — konsisten dengan trailing 3-nilai `proOnly`/`freeTier` (`schema.ts:438-461`).

### 3.2 Migration (forward-only, dua set)
- `migrations/full-postgres/0044_add_models_warning_metadata.sql`:

```sql
-- Peringatan per model (nullable; NULL = tidak ada). JSONB agar shape bisa
-- berkembang tanpa migration per kategori.
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "warning_metadata" jsonb;
```

- `migrations/lite-sqlite3/0044_add_models_warning_metadata.sql`:

```sql
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "warning_metadata" text;
```

- **Tidak** menyentuh `0000_baseline.sql`. `bun run check:migrations` wajib hijau (drift check membandingkan DDL Drizzle vs SQL committed — lih. `.skills/cartethyia-engineering/references/verification.md:17-24`).

### 3.3 Runtime flow (guard & fallback)
1. **Compile-time:** `ModelDefinition.warnings?` dan `ModelHelperRow.warnings?` ditambahkan; `defineModel` meneruskan `…(row.warnings === undefined ? {} : { warnings: row.warnings })` (pola sama dengan `proOnly`, `provider-model-definition.ts:308-310`).
2. **Seed:** `seedBundledModels` menulis `warningMetadata: definition.warnings ?? null` dan menambahkannya ke set upsert (`provider-catalog-seeder.ts:58-62,90-92`). **Guard:** karena seeder me-reconcile baris builtin setiap boot, `warnings` dari catalog statis tidak bisa di-override operator — hanya baris non-builtin yang editable (lihat 3.5).
3. **Discovery:** `probing-service.ts` upsert membawa `warningMetadata: discDef?.warnings ?? knownDefinition?.warnings ?? null` (sama pola `proOnly`, `:933-935,968-985`). **Fallback:** jika keduanya absence → `NULL`.
4. **Projection:** `mapModelRow` meneruskan `...(row.warningMetadata === undefined || row.warningMetadata === null ? {} : { warnings: row.warningMetadata.warnings })` — hanya jika non-null, supaya wire lama (tanpa field) tetap valid.
5. **Routing tidak berubah:** kolom ini *display-only*; tidak dibaca oleh `route-catalog.ts` / `plan-gate.ts`. Guard eksplisit: jangan tambahkan ke `MODEL_COLUMNS` (`route-catalog.ts:298-316`).

### 3.4 API contract
- `ModelCatalogEntry.warnings?: readonly ModelWarning[]` ditambahkan (`contracts.ts:306-361`).
- `ModelMetadataOverride.warnings?: readonly ModelWarning[] | null` (`contracts.ts:402-410`) — `null` (= clear) dan absent (= leave alone) dibedakan, konsisten dengan semantik existing.
- Validasi `validateModelMetadata` (`model-operations.ts:38-50`): `kind` string non-empty ≤ 64 char, `message` string non-empty ≤ 500 char, `severity` dari whitelist; selain itu `invalid_request` 400.
- Elysia body: `modelMetadataOverrideBody` (+ `warnings` opsional) di `routes.ts:110-113`; `setModelEnabledBody`/`registerModelsBody` otomatis ikut via reuse.
- Mirror dashboard: `ModelMetadataPayload` (`hooks/providers.ts:20-27`) + `warnings?`; `assertModels` tetap longgar (field baru tidak wajib — kompatibel dengan response lama).

### 3.5 UI: ikon `!` di `ModelCard`
- Di baris badge card (dekat pill `Pro`/`Free tier`, `Models.tsx:941-978`), render ikon peringatan bila `model.warnings?.length`:
  - **Hover:** tooltip native `title` berisi semua `message` (dipisah newline), plus `severity` terparah sebagai state visual (warna orange untuk `warn`, merah untuk `critical`).
  - **Click:** toggle inline detail block (pola `showMetaDetails` yang sudah ada di `Models.tsx:777,1134-1169`) menampilkan daftar `kind` + `message` + `updatedAt`.
  - **A11y:** `aria-label="Model warnings: …"`, `role="button"` + `tabIndex` saat clickable, `cursor-help`.
- Style: reuse `.estimate-dot` pattern (`app.css:1613-1616`) atau `Badge tone="warn"` dengan ikon `AlertTriangle` (sudah diimport di `Models.tsx:3`).
- **Edit dialog (wajib, D33):** `EditModelModal` (`Models.tsx:661-745`) mendapatkan seksi “Warnings” (list + add/remove/clear) hanya untuk baris non-builtin — `onEditRequest` sudah tidak ada untuk builtin (`Models.tsx:1246-1248`).
- **Flat picker** (`dashboard/src/components/ModelPicker.tsx`) di luar scope iterasi pertama (lihat 6.4).

### 3.6 Dari mana isinya (untuk qoder sebagai iterasi pertama)
- **Sumber A — statis/roster:** `QODER_INTL_MODEL_CONFIGS` / `QODER_CN_MODEL_CONFIGS` (`qoder-catalog.ts:105-169`) dan `QODER_VIRTUAL_MODELS` (`qoder-virtual.ts:40-57`) mendapat `warnings` per baris. Contoh berbasis bukti kode:
  - Baris virtual yang slotnya bisa dijawab upstream dengan `auto` (fallback) → `kind: "fallback_model"`.
  - Baris yang `is_free: true` tapi ditolak gRPC (`lite`) → `kind: "model_refusal"` (plan/transport).
  - Baris yang diketahui punya risiko cache/serving-model (metadata `router_strategy_name`/`supply_model` tersedia di `raw_usage`) → `kind: "cache_reliability"`.
- **Sumber B — manual/operator:** lewat `EditModelModal` (non-builtin only).
- **Sumber C — ditolak (D38):** auto-deteksi dari `reportedModel` (`probing-service.ts:604-623`) tidak dikerjakan.

### 3.7 Rekomendasi opsi
- **Kolom JSONB di `models` vs tabel terpisah `model_warnings`:** kolom JSONB menang — pola sudah dipakai (`modalities`, `cost`), jumlah warning per row kecil, dan menghindari join + FK baru. Tabel terpisah hanya menang kalau warning perlu di-query/agregate lintas model — belum ada kebutuhan.
- **Source compile-time (ModelDefinition) vs hanya DB:** dua-duanya, compile-time sebagai seed (konsisten dengan `proOnly`/`freeTier`), DB sebagai penyimpanan final. Tanpa seed, qoder perlu script isi manual per deploy — bertentangan dengan “bawaan db”.

---

## 4. File yang tersentuh

| Area | File |
|---|---|
| Schema | `src/persistence/schema.ts` (kolom `warning_metadata` di `models`) |
| Migration | `migrations/full-postgres/0044_add_models_warning_metadata.sql`, `migrations/lite-sqlite3/0044_add_models_warning_metadata.sql` |
| Provider model definition | `src/providers/provider-model-definition.ts` (`ModelDefinition`, `ModelHelperRow`, `defineModel`) |
| Seeder | `src/providers/operations/provider-catalog-seeder.ts` |
| Discovery upsert | `src/providers/discovery/probing-service.ts` |
| Qoder catalog (isi awal) | `src/providers/integrations/qoder/qoder-catalog.ts`, `qoder-virtual.ts` |
| Console contracts | `src/console/providers/catalog/contracts.ts` (`ModelCatalogEntry`, `ModelMetadataOverride`, `ProviderCatalogStore`) |
| Console store | `src/console/providers/catalog/store-helpers.ts` (`mapModelRow`), `src/console/providers/catalog/store.ts` (`updateModelMetadata`) |
| Console route/validasi | `src/console/providers/catalog/routes.ts`, `model-operations.ts` |
| Dashboard mirror | `dashboard/src/data/contracts.ts`, `dashboard/src/hooks/providers.ts`, `dashboard/src/data/assert.ts` |
| Dashboard UI | `dashboard/src/features/provider-detail/sections/Models.tsx` (badge `!`, tooltip, Edit dialog), `dashboard/src/styles/app.css` (class ikon, bila perlu) |
| Tests | `test/console/model-metadata-override.test.ts` (projection), `test/providers/*` (seed qoder), `dashboard/test/features/models-show-filter.test.tsx` (rendering badge) |

---

## 5. Migrasi & risk

### Migrasi
- Forward-only, dua set (postgres + sqlite), `0044_…`, `ADD COLUMN IF NOT EXISTS`, nullable, tanpa default value — tidak ada backfill yang diperlukan (NULL = tidak ada warning).
- `check:migrations` (drift DDL vs SQL) adalah gate wajib (`verification.md:17-24`).
- Baseline lama (0000) tidak diubah; DB yang ada dengan history migration lama di-restore ke fresh database untuk uji (bukan dev/prod).

### Risk
| Risk | Mitigasi |
|---|---|
| `mapModelRow`/seeder/upsert lupa membawa kolom baru → warning hilang diam-diam | `check:migrations` + test projection; kolom ditambahkan ke semua 3 titik tulis (seed, discovery, update) |
| Seeder reconcile menimpa warning operator pada baris builtin | Builtin tidak editable (guard di `updateModelMetadata`, `store.ts:579-585`); warning builtin = milik catalog |
| Payload besar/tidak valid | Validasi `kind`/`message`/`severity` (3.4); `NULL`/absent tidak pernah jadi array kosong |
| UI markup ambigu (hover + click) | `title` untuk hover; toggle inline untuk click; `aria-label`; browser pass wajib (`verification.md:30-34`) |
| Wire lama tanpa field | Field opsional di type; `assertModels` tetap longgar |
| Routing tidak sengaja membaca kolom | Guard: jangan tambah ke `MODEL_COLUMNS` (`route-catalog.ts:298-316`) |

### Baseline test (harus dicatat saat eksekusi)
- Baseline saat ini **belum ditangkap di sesi audit ini** — sesuai `verification.md:79-83`, eksekusi wajib mengutip angka pass/fail sebelum-sesudah: `bun run typecheck`, `bun run dashboard:typecheck`, `bun run test` (backend), `bun test test/protocol`, `bun run check:migrations`.
- Tes baru yang wajib:
  1. `mapModelRow` memproyeksi `warnings` dari row yang punya, dan mengomit saat `NULL` (`test/console/model-metadata-override.test.ts` style).
  2. Seed qoder menulis warning ke baris builtin (qoder intl + cn) dan tidak menimpanya saat re-seed.
  3. `updateModelMetadata` menerima `warnings` (set/clear) hanya untuk non-builtin; menolak shape invalid (400).
  4. Dashboard: `ModelGrid` merender ikon `!` saat `warnings` non-empty; `title` berisi semua pesan; click toggle membuka detail (`dashboard/test/features/models-show-filter.test.tsx` style).
  5. `check:migrations` hijau (drift nol).

---

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.6 (D33–D38). Tidak ada yang menunggu jawaban,
termasuk tidak ada "konfirmasi fakta per roster" yang ditunda.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D33 | **Edit UI disertakan** untuk baris non-builtin (`EditModelModal`: list + add/remove/clear). | Mengganti rekomendasi audit; area 05 membuat baris non-builtin, jadi reuse lintas provider butuh edit. |
| D34 | Severity 3 level `info \| warn \| critical`, default `warn`. | State visual ikon `!`. |
| D35 | `kind` string terbuka + 3 nilai terdefinisi: `fallback_model`, `cache_reliability`, `model_refusal`. | Extensible tanpa migrasi per kategori. |
| D36 | Flat `ModelPicker.tsx` **tidak** menampilkan warning. | Batas eksplisit, bukan fase lanjutan. |
| D37 | Isi awal qoder = **tiga warning bertingkat provider** dengan bahasa "may" (`fallback_model`, `cache_reliability`, `model_refusal`), melekat ke seluruh baris `qoder`/`qodercn`; **tidak ada klaim per-model**. | Requirement berbunyi *"provider ini mungkin akan memfallback model, cache reliability expect to be degraded and model refusal"* — provider-level. Bukti: `qoder-ide.ts:424-425`, `:177-189`, `qoder-adapter.ts:83-86`, `qoder-grpc.ts:785-791`. Tidak mengarang fakta per roster. |
| D38 | Auto-deteksi dari `reportedModel` **tidak** dikerjakan. | Batas eksplisit (menyentuh telemetry/attempt-finalize). |

Semua penanda lama, dan
"Konfirmasi fakta per roster" di §1–§5 dibaca melalui tabel ini. Koreksi terkait: §3.6 Sumber C dihapus dari cakupan, §3.5 "Edit dialog …
mendapatkan seksi Warnings" kini wajib, §4/§5 tidak ada pekerjaan
fase lanjutan. Isi seed qoder ditulis di level provider, bukan per baris roster —
jadi tidak ada data upstream yang dikarang.

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C2 + C3 + C6.

| Area | Status | Bukti |
| --- | --- | --- |
| Kolom + migrasi `0044` (dua set) | ✅ | `models.warning_metadata` jsonb/text nullable; `check:migrations` 45 migration OK. |
| `ModelDefinition`/seeder/discovery/`mapModelRow` | ✅ | Empat titik tulis/proyeksi membawa `warningMetadata`; `parseWarningMetadata` menolak shape invalid (R-E). |
| Kontrak + validasi | ✅ | `ModelCatalogEntry.warnings?`, `ModelMetadataOverride.warnings? | null`; set/clear hanya non-builtin, `kind` ≤64 / `message` ≤500 / severity whitelist, invalid → 400. |
| UI ikon `!` | ✅ | `ModelCard` badge dengan `title` native + toggle inline + `aria-label`; `model-warnings.test.tsx`. |
| Edit UI (D33) | ✅ | `WarningEditor` di `EditModelModal` untuk baris non-builtin. |
| Isi awal qoder (D37) | ✅ | `QODER_PROVIDER_WARNINGS` — tiga warning provider-level (`fallback_model`, `cache_reliability`, `model_refusal`) bahasa "may", melekat ke seluruh baris qoder/qodercn; tanpa klaim per-model. |
| Auto-deteksi `reportedModel` (D38) | ⛔ | **Sengaja tidak dikerjakan** — batas eksplisit master §3.6 (menyentuh telemetry/attempt-finalize). |
| Flat `ModelPicker` (D36) | ⛔ | **Sengaja tidak dikerjakan** — batas eksplisit, bukan fase lanjutan. |

Keputusan D33–D38 diterapkan; dua ⛔ adalah batas yang disetujui.

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
