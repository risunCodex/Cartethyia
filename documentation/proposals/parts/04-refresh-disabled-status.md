# Proposal — Refresh token/status untuk akun disabled tanpa mengaktifkan ulang

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** authentication/OAuth refresh (`src/providers/authentication/`), quota refresh (`src/providers/quota/refresh.ts`, `src/workers/quota-refresh-sweep.ts`), worker OAuth sweep (`src/workers/oauth-refresh-sweep.ts`), routing (`src/transport/routing/`), console API (`src/console/providers/catalog/`, `src/console/quota/`), dashboard (`dashboard/src/features/provider-detail/`), telemetry/log (`token_refresh`).
**Method:** audit subagent tunggal; `codegraph_explore` + `Read`/`Grep` langsung. Semua klaim behavior mengacu pada kode (file:line). Baseline pass/fail diukur saat eksekusi (lihat §5).

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.4 (D21–D26) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Dua jalur refresh yang terpisah dan berlaku tidak konsisten untuk `disabled`

Ada dua pipeline refresh yang independen, dan keduanya menyentuh akun `disabled` secara berbeda:

**a. OAuth token refresh (`OAuthRefreshService`, `src/providers/authentication/oauth-refresh-service.ts`)**
- Entry point `ensureFreshAccessToken` (`:499-526`) → `#refreshIfDue` (`:528-551`) → `#refreshNow` (`:553-644`).
- **Tidak ada guard status** di `#refreshIfDue`/`#refreshNow`: satu-satunya filter adalah `staticToken` (`:544`) dan `credentialKind === "oauth"` (`:535`). Akun `disabled` yang sampai ke jalur ini tetap di-refresh.
- Satu-satunya filter status ada di **daftar due sweep**: `loadDueOAuthAccounts` (`:435-477`) hanya memilih `["active", "cooldown"]` (`:456`), dengan komentar eksplisit: *"`disabled` stays out — that is an operator decision, and refreshing it would spend a grant on an account that must not return to rotation on its own."* (`:452-455`). Jadi **OAuth sweep global mengecualikan disabled**.
- Hasil refresh sukses: `persistRefreshed` (`:173-219`) menulis `credentialCiphertext`, `expiresAt`, opsional `label`/`authState` — **tidak pernah menyentuh `status`** (`:198-215`).
- Hasil refresh gagal definitif: `disableAccount` (`:244-288`) menulis `status: "disabled"`, `lastErrorCategory: "auth_invalidated"`, dan — hanya jika `resolveAccountDisabledRecoveryMs() > 0` — `cooldownUntil: now + recoveryMs` (`:262-283`).
- Gagal definitif tapi access token masih usable: `markStaticToken` (`:303-318`) — **tidak menyentuh status** (komentar `:296-302`: *"This never changes `status`"*), tapi menghapus `cooldownUntil`, `lastError*` (`:312-315`).
- Boot pass `reconcileStaticTokenAccounts` (`:374-418`) menyapu baris `disabled` + `lastErrorCategory IN (oauth_revoked, auth_invalidated)`; docstring-nya (`:365-367`) mengklaim "moves each … static token, back to `active`", tetapi **kode hanya memanggil `markStaticToken` dan tidak pernah menulis status** — docstring basi.

**b. Quota refresh (`src/providers/quota/refresh.ts`, `src/workers/quota-refresh-sweep.ts`)**
- `listQuotaRefreshTargets` (`:265-280`) **tidak memfilter `disabled`** — hanya mengecualikan `lastErrorCategory = "auth_invalidated"` (`:273-278`). Komentar (`:260-263`): *"Every other credential-bearing account is swept, `disabled` included … skipping it would let a credential die silently."*
- Setiap target melewati `refreshAccountQuota` (`:314-335`) → `runQuotaRefresh` (`:337-464`) → `deps.resolveCredential` → `resolveAccountSecretString` → `resolveCredentialForAccount` (`src/providers/operations/provider-credential-service.ts:222-313`) → `ensureFreshAccessToken` bila due (`:271-283`). **Artinya: akun `disabled` memang di-refresh token-nya setiap menit oleh quota sweep** — secara transitif, bukan sadar.
- `recordAccountCheck` (`refresh.ts:148-206`) hanya menulis untuk baris `status = "active"` (`activeOnly`, `:153-156`, dipakai `:167`, `:188`, `:204`). Untuk akun `disabled`: stamp sukses (`lastSuccessAt`, clear error) dan stamp gagal (`lastError*`, `consecutiveFailures`) **keduanya no-op**. Yang tetap terjadi: cache quota diisi (`:395`), `quotaPlan` diupdate tanpa filter status (`:405-414`), label adopt (`:428-449`).

