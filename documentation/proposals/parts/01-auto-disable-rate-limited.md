# Proposal — Settings toggle: auto-disable akun rate-limited (429/quota-exhausted)

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** account health / cooldown (`src/providers/operations/`), console settings API (`src/console/settings/`, `src/persistence/schema.ts`), dashboard (`dashboard/src/features/settings/`, `dashboard/src/hooks/settings.ts`), routing exclusion (dibaca, tidak diubah — `src/transport/routing/`), recovery sweep (`account-health-service.ts` — Opsi B + marker (D03)).
**Method:** audit subagent tunggal; `codegraph_explore` + `Read`/`Grep` langsung. Semua klaim behavior mengacu pada kode (file:line). Baseline pass/fail diukur saat eksekusi (lihat §5).

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.1 (D01–D06) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Pipeline klasifikasi 429 / quota

1. Dispatch/probe gagal → `reportAttemptOutcome` (`src/providers/operations/account-health-service.ts:531-549`) → `recordAccountFailure` (`account-health-service.ts:62-288`).
2. `recordAccountFailure` memanggil `classifyAccountError(error, options?)` (`src/providers/operations/account-error-classification.ts:801-804`). Tabel rule berurutan `ACCOUNT_ERROR_RULES` (`:1212+`); rule pertama yang match memutuskan `{category, status, cooldownMs, retryAt, mutatesAccount}`.
3. Kategori yang relevan untuk requirement ini:
   - `quota_exhausted` — dihasilkan rule `quota-exhausted` (`account-error-classification.ts:1520-1564`, category `:177`), `trae-region-unavailable` (`:1452-1471`), `price-refusal` (`:1399-1403`).
   - `rate_limit_transient` — dihasilkan rule `rate-limit` (`:1598-1624`) dan `inception-per-minute-limit` (`:1573-1596`).
   - Turunan quota per-model: `model_unreachable` (Trae `4008` via `trae-quota-exhausted`, `:1482-1497`; Qoder `110`/upstream-499, `:1504-1518`, `:1699-1715`).

### 1.2 Tidak ada satu pun rule quota/rate-limit yang menghasilkan `disabled`

`AccountErrorClassification.status` hanya dua nilai: `"cooldown" | "disabled"` (`account-error-classification.ts:266`). Status `disabled` saat ini hanya dihasilkan oleh:
- `validation-required` (`:1270-1285`, `validation_required`, `mutatesAccount: true`),
- `github-copilot-not-licensed` (`:1296-1312`, `policy_blocked_banned`),
- `credential-rejected` hanya saat *named revocation* (`:1369-1395`, `auth_invalidated`, `recoverable === false`).

Semua rule quota/rate-limit memutuskan `"cooldown"` dengan `mutatesAccount` = `origin === "upstream"` (untuk `quota-exhausted` `:1561`, `rate-limit` `:1621`, `inception-per-minute-limit` `:1593`). **Tidak ada mekanisme yang mengubah 429/quota menjadi disable hari ini.**

### 1.3 Writer: model-scoped vs account-wide

`recordAccountFailure` (`account-health-service.ts:98-288`):
- Early exit: `if (!account || account.status === "disabled") return null;` (`:118`) — akun yang sudah disabled tidak disentuh.
- `isThrottle` = `rate_limit_transient | model_capacity | model_unreachable` (`:137-140`); bila `modelId !== undefined` → **model-scoped** (tulis `modelCooldowns[modelId]`, `:169-244`, status akun tidak bergerak).
- Selain itu → **account-wide**: tulis `status: effective.status` + `cooldownUntil: accountDeadlineMs([...])` (`:246-268`).
- Konsekuensi penting: **429/quota yang datang dengan `modelId` menjadi cooldown per-model, bukan status akun.** Auto-disable "seluruh akun" harus memutus jalur ini (lihat §3.4, D02).
- `mutatesAccount === false` → hanya menulis health event, akun tidak bergerak (`:84-96`; `:84-94` menulis `fromStatus === toStatus`).

### 1.4 Mesin recovery: disabled tidak pernah di-sweep

