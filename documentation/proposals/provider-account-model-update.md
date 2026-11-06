# Proposal — Provider account & model operations update (8 area)

**Status:** executed (full) — 8/8 area ✅ (Rover, 2026-11-06)
**Tanggal:** 2026-11-06
**Scope:** account health / cooldown (`src/providers/operations/`), OAuth & quota refresh
(`src/providers/authentication/`, `src/providers/quota/`), console settings
(`src/console/settings/`), console provider catalog (`src/console/providers/catalog/`),
schema + migrasi (`src/persistence/schema.ts`, `migrations/*`), protocol/transport error
envelope (`src/protocol/`, `src/transport/`), discovery/probing (`src/providers/discovery/`),
dashboard (`dashboard/src/features/settings/`, `dashboard/src/features/provider-detail/`).
Routing dibaca sebagai dependensi, tidak diubah perilakunya.
**Method:** 8 audit subagent paralel, satu per area; `codegraph_explore` + `Read`/`Grep`.
Per-area report adalah source of truth evidence di `documentation/proposals/parts/`
(`01`–`08`, lihat §0). Dokumen ini mengkomposisi semuanya, menutup residual lintas-area,
dan **mengganti seluruh 49 butir audit yang masih menggantung dengan keputusan
final** (§6). Tidak ada item tertunda, tidak ada pekerjaan lanjutan yang belum
dijadwalkan, dan tidak ada fakta yang menunggu konfirmasi di dokumen ini maupun
di parts/01–08.

---

## 0. Parts (source of truth per area)

| Part | Area | Owner skill (canonical) |
| --- | --- | --- |
| `parts/01-auto-disable-rate-limited.md` | Settings: auto-disable rate-limited accounts | `cartethyia-health-routing` + `cartethyia-console-api` + `cartethyia-dashboard` |
| `parts/02-provider-detail-actions.md` | Provider detail: redesign action, disable all cooldown, delete banned | `cartethyia-console-api` + `cartethyia-dashboard` |
| `parts/03-cooldown-per-provider-role.md` | Cooldown per provider & role (free/pro/paid) | `cartethyia-health-routing` |
| `parts/04-refresh-disabled-status.md` | Refresh status akun disabled tanpa re-activate | `cartethyia-health-routing` + `cartethyia-console-api` |
| `parts/05-manual-add-model.md` | Add model via `v1/models` fetch + search + multi-add | `cartethyia-provider-catalog` + `cartethyia-console-api` |
| `parts/06-model-metadata-warning.md` | Metadata warning model (`!`), qoder first → general | `cartethyia-schema-telemetry` + `cartethyia-provider-catalog` + `cartethyia-dashboard` |
| `parts/07-modelprobe-test.md` | Modelprobe: `ask detail` / `fast minimal` + settings surface | `cartethyia-console-api` + `cartethyia-dashboard` |
| `parts/08-upstream-error-passthrough.md` | Upstream error message as-is, tanpa generalize 502 | `cartethyia-trace-replay` (wire bytes) + protocol/transport |

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Health / cooldown pipeline (dipakai 01, 03, 04, 02)

`reportAttemptOutcome` (`src/providers/operations/account-health-service.ts:531-549`) →
`recordAccountFailure` (`:62-288`) → `classifyAccountError`
(`src/providers/operations/account-error-classification.ts:801-804`) → tabel rule
`ACCOUNT_ERROR_RULES` (`:1212+`) → writer memilih **model-scoped** (`modelCooldowns[modelId]`,
`:169-244`) untuk throttle + `modelId`, atau **account-wide** (`status` + `cooldownUntil`,
`:246-268`). Fakta kunci:

- `AccountErrorClassification.status` hanya `"cooldown" | "disabled"` (`:266`); `disabled`
  hari ini **hanya** dari `validation-required`, `github-copilot-not-licensed`,
  `credential-rejected` named-revocation (`:1270-1395`). **Nol rule quota/rate-limit yang
  menghasilkan `disabled`** (`:1520-1624`) — temuan F1/01.
- `sweepExpiredCooldowns` (`:406-484`) hanya memilih `status='cooldown' AND cooldown_until <= now`
  (`:416-423`); `disabled` tidak pernah di-sweep, di-pin `test/providers/disabled-recovery-sweep.test.ts:114-168`.
- `recordAccountSuccess` early-return `false` untuk `disabled` (`:312`), dan routing sudah
  mengecualikan `disabled` sejak SELECT (`src/transport/routing/route-catalog.ts:428`,
  `router.ts:279-280`). **Implikasi lintas-area:** jalur sukses tidak bisa memulihkan akun disabled,
  apa pun guard yang ditambahkan (lihat §3.3/R2).
- `escalateFallbackCooldown` (`account-error-classification.ts:337-345`) memakai
  `Math.min(cooldownMs * 2 ** level, resolveAccountCooldownEscalationMaxMs())` dengan cap default
  **1h** (`src/config/spec.ts:256`). Durasi kebijakan 24h (Trae/Grok/Qoder) yang tidak
  disertai window upstream dicegat jadi 1h pada `streak = 0` — temuan HIGH F2/03.
- Role/plan sudah ada sebagian: `provider_accounts.quota_plan` (`schema.ts:311`, migrasi
  `0018_add_accounts_quota_plan.sql`) diisi `fetchProviderQuota` (`src/providers/quota/refresh.ts:405-414`)
  oleh 10+ collector, dan dipakai routing `plan-gate.ts:22-45`. **Classifier buta role**:
  `AccountFailureEvidence` (`:220-262`) tidak punya field plan/tier.

### 1.2 Refresh (04)

- OAuth: `loadDueOAuthAccounts` (`src/providers/authentication/oauth-refresh-service.ts:435-477`)
  hanya `["active","cooldown"]` (`:456`); `persistRefreshed` (`:173-219`) dan `markStaticToken`
  (`:303-318`) **tidak pernah menulis `status`**. Klaim "refresh mengaktifkan ulang" tidak
  terbukti (F1/04).
