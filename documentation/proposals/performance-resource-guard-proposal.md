# Proposal — performance & resource-guard pass (SSE, startup/RAM, Providers page, account ops, CPU/mem guard)

**Status:** ✅ executed (local, unpushed)
**Tanggal:** 2026-11-03
**Scope:** dashboard SSE frontend, gateway startup/deps/RAM, Providers page load, account batch/delete/recovery, dan guard CPU/memory foreground-vs-background.
**Method:** 5 subagent audit paralel (SSE, startup/RAM, Providers page, account ops, spike guard). Semua read-only, belum ada edit. Baseline suite hijau (backend 4258 pass / 0 fail, protocol 605 pass / 0 fail).

---

## 0. Kesimpulan utama

Masalah yang kamu lihat ("buka Providers/accounts/proxy → spike CPU & mem, foreground lag") punya **3 akar konkret**:

1. **Providers page fan-out 2N request** — tiap card mount `useProviderModels` + `useProviderAccounts` sekaligus (~100–140 request saat cache cold), tiap accounts request menghitung ulang aggregate telemetry (GROUP BY) + double-compute inflight (listAccounts dijalankan 2× per provider).
2. **Semua background & foreground satu event loop** — sweep (quota/oauth/health), telemetry flush, gzip sinkron, dan rebuild snapshot catalog semuanya jalan di loop yang sama. Saat page open + sweep bareng → spike. Tidak ada keb "foreground vs background".
3. **Rebuild snapshot catalog terjadi LAZY di request path** — invalidate → rebuild 13 SELECT + fan-out + deepFreeze dibayar oleh request berikutnya (termasuk page open).

---

## 1. SSE frontend / cutoff (Area A)

### Findings
| # | Temuan | Severity | Effort |
|---|---|---|---|
| S-01 | **No backoff pada reconnect** — fixed 3s (notifications) / 5s (semua stream lain). Saat gateway down, tiap tab × tiap stream retry tiap 5s selamanya (~1.2 req/s/tab). | HIGH | S |
| S-02 | **No server-side idle/max-age cutoff** — stream hidup selamanya (heartbeat 25s); tab abandoned menahan subscription + timer. | HIGH | S–M |
| S-03 | **Per-connection sampling timers** — `/notifications/stream` jalankan `liveMemory()` tiap 30s + `fetchRelease()` tiap 60s PER koneksi; share-stats 30s rollup per koneksi. Linear dengan jumlah tab. | MED | M |
| S-04 | **Double-delivery update** — `/notifications/stream` (SSE, 60s) vs `useLatestRelease` poll `/updates/release` tiap 30 menit. Sama-sama cek GitHub release. | MED | M |
| S-05 | **Usage page buka 2 stream terkait** — `useInFlight` + `useRequestsStream` (2 koneksi + 2 preflight, data dari request-state store yang sama). | MED | M |
| S-06 | **6 hook SSE hand-rolled** — tiap hook duplikasi EventSource+preflight+onerror+timer+generation guard (~200 baris duplikat). | MED | M |
| S-07 | Pool health double-path: SSE health events + poll 10s di dialog; 2 hook pool-health copy-paste. | LOW | S |
| S-08 | `sender.send` re-stringify + TextEncoder baru per frame. | LOW | S |

### Fix yang diusulkan
- **S-01** ✅ shared exponential backoff + jitter (2s → 60s cap, reset on open) untuk semua reconnect (`use-console-event-source.ts`).
- **S-02** ✅ `createConsoleSseStream` tambah max lifetime + idle-timeout yang close graceful; client reconnect logic reopen.
- **S-03** ✅ sampler sekali per gateway (proses) → subscriber set (pola `subscribePoolHealth`), bukan per-koneksi (updates + share-stats).
- **S-04** ✅ unify update delivery ke notifications stream; `useLatestRelease` jadi cold-start fallback saja (fetch sekali on mount, never polled). Poll 3s `/updates/status` dipertahankan hanya saat apply (gateway restart saat install, SSE tidak reliable) sebagai fallback.
- **S-05** ✅ merge `useInFlight` + `useRequestsStream` jadi 1 stream + 1 preflight.
- **S-06** ✅ extract `useConsoleEventSource` hook bersama (auth-preflight, visibility gate, backoff, cleanup).
- **S-07** ✅ unify 2 hook pool-health; health event stream menggantikan poll 10s di `PoolHealthDialog`.
- **S-08** ✅ TextEncoder module-level + encode sekali.