- Sweep `sweepExpiredCooldowns` (`account-health-service.ts:406-484`) memilih **hanya** `status === "cooldown"` DAN `cooldownUntil <= now` (`:416-423`). Baris `disabled` tidak pernah dipilih; `COOLDOWN_RECOVERY_BATCH = 500` (`account-error-classification.ts:47`); interval 30s (`src/boot/dependencies.ts:353,372`).
- Test `test/providers/disabled-recovery-sweep.test.ts` mem-pin perilaku ini: "an automatic disable is never re-enabled by the sweep" (`:114-125`), "an operator disable — no deadline — is never swept" (`:127-138`), "an automatic disable whose deadline has not arrived stays parked" (`:140-149`), "a plain cooldown is still recovered exactly as before" (`:151-168`).
- **Ketidaksesuaian dokumentasi:** komentar di `credential-rejected` masih mengklaim "`sweepExpiredCooldowns` recovers a disabled row only when its `cooldownUntil` has elapsed" (`account-error-classification.ts:1371-1375`), padahal kode sweep tidak pernah memulihkan `disabled` (commit `c15dabb3` "fix(providers): never re-enable disabled accounts from the sweep"). `oauth-refresh-service.ts` `disableAccount` (`:244-288`) tetap menulis `cooldownUntil = now + resolveAccountDisabledRecoveryMs()` (`:281-283`) untuk auto-disable-nya — deadline yang tidak pernah dibaca sweep (harus dijelaskan agar desain §3.5 tidak mengandalkan komentar basi ini).
- Env `CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS` default 24h (86_400_000), min 0, max 7d (`src/config/spec.ts:272`); dibaca `resolveAccountDisabledRecoveryMs()` (`src/config/cooldowns.ts:156-161`).
- Recovery operator: `recoverAccount` (`account-health-service.ts:353-403`) — paksa `active`, bersihkan `modelCooldowns`/`lastError*`. API: PATCH `/accounts/:id` (`src/console/quota/account-quota-tenant.ts:738-786`), batch `:787-821`, global (`src/console/quota/account-quota-global.ts:50-100`). Semua hanya men-set `status` (tidak membersihkan `cooldownUntil` lama).

### 1.5 Routing: disabled dikeluarkan sejak pembacaan snapshot

- `RouteCatalogRepository.loadRouteCatalogSnapshot` men-`SELECT` akun dengan `.where(ne(providerAccounts.status, "disabled"))` (`src/transport/routing/route-catalog.ts:428`) — **akun disabled tidak pernah menjadi kandidat**; tidak perlu perubahan routing untuk mengecualikan.
- Stamping kesehatan kandidat: `status === "cooldown"` → `health_status: "cooldown"` + `cooldown_kind` hard/soft via `HARD_COOLDOWN_CATEGORIES = {quota_exhausted, policy_blocked, auth_invalidated}` (`route-catalog.ts:87-95`, `:874-923`); per-model → `model_cooldown` (`:940-945`).
- `EligibilityEvaluator.evaluate` (`src/transport/routing/router.ts:277-301`): `disabled` → tidak eligible; `model_cooldown` → tidak eligible; `cooldown` hard → tidak eligible; `cooldown` soft → eligible (deprioritasi).
- **Preceden penting:** `forceDisableCooldown` — preferensi runtime yang dibaca pada request path via snapshot (`route-catalog.ts:458-474`, `:890-893`), disimpan di `console_settings.preferences` JSONB, default off, diekspos di dashboard Operations panel (`dashboard/src/features/settings/SettingsPage.tsx:455-492`). Ini pola persis untuk toggle baru.

### 1.6 Infrastruktur settings (reuse penuh)

