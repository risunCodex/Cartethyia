# Proposal — Provider detail actions: disable all cooldown accounts & delete banned accounts (redesign aksi)

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** dashboard provider detail (`dashboard/src/features/provider-detail/`), console API catalog (`src/console/providers/catalog/`), quota routes (`src/console/quota/`), health/cooldown state (`src/providers/operations/account-health-service.ts`, `src/persistence/schema.ts`), audit labels (`dashboard/src/features/logs/audit-labels.ts`). Tidak menyentuh schema (tanpa migrasi).
**Method:** audit subagent tunggal; `codegraph_explore` + `Read`/`Grep` langsung. Semua klaim behavior mengacu pada kode (file:line). Baseline pass/fail diukur saat eksekusi (lihat §5).

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.2 (D07–D13) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Halaman provider detail & aksi yang sudah ada

- `ProviderDetailPage` (`dashboard/src/features/provider-detail/ProviderDetailPage.tsx`) merender halaman; aksi global provider (Enable/Disable built-in) ada di `PageHeader actions` (`:460-487`). Kartu Accounts memuat `AccountsList` (`:597-604`) dan `ConfirmDialog` delete per-akun (`:889-939`).
- `AccountsList` (`dashboard/src/features/provider-detail/sections/Accounts.tsx`) memiliki flat toolbar: **Test all** (`:328-344`), **Recover** (`:349-362`), **Enable** (`:363-378`), **Disable** (`:379-394`), **Export** (`:395-408`), **Delete** (`:409-422`), Grok-only **Test 407** (`:428-439`). Pola yang dipakai: tombol selalu mounted dan grey out saat tidak relevan (komentar `:345-348`), bukan dropdown.
- Semua bulk aksi saat ini adalah **client-side fan-out** lewat `runBulk` + `mapWithConcurrency` (`Accounts.tsx:179-191`) dengan concurrency `TEST_ALL_CONCURRENCY = 3` (`:205`). `bulkSetActive` memanggil `PATCH /providers/:providerId/accounts/:accountId` per akun (`:244-251`); `bulkRecover` memanggil `POST .../recover` per akun (`:193-196`); `bulkDelete` memanggil `DELETE /accounts/:id` (tenant) atau `DELETE /global/accounts/:id` (shared) per akun (`:281-299`).
- Per-row aksi (`dashboard/src/features/provider-detail/sections/AccountRow.tsx`): **Health** (`:385-404`), **Test** (`:405-454`, wajib `POST /accounts/:id/quota/refresh`), **Edit key** (`:455-465`), **Enable/Disable** (`:466-477`), **Recover** (`:478-489`, hanya jika `isRecoverable` = status `cooldown` atau `cooldownUntil` aktif, `:186-188`), **Delete** (`:490-500`). Baris `kind === "pool"` (pool-as-account) menyembunyikan Edit key/Disable/Delete (`:455-500`).

### 1.2 Backend: endpoint yang sudah ada

- Console API **catalog** di `src/console/providers/catalog/routes.ts` (prefix `/providers`):
  - `GET /:providerId/accounts` (`:341-343`) → `store.listAccounts` (`src/console/providers/catalog/store.ts:893-918`), gabungan akun nyata + pool-as-account.
  - `PATCH /:providerId/accounts/:accountId` (`:368-380`) → body `updateAccountBody`: `label | secret | status` dengan `ACCOUNT_STATUSES = ["active","disabled"]` (`src/console/providers/catalog/contracts.ts:60`; `cooldown` sengaja tidak operator-settable, komentar `:57-59`).
  - `POST /:providerId/accounts/:accountId/recover` (`:404-411`) → `recoverAccount` (`provider-operations.ts:700-717`).
  - `POST /:providerId/accounts/export` (`:412-422`).
- Console API **quota** di `src/console/quota/account-quota-tenant.ts` (prefix `/accounts` tenant-scoped):
  - `PATCH /accounts/batch` (`:787-821`) — enable/disable massal dalam **satu UPDATE statement**, body `{ ids, active }`, tanpa size cap, invalidation snapshot sekali.
  - `POST /accounts/batch-delete` (`:847-888`) — delete massal satu statement, mengembalikan `{ ok, deleted, missing }`, menyentuh hanya tenant-owned (`tenant_id = tenant`).
  - `PATCH /accounts/:id` (`:738-786`), `DELETE /accounts/:id` (`:822-846`), `POST /accounts/:id/quota/refresh` (`:585-662`), `POST /quota/refresh` batch (concurrency `QUOTA_REFRESH_CONCURRENCY = 5`, `:318`).
