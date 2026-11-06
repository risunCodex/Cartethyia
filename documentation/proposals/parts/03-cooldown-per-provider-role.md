# Proposal — Cooldown per provider & role akun (free/pro/paid)

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** account health / cooldown (`src/providers/operations/`), routing (`src/transport/routing/`), schema (`src/persistence/schema.ts` + migrations), quota refresh (`src/providers/quota/refresh.ts`, `src/workers/quota-refresh-sweep.ts`), console API (`src/console/providers/catalog/contracts.ts`), dashboard (`dashboard/src/`), telemetry/health events.
**Method:** audit subagent tunggal; `codegraph_explore` + `Grep`/`Read` langsung. Semua klaim behavior mengacu pada kode (file:line). Baseline pass/fail diukur saat eksekusi (lihat §5).

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.3 (D14–D20) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Pipeline cooldown

1. Dispatch/probe gagal → `reportAttemptOutcome` (`src/providers/operations/account-health-service.ts:531-549`) → `recordAccountFailure` (`account-health-service.ts:62-288`).
2. `recordAccountFailure` memanggil `classifyAccountError(error, options?)` (`src/providers/operations/account-error-classification.ts:801-804`) — **murni** atas evidence error; tidak membaca baris akun.
3. `classifyAccountError` membangun `AccountErrorContext` (`account-error-classification.ts:552-584`) + `AccountErrorSignals` (`:607-638`) dan menjalankan tabel rule berurutan `ACCOUNT_ERROR_RULES` (`:1212+`). Rule pertama yang match memutuskan `{category, status, cooldownMs, retryAt, mutatesAccount}`.
4. Kembali ke writer: `recordAccountFailure` membaca baris akun (proyeksi, `account-health-service.ts:103-113`), lalu:
   - kategori throttle (`rate_limit_transient`, `model_capacity`, `model_unreachable`) + `modelId` → **model-scoped** cooldown (tulis `modelCooldowns[modelId]`, `:169-244`),
   - selain itu → **account-wide** (tulis `status` + `cooldownUntil`, `:246-268`).
5. `cooldownUntil`/`modelCooldowns` dibaca routing (`src/transport/routing/route-catalog.ts:317-330`, `:874+`) untuk mengecualikan kandidat; sweep `COOLDOWN_RECOVERY_BATCH` (`account-error-classification.ts:47`) memulihkan setelah deadline.

### 1.2 Durasi cooldown hari ini: konstanta + fallback, tidak ada dimensi role

Semua durasi adalah konstanta hardcoded di file classifier atau env fallback di `src/config/cooldowns.ts`:

| Konstanta | Nilai | Lokasi |
| --- | --- | --- |
| `TRAE_QUOTA_COOLDOWN_MS` | 24h | `account-error-classification.ts:73` |
| `TRAE_REGION_COOLDOWN_MS` | 24h | `account-error-classification.ts:67` |
| `GROK_QUOTA_COOLDOWN_MS` | 24h | `account-error-classification.ts:59` |
| `QODER_QUOTA_COOLDOWN_MS` | 24h | `account-error-classification.ts:79` |
| `MODEL_UNREACHABLE_COOLDOWN_MS` | 6h | `account-error-classification.ts:100` |
| `DEFAULT_QUOTA_COOLDOWN_MS` | 1h (env) | `account-error-classification.ts:39`; `src/config/spec.ts:235` |
| `DEFAULT_RATE_LIMIT_COOLDOWN_MS` | 15m (env) | `account-error-classification.ts:25`; `spec.ts:234` |
| `INCEPTION_RATE_LIMIT_COOLDOWN_MS` | 1m | `account-error-classification.ts:35` |
| `UNSUPPORTED_MODEL_COOLDOWN_MS` | 6h → 24h (ladder ×2, level ≤8) | `account-error-classification.ts:117-136` |
| `resolveAccountCooldownEscalationMaxMs` | 1h (env) | `src/config/cooldowns.ts:78-83`; `spec.ts:256` |

Rule provider-spesifik yang memakai konstanta di atas: `trae-quota-exhausted` (`:1482-1497`, code `4008`/“exceeded the quota” → `model_unreachable`), `trae-region-unavailable` (`:1452-1471`), `qoder-model-quota` (`:1504-1518`, code `110`/upstream-499), cabang `grokFreeTier` di `quota-exhausted` (`:1526-1550`), `qoder-plan-gated`/`model-plan-gated` (`:1411-1443`), `inception-per-minute-limit` (`:1573-1596`), `rate-limit` (`:1597+`).