- Schema: `console_settings.preferences` JSONB `$type<ConsoleSettingsPreferences>()` (`src/persistence/schema.ts:1293-1297`); interface `ConsoleSettingsPreferences` (`:1190-1291`) — berisi `forceDisableCooldown?: boolean` (`:1242`), `invokeDisabled?: boolean` (`:1251`).
- Kontrak: `RuntimeSettingsResponse` (`src/console/settings/contracts.ts:15-73`); `UpdateRuntimeSettingsRequest = ConsoleSettingsPreferences` (`:94`); validasi ops `createRuntimeSettingsOperations` (`:142-227`); body schema `runtimeUpdateBody` (`:235-275`) — **komentar `:246-259` memperingatkan** bahwa field yang tidak terdaftar di `runtimeUpdateBody` di-drop diam-diam (bug historis).
- Store: `mapRuntimeSettingsRow` (`src/console/settings/store.ts:135-182`); `DrizzleRuntimeSettingsStore.update` membangun `patchPrefs` per field dan `mergeJson` (`:199-249`); `bumpSettingsRevision()` (`:247`).
- Routes: GET/PATCH `/settings/runtime` (`src/console/settings/routes.ts:10-29`).
- Dashboard: `useRuntimeSettings`/`useUpdateRuntimeSettings` (`dashboard/src/hooks/settings.ts:14-38`); `RuntimeSettingsResponse` diimpor dari backend (`dashboard/src/data/contracts.ts:165-168`); `OperationalPanel` (`SettingsPage.tsx:424+`) memakai `<Select>` off/on + `<Banner>` warning (`:455-492`) — pola toggle + banner siap ditiru.

### 1.7 Jalur parkir terpisah (di luar scope)

`recordAccountCheck` (`src/providers/quota/refresh.ts:148-206`) memarkir akun ke `cooldown` 6h setelah `QUOTA_FAILURE_PARK_THRESHOLD = 3` kegagalan beruntun (`:52`, `:197-205`) — terpisah dari classifier; tidak termasuk scope proposal ini (tulis sebagai catatan).

### 1.8 Ringkasan temuan

| # | Temuan | Verdict | Behavior change? | Severity | Effort |
| --- | --- | --- | --- | --- | --- |
| F1 | Tidak ada rule quota/rate-limit yang menghasilkan `disabled`; `disabled` hanya dari auth/ban/validation (`account-error-classification.ts:1520-1624` vs `:1270-1395`). | konfirmasi | ya (fitur baru) | HIGH | S |
| F2 | 429/quota dengan `modelId` menjadi model-scoped cooldown, bukan status akun (`account-health-service.ts:137-141,169-244`) — auto-disable akun penuh harus memutus jalur ini. | konfirmasi | ya (jika 429 harus disable akun) | HIGH | S/M |
| F3 | Sweep tidak pernah memulihkan `disabled` (`account-health-service.ts:416-423`; `disabled-recovery-sweep.test.ts:114-168`); komentar `account-error-classification.ts:1371-1375` basi. Auto-disable baru sudah diputus recovery eksplisit. | konfirmasi | Opsi B + marker (D03) | MED | M |
| F4 | Infrastruktur settings lengkap (JSONB preferences, kontrak, store, routes, dashboard) dengan preceden toggle `forceDisableCooldown` — reuse tanpa migrasi. | reusable | tidak | — | S |
| F5 | Routing sudah mengecualikan `disabled` sejak SELECT snapshot (`route-catalog.ts:428`) — tidak ada perubahan routing yang diperlukan. | reusable | tidak | — | S |
| F6 | `recordAccountFailure` tidak punya akses tenant/settings (proyeksi `:103-113` tanpa `tenantId`); request-path read settings hanya lewat snapshot, sedangkan health writer di luar snapshot. | gap | ya (perlu akses toggle) | MED | S/M |

---

## 2. Masalah yang diminta diatasi

Requirement: pengaturan baru di **Settings** — "auto disable rate limited accounts" — saat aktif, akun yang kena rate limit (429/quota-exhausted) harus otomatis di-`disable` (bukan sekadar cooldown) sesuai aturan.

Diterjemahkan ke masalah konkret pada perilaku sekarang:

1. **Tidak ada cara mengubah 429/quota menjadi disable.** Setiap verdict quota/rate-limit memutuskan `cooldown` (`F1`); akun yang quota-nya habis / kena 429 terus kembali ke rotasi setiap kali window lewat, membakar retry sibling account (`policy_blocked_banned` mencatat alasan yang sama untuk ban: `account-error-classification.ts:188-195`).
2. **Model-scoped throttle mengalahkan maksud "disable akun".** Karena 429 hampir selalu membawa `modelId`, cooldown per-model adalah outcome default (`F2`) — toggle yang hanya mengubah status account-wide hampir tidak akan pernah menembak.
3. **Tidak ada mekanisme recovery untuk auto-disable baru** yang bisa dibedakan dari operator disable (`F3`): sweep hari ini tidak memulihkan `disabled` apa pun; menulis `disabled` tanpa deadline = parkir permanen.
4. **Belum ada surface settings** untuk perilaku ini; menambah toggle harus lewat jalur `console_settings.preferences` yang sudah ada (`F4`).

