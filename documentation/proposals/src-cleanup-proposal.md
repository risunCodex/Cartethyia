# Proposal — src/ code cleanup & optimization (12-area audit)

**Status:** ready for execution — audit complete, findings composed from 12 per-area reports.
**Tanggal:** 2026-11-03
**Scope:** `src/` (semua area). Tanpa perubahan behavior; murni refactor + dead-code removal + optimasi.
**Method:** 12 subagent explore paralel, masing-masing membaca lengkap semua `.ts` di areanya, verifikasi dead-symbol via grep seluruh repo (`src/`, `test/`, `scripts/`, `dashboard/src/`), dan menulis report per-area di `documentation/proposals/parts/`.

---

## 1. Ringkasan eksekutif

**345 temuan** terverifikasi. Konsolidasi:

| Area | Report | Total | DEAD | DUP | BLOAT | ANTI | OPT | STALE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| boot/config/workers | 01 | 25 | 5 | 4 | 3 | 8 | 3 | 2 |
| console/api-keys/auth/backup | 02 | 23 | 2 | 8 | 1 | 5 | 4 | 3 |
| console/cli/inferhub/observability | 03 | 27 | 5 | 7 | 3 | 4 | 4 | 4 |
| console/providers/quota/routing | 04 | 29 | 6 | 12 | 3 | 2 | 3 | 3 |
| network + security | 05 | 25 | 4 | 6 | 5 | 4 | 3 | 3 |
| observability + persistence | 06 | 30 | 7 | 6 | 4 | 4 | 5 | 4 |
| protocol | 07 | 25 | 5 | 7 | 4 | 3 | 3 | 3 |
| transport/dispatch/guards/request | 08 | 27 | 2 | 8 | 6 | 7 | 2 | 2 |
| transport/routing/surface | 09 | 28 | 8 | 7 | 3 | 4 | 3 | 3 |
| providers core | 10 | 33 | 7 | 8 | 6 | 4 | 5 | 3 |
| providers integrations A | 11 | 39 | 18 | 7 | 4 | 3 | 4 | 3 |
| providers integrations B | 12 | 34 | 16 | 4 | 4 | 4 | 3 | 3 |
| **Total** | | **345** | **85** | **84** | **46** | **52** | **42** | **36** |

Distribusi: dead code & duplikasi = 169 (49%), anti-pattern = 52 (15%), optimasi = 42 (12%), stale = 36 (10%), bloat = 46 (13%).

**Karakter temuan:** mayoritas adalah (a) exported symbol yang tidak pernah dipakai (85), (b) logika yang ditulis ulang di 2–6 tempat (84), (c) `as unknown as`/`as never` casting yang melubangi typing (52), dan (d) konstanta/dok/perintah usang (36). Tidak ada temuan yang mengubah kontrak publik — semua aman untuk dieksekusi dengan guard typecheck + golden tests.

---

## 2. Rekomendasi prioritas (quick wins dulu)

### Tier 1 — Dead code, aman dihapus (85 findings)
Paling berdampak, risiko terendah. Setiap item sudah diverifikasi zero-caller di seluruh repo:
- **01 D1–D5** — `createNoopMaintenanceLeaseStore`, `growthClientToken`, `requirePublicOrigin`/`oauthCallbackUrl`, `FALLBACK_MEMORY_LIMIT_BYTES`, 4 export test-only.
- **03 D1–D5** — `isAlsoAccountCredential`, `CliToolMappingStore.listAll`, 12 `import type {}` kosong, `summarizeUsagePerformance`, `formatSseFrame`.
- **06 D1–D7** — 6 SQL reader superseded (`summarizeTelemetry`, `healthTelemetry`, `eventByRequestId`, dll), seluruh file-reader test-only di `event-log.ts`, `reset*ForTests` ×3, metric mati.
- **10 #1–#6, #33** — `isDevicePollPending`, `resetJwksVerifiersForTests`, `invalidateQuotaCacheForAccount`, 4 export `client-versions`, `DISCOVERY_BACKED_PROVIDER_IDS`, 5 arm rule-table unreachable, raw credential resolver.
- **11 (18 findings)** & **12 (16 findings)** — cursor protocol dead exports (`decodeMessageSparse`, `buildExecHeartbeat`, dll), `QODER_MODEL_CONFIGS`, `isForeignQoderModel`, Trae path constants, xAI re-exports, dll.

### Tier 2 — Duplikasi, konsolidasi helper bersama (84 findings)
Ekstraksi helper yang dipakai banyak tempat:
- **05 U1–U3 (network/security)** — parser IPv4/IPv6/CIDR di `ssrf.ts` vs `ip-boundary.ts` hampir verbatim. Ekstrak `ip-utils.ts` bersama. **Dampak: menghilangkan duplikasi paling besar di repo.**
- **03 U2** — regex usage-period triplicated; **04 #7** — `escapeHtml` ×3; **04 #9** — `toTokenUsage` ×3; **07 #6–#11** — proyeksi structured-output/tools/file-part/computer-screenshot/malformed-SSE ×3–4.
- **08 #3/#4** — blok credential-resolution ×6 & outbound-fetch ×5 di native handlers.
- **09 #1/#2/#7** — 4 body-unwrap helper, file-block parsing, 4 candidate-builder di route-catalog.
- **10 #7/#12/#14** — fetch-like types ×3, `AbortSignal.any` inline ×5, `quotaLens` vs `targetLens`.
- **12 #1** — session-cache estimator `kiro-cache.ts` vs `trae-cache.ts` identik byte-for-byte.

