# Research: Telemetry volume & footprint — dev instance (2026-11-03)

Status: **research** — data riil dari instance dev, referensi kode/docs repo.
Tujuan: menurunkan volume & jejak telemetry ("lower and lower") tanpa merusak
kontrak dashboard/analisis.

---

## 0. Brief untuk agent analisis lain (handoff)

Tugas: analisis & usulkan optimasi **brutal** untuk area telemetry agar volume
tidak tumbuh tak terkendali (read/write paling berpengaruh). Data tumbuh
±49k baris/hari; target: minimumkan write path, storage, dan query load tanpa
memutus kontrak dashboard.

Batasan:
- Repo aplikasi **harus tetap 100% sinkron upstream** — dilarang patch lokal.
  Perubahan kode hanya sah lewat **proposal/PR upstream**.
- Yang boleh dieksekusi langsung di instance dev: konfigurasi env, pengaturan
  tenant (Settings → Privacy), penjadwalan/retensi, dan keputusan operasional.
- Dilarang menuliskan secret (password/token) dan alamat IP/host riil di
  dokumen.

File sumber utama untuk dibedah (path relatif repo):
- `src/observability/telemetry-buffer.ts` — batch/queue: flush 500ms,
  maxBatch 500, maxItems 10.000, maxBytes queue, adaptive flush (floor 50ms).
- `src/observability/raw-event-writer.ts` — dual-write JSONL + SQL.
- `src/observability/event-log.ts` — `TELEMETRY_EVENT_DIR`, format baris.
- `src/observability/payload-store.ts` — frame payload, backlog bounds
  (max 32 item / 64 MiB), default dir `./data/telemetry-payloads`.
- `src/observability/payload-capture.ts` — mode `none|metadata|full`, depth,
  retention payload (default 1 jam), state `captured` vs `captured_metadata`
  vs `skipped_*`.
- `src/observability/redaction.ts` — redaksi body.
- `src/persistence/stores/telemetry-store.ts` — prune per jam, batch 5.000,
  `deleteExpiredEvents`, lifetime totals.
- `src/observability/event-query.ts` — query analytics (summary/percentile).
- `src/console/observability/store.ts` + `src/console/settings/contracts.ts`
  — endpoint dashboard & preferensi tenant `telemetryPayloads*`.
- `src/config/telemetry.ts` — resolusi env retention/payload.
- `documentation/reference/configuration.md` — daftar env.
- `documentation/archive/proposals/persistence-console-optimization.md` —
  optimasi query yang sudah diimplementasikan (jangan diregresi).
- `documentation/proposals/performance-resource-guard-proposal.md` —
  catatan beban event-loop & floor telemetry buffer.
- `documentation/architecture.md` (bagian Data) — diagram write path.

Data ekspor untuk analisis sempat dibuat (lokal, non-secret): CSV gzip
391.955 events; sudah dihapus setelah selesai dipakai. Data mentah masih
utuh di PostgreSQL instance dev bila perlu di-ekspor ulang.

---

## 1. Konteks

Instance dev baru saja dimigrasikan dari Lite (SQLite) ke Full (PostgreSQL).
Pasca-migrasi & pembersihan tenant test, data telemetry aktif:

| Data | Jumlah |
| --- | --- |
| `telemetry_events` | 391.955 baris (7 hari: 27 Okt–3 Nov) ≈ **49k/hari** |
| `telemetry_usage_totals` | 1.186 baris (lifetime) |
| `telemetry_payloads` | 299 baris (indeks frame yang masih dalam retensi) |
| Rata-rata ukuran baris events | ±367 byte (raw ±144 MB) |

## 2. Bentuk isi events (rata-rata)

- **Surface:** 97% `chat`, 3% `messages`/`responses`; endpoint ±96% di
  `/v1/chat/completions`.
- **Status:** 94,6% `completed`; 4,4% `failed`; ±1,2% `cancelled`.
- **Error:** 94,6% baris tanpa `error_category` (sukses). Error teratas:
  `accounts_rate_limited`, `transport_closed`, `authentication_failed`,
  `platform_unavailable`.
- **Payload capture:** 70% `captured` (penuh), 27% `captured_metadata`,
  ±3% tanpa state. **Tidak ada** `skipped_mode_none` → tenant aktif memakai
  mode capture penuh.
- **Latensi:** median ±4,5 dtk; rata-rata ±8,9 dtk; ekor sampai ±15 menit
  (investigasi: `transport_closed` / timeout upstream).
- **Token:** input rata-rata ±122.938, output ±753 (dominasi konteks besar,
  code-completion style).
- **Cost terakumulasi:** ±US$2.942 (7 hari).

## 3. Arsitektur write path (ringkas, dari docs + kode)