---

## 3. Desain yang diusulkan

### 3.1 Prinsip

- **Default off (opt-in)** — `proposal.md` "Default off": tanpa toggle aktif, perilaku identik hari ini.
- **Hanya verdict upstream yang meng-disable.** Intercept hanya berlaku saat `classification.mutatesAccount === true` dan `origin === "upstream"` (semantic `mutatesAccount` di `account-error-classification.ts:763`); kegagalan lokal/network tidak pernah men-disable.
- **Fail-safe:** gagal membaca preferensi ⟹ dianggap off (tidak pernah men-disable karena error baca).
- **Provider-stated tetap tercatat** — window `retryAfterMs`/`resets_*` tetap ditulis ke `cooldownUntil`/reason; toggle hanya mengganti *outcome status*, bukan memutar window.
- **Preceden reuse:** pola preventif `forceDisableCooldown` (`SettingsPage.tsx:455-492`, `route-catalog.ts:458-474`) — toggle di Operations panel, default off, banner warning, baca via cache/version.

### 3.2 Model data (tanpa migrasi)

- Tambah preferensi JSONB baru di `ConsoleSettingsPreferences` (`src/persistence/schema.ts:1190+`) dan mirror-nya:
  - `autoDisableRateLimited?: boolean;` — default absent/false.
- `RuntimeSettingsResponse` (`src/console/settings/contracts.ts:15-73`): `readonly autoDisableRateLimited: boolean;` (normalisasi `=== true`).
- `runtimeUpdateBody` (`contracts.ts:235-275`): `autoDisableRateLimited: t.Optional(t.Boolean())` — wajib, mengikuti komentar `:246-259`.
- `DrizzleRuntimeSettingsStore.update` (`store.ts:199-249`): `if (patch.autoDisableRateLimited !== undefined) patchPrefs.autoDisableRateLimited = patch.autoDisableRateLimited === true;`.
- **Tidak ada kolom/tabel baru; tidak ada migrasi.**

### 3.3 Alur runtime (fail-safe, dengan guard)

Di `recordAccountFailure` (`account-health-service.ts:62-288`), **setelah** klasifikasi dan **sebelum** percabangan model-scoped/account-wide:

```
1. Proyeksi akun ditambah tenantId (account-health-service.ts:103-113).
2. Resolve toggle: `autoDisableRateLimitedEnabled(db, tenantId)` → boolean
   (baca langsung dari `console_settings`, tanpa cache in-process — keputusan
   eksekusi: `bumpSettingsRevision()` hanya in-process, sedangkan gateway bisa
   multi-process via SO_REUSEPORT, jadi cache per-tenant berisiko membuat toggle
   yang diubah lewat proses A tidak terbaca proses B; gagal baca → false).
3. Intercept hanya jika SEMUA benar:
   - toggle === true
   - classification.mutatesAccount === true
   - classification.origin === "upstream"
   - classification.category ∈ { "quota_exhausted", "rate_limit_transient" }   (set D01)
   - classification.status === "cooldown"   (status "disabled" dari rule lain tidak disentuh)
   Maka rewrite: effectiveStatus = "disabled"; cooldownMs = resolveAccountDisabledRecoveryMs();
   retryAt = now + cooldownMs (atau null jika recovery=0).
4. Jalur account-wide menulis status "disabled" + cooldownUntil (accountDeadlineMs, :262-266);
   health event toStatus="disabled" dengan reason asli classifier; routesVisible=true → snapshot invalidate.
```

- **Guard model-scoped (D02):** jika toggle aktif dan kategori ∈ set target, percabangan `shouldModelCooldown` (`:137-141`) **dilewati** untuk kategori tersebut — outcome disable harus account-wide, tidak boleh tenggelam jadi `modelCooldowns`. (Opsi B ditolak — D02 berlaku pasti.)
- **Fallback:** semua error tulis dibungkus `withTransaction` (`:46-59`) yang sudah mengembalikan fallback; health tidak pernah gagal request.

### 3.4 Interaksi dengan cooldown existing

