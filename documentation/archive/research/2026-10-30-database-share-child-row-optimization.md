# Proposal: One-Time Row-Data Optimization for Share Children (less bloat metadata)

> Status: **diimplementasikan** — migration `0029`, write-path slim, post-restore
> normalization, dan test regresi ikut dalam change yang sama.
> Target: mengurangi footprint row data `api_keys` (khususnya child share yang
> menduplikasi policy template) lewat **satu migration otomatis saat boot** +
> perubahan write path. Backward compatibility hanya perlu dijaga untuk alur
> **backup/restore**.
>
> Revisi 2 — hasil audit penuh layer persistence & console (bukan verifikasi
> parsial). Perubahan vs revisi 1: koreksi `model_access_mode` NOT NULL,
> pencatatan `AUTH_KEY_COLUMNS` SQLite, koreksi daftar kolom nullable, dan
> penegasan `scopes` harus tetap dipertahankan.

---

## 1. Ringkasan

`api_keys` adalah tabel paling bengkak di deployment. Satu template share bisa
memiliki ratusan ribu child; **setiap child menyalin kolom policy dari
template-nya**. Perilaku auth **tidak pernah membaca kolom itu dari child** —
child selalu resolve ke parent (`api-key-auth.ts:353–390`). Artinya duplikasi
itu murni write-amplification + pembengkakan storage/backup.

Bukti volume: satu tenant memiliki **331.723 child** (semua dari 2 IP, 3
hari, lihat `share-store.ts:493–498`) — `api_keys` jadi 367 MB raw di export
backup.

Proposal ini:
1. **Menghentikan** penyalinan policy ke child (write path).
2. Menjalankan **satu migration data one-time (`0029`)** yang men-`NULL`-kan
   kolom policy menghasilkan semua child yang sudah ada. **Idempotent**, cepat,
   aman bagi kedua backend (Postgres & SQLite), dan tidak mengubah shape tabel
   sehingga **backup/restore kedua arah tetap kompatibel**.
3. Verifikasi lewat test regresi + probe ukuran.

Keputusan desain penting: **kolom tidak di-`DROP`** dari schema. Alasan &
trade-off di §7.

---

## 2. Mapping persistence & console (audit penuh)

Authority: `src/persistence/schema.ts` (canonical), `migrations/full-postgres/0000_baseline.sql`,
`migrations/lite-sqlite3/0000_baseline.sql` (generated, identik secara logis).

### 2.1 Tabel (29 total)
Ringkas: `tenants` (root); provider/routing (`providers`, `provider_accounts`,
`provider_oauth_states`, `models`, `tenant_disabled_models`, `network_pools`,
`health_events`, `model_aliases`, `model_combos`, `provider_routing_settings`,
`pool_routing_settings`); API-key/share (**`api_keys`**, `share_popups`,
`share_links`); console/auth (`console_users`, `console_sessions`,
`console_lockouts`, `console_settings`, `admin_audit_log`,
`cli_tool_mappings`, `cli_tool_settings`, `inferhub_config_keys`);
telemetry (`telemetry_events`, `telemetry_usage_totals`,
`telemetry_payloads`, `telemetry_reconciliation_state`). `admin_audit_log`
FK `SET NULL`; telemetry tidak punya FK korelasi (schema 1246–1247).

### 2.2 Bentuk row `api_keys` (schema 787–848)
Kolom lengkap: `id`, `tenant_id` (FK required), `key_hash`, `key_mode`,
`parent_key_id` (self-FK cascade), `issued_client_ip`, `issued_client_ip_key`,
`label` (NOT NULL), `scopes` (jsonb **NOT NULL**), `key_prefix`,
`key_encrypted`, `notes_title/subtitle/body`, `sort_index`,
`requests_per_minute`, `daily_token_limit`, `monthly_token_limit`,
`lifetime_token_budget`, `lifetime_tokens_consumed` (NOT NULL default 0),
`max_concurrent_requests`, `model_access_mode` (**NOT NULL default
`'whitelist'`**, schema 822–825), `model_list` (jsonb),
`client_router_denylist` (jsonb), `model_prefix`, `created_at`, `enabled`,
`revoked_at`, `is_default`.