- Console API **global** di `src/console/quota/account-quota-global.ts` (prefix `/global/accounts`, `requireGlobalAdmin`): `PATCH /global/accounts/:id` (`:50-100`), `DELETE /global/accounts/:id` (`:101-128`), `POST /global/accounts/batch-delete` (`:129-159`), `POST /global/accounts/:id/quota/refresh` (`:160-191`).
- **Gap penting:** endpoint batch server-side (`PATCH /accounts/batch`, `POST /accounts/batch-delete`, `POST /global/accounts/batch-delete`) sudah ada, tetapi dashboard provider detail **tidak memakainya** — `Accounts.tsx` tetap fan-out per-akun (F1). Hooks `useSetAccountsActiveBatch`/`useDeleteQuotaAccount` (`dashboard/src/hooks/quota.ts:285-321`) ada, tapi dipakai halaman Quota, bukan provider detail.

### 1.3 Status cooldown: cara disimpan & dibaca

- Schema `src/persistence/schema.ts`: enum `healthStatus = ["active","cooldown","disabled"]` (`:100`); `healthColumns()` memuat `status`, `consecutiveFailures`, `lastError*`, `cooldownUntil` (`:115`), `lastRecoveredAt` (`:116`); `modelCooldowns` jsonb `notNull().default({})` (`:252`). Index `(status, cooldown_until)` (`:349`).
- Proyeksi ke dashboard: `mapAccount` (`store.ts:1509-1558`) → `cooldownUntil` (`:1551`) dan `liveModelCooldowns(row.modelCooldowns)` (`:1552`). `liveModelCooldowns` (`src/console/quota/quota-view.ts:163-173`) mengembalikan hanya entri yang belum lewat batas waktu.
- Routing membaca `cooldown_until` dan `model_cooldowns` untuk mengecualikan kandidat (`src/transport/routing/route-catalog.ts:940-944`; `router.ts:282-299`).
- Health sweep `sweepExpiredCooldowns` (`src/providers/operations/account-health-service.ts:406-484`) jalan tiap 60 detik (`src/boot/dependencies.ts:357-376`), **hanya** merecover baris `status = 'cooldown'` dengan `cooldown_until <= now` (batch `COOLDOWN_RECOVERY_BATCH = 500`, `src/providers/operations/account-error-classification.ts:47`), lalu me-prune entri `model_cooldowns` expired. Baris `disabled` tidak pernah di-recover sweep (`:418-422`).

### 1.4 Status banned: tidak ada enum, melainkan kategori error

- Tidak ada status DB "banned": banned direpresentasikan sebagai `lastErrorCategory === "policy_blocked_banned"` (kategori `:196` di `account-error-classification.ts`) yang dihasilkan rule `policyBlock`/`channelBlock` saat `buddyBanned` (`:985-998`, `:1072-1079`, `:1293-1310`) dengan hasil transisi **`status: "disabled"`**.
- Dashboard menampilkan banned via `AccountStatusBadge` (`AccountStatusBadge.tsx:61-67`, lengan `disabled` `:132-151`) memakai `accountErrorLabel("policy_blocked_banned", ...)` → "Account banned" / "No Copilot access" untuk github (`dashboard/src/lib/format/labels.ts:16,73-75`).
- Implikasi: "delete banned accounts" = delete akun dengan `status='disabled'` **dan** `last_error_category='policy_blocked_banned'`.

### 1.5 Akun shared vs tenant-owned, dan pool-as-account