---

## 2. Startup / dependencies / RAM (Area B)

### Findings
| # | Temuan | Severity | Effort |
|---|---|---|---|
| B-01 | **`bundledModelCatalog` load 73 provider di boot (sebelum listen)** — `deps.ts:235` dynamic-import semua integration module (qoder.ts 78KB, cursor-catalog, trae-catalog, gemini) + seed ke DB. Ini blok modul-evaluasi + DB-write terbesar di pre-listen. | HIGH | S–M |
| B-02 | **Console-router & workers statically import integration module** — `oauth/routes.ts:10` → kiro-oauth (58KB); `account-quota-tenant.ts` → buddy-usage-store/buddy-oauth-shared; `account-quota-shared.ts` → cline-quota; `provider-operations.ts` → buddy-identity; workers buddy/daily-checkin import buddy/qoder. Semua masuk eager boot graph. | HIGH | M |
| B-03 | `systray2` (10.9MB!) cuma dipakai tray CLI; `enquirer` CLI-only; `pino-pretty` dev-only TTY. → devDependencies (hemat ~11.3MB / ~30% tree). | LOW | S |
| B-04 | Unbounded caches: `THINKING_RESOLVE_CACHE`, `DIALECT_RESOLVE_CACHE`, BYOK fingerprints. | LOW–M | S |
| B-05 | Worker first-minute contention: quota-refresh (delay 20s), account-health (5s), client-version (10s, external fetch). | MED | S–M |
| B-06 | `--smol`/JSC flags — riset internal sengaja hindari (neutrality); jadikan eksperimen terpisah, bukan default. | LOW | S |

### Fix yang diusulkan
- **B-01** ✅ defer `bundledModelCatalog` ke first snapshot build (post-listen warm) — hilangkan 73 dynamic import + DB-write dari pre-listen path.
- **B-02** ✅ ubah import statik konsol/worker itu jadi dynamic import di dalam fungsi pemakai (guard `no-dynamic-imports-in-shipped.test.ts` diperluas ke console/workers; semua 8 site escape-hatch berkomentar).
- **B-03** ✅ pindah `pino-pretty` ke devDependencies; `systray2`/`enquirer` dipertahankan di dependencies (CLI ships via bin, butuh tray/prompt saat install produksi).
- **B-04** ✅ pakai `BoundedLruMap`/size cap untuk 3 cache (thinking resolver, dialect resolver, BYOK fingerprints).
- **B-05** ✅ client-version monitor initial delay 10s→90s; OAuth refresh & buddy sweeps dapat `budgetMs`; account-health interval 30s→60s; `CARTETHYIA_DISABLED_TASKS` didokumentasikan di `installation.md` + `configuration.md`.

---

## 3. Providers page load (Area C)

### Findings
| # | Temuan | Severity | Effort |
|---|---|---|---|
| P-01 | **Fan-out 2N request saat mount** — tiap card (termasuk section collapsed) fire `useProviderModels` + `useProviderAccounts`. ~100–140 request. | HIGH | M |
| P-02 | **`readRoutingAccountInflight` re-run `listAccounts` penuh** — `boot/dependencies.ts:437` panggil `inflightStore.listAccounts` (yang hitung today/lifetime usage aggregates lagi) cuma untuk ambil id set. Double compute per provider. | HIGH | L–M |
| P-03 | `/providers/:id/models` ambil full rows per provider cuma untuk `.length` (badge). | MED | L |
| P-04 | **Tidak ada cache server** di endpoint provider — `/providers`, `/models`, `/accounts` dihitung ulang tiap request (poll 60s re-run semuanya). | MED | M |
| P-05 | Full account DTO (usage+inflight) untuk badge-only rendering; `listAllAccountSummaries` sudah ada tapi page tetap fetch accounts penuh. | MED | M |

### Fix yang diusulkan
- **P-01 + P-03** ✅ embed di `/providers`: per-provider `{accountCount, activeAccountCount, modelCount}` dari 2 grouped query (`providerAccountCounts`/`providerModelCounts` di store); card render dari list payload, `useProviderModels`/`useProviderAccounts` dihapus dari card (detail page tetap pakai).
- **P-02** ✅ `readRoutingAccountInflight` select **hanya `id`** dari `provider_accounts` — hilangkan aggregate telemetry double-compute.
- **P-04** ✅ wrap `listProviders` di `cachedReadWithEtag` TTL pendek → poll 60s jawab 304; invalidate via snapshot invalidator (test ETag 304 + invalidation menyusul).
- **P-05** ✅ dikerjakan lewat P-01 (badge dari list counts, bukan full DTO) — tidak perlu `?summary=1` terpisah.