### 1.2 Akun disabled di routing: hard exclusion, tapi UI tetap menawarkan Test/Recover

- Routing mengecualikan `disabled` keras: `router.ts:279-280` (`health_status === "disabled"` → `eligible: false, reason: "disabled"`), `route-catalog.ts:428` (`ne(status, "disabled")`), `:674` (`if (account.status === "disabled") continue`).
- Health machine juga skip disabled: `recordAccountFailure` return `null` bila `status === "disabled"` (`account-health-service.ts:118`); `recordAccountSuccess` return `false` (`:312`).
- Operator disable vs machine disable: hanya dibedakan oleh ada/tidaknya `cooldownUntil` (`disableAccount` menulis deadline, operator disable tidak; lihat komentar `oauth-refresh-service.ts:275-283`). `sweepExpiredCooldowns` (`account-health-service.ts:406-484`) hanya memulihkan `status = "cooldown"` — `disabled` **tidak pernah** di-sweep (di-pin test `test/providers/disabled-recovery-sweep.test.ts:114-138`).

### 1.3 Jalur yang benar-benar bisa mengaktifkan ulang (bukan refresh)

Enumerasi semua situs `status → "active"` untuk akun (grep `set({ status: "active"` di `src/`):
1. `recordAccountSuccess` — sukses dispatch (`account-health-service.ts:327`); tidak terjangkau akun disabled karena routing mengecualikan.
2. `recoverAccount` — operator Recover (`:371`), tanpa syarat status; dikunci `cooldownUntil` apa pun.
3. `sweepExpiredCooldowns` — hanya `cooldown` (`:433`).
4. `recordResetActivity` — sukses consume rate-limit reset (`src/providers/operations/account-reset-service.ts:685`), tanpa syarat status; di-pin komentar `:663-666`.
5. Re-login OAuth (`src/console/providers/oauth/routes.ts:86-111`, `status: "active"` di `:96`) — operator login ulang.
6. Create/import akun (`catalog/store.ts:1323`, `oauth/routes.ts:131`) — baris baru.
7. Restore backup (`src/console/backup/nine-router.ts:287`, `:500`).

**Tidak ada satu pun jalur refresh token/status yang menulis `status = "active"`.** Klaim requirement "refresh token kemungkinan ikut mengaktifkan ulang" **tidak terbukti di kode saat ini** — yang ada adalah: (a) refresh akun disabled terjadi diam-diam lewat quota sweep, (b) satu docstring basi yang mengklaim "back to active", (c) satu celah UI di mana akun disabled yang kebetulan membawa `cooldownUntil` (dari `disableAccount` pada refresh gagal) menampilkan tombol **Recover** yang — jika diklik — benar-benar mengaktifkan ulang.

### 1.4 UI saat ini untuk akun disabled