- Akun shared/global (`tenant_id IS NULL`) di-return `listAccounts` (`store.ts:893-918`, `globalOrOwnedBy`), dimasukkan `ProviderAccountResponse.tenantId = null` (`contracts.ts:507`), dan tidak terjangkau route tenant-scoped (`DELETE /accounts/:id` dan `PATCH /accounts/batch` pakai `eq(tenantId, ...)`, `account-quota-tenant.ts:770,807`). Delete shared butuh `/global/accounts/:id` atau `/global/accounts/batch-delete` (platform admin).
- Pool-as-account (`kind === "pool"`, `contracts.ts:549-569`): `listPoolAccounts` (`store.ts:1033-1052`) menempatkannya di daftar; `Accounts.tsx` mengecualikan dari selection bulk (`:143-146`) dan `AccountRow` menyembunyikan Edit key/Disable/Delete. Cooldown pool hidup di `network_pools.provider_cooldowns` (badge `PoolProviderCooldownBadge`, `AccountStatusBadge.tsx:95-118`), bukan `provider_accounts`.

### 1.6 Ringkasan temuan

| # | Temuan | Verdict | Behavior change? | Severity | Effort |
| --- | --- | --- | --- | --- | --- |
| F1 | Bulk actions provider detail (Enable/Disable/Delete/Recover/Export) adalah client-side fan-out via `mapWithConcurrency`, padahal endpoint batch server-side (`PATCH /accounts/batch`, `POST /accounts/batch-delete`) sudah ada dan tidak dipakai halaman ini. | konsolidasi | ya (teknis internal) | MED | M |
| F2 | Tidak ada aksi "disable semua akun cooldown". `AccountRow` hanya menawarkan Recover per-akun (`:478-489`); definisi "sedang cooldown" mencakup status `cooldown`, `cooldownUntil` future, **dan** `modelCooldowns` live (`quota-view.ts:163-173`) — perlu dipilih secara eksplisit. | gap fitur | ya (perlu) | HIGH | M |
| F3 | Tidak ada aksi "delete semua akun banned". Banned bukan status melainkan `lastErrorCategory === "policy_blocked_banned"` + `status='disabled'`; tidak ada helper kueri untuk memilihnya. | gap fitur | ya (perlu) | HIGH | S/M |
| F4 | Akun shared (`tenant_id IS NULL`) tidak terjangkau route tenant-scoped; global batch-delete ada tapi global batch-disable tidak ada (hanya PATCH per-akun). Desain baru harus memutuskan bagaimana menangani akun shared. | gap desain | ya | MED | S |
| F5 | Pool-as-account (`kind === "pool"`) tidak boleh kena aksi massal (bukan baris `provider_accounts`); Selection bulk sudah mengecualikan, filter baru (cooldown/banned) harus ikut mengecualikan. | guard | tidak | MED | S |
| F6 | Konsistensi aksi: pola existing adalah flat toolbar "selalu mounted, grey out" (`Accounts.tsx:345-348`) + `ConfirmDialog` untuk destruktif (`:509-519`). Aksi baru harus mengikuti pola ini; label/ikon lucide sudah ada (PowerOff, Trash2). | reorganisasi UI | ya (kosmetik) | LOW | S |

---

## 2. Masalah yang diminta diatasi

Requirement: halaman detail provider perlu aksi-aksi tambahan:

1. **Disable all cooldown accounts** — men-disable semua akun yang sedang dalam status cooldown (account-wide **maupun** model-scoped) pada provider itu.
2. **Delete banned accounts** — menghapus akun-akun yang berstatus banned.
3. **Redesign aksi existing** agar konsisten (Test, Edit key, Disable, Delete per-akun, dsb.).

Diterjemahkan ke masalah konkret pada perilaku sekarang:

- Tidak ada jalur untuk men-disable sekumpulan akun cooldown sekaligus; operator harus memilih satu-satu atau me-recover (kebalikan). Tidak ada tombol yang menampilkan jumlah akun cooldown/banned sebagai informasi.
- Tidak ada definisi operasional "banned" yang bisa dipakai query delete; kategori `policy_blocked_banned` ada tapi tidak pernah dipakai sebagai filter hapus massal.
- Bulk yang ada tidak konsisten dengan backlog backend: fan-out client-side vs satu statement server-side (F1). Konfirmasi destruktif mengikuti pola yang sudah mapan: delete memakai `ConfirmDialog`, disable langsung dieksekusi.

---

## 3. Desain yang diusulkan

### 3.1 Prinsip