- Quota: `listQuotaRefreshTargets` (`src/providers/quota/refresh.ts:265-280`) **menyertakan**
  `disabled`; `recordAccountCheck` active-only (`:153-156`) membuat stamp no-op. Jadi akun
  disabled sudah di-refresh token tiap menit secara diam-diam (F2/04).
- Celah nyata: `disableAccount` (`oauth-refresh-service.ts:244-288`) menulis `cooldownUntil`
  ke baris operator-disabled → `isRecoverable` (`AccountRow.tsx:186-188`) true → tombol Recover
  bisa mengaktifkan ulang (F5/04). Docstring `reconcileStaticTokenAccounts` (`:365-367`) basi.

### 1.3 Settings (01, 07)

`console_settings.preferences` JSONB (`schema.ts:1293-1297`), `ConsoleSettingsPreferences`
(`:1190-1291`), kontrak `RuntimeSettingsResponse` / `runtimeUpdateBody`
(`src/console/settings/contracts.ts:15-73`, `:235-275` — **field yang tidak terdaftar di body
di-drop diam-diam**, komentar `:246-259`), store `DrizzleRuntimeSettingsStore.update`
(`:199-249`), routes `GET/PATCH /settings/runtime` (`routes.ts:10-29`), dashboard
`OperationalPanel` (`SettingsPage.tsx:424+`) dengan preceden toggle `forceDisableCooldown`
(`:455-492`, dibaca request-path di `route-catalog.ts:458-474`). **Reuse penuh, tanpa migrasi.**

### 1.4 Console provider catalog (02, 05, 06, 07)

- Bulk actions provider detail masih **client-side fan-out** (`Accounts.tsx:179-191`,
  `TEST_ALL_CONCURRENCY = 3`), padahal `PATCH /accounts/batch`
  (`src/console/quota/account-quota-tenant.ts:787-821`) dan `POST /accounts/batch-delete`
  (`:847-888`) sudah ada sebagai satu statement server-side (F1/02).
- "Banned" **bukan status DB**: `status='disabled' AND last_error_category='policy_blocked_banned'`
  (`account-error-classification.ts:196`, `:1293-1310`; badge `AccountStatusBadge.tsx:61-67`).
- "Cooldown" = `status='cooldown' OR cooldown_until > now OR model_cooldowns` punya entri live
  (`quota-view.ts:163-173`).
- Add model: `AddModelModal` (`Models.tsx:243-496`) manual murni, satu id per submit, metadata
  dari `resolveManualModelMetadata` (`provider-model-definition.ts:336-352`, packed catalog statis).
  Fetch `v1/models` sudah ada (`src/providers/discovery/openai-model-discovery.ts:26-121`,
  `probing-service.ts:720-867`) tapi **langsung persist semua**; tidak ada endpoint read-only (05).
- Model row: `models` (`schema.ts:413-481`), DTO `ModelCatalogEntry`
  (`contracts.ts:306-361`), proyeksi `mapModelRow` (`store-helpers.ts:299-349`), badge `Pro`/
  `Free tier`/`estimate-dot` dengan tooltip `title` native (`Models.tsx:949-1031`). Kolom
  `warning_metadata` belum ada (06).
- Probe: `probeModel` (`probing-service.ts:185`) sudah lengkap (stream, `max_tokens` 256,
  retry 1024, timeout 30s, telemetry, `recordProbeHealth`); route `POST /models/probe`,
  `/models/test-models`, `/accounts/probe` (`routes.ts:267-291`). `test-models` **mati** di UI.
  Non-Qoder memakai `gateway-model-test.ts` (bukan console probe) demi akurasi routing ladder
  (komentar `:7-14`). Settings tidak punya section probe (07).

### 1.5 Error envelope (08)

`mapUpstreamHttpError` (`src/transport/failure-policy.ts:923`) → `classifyUpstreamError` (`:808`)
→ `publicGatewayErrorBody` (`src/protocol/gateway-error.ts:206`) →
`createErrorNormalizationMiddleware` (`src/transport/guards/error-lifecycle.ts:72`).
**Jalur HTTP utama sudah meneruskan pesan upstream verbatim** untuk JSON terstruktur
(`test/transport/failure-policy.test.ts:2160-2168`). Gap hanya pada unknown/unparseable:
Claude non-JSON (`send-claude-messages.ts:57-85`), SSE malformed (`sse-decoder.ts:97,104,226`),
stream kosong / envelope tanpa message (`compatible-adapter.ts:411-449,488`), frame record tanpa
message (`stream-error-frames.ts:65`), dan error mentah yang jatuh ke 500 `internal_error`
(`error-lifecycle.ts:102-107`). Kontrak redaksi repo = **verbatim, tanpa string-sniffing**
(`src/observability/redaction.ts:3-11`; `gateway-error-envelope.test.ts:467-512`).

---

## 2. Masalah yang diminta diatasi

| # | Requirement (Rover) | Masalah konkret pada kode |
| --- | --- | --- |
| R1 | Settings > auto disable rate limited accounts | Tidak ada rule 429/quota → `disabled`; 429 dengan `modelId` tenggelam jadi cooldown per-model; tidak ada toggle. |
| R2 | Provider detail > redesign action + disable all cooldown + delete banned | Bulk fan-out client-side, dua aksi massal tidak ada, tidak ada definisi query "banned". |
| R3 | Cooldown mengikuti aturan per provider × role (free/pro/paid) | Cooldown = konstanta hardcoded, buta role; cap eskalasi 1h memendekkan kebijakan 24h. |
| R4 | Refresh status akun disabled tanpa mengaktifkan kembali | Tidak ada kontrak eksplisit "refresh ≠ status", tidak ada affordance UI, ada celah Recover-palsu. |
| R5 | Manual add model: daftar dari `v1/models`, search, multi-add, configs ikut fetched | Add model manual satu-satu; fetch `v1/models` langsung persist semua; tidak ada endpoint read-only. |
| R6 | Tanda `!` metadata model (qoder first, general, dari DB, migration) | Fakta fallback/cache/refusal hanya jadi komentar kode; tidak ada kolom metadata peringatan. |
| R7 | Settings > modelprobe test, mode `ask detail` / `fast minimal` | Satu mode probe saja; tidak ada surface settings; `test-models` mati. |
| R8 | Undefined error upstream: message as-is, jangan generalize 502 | Pesan hilang di 5 titik unknown/unparseable; fallback 502/500 generik menimpa teks asli. |

