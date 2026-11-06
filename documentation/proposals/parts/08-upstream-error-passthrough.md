# Proposal — Upstream Error Passthrough (message as-is untuk unknown/undefined error)

**Status:** executed (full) — lihat §7
**Tanggal:** 2026-11-06
**Scope:** transport, protocol, providers (adapter), dispatch (terminal envelope)
**Method:** audit subagent (codegraph_explore + Read/Grep), baseline test dijalankan (`326 pass / 0 fail` transport+protocol, `30 pass / 0 fail` klasifikasi provider)

**Decision lock:** area ini sudah terkunci penuh; tidak ada keputusan yang tertunda. Seluruh keputusan dikunci di `../provider-account-model-update.md` §6.8 (D44–D49) dan diregister ulang di §6 file ini. Frasa "Opsi A/B", "Dipilih/Ditolak", "lihat Dnn", "tidak dikerjakan", dan "opsional" di §1–§5 adalah jejak audit yang **sudah ditimpa keputusan final**, bukan pilihan yang menunggu jawaban; baca melalui tabel koreksi di §6. Source of truth keputusan = master.

---

## 1. Kondisi saat ini (dari kode)

Pipeline error upstream → envelope publik (satu jalur dominan):

1. **HTTP non-2xx** → `mapUpstreamHttpError` (`src/transport/failure-policy.ts:923`) membaca body, `classifyUpstreamError` (`:808`) mengklasifikasi via tabel identifier lalu fallback `statusToGatewayErrorCode` (`:160`). Pesan = `extractUpstreamMessage` (`:26`) atau fallback `Provider returned HTTP <status>.` (`:955`).
2. **Frame SSE dalam stream** → `gatewayErrorFromStreamError` (`src/protocol/stream-error-frames.ts:45`) — string error diteruskan langsung (`:53`, potong 500), record error pakai `extractUpstreamMessage` atau `label` surface.
3. **Claude** → `mapClaudeHttpError` / `mapClaudeStreamError` (`src/protocol/messages-errors.ts:56/78`), manggil `claudeErrorFromStatus` (`:25`).
4. **Adapter generik** → `compatible-adapter.transformStream` (`src/providers/adapters/compatible-adapter.ts:393`) — non-JSON body dijadikan `transport_unavailable` 502 dengan `Upstream returned a non-JSON response: ${summary}` (`:443-449`), envelope JSON tanpa message → `"Upstream reported an error"` (`:488`).
5. **Envelope publik** → `publicGatewayErrorBody` (`src/protocol/gateway-error.ts:206`) via `explainGatewayError` (`:143`) → `formatPublicErrorMessage` (`:129`) yang hanya strip label origin legacy + prefix `code:`. Details di-allowlist `PUBLIC_ERROR_DETAIL_KEYS` (`:147`) + `sanitizePublicDetail` (`:180`, depth 3, string 500).
6. **Middleware** → `createErrorNormalizationMiddleware` (`src/transport/guards/error-lifecycle.ts:72`): GatewayError → `explainGatewayError` + `applyRequestId` (`:58`, append ` (request <id>)` atau replace `{requestId}`); non-GatewayError → 500 `internal_error` dengan teks generik (`:102-107`).

### Finding ringkas (semua verdict: behavior change? + severity + effort)