- **Server-side batch, bukan fan-out client-side.** `PATCH /accounts/batch` dan `POST /accounts/batch-delete` adalah preseden (satu statement, satu invalidation snapshot, satu audit row). Aksi baru mengikuti bentuk itu.
- **Definisi "sedang cooldown"** (untuk disable): status `= 'cooldown'` ATAU `cooldown_until > now` ATAU `model_cooldowns` memiliki entri live. Ini mencocokkan `toQuotaAccountHealth`/`liveModelCooldowns` (`quota-view.ts:137-173`) dan `isRecoverable` (`AccountRow.tsx:188`) — akun yang badge-nya menunjukkan cooldown (account-wide atau per-model) adalah yang terkena.
- **Definisi "banned"** (untuk delete): `status = 'disabled' AND last_error_category = 'policy_blocked_banned'`. Ini persis himpunan yang badge-nya menampilkan "Account banned"/"No Copilot access".
- **Pool-as-account dikecualikan** di kedua filter (guard F5) — aksi hanya menyentuh baris `provider_accounts`.
- **Default off / deklaratif:** tidak ada perubahan pada per-akun actions; aksi baru adalah tambahan di toolbar, non-destruktif (disable) dan destruktif dengan konfirmasi (delete).

### 3.2 UI: tata letak aksi baru

- Dua tombol baru di toolbar `AccountsList`, diletakkan setelah **Delete** (mengikuti urutan "per-akun → massal → ekspor" yang ada):
  - **"Disable cooldown"** — `variant="secondary"`, ikon `PowerOff` (sudah dipakai Disable, `Accounts.tsx:380`). Label menampilkan count: `Disable cooldown (n)` dengan `n` = jumlah akun cooldown dari data `accounts` (semua akun dihitung, bukan hanya selection). Disabled (grey out) saat `n === 0` atau `bulkBusy`.
  - **"Delete banned"** — `variant="danger"`, ikon `Trash2`. Label `Delete banned (n)`. Disabled saat `n === 0` atau `bulkBusy`. Membuka `ConfirmDialog` (pola `:509-519`) dengan message bermuatan jumlah akun dan peringatan bahwa penghapusan permanen.
- Keduanya mengikuti pola "selalu mounted, grey out" (`:345-348`) sehingga toolbar tidak berubah bentuk.
- **Redesign konsistensi (F6):** tidak mengubah per-row actions; hanya memastikan toolbar baru memakai `Button` + `ConfirmDialog` yang sama, urutan stabil, dan title tooltip menjelaskan cakupan ("all accounts of this provider currently in cooldown"). Per-row `Disable` tetap toggling per-akun.
- `n` dihitung dari `ProviderAccountResponse` yang sudah ada: cooldown = `account.kind !== "pool" && (status === "cooldown" || cooldownUntil future || Object.keys(modelCooldowns ?? {}).length > 0)`; banned = `account.kind !== "pool" && status === "disabled" && lastErrorCategory === "policy_blocked_banned"`.

### 3.3 API baru di console (route + contract)

Tambahkan dua route di `src/console/providers/catalog/routes.ts` (prefix `/providers`, domain catalog, bukan quota — karena ini operasi provider/akun):

```
POST /:providerId/accounts/actions/disable-cooldowns   // body: {} (tanpa body)
POST /:providerId/accounts/actions/delete-banned       // body: {}
```

Response bersama:

```ts
// jenis gabungan (contract baru di src/console/providers/catalog/contracts.ts)
interface ProviderAccountBulkActionResult {
  ok: boolean;
  updated: number;            // disable: jumlah yang di-set status=disabled
  deleted?: string[];         // delete: id yang terhapus (mirip batch-delete)
  missing?: string[];         // delete: id target yang tidak ditemukan (selalu kosong di batch-by-filter)
  globalSkipped: number;      // jumlah akun shared (tenant_id NULL) yang dilewati route tenant-scoped
}
```