**Tidak ada satu pun rule yang membaca role/tier/plan akun.** `AccountFailureEvidence` (`:220-262`) tidak membawa field plan/role; parameter classifier `options?: AccountFailureEvidence` tidak punya akses ke baris akun.

### 1.3 Interaksi eskalasi dengan durasi besar (temuan penting)

`escalateFallbackCooldown(cooldownMs, providerStated, consecutiveFailures)` (`account-error-classification.ts:337-345`):

```ts
if (providerStated || cooldownMs <= 0) return cooldownMs;
const level = Math.min(Math.max(0, consecutiveFailures), COOLDOWN_ESCALATION_MAX_LEVEL);
return Math.min(cooldownMs * 2 ** level, resolveAccountCooldownEscalationMaxMs());
```

Karena `Math.min(...)` berlaku untuk **semua** durasi non-provider-stated, konstanta 24h (Trae/Grok/Qoder) yang *tidak* disertai window dari upstream pada dasarnya dicegat di `resolveAccountCooldownEscalationMaxMs()` (default **1h**, `spec.ts:256`). Artinya maksud “full-day cooldown” hanya bertahan bila respons error membawa `resets_*`/`Retry-After` (diparse `account-error-classification.ts:513-549`, `providerStated` di `:749-755`). Ini perlu diverifikasi dengan evidence runtime sebelum dianggap bug — tetapi mekanika kodanya jelas: durasi kebijakan 24h dihabiskan oleh cap eskalasi 1h pada `streak = 0` (level 0 → `min(24h × 1, 1h) = 1h`).

### 1.4 Role akun: yang sudah ada

- **`provider_accounts.quota_plan` (`text`, nullable)** — `src/persistence/schema.ts:311`; migrasi `migrations/full-postgres/0018_add_accounts_quota_plan.sql` (+ lite). Diisi oleh `fetchProviderQuota` di `src/providers/quota/refresh.ts:405-414` (**hanya** saat `quota.plan !== null`; gagal fetch membiarkan nilai lama).
- Provider yang sudah melaporkan string plan: Trae (`plan_name`/`planName`/`user_type` di session usage, `ent_title`/`package_name` di entitlement — `src/providers/integrations/trae/trae-quota.ts:207-210`, `:226-238`, `:368`), Qoder (`userType` dari userinfo — `src/providers/integrations/qoder/qoder-oauth.ts:75-103`), Cursor (`planName`/`membershipType` — `cursor-quota.ts:197`), Codex (`plan_type` — `codex-quota.ts:45`), Cline (`displayName` — `cline-quota.ts:119-128`), Antigravity (`tier`/`plan` — `antigravity-quota.ts:290-340`), Buddy (`PackageName`/`SubProductName` — `buddy-quota-shared.ts:213`), zcode-start (nama plan di `src/providers/integrations/zcode-start-plan/quota.ts`).
- **Pemakaian plan saat ini hanya di routing, untuk plan-gate:** `ACCOUNT_COLUMNS` memasukkan `quotaPlan` (`route-catalog.ts:329`), kandidat membawa `account_plan` (`route-catalog.ts:854-856`), dan `planAllowsCandidate`/`isFreePlanAccount` (`src/transport/routing/plan-gate.ts:22-45`) menolak model `pro_only` pada akun yang plan-nya mengandung marker `"free"` (`FREE_PLAN_MARKERS`, `plan-gate.ts:20`). Default **permissive**: plan tidak dikenal ≠ free, tidak pernah mengecualikan (`plan-gate.ts:11-19`).
- Tidak ada kolom `role`/`tier`/`subscription`/`entitlement` terstruktur di schema (grep `role|tier` hanya menemukan `models.pro_only`/`models.free_tier` — `schema.ts:452`, `:461` — dan `FREE_TIER_REFUSAL` di `src/network/rate-limit-verdict.ts:30` untuk pool, bukan akun).

### 1.5 Catatan pelengkap

