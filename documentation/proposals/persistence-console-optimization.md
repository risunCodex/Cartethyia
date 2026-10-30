# Proposal: Persistence & Console API optimization (pass 1)

Status: **implemented** — Fase 1–3 diterapkan (lihat commit). Referensi
perilaku: `src/observability/event-query.ts` + `src/console/observability/store.ts`.

---

## 0. Ringkasan

Audit menemukan **3 peluang nyata** + beberapa catatan yang sudah optimal.
Tidak ada refactor besar yang asal; semua perubahan kecil, terarah, dan
mempertahankan kontrak wire.

| # | Area | Temuan | Dampak |
| --- | --- | --- | --- |
| 1 | Observability summary | 3 fungsi independen men-scan `telemetry_events` untuk window sama + percentile query berulang | hitungan query naik 2-4× saat cold-cache |
| 2 | SQLite percentile | `latencyPercentiles` SQLite = 3 query (p50/p95/p99) per panggilan | 3 query tambahan per summary/health |
| 3 | Dashboard Usage page | memanggil 4-5 endpoint sekaligus; tiap endpoint cold-cache scan window identik | 4-5 scan identik per halaman |

---

## 1. Temuan 1 — Tiga fungsi summary independen

`src/observability/event-query.ts` memiliki tiga fungsi yang masing-masing
men-scan window yang sama untuk data yang tumpang tindih:

| Fungsi | Dipakai oleh | Query utama | Query percentile |
| --- | --- | --- | --- |
| `summarizeTelemetry` | `usageSummary` endpoint | 1 (count/sum) | 1 (Postgres) / 3 (SQLite) |
| `summarizeHealthPerformance` | `health` endpoint | 1 (avg/sampled) | 1 / 3 |
| `summarizeUsagePerformanceSql` | `usageSummary` endpoint | 1 (resolve/avg tokens) | 1 / 3 |

`usageSummary` memanggil `summarizeTelemetry` **dan**
`summarizeUsagePerformanceSql` → **2 window scan + 2 percentile query**
(Postgres) atau 2 + 6 (SQLite) untuk satu response.

### Kenapa ini masalah

- Window yang sama (`tenant_id`, `created_at >= since`) di-scan 2× dalam
  satu request.
- Latency percentile dihitung 2× untuk data yang sama.
- Cold-cache (mis. restart gateway, Redis flush) = semua query jalan serentak.

### Usulan

1. **Gabung `summarizeTelemetry` + `summarizeUsagePerformanceSql`** menjadi
   satu query + satu percentile pass. Semua kolom yang dibutuhkan kedua
   response dipilih dalam satu `SELECT` (count, sum token, avg latency,
   count resolve, avg tokens/sec, unpriced, sampled, …). Latency percentiles
   dihitung sekali. Return `UsageSummary` (yang sudah punya field
   `avgResolveMs`/`avgTokensPerSec`? belum — tambahkan field, atau buat
   return gabungan yang dipetakan ke kedua bentuk).
2. **`health` endpoint** (`summarizeHealthPerformance`) tetap sendiri (kard
   beda), tapi **pakai hasil yang sama** bila dipanggil dalam halaman yang
   sama? Tidak — `health` dan `usageSummary` adalah endpoint terpisah dengan
   cache terpisah. Bahan gabung endpoint; hanya gabung query **di dalam**
   masing-masing.
3. Hasil: `usageSummary` = 1 scan + 1 percentile (bukan 2+2). `health` =
   1 scan + 1 percentile (bukan 1+1).

---

## 2. Temuan 2 — SQLite percentile = 3 query

`latencyPercentiles` saat SQLite menjalankan **3 query terpisah**
(p50/p95/p99 masing-masing `ORDER BY latency OFFSET x LIMIT 1`).

### Usulan

- **Satu query** untuk ketiga rank: pakai `row_number() over (order by
  latency_ms)` + `WHERE row_number IN (ceil(0.5*n), ceil(0.95*n),
  ceil(0.99*n))` — satu pass, tiga nilai.
- Atau, lebih sederhana: untuk window kecil (< ~10k baris), **hitung
  percentile di JS dari satu `SELECT latency_ms ORDER BY`** (array satu
  kolom), yang lebih murah daripada 3 OFFSET scan. Untuk window besar,
  tetap di SQL.