---

## 3. Desain yang diusulkan

### 3.1 Executive summary

| Area | Temuan bernomor | Severity tertinggi | Behavior change? | Effort | Prioritas |
| --- | --- | --- | --- | --- | --- |
| 01 auto-disable | F1–F6 (6) | HIGH | ya, **opt-in** (default off) | M | P0 |
| 02 provider actions | F1–F6 (6) | HIGH | ya (aksi baru + konsolidasi internal) | M | P1 |
| 03 cooldown × role | F1–F6 (6) | HIGH | ya, **hanya saat role dikenal** | M | P0 |
| 04 refresh disabled | F1–F6 (6) | HIGH | ya (endpoint + guard kecil) | M | P0 |
| 05 add model | gap §2 (4) | HIGH (gap read-only discovery) | ya (UI fetch-first, fallback manual) | L | P1 |
| 06 warning metadata | §1.1–1.7 | MED | ya (display-only) | M (1 migrasi) | P1 |
| 07 modelprobe mode | §1.1–1.6 | MED | ya, **default tidak berubah** | M | P2 |
| 08 error passthrough | F1–F8 (8) | HIGH | ya (message-only, status tetap) | M | P0 |

Total **32 temuan bernomor** (8 HIGH) + 3 area dengan gap tanpa penomoran. Delapan HIGH:
`01/F1`, `01/F2`, `02/F2`, `02/F3`, `03/F1`, `03/F2`, `04/F6`, `08/F2`.

### 3.2 Prioritas tiered

- **P0 — correctness & invariant:** 03 (cap eskalasi + tier), 08 (passthrough), 04 (refresh ≠ status), 01 (auto-disable). Ini yang menyentuh dispatch/health dan punya regression risk tertinggi.
- **P1 — surface operator:** 02 (dua aksi massal), 05 (add model), 06 (warning `!` + migrasi `0044`).
- **P2 — diagnostik:** 07 (mode probe + settings + `test-models`).

Urutan eksekusi mengikuti ketergantungan: **fondasi** (migrasi `0044`, modul `account-tier.ts`/
`cooldown-rules.ts`, helper `upstreamMessageAsIs`) → **health** (01/03/04) → **console** (02/05/06/07)
→ **dashboard** (semua UI) → **validasi penuh**.

### 3.3 Residual lintas-area (ditutup di sini, bukan di part)

| # | Konflik | Keputusan |
| --- | --- | --- |
| R-A | **01 vs 04:** 01/D05 mengusulkan guard `recordAccountSuccess` agar sukses memulihkan auto-disable. 04 §1.2 membuktikan `recordAccountSuccess` early-return `false` untuk `disabled` dan routing mengecualikan `disabled` sejak SELECT. Guard itu **dead code**. | Guard **tidak ditambahkan**. Pemulihan auto-disable **hanya** lewat sweep Opsi B (D03) atau operator `recoverAccount`. Tidak ada jalur sukses otomatis. |
| R-B | **01 vs 02:** 02 menyimpan `cooldownUntil` + `lastErrorCategory` sebagai evidence saat disable massal. 01 Opsi B akan merecover baris `disabled` dengan kategori target + deadline lewat → **mengaktifkan ulang akun yang sengaja di-disable operator**. | Predikat sweep Opsi B **wajib** menyertakan marker auto-disable eksplisit: `last_error LIKE 'auto-disable (rate-limited): %'` (prefiks yang sudah diusulkan 01 §3.7). Kategori + deadline saja tidak cukup. Operator disable tetap terminal. |
| R-C | **01 vs 03:** Trae `4008` diklasifikasi `model_unreachable` (`account-error-classification.ts:1482-1497`), bukan `quota_exhausted`. Kalau auto-disable dan rule tier sama-sama aktif, kebijakan bisa tumpang tindih. | Pemisahan eksplisit: `model_unreachable` **milik 03** (rule tier: free 24h / paid pendek), `quota_exhausted` + `rate_limit_transient` **milik 01** (auto-disable). Tidak ada double policy pada satu verdict. |
| R-D | **02 vs 04:** 02 mempertahankan `cooldownUntil` (evidence) sehingga `isRecoverable` true pada baris `disabled`; 04/F5 ingin menutup Recover-palsu. | 04 memperbaiki **hanya** `disableAccount` (OAuth failure path): tidak menulis `cooldownUntil` ke operator-disabled. Tombol Recover pada akun hasil aksi 02 **tetap ada** — itu aksi operator eksplisit, bukan aktivasi otomatis. Invarian: *disabled tidak pernah pulih tanpa tindakan operator atau marker auto-disable + sweep*. |
| R-E | **05 vs 06:** 05 commit baris `source="manual"` (non-builtin) lewat upsert di `probing-service.ts`; 06 menambah `warning_metadata` ke jalur seed/discovery/upsert yang sama. | Satu jalur upsert: `warningMetadata = discDef?.warnings ?? knownDefinition?.warnings ?? null`. Baris hasil 05 dapat warning dari static definition bila id cocok, selain itu `NULL` dan **dapat diedit** lewat `EditModelModal` (D33). Migrasi `0044` **harus** landas dulu sebelum 05/06 menyentuh upsert. |

### 3.4 Desain per area (ringkas; detail + evidence di parts)

- **01** — Toggle `autoDisableRateLimited` di JSONB preferences (default off). Intercept di
  `recordAccountFailure` setelah klasifikasi, sebelum cabang model-scoped, hanya bila
  `mutatesAccount && origin === "upstream" && category ∈ {quota_exhausted, rate_limit_transient}
  && status === "cooldown"`. Rewrite `status = "disabled"` + `cooldownUntil` +
  alasan berprefiks marker. Baca preferensi gagal → off. Recovery: sweep Opsi B dengan marker
  (R-B). Routing tidak diubah.