- Untuk outcome yang di-intercept, cooldown *diganti* disable (requirement: "bukan sekadar cooldown"); cooldown tetap direkam sebagai `cooldownUntil` untuk kepentingan recovery (D03) dan reason/lastErrorCategory tetap kategori classifier (badge dashboard menampilkan alasan yang benar — `AccountStatusBadge.tsx:132-151`).
- Kategori di luar set (`model_capacity`, `server_error`, `timeout`, `auth_invalidated`, `policy_blocked_banned`, `model_unreachable`) tidak tersentuh.
- Static token (`:124-126`), provider-stated, eskalasi fallback (`escalateFallbackCooldown`, `account-error-classification.ts:337-345`) tetap berjalan seperti sekarang.
- `recordAccountSuccess` (`:291-350`) tetap memulihkan ke `active` — **konsekuensi perlu diputuskan**: sukses setelah auto-disable akan menimpa `disabled` menjadi `active` (karena `recordAccountSuccess` tidak mengecek asal disabled). Ini sebenarnya perilaku yang diinginkan (akun terbukti sehat), tetapi berlawanan dengan "operator disable tidak boleh di-override otomatis". Guard: hanya izinkan `recordAccountSuccess` memulihkan bila `lastErrorCategory ∈ set target` (auto-disable) — operator disable (category null atau di luar set) tetap terminal.

### 3.5 Recovery (Opsi A vs B — sudah diputus, lihat D03)

- **Opsi A — ditolak (D03).** Auto-disable menulis `status="disabled"` tanpa deadline (atau deadline yang tidak dibaca). Konsisten dengan invarian `disabled-recovery-sweep.test.ts`; operator memulihkan via `recoverAccount`/PATCH yang sudah ada. Risiko: akun 429 yang sebenarnya pulih cepat menganggur sampai operator bertindak.
- **Opsi B — sweep memulihkan auto-disable setelah deadline (rekomendasi).** Perluas predikat `sweepExpiredCooldowns` (`account-health-service.ts:416-423`): selain `cooldown`, sertakan `disabled` yang `lastErrorCategory ∈ set target` DAN `last_error LIKE 'auto-disable (rate-limited): %'` DAN `cooldownUntil <= now`; `status="disabled"` dengan category di luar set (operator, `auth_invalidated`, ban) tetap tidak tersentuh. Update test `disabled-recovery-sweep.test.ts` (tambah kasus kategori quota; kasus existing `auth_invalidated` tetap hijau). Ini menghidupkan kembali maksud `oauth-refresh-service.ts:275-283` (deadline auto-disable pernah dimaksudkan untuk dibaca sweep) untuk kategori yang aman saja.
- Toggle off **tidak** membatalkan disable yang sudah terjadi; mencegah disable baru. (Rekoveri berjalan sesuai window.)

### 3.6 Dashboard/UI

- `OperationalPanel` (`SettingsPage.tsx:424+`): group baru **Account health** (atau di bawah group Routing), satu `SettingsRow` toggle `autoDisableRateLimited` (pola `:455-492`):
  - label: "Auto-disable rate-limited accounts"
  - hint: jelaskan cakupan (429/quota-exhausted upstream), default off, dan hubungan dengan recovery.
  - banner warning saat on: akun akan di-disable (keluar rotasi) hingga pulih/operator recovery; per-model cooldown tetap berlaku untuk kategori non-target.
- Tidak ada perubahan kontrak dashboard (`data/contracts.ts:165-168` meng-import tipe backend — field menyebar otomatis).

### 3.7 Observability

