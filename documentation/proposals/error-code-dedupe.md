# Proposal: Error code dedupe — pass 2 (residual overlaps)

Status: **implemented** (Fase A–D selesai; pass 2 dedupe diterapkan).
Referensi final: `documentation/reference/errors.md`.

---

## 0. Ringkasan

Pass 1 membereskan overlap besar (`invalid_request` overload, `529 → upstream_overloaded`,
shutdown merge, dst.). Masih tersisa **6 klaster dupe** yang bisa dikonsolidasi:

| # | Klaster | Code terlibat | Masalah inti |
| --- | --- | --- | --- |
| 1 | 503 "gak bisa layani" | `admission_unavailable`, `accounts_unavailable`, `platform_unavailable`, `shutting_down`, `proxy_pool_unavailable` | bucket 503 yang tumpang-tindih |
| 2 | `admission_unavailable` overload | 1 code untuk ~10 makna berbeda | routing/prep failure dicampur admission failure |
| 3 | `transport_unavailable` vs `platform_unavailable` | 502 kembar | pembagian subjektif |
| 4 | `model_not_found` conflation | eksistensi vs eligibility vs wire | 3 makna dalam 1 code |
| 5 | `quota_exceeded` campur aduk | spend vs rate-limit vs abuse ban | 3 makna dalam 1 code |
| 6 | Console free-string dupes | `invalid_*`, `not_found`, `pool_*` | string code yang tidak konsisten |

---

## 1. Klaster 1 — 503 "gak bisa layani" (5 code, batas kabur)

Semua code ini 503 dan diterima client sebagai "coba lagi nanti". Batasnya
kabur dan beberapa situs memilih code secara subjektif:

| Code | Makna seharusnya | Call site aktual yang "nyasar" |
| --- | --- | --- |
| `admission_unavailable` | admission/limit counter gagal atau tidak bisa dijalankan | dipakai juga untuk "provider adapter not registered", "request never registered", "not prepared", "no eligible route", "validated network binding required" |
| `accounts_unavailable` | model dirutekan tapi tidak ada akun sehat | dipakai juga untuk "credential store unavailable" (auth-guard) |
| `platform_unavailable` | upstream 5xx (502) / gateway-own (503: readiness, invoke off) | readiness deps & invoke off memakai ini — benar, tapi tidak ada `details.reason` yang konsisten |
| `shutting_down` | drain/restart | bersih |
| `proxy_pool_unavailable` | pool tidak ada / koordinasi mati | bersih |

### Usulan

1. **Pisah `admission_unavailable`** → tambah code baru:
   - `admission_unavailable` → **hanya** untuk kegagalan admission counter/store
     (abuse store unreachable, peer address unknown, counter corrupt).
   - **`route_unavailable`** (503, baru) → untuk "no eligible X route",
     "provider adapter not registered", "validated network binding required",
     "request was never registered", "not prepared", "not authenticated and parsed".
     Ini kegagalan **routing/preparasi**, bukan admission.
2. **`platform_unavailable` gateway-own**: wajib `details.reason` (`"dependencies_not_ready"`,
   `"invoke_switched_off"`) — sudah ada aturan, tinggal enforce.
3. **`accounts_unavailable`**: tarik call-site "credential store unavailable"
   kembali ke `admission_unavailable` (store gagal = admission infra, bukan
   tidak-ada-akun). Karena auth-guard gagal baca store, bukan karena akun tidak ada.

```
Sebelum:  admission_unavailable (503) — 10+ makna (route, adapter, prep, admission, abuse)
Sesudah:  admission_unavailable (503) — admission counter/store saja
           route_unavailable (503, baru) — routing/prep/adapter/binding
           accounts_unavailable (503) — benar-benar tidak ada akun sehat
```

---

## 2. Klaster 2 — `admission_unavailable` overload (terkuantifikasi)

Dari grep, `admission_unavailable` muncul di **18+ situs** dengan makna:

| Makna | Contoh situs | Ke mana |
| --- | --- | --- |
| Abuse store unreachable | `abuse.ts:467` | tetap `admission_unavailable` |
| Peer address unavailable | `guard-errors.ts` | tetap |
| Request body never read | `request-context.ts:162` | → `route_unavailable` |
| Not authenticated and parsed | `request-context.ts:227` | → `route_unavailable` |
| Request never registered | `state.ts:421` | → `route_unavailable` |
| Not prepared | `proxy-request.ts:119` | → `route_unavailable` |
| No account leased | `proxy-request.ts:191` | → `route_unavailable` |
| Provider adapter not registered | `proxy-request.ts:214` | → `route_unavailable` |
| Validated network binding required | `proxy-request.ts:218` | → `route_unavailable` |
| exhaustedError (no eligible route) | websearch/token-count/systemone/generation/responses-compact | → `route_unavailable` |