### 2.3 Kolom yang benar-benar dipakai runtime oleh child
Auth/admission (`api-key-auth.ts:303–415`, `api-key-store.ts:468–492`):
- lookup `key_hash` → `findActiveByHash`; lalu `policy = parent ?? row`
  (`api-key-auth.ts:359`) — **semua field policy dibaca dari `policy`**
  (parent), bukan dari child.
- `admission_identity` = parent.id; konsumsi =
  `policy.lifetimeTokensConsumed + sumChildrenConsumed(policy.id) + pending`.
- `scopes` = `policy.scopes` (line 373); `model_list`, `model_access_mode`,
  `client_router_denylist`, limits, `max_concurrent` (380–390); `modelPrefix`,
  `cliMappingOwnerId` (399–400).

Kolom yang **wajib ada di child**: `id`, `tenant_id`, `key_hash`,
`key_mode='share'`, `parent_key_id`, `issued_client_ip`,
`issued_client_ip_key` (ditegakkan `api_keys_mode_shape_check`), `label`,
`enabled`, `revoked_at`, `created_at`, `sort_index`,
`lifetime_tokens_consumed`, `is_default`, `key_prefix` (tampil di
`SharedKeySummary` & respons issue), **`scopes`** (validator restore + auth
membaca `policy.scopes` — tapi karena policy = parent, nilai child tidak
dipakai; tetap dipertahankan untuk kompatibilitas restore).

**12 kolom yang di-copy tapi tidak pernah dibaca dari child** (parent menang):
`model_access_mode`, `model_list`, `client_router_denylist`, `model_prefix`,
`requests_per_minute`, `daily_token_limit`, `monthly_token_limit`,
`lifetime_token_budget`, `max_concurrent_requests`, `notes_title`,
`notes_subtitle`, `notes_body`. Dari 12 ini: **11 nullable** (di-NULL-kan oleh
migration) + **1 NOT NULL** (`model_access_mode`, default `'whitelist'` — tidak
bisa NULL, dibiarkan default).

### 2.4 Consumer penting (console + dashboard)
- `listKeys` (`api-keys/routes.ts:40–61`): **hanya top-level** (`parentKeyId
  === undefined`), lalu menambah `sumChildrenConsumed` untuk template share.
  Child tidak pernah tampil di daftar utama dashboard.
- `getKeyDetail` (`:87–92`), `sanitizeApiKeyResponse` (`contracts.ts:352`):
  untuk parent, menyalin semua kolom policy ke respons. Child tidak dirender
  lewat path ini.
- `ShareManagementDialog` (dashboard): memakai `SharedKeySummary` (id, label,
  keyPrefix, issuedClientIp, createdAt, revokedAt, usage) — **tidak membaca**
  kolom policy child.
- `createApiKey`/`updateKey` (`routes.ts:104–169`, `170+`): menulis semua
  kolom policy **hanya untuk top-level** (parent). Child dibuat khusus melalui
  `issueSharedApiKey`.
- **SQLite `AUTH_KEY_COLUMNS`** (`db-sqlite.ts:325–332`): select **semua 29
  kolom** di setiap request terautentikasi. Meng-null-kan 11 kolom tidak
  mengecilkan query ini (masih select semua kolom), tapi mengurangi byte yang
  dibaca dari disk & parsing jsonb — benefit kecil tapi nyata.

### 2.5 Hot path & volume
| Path | Lokasi | Volume |
|---|---|---|
| Mint child | `share-store.ts:528–554` (`issueSharedApiKey`), route `share-router.ts:358–414` | menulis full denormalized row per child |
| Auth lookup (tiap `/v1/*`) | `api-key-store.ts:468–492`; `db-sqlite.ts:325–360` | baca full wide row + SELECT parent |
| Dashboard share list | `api-keys/routes.ts:643–657` → `listChildren` (`api-key-store.ts:299–311`) | unbounded (no LIMIT) |
| Telemetry family | `event-query.ts:329–331` (`familyKeyCondition`) | `EXISTS` pada `id`/`parent_key_id` only |
| Backup export | `backup/store.ts:303–340`, `403–529` | 331k child = 331k wide row (cap 500k) |

