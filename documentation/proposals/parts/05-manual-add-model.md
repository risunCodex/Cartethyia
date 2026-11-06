# Proposal — Add model berbasis fetch `v1/models` (search + multi-select, configs mengikuti fetched)

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** console API contract (routes/operations), provider discovery layer (probing service), dashboard UI (provider-detail Add Model dialog), dashboard hooks+contracts mirror. Tidak menyentuh schema DB (tidak ada migrasi) dan tidak mengubah routing/dispatch.
**Method:** audit langsung (Read/Grep/codegraph_explore) pada 6 area: AddModelModal + Models section di dashboard, hooks dashboard (useRegisterProviderModels / useSyncProviderModels), console model routes/operations (`src/console/providers/catalog/`), discovery layer (`src/providers/discovery/`, `src/providers/operations/`), schema `models`, precedent picker/search (`ModelPickerModal`).

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.5 (D27–D32) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Manual add model — flow sekarang
- **UI:** `AddModelModal` (`dashboard/src/features/provider-detail/sections/Models.tsx:243-496`) adalah form manual murni: input teks bebas "Model ID" (`Models.tsx:384-398`), tombol Test (probe), pilih wire family (`Models.tsx:422-432`), dan `ModelMetadataFields` (`Models.tsx:544-660`) untuk isi manual context/output limits + flag `passthrough`/`image`/`reasoning`/`toolCall`. Draft default `newModelDraft` (`Models.tsx:532-534`) memakai fallback ceilings `FALLBACK_CONTEXT_TOKENS`/`FALLBACK_OUTPUT_TOKENS`.
- **Submit:** `handleAdd` (`Models.tsx:334-371`) mengirim **satu model** via `useRegisterProviderModels` (`dashboard/src/hooks/providers.ts:86-120`) → `POST /providers/:providerId/models` body `{ modelIds: [normalized], wireFamily, metadata }`.
- **Backend route:** `createProviderCatalogRoutes` (`src/console/providers/catalog/routes.ts:253-266`) → `createModelCatalogOperations.registerModels` (`src/console/providers/catalog/model-operations.ts:178-198`). Body `registerModelsBody` (`routes.ts:114-118`) sudah menerima `modelIds: t.Array(t.String())` + **satu** `metadata` untuk semua id (`routes.ts:117`).
- **Store:** `DrizzleProviderCatalogStore.registerModels` (`src/console/providers/catalog/store.ts:337-405`) — multi-row upsert; metadata per baris = `applyModelMetadataOverride(resolveManualModelMetadata(providerId, modelId), metadata)` (`store.ts:383-386`).
- **`resolveManualModelMetadata`** (`src/providers/provider-model-definition.ts:336-352`) me-resolve capabilities dari **packed catalog statis** (`modelsDevCatalog.resolve`), default `reasoning: true`, `toolCall: true`, modalities text+image. Artinya: untuk id yang tidak ada di catalog statis, limit Fall `null` dan capabilities memakai default, bukan fakta upstream.

### 1.2 Fetch `v1/models` — sudah ada, tapi persist-otomatis
- **Fetcher inti:** `fetchOpenAICompatibleModels` (`src/providers/discovery/openai-model-discovery.ts:26-121`) — tolerant, parsing `data|models|items` (`openai-model-discovery.ts:194-204`), context/output limits dari banyak spelling (`:49-76`), image modality (`:94-97`), cost dari `modelsDevCatalog.costFor` (`:78`), wire family dari `isResponsesNativeModelId` (`:98`).
- **Orkestrasi:** `ProviderProbingService.syncModels` (`src/providers/discovery/probing-service.ts:720-867`) — dua cabang: (a) bundled/registered provider via `providerRegistry.resolveModelDiscovery(providerId)` (`probing-service.ts:724-770`; credential dari `usableAccount` `:732-733,1030-1050`), (b) custom/BYOK via `fetchOpenAICompatibleModels` pada `modelDiscoveryBaseUrl(providerRow.baseUrl)` (`:772-823`). Hasil langsung di-persist oleh `persistDiscoveredModels` (`probing-service.ts:869-1016`): upsert, skip id builtin (`:888,903`), `source = "discovered" | "auto_free"` (`:951`), chunk 500 (`:962`).
- **Route sync:** `POST /:providerId/models/sync` (`routes.ts:338-340`) → `syncModels` (`model-operations.ts:156-176`, butuh `platform:admin`); `GatewayError` → `ConsoleDomainError` (`:166-175`). Dashboard: `useSyncProviderModels` (`hooks/providers.ts:808-834`), tombol "Fetch models" (`ProviderDetailPage.tsx:641-654`), auto-sync hanya untuk opencode/cline (`ProviderDetailPage.tsx:182,213-224`).
- **Kesenjangan:** tidak ada endpoint yang mengembalikan daftar candidate hasil fetch tanpa menuliskannya ke DB. Satu-satunya cara melihat model upstream = sync penuh (register semua sekaligus).