---

## 4. Account batch / delete / recovery (Area D)

### Findings
| # | Temuan | Severity | Effort |
|---|---|---|---|
| A-01 | **Execute batch (`POST /quota/daily-growth`) sinkron di request** — per account: 2 upstream HTTP + credential resolve + ledger stamp; chunked 3 parallel serial (⌈N/3⌉), tanpa global timeout/signal. Response nunggu semua selesai. | HIGH | M |
| A-02 | **Dashboard bulk delete/recover pakai `Promise.allSettled` unbounded** — N account → N request paralel, N commit, N audit, N invalidate (spike burst). `mapWithConcurrency` sudah ada tapi tidak dipakai. | HIGH | L |
| A-03 | Quota refresh: worker pool 5 + 15s budget (ok) tapi tetap sinkron menunggu semua account. Probe-all bounded 10. | MED | M |
| A-04 | Delete endpoint per-id kecil; cascade ok; tapi `daily_checkin_ledger.accountId` **tanpa FK** → orphan saat delete. | LOW | L |
| A-05 | Recovery reset (`POST /accounts/:id/reset`) — sampai 3 serial upstream call per account tanpa timeout; `GET /accounts/:id/resets` hit upstream live tiap open dialog tanpa cache. | MED | M |

### Fix yang diusulkan
- **A-01** ✅ daily-growth dipindah ke background job (`daily-growth-job.ts`: registry in-process, state queued/running/done/failed, bounded concurrency 3, budget per-leg, anti double-claim dengan in-flight set + `checkinAttemptedToday`); route return cepat 202 `{ jobId }` + `GET /quota/daily-growth/status/:jobId`.
- **A-02** ✅ `runBulk` di dashboard ganti `Promise.allSettled` → `mapWithConcurrency(selectedAccounts, 3, fn)` (delete/recover/enable/disable).
- **A-03** ✅ server-side `POST /accounts/batch-delete` (tenant) + `POST /global/accounts/batch-delete` — 1 statement `WHERE id IN (...)`, 1 audit, 1 invalidate, return `{ ok, deleted, missing }`.
- **A-04** ✅ wiring timeout/signal ke daily-growth & reset legs (AbortSignal.any + budget); FK `daily_checkin_ledger.accountId` ditambahkan (migration forward `0041`, kedua backend, onDelete cascade).
- **A-05** ✅ cache `listAccountResetCredits` per account TTL pendek + timeout signal.

---

## 5. Guard spike CPU/mem foreground vs background (Area E) — inti permintaanmu

### Findings (akar spike)
| # | Temuan | Severity | Effort |
|---|---|---|---|
| G-01 | **Semua background & foreground satu event loop** — tidak ada worker_threads untuk sweep; gzip sinkron untuk tiap response console; Lite mode (bun:sqlite) query sinkron di C block loop saat aggregate berat. | HIGH | Besar |
| G-02 | **Rebuild snapshot catalog LAZY di request path** — invalidate → request berikutnya bayar 13 SELECT + fan-out + deepFreeze; sweep account-health sering invalidate saat banyak recovery. | HIGH | M |
| G-03 | **Gate background tidak peduli foreground** — single-flight antar-task saja; tidak ada semaphore/prioritas "foreground vs background", tidak ada idle-only scheduling. | HIGH | M |
| G-04 | Quota sweep 40 account/pass + check-in ride-along; OAuth sweep tanpa budget; buddy scan semua account. | MED | S |
| G-05 | Page open triger aggregate DB berat (2N accounts request, tiap dengan GROUP BY telemetry). | HIGH | M (terkait P-01/P-02) |