### 2.6 Constraint/index relevan pada `api_keys`
- `api_keys_mode_shape_check` (schema 868–885; pg 239–253; sqlite 249): tidak
  menyentuh kolom target proposal.
- Index: `api_keys_key_hash_idx` (unique), `api_keys_tenant_id_idx`,
  `api_keys_enabled_tenant_idx` (partial), `api_keys_parent_key_id_idx`,
  `api_keys_one_default_per_tenant_uidx` (partial, `is_default`+`revoked_at`).
  Kolom target **tidak di-index** → aman.
- `api_keys_active_shared_ip_uidx` dibuat di baseline lalu di-drop migration
  0001 — tidak ada lagi.

---

## 3. Masalah & bukti

1. **Write-amplification**: 331.723 child × 12 kolom policy = ±4 juta
   duplikasi sel metadata.
2. **Backup bengkak**: export schema-driven meng-encode semua kolom
   (`backup/store.ts:343–356`) → 367 MB raw / 28 MB gz untuk `api_keys`
   saja.
3. **Auth tidak diuntungkan**: `api-key-auth.ts` membaca parent; copy child
   hanya menambah lebar row yang dibaca tiap request (`db-sqlite.ts:325–332`
   select semua kolom).
4. **Risiko drift**: jika policy template berubah, child lama membawa policy
   basi (walaupun tidak dibaca — bisa menyesatkan operator yang query manual).

---

## 4. Desain target

### 4.1 Perilaku setelah migrasi
- **Child row hanya menyimpan kolom esensial** + `scopes` (copy parent) +
  `lifetime_tokens_consumed = 0` (counter keluarga tetap via parent).
- 12 kolom policy di child: `NULL` (11 kolom) / `'whitelist'` (default
  `model_access_mode` — **tidak bisa NULL** karena NOT NULL).
- Auth **tidak berubah sama sekali** — sudah resolve ke parent.
- Schema tabel tetap sama (kolom tetap ada) → tidak ada rewrite table, tidak
  ada perubahan constraint, tidak ada perubahan baseline.

### 4.2 Write path (`src/persistence/stores/share-store.ts`)
Hapus blok penyalinan dari parent (baris ±541–552) di `issueSharedApiKey`.
Values yang tersisa:

```
tenantId, keyHash, keyMode: "share", parentKeyId, issuedClientIp,
issuedClientIpKey, label, scopes: parent.scopes, keyPrefix, keyEncrypted: null,
lifetimeTokensConsumed: 0
```

(Kolom lain dibiarkan default — `model_access_mode` default `'whitelist'`,
sisanya NULL.)

### 4.3 Migration one-time `0029` (PG + SQLite, identik)
CATATAN: `model_access_mode` **tidak** di-set NULL (NOT NULL). Hanya 11
kolom nullable yang di-NULL-kan. `model_access_mode` dibiarkan `'whitelist'`
(default) di child lama.

```sql
UPDATE "api_keys"
SET "notes_title" = NULL,
    "notes_subtitle" = NULL,
    "notes_body" = NULL,
    "requests_per_minute" = NULL,
    "daily_token_limit" = NULL,
    "monthly_token_limit" = NULL,
    "lifetime_token_budget" = NULL,
    "max_concurrent_requests" = NULL,
    "model_prefix" = NULL,
    "model_list" = NULL,
    "client_router_denylist" = NULL
WHERE "parent_key_id" IS NOT NULL
  AND ( "notes_title" IS NOT NULL OR "notes_subtitle" IS NOT NULL
        OR "notes_body" IS NOT NULL OR "requests_per_minute" IS NOT NULL
        OR "daily_token_limit" IS NOT NULL OR "monthly_token_limit" IS NOT NULL
        OR "lifetime_token_budget" IS NOT NULL
        OR "max_concurrent_requests" IS NOT NULL OR "model_prefix" IS NOT NULL
        OR "model_list" IS NOT NULL
        OR "client_router_denylist" IS NOT NULL );
```

- **Idempotent**: kedua kalinya, `WHERE` tidak match → 0 row.
- **Cepat**: 331k row, tanpa join, tanpa rewrite; jauh di bawah
  `statement_timeout` (30s) PG.