- **02** — Dua route `POST /providers/:providerId/accounts/actions/disable-cooldowns` dan
  `.../delete-banned` (satu UPDATE/DELETE statement, satu invalidasi snapshot, satu audit row),
  **plus pasangan global** `POST /global/accounts/actions/...` untuk akun shared (D10).
  Response `{ ok, updated, deleted?, missing?, globalSkipped }`. Toolbar: `Disable cooldown (n)` /
  `Delete banned (n)`, pola "selalu mounted, grey out", `ConfirmDialog` untuk delete.
  Bulk existing dikonsolidasi ke endpoint batch server-side.
- **03** — Modul `account-tier.ts` (`mapPlanToTier` dari `quota_plan`, `free | paid | pro | null`)
  + `cooldown-rules.ts` (static registry in-code). Presedensi: **provider-stated > rule
  (provider, kategori, tier) > konstanta lama > fallback env**. Unknown = perilaku hari ini.
  Durasi dari rule **tidak** lewat `escalateFallbackCooldown` (perbaikan F2, test mengunci 24h).
  `cooldownMs = 0` tidak dipakai (D17). Tanpa kolom baru, tanpa override manual (D15/D20).
- **04** — Invariant "refresh ≠ status" dikunci di `persistRefreshed` + test. Fungsi
  `refreshAccountStatus` (force refresh, `statusAfter` dibaca ulang dari DB, tidak pernah
  `"active"`), endpoint `POST /providers/:providerId/accounts/:accountId/refresh-token`,
  tombol `Refresh token` di `AccountRow` untuk OAuth non-static termasuk `disabled`.
  `disableAccount` + `preserveOperatorDisable`; `markStaticToken` mempertahankan
  `lastErrorCategory` untuk baris `disabled`; docstring basi diperbaiki. Split sweep dipertahankan.
- **05** — `GET /providers/:providerId/models/discover` (read-only, tanpa persist, kredensial
  `usableAccount`, `alreadyRegistered` intersect) + `POST .../models/discover/commit`
  (`modelIds`, cap 100, discovery ulang di server sebagai anti-forgery, persist `source="manual"`
  dengan `ModelDefinition` utuh hasil fetch). `AddModelModal` dua-mode: "Dari provider" (search +
  multi-select, pola `ModelPickerModal`) default, "Tambah manual" sebagai fallback saat fetch
  gagal / `supportsModelDiscovery=false`. Tombol "Fetch models" (sync penuh) tetap ada.
- **06** — Kolom `warning_metadata` (jsonb Postgres / text SQLite, nullable, `NULL` = tidak ada
  warning), migrasi forward-only `0044_add_models_warning_metadata.sql` di dua set, tanpa backfill.
  Shape `{ warnings: [{ kind, message, severity?, updatedAt? }] }`. Alur:
  `ModelDefinition` → seed → DB → `mapModelRow` → `ModelCatalogEntry.warnings?` →
  ikon `!` (`AlertTriangle`) dengan `title` (hover) + toggle inline (click) + `aria-label`.
  Edit di `EditModelModal` **hanya non-builtin**. Display-only: tidak masuk `MODEL_COLUMNS`.
  Isi awal qoder = **tiga warning bertingkat provider** dengan bahasa "may" (D37).
- **07** — `ProbeModelRequest.mode?: "fast" | "detail"` (absent = `detail`). `fast`: 32 token,
  timeout 10s, tanpa retry, tanpa payload-body capture, telemetry ringkas, `sample` 80 char,
  `recordProbeHealth` tetap. Settings section `model-testing` (default mode + timeout, JSONB).
  `ModeSelect` per-provider (localStorage) + tombol **"Test all models"** menghidupkan
  `test-models`. Jalur gateway non-Qoder tetap dipertahankan dengan opt `fast`.
- **08** — Helper `upstreamMessageAsIs` di `failure-policy.ts`, diterapkan di 5 titik
  pengumpulan (F1–F5) + penutup celah pembungkus (F6). Hanya kategori unknown/undefined;
  error terklasifikasi tidak berubah; status code tidak berubah; bound 500 publik / 4000
  `details.raw`; flag `upstreamMessageAsIs` di `PUBLIC_ERROR_DETAIL_KEYS`; `applyRequestId`
  tetap append. Middleware dan `errorClientResponseBody` **tidak diubah** (F7 diselesaikan
  lewat pembungkus).

### 3.5 Klaster eksekusi (file-disjoint)

| Klaster | File yang dimiliki | Area |
| --- | --- | --- |
| C1 health core | `account-health-service.ts`, `account-error-classification.ts`, `account-tier.ts`*, `cooldown-rules.ts`*, `src/config/cooldowns.ts` | 01 writer, 03, recovery sweep |
| C2 prefs + schema + migrasi | `src/persistence/schema.ts`, `src/console/settings/*`, `migrations/full-postgres/0044*`, `migrations/lite-sqlite3/0044*` | 01 toggle, 06 kolom, 07 prefs |
| C3 catalog API + discovery | `src/console/providers/catalog/*`, `src/providers/discovery/probing-service.ts`, `src/providers/provider-model-definition.ts`, `provider-catalog-seeder.ts`, qoder catalog | 02, 05, 06 proyeksi, 07 route |
| C4 protocol/transport | `src/transport/failure-policy.ts`, `src/protocol/*`, `src/providers/adapters/compatible-adapter.ts` | 08 |
| C5 OAuth refresh | `src/providers/authentication/oauth-refresh-service.ts`, `src/providers/quota/refresh.ts` | 04 |
| C6 dashboard | `dashboard/src/features/settings/*`, `dashboard/src/features/provider-detail/*`, `dashboard/src/hooks/*`, `dashboard/src/data/*` | 01/02/04/05/06/07 UI |
| C7 tests | `test/**` baru + regresi, `dashboard/test/**` | semua |