- Probe health memakai jalur yang sama (`recordProbeHealth` → `recordAccountFailure`, `src/providers/discovery/probe-phases.ts:700-756`) — perubahan signature harus tetap kompatibel di sini.
- Sweep quota yang gagal memarkir akun lewat `QUOTA_FAILURE_COOLDOWN_MS = 6h` (`src/providers/quota/refresh.ts:54`, dipakai `:202`) — jalur terpisah yang sama sekali tidak lewat classifier, dan tidak tier-aware.
- Dashboard menampilkan `plan` per akun (`dashboard/src/hooks/quota.ts:33`; format khusus zcode-start di `dashboard/src/lib/format/quota.ts:58-64`), tetapi tidak ada surface untuk mengedit role.
- `health_events` tidak menyimpan tier (`AccountHealthEventRecord`, `account-health-service.ts:26-35`).

### 1.6 Ringkasan temuan

| # | Temuan | Verdict | Behavior change? | Severity | Effort |
| --- | --- | --- | --- | --- | --- |
| F1 | Classifier cooldown buta role: `AccountFailureEvidence` tanpa field plan/role, `recordAccountFailure` tidak memproyeksikan `quotaPlan`. | tidak ada jalur role → konfirmasi | ya (perlu) | HIGH | S/M |
| F2 | Cap eskalasi (`Math.min` dengan `resolveAccountCooldownEscalationMaxMs`, default 1h) berlaku pada durasi kebijakan 24h non-provider-stated → berpotensi memendekkan Trae/Grok/Qoder 24h jadi 1h. | perlu verifikasi runtime | ya (jika dikonfirmasi) | HIGH | M |
| F3 | `quota_plan` ada dan terisi otomatis oleh refresh, tapi string mentah per-provider, tanpa normalisasi tier; `NULL` = tidak pernah terbaca. | reusable, perlukan normalisasi | sebagian | MED | M |
| F4 | Deteksi role hanya lewat string plan dari collector; tidak ada sumber kedua, tidak ada override manual; dashboard tidak punya kontrol. | gap | ya (perlu) | MED | M |
| F5 | Fallback role tidak dikenal ambigu: plan-gate routing memilih permissive (unknown = boleh), sedangkan kebijakan cooldown berbasis role sudah diputus eksplisit (aman = konservatif). | gap desain | ya | MED | S |
| F6 | `QUOTA_FAILURE_COOLDOWN_MS` (6h) jalur terpisah dari classifier; diputus **tidak** tier-aware (D20). | gap ditutup | tidak | LOW | M |

---

## 2. Masalah yang diminta diatasi

Requirement: logika penentuan cooldown (durasi & kelas) harus mempertimbangkan **role/tier akun** (free/pro/paid dll.) dan **aturan khusus per provider**.

Diterjemahkan ke masalah konkret pada perilaku sekarang:

1. **Tidak ada dimensi role.** Akun free Trae yang kena quota harian (code `4008`) dan akun paid Trae yang kena kesalahan yang sama menerima `cooldownMs` yang identik (`trae-quota-exhausted`, `account-error-classification.ts:1487`). Nilai 24h/1h/6h adalah konstanta global per provider, bukan fungsi (provider, role, kategori).
2. **“Kelas” cooldown juga tidak tier-aware.** Kelas saat ini hanya dua: model-scoped vs account-wide, ditentukan kategori (`account-health-service.ts:137-141`). Akun paid yang seharusnya tidak di-cooling sama sekali (atau hanya model-nya) tidak bisa dibedakan.
3. **Aturan per provider tersebar sebagai konstanta hardcoded** di dalam rule classifier, tidak dapat dikonfigurasi tanpa deploy, dan tidak punya konsep “role lebih tinggi → lebih pendek / tidak sama sekali”.
4. **Kesalahan deteksi role berdampak dua arah**: salah mengira paid sebagai free → parkir terlalu lama (kehilangan kapasitas); salah mengira free sebagai paid → memukul upstream berulang (reproduksi refusal).

---

## 3. Desain yang diusulkan

### 3.1 Prinsip