- Authorization: `requireTenantAnyScope(access, PROVIDER_WRITE_SCOPES)` (pola `provider-operations.ts:645,705`).
- Filter SQL (tenant-scoped, **hanya owned**): `provider_id = ? AND tenant_id = ? AND <kondisi>`; akun shared tidak match dan dihitung `globalSkipped` bila ingin diketahui (D10).
- **Disable cooldowns** — satu UPDATE:
  - Kondisi: `status = 'cooldown' OR cooldown_until > now OR <model_cooldowns punya entri live>`. Entri live model di SQL: `(model_cooldowns IS NOT NULL AND model_cooldowns::text <> '{}')` — lebih tepat: `jsonb_typeof(model_cooldowns) = 'object' AND EXISTS (SELECT 1 FROM jsonb_each_text(model_cooldowns) e WHERE e.value::timestamptz > now())`; pada SQLite pakai `json_each`/`json_extract`. (Sederhanakan bila perlu: ikut semantic `liveModelCooldowns`, tetapi evaluasi di SQL untuk satu statement.)
  - Set: `status = 'disabled'`. **Tidak** menghapus `cooldown_until`/`model_cooldowns` (preserve evidence, diagnosa; recovery manual `recoverAccount` membersihkan semuanya — `account-health-service.ts:368-388`).
  - Guard/fallback: tanpa baris match → `updated: 0`, `ok: true`. Invalidation snapshot + credential cache tidak diperlukan (status tidak menyentuh ciphertext), tapi snapshot invalidator **harus** dijalankan (routing membaca status, `route-catalog.ts`).
- **Delete banned** — satu DELETE statement:
  - Kondisi: `status = 'disabled' AND last_error_category = 'policy_blocked_banned'`.
  - Ikuti persis pola `POST /accounts/batch-delete` (`account-quota-tenant.ts:847-888`): `DELETE ... WHERE provider_id = ? AND tenant_id = ? AND <kondisi> RETURNING id`, lalu `invalidateCredentialCaches(deletedIds)`, `invalidateQuotaCaches(tenantId, deletedIds, redis)`, `snapshotInvalidator.invalidate()`, satu audit row.
  - Keterbatasan (guard): ini **hanya** menyentuh tenant-owned. Akun shared tidak match (F4 → D10).
- Audit: action baru `"provider_account.bulk_disabled_cooldowns"` dan `"provider_account.bulk_deleted_banned"` (detail `{ providerId, updated | deleted, globalSkipped }`); tambahkan label di `dashboard/src/features/logs/audit-labels.ts` (pola `:38-47`).
- Invalidation client-side: pakai helper `invalidateProviderAccounts` (`dashboard/src/hooks/providers.ts:480-489`) — accounts list, health-events family, providers all — plus `queryKeys.quota.all` (delete mengubah overview), `queryClient.removeQueries` untuk quota account per id yang dihapus (pola `bulkDelete`, `Accounts.tsx:290`).

### 3.4 Batas batch

- Preseden `PATCH /accounts/batch` dan `POST /accounts/batch-delete` sengaja tanpa cap: satu statement `UPDATE/DELETE ... WHERE ...` sudah bounded oleh DB (komentar `account-quota-tenant.ts:797-798,860-862`).
- Keputusan final (§6): **gunakan satu statement**, tidak ada cap; jika ingin guard defensif, batasi dengan loop `LIMIT 5000` (pola `revokeChildrenByScope`, `src/persistence/stores/api-key-store.ts:515-528`). Keputusan final (§6): tanpa cap dulu (konsisten dengan batch yang ada), catat kontrak di comment.

### 3.5 Interaksi dengan health sweep

- Sweep `sweepExpiredCooldowns` hanya merecover `status='cooldown'` (`account-health-service.ts:418-422`). Setelah disable → `status='disabled'`, akun tidak akan di-recover otomatis. Tidak ada race yang berbahaya: jika sweep merecover antara select dan update (transaksi pendek), `UPDATE ... WHERE <kondisi>` tetap valid — baris yang sudah active tidak match, jadi idempotent.
- Pruning `model_cooldowns` expired oleh sweep tetap berjalan; tidak konflik dengan aksi (filter live dihitung saat eksekusi).
- Glitch kecil yang harus diuji: akun dengan hanya `modelCooldowns` live (status still `active`) — aksi disable harus tetap men-set `status='disabled'`; setelah itu badge menampilkan Disabled + model chips (`AccountStatusBadge.tsx:132-151`).

### 3.6 Observability