- `AccountRow` (`dashboard/src/features/provider-detail/sections/AccountRow.tsx`): baris disabled hanya diatur opasitas (`:272`). Tombol **Test** (`:405-421`, title *"Refresh quota and health for this account"*) **tetap aktif untuk disabled** → memanggil `POST /accounts/:id/quota/refresh` (`hooks/quota.ts:123-146`), yang di server memuat akun apa pun statusnya (`account-quota-tenant.ts:585-604`, tanpa filter status) dan bisa memicu refresh token. Tombol **Enable/Disable** (`:231-249`, `:466-477`). Tombol **Recover** (`:478-489`) muncul jika `isRecoverable` (`:186-188`) = `status === "cooldown" || hasActiveCooldown`.
- `AccountStatusBadge` (`AccountStatusBadge.tsx:132-151`): cabang `disabled` menampilkan kategori error (`auth_invalidated` → "Re-login required", `:137-147`); `markStaticToken` menghapus kategori ini, sehingga akun disabled yang diverifikasi static kehilangan keterangan alasan.
- Tidak ada tombol/aksi "refresh token" eksplisit per akun di mana pun; satu-satunya "refresh" per-akun adalah Test (quota) — dan di baliknya refresh token hanya terjadi jika token sudah due.

### 1.5 Ringkasan temuan

| # | Temuan | Verdict | Behavior change? | Severity | Effort |
| --- | --- | --- | --- | --- | --- |
| F1 | Refresh token/status **tidak pernah** menulis `status`; klaim "refresh mengaktifkan ulang" tidak terbukti. `persistRefreshed` (`oauth-refresh-service.ts:173-219`) & `markStaticToken` (`:303-318`) tidak menyentuh status; semua situs aktivasi enumerated di §1.3. | konfirmasi (tidak ada bug aktivasi otomatis) | tidak | — | — |
| F2 | Akun disabled **sudah** di-refresh token-nya setiap menit lewat quota sweep (`listQuotaRefreshTargets`, `refresh.ts:265-280`, termasuk disabled), sementara OAuth sweep mengecualikannya (`loadDueOAuthAccounts`, `oauth-refresh-service.ts:456`). Inkonsisten dan tidak terlihat di UI. | gap | ya (perlu explicit policy) | MED | S/M |
| F3 | `markStaticToken` menghapus `lastErrorCategory` bahkan untuk akun disabled (`oauth-refresh-service.ts:312-315`) → akun disabled kehilangan pill "Re-login required" (diagnosa hilang) setelah boot pass / refresh gagal+token usable. | gap | ya (jika disepakati) | MED | S |
| F4 | Docstring `reconcileStaticTokenAccounts` mengklaim "back to active" (`oauth-refresh-service.ts:365-367`) padahal kode tidak; berisiko misleads perubahan berikutnya. | konfirmasi (doc basi) | tidak | LOW | S |
| F5 | Akun **operator-disabled** yang kena `disableAccount` (refresh gagal definitif) menerima `cooldownUntil` (`oauth-refresh-service.ts:281-283`) → terlihat "recoverable" di UI (`AccountRow.tsx:186-188`) → tombol Recover muncul (`:478-489`) dan klik-nya mengaktifkan ulang (`account-health-service.ts:368-388`). Bukan otomatis, tapi mengaburkan pembeda operator-vs-machine disable. | gap | ya (perlu keputusan) | MED | S/M |
| F6 | Tidak ada aksi eksplisit "refresh token" per akun di UI maupun endpoint console khusus; satu-satunya jalur manual adalah Test (quota refresh) yang tujuan utamanya quota, bukan token — dan untuk disabled, stamp hasilnya no-op (`recordAccountCheck` activeOnly, `refresh.ts:153-156`) sehingga "Last check" tidak pernah ter-update. | gap | ya (perlu) | HIGH | M |

---

## 2. Masalah yang diminta diatasi

Requirement: akun berstatus `disabled` tetap bisa me-refresh token/status-nya (mis. dari halaman provider detail atau via sweep), tetapi refresh itu **tidak boleh** mengubah statusnya kembali menjadi `active`.

Diterjemahkan ke masalah konkret pada perilaku sekarang:

