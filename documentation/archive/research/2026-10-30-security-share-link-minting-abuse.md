# Share-link minting abuse — incident analysis & prevention

> Status: research/incident record (2026-10-30). Data diambil live dari
> deployment dev sebelum & sesudah pembersihan.

## 1. Ringkasan insiden

Satu template share ("One step at a time", `e58be58d-…`) dipakai untuk
**minting massal child key** oleh skrip bot:

| Fase | Jumlah dihapus | Keterangan |
|---|---|---|
| 2 IP Google Cloud (edge) | **319.395** | `35.247.128.192` (287.675) + `35.194.181.114` (31.720), dibuat dalam ~3 hari |
| Sisa (12.327) | **12.327** | 12.204 zero-usage (99%), 123 pernah dipakai, 54 hit hari ini |
| **Total** | **331.722** | ~99,9% tidak pernah dipakai |

Kedua gelombang menampilkan pola bot yang sama:
- **Burst milidetik**: ratusan key dibuat pada detik yang sama (mis. `05:56:41.396–419`).
- **Label sintetis**: `omp-<random>` (dan varian lain) — bukan nama hint dari manusia.
- **IP edge/rotasi**: di belakang CDN/cloud edge (IPv4 & IPv6) dan proxy/residential; per-IP dedupe tidak mempan karena tiap permintaan datang dari IP edge/rotasi berbeda.
- **Zero usage**: 99%+ tidak pernah mengeluarkan satu permintaan pun.
- Distribusi IP sisa (12.327): `126.209.124.215` (4.407) & `126.209.124.217`
  (1.499) — rentang ISP Indonesia; `104.28.194.105` (3.175) — Cloudflare IPv4
  edge; `2a09:bac5:…:247:aa` (3.110) — Cloudflare IPv6 edge; ±105 IP lain
  1–6 key (total ~136). Pola sama: burst milidetik + label `omp-*`.

Konsekuensi:
- `api_keys` membengkak 330k+ baris → bloat storage/backup (367 MB raw), autentikasi baca lebar, list console sempat hilang/error (mis. `IN (...)` melewati batas 65.535 bind params PG).
- Risiko drift policy & noise administratif.

## 2. Attack surface

Route `POST /share/:token/issue` (`src/console/share/share-router.ts:358`)
membuat child dengan **satu kunci dedupe**: 1 child per canonical client IP
(`canonicalClientIpKey`). Itu cukup untuk manusia biasa, tapi **gagal
melawan**:

1. **Rotasi IP / proxy / CDN masking** — attacker memakai banyak IP edge
   (GCP, Cloudflare, dsb.), tiap IP dapat 1 child → tanpa batas total.
2. **Tidak ada batas total per template** — tanpa cap, jumlah child tak
   terikat.
3. **Tidak ada bukti-manusia** — `issue` adalah endpoint publik tanpa CAPTCHA
   / challenge / token sesi.
4. **Tidak ada rate-limit global per link** — throttle hanya per-IP.
5. **Tidak ada anomali/alerting** — lonjakan 330k mint tidak terdeteksi
   otomatis.
6. **Tidak ada hygiene** — child yang tidak pernah dipakai tidak pernah di-daur
   ulang.

## 3. Rekomendasi pencegahan (urut prioritas)

### Fase 1 — cepat, dampak besar, low risk
1. **Hard cap jumlah child per template** (default mis. 200–500, configurable
   per tenant). Di `issueSharedApiKey`, hitung child aktif template; jika
   `>= cap` → tolak dengan `429`/`conflict` + tandai template di console.
   Ini menutup akar masalah (unbounded) seketika.
2. **Rate-limit per template + window** (Redis counter, mirror pola
   `pruneTelemetry`/admission): mis. ≤30 mint/menit per link; batas kedua
   per-IP. Anti-burst bahkan sebelum cap tercapai.
3. **Hygiene worker**: purge child yang `created_at < now() - interval '30
   days'` **dan** `lifetime_tokens_consumed = 0` **dan** tidak ada telemetry
   (batch 5000, mirror `deleteExpiredEvents`). Memastikan kebocoran kecil pun
   tidak menumpuk.