- Audit rows (di atas) + toast hasil di dashboard (pola `runBulk`: success `"Disable complete"` / `"Delete complete"` dengan count; error `"partially failed"` bila `updated`/`deleted` kurang dari target).
- Tidak ada telemetry baru; health-events tidak perlu entri baru (ini aksi operator, bukan transition health — konsisten dengan `provider_account.revoked` yang bahkan tidak menulis health event).

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Console API — kontrak | `src/console/providers/catalog/contracts.ts` (type `ProviderAccountBulkActionResult`, tambah method `ProviderCatalogStore`) |
| Console API — route | `src/console/providers/catalog/routes.ts` (dua route baru `POST .../actions/disable-cooldowns`, `POST .../actions/delete-banned`) |
| Console API — operasi | `src/console/providers/catalog/provider-operations.ts` (handler + audit + invalidation snapshot) |
| Console API — store | `src/console/providers/catalog/store.ts` (implementasi `disableCooldowns(tenantId, providerId)` & `deleteBanned(tenantId, providerId)` — satu UPDATE/DELETE, cache invalidation) |
| Dashboard — hooks | `dashboard/src/hooks/providers.ts` (mutations `useDisableProviderCooldowns`, `useDeleteProviderBanned`) |
| Dashboard — UI | `dashboard/src/features/provider-detail/sections/Accounts.tsx` (dua tombol toolbar + count + ConfirmDialog delete banned), `dashboard/src/features/provider-detail/sections/AccountRow.tsx` (tidak berubah, pr reference) |
| Audit labels | `dashboard/src/features/logs/audit-labels.ts` (dua label baru) |
| Test backend | `test/console/provider-detail-bulk-actions.test.ts` (baru), regresi `test/console/account-batch-delete.test.ts` |
| Test dashboard | `dashboard/test/features/provider-detail-bulk-actions.test.tsx` (baru) |

Tidak menyentuh: `src/persistence/schema.ts` (tanpa migrasi), route quota (`account-quota-tenant.ts`/`account-quota-global.ts`) termasuk pasangan global route (D10).

---

## 5. Migrasi & risk

**Migrasi:** tidak ada. Tidak ada kolom/tabel baru; `provider_accounts` sudah memiliki semua kolom yang dibutuhkan (`status`, `cooldown_until`, `model_cooldowns`, `last_error_category` — `schema.ts:100,115,252`).

**Backward compatibility:**
- API baru bersifat tambahan; endpoint lama tidak berubah. Dashboard tetap bisa memakai per-akun path.
- Filter cooldown mengikuti semantic read yang sudah ada (`liveModelCooldowns`); tanpa entri live, tidak ada akun terpilih — aksi no-op aman.
- `PATCH /accounts/batch`/`POST /accounts/batch-delete` yang sudah ada tetap utuh; tidak ada perubahan kontrak.

**Risk & mitigasi:**
- *Misinterpretasi "cooldown"*: akun `status='cooldown'` tetapi deadline sudah lewat (belum di-sweep) tetap match — ini sesuai keinginan (disable = operator menghentikan, bukan sekadar menunggu). Untuk menghindari salah tangkap, dokumentasikan di tooltip: "currently in cooldown (account-wide or per-model)".
- *Race dengan sweep*: UPDATE idempotent (lihat §3.5); transaksi pendek. Tidak ada lock panjang.
- *Hapus banned salah tangkap*: filter ketat `last_error_category='policy_blocked_banned'` + `status='disabled'`; `auth_invalidated` tidak termasuk. Konfirmasi destruktif wajib.
- *Akun shared*: route tenant-scoped tidak menyentuh `tenant_id IS NULL` (F4). Jika operator butuh, global route `POST /global/accounts/batch-delete` sudah ada untuk delete; pasangan global route dibuat (D10).
- *Performa*: satu statement per aksi; guard `LIMIT 5000` ditolak (D09).

**Test list (proof-of-design):**
- `test/console/provider-detail-bulk-actions.test.ts` (baru):
  - disable menyentuh hanya akun dengan status `cooldown` OR `cooldownUntil` future OR `modelCooldowns` live; status berubah `disabled`; `modelCooldowns`/`cooldownUntil` dipertahankan; `updated` benar.
  - disable tidak menyentuh pool-as-account dan akun shared (`globalSkipped`/`missing` semantics).
  - delete banned: hanya `status='disabled' AND last_error_category='policy_blocked_banned'`; `deleted` + `missing`; bukan status nyata; cache credential/quota diinvalidasi; satu audit row.
  - idempotensi: panggil dua kali → `updated:0` pada kedua.
  - auth: menolak tanpa `providers:write`.