1. **Tidak ada kontrak eksplisit "refresh ≠ aktivasi".** Tidak ada kode yang melanggar sekarang (F1), tetapi tidak ada juga mekanisme yang *memastikan* itu — dan satu docstring bahkan mengklaim sebaliknya (F4). Ini butuh dibuat eksplisit: guard + test yang mengunci.
2. **Refresh akun disabled terjadi diam-diam dan tidak konsisten** (F2): quota sweep menyentuhnya, OAuth sweep tidak; tidak ada observability yang menyatakan "token akun disabled di-refresh". Operator tidak bisa tahu status token akun yang di-disable.
3. **Tidak ada affordance.** Dari halaman provider detail, satu-satunya cara memaksa refresh untuk akun disabled adalah tombol Test (quota) — yang tidak memberi tahu bahwa token ikut di-refresh, dan untuk disabled tidak men-stamp baris (F6).
4. **Celah Recover** (F5): akun disabled bisa menampilkan tombol Recover (akibat `cooldownUntil` dari `disableAccount`), dan itu satu-satunya jalan "tidak sengaja" mengaktifkan ulang akun yang sengaja di-disable. Tidak terkait refresh, tapi satu paket dengan "status akun disabled harus tetap juny".

---

## 3. Desain yang diusulkan

### 3.1 Prinsip

- **Refresh ≠ status.** Tidak ada jalur refresh (token maupun quota) yang boleh menulis kolom `status`. Invariant ini dijaga oleh guard di satu titik pusat + test yang mengunci (di bawah).
- **Disabled tetap disabled.** Setiap jalur refresh yang menjangkau akun `disabled` wajib mempertahankan `status = "disabled"` dan tidak boleh menulis `cooldownUntil` yang membuatnya tampak recoverable, (D23).
- **Default off untuk perubahan sweep.** Perubahan perilaku sweep default-nya opt-in / berhati-hati: yang sudah menyentuh disabled (quota sweep) dipertahankan; yang belum (OAuth sweep) tidak diubah (D21).
- **Satu titik orkestrasi.** Semua refresh token (dispatch, quota, sweep, manual UI) tetap lewat `OAuthRefreshService.ensureFreshAccessToken` — tidak ada jalur kedua yang bisa melupakan invariant.

### 3.2 Refactor kecil: pisahkan "persist hasil refresh" dari "mutasi kesehatan"

Di `src/providers/authentication/oauth-refresh-service.ts`:

- `persistRefreshed` (`:173-219`) sudah murni credential (tidak menyentuh status) — biarkan, tapi tambahkan komentar batas eksplisit: *"This function must never write `status`; a refresh is not a health verdict."* Tambahkan asersi dev-time (wajib, D21): jika `set` mengandung `status`, throw.
- `disableAccount` (`:244-288`): tambahkan argumen/guard `preserveOperatorDisable` — bila baris sudah `disabled` **tanpa** `cooldownUntil` (operator disable), jangan menulis `cooldownUntil` (F5). Ini mempertahankan semantik "operator disable tidak pernah di-recover" yang di-pin `disabled-recovery-sweep.test.ts:127-138`.
- Ganti docstring `reconcileStaticTokenAccounts` (`:365-367`) agar sesuai kode: *"… static token; the account stays `disabled`; only an operator can re-enable it."* (F4, doc-only).
- **Fungsi observasi baru** `refreshAccountStatus(accountId, opts): Promise<RefreshAccountStatusOutcome>` (di `oauth-refresh-service.ts`, atau modul kecil `src/providers/operations/account-refresh-status.ts`):
  - memuat akun (proyeksi: status, credentialKind, staticToken, refreshCiphertext),
  - menolak untuk non-OAuth (`api_key`/`none`) dengan `{error: "not_oauth"}`,
  - menolak untuk `staticToken` dengan `{error: "static_token"}`,
  - untuk `disabled`: **mengizinkan** refresh token (memanfaatkan `ensureFreshAccessToken(accountId, refresher, {force: true})` yang sudah ada — force path sudah punya single-flight sendiri, `:509`),
  - mengembalikan `{ ok: true, tokenRefreshed: true, statusAfter: "disabled", expiresAt, refreshedAt }` atau `{ ok: false, statusAfter: "disabled", error, category, message }` — **tidak pernah** `statusAfter: "active"`.
  - Guard: `statusAfter` selalu diambil dari baris yang baru dibaca ulang setelah refresh, bukan dari input.