`*` = file baru. Orkestrator menutup residual antar-klaster (C2 → C3 → C6 urutan wajib).
Semua perubahan **lokal, satu commit**, push hanya bila operator meminta.

### 3.6 Batas eksplisit (bukan pertanyaan, sengaja di luar scope)

`account_tier` kolom/override manual (03/D15), tabel `provider_cooldown_rules`,
tier-aware `QUOTA_FAILURE_COOLDOWN_MS`, auto-deteksi warning dari `reportedModel` (06/Sumber C),
warning di flat `ModelPicker`, konsolidasi jalur gateway test ke console probe (07), perubahan
middleware error (08), perubahan routing/plan-gate, dan migrasi selain `0044` — **tidak
dikerjakan pada iterasi ini**. Ini batas yang disengaja, bukan item yang menunggu keputusan.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Health | `src/providers/operations/account-health-service.ts`, `account-error-classification.ts`, `account-tier.ts`*, `cooldown-rules.ts`*, `src/config/cooldowns.ts` |
| Refresh | `src/providers/authentication/oauth-refresh-service.ts`, `src/providers/operations/account-refresh-status.ts`*, `src/providers/quota/refresh.ts` |
| Settings | `src/persistence/schema.ts` (`ConsoleSettingsPreferences`), `src/console/settings/contracts.ts`, `store.ts`, `src/providers/operations/account-health-service.ts` (`autoDisableRateLimitedEnabled`: resolver toggle fail-safe, baca langsung dari DB tanpa cache in-process — SO_REUSEPORT multi-process) |
| Schema & migrasi | `src/persistence/schema.ts` (`models.warning_metadata`), `migrations/full-postgres/0044_add_models_warning_metadata.sql`*, `migrations/lite-sqlite3/0044_add_models_warning_metadata.sql`* |
| Console catalog | `src/console/providers/catalog/contracts.ts`, `routes.ts`, `store.ts`, `store-helpers.ts`, `model-operations.ts`, `provider-operations.ts`, `src/console/quota/account-quota-global.ts` |
| Discovery / katalog model | `src/providers/discovery/probing-service.ts`, `discovery-types.ts`, `probe-phases.ts`, `src/providers/provider-model-definition.ts`, `src/providers/operations/provider-catalog-seeder.ts`, `src/providers/integrations/qoder/qoder-catalog.ts`, `qoder-virtual.ts` |
| Protocol / transport | `src/transport/failure-policy.ts`, `src/protocol/gateway-error.ts`, `sse-decoder.ts`, `stream-error-frames.ts`, `messages-errors.ts`, `src/protocol/upstream/send-claude-messages.ts`, `src/providers/adapters/compatible-adapter.ts` |
| Dashboard | `dashboard/src/features/settings/SettingsPage.tsx`, `dashboard/src/features/provider-detail/sections/{Models,Accounts,AccountRow,AccountStatusBadge}.tsx`, `dashboard/src/features/provider-detail/sections/gateway-model-test.ts`, `ProviderDetailPage.tsx`, `dashboard/src/hooks/{providers,settings,quota}.ts`, `dashboard/src/data/{contracts,assert}.ts`, `dashboard/src/styles/app.css`, `dashboard/src/features/logs/audit-labels.ts` |
| Test | `test/providers/auto-disable-rate-limited.test.ts`*, `account-tier.test.ts`*, `cooldown-rules.test.ts`*, `refresh-disabled-status.test.ts`*, `test/console/provider-detail-bulk-actions.test.ts`*, `provider-account-refresh-token.test.ts`*, `test/providers/model-sync-without-account.test.ts` (diperluas), `test/transport/failure-policy.test.ts`, `test/console/model-metadata-override.test.ts`, `dashboard/test/features/*` |

---

## 5. Migrasi & risk

**Migrasi:** tepat **satu** perubahan DDL — `0044_add_models_warning_metadata.sql` di dua set
(forward-only, `ADD COLUMN IF NOT EXISTS`, nullable, tanpa backfill, baseline `0000` tidak
disentuh). Semua area lain memakai JSONB `console_settings.preferences` atau kolom existing.
Gate wajib: `bun run check:migrations` (drift DDL vs SQL) hijau.

**Backward compatibility:** default off pada perilaku yang mengubah rotasi (01 toggle, 03
unknown-role, 07 default `detail`); `mode` absent = `detail`; `warnings?` opsional sehingga
wire lama tetap valid; `assertModels` tetap longgar; routing/plan-gate tidak berubah.

| Risk | Mitigasi |
| --- | --- |
| Sweep Opsi B mengaktifkan ulang operator disable | Marker `last_error LIKE 'auto-disable (rate-limited): %'` wajib (R-B); test `disabled-recovery-sweep.test.ts` diperluas. |
| Cap eskalasi 1h memendekkan 24h | Durasi rule role tidak lewat `escalateFallbackCooldown`; test mengunci 24h tanpa window upstream. |
| Misklasifikasi tier | Unknown = perilaku lama; mapping eksplisit per provider; `paid` tidak pernah `cooldownMs = 0`. |
| Anti-forgery add model | Commit menjalankan discovery ulang, intersect ketat, 400 bila id hilang dari roster. |
| Seeder menimpa warning operator | Builtin tidak editable; warning builtin milik catalog statis. |
| Redaksi pesan upstream | Kontrak repo = verbatim (`redaction.ts:3-11`); diputuskan dipertahankan (D46). |
| `runtimeUpdateBody` drop field diam-diam | Setiap field baru wajib didaftarkan di body schema (`contracts.ts:235-275`). |

**Test list (proof-of-design):** seluruh daftar di `parts/01`–`08` §5 tetap berlaku. Tambahan
wajib lintas-area: (a) akun hasil aksi 02 tidak pulih oleh sweep Opsi B; (b) Trae `4008`
(`model_unreachable`) tidak terkena auto-disable 01; (c) baris hasil commit 05 membawa
`warning_metadata` yang benar; (d) `recordAccountSuccess` pada `disabled` tetap no-op.