### Fase 2 — hardening lebih dalam
4. **Trust Cloudflare true client IP**: tambahkan CIDR Cloudflare ke
   `TRUSTED_PROXY_CIDRS` dan baca `CF-Connecting-IP` → per-IP dedupe
   kembali efektif walau via CDN (perketat agar hanya dari CF yang
   dipercaya). Jangan lakukan tanpa verifikasi keamanan proxy trust.
5. **Challenge ringan di halaman share** (honeypot field + minimum time +
   token sesi HMAC sekali pakai yang ditandatangani saat render page; `issue`
   menolak tanpa token). Memblokir skrip tanpa browser interaksi.
6. **Anomali & alerting**: metrik `mint rate per template/menit`; alert pada
   ambang (mis. >50/menit); opsi auto-pause link (`share_links.active=false`)
   saat terdeteksi, dengan notifikasi console.
7. **Audit & visibilitas**: hitung child per template di console + log
   `api_key.share_minted` (sudah ada audit sink; pastikan bulk mint tercatat),
   dan tampilkan jumlah mint per jam di halaman share.

### Catatan desain
- Cap & rate-limit harus berada di **store/route layer** (bukan hanya UI).
- Dengan cap, beban `listChildrenPage` juga terbatas otomatis; namun tetap
  pertahankan pagination yang baru dibangun (tabel recipients).
- Backup/restore: template dengan child sedikit → export jauh lebih kecil;
  pastikan cap tidak menghalangi restore backup lama (restore tidak menjalankan
  cap — cap hanya berlaku untuk minting baru).

## 4. Referensi kode
- Mint child: `src/persistence/stores/share-store.ts` (`issueSharedApiKey`).
- Route publik: `src/console/share/share-router.ts:358` (`POST /share/:token/issue`).
- Dedupe per-IP: `canonicalClientIpKey` (share-store / share-router).
- Batching preceden: `src/persistence/stores/telemetry-store.ts:316` (`deleteExpiredEvents`).
- Pagination list child: `src/persistence/stores/api-key-store.ts` (`listChildrenPage`).
- Readiness/ledger: `src/persistence/migrate.ts`.

## 4b. Temuan lanjutan: inkonsistensi total usage

Setelah pembersihan, angka usage family tidak konsisten antarpermukaan:

| Permukaan | Sumber | Nilai (untuk template One step at a time) |
|---|---|---|
| Overview / daftar key | kolom `api_keys.lifetime_tokens_consumed` **pada template** | **400.000.000.000 (400B)** |
| Share page `/stats` | `telemetry_usage_totals` family (termasuk child yang sudah dihapus) | ~15,6B |
| Share dialog / recipient table | kolom `lifetime_tokens_consumed` pada **child yang masih ada** (3) | ~1,8M |

Akar: (1) kolom counter template berisi nilai 400B (seeded/manual, bukan
hasilkan traffic), dan (2) `telemetry_usage_totals` menyimpan row per child
yang tidak ikut terhapus saat child di-delete → total telemetry masih
mencakup bot yang sudah dibersihkan. Ketiga sumber membaca kolom/tabel yang
berbeda sehingga selalu tampak kontradiktif.

Rekomendasi: satukan definisi "total family usage" pada satu sumber (mis.
`telemetry_usage_totals` untuk family yang masih ada, dengan prune row child
yang dihapus, atau jumlahkan kolom child yang masih ada), dan klarifikasi
kolom counter template sebagai limit seed — bukan hasil pakai.

## 5. Status aksi
- [x] Hapus 331.722 child bot (2 IP GCP + sisa 12.327) — live, 2026-10-30.
- [x] Pagination/sorting list child (tabel recipients) — commit `a73a6cd5`.
- [ ] Implementasi Fase 1 (cap + rate-limit + hygiene worker) — belum.
- [ ] Fase 2 (CF trusted proxy, challenge, alerting) — belum.