- Health event `toStatus="disabled"` + `errorCategory` classifier + reason asli (`account-health-service.ts:271-281`) sudah memadai; tambahkan prefiks reason `"auto-disable (rate-limited): "` agar audit dapat dibedakan dari operator disable.
- Log `[health]` saat intercept terjadi (category, tenantId, accountId) — tanpa kolom baru.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Klasifikasi | `src/providers/operations/account-error-classification.ts` (set kategori target — konstanta ekspor baru; `AccountErrorClassification` tidak berubah bentuk) |
| Writer health + toggle | `src/providers/operations/account-health-service.ts` (proyeksi + `tenantId`, resolver toggle, intercept, rewrite status, sweep Opsi B (D03); guard `recordAccountSuccess` dihapus (D05)) |
| Resolver preferensi baru | `src/providers/operations/account-health-service.ts` (`autoDisableRateLimitedEnabled` — baca `console_settings.preferences.autoDisableRateLimited` langsung per tenant, fail-safe off, tanpa cache; lihat koreksi §3.3) |
| Schema | `src/persistence/schema.ts` (`ConsoleSettingsPreferences.autoDisableRateLimited`) |
| Console settings API | `src/console/settings/contracts.ts` (response + `runtimeUpdateBody` + validasi ops), `src/console/settings/store.ts` (map + patch) |
| Dashboard | `dashboard/src/features/settings/SettingsPage.tsx` (OperationalPanel: toggle + banner) |
| Boot (Opsi B, D03) | `src/boot/dependencies.ts` (tidak berubah — sweep sudah terdaftar 30s) |
| Test backend | `test/providers/auto-disable-rate-limited.test.ts` (baru), `test/providers/disabled-recovery-sweep.test.ts` (D03), `test/console/runtime-settings-operations.test.ts`, `test/providers/inception-rate-limit-classification.test.ts`, `test/providers/gateway-capacity-classification.test.ts` (regresi: kategori non-target tidak berubah) |
| Test dashboard | `dashboard/test/features/settings-sections.test.tsx` (toggle render + mutasi) |
| Dokumentasi | halaman `documentation/features/` yang meng-own account health/settings (perbarui bila ada) |

---

## 5. Migrasi & risk

**Migrasi:** tidak ada (preferensi JSONB). Dengan Opsi B (D03), tidak ada perubahan schema — hanya predikat SQL sweep. **Tidak menulis ulang baseline; pinned migration history tetap.**

**Backward compatibility:**
- Default off ⟹ nol perubahan perilaku tanpa toggle diaktifkan.
- Hanya kategori `quota_exhausted`/`rate_limit_transient` + `origin=upstream` + `mutatesAccount` yang bisa terkena; semua jalur lain identik.
- `recordAccountSuccess` guard (3.4) menjaga operator disable tetap terminal.

**Risk & mitigasi:**
- *F2 — 429 dengan modelId:* tanpa bypass `shouldModelCooldown`, toggle hampir tidak pernah menembak (D02). Bypass penuh berisiko men-disable akun yang hanya kena limit per-model 1 menit (Inception, `account-error-classification.ts:35,1573-1596`) — lihat D04.
- *Penumpukan disable permanen (Opsi A, ditolak):* akun 429 yang pulih cepat menganggur sampai operator bertindak; D03 mengurangi risiko ini via window recovery default 24h (`spec.ts:272`).
- *Akun shared/global (`tenant_id NULL`):* console_settings keyed per tenant; ikuti preceden `anyTenantOverrides` (`route-catalog.ts:474`) — tenant mana pun yang menyalakan toggle berlaku untuk akun shared (D06).
- *Race dengan `quota_plan`/refresh:* jalur `recordAccountCheck` (`refresh.ts:197-205`) tidak ikut auto-disable; tidak ada interaksi tulis yang bertabrakan (sweep quota menulis `status` hanya saat `active`, `refresh.ts:153-156`).

**Test list (proof-of-design):**
- `test/providers/auto-disable-rate-limited.test.ts` (baru): toggle off → 429/quota tetap cooldown (regresi); toggle on → `quota_exhausted` upstream → `status="disabled"` + `cooldownUntil` + health event + routesVisible; origin lokal/network tidak men-disable; `mutatesAccount=false` tidak men-disable; kategori non-target tidak tersentuh; baca preferensi gagal → off; `recordAccountSuccess` setelah auto-disable → active (guard kategori).
- `test/providers/disabled-recovery-sweep.test.ts` (D03): disabled kategori quota + deadline lewat → pulih; disabled `auth_invalidated`/operator tidak pulih (kasus existing tetap).
- `test/console/runtime-settings-operations.test.ts`: PATCH `autoDisableRateLimited` persist + normalize + tidak valid body (schema `runtimeUpdateBody`).
- `dashboard/test/features/settings-sections.test.tsx`: toggle render, off default, mutasi memanggil PATCH.
- Regresi classification: `inception-rate-limit-classification.test.ts`, `gateway-capacity-classification.test.ts`, `qoder-model-plan-gated-classification.test.ts`, `account-health-invalidation.test.ts`.