**Baseline verification (terukur hari ini, tidak dikarang):**

| Suite | Baseline |
| --- | --- |
| `bun run test:backend` | **4484 pass / 4 skip / 0 fail** (4488 tests, 404 files) — diukur part 05 |
| `bun test` (cwd `dashboard/`) | **656 pass / 0 fail** (55 files) — diukur part 05 |
| `bunx tsc --noEmit` | **exit 0** |
| `bun run dashboard:typecheck` | **exit 0** |
| transport+protocol subset | **326 pass / 0 fail** — diukur part 08 |
| klasifikasi provider subset | **30 pass / 0 fail** — diukur part 08 |
| `bun test` full-repo sekaligus | 5143 pass / **6 fail** — dinyatakan **di luar baseline resmi**; gate eksekusi memakai dua suite scope di atas + `bunx tsc --noEmit` + `bun test test/protocol` + `check:migrations`. Enam fail itu bukan pertanyaan desain. |

Angka after-state wajib dikutip di §7 dan dibandingkan per-suite.

---

## 6. Keputusan final (register — nol pertanyaan terbuka)

Seluruh **49** pertanyaan dari parts dikunci di bawah. `→` menandai keputusan yang
**mengganti rekomendasi subagent** dengan alasan lintas-area; sisanya mengikuti rekomendasi
part. Tidak ada keputusan yang ditunda.

### 6.1 Area 01 — auto-disable (D01–D06)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D01 | Target = `{quota_exhausted, rate_limit_transient}`. `model_unreachable` **tidak** termasuk. | R-C; Trae/Qoder quota di-own 03. Men-disable `model_unreachable` bertentangan `trae-quota-exhausted` (`:1478-1481`). |
| D02 | Bypass `shouldModelCooldown` untuk kategori target (opsi A). | Tanpa bypass, toggle nyaris tidak menembak (`account-health-service.ts:137-141`). |
| D03 | Recovery = **Opsi B**, sweep menyertakan `disabled` hanya bila `last_error_category ∈ target` **DAN** `last_error LIKE 'auto-disable (rate-limited): %'` **DAN** `cooldown_until <= now`. | R-B. Memakai deadline yang sudah ditulis tanpa mengaktifkan ulang operator disable. |
| D04 | → **Tidak** auto-disable bila `providerStated && statedCooldownMs < 5 menit`; biarkan cooldown 1m (Inception) bekerja. | Mengganti rekomendasi part (yang mau seragam). Memarkir akun 24h untuk limit 1m kehilangan kapasitas tanpa manfaat; cooldown sudah mencegah hammering (`:1573-1596`). |
| D05 | → **Tidak** menambah guard `recordAccountSuccess`. | R-A: `recordAccountSuccess` early-return untuk `disabled` (`:312`) + routing exclude (`route-catalog.ts:428`). Guard = dead code. |
| D06 | Akun shared: ikuti `anyTenantOverrides` — toggle tenant mana pun berlaku, didokumentasikan di hint UI. | `route-catalog.ts:474`. |

### 6.2 Area 02 — provider actions (D07–D13)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D07 | Definisi cooldown = `status='cooldown' OR cooldown_until > now OR model_cooldowns` live. | Mencocokkan badge + `isRecoverable` (`quota-view.ts:163-173`). |
| D08 | `cooldownUntil`/`modelCooldowns` **dipertahankan** sebagai evidence. | `recoverAccount` membersihkan keduanya; R-B sudah diamankan marker sweep. |
| D09 | Satu statement tanpa cap (konsisten `PATCH /accounts/batch`). | `account-quota-tenant.ts:797-798`. |
| D10 | → **(b) + route global di iterasi ini**: `globalSkipped` dilaporkan **dan** pasangan `POST /global/accounts/actions/...` (`requireGlobalAdmin`) dibuat. | Audit awal menunda route global; keputusan ini menyelesaikannya sekarang. Akun shared (`tenant_id NULL`) harus terjangkau, delete global sudah ada presedennya. |
| D11 | Label `Disable cooldown (n)` / `Delete banned (n)`, count inline. | Pola "selalu mounted, grey out" (`Accounts.tsx:345-348`). |
| D12 | Delete banned **strictly** `policy_blocked_banned`; `auth_invalidated` tidak termasuk. | Remediasi auth = ganti credential, bukan hapus. |
| D13 | Audit `provider_account.bulk_disabled_cooldowns` / `provider_account.bulk_deleted_banned`. | Eksplisit scope. |

### 6.3 Area 03 — cooldown × role (D14–D20)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D14 | Taksonomi `free \| paid \| pro \| null`. | Cukup untuk 10+ collector; `trial` masuk `paid` dengan durasi khusus. |
| D15 | → **Opsi A saja, lengkap**: tier selalu turunan `quota_plan`; tidak ada kolom `account_tier`, tidak ada override manual. | Audit awal menawarkan lanjutan; keputusan ini menolaknya tuntas. Override bukan bagian requirement dan menambah migrasi kedua; batas ditulis di §3.6. |
| D16 | Scope kategori: `quota_exhausted`, `model_unreachable`, `rate_limit_transient`. | Kategori penghasil 24h/1h; auth/ban/server_error tidak berubah. |
| D17 | `paid` → durasi pendek **15m**, bukan `0`. | `0` = langsung dicoba ulang, risiko hammering kalau verdict keliru. |
| D18 | Cap eskalasi **dipecah**: durasi dari rule role/provider tidak lewat `escalateFallbackCooldown`; fallback murni tetap pakai cap 1h. | Memperbaiki F2 (HIGH) tanpa env baru. |
| D19 | Static registry in-code `cooldown-rules.ts`; tidak ada tabel DB. | Default kosong = nol perubahan sampai rule diisi; sesuai "default off". |
| D20 | `QUOTA_FAILURE_COOLDOWN_MS` (6h, `refresh.ts:54`) **tidak** tier-aware. | Jalur terpisah; batas eksplisit §3.6. |