- Postgres sudah optimal (`percentile_cont` satu query) — tidak diubah.

Dampak: SQLite summary/health dari 4-7 query → 2 query.

---

## 3. Temuan 3 — Dashboard Usage cold-cache = 4-5 scan identik

Dashboard halaman Usage memanggil: `/system/usage`, `/system/usage/summary`,
`/system/usage/chart`, `/system/usage/by-model`, `/system/usage/by-provider`
(+ `/system/usage/cache`). Semua memakai window sama.

### Kenapa ini masalah

- Setiap endpoint punya key cache Redis sendiri (`usage:tenant:7d` dst.).
- Cold-cache → setiap endpoint hit DB sendiri → **4-5 scan identik** dalam
  satu detik.
- Redis TTL 10s membantu setelahnya, tapi cold start tetap mahal.

### Usulan (dua langkah)

1. **Bagikan satu hasil scan** antar endpoint yang dipanggil bersamaan:
   - Tambah **cache pada window**, bukan per-endpoint: satu key
     `usage:window:{tenant}:{period}` berisi hasil query aggregate
     (summary+chart+breakdown+health) yang dihitung **sekali**, lalu keempat
     endpoint membaca dari sana (Redis GET, tanpa DB).
   - Ini mengubah `cachedReadWithEtag` menjadi multi-consumer: hasil tunggal,
     ETag per response tetap dihitung dari subset.
2. **Minor**: chart + breakdown sudah di-SQL dan cheap (group by). Yang
   mahal hanya summary/health. Jadi cukup gabung **summary** (Temuan 1) dan
   biarkan chart/breakdown.

### Catatan risiko

- Perlu menjaga **ETag per endpoint** tetap benar (masing-masing punya
  validator sendiri). Cache window menyimpan `{value, etag}` per subset atau
  hash penuh sekali.
- Jangan ubah kontrak response dashboard.

---

## 4. Catatan yang sudah optimal (tidak diubah)

| Area | Mengapa sudah baik |
| --- | --- |
| Routing snapshot | `InMemoryRouteSnapshotService` cache in-memory + lazy build + broadcast invalidation; tidak ada rebuild per request |
| Telemetry writer | `TelemetryBatchBuffer` batching multi-row insert + retry + adaptive flush |
| Logger | Pino JSON + worker thread hanya saat TTY; ring 500; level-check sebelum copy |
| SQLite statement cache | sudah ada (`SQLITE_STATEMENT_CACHE_MAX`) |
| `listChildrenPage` | total/active/revoked dalam satu query (`count(*) filter`) |
| `eventByRequestId` | indexed single-row |
| Console ETag | `cachedReadWithEtag` — validator sekali per write, 304 murah |

---

## 5. Rencana penerapan

1. **Fase 1** — Temuan 1: gabung `summarizeTelemetry` +
   `summarizeUsagePerformanceSql` (1 scan + 1 percentile). Update store
   `usageSummary` untuk memakai hasil gabungan.
2. **Fase 2** — Temuan 2: SQLite `latencyPercentiles` satu-query
   (`row_number` atau JS-side untuk window kecil).
3. **Fase 3** — Temuan 3: cache window bersama untuk summary/health
   (multi-consumer), pertahankan ETag per endpoint.
4. **Validasi** — `bun run typecheck`, `bun run test --scope backend/dashboard`,
   dan ukur query count (log statement untuk window test).

---

## 6. Test terdampak

- `test/observability/event-query*` (jika ada) — summary/percentile
- `test/console/observability*` — endpoint usage summary/health
- `test/console/read-through-cache*` — multi-consumer cache
- `test/persistence/db-sqlite*` — statement cache behavior

---

## 7. Keputusan yang masih terbuka

- Apakah mengubah **kardinalitas query** (aggregate window) dianggap aman
  untuk konsistensi data? Ya — hasil identik, hanya lebih sedikit round-trip.
- Apakah perlu **redundan cache di memori** (selain Redis) untuk menghindari
  satu GET Redis per poll? Panjang; TTL 10s sudah cukup.