- `ensureFreshAccessToken` sendiri tidak diubah signature-nya (blast radius besar: 20+ caller); invariant dijaga di lapisan persist.

### 3.3 Console API

Endpoint baru di `src/console/providers/catalog/routes.ts` (mengikuti pola `recover`, `:404-411`):

```
POST /providers/:providerId/accounts/:accountId/refresh-token
```

- Otentikasi: `dashboard:write` (`requireTenantScope`, pola route lain).
- Implementasi di `provider-operations.ts` (mirror `recoverAccount`, `:700-711`): panggil `refreshAccountStatus`, catat `adminAuditLog`/health event (`token_refresh`), return `{ ok, statusAfter, error?, category? }`.
- **Tidak mengubah status**; khusus akun `disabled` respons selalu `statusAfter: "disabled"`.
- 404 bila akun tidak ada / salah provider; 409 bila `staticToken`; 400 bila non-OAuth.

### 3.4 Dashboard/UI

- `AccountRow.tsx`: tambahkan tombol ikon **Refresh token** (`RefreshCw`), untuk baris non-pool dengan `credentialKind === "oauth"` dan `!staticToken` — **tersedia di semua status, termasuk `disabled`** (di sinilah affordance untuk disabled berada).
  - Tooltip: "Refresh OAuth token only — status unchanged". Untuk `disabled`: teks tombol tetap, toast sukses: *"Token refreshed — account remains disabled"*.
  - Hook baru `useRefreshAccountToken(providerId, accountId)` di `dashboard/src/hooks/providers.ts` (pola `useRecoverAccount`, `:492-520`); `onSuccess` invalidate `queryKeys.providers.accounts(providerId)`, `queryKeys.providers.healthEvents(...)`, `queryKeys.providers.all`.
  - Jangan mengubah tombol Enable/Disable; jangan menambah tombol Recover untuk disabled (F5 diselesaikan di server, §3.2, sehingga `isRecoverable` hanya true untuk cooldown sungguhan).
- `AccountStatusBadge.tsx`: tidak berubah strukturnya; (D24), `markStaticToken` tidak lagi menghapus `lastErrorCategory` untuk baris `disabled` sehingga pill "Re-login required" tetap tampil.

### 3.5 Sweep global: kebijakan eksplisit

- **Quota sweep** (`listQuotaRefreshTargets`, `refresh.ts:265-280`): pertahankan penyertaan `disabled` (sudah menjadi perilaku, dan itu memang yang menjaga token akun disabled tetap hidup) — tetapi tambahkan (a) komentar yang menyebut invariant "never flips status", (b) log `token_refresh` yang sudah ada sudah mencakupnya (event `token_refresh` di `oauth-refresh-service.ts:558-562`), tambah field `origin: "sweep:quota"` (D26).
- **OAuth sweep** (`loadDueOAuthAccounts`, `oauth-refresh-service.ts:456`): **biarkan mengecualikan disabled** (default off; itu juga perilaku sekarang yang di-pin komentar). Perubahan ditolak (D21).
- Tidak ada perubahan interval/budget.

### 3.6 Observability

- Event `token_refresh` (`oauth-refresh-service.ts:558-622`) sudah mencatat `accountId` + `providerId` + `errorCode`; tambahkan `statusBefore` (dan `statusAfter` yang selalu sama) pada log refresh untuk akun disabled — biaya nihil, memungkinkan dashboard/audit membuktikan "refresh tidak mengubah status".
- Health event: `refreshAccountStatus` menulis `health_events` dengan `fromStatus = toStatus = "disabled"` saat sukses (pola non-mutating yang sudah ada, `account-health-service.ts:84-96`).

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| OAuth refresh service | `src/providers/authentication/oauth-refresh-service.ts` (guard `persistRefreshed`, `disableAccount` + preserveOperatorDisable, docstring F4, `refreshAccountStatus` baru) |
| Operations baru | `src/providers/operations/account-refresh-status.ts` (baru, jika tidak digabung ke oauth-refresh-service) |
| Console API | `src/console/providers/catalog/routes.ts` (route `refresh-token`), `src/console/providers/catalog/provider-operations.ts` (handler), `src/console/providers/catalog/contracts.ts` (respons type) |
| Quota refresh | `src/providers/quota/refresh.ts` (komentar invariant; `origin`, D26), `src/workers/quota-refresh-sweep.ts` (`origin`, D26) |
| Routing | tidak ada perubahan perilaku (`router.ts:279-280`, `route-catalog.ts` tetap); hanya verifikasi |
| Dashboard | `dashboard/src/hooks/providers.ts` (`useRefreshAccountToken`), `dashboard/src/features/provider-detail/sections/AccountRow.tsx` (tombol), `AccountStatusBadge.tsx` (D24) |
| Telemetry/health | `src/providers/authentication/oauth-refresh-service.ts` (log `statusBefore`), `src/providers/operations/account-health-service.ts` (pakai ulang `writeHealthEvent` — tidak berubah) |