### 6.4 Area 04 — refresh disabled (D21–D26)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D21 | Split sweep dipertahankan: quota sweep menyentuh `disabled`, OAuth sweep mengecualikan. | Sudah berjalan; kuota sweep menjaga token tetap segar tanpa beban tambahan. |
| D22 | Tidak ada env/konfigurasi baru (`OAUTH_REFRESH_DISABLED_ACCOUNTS` ditolak). | Yang dibutuhkan invariant + test, bukan flag. |
| D23 | `disableAccount` **tidak** menulis `cooldownUntil` ke operator-disabled (F5). | Menutup Recover-palsu; machine disable tetap menulis deadline. |
| D24 | `markStaticToken` mempertahankan `lastErrorCategory` untuk baris `disabled` (F3). | Diagnosa "Re-login required" lebih berharga daripada baris bersih. |
| D25 | Endpoint terpisah `POST .../refresh-token`; `quota/refresh` tidak diperluas. | Semantik token ≠ quota; `recordAccountCheck` tetap active-only. |
| D26 | Observability: `origin` (`ui`/`sweep`/`dispatch`), `statusBefore`, `statusAfter` + health event non-mutating. | Biaya nihil, membuktikan "refresh tidak mengubah status". |

### 6.5 Area 05 — add model (D27–D32)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D27 | Kredensial fetch = `usableAccount` (akun pertama usable, sama dengan `syncModels`); label akun ditampilkan di UI. | Konsisten `probing-service.ts:1030-1050`; tanpa friction pilih akun. |
| D28 | `source = "manual"` untuk baris hasil commit. | Tidak pernah di-prune sync (`:1006`), menandakan pilihan operator. |
| D29 | Cap **100** model per commit. | Konservatif; upsert chunk 500 sudah ada. |
| D30 | `GET discover` cukup `MODEL_READ_SCOPES`; `commit` tetap `MODEL_WRITE_SCOPES`. | Discover read-only (tidak menulis DB). |
| D31 | Endpoint commit terpisah (opsi C); `registerModels` tidak diubah. | Anti-forgery alami; tidak mencampur dua semantik. |
| D32 | Satu modal dua-mode (default "Dari provider", fallback "Tambah manual"); tombol "Fetch models" (sync penuh) **tetap ada**. | Semantik berbeda: pilih subset vs daftar semua. |

### 6.6 Area 06 — warning metadata (D33–D38)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D33 | → **Edit UI disertakan** untuk baris non-builtin. | Mengganti rekomendasi part. R-E: 05 membuat baris non-builtin; tanpa edit, desain tidak benar-benar reusable lintas provider. |
| D34 | Severity 3 level `info \| warn \| critical`, default `warn`. | Murah, memberi state visual. |
| D35 | `kind` string terbuka + 3 nilai terdefinisi (`fallback_model`, `cache_reliability`, `model_refusal`). | Extensible tanpa migrasi per kategori. |
| D36 | Flat `ModelPicker` **tidak** menampilkan warning di iterasi ini. | Batas eksplisit §3.6. |
| D37 | → Isi awal qoder = **tiga warning bertingkat provider** (`fallback_model`, `cache_reliability`, `model_refusal`) dengan bahasa "may", melekat ke seluruh baris `qoder`/`qodercn`; **tidak ada klaim per-model**. | Mengganti "butuh konfirmasi fakta per roster". Requirement berbunyi *"provider ini mungkin akan memfallback model, cache reliability expect to be degraded and model refusal"* — provider-level. Bukti: `qoder-ide.ts:424-425`, `:177-189`, `qoder-adapter.ts:83-86`, `qoder-grpc.ts:785-791`. Tidak mengarang fakta per roster. |
| D38 | Auto-deteksi dari `reportedModel` **tidak** dikerjakan. | Batas eksplisit §3.6 (menyentuh telemetry/attempt-finalize). |

### 6.7 Area 07 — modelprobe (D39–D43)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D39 | Default global = `detail` saat unset; `mode` absent = `detail`. | Default off; tidak mengubah perilaku operator yang tidak menyentuh settings. |
| D40 | `fast` mengembalikan `sample` dipotong **80 char**. | Konfirmasi "model menjawab" dengan biaya token kecil. |
| D41 | Jalur ganda dipertahankan: non-Qoder tetap `gateway-model-test.ts` + opt `fast`. | `gateway-model-test.ts:7-14`: probe internal skip routing ladder → "Fail" palsu. |
| D42 | Prompt `fast` = prompt identitas yang sama, hanya batasi token. | Prompt identitas lolos content-policy (`probe-phases.ts:629-635`). |
| D43 | "Test all models" **dihidupkan** (`POST /models/test-models`). | Route sudah ada; mode fast membuatnya murah. |

### 6.8 Area 08 — error passthrough (D44–D49)

| ID | Keputusan | Alasan / evidence |
| --- | --- | --- |
| D44 | Bound pesan publik **500**; `details.raw` tetap 4000. | Konsisten `sanitizePublicDetail` + `MAX_UPSTREAM_ERROR_BYTES`. |
| D45 | Sumber as-is mencakup **HTML title + teks polos + JSON**, bukan hanya JSON. | Itulah kasus "undefined" yang paling sering kehilangan pesan. |
| D46 | Redaksi: **verbatim, tanpa `scrubSecrets`** pada message publik. | Kontrak repo `redaction.ts:3-11` + `gateway-error-envelope.test.ts:467-512`; sweep hanya untuk log. |
| D47 | `applyRequestId` tetap append ` (request <id>)`. | Traceability; klien bisa strip suffix. |
| D48 | F7 diselesaikan **dengan menutup celah pembungkus**; middleware/`errorClientResponseBody` tidak diubah. | 500 `internal_error` tetap benar untuk error internal sejati. |
| D49 | Flag `upstreamMessageAsIs: true` ditambahkan ke `PUBLIC_ERROR_DETAIL_KEYS`. | Membedakan pesan upstream asli di Request Detail; murah. |