### 1.3 Schema `models` (target persist)
- `src/persistence/schema.ts:413-481`: `providerId`, `modelId`, `wireFamily`, `serviceKind`, `endpointPath`, `contextLimit`, `outputLimit`, `modalities jsonb`, `reasoning`, `toolCall`, `cost jsonb`, `source`, `sourceUpdatedAt`, `enabled`, `proOnly`, `freeTier`, `dialect`. Unique `(provider_id, model_id, endpoint_path)` (`schema.ts:470-474`). Tidak perlu kolom baru.

### 1.4 Precedent pencarian + multi-select di dashboard
- `ModelPickerModal` (`dashboard/src/components/ModelPicker.tsx:72-279`): search field (`:94-108`, filter client-side atas `qualified`/`modelId`/`providerId`), multi-select chips (`:163-184`), grouping oleh provider (`:110-135`), error+retry (`:195-201`), empty state (`:202-207`). Data dari `useAllModelsCatalog` → `GET /providers/models/flat` (`ModelPicker.tsx:17-38`). Ini precedent siap-reuse untuk picker candidate.

### 1.5 Capability per provider
- `ProviderResponse.supportsModelDiscovery` (`src/console/providers/catalog/contracts.ts:730`; dihitung di `provider-operations.ts:190-193` — `!isBuiltIn || resolveModelDiscovery !== undefined`). Dashboard sudah memakainya untuk mengontrol auto-sync (`ProviderDetailPage.tsx:217`).

### 1.6 Precedent batas array
- `bulkDeleteModelsBody.items` dibatasi `maxItems: 1000` (`routes.ts:148-150`). Multicra `registerModels` tidak punya batas (model `modelIds: t.Array(t.String())`).

---

## 2. Masalah yang diminta diatasi

1. **Add model sekarang manual murni** — operator harus mengetik id (sering salah), mengisi limits/capabilities dengan tangan, dan hanya bisa menambahkan **satu** model per dialog (`Models.tsx:334-371`).
2. **Tidak ada daftar model yang bisa ditambah dari fetch** — hasil `v1/models` hanya tampil lewat "Fetch models" yang *langsung mendaftarkan semua* (probing-service.ts:720-867), tanpa kesempatan memilih; id yang tidak ada di packed catalog statis tidak mendapat token/capabilities upstream (provider-model-definition.ts:336-352).
3. **Pencarian tidak ada di add-model flow** — `ModelPickerModal` punya search+multi-select tapi hanya untuk picker model *yang sudah terdaftar* (ModelPicker.tsx:72-108), bukan untuk kandidat baru.
4. Requirement: daftar kandidat berasal dari fetch `v1/models` (bukan statis), bisa dicari, multi-select, dan konfigurasi (token/capabilities) mengikuti hasil fetch — bukan isian manual.

---

## 3. Desain yang diusulkan

### 3.1 Alur baru (dua fase, read-only → commit)
```
Buka Add Model dialog
 → GET /providers/:providerId/models/discover   (fetch v1/models, TANPA persist)
 → render daftar candidate + search + multi-select
 → operator mencentang subset
 → POST /providers/:providerId/models/discover/commit { modelIds }
 → persist baris `source="manual"` dengan metadata dari hasil fetch (upsert)
```