| # | Finding | Evidence | Verdict | Sev | Effort |
|---|---------|----------|---------|-----|--------|
| F1 | Fallback `platform_unavailable` yang tidak punya pesan upstream diganti teks generik "temporarily unavailable" — tidak ada passthrough | `failure-policy.ts:960-965`; test `“a platform-unavailable upstream response without a body message”` (`test/transport/failure-policy.test.ts:2149-2158`) | behavior change (message-only) | MED | S |
| F2 | Body upstream yang bukan JSON / tidak punya `message` yang bisa diekstrak di **Claude path** dibuang; client dapat `"Claude response is not valid JSON"` dll, teks upstream hilang | `src/protocol/upstream/send-claude-messages.ts:57-85` | behavior change (message-only) | HIGH | S |
| F3 | SSE decoder mengganti baris malformed / body oversize / body kosong dengan pesan generik 502; konten upstream tidak disurface | `src/protocol/sse-decoder.ts:97,104,226` | behavior change (message-only) | MED | S |
| F4 | Adapter generik: stream kosong → generik (`compatible-adapter.ts:411-419`); non-JSON → ringkasan terpotong 320 (sudah sebagian as-is) (`:443-449`); JSON envelope tanpa message → `"Upstream reported an error"` (`:488`) | `compatible-adapter.ts:411-449,488` | hybrid (sebagian sudah as-is) | MED | S |
| F5 | Frame stream record dengan message kosong → fallback `label` surface (generik), bukan teks upstream | `stream-error-frames.ts:65` | behavior change (message-only) | MED | S |
| F6 | Error non-GatewayError (termasuk yang berasal dari upstream tapi tidak terbungkus, mis. `SyntaxError`/fetch TypeError) → envelope 500 `internal_error` generik | `attempt-finalize.ts:40-43` (`errorClientResponseBody`), `error-lifecycle.ts:102-107`, `console/shared/errors.ts:70-73`; `classifyUpstreamFailure` memperlakukan non-GatewayError sebagai network (`failure-policy.ts:193-195`) | behavior change | MED | M |
| F7 | Streaming finalize: error stream non-GatewayError → 502 `transport_unavailable` dengan pesan generik, menggantikan pesan upstream yang mungkin ada | `src/transport/dispatch/streaming/finalize.ts:593-601` | behavior change | MED | S |
| F8 | Akun-health `unknown` (`classifyAccountError` fallback `account-error-classification.ts:1197-1204`) tidak memengaruhi envelope publik; reason-nya justru sudah menyimpan pesan upstream (`:769`, `rawUpstreamResponse ?? message.slice(0,160)`) — tidak perlu diubah, cukup jadi precedent | `account-error-classification.ts:769,1197-1204` | non-change (reference) | LOW | – |

Catatan penting: **jalur HTTP utama sudah meneruskan pesan upstream verbatim** bila bisa diekstrak — dibuktikan test `"keeps an upstream-provided message verbatim"` (`failure-policy.test.ts:2160-2168`). Jadi gap-nya bukan pada pesan yang terklasifikasi, melainkan pada: (a) body yang tidak bisa diparse/diekstrak, (b) kategori unknown/undefined hasil fallback status, (c) error yang lolos tanpa terbungkus GatewayError.

### Precedent yang sudah ada

- `extractUpstreamMessage` (`failure-policy.ts:26`) — sudah membatasi `MAX_UPSTREAM_ERROR_BYTES` = 4000 dan strip baris baru.
- Kontrak redaksi: `src/observability/redaction.ts:3-11` — tanpa string-sniffing redactor; body dipertahankan verbatim; sweep hanya untuk log (`scrubSecrets`, `:75`). `test/transport/gateway-error-envelope.test.ts:467-512` secara eksplisit menguji `raw` pass-through termasuk kredensial yang digema upstream.
- `classifyAccountError` hasil `unknown` (`:1197`) sudah menyimpan pesan upstream di `reason` — precedent bahwa teks upstream aman dipakai di dalam sistem.

## 2. Masalah yang diminta diatasi

Requirement: *"undefined error send as is dari upstream untuk messagenya. do not generalize 502"* — ketika error upstream tidak terklasifikasi (unknown/undefined), pesan error yang dikirim ke client harus diteruskan sebagaimana adanya dari upstream (message as-is), tidak digeneralisasi menjadi 502 generic.

Masalah konkret pada perilaku saat ini:

1. **Pesan upstream hilang** pada kasus unknown/unparseable: body non-JSON (Claude), baris SSE malformed, stream kosong, envelope tanpa message — client menerima kalimat generik 502 yang tidak menyebut kondisi asli (F2, F3, F4, F5).
2. **Generalization 502**: fallback `platform_unavailable` (status-only, tanpa identifier) mengganti teks status dengan kalimat generik; stream finalize mengganti error mentah dengan 502 generik (F1, F7).
3. **Bocor ke 500**: error yang sebenarnya dari upstream tapi tidak terbungkus `GatewayError` sampai ke middleware sebagai `internal_error` 500 generik — ini generalization yang paling menyesatkan (F6).

Yang **tidak** diminta (scope boundary): error yang sudah terklasifikasi (quota/auth/capacity/dst.) tetap memakai pesan kanoniknya masing-masing; status code tetap (unknown 5xx → 502 `platform_unavailable`); console quota probe 502 (`src/console/quota/account-quota-tenant.ts:1049+`) bukan kep lip publik, di luar scope.

## 3. Desain yang diusulkan

**Prinsip:** *message passthrough hanya untuk klasifikasi unknown/undefined; error terklasifikasi tidak berubah; status code tidak berubah; hanya teks yang dipertahankan.*

### 3a. Alur runtime yang diusulkan