- Regresi: `test/console/account-batch-delete.test.ts` (pola tetap); `test/console/quota-refresh-authstate.test.ts`, `test/console/account-authmethod.test.ts` (tidak terpengaruh).
- Dashboard: `dashboard/test/features/provider-detail-bulk-actions.test.tsx` — count badges, disable saat 0, ConfirmDialog muncul untuk delete, invalidation memanggil ulang list.
- `dashboard/test/shared/account-error-labels.test.ts` — label banned (existing, tetap hijau).

**Baseline verification (diukur saat eksekusi, tidak di-fabricate di audit ini):** `bunx tsc --noEmit`; dashboard typecheck (`bun run --filter dashboard typecheck` atau per `package.json`); `bun run test:backend`; `bun test test/protocol`. Suite relevan untuk perbandingan per-finding: `account-batch-delete`, `quota-refresh-authstate`, `account-authmethod`, `provider-status-counts` (dashboard), `providers-pagination` (dashboard). Hitungan pass/fail baseline dicatat sebelum perubahan dan dibandingkan di `## Execution status`.

---

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.2 (D07–D13). Tidak ada yang menunggu jawaban.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D07 | Cooldown = `status='cooldown' OR cooldown_until > now OR model_cooldowns` live. | Mencocokkan badge + `isRecoverable`. |
| D08 | `cooldownUntil`/`modelCooldowns` **dipertahankan** sebagai evidence. | `recoverAccount` membersihkan keduanya; marker sweep (D03) mencegah auto-recovery. |
| D09 | Satu statement, tanpa cap. | Konsisten `PATCH /accounts/batch`. |
| D10 | `globalSkipped` dilaporkan **dan** pasangan `POST /global/accounts/actions/...` (`requireGlobalAdmin`) **dibuat pada iterasi ini**. | Mengganti "global route dibuat pada iterasi ini (D10)" — tidak ada fase lanjutan. |
| D11 | Label `Disable cooldown (n)` / `Delete banned (n)`, count inline. | Pola "selalu mounted, grey out". |
| D12 | Delete banned **strictly** `policy_blocked_banned`; `auth_invalidated` tidak termasuk. | Remediasi auth = ganti credential. |
| D13 | Audit `provider_account.bulk_disabled_cooldowns` / `provider_account.bulk_deleted_banned`. | Eksplisit scope. |

Semua penanda lama di §1–§5
dibaca melalui tabel ini. Koreksi terkait: §3.3 filter tenant-scoped tetap, tetapi
pasangan global route wajib ada (D10); §4 baris "kecuali jika D10 diputuskan memakai
global route" kini berlaku pasti; §3.4 "jika ingin guard defensif" ditolak (D09).

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C3 + C6.

| Finding | Status | Bukti |
| --- | --- | --- |
| F1 (bulk client-side fan-out) | ✅ | `Accounts.tsx` konsolidasi ke `PATCH /accounts/batch` + `POST /accounts/batch-delete`; `provider-detail-bulk-actions.test.tsx`. |
| F2 (tidak ada disable-cooldown massal) | ✅ | `POST /:providerId/accounts/actions/disable-cooldowns` (satu UPDATE, preserve evidence), toolbar `Disable cooldown (n)`; `test/console/provider-detail-bulk-actions.test.ts`. |
| F3 (tidak ada delete-banned) | ✅ | `POST .../delete-banned` (satu DELETE `policy_blocked_banned`), `ConfirmDialog` + toast; audit label baru. |
| F4 (akun shared tidak terjangkau) | ✅ | D10: pasangan `POST /global/accounts/actions/disable-cooldowns` + `delete-banned` (`requireGlobalAdmin`) mendarat di `account-quota-global.ts:226,237`; `globalSkipped` dilaporkan. |
| F5 (pool-as-account guard) | ✅ | Filter SQL/UI mengecualikan `kind === "pool"`; test idempotensi + shared. |
| F6 (konsistensi aksi) | ✅ | Pola "selalu mounted, grey out" + count inline + `ConfirmDialog` dipakai; per-row actions tidak diubah. |

Keputusan D07–D13 diterapkan seluruhnya, termasuk route global yang tidak ditunda.

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