- Terdaftar di ledger → jalan otomatis satu kali saat boot.

---

## 5. Backward compatibility — hanya backup/restore

> Bukti dari subagent research backup/restore (verifikasi penuh terhadap
> `validate.ts` / `store.ts` / `contracts.ts`).

**`requiredColumns(api_keys)` eksak:** `validate.ts:125–136` mewajibkan kolom
yang `notNull && !hasDefault` (kecuali `tenant_id`, generated/identity).
Untuk `api_keys`, hanya **`label`** (schema.ts:797) dan **`scopes`**
(schema.ts:798) yang wajib. `model_access_mode` (NOT NULL default
`'whitelist'`, schema.ts:822–825) **tidak wajib** — `hasDefault` true, dan
restore yang mengomitnya akan diisi default DB. 11 kolom target semuanya
nullable di baseline `0000` dan tidak pernah diubah migration `0001–0028`.

**Old backup → new schema (pre-0029 → post-0029): restore penuh.**
- 0029 hanya mengubah *nilai* (UPDATE), bukan *kolom* — semua kolom tetap ada
  di schema, jadi `columnNames(table)` (contracts.ts:437–443) tetap menerimanya;
  tidak ada jalur unknown-column (validate.ts:310).
- `requiredColumns` dihitung dari schema live; baris lama masih bawa
  `label`+`scopes` → tidak ada yang dituntut lagi.
- CHECK `api_keys_mode_shape_check` (baseline:239–252) hanya menyentuh
  `key_mode`/`key_hash`/`parent_key_id`/`key_encrypted`/`issued_client_ip*` —
  bukan 11 kolom target → nilai terisi tidak pernah men-trip constraint.

**New backup → old schema (post-0029 → pre-0029): restore juga penuh.**
- 11 kolom target **nullable di schema lama juga** (baseline `0000`), dan
  tidak ada migration `0001–0028` yang menyentuhnya. Kode restore lama tidak
  pernah mewajibkannya; `toValues` (validation.ts:677–692) menerima `null`
  eksplisit (decode `null` → `null`).
- `scopes` + `label` hadir di backup baru (persis yang diminta); `model_access_mode`
  dibawa eksplisit, dan kalaupun omit, default `'whitelist'` mengisi.
- Set kolom identik sebelum/sesudah 0029 (0029 ubah nilai, bukan kolom) →
  tanpa jalur unknown-column untuk 11 kolom.

**Encode export:** `encodeRow` (store.ts:343–356) mengiterasi **semua** kolom
termasuk yang NULL → backup post-0029 memuat `"notes_title": null, …` eksplisit
per child. Tidak ada omission ambiguity.

**Nuansa:**
- `scopes` **load-bearing** — satu-satunya kolom NOT NULL tanpa default selain
  `label`. Jika migration menyentuhnya, restore lama akan drop tiap child
  (validate.ts:356–369). Proposal benar membiarkannya.
- `BACKUP_VERSION` tetap 1 (contracts.ts:47); validator hanya warn pada versi
  ≠1 (validate.ts:223–227), tak pernah menolak. Kedua arah versi 1 → tanpa
  noise.
- Bulk-insert `insertRows` mengelompokkan per set-kunci kolom terurut
  (store.ts:951–964) — bentuk campuran (parent berisi, child NULL, key set
  sama karena 11 kolom selalu hadir) menghasilkan SQL seragam; tanpa dependensi
  urutan.

**Simpulan**: klaim backward-compat **terbukti berlaku** dua arah. 0029
mengubah hanya nilai tersimpan, bukan nullability kolom; `scopes`/`label`/
`model_access_mode` hadir mencukupi satu-satunya constraint required.

### 5.1 ⚠️ Celah: restore tidak menjalankan migration ulang

Urutan nyata: **boot** (migration auto-run, 0029 sekali, tercatat ledger) →
**restore** (`BackupService.restore` → `applyRestore`, `backup/store.ts:1005`)
terjadi **setelah** boot dan **tidak** memicu migration lagi — ia insert
`api_keys` rows persis seperti yang dibawa backup.