**Baseline verification (diukur saat eksekusi, tidak di-fabricate di audit ini):**
`bunx tsc --noEmit`; `bun run test:backend` (`bun run scripts/test/run.ts --scope backend`); `bun test test/protocol`; dashboard typecheck + `bun run test:backend` scope dashboard (`bun run scripts/test/run.ts --scope dashboard`). Hitungan pass/fail baseline dicatat sebelum perubahan dan dibandingkan di `## Execution status`. Suite pembanding per-finding: `disabled-recovery-sweep` (F3), `runtime-settings-operations` (F4), `inception-rate-limit-classification`/`gateway-capacity-classification` (F1/F2), `settings-sections` (dashboard).

---

## 6. Keputusan final (closed)

Bagian ini **bukan** daftar pertanyaan. Seluruh keputusan area 01 sudah dikunci di
`../provider-account-model-update.md` §6.1 (D01–D06), yang merupakan source of truth
keputusan. Tidak ada item yang menunggu jawaban.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D01 | Target = `{quota_exhausted, rate_limit_transient}` — `model_unreachable` **tidak** termasuk. | Milik area 03; lihat R-C di master. |
| D02 | Bypass `shouldModelCooldown` untuk kategori target (Opsi A). | Tanpa bypass toggle nyaris tidak menembak. |
| D03 | Recovery = **Opsi B**, dengan predikat wajib `last_error_category ∈ target` **DAN** `last_error LIKE 'auto-disable (rate-limited): %'` **DAN** `cooldown_until <= now`. | Marker mencegah sweep mengaktifkan ulang akun hasil aksi 02 (R-B). |
| D04 | 429 dengan `providerStated && statedCooldownMs < 5 menit` **tidak** di-disable; biarkan cooldown 1m (Inception). | Mengganti rekomendasi audit awal. |
| D05 | Guard `recordAccountSuccess` **tidak** ditambahkan. | Dead code: `:312` early-return + `route-catalog.ts:428` exclude (R-A). |
| D06 | Akun shared: `anyTenantOverrides` — toggle tenant mana pun berlaku, didokumentasikan di hint UI. | `route-catalog.ts:474`. |

Semua penanda lama di §1–§5 sudah ditimpa oleh tabel ini dan bukan pilihan terbuka. Koreksi
terkait: §3.4 guard `recordAccountSuccess` dihapus (D05), §3.5 memakai Opsi B + marker
(D03), §4 tabel file sweep Opsi B kini wajib, §5 predikat SQL sweep
kini berlaku pasti.

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C1 + C2 + C6.

| Finding | Status | Bukti |
| --- | --- | --- |
| F1 (tidak ada rule quota → disabled) | ✅ | `autoDisableRateLimitedEnabled` + intercept di `account-health-service.ts`; `test/providers/auto-disable-rate-limited.test.ts` (toggle off → perilaku lama, on → `status="disabled"`). |
| F2 (model-scoped throttle mengalahkan disable akun) | ✅ | Bypass `shouldModelCooldown` untuk kategori target (D02); test `modelId` tetap disable akun. |
| F3 (sweep tidak pernah memulihkan disabled) | ✅ | `sweepExpiredCooldowns` diperluas dengan marker `auto-disable (rate-limited): %` (D03/R-B); `disabled-recovery-sweep.test.ts` — quota+marker pulih, operator disable tetap terminal. |
| F4 (infrastruktur settings) | ✅ | C2: `autoDisableRateLimited` di `ConsoleSettingsPreferences`, `RuntimeSettingsResponse`, `runtimeUpdateBody`, store; C6: toggle + banner di `SettingsPage.tsx` (`auto-disable-rate-limited-setting.test.tsx`). |
| F5 (routing sudah mengecualikan disabled) | ✅ | Dibaca, tidak diubah — `route-catalog.ts:428` tetap. |
| F6 (writer tidak punya akses tenant/settings) | ✅ | Proyeksi tambah `tenantId`; resolver fail-safe membaca `console_settings` langsung (tanpa cache in-process, lihat deviasi master §7). |

Keputusan D01–D06 diterapkan seluruhnya. Tidak ada yang dilewati.

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