- **Provider-stated wins.** Window yang dinyatakan upstream (`retryAfterMs`/`resets_*`/`Retry-After`) tetap menang atas rule role (sekarang di `providerStated`, `account-error-classification.ts:749-755`). Role hanya mengganti *fallback* durasi, bukan kebenaran upstream.
- **Unknown → perilaku hari ini.** Role tidak dikenal (`NULL`/string tidak dikenal) ⟹ persis behavior sekarang. Tidak ada perubahan perilaku tanpa role yang terdeteksi/ter-set. Ini memenuhi aturan “default off” (`proposal.md`).
- **Monotonic guard dipertahankan.** `latestDeadlineMs` (`account-error-classification.ts:357-364`) dan `accountDeadlineMs` (`:382-387`) tetap dipakai: deadline hanya boleh bergerak lebih lambat.
- **Durasi kebijakan role tidak boleh dirusak cap eskalasi.** F2 diselesaikan dengan memisahkan “durasi kebijakan” (dari rule role/provider) dan “fallback murni” (env default): eskalasi ×2 hanya berlaku untuk fallback murni, bukan durasi yang sudah ditentukan rule role.

### 3.2 Model data

**Opsi A — dipilih (D15, tanpa migrasi):** jangan buat kolom baru; turunkan tier dari `quota_plan` yang sudah ada saat failure:

- Fungsi `mapPlanToTier(providerId: string, plan: string | null): AccountTier` — modul baru `src/providers/operations/account-tier.ts`.
- `AccountTier = "free" | "paid" | "pro" | null` (null = tidak dikenal). Mapping per provider atas string yang sudah terbukti dikirim collector (mis. Trae `"Free Plan Subscription"`-family → `free`; CodeBuddy `personal_free_user`-family → `free`; Cursor `membershipType` non-free → `paid`; Qoder `userType` non-`personal_standard` / org → `pro`). Pola marker `"free"` sudah ada di `plan-gate.ts:20` — pakai sebagai baseline, perluas per provider.
- SQL: tidak ada migrasi; `recordAccountFailure` cukup menambah `quotaPlan` ke proyeksi (`account-health-service.ts:103-113`) dan memanggil `mapPlanToTier` saat menulis.

**Opsi B — ditolak (D15):** kolom baru `provider_accounts.account_tier text` (nullable) + migrasi forward (pola `0018_add_accounts_quota_plan.sql`):

- Ditulis otomatis oleh refresh di samping `quotaPlan` (`refresh.ts:405-414`) lewat `mapPlanToTier`.
- Override manual via console API: `UpdateProviderAccountRequest` (`src/console/providers/catalog/contracts.ts:475-486`) menambah `tier?: AccountTier`; dashboard menambah kontrol di detail akun (badge tier + edit).
- Prioritas baca: `account_tier` (override) → turunan dari `quota_plan` → `null`.

Keputusan final (§6): kerjakan A dulu (perubahan kecil, aman, buktikan nilai), B tidak dikerjakan (D15). **Backfill**: tidak ada (D15).

### 3.3 Resolusi rule cooldown

Modul baru `src/providers/operations/cooldown-rules.ts`:

```ts
// shape (contoh, iterasi ini)
type CooldownRuleKey = { providerId: string; category: AccountErrorCategory; tier: AccountTier };
function resolveCooldownRule(key: CooldownRuleKey): number | undefined;
```

- **Static registry in-code (D19)** (objek `Record<providerId, Partial<Record<category, Record<tier, number>>>>`), default kosong (tidak ada yang berubah sampai rule diisi). Contoh pertama sesuai requirement: `trae` × `model_unreachable` (quota harian) × `free` → 24h; × `paid` → 0 (tidak di-cooling) atau durasi pendek; × `pro` → 0.
- Tabel `provider_cooldown_rules(provider_id, role, category, cooldown_ms)` **ditolak** (D19); rule tinggal di static registry in-code.
- Alur runtime: `classifyAccountError` menerima `accountTier?: AccountTier` di `AccountFailureEvidence`; di dalam `decide` rule yang relevan (`quota-exhausted`, `model_unreachable`, `rate_limit_transient` dll.), setelah `statedCooldownMs` gagal, urutannya: **rule (provider,kategori,tier) → konstanta provider lama → fallback env**. Urutan dieksekusi di `recordAccountFailure` bila lebih bersih: classifier menandai `ruleSource: "provider-rule" | "fallback"` dan writer baru memutuskan eskalasi.

### 3.4 Kelas cooldown per role

- `cooldownMs = 0` dari rule role ⟹ `mutatesAccount: false` untuk kategori yang biasanya mutate (contoh: paid Trae quota — akun tetap `active`, tidak ditulis `cooldownUntil`). Ini memakai mekanisme yang sudah ada (`mutatesAccount`, `account-error-classification.ts:763`; jalur non-mutating di `account-health-service.ts:84-96`).
- Model-scoped vs account-wide tetap ditentukan kategori; rule role boleh mengubah kategori untuk kasus spesifik (mis. free Trae → `model_unreachable` model-scoped 24h; paid → `rate_limit_transient` model-scoped pendek), tanpa mengubah ketentuan umum.