---

## 5. Migrasi & risk

**Migrasi:** tidak ada. Tidak ada kolom/tabel baru; `status` sudah ada (`src/persistence/schema.ts:109`). Semua perubahan adalah guard + endpoint + UI.

**Backward compatibility:**
- Perilaku eksisting dipertahankan: quota sweep tetap menyentuh disabled; OAuth sweep tetap mengecualikan disabled; `ensureFreshAccessToken` signature tidak berubah.
- `disableAccount` + preserveOperatorDisable adalah **satu-satunya perubahan perilaku** (§3.2): akun operator-disabled yang kena refresh gagal tidak lagi menerima `cooldownUntil`. Ini menghilangkan F5 (tombol Recover pada disabled) — perubahan kecil namun berlaku pasti (D23).

**Risk & mitigasi:**
- *Regresi aktivasi otomatis di masa depan* → dikunci test (di bawah) yang menegaskan `status` tidak berubah pada sukses, gagal transient, gagal definitif, dan boot pass.
- *Refresh akun disabled tidak sengaja "menghidupkan" di UI* → `refreshAccountStatus` selalu mengembalikan `statusAfter` hasil baca ulang; dashboard menampilkan toast "remains disabled".
- *Quota sweep menyentuh disabled sudah terjadi* → tidak ada risiko baru; yang baru adalah observability-nya.
- *Perubahan `disableAccount`* → hanya memengaruhi baris `disabled` tanpa `cooldownUntil` (operator disable); machine disable (dengan deadline) tetap menulis deadline seperti sekarang.

**Test list (proof-of-design):**
- `test/providers/static-token-detection.test.ts` — sudah mengunci disabled→disabled pada boot pass (`:182-212`); tambah kasus: refresh sukses pada akun disabled → status tetap disabled; gagal definitif + token usable → status tetap disabled + static marker; gagal definitif + token unusable → tetap disabled + `auth_invalidated`.
- `test/providers/disabled-recovery-sweep.test.ts` — sudah mengunci sweep tidak pernah re-enable disabled (`:114-138`); tambah kasus `disableAccount` pada operator-disabled tidak menulis `cooldownUntil`.
- `test/providers/oauth-refresh-timeout.test.ts` — baseline timeout refresh (tidak berubah).
- Baru `test/providers/refresh-disabled-status.test.ts` — `refreshAccountStatus`: non-OAuth ditolak, staticToken ditolak, disabled diizinkan + `statusAfter: "disabled"`, outcome error ter-struktur.
- Baru `test/console/provider-account-refresh-token.test.ts` — route `POST .../refresh-token`: 200 untuk disabled (statusAfter disabled), 409 staticToken, 404 unknown account, audit log ditulis.
- Dashboard: `dashboard/test/features/...` — tombol Refresh token tampil untuk OAuth non-static, tidak untuk api_key/pool; toast "remains disabled" untuk disabled.