### Desain guard yang diusulkan
- **G-01a (server cheaper payloads)** ✅ P-01/P-02/P-04 (overview endpoint, inflight id-only, cache ETag) — hilangkan mayoritas spike saat buka page.
- **G-01b (gzip sinkron)** ✅ `response-compression.ts` — skip gzip utk payload kecil di bawah threshold (1KB); SSE (`text/event-stream`) tetap dikecualikan.
- **G-02 (rebuild eager + debounce)** ✅ saat invalidate → rebuild di background segera (eager), serve snapshot lama sampai yang baru siap; debounce invalidation ~500ms; single-flight guard. **Ini kandidat #1 bunuh spike memory di page open.**
- **G-03 (InvokeGuard)** ✅ counter + timestamp aktivitas foreground (route console bump counter; proxy inFlight source). `ScheduledTaskRegistry` consult sebelum tick & antar-wave → defer kalau busy (pause bounded, bukan skip). **Ini jawaban langsung "invoking tidak terganggu & foreground tidak lag".**
- **G-04** ✅ beri `budgetMs` ke OAuth & buddy sweep; stagger lebih sistematis; naikkan account-health interval 30s→60s (paling sering invalidate).
- **G-05 (client-side)** ✅ lazy mount per-section (visibility gate) — hanya section visible yang mount card data-bearing; `staleTime` accounts 30s→120s; debounce invalidasi pools dari SSE health (2s).
- **G-lower** ✅ naikkan floor TelemetryBatchBuffer di bawah load (min 200ms) supaya flush tidak tabrakan dengan baca console.

---

## 6. Prioritas & urutan eksekusi

### Batch 1 — "bunuh spike" (High impact, Medium effort)
1. **P-01/P-03** — endpoint `/providers/overview` + card render dari list (potong 2N → 1).
2. **P-02** — inflight id-only (hilangkan double-compute telemetry).
3. **G-02** — rebuild snapshot eager + debounce (serve lama sampai baru siap).
4. **A-02** — `mapWithConcurrency` 3 di bulk delete/recover (1 baris).

### Batch 2 — guard & background (jawaban "invoking tidak terganggu")
5. **G-03** — `InvokeGuard` (foreground counter; scheduler defer saat busy).
6. **A-01** — daily-growth/quota-refresh → background job + status.
7. **G-04/B-05** — budget OAuth/buddy + stagger + interval health 60s.
8. **A-03** — server batch-delete endpoint.

### Batch 3 — startup & RAM
9. **B-01** — defer bundledModelCatalog ke snapshot warm.
10. **B-02** — lazy-import console/worker integration modules.
11. **B-03** — pindah systray2/enquirer/pino-pretty ke devDependencies.
12. **B-04** — bound 3 cache.

### Batch 4 — SSE & sisa
13. **S-01/S-02** — backoff + server cutoff.
14. **S-03/S-04/S-05/S-06** — single sampler, unify update, merge in-flight stream, shared hook.
15. **P-04/A-05/G-01b** — ETag cache, reset cache, gzip threshold.
16. **S-07/S-08/B-05/A-04/G-05** — sisanya (pool hook, encoder, orphan FK, client lazy mount).

**Estimasi total: ~3–4 hari kerja.** Semua local, no push. Marker ✅/⛔ di-update di proposal ini setelah eksekusi.

---

## 7. Validasi

Per batch: `bunx tsc --noEmit` (backend + dashboard) + `bun run test:backend` + `bun test test/protocol` + `bun run dashboard:typecheck`. Baseline: backend 4258 pass / 0 fail, protocol 605 pass / 0 fail. Untuk perubahan UX (page render, SSE), verifikasi manual via agent-browser.

### Hasil validasi eksekusi (2026-11-03)
- `bunx tsc --noEmit` — 0 error (backend + dashboard).
- `bun run test:backend` — **4270 pass / 3 skip / 0 fail** (exit 0).
- `bun run dashboard:typecheck` — 0 error.
- `bun run dashboard:test` — **606 pass / 0 fail**.
- Guard `no-dynamic-imports-in-shipped.test.ts` — hijau (8 site escape-hatch berkomentar `// dynamic-import:`).
- `config-reference.test.ts` — hijau setelah regenerate `documentation/reference/configuration.md` (blok manual `CARTETHYIA_DISABLED_TASKS` diganti generator).
- Test baru: `test/console/provider-list-overview.test.ts`, `test/console/account-batch-delete.test.ts`, `test/console/daily-growth-job.test.ts`, `test/console/account-reset-cache.test.ts`, `dashboard/test/features/provider-status-counts.test.ts`.
- **Tidak dijalankan**: `check:migrations` (`CARTETHYIA_DRIFT_DATABASE_URL` tidak tersedia). Migration `0041` FK `daily_checkin_ledger` diverifikasi manual di kedua backend.
- **Tidak diverifikasi manual**: visual page render / SSE via agent-browser (lokal, tanpa gateway berjalan).