Akibat:
- Restore **OLD backup** (child bawa 12 kolom policy penuh) → child hasil
  restore **tetap penuh**; 0029 tidak re-run, jadi bloat hidup kembali dan
  invariant rusak.
- Restore **NEW backup** (child sudah NULL) → aman.

**Solusi — post-restore normalization.** Tambahkan satu langkah di dalam
`applyRestore` (transaksi yang sama, setelah insert `api_keys`) yang
menjalankan `UPDATE` identik dengan 0029, di-scope ke tenant yang sedang
di-restore:

```sql
UPDATE "api_keys"
SET "notes_title" = NULL, "notes_subtitle" = NULL, "notes_body" = NULL,
    "requests_per_minute" = NULL, "daily_token_limit" = NULL,
    "monthly_token_limit" = NULL, "lifetime_token_budget" = NULL,
    "max_concurrent_requests" = NULL, "model_prefix" = NULL,
    "model_list" = NULL, "client_router_denylist" = NULL
WHERE "tenant_id" = $1 AND "parent_key_id" IS NOT NULL;
```

- Idempotent; dalam tx yang sama → restore gagal = rollback total, tanpa state
  parsial.
- Berlaku juga utk `restoreFirstBoot` (lewat `apply` yang sama).
- Scope tenant cukup (applyRestore hanya memasukkan rows milik tenant tujuan);
  tenant lain sudah diproses migration 0029.
- Duplikasi statement dgn 0029 (file SQL tidak bisa import TS): pertahankan
  satu sumber kebenaran via komentar cross-reference dua arah, atau ekstrak
  sebagai fungsi TS `normalizeShareChildPolicy(db, tenantId)` yang dipanggil
  post-restore, dan 0029 meniru SQL yang sama (didokumentasikan).

---

## 6. Rencana implementasi (checklist)

1. **Migration `0029`** — file SQL di `migrations/full-postgres/` dan
   `migrations/lite-sqlite3/` (isi sama, §4.3):
   - **Tambah nama file ke daftar pinned**: `test/persistence/sqlite-baseline.test.ts:47–77`
     (setelah baris 76 `"0028_add_family_template_key_telemetry.sql"`). Ini
     satu-satunya daftar pinned; `expect(postgres).toEqual(expected)` dan
     `expect(sqlite).toEqual(expected)` (baris 78–79) gagal jika hanya satu
     backend yang dapat file → guard drift bawaan.
   - **Baseline tidak perlu di-regenerate** — `schema.ts` tidak berubah;
     `deriveSqliteBaseline` (sqlite-baseline.test.ts:82–85) tetap pass.
   - **`check-migrations.ts`** butuh `CARTETHYIA_DRIFT_DATABASE_URL`
     (kalau dijalankan); sebuah `UPDATE` tidak mengubah catalog → tidak ada
     drift failure selama `schema.ts` tidak disentuh.
2. **Write path** — `share-store.ts`: hapus blok copy 12 kolom (baris
   ±541–552). **Harus satu commit dengan migration** agar ada invariant
   seragam (kalau tidak, child baru non-NULL vs child lama NULL — tanpa efek
   perilaku, tapi tidak seragam).
3. **Test regresi**:
   - Update `test/console/share-issue-rate-limit.test.ts` atau test baru:
     setelah issue, query baris child → assert 11 kolom policy `NULL` dan
     `model_access_mode = 'whitelist'`.
   - Test auth existing tetap pass (parent policy tetap ter-resolve).
   - **Test restore child NULL (gap yang ditemukan subagent)** — tidak ada
     test yang me-restore baris api_keys dengan 11 kolom eksplisit `null`,
     apalagi round-trip child share. Tambahkan test (mis. di
     `test/console/backup-portability.test.ts` atau baru): export dengan child
     (11 kolom NULL) → restore → assert child tetap masuk + `scopes`/`label`
     hadir + `model_access_mode` default.
4. **Probe ukuran** (satu kali, opsional): ukur byte/row `api_keys` sebelum
   vs sesudah (dengan izin) atau di fixture 331k sintetis. Ukur juga jumlah
   kolom yang dibaca `AUTH_KEY_COLUMNS` (tidak berubah).