**Tidak ada pertanyaan terbuka.** Batas-batas di §3.6 adalah keputusan "tidak dikerjakan",
bukan item yang menunggu jawaban.

---

## 7. Execution status

| Area | Status | Bukti / catatan |
| --- | --- | --- |
| 01 auto-disable | ✅ | C1: `autoDisableRateLimitedEnabled` (fail-safe, any-tenant), intercept + marker, bypass model-scoped, sweep recovery dengan marker (D03). Test `auto-disable-rate-limited.test.ts` + `disabled-recovery-sweep.test.ts`. 99 pass suite wajib / 0 fail; toggle UI di C6 (`auto-disable-rate-limited-setting.test.tsx`). |
| 02 provider actions | ✅ | C3: dua route catalog + pasangan global; C6: toolbar + count + ConfirmDialog + konsolidasi batch. 320 pass console / 0 fail; 701 pass dashboard / 0 fail. | 03 cooldown × role | ✅ | C1: `account-tier.ts`, `cooldown-rules.ts` (static registry, Trae free 24h / paid 15m), `applyRuleEscalation` (D18), presedensi stated > rule > konstanta > fallback. Test `account-tier.test.ts`, `cooldown-rules.test.ts`. 1452 pass providers / 0 fail. |
| 04 refresh disabled | ✅ | C5: `refreshAccountStatus` (`statusAfter` dibaca ulang, tidak pernah active), endpoint `refresh-token`, invariant `persistRefreshed`, `preserveOperatorDisable` (D23), `markStaticToken` simpan kategori (D24), log `origin`/`statusBefore`/`statusAfter` (D26), tombol Refresh token. Backend 40 pass / 0 fail; dashboard 7 pass / 0 fail; tsc 0. Deviasi tercatat di bawah. |
| 05 add model | ✅ | C3: discover read-only + commit anti-forgery (cap 100, `source="manual"`); C6: AddModelModal dua-mode. 397 pass discovery / 0 fail; `add-model-discovery.test.tsx`. | 06 warning metadata | ✅ | C2: migrasi `0044` dua set + `warning_metadata` (`check:migrations` OK, 45 migration). C3: seeder/discovery/`mapModelRow`/`QODER_PROVIDER_WARNINGS` (D37, provider-level "may", tanpa klaim per-model) + validasi set/clear non-builtin. C6: ikon `!` hover/click + `WarningEditor` (`model-warnings.test.tsx`). |
| 07 modelprobe | ✅ | C3: mode fast/detail + `test-models`; C2: prefs; C6: ModeSelect + Settings section + Test all models + gateway `fast`. 701 pass dashboard / 0 fail. |
| 08 error passthrough | ✅ | C4: `upstreamMessageAsIs` + `extractUpstreamMessageText` (prose ≠ `code`), 5 titik pengumpulan, flag `upstreamMessageAsIs` hanya saat prose asli, status code tidak berubah, bound 500/4000. 7 test passthrough baru; `failure-policy.test.ts` 206 pass / 0 fail; suite gabungan 356 pass / 0 fail. |

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

Seluruh finding di parts/01–08 sudah diberi ✅ (dengan evidence) atau ⛔
(dengan alasan batas eksplisit) di `## 7. Execution status` masing-masing part.
Tidak ada finding yang hilang atau diklaim selesai tanpa bukti.

**Deviasi eksekusi yang disetujui orkestrator:**
1. Resolver toggle auto-disable tidak dipisah ke `src/console/settings/auto-disable.ts`
   seperti daftar file awal. Implementasi final: `autoDisableRateLimitedEnabled` di
   `account-health-service.ts`, baca langsung dari `console_settings` **tanpa cache
   in-process**. Alasan: `bumpSettingsRevision()` hanya in-process, sedangkan gateway
   berjalan multi-process (SO_REUSEPORT), sehingga cache per-tenant berisiko membuat
   toggle yang diubah lewat proses A tidak terbaca proses B. `parts/01` §3.3/§4 sudah
   diselaraskan. Perilaku (default off, fail-safe, D06 any-tenant) tidak berubah.
2. `stream-error-frames.ts` memakai `extractUpstreamMessageText` (helper baru di
   `failure-policy.ts`) untuk membedakan prose upstream dari `code`/identifier: flag
   `upstreamMessageAsIs` hanya muncul saat ada `message`/`msg`/`error` asli, sedangkan
   `code` tetap dipakai sebagai fallback pesan (konvensi lama, di-pin test). Dua
   ekspektasi di `test/protocol/stream-errors.test.ts` diperbarui sesuai D49.
3. Suite health (C1) dan bulk-actions (C3) memakai fixture SQLite; dua cabang
   PostgreSQL diuji langsung oleh orkestrator terhadap DB test isolated
   (`cartethyia_gwtest`), bukan dibiarkan sebagai klaim yang belum terbukti:
   - Predikat `model_cooldowns` live (`jsonb_each_text` + `value::timestamptz > now()`,
     `dialect.ts:87`) → **live=1, expired/kosong/NULL=3**, sesuai semantics
     `liveModelCooldowns`.
   - Predikat recovery sweep (`inArray(lastErrorCategory)` + `like(lastError,
     'auto-disable (rate-limited): %')` + deadline, `account-health-service.ts:572-588`)
     → memilih tepat `auto_expired` + `cooldown_expired`; operator disable tanpa
     marker, kategori non-target, dan deadline masa depan tetap terminal.
   Kedua verifikasi memakai tabel TEMP disposable, tidak menyentuh data runtime.
4. **Batas verifikasi yang jujur:** jalur jaringan penuh mode `fast` dengan adapter
   sungguhan tidak dijalankan (membutuhkan upstream live). Yang di-pin oleh
   `test/providers/probe-mode.test.ts` adalah kontraknya: default `detail`, override
   per-request, budget 32 token, timeout 10s, tanpa retry, telemetry suppression,
   prompt identik, bound sample 80 char, dan penerusan `mode` ke `test-models`.
   Implementasi ada di `probing-service.ts:254,445,542,629` — bukan stub.