### 3.5 Dashboard/UI

- Badge tier di baris akun (`dashboard/src/features/provider-detail/sections/Accounts.tsx`) — reuse pola `AccountStatusBadge` (`AccountStatusBadge.tsx:120+`).
- Dropdown tier / PATCH `/accounts/:id` tidak dikerjakan (D15); tampilan read-only.

### 3.6 Observability

- `health_events` belum punya kolom tier; tanpa kolom baru; tulis tier di log `[health]` saat rule role aktif.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Klasifikasi & cooldown | `src/providers/operations/account-error-classification.ts` (evidence + rule + `result`), `src/config/cooldowns.ts` / `src/config/spec.ts` (hanya jika env baru untuk cap eskalasi per-rule) |
| Modul baru tier & rule | `src/providers/operations/account-tier.ts`, `src/providers/operations/cooldown-rules.ts` (baru) |
| Writer health | `src/providers/operations/account-health-service.ts` (proyeksi + `quotaPlan`, pemakaian tier, eskalasi hanya fallback murni) |
| Routing (baca plan) | `src/transport/routing/route-catalog.ts` (sudah membawa `account_plan` — tidak berubah, hanya jadi referensi mapping), `src/transport/routing/plan-gate.ts` (reuse `isFreePlanAccount`/marker) |
| Quota refresh | `src/providers/quota/refresh.ts` (tidak tersentuh, D15), `src/workers/quota-refresh-sweep.ts` (tidak tier-aware, D20) |
| Schema & migrasi | `src/persistence/schema.ts` (tidak ada kolom baru, D15), tidak ada migrasi (D15) |
| Console API | `src/console/providers/catalog/contracts.ts`, `src/console/providers/catalog/store.ts` (tidak tersentuh, D15) |
| Dashboard | `dashboard/src/features/provider-detail/sections/AccountStatusBadge.tsx`, `Accounts.tsx`, `AddAccountModal.tsx` (tidak tersentuh, D15) |
| Probe | `src/providers/discovery/probe-phases.ts` (panggil dengan tier dari baris akun — kompatibel via `recordAccountFailure`) |

---

## 5. Migrasi & risk

**Migrasi:** tidak ada (D15). Tidak ada kolom, tidak ada backfill, baseline tidak disentuh.

**Backward compatibility:**
- Role tidak dikenal ⟹ perilaku identik sekarang (guard utama).
- Provider-stated tetap menang; monotonic guards tetap; `routesVisible` semantics tetap.
- Jalur probe (`probe-phases.ts:700-756`) dan jalur non-mutating (`account-health-service.ts:84-96`) tidak berubah bentuk.

**Risk & mitigasi:**
- *Misklasifikasi tier* → rule yang salah. Mitigasi: default unknown; mapping eksplisit per provider; “free” hanya diklaim bila string membuktikan (sama dengan `plan-gate.ts`); paid→free salah arah tidak menggantung (konservatif), free→paid salah arah dibatasi `cooldownMs = 0` hanya untuk provider tertentu yang sudah diverifikasi.
- *F2 (cap eskalasi)*: diselesaikan dengan sumber durasi terpisah — rule role tidak masuk jalur `escalateFallbackCooldown`; tambah test yang membuktikan 24h bertahan untuk free Trae tanpa window upstream.
- *Perubahan perilaku yang meluas*: gated per (provider,kategori,tier); tanpa rule terisi, `resolveCooldownRule` mengembalikan `undefined` dan semuanya berjalan seperti sekarang.

**Test list (proof-of-design):**
- `test/providers/account-health-invalidation.test.ts` — kasus baru: Trae free quota 24h model-scoped; Trae paid quota → 0/tidak mutasi; unknown → perilaku lama.
- `test/providers/gateway-capacity-classification.test.ts`, `test/providers/inception-rate-limit-classification.test.ts`, `test/providers/qoder-model-plan-gated-classification.test.ts`, `test/providers/endpoint-quota.test.ts` (Trae) — regresi rule per provider.
- Unit baru `test/providers/account-tier.test.ts` — `mapPlanToTier` per provider; `cooldown-rules.test.ts` — presedensi stated > rule > fallback.
- Test eskalasi: durasi rule role tidak di-double dan tidak dicap 1h.
- Test PATCH tier / dashboard badge tidak dikerjakan (D15).