5. **Verifikasi penuh**: `bun run typecheck` + `bun run test` (runner resmi,
   bukan `bun test` bare — runner yang set `NODE_EXTRA_CA_CERTS` utk fixture
   TLS). Pastikan `test/persistence/sqlite-baseline.test.ts` pass.
6. **Post-restore normalization** (lihat §5.1) — tambahkan langkah UPDATE di
   `applyRestore` setelah insert `api_keys`, satu commit dengan migration &
   write path agar invariant seragam di semua jalur masuk data (boot, issue,
   restore).
7. **Commit & push** (semua remote, main+dev) mengikuti pola yang ada.

---

## 7. Keputusan desain: kenapa TIDAK `DROP COLUMN`

- **SQLite**: `ALTER TABLE ... DROP COLUMN` tidak mendukung `IF EXISTS`.
  Jika baseline di-regenerate tanpa kolom (karena schema.ts berubah), fresh DB
  tidak punya kolom → migration DROP gagal. Solusi aman memerlukan rewrite
  tabel (create-new + copy + rename) — sangat berisiko untuk `api_keys`
  (331k row, FK `parent_key_id` self-FK, cascade `share_popups`/
  `share_links`/`cli_tool_*`).
- **Backup/restore**: meski arah old→new aman (unknown-column drop), arah
  new→old berisiko. Mempertahankan kolom menghilangkan risiko itu sepenuhnya.
- **Manfaat marginal**: Postgres menyimpan NULL murah (null bitmap); JSON
  export `null` pendek. Penurunan footprint dari NULL sudah signifikan tanpa
  perlu menghilangkan kolom dari schema.

> **Opsi lanjutan (tidak direkomendasikan sekarang)**: jika ingin schema
> benar-benar ramping, lakukan Fase 2 terpisah yang (a) regenerate kedua
> baseline dari schema baru, (b) beri migration PG `DROP COLUMN IF EXISTS`,
> dan (c) untuk SQLite gunakan update direct via `PRAGMA`-guard dalam skrip
> (bukan SQL murni). Trade-off: runtime boot lebih kompleks & perlu uji
> migrasi fresh-vs-lama dua arah. Fase 1 sudah memenuhi "optimized row data".

---

## 8. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Kode lain diam-diam membaca kolom policy dari child | Telah diaudit penuh (subagent): tidak ada jalur baca 12 kolom dari child. Auth semua lewat `policy = parent ?? row` (`api-key-auth.ts:359`); `listChildren` konsumennya hanya baca id/telemetry; `/share/:token/data` hanya resolve parent (`share-store.ts:386`); `sanitizeApiKeyResponse` omit field undefined. |
| `model_access_mode` NOT NULL | Tidak di-NULL-kan; tetap `'whitelist'` (default). Caveat kecil: `map()` (`api-key-store.ts:249`) set `modelAccessMode: row.modelAccessMode` unconditional — dengan default `'whitelist'` tetap truthy, jadi `getKeyDetail` pada child (jika langsung dialamatkan) melaporkan `modelAccessMode: 'whitelist'` tanpa `modelList` — harmless. |
| **PG `statement_timeout` 30s / `lock_timeout` 5s** (`db-pg.ts:119–142`) | Estimasi: UPDATE 331k row biasanya detik — single UPDATE hampir pasti aman. Jika ingin zero-risk, gunakan chunker `DO $$ … $$` di file PG saja (loop `WHERE id IN (SELECT id … LIMIT 5000)` sampai changes < 5000), mirror `pruneTelemetry` batching (`telemetry-store.ts:316–352`). SQLite tidak butuh batching (single writer, tanpa timeout). |
| Migration gagal sebagian (PG/SQLite) | Kedua runner membungkus seluruh file + ledger dalam satu transaksi (`db-pg.ts:191–216`, `db-sqlite.ts:547–560`) → rollback total, tanpa state parsial. |
| SQLite statement split | `UPDATE` satu statement tanpa breakpoint — `splitStatements` menghasilkan satu chunk; `exec` menjalankannya (preceden 0028 identik). |
| Deployment lama dengan data child non-NULL | Migration hanya men-`NULL`-kan child (`parent_key_id IS NOT NULL`); template/personal tak tersentuh. |
| Child baru non-NULL jika write path tak ikut diubah | Satu commit untuk migration + write path (lihat §6.2) → invariant seragam. |
| Test harness memakai `bun test` bare | Selalu gunakan `bun run test` (runner resmi). |
| Restore OLD backup menghidupkan kembali bloat (migration tidak re-run) | Post-restore normalization di `applyRestore` (§5.1) — satu transaksi dengan restore. |
| Restore gagal di tengah setelah UPDATE | Update post-restore berada dalam tx restore → rollback total. |