### 3.2 Backend
- **`GET /providers/:providerId/models/discover`** (read-only, scoped `MODEL_READ_SCOPES`):
  - Menjalankan discovery yang **sama** dengan `syncModels`: `resolveModelDiscovery` untuk registered provider, fallback `fetchOpenAICompatibleModels` untuk BYOK (`probing-service.ts:724-823`). Kredensial dari `usableAccount` (`probing-service.ts:1030-1050`) — akun tenant pertama yang usable, sama seperti sync.
  - **Tidak persist.** Return `DiscoverModelCandidate[]`: `{ modelId, wireFamily, serviceKind, endpointPath, contextLimit, outputLimit, modalities, reasoning, toolCall, freeTier, proOnly, alreadyRegistered }`. `alreadyRegistered` di-set dengan intersect terhadap `listModelsForTenant` (store.ts:294-336) — baris yang sudah ada dirender disabled + badge "Registered".
  - Guard: fetch gagal (`null` dari resolver / 401 / timeout) → `GatewayError("transport_unavailable", 502)` yang sama dengan sync (`probing-service.ts:744-761`), diterjemahkan ke `ConsoleDomainError` di layer console (`model-operations.ts:166-175`). Provider dengan `supportsModelDiscovery === false` → kembalikan `{ supported: false }` agar UI jatuh ke mode manual (tidak gagal).
  - Tanpa cache antar-request (akun bisa berubah; sync path juga tidak cache). Reuse `getCachedModelDiscovery` TIDAK dipakai (itu untuk discovery credential-free, model-discovery-cache.ts:20-29).
- **`POST /providers/:providerId/models/discover/commit`** (scoped `MODEL_WRITE_SCOPES`):
  - Body `{ modelIds: string[] }` (batas **100**, ikut semangat `bulkDeleteModelsBody` tapi lebih konservatif; dokumentasikan di contracts).
  - Menjalankan discovery **sekali lagi** di server, intersect `modelIds` dengan hasil fetch → **anti-forgery**: id yang tidak ada di hasil fetch ditolak (400) — mencegah flush id arbitrer dengan metadata palsu. Id yang `alreadyRegistered` di-skip senyap (idempotent upsert).
  - Persist memakai **`ModelDefinition` utuh hasil fetch** (context/output/modalities/reasoning/toolCall/wireFamily/endpointPath/freeTier/proOnly), dengan `source = "manual"` (bukan `discovered`). Implementasi: ekstrak loop persist `persistDiscoveredModels` (`probing-service.ts:869-1016`) menjadi helper yang menerima subset + source, agar upsert/chunk/prune tetap satu sumber benar. Karena source `manual` tidak pernah di-prune sync (prune hanya `discovered`/`auto_free`, `probing-service.ts:1006`), baris hasil pilihan tidak akan hilang saat roster upstream berubah.
  - Audit: baris `provider.models.registered` yang sama dengan registerModels existing (`model-operations.ts:190-195`), detail `{ modelIds, source: "discover-commit" }`.

### 3.3 Dashboard
- **`AddModelModal` di-rewrite** menjadi dua-tab / dua-mode:
  - **Mode "Dari provider" (default bila `supportsModelDiscovery`):** pada saat open, fetch candidates (`GET …/discover`). Render dengan pola `ModelPickerModal` (ModelPicker.tsx:94-135): input search client-side atas `modelId`, checkbox multi-select + chips, grouping, loading/error/empty state dengan tombol retry.
  - **Mode "Tambah manual" (fallback):** form existing (Models.tsx:384-496) tetap dipertahankan utuh — dipakai saat fetch gagal (banner error + tombol "Tambah manual"), atau saat `supportsModelDiscovery=false`. Ini menjawab fallback: **tidak** ada daftar statis pengganti; fet yang gagal = error + opsi manual, bukan daftar basi.
  - Submit mode provider → `POST …/discover/commit`; submit mode manual → `registerModels` existing (tidak berubah).
  - Hook baru: `useDiscoverModelCandidates(providerId)` (query) dan `useCommitDiscoveredModels()` (mutation, invalidate `queryKeys.providers.models(providerId)` seperti `useRegisterProviderModels` hooks/providers.ts:110-115).