**Baseline verification (diukur saat eksekusi, tidak di-fabricate di audit ini):** `bunx tsc --noEmit`; `bun run test:backend` (`bun run scripts/test/run.ts --scope backend`); `bun test test/protocol`. Suite relevan untuk perbandingan per-finding: `static-token-detection` (F1/F3/F4), `disabled-recovery-sweep` (F5), `oauth-refresh-timeout` (F1), `account-health-invalidation`, suite console providers (`provider-list-overview`, `zcode-gifts`), suite dashboard providers. Hitungan pass/fail baseline dicatat sebelum perubahan dan dibandingkan di `## Execution status`.

---

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.4 (D21–D26). Tidak ada yang menunggu jawaban.
(Catatan: audit awal menggabungkan butir 5 dan 6 dalam satu baris; keduanya
dipisahkan dan dikunci di sini.)

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D21 | Split sweep dipertahankan: quota sweep menyentuh `disabled`, OAuth sweep mengecualikan. | Sudah berjalan; tidak ada beban upstream tambahan. |
| D22 | Tidak ada env/konfigurasi baru — `OAUTH_REFRESH_DISABLED_ACCOUNTS` **ditolak**. | Yang dibutuhkan invariant + test, bukan flag. |
| D23 | `disableAccount` **tidak** menulis `cooldownUntil` ke operator-disabled (F5). | Menutup Recover-palsu; machine disable tetap menulis deadline. |
| D24 | `markStaticToken` **mempertahankan** `lastErrorCategory` untuk baris `disabled` (F3). | Pill "Re-login required" tetap tampil. |
| D25 | Endpoint terpisah `POST .../refresh-token`; `quota/refresh` tidak diperluas. | Semantik token ≠ quota; `recordAccountCheck` tetap active-only. |
| D26 | Observability: `origin` (`ui`/`sweep`/`dispatch`), `statusBefore`, `statusAfter` + health event non-mutating. | Membuktikan "refresh tidak mengubah status". |

Semua `D21`/`D23`, "kecuali secara eksplisit disetujui", "(D21)",
penanda lama di §1–§5 dibaca
melalui tabel ini. Koreksi terkait: §3.2 asersi dev-time **tidak** opsional
(dijadikan guard pasti), §3.4 `AccountStatusBadge.tsx` tetap tersentuh lewat D24,
§3.5 `origin` wajib ditambahkan (D26), §5 "berlaku pasti (D23)" kini berlaku pasti.

---

## 7. Execution status

**Status: ✅ executed (full)** — klaster C5 + orkestrator.

| Finding | Status | Bukti |
| --- | --- | --- |
| F1 (refresh tidak pernah menulis status) | ✅ | Invariant dikunci di `persistRefreshed` (komentar + asersi dev-time); `refresh-disabled-status.test.ts` — sukses/gagal transient/gagal definitif/boot pass tetap tidak mengubah status. |
| F2 (quota sweep menyentuh disabled, OAuth tidak) | ✅ | Split dipertahankan (D21); `refresh.ts` komentar invariant + `origin: "sweep:quota"` (D26). |
| F3 (`markStaticToken` menghapus kategori) | ✅ | D24: kategori dipertahankan untuk baris `disabled`; pill "Re-login required" tetap tampil. |
| F4 (docstring basi) | ✅ | `reconcileStaticTokenAccounts` docstring diperbaiki ("stays disabled"). |
| F5 (Recover-palsu pada operator-disabled) | ✅ | `preserveOperatorDisable` di `disableAccount` (D23); `disabled-recovery-sweep.test.ts` kasus baru. |
| F6 (tidak ada affordance refresh token) | ✅ | `refreshAccountStatus` + `POST .../refresh-token` + tombol `Refresh token` di `AccountRow` (semua status, termasuk disabled); `provider-account-refresh-token.test.ts` 200/409/404 + audit; dashboard `account-refresh-token.test.tsx` 7 pass. |

Keputusan D21–D26 diterapkan seluruhnya. Deviasi orkestrator: `category` pada refresher yang melempar kini membawa pesan as-is lewat `reportingRefresher` (bukan generik), sejalan semangat area 08; fixture test dibuat unik per kasus (unique constraint `credential_fingerprint`).

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