1. **Pusatkan normalisasi di `failure-policy.ts`** — tambah helper `upstreamMessageAsIs(body: unknown, fallback: string): { message, hadUpstreamText }`:
   - Ekstrak teks upstream dengan `extractUpstreamMessage`; bila kosong, coba raw text: `extractHtmlTitle` untuk HTML, `raw.trim()` untuk teks polos (reuse `:994`).
   - Normalisasi: `.replace(/[\r\n]+/g, " ")`, `.trim()`, `.slice(0, 500)` untuk message publik (konsisten dengan `sanitizePublicDetail` per-string 500; `details.raw` tetap 4000).
   - Bila tetap kosong → `fallback` surface (seperti sekarang).
2. **Terapkan di 5 titik yang kehilangan pesan**:
   - `mapUpstreamHttpError` (`failure-policy.ts:960-965`): ganti blok "human explanation" — hanya berlaku bila `hadUpstreamText === false`. Bila upstream memberi teks apa pun, `message` = teks as-is (bukan `"temporarily unavailable"`).
   - `send-claude-messages.ts:70-85`: branch non-JSON / non-object — bawa teks raw body sebagai message, bukan `"Claude response is not valid JSON"`; tambah `details.raw`.
   - `sse-decoder.ts:97,104,226`: message memuat cuplikan baris/sebab asli (bounded), bukan hanya kalimat generik.
   - `compatible-adapter.ts:443-449,488`: non-JSON sudah sebagian as-is (`summary`) — naikkan batas slice ke 500 dan konsisten; fallback `"Upstream reported an error"` diganti teks raw bila ada.
   - `stream-error-frames.ts:65`: `message || label` → coba raw text dulu, baru `label`.
3. **Tanda untuk observability**: pada `GatewayError.details` tambah `upstreamMessageAsIs: true` hanya saat passthrough aktif (masuk `PUBLIC_ERROR_DETAIL_KEYS`). Ini membedakan "pesan upstream asli" dari "pesan internal" di Request Detail tanpa mengubah kode.
4. **Envelope tidak berubah strukturnya**: `publicGatewayErrorBody` (gateway-error.ts:206) tetap; `formatPublicErrorMessage` (`:129`) tetap strip label legacy — edge case terdokumentasi: bila teks upstream dimulai `platform_unavailable:` persis, prefix ter-strip (jarang, aman).
5. **F6 (non-GatewayError)**: perilaku diubah hanya bila error terdeteksi berasal dari jalur upstream — praktisnya: adapter/claude/SSE path menjamin semua error upstream terbungkus GatewayError (sudah `:39` rethrow, `:47` map). Jadi F6 diselesaikan dengan *menutup celah pembungkus* di titik 2, bukan mengubah middleware (middleware 500 tetap benar untuk error internal sejati). `errorClientResponseBody` (`attempt-finalize.ts:40`) tidak diubah — hanya ada gateway error yang lolos tanpa bungkus; di-mitigasi oleh 2.
6. **Recursion guard**: helper murni (tanpa I/O); tidak ada rekursi. **Failure fallback**: apa pun yang gagal dalam ekstraksi → `fallback` existing; tidak pernah throw.

### 3b. Contoh sebelum/sesudah

| Kasus | Sebelum | Sesudah |
|--------|---------|---------|
| Claude 502 body `{"error":"origin is down for maintenance"}` | Sudah pass-through via `extractUpstreamMessage` (JSON terstruktur) — tidak berubah | `"origin is down for maintenance"` (as-is, tidak berubah) |
| Claude 502 body teks polos `"connection throttled, retry later"` | `"Claude response is not valid JSON (request …)"` 502 | `"connection throttled, retry later"` 502 |
| Upstream 502 HTML `<title>522 Origin Connection Time-out</title>` | `"The provider's service is temporarily unavailable …"` | `"522 Origin Connection Time-out"` 502 |
| SSE baris malformed `data: {"partial"` | `"Malformed SSE line (request …)"` | `"Malformed SSE line: data: {\"partial\" (request …)"` — atau `"Malformed SSE line (request …)"` + `details.raw` |
| Upstream 502 body `{"code":"9999","msg":"weird vendor failure"}` (identifier tak dikenal) | `"weird vendor failure"` (sudah as-is via extract) — **tidak berubah** | tidak berubah |
| Quota 429 terklasifikasi | pesan kanonik | **tidak berubah** (guarded) |

### 3c. Opsi yang dievaluasi