---

## 9. Kriteria sukses

1. `bun run typecheck` EXIT=0; `bun run test` → 0 fail (termasuk
   `sqlite-baseline`, `share-stats`, `share-issue-rate-limit`, `backup-portability`).
2. Test baru: child baru hasil `issue` punya 11 kolom policy `NULL` dan
   `model_access_mode = 'whitelist'`; parent tetap memegang policy; auth tetap
   resolve dari parent.
3. Migration `0029` idempotent (jalan 2× → hasil sama; ledger skip kedua).
4. Probe ukuran: byte/row `api_keys` child turun (target ≥ ~50–70% di kolom
   policy besar seperti `model_list`/`client_router_denylist`/notes).
5. Backup/restore dua arah + test child NULL (gap yang ditutup §6.3):
   restore backup lama → new schema tanpa kehilangan row; restore backup baru
   → old schema: child tetap masuk karena `scopes` + `label` hadir dan
   `model_access_mode` default.
6. **Post-restore invariant** (§5.1): setelah restore OLD backup (child penuh),
   query baris child → 11 kolom `NULL` dan `model_access_mode = 'whitelist'`
   — membuktikan restore juga menerapkan optimasi, bukan hanya migration boot.

---

## 10. Hasil research paralel (3 subagent)

Ringkasan temuan dari tiga research read-only yang diluncurkan untuk memverifikasi
proposal ini.

### 10.1 Audit pembaca kolom child (tidak ada yang membaca)
- Tidak ada satu pun jalur kode yang membaca 11 kolom target (atau `scopes`)
  dari baris `parent_key_id IS NOT NULL`.
- `api-key-auth.ts:351–359`: parent selalu di-resolve dulu; `policy = parent ??
  row`; semua 12 kolom dibaca dari `policy` (parent). `notes_*` bahkan tidak
  dibaca auth sama sekali.
- `listChildren` (`api-key-store.ts:299–311`) dipakai hanya utk `child.id`
  (invalidation/revoke) atau `SharedKeySummary` (id/label/keyPrefix/issuedClientIp/
  createdAt/revokedAt/usage) — tak pernah 12 kolom.
- `map()` (`api-key-store.ts:213–258`) null-guards semua kolom opsional →
  child NULL hanya menghilangkan key; tak ada konsumen yang baca policy child.

### 10.2 Verifikasi backup/restore (klaim dua arah berlaku)
- `requiredColumns(api_keys)` = **{`label`, `scopes`}** saja.
- Old→new: restore penuh (kolom tetap ada; tidak ada unknown-column; CHECK shape
  tak menyentuh 11 kolom).
- New→old: restore penuh (11 kolom nullable di semua versi; `null` eksplisit
  diterima; `scopes`/`label` hadir; `model_access_mode` default bila omit).
- Export encode menyertakan NULL eksplisit; `BACKUP_VERSION` tetap 1; bulk-insert
  grouping aman.
- Gap: **belum ada test yang me-restore child dengan 11 kolom NULL** → §6.3.

### 10.3 Verifikasi machinery migration (aman; satu update file)
- PG: tiap file dalam `BEGIN/COMMIT` + ledger; `statement_timeout` 30s /
  `lock_timeout` 5s; UPDATE 331k row hampir pasti fit — opsi chunking
  `DO $$ … $$` kalau mau zero-risk.