Ini **10 makna dalam 1 code** — client tidak bisa membedakan "gateway
kesalahan internal" dari "rute tidak ada" dari "admission gagal".

---

## 3. Klaster 3 — `transport_unavailable` vs `platform_unavailable` (502 kembar)

| Code | Dipakai untuk (aktual) |
| --- | --- |
| `transport_unavailable` | WebSocket/HTTP2 mati, DNS gagal, stream terpotong, missing tool name, upstream non-JSON, socket drop |
| `platform_unavailable` | upstream 5xx, empty stream, decode gagal, buffer bound, HTML page, "no endpoints" |

Kedua origin `upstream`/`network` dan 502. Perbedaan sebenarnya: **transport =
koneksi/byte gagal**, **platform = upstream respon tapi tidak berguna/gagal**.
Batasnya halus dan beberapa situs memilih subjektif (mis. "HTTP/2 stream
aborted by remote" → transport, tapi "HTTP/2 response exceeded buffer bound"
→ platform; keduanya upstream salah kirim).

### Usulan

- **Jangan digabung** (telemetry/retry membedakannya), tapi **standarisasi
  aturan pemilihan**:
  - `transport_unavailable` → kegagalan saat **mendapatkan/mentransmisikan**
    byte (socket, DNS, TLS, handshake, timeout baca, stream aborted).
  - `platform_unavailable` → upstream **mengembalikan** sesuatu yang tidak
    bisa dipakai (5xx, empty, malformed, buffer overflow, HTML).
  - Tulis aturan ini di `errors.md` sebagai tabel keputusan; perbaiki situs
    yang melanggar (buffer bound → transport? tidak — tetap platform, tapi
    kodifikasi).

---

## 4. Klaster 4 — `model_not_found` conflation (3 makna)

| Makna | Situs | Status |
| --- | --- | --- |
| Model tidak dikenal / tidak dirutekan | `route-model.ts` (`modelNotFoundError`) | 404 |
| Model tidak diizinkan untuk key ini | `preparer.ts` (allowlist/prefix), admission `model-not-allowed`/`model-denied` | 404 |
| Wire family tidak didukung | kimi/antigravity/agentrouter/qoder/cloudflareai (kadang `capability_unsupported`) | 400/404 |
| Roster tidak ada | Qoder virtual model | 404 |

Client tidak bisa membedakan "typom model" vs "key-ku tidak boleh pakai" vs
"provider tidak mendukung wire ini" — tiga perbaikan yang berbeda.

### Usulan

- **`model_not_found`** → hanya "model tidak ada / tidak dirutekan" (404).
- **`model_not_allowed`** (baru, 403) → eligibility/allowlist/prefix/denylist.
  (CosRA sudah punya `model-not-allowed` reason; tinggal angkat jadi code
  publik.) Ini penting: 403 memberi sinyal "jangan retry dengan model sama",
  sedangkan 404 bisa berarti typo.
- **wire family** → sudah benar di `capability_unsupported`; rapikan situs
  yang masih memakai `model_not_found` untuk wire.

---

## 5. Klaster 5 — `quota_exceeded` campur aduk (3 makna)

| Makna | Situs | Seharusnya |
| --- | --- | --- |
| Spend/balance limit (kuota habis) | upstream quota, daily/monthly/lifetime token | `quota_exceeded` (tetap) |
| Rate limit (terlalu cepat) | admission `rpm-exhausted`, abuse `ip-rate-limited`, console mutation throttle | **`rate_limited`** (baru, 429) |
| Ban abuse (sementara) | `abuse.ts` banned | **`rate_limited`** + `details.reason="ip-banned"` |

Sekarang `quota_exceeded` berarti "uang habis", "terlalu cepat", dan
"di-ban" sekaligus. Client tidak bisa membedakan "top up" vs "tunggu
window" vs "jangan spam".

### Usulan

- Tambah **`rate_limited`** (429) untuk rate-limit murni (rpm, abuse window,
  console throttle).