- **Opsi A — dipilih (D44–D49):** passthrough di titik pengumpulan upstream (2), default-on hanya untuk unknown/unparseable. Alasan: menyasar persis gap-nya, tidak menyentuh pesan terklasifikasi, tidak mengubah kontrak envelope, satu helper bersama.
- **Opsi B — ditolak:** passthrough global di `formatPublicErrorMessage`/middleware (sema). Alasan ditolak: akan meneruskan pesan internal yang seharusnya generik, dan tidak menjawab kasus body yang dibuang sebelum envelope (F2/F3) — message-nya memang tidak pernah ada.
- **Opsi C — ditolak:** opt-in via env/config selama masa transisi. Ditolak: requirement eksplisit meminta perilaku ini; scope dibatasi ketat ke unknown sehingga default-on aman (tulisan "Default off" di proposal.md berlaku untuk perilaku yang mengubah routing/dispatch; ini message-only pada jalur error).

## 4. File yang tersentuh

| Area | File |
|------|------|
| Transport — klasifikasi & mapping upstream | `src/transport/failure-policy.ts` (helper `upstreamMessageAsIs`, `mapUpstreamHttpError`) |
| Protocol — envelope & sanitasi | `src/protocol/gateway-error.ts` (tambah `upstreamMessageAsIs` ke `PUBLIC_ERROR_DETAIL_KEYS`) |
| Protocol — SSE decoder | `src/protocol/sse-decoder.ts` |
| Protocol — frame SSE | `src/protocol/stream-error-frames.ts` |
| Protocol — Claude mapping | `src/protocol/messages-errors.ts` (jika perlu ikut helper) |
| Protocol — Claude send path | `src/protocol/upstream/send-claude-messages.ts` |
| Providers — adapter generik | `src/providers/adapters/compatible-adapter.ts` |
| Transport — streaming finalize | `src/transport/dispatch/streaming/finalize.ts` (tidak tersentuh, D48) |
| Test | `test/transport/failure-policy.test.ts`, `test/transport/gateway-error-envelope.test.ts`, `test/protocol/stream-errors.test.ts`, `test/protocol/` (SSE), `test/transport/terminal-failure.test.ts` |

Tidak tersentuh: `src/console/` (envelope console terpisah), `src/providers/operations/account-error-classification.ts` (F8 hanya reference), skema/telemetri DB (tidak ada migrasi), dashboard.

## 5. Migrasi & risk

**Migrasi:** tidak ada (tanpa perubahan skema/DB/config). Perilaku baru inkremental di jalur error.

**Risk & mitigasi:**

- **Client branching pada teks pesan** (ripple): pesan unknown kini bisa berupa teks upstream asing (non-English dll). Mitigasi: hanya kategori unknown; kode tetap stabil; `error.code` tetap `platform_unavailable`; dokumentasi kontrak (code = branch key). Guard `"no public error message is written in another language"` (`gateway-error-envelope.test.ts:118`) hanya memindai string literal `new GatewayError(<literal>` — pesan dinamis dari upstream tidak dipindai, jadi tidak akan gagal.
- **Kebocoran informasi**: kontrak repo saat ini justru *verbatim* (redaction.ts:3-11; test `:467+`). Risiko kredensial ter-echo dibiarkan sesuai keputusan desain yang sudah ada — jadi D46.
- **Ukuran**: bound 500 (publik) / 4000 (raw) sudah ada; tidak ada penguatan baru yang dibutuhkan.
- **Regresi gateway error**: `mapUpstreamHttpError` message untuk kasus tanpa body tetap fallback human (`"temporarily unavailable"`) — test `:2149-2158` tetap hijau. Test `"keeps an upstream-provided message verbatim"` (`:2160`) tetap hijau.

**Baseline test (dijalankan, kuotasi):**

- `bun test test/transport/failure-policy.test.ts test/transport/gateway-error-envelope.test.ts test/protocol/stream-errors.test.ts test/transport/terminal-failure.test.ts test/transport/proxy-402-vs-account-402.test.ts` → **326 pass / 0 fail**.
- `bun test test/providers/gateway-capacity-classification.test.ts test/providers/inception-rate-limit-classification.test.ts test/providers/qoder-model-plan-gated-classification.test.ts test/providers/antigravity-validation-required.test.ts test/providers/qoder-billing-daily-count-classification.test.ts` → **30 pass / 0 fail**.

**Test baru yang harus ditulis (bukti desain):**