### Tier 3 — Anti-pattern typing holes (52 findings)
Hilangkan `as unknown as` / `as never` / `as string` yang melubangi strict typing:
- **08 #17/#18/#19/#20** — `as never` scope-hacks, `passThrough(unknown)`, double-cast, `buildUpstreamDispatchContext` opaque.
- **07 #17** — `toWellFormedString` double-cast + fallback regex mati (semua runtime modern punya `toWellFormed`).
- **05 A1–A4** — `{} as never` SOCKS, unchecked `JSON.parse(...) as ResolvedApiKey`, cluster `as unknown as`.
- **10 #21–#24** — capability loader unchecked cast, `as never` insert, re-export shim, double-cast probe.

### Tier 4 — Optimasi hot path (42 findings)
- **07 #20** — memoize `resolveThinkingForModel` (rule table deterministik, dipanggil per encode).
- **10 #25** — `resolveDialect` dihitung dua kali (preparePayload + transformStream).
- **05 O1** — `ValidatedNetworkBindingFactory.fetch()` rebuild closure per request pool.
- **04 #24** — `generateAccountLabel` N×M SELECT pada batch unlabeled.
- **09 #1** — dedupe quota fetch per account saat combo fan-out.
- **03 O1** — double full payload-directory scan per request usage.

---

## 3. Eksekusi yang diusulkan

**Prinsip:** satu area per change, guard penuh, tanpa mengubah behavior. Urutan:

1. **Siapkan baseline** — jalankan `bunx tsc --noEmit` + `bun run test:backend` + protocol suite; catat hasil (saat ini: 4217 pass / 0 fail, protocol 591 pass / 0 fail). Kontrak golden: payload codec byte-identik.
2. **Tier 1 (dead code)** per area, dengan safety net yang sudah terbukti di sweeps sebelumnya:
   - Privatkan dulu (strip `export`), lalu typecheck; hapus hanya yang menghasilkan TS6133/6196; restore export yang ternyata dipakai eksternal.
   - Hapus test yang hanya menguji simbol mati (atau alihkan assertion ke kanoniknya).
3. **Tier 2 (duplikasi)** — ekstrak helper di lokasi kanonik:
   - `src/network/ip-utils.ts` (baru) untuk IP/CIDR; `src/console/shared/` untuk escapeHtml/tokenUsage/ownedAccount; `src/shared/` (sudah ada) untuk hash/UUID/general utils.
   - Konsolidasi codec projections di `src/protocol/translation/` atau `codecs.ts`.
4. **Tier 3 (anti-pattern)** — ganti cast dengan tipe nyata; perbaiki typing di sumber (mis. `RedisClient.eval`, `StaticHandler.body`, `ProviderDispatchContext` typed).
5. **Tier 4 (optimasi)** — memoization/caching terbatas; jangan sentuh path yang butuh verifikasi behavior (mis. `estimatedCountResponse` telemetry gap di 08 #22 — konfirmasi kontrak telemetry dulu).
6. **Verifikasi per area** — typecheck + test area + suite penuh; jalankan suite penuh setelah tiap 2–3 area.

**File pendukung:** detail lengkap per area di `documentation/proposals/parts/01…12.md`.

---

## 4. Risiko & mitigasi

| Risiko | Mitigasi |
| --- | --- |
| Dead-code yang ternyata dipakai via re-export alias / magic string / runtime lookup | Safety net privatisasi→typecheck→restore (terbukti di sweeps sebelumnya); verifikasi grep ulang nama lama |
| Perubahan byte payload codec | Golden tests protocol (591) + test `thinking-ladder`/`dialect` memastikan byte-identik |
| Ekstraksi helper mengubah semantik (mis. precedence summary vs payload di reasoning-text) | `reasoningTextOf(part, { preferSummary })` — pertahankan precedence lama per call site |
| Duplikasi lintas-modul yang ternyata sengaja beda (1500 vs 1600 chars/token) | Satu sumber konstanta + dokumentasi perbedaan deliberate |
| `estimatedCountResponse` telemetry gap | Jangan ubah sampai konfirmasi kontrak telemetry (08 #22) |
| Hapus file yang masih dirujuk doc/CHANGELOG | grep docs setelah tiap penghapusan signifikan; update referensi |

---

## 5. Kriteria selesai

- Typecheck backend & dashboard bersih.
- Backend suite hijau (≥ baseline 4217 pass), protocol suite hijau (≥ 591 pass).
- Tidak ada `export` mati baru (scan ulang per area).
- Tidak ada `any`/`as unknown as`/`as never` baru kecuali yang terdokumentasi di seam backend (db-sqlite/pg).

---

## 6. Catatan penting dari audit

- **08 #22** — `estimatedCountResponse` mem-bypass telemetry finalizer (mutasi `state` langsung). Ini satu-satunya temuan yang berpotensi mengubah behavior; verifikasi kontrak telemetry sebelum perubahan.
- **06 O1/B4/S4** — `telemetry_reconciliation` menulis `files_completed + 0` (bug/kolom mati): fix ke `+ 1` atau drop kolom via forward migration.
- **03 A1** — chart "cached" menampilkan `bucket.inputTokens` (salah label): tambah `cachedInputTokens` di SQL `chartTelemetry` atau drop field.
- **05 D1** — `src/network/response-headers.ts` seluruhnya mati; konfirmasi header stripping memang superseded oleh upstream projection sebelum hapus.
- **04 #22** — `POST /updates/apply` spawn `npm install` detached lalu `process.exit(1500)` tanpa cek exit: jalur destruktif, butuh perbaikan (blokir atau tangani proper).
- **10 #29/#31** — stale: legacy envelope versions v2–v4 di quota cache; daftar paralel id/spec yang harus sinkron.