```
per-request event ──► hourly JSONL file (data/telemetry-events/<hour>-<writer>.jsonl)
                ──► telemetry_events (SQL row)          — sumber analytics
                ──► telemetry_usage_totals (lifetime)
payload (jika full/metadata) ──► frame file + indeks telemetry_payloads
```

- `TelemetryBatchBuffer`: batch multi-row insert, flush interval default
  **500 ms**, `maxBatch` 500, `maxItems` 10.000, `maxBytes` per bounded queue;
  flush adaptif (floor 50 ms saat antre penuh).
- **Retensi:** prune per jam (`telemetry-store.ts`): hapus file JSONL & row SQL
  yang jam-nya lebih tua dari retention (jam berjalan + sebelumnya tidak
  disentuh). `deleteExpiredEvents` batch 5.000.
- **Payload:** frame hidup default **1 jam** (`payloadRetentionMs`), di-rewrite
  oleh config `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES` (default 16 MB).
  Indeks `telemetry_payloads` hanya memegang frame yang masih dalam window.

## 4. Konfigurasi yang tersedia (docs configuration.md)

| Variabel | Default | Rentang |
| --- | --- | --- |
| `CARTETHYIA_TELEMETRY_RETENTION_DAYS` | 30 | 3–365 |
| `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES` | 16.777.216 | 1.048.576–16.777.216 |
| `CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS` | 3.600.000 | 1.000–604.800.000 |
| `CARTETHYIA_TELEMETRY_PAYLOAD_DIR` | (di luar spec) | — |

Config mode/depth capture **tidak** lewat env; lewat **Settings → Privacy**
per tenant (`telemetryPayloads`: `none` | `metadata` | `full`;
`telemetryPayloadDepth`: minimum/moderate/maximum; `telemetryWindowMinutes`).

## 5. Temuan & peluang penghematan

### P-1 (terbesar): mode capture penuh → metadata/none
- 274k baris `captured` = frame berisi body request & response (redacted) yang
  ditulis ke disk + I/O per request.
- Switch tenant ke `metadata` (simpan hanya baris Proxy→Provider) atau `none`
  menghilangkan body frames sepenuhnya; **event row tetap utuh** di SQL.
- Ini pemangkasan disk/I-O terbesar, tanpa dampak ke analytics.
- Implementasi: langsung lewat dashboard Settings → Privacy (config tenant,
  bukan env).

### P-2: retention diperpendek untuk dev
- Default 30 hari. Untuk dev, `CARTETHYIA_TELEMETRY_RETENTION_DAYS=7` cukup;
  riwayat lifetime tetap aman di `telemetry_usage_totals`.
- Efek: prune otomatis per jam membersihkan SQL + file lebih agresif.

### P-3: batas payload diturunkan
- `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES=1048576` (1 MB) → frame lebih kecil,
  lebih sedikit disk per capture.
- Kombinasikan dengan P-1 bila capture penuh masih dibutuhkan sesekali.

### P-4: evaluasi JSONL double-write
- Setiap event ditulis **dua kali** (SQL + JSONL). JSONL adalah audit/retensi
  kasar; analytics membaca SQL. Jika audit file tidak diperlukan untuk dev,
  bisa dipertimbangkan proposal mematikan raw JSONL (perlu perubahan kode;
  belum ada env toggle).

### P-5: agregasi & arsip dari
- Kunci `telemetry_usage_totals` sudah memegang angka lifetime. Untuk dev,
  raw events > retensi sudah dipangkas otomatis — cukup pastikan retention
  diset sesuai kebutuhan (P-2).

### P-6: bukan target penghematan
- `client_ip`/`user_agent` tidak dominan di ukuran baris (367 B/baris sudah
  ringan). Don't-touch.

## 6. Catatan risiko

- Dashboard request-list & detail drawer membaca JSONL frames; mematikan
  capture penuh menurunkan detail drawer ke "metadata only" (per desain).
- Retensi memangkas berdasarkan **jam**, bukan hari penuh; setup `RETENTION_DAYS`
  diinterpretasikan sebagai batas umur, aman untuk konsistensi.
- Jangan ubah kontrak `telemetry_events`/`telemetry_usage_totals` — dipakai
  `event-query.ts` + `usageSummary`/`health` dashboard.

## 7. Rekomendasi eksekusi (dev)

1. **Segera:** di Console → Settings → Privacy, set tenant aktif → capture
   `metadata` (atau `none`), depth `minimum`, window 60 menit.
2. **Segera:** `.env` dev → `CARTETHYIA_TELEMETRY_RETENTION_DAYS=7` +
   `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES=1048576`, restart app.
3. Ukur ulang setelah 24–48 jam: jumlah event/hari, ukuran DB, disk PakaiCloud.
4. (Opsional proposal kode) sampling capture, disable raw JSONL, dan rollup
   harian bila target volume tetap perlu diturunkan.