### 3.4 Telemetry/observability
- Tidak ada field telemetry baru. Load time discovery sudah di-track (`trackModelCatalogLoad`, model-catalog-cache.ts:71-73). Opsional: audit event commit (3.2).

### 3.5 Opsi yang dievaluasi
- **A. Reuse `registerModels` + kirim `metadata` hasil fetch per eksekusi seragam:** tidak bisa — contract `registerModelsBody` hanya membawa satu `metadata` untuk semua id, dan `resolveManualModelMetadata` tetap menimpa dengan catalog statis (store.ts:383-386). Perlu contract baru yang sama besar dengan commit endpoint.
- **B. Modifikasi `registerModels` menerima `metadataByModel`:** menambah branch ke endpoint existing, tapi mencampur dua semantik (manual murni vs fetched) di satu contract, dan tetap tidak menjamin id berasal dari fetch.
- **C. Endpoint commit terpisah (rekomendasi):** guard anti-forgery alami, contract eksplisit, sync/register existing tidak tersentuh. Kelemahan: fetch dua kali (preview + commit) — biaya network kecil (≤10s timeout per fetch, openai-model-discovery.ts:31), konsistensi dijamin server-side.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Console API — contracts | `src/console/providers/catalog/contracts.ts` (DTO `DiscoverModelCandidate`, `DiscoverModelCommitRequest`) |
| Console API — operations | `src/console/providers/catalog/model-operations.ts` (`listDiscoveryCandidates`, `commitDiscoveredModels`) |
| Console API — routes | `src/console/providers/catalog/routes.ts` (+`GET /:providerId/models/discover`, +`POST /:providerId/models/discover/commit`) |
| Console API — store | `src/console/providers/catalog/store.ts` (delegasi ke probing service) |
| Provider layer — discovery | `src/providers/discovery/probing-service.ts` (split `persistDiscoveredModels` jadi helper subset+source; expose discover/commit) |
| Dashboard — hooks | `dashboard/src/hooks/providers.ts` (`useDiscoverModelCandidates`, `useCommitDiscoveredModels`) |
| Dashboard — UI | `dashboard/src/features/provider-detail/sections/Models.tsx` (rewrite `AddModelModal`) |
| Dashboard — contracts mirror | `dashboard/src/data/contracts.ts`, `dashboard/src/data/assert.ts` (type mirror + assert minimum, pola `assertModels`) |

---

## 5. Migrasi & risk

- **Migrasi DB: tidak ada.** Tidak ada kolom/tabel/indeks baru; `source="manual"` sudah ada di vocab (`store.ts:387`, `contracts.ts:335`). `check:migrations` tidak perlu diubah.
- **Behavior change:** `AddModelModal` berubah dari form manual murni menjadi fetch-first dengan fallback manual. Perilaku existing (mode manual, `registerModels`, sync penuh "Fetch models") tetap dipertahankan — tombol/tab tidak dihapus.
- **Risk 1 — kredensial:** commit memakai akun *pertama yang usable* (`usableAccount`). Jika tenant punya banyak akun dengan catalog berbeda (mis. plan berbeda), fetch bisa menampilkan roster akun yang bukan yang operator maksud. → D27; mitigasi UI: tampilkan label akun yang dipakai.
- **Risk 2 — fetch dua kali:** preview + commit. Mitigasi: commit adalah satu-satunya sumber kebenaran; jika roster berubah di antara keduanya, intersect menolak id yang hilang (400, pesan "model tidak lagi ada di roster — ulangi fetch").
- **Risk 3 — besar payload:** cap 100 model/commit, upsert chunk 500 sudah ada (probing-service.ts:962).
- **Risk 4 — invalidasi snapshot:** commit wajib memanggil `config.snapshotInvalidator.invalidate()` seperti registerModels (model-operations.ts:196).
- **Baseline test (diukur hari ini, sebelum perubahan):**
  - `bun run test:backend` → **4484 pass / 4 skip / 0 fail** (4488 tests, 404 files).
  - `bun test` (dashboard/, cwd dashboard) → **656 pass / 0 fail** (656 tests, 55 files).
  - `bunx tsc --noEmit` (repo root) → exit 0, tanpa output error.
  - `bun run dashboard:typecheck` → exit 0.
  - Catatan: `bun test` full-repo (semua scope sekaligus) menghasilkan 5143 pass / 6 fail — 6 fail tersebut di luar baseline resmi (master §5); baseline resmi yang dipakai adalah dua scope di atas.