- `quota_exceeded` → hanya spend/balance.
- Ban abuse → `rate_limited` + `details.reason: "ip-banned"` + `retryAfterMs`
  (tetap 429, jadi retry behavior tidak berubah).

---

## 6. Klaster 6 — Console free-string dupes

`ConsoleDomainError` memakai string bebas; ada tumpang-tindih antar domain:

| Code | Domain yang memakai | Tumpang tindih |
| --- | --- | --- |
| `not_found` | quota, inferhub, native-identity, share, dll. | generik: ok, tapi beberapa situs memakai `invalid_request` untuk "tidak ketemu" (mis. `inferhub/routes.ts:272` mengembalikan `{error:"not_found", code:"not_found"}` — error==code) |
| `invalid_pool` vs `invalid_endpoint` vs `invalid_pool_limits` vs `invalid_config` | pools | 4 code validasi pool; bisa digabung jadi `invalid_pool` + `details.field` |
| `invalid_key` vs `invalid_key_mode` vs `invalid_scope` vs `invalid_limits` | api-keys | tetap terpisah, ok |
| `capability_unsupported` (501) vs `not_supported` (400/503) | api-keys vs pools | dua code "fitur tidak tersedia" → bisa disatukan |

### Usulan (minimal)

- Console **tidak wajib** mengikuti union Gateway, tapi **standarisasi
  naming**: `invalid_<subject>`, `not_found` hanya untuk lookup.
- Gabung `invalid_pool` / `invalid_endpoint` / `invalid_pool_limits` /
  `invalid_config` → `invalid_pool` + `details.field`.
- Tentukan satu code untuk "fitur tidak tersedia": pilih
  `capability_unsupported` (501) di console, deprecate `not_supported`
  (atau sebaliknya).

---

## 7. Rangkuman perubahan kode (gateway)

| Aksi | Code |
| --- | --- |
| Tetap | seluruh 52 code kecuali di bawah |
| Ditambah | `route_unavailable` (503), `model_not_allowed` (403), `rate_limited` (429) |
| Dibatasi makna | `admission_unavailable` (hanya admission), `model_not_found` (hanya eksistensi), `quota_exceeded` (hanya spend) |
| Dipindah call-site | `accounts_unavailable` ← hapus "credential store unavailable"; `admission_unavailable` "nyasar" → `route_unavailable` |

Union berubah 52 → **55**.

---

## 8. Test terdampak

- `test/transport/failure-policy.test.ts` (retry list + baru `route_unavailable`,
  `model_not_allowed`, `rate_limited`)
- `test/transport/gateway-error-envelope.test.ts` (exhaustive code list)
- `test/transport/retry-policy.test.ts`
- `test/security/admission.test.ts` + `admission-redis.test.ts`
- `test/providers/account-health-invalidation.test.ts`
- `test/console/*` untuk pool/api-keys (jika console standardisasi)
- `test/protocol/stream-errors.test.ts` (jika menyentuh classifier)

---

## 9. Rencana penerapan (fase)

1. **Fase A (additive, aman):** tambah `route_unavailable`, `model_not_allowed`,
   `rate_limited` ke union + classifier retryable + telemetry status. Belum
   memindahkan call-site.
2. **Fase B (pindah call-site):** `admission_unavailable` → `route_unavailable`
   (klaster 2); `quota_exceeded` → `rate_limited` (klaster 5);
   `model_not_found` → `model_not_allowed` (klaster 4); `accounts_unavailable`
   credential-store → `admission_unavailable`.
3. **Fase C (console):** standardisasi naming + gabung code pool + pilih
   `capability_unsupported`.
4. **Fase D:** update `documentation/reference/errors.md` + `CHANGELOG.md`.

---

## 10. Lampiran — call site yang akan berubah

| Perubahan | File |
| --- | --- |
| `admission_unavailable` → `route_unavailable` | `request-context.ts`, `state.ts`, `proxy-request.ts`, `websearch.ts`, `token-count.ts`, `systemone.ts`, `generation.ts`, `responses-compact.ts` |
| `quota_exceeded` → `rate_limited` | `reasons.ts` (rpm/daily/monthly/lifetime), `abuse.ts` (ip-rate-limited), `console-router-guards.ts` |
| `model_not_found` → `model_not_allowed` | `preparer.ts`, `reasons.ts` (model-not-allowed/model-denied) |
| `accounts_unavailable` → `admission_unavailable` | `auth-guard.ts` (credential store) |