1. `mapUpstreamHttpError` body teks polos pada 502 → message = teks as-is (bukan "temporarily unavailable").
2. `mapUpstreamHttpError` HTML error page 502 → message memuat title (`extractHtmlTitle`).
3. `mapClaudeHttpError` body non-JSON 502 → message = raw text as-is.
4. `gatewayErrorFromStreamError` record tanpa message → fallback ke raw text bila ada, baru label.
5. Passthrough dibatasi 500 karakter; `details.raw` tetap 4000.
6. Error terklasifikasi (429 quota, 401 auth, identifier dikenal) → message tidak berubah (guard test).
7. Envelope tetap memuat `upstreamMessageAsIs` di details; `explainGatewayError` tetap strip label legacy.
8. Full suite tetap hijau (gate: `bunx tsc --noEmit`, `bun run test:backend`, `bun test test/protocol`).

## 6. Keputusan final (closed)

Bukan daftar pertanyaan. Source of truth keputusan:
`../provider-account-model-update.md` §6.8 (D44–D49). Tidak ada yang menunggu jawaban.

| ID | Keputusan final | Catatan |
| --- | --- | --- |
| D44 | Bound pesan publik **500**; `details.raw` tetap 4000. | `sanitizePublicDetail` + `MAX_UPSTREAM_ERROR_BYTES`. |
| D45 | Sumber as-is mencakup **HTML title + teks polos + JSON**. | Kasus "undefined" yang paling sering kehilangan pesan. |
| D46 | Redaksi: **verbatim, tanpa `scrubSecrets`** pada message publik. | Kontrak `redaction.ts:3-11` + `gateway-error-envelope.test.ts:467-512`; sweep hanya untuk log. |
| D47 | `applyRequestId` tetap append ` (request <id>)`. | Traceability; klien bisa strip suffix. |
| D48 | F7 diselesaikan **dengan menutup celah pembungkus**; middleware/`errorClientResponseBody` tidak diubah. | 500 `internal_error` tetap benar untuk error internal sejati. |
| D49 | Flag `upstreamMessageAsIs: true` ditambahkan ke `PUBLIC_ERROR_DETAIL_KEYS`. | Membedakan pesan upstream asli di Request Detail. |

Semua "Keputusan final (§6):", "Opsi A (direkomendasikan) / Opsi B / Opsi C", "D46",
"hanya bila F7 dipilih", dan "atau" spekulatif di §1–§5 dibaca melalui tabel ini.
Koreksi terkait: §3c Opsi A dipakai pasti (B dan C ditolak), §4 baris
`src/transport/dispatch/streaming/finalize.ts` **tidak tersentuh** (D48), §5
"Kebocoran informasi … jadi D46" kini sudah diputus (D46: verbatim).

## 7. Execution status

**Status: ✅ executed (full)** — klaster C4 + orkestrator.

| Finding | Status | Bukti |
| --- | --- | --- |
| F1 (fallback `platform_unavailable` tanpa pesan) | ✅ | `mapUpstreamHttpError` memakai `upstreamMessageAsIs(..., "")`; human sign-off hanya saat `hadUpstreamText === false`. |
| F2 (Claude non-JSON dibuang) | ✅ | `send-claude-messages.ts` membawa raw text as-is + `details.raw`; test "a Claude non-JSON body keeps the raw upstream text". |
| F3 (SSE malformed generik) | ✅ | `sse-decoder.ts` memuat cuplikan baris/sebab asli (bounded). |
| F4 (adapter: stream kosong / non-JSON / envelope tanpa message) | ✅ | `compatible-adapter.ts` slice 500 + fallback teks raw bila ada. |
| F5 (frame record tanpa message) | ✅ | `stream-error-frames.ts` fallback ke prose → `code` → `label`; flag `upstreamMessageAsIs` hanya untuk prose asli. |
| F6 (error non-GatewayError → 500 generik) | ✅ | Celah pembungkus ditutup lewat F2–F5; middleware/`errorClientResponseBody` tidak diubah (D48). |
| F7 (streaming finalize 502 generik) | ✅ | Diselesaikan lewat penutup celah pembungkus (D48); `finalize.ts` tidak tersentuh. |
| F8 (akun-health `unknown` sebagai precedent) | ⛔ | **Reference-only, sengaja tidak diubah** — `classifyAccountError` tetap menyimpan pesan upstream di `reason`; tidak ada perubahan kode yang diperlukan. |

Keputusan D44–D49 diterapkan seluruhnya. Deviasi orkestrator: helper `extractUpstreamMessageText` ditambahkan agar `code`/identifier tidak dihitung sebagai prose passthrough; dua ekspektasi lama di `stream-errors.test.ts` diperbarui sesuai D49. Tujuh test passthrough baru di `failure-policy.test.ts`.

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