**Baseline verification (diukur saat eksekusi, tidak di-fabricate di audit ini):** `bunx tsc --noEmit`; `bun run test:backend` (`bun run scripts/test/run.ts --scope backend`); `bun test test/protocol`. Suite yang relevan untuk perbandingan per-finding: `account-health-invalidation` (F1/F2), `gateway-capacity-classification`, `inception-rate-limit-classification`, `qoder-model-plan-gated-classification`, `endpoint-quota` (F3), `plan-gate`/routing tests (F4/F5). Hitungan pass/fail baseline harus dicatat sebelum perubahan dan dibandingkan di `## Execution status`.

---

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.3 (D14–D20). Tidak ada yang menunggu jawaban.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D14 | Taksonomi `free \| paid \| pro \| null`. | `trial` masuk `paid` dengan durasi khusus. |
| D15 | **Opsi A saja, lengkap**: tier selalu turunan `quota_plan`; **tidak ada** kolom `account_tier`, **tidak ada** override manual. | Audit awal menawarkan lanjutan; ditolak tuntas. Tidak ada migrasi kedua. |
| D16 | Scope: `quota_exhausted`, `model_unreachable`, `rate_limit_transient`. | `model_unreachable` di sini (Trae `4008`), bukan di area 01 (R-C). |
| D17 | `paid` → **15m**, bukan `0`. | `0` = hammering bila verdict keliru. |
| D18 | Cap eskalasi dipecah: durasi rule role/provider **tidak** lewat `escalateFallbackCooldown`; fallback murni tetap cap 1h. | Memperbaiki F2 tanpa env baru. |
| D19 | Static registry in-code `cooldown-rules.ts`; tanpa tabel DB. | Default kosong = nol perubahan. |
| D20 | `QUOTA_FAILURE_COOLDOWN_MS` (6h) **tidak** tier-aware. | Batas eksplisit, bukan iterasi berikutnya. |

Semua penanda lama di §1–§5 dibaca melalui tabel ini: **Opsi B, tabel rule, kolom
`account_tier`, override operator, backfill, dan badge/edit tier tidak
dikerjakan** (batas eksplisit di master §3.6). File di §4 yang ditandai "tidak tersentuh"
(`refresh.ts`, `quota-refresh-sweep.ts`, schema, migrations, console PATCH tier,
`AddAccountModal.tsx`) memang **tidak tersentuh** untuk area 03. Bagian §5 "Migrasi"
kini berbunyi: **tidak ada migrasi** untuk area ini.

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C1.

| Finding | Status | Bukti |
| --- | --- | --- |
| F1 (classifier buta role) | ✅ | `src/providers/operations/account-tier.ts`, `cooldown-rules.ts`; `AccountFailureEvidence.accountTier`; proyeksi `quotaPlan` di writer; `account-tier.test.ts`, `cooldown-rules.test.ts`. |
| F2 (cap eskalasi 1h memendekkan 24h) | ✅ | `applyRuleEscalation` (D18): durasi rule tidak lewat `escalateFallbackCooldown`; test mengunci Trae free 24h tanpa window upstream + recovery window tidak dicap. |
| F3 (`quota_plan` tanpa normalisasi) | ✅ | `mapPlanToTier` per provider; unknown → `null` → perilaku lama. |
| F4 (tidak ada sumber kedua / override manual) | ⛔ | **Sengaja tidak dikerjakan (D15)**: kolom `account_tier`, override operator, dan UI edit ditolak tuntas; batas eksplisit master §3.6. Bukan item yang tertunda. |
| F5 (fallback role tidak dikenal ambigu) | ✅ | Unknown = persis perilaku sekarang (guard utama), di-pin test. |
| F6 (`QUOTA_FAILURE_COOLDOWN_MS` 6h terpisah) | ⛔ | **Sengaja tidak tier-aware (D20)** — jalur sweep quota di luar scope iterasi ini; batas eksplisit, bukan iterasi berikutnya. |

Keputusan D14–D20 diterapkan; dua ⛔ di atas adalah batas yang disetujui, bukan kegagalan.

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