- **Test baru yang membuktikan desain:**
  - `test/providers/model-sync-without-account.test.ts` diperluas → discover read-only tidak persist (hitung baris `models` sebelum/sesudah), dan commit anti-forgery (id di luar fetch → 400).
  - `test/console/provider-list-overview.test.ts` / `public-model-cache.test.ts` → `alreadyRegistered` intersect benar.
  - `dashboard/test/features/`: modal fetch-first (loading → daftar → multi-select → commit), fallback manual saat fetch gagal, badge "Registered" disabled, search filter.
  - Pin `models` upsert: baris commit punya `source="manual"` + metadata persis dari ModelDefinition hasil fetch (bukan fallback statis).

---

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.5 (D27–D32). Tidak ada yang menunggu jawaban.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D27 | Kredensial fetch = `usableAccount` (akun pertama usable, sama dengan `syncModels`); label akun ditampilkan di UI. | Tidak ada pemilih akun; DTO tanpa `accountId`. |
| D28 | `source = "manual"` untuk baris hasil commit. | Tidak pernah di-prune sync (`probing-service.ts:1006`). |
| D29 | Cap **100** model per commit. | Upsert chunk 500 sudah ada. |
| D30 | `GET discover` cukup `MODEL_READ_SCOPES`; `commit` tetap `MODEL_WRITE_SCOPES`. | Discover read-only. |
| D31 | Endpoint commit terpisah (Opsi C); `registerModels` **tidak** diubah. | Anti-forgery alami. |
| D32 | Satu modal dua-mode (default "Dari provider", fallback "Tambah manual"); tombol "Fetch models" (sync penuh) **tetap ada**. | Semantik pilih-subset vs daftar-semua berbeda. |

Semua penanda lama, termasuk opsi B, "tab terpisah vs satu modal", dan
"D27" di §1–§5 dibaca melalui tabel ini. Koreksi terkait: §5 Risk 1
"→ D27" kini menjadi mitigasi pasti (label akun ditampilkan),
bukan pertanyaan; §3.5 Opsi A/B ditolak, Opsi C dipakai pasti. Catatan baseline di
§5 tentang 6 fail full-repo **bukan** pertanyaan desain — baseline resmi adalah dua
scope yang dikutip di master §5.

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C3 + C6.

| Gap (§2) | Status | Bukti |
| --- | --- | --- |
| G1 (add model manual satu-satu) | ✅ | `AddModelModal` dua-mode; commit `{ modelIds }` cap `DISCOVER_MODEL_COMMIT_MAX = 100`; `add-model-discovery.test.tsx`. |
| G2 (fetch `v1/models` langsung persist semua) | ✅ | `GET /:providerId/models/discover` read-only tanpa persist + `discoverModels` di `probing-service.ts`; test `model-sync-without-account.test.ts` (baris `models` sebelum/sesudah identik). |
| G3 (tidak ada pencarian) | ✅ | Search client-side atas `modelId` + multi-select chips, pola `ModelPickerModal`; badge "Registered" disabled. |
| G4 (configs bukan dari fetched) | ✅ | Commit memakai `ModelDefinition` utuh hasil fetch (context/output/modalities/reasoning/toolCall), `source="manual"`, anti-forgery intersect server-side (id di luar roster → 400). |

Keputusan D27–D32 diterapkan seluruhnya: `usableAccount` + label akun tampil (D27), `source="manual"` (D28), cap 100 (D29), `MODEL_READ_SCOPES`/write (D30), endpoint commit terpisah (D31), satu modal dua-mode + "Fetch models" tetap ada (D32).

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