- SQLite: per-file transaction; `splitStatements` satu chunk; tanpa timeout.
- Fresh DB & existing deployment keduanya apply 0029; ledger cegah re-run.
- Yang harus diupdate: hanya `test/persistence/sqlite-baseline.test.ts:47–77`
  (tambah `"0029_*.sql"`). Tidak perlu regenerate baseline; `check-migrations`
  tidak drift (UPDATE tak ubah catalog).

---
## 11. Catatan eksekusi (status implementasi)

Fase 1 diimplementasikan dan diverifikasi:

- **Migration `0029`** — `migrations/full-postgres/0029_null_share_child_policy_columns.sql`
  + `migrations/lite-sqlite3/0029_null_share_child_policy_columns.sql`
  (update 11 kolom nullable → NULL pada `parent_key_id IS NOT NULL`,
  idempotent).
- **Write path** — `share-store.ts:issueSharedApiKey`: blok copy 12 kolom
  dihapus; child hanya membawa identitas + `scopes` (+ `model_access_mode`
  default). Komentar cross-reference ke 0029 & `normalizeShareChildPolicy`.
- **Post-restore normalization** — `src/console/backup/store.ts`:
  `normalizeShareChildPolicy(db, tenantId)` dipanggil di dalam `applyRestore`
  (satu transaksi, setelah insert `api_keys`, hanya jika tabel `api_keys`
  termasuk replaceTables).
- **Pinned list** — `test/persistence/sqlite-baseline.test.ts`: `"0029_null_share_child_policy_columns.sql"`
  ditambahkan (daftar pasangan PG/SQLite).
- **Test baru**:
  - `test/console/share-issue-rate-limit.test.ts`: test baru — child hasil
    `issue` tidak menyalin policy (11 kolom NULL, `model_access_mode`
    `'whitelist'`, `scopes` tetap). Parent fixture kini membawa policy penuh
    agar regresi copy terlihat.
  - `test/console/backup-share-child-policy.test.ts` (baru): restore OLD
    backup (child penuh) → child hasil restore di-NULL-kan + parent tetap
    penuh; restore NEW backup (child NULL) → tetap NULL.
- **Verifikasi**:
  - `bun run typecheck` → EXIT=0.
  - `bun run test` (runner resmi, backend + dashboard) → **3919 pass / 1
    skip (env) / 0 fail** (331 file backend + 44 dashboard), dua kali
    dijalankan.
  - Probe ukuran byte/row di data produksi **belum** dijalankan (VPS SSH
    terblokir; butuh izin/data live) — target §9.4 tetap open.
- **Belum dilakukan**: commit & push ke remote (tunggu go-ahead user).

---
## Lampiran: referensi kunci

- Schema `api_keys`: `src/persistence/schema.ts:784–887`
- Shape check & NOT NULL `model_access_mode`: `schema.ts:822–825`, `868–885`;
  baseline pg `0000:239–253`, sqlite `0000:249`
- Copy block: `src/persistence/stores/share-store.ts:528–554`
- Auth parent-resolve: `src/security/api-key-auth.ts:353–390`
- SQLite prepared auth select semua kolom: `src/persistence/db-sqlite.ts:325–360`
- Backup contracts (required/legacy): `src/console/backup/contracts.ts:91–136`,
  `160–169`, `454–472`
- Restore validate: `src/console/backup/validate.ts:125–136`, `201–434`
- Export encode: `src/console/backup/store.ts:343–356`, `403–529`
- Bulk-insert grouping: `src/console/backup/store.ts:951–964`
- Console listKeys (top-level saja): `src/console/api-keys/routes.ts:40–61`
- Dashboard `SharedKeySummary` (tidak baca policy child): `src/console/share/share-usage.ts:24–34`
- Migration machinery: `src/persistence/db-pg.ts:155–224`,
  `src/persistence/db-sqlite.ts:509–569`, `src/persistence/migrate.ts`
- PG timeouts: `src/persistence/db-pg.ts:119–142`
- Batching preceden (pruneTelemetry): `src/persistence/stores/telemetry-store.ts:316–352`
- Pinned migration list: `test/persistence/sqlite-baseline.test.ts:47–77`
- Drift check: `scripts/test/check-migrations.ts`
- Preceden: `0001` (drop index), `0023` (drop column), `0028` (backfill one-time)
