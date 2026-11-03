# Proposal — context-size booming / token-limit overflow audit

**Status:** executed (full) — semua item dieksekusi end-to-end; lihat §5.
**Tanggal:** 2026-11-03
**Scope:** seluruh arithmetic output-token/budget/context-window/byte-size di `src/`, khususnya saat nilai bisa membesar tak terkendali ("booming") saat model berubah atau caller mengirim nilai besar.
**Method:** sweep pola int32/bitwise + baca langsung seluruh path token math (messages/responses/chat/quirks/model-thinking/qoder/trae/antigravity/catalog) + 1 subagent trace dalam. **Belum ada edit — proposal dulu.**

---

## 1. Temuan utama (jujur)

**Tidak ada arithmetic int32 literal di token math** — semua nilai token adalah IEEE-754 double, jadi tidak ada yang "wrap" di 2^31. Tapi ada dua hal nyata:

1. **Unbounded balloon** di `max_tokens` (thinking budget + 1024 tanpa ceiling) — ini persis mode gagal "context size booming" yang kamu maksud.
2. **Satu-satunya uint32 literal** ada di packed catalog offline (`ctx`/`out` kolom u32) — latent.

Keduanya punya akar yang sama: **model's catalog `maxOutputTokens` hanya di-consult di wire `chat` (lewat compatible adapter); wire Messages/Responses/Trae tidak pernah melihatnya.**

---

## 2. Findings

| # | File:line | Masalah | Severity | Effort |
|---|---|---|---|---|
| O-01 | `src/protocol/request/messages.ts:679-687,716-720` + `src/protocol/translation/capabilities.ts:251-268` | **Messages: thinking budget balloon `max_tokens` tanpa batas.** Non-OAuth → `maxAllowed = Number.MAX_SAFE_INTEGER`, jadi `ensureMaxTokensForThinking` tidak pernah throw & `budget + 1024` lolos apa adanya (caller `budget_tokens: 1e6` → `max_tokens: 1,001,024`; `9e15` → `~9e15`). `resolveWireMaxTokens` dipanggil **tanpa `maxOutputTokens`** → catalog limit model tidak pernah diterapkan di wire Messages. `payload.max_tokens` ship verbatim. | **HIGH** | M |
| O-02 | `src/protocol/request/responses.ts:340-348` + `quirks.ts:73` | **Responses: `max_output_tokens` pass-through tanpa ceiling.** `resolveWireMaxTokens("responses", …)` tanpa `maxOutputTokens`; nilai caller sampai 2^53 lolos. Catalog limit model tidak relevan di sini. | **HIGH** | M |
| O-03 | `src/protocol/request/chat.ts:575-577` + `quirks.ts:71` + `compatible-adapter.ts:233` | Chat wire: ceiling hanya ada saat compatible adapter mengirim `candidate.output_limit`; panggil langsung codec lain atau route dengan `output_limit` null → nilai besar pass-through (desain: "unknown model passes caller's value through"). Fallback tak terikat. | MED | S |
| O-04 | `src/providers/integrations/trae/trae-protocol.ts:259-269` | Trae: `max_tokens: controls.max_tokens` verbatim — tanpa `resolveWireMaxTokens`, tanpa normalize, tanpa clamp. Caller nilai besar pergi langsung ke Trae. Roster aman (defineModel clamp output ≤ context). | MED | S |
| O-05 | `src/providers/integrations/qoder/qoder.ts:626-641` | Qoder: aman (selalu clamp ke roster ceiling 65k–512k). **Tapi** discovery model (row tanpa `max_output_tokens`) diam-diam di-clamp ke fallback 65_536 walaupun ceiling asli lebih tinggi — shrink, bukan balloon; correctness gap. | MED | S |
| O-06 | `src/providers/discovery/catalog/catalog-format.ts:237,424-433` + `scripts/tools/generate-models.ts:460,469-470` | **Offline catalog: kolom u32 `ctx`/`out` bisa wrap ≥ 2^32.** Tulis nilai ≥ 4,294,967,296 → wrap mod 2^32; reader mengembalikan angka sampah sebagai limit nyata. Saat ini tidak triggerable (positiveInt → 0 utk non-finite; token real maks ~10M). Satu-satunya batas uint32 literal di repo. | MED | S |
| O-07 | `src/protocol/translation/dialect/model-thinking.ts:74-89` | `outputFloorFor`: aman (guard undefined/non-finite/≤0; `Math.floor(modelOutputLimit/2)`). Hanya balloon kalau catalog sendiri deklarasi output limit absurd. | SAFE | — |
| O-08 | `src/transport/dispatch/token-count.ts:345,399`, `image-clamp.ts:91-96`, `reasoning.ts:177-200`, antigravity/kimi bootstrap | Semua aman — bounded oleh memory/katalog, double handling, fixed constants. | SAFE | — |
| O-09 | `src/providers/integrations/kiro/kiro.ts:305-312` | `Math.round((window * percentage)/100)` — `percentage` upstream unvalidated, tapi hanya telemetry (bukan request/context sizing). | SAFE | — |

---

## 3. Akar masalah & desain fix

Masalah inti: **wire Messages/Responses tidak pernah menerima `maxOutputTokens` dari catalog model.** `registry.encodeWireRequest` hanya meneruskan `maxOutputTokens` ke family `chat` (registry.ts:170-187). Akibatnya:
- Messages: budget+1024 balloon.
- Responses: max_output_tokens pass-through.
- Trae: verbatim.

### Fix inti (O-01 + O-02):
1. **Teruskan `maxOutputTokens` (dari `candidate.output_limit` / catalog) ke codec Messages & Responses** — mirror mekanisme yang sudah ada di chat (`registry.encodeWireRequest` → `canonicalToChatPayload`).
2. **Clamp `maxTokens` ke catalog limit setelah `ensureMaxTokensForThinking`** di messages.ts.
3. **Cap `maxAllowed` non-OAuth di `ensureMaxTokensForThinking`** ke catalog limit (atau ceiling waras) alih2 `MAX_SAFE_INTEGER` — supaya guard `budget + 1024 > maxAllowed` (capabilities.ts:258) benar-benar bisa fire dan memberi 400 bersih untuk budget mustahil.

### Fix pendukung (O-04):
4. Route Trae lewat `resolveWireMaxTokens("chat", …, { maxOutputTokens: <roster out> })` seperti chat codec.

### Fix minor (O-03, O-05, O-06):
5. O-03: dokumentasikan bahwa direct-call tanpa output_limit = intentional pass-through; opsional tambah fallback ceiling waras.
6. O-05: discovery `defineModel` untuk qoder sebaiknya set `out` dari roster (hilangkan silent shrink ke 65_536).
7. O-06: di `positiveInt` / saat tulis, clamp `row.context`/`row.output` ke `< 2^31` atau pakai f64/u64; minimal tambah assert `row.context < 2^32` di generator supaya sumber data masa depan gagal keras, bukan wrap.

---

## 4. Validasi

- Setelah implementasi: `bunx tsc --noEmit` + `bun run test:backend` (baseline 4241 pass / 0 fail) + `bun test test/protocol` (599 pass / 0 fail).
- Test baru: Messages request `budget_tokens: 1e6` + model catalog limit 64k → `max_tokens === 64k` (atau typed 400); Responses `max_output_tokens: 1e9` + catalog limit → clamp; Trae huge value → clamp; generate-models assert guard.
- **Catatan verifikasi:** perubahan ini mengubah payload `max_tokens` untuk request ekstrem (sebelumnya ship verbatim). Untuk input normal (budget kecil ≤ catalog limit) tidak ada perubahan wire.

---

## 5. Rekomendasi eksekusi

Semua 7 item dikerjakan bersama (1 batch) — O-01/O-02 inti, sisanya pendukung. Estimasi M (1/2 hari). Marker ✅/⛔ di-update di proposal ini. Local only, no push.

---

## 6. Execution status (2026-11-03)

| # | Item | Status |
|---|---|---|
| O-01 | Messages: clamp max_tokens ke catalog limit + maxAllowed di-cap | ✅ |
| O-02 | Responses: maxOutputTokens di-thread + clamp | ✅ |
| O-03 | Chat pass-through didokumentasikan (comment-only) | ✅ |
| O-04 | Trae: route lewat resolveWireMaxTokens dengan roster output limit | ✅ |
| O-05 | Qoder discovery: roster ceiling dipakai, tidak shrink ke 65_536 | ✅ |
| O-06 | Packed catalog: guard ≥ 2^31 di generator (checkedPackedLimit) | ✅ |
| O-07/O-08/O-09 | Verifikasi aman — tidak ada action | ✅ |

**Yang berubah:**
- `src/protocol/registry.ts` — `WireEncodingContext` + `encodeWireRequest` skarang meneruskan `maxOutputTokens` ke family `messages` & `responses` (mirror chat).
- `src/protocol/request/messages.ts` — `maxOutputTokens` di-thread ke `resolveWireMaxTokens`; `maxAllowed` non-OAuth di-cap ke catalog limit (guard 400 bisa fire); clamp final `maxTokens` ke catalog limit.
- `src/protocol/request/responses.ts` — `maxOutputTokens` di-thread ke `resolveWireMaxTokens`.
- `src/providers/integrations/trae/trae-protocol.ts` + `trae.ts` — `buildTraeChatBody` route `controls.max_tokens` lewat `resolveWireMaxTokens("chat", …, { maxOutputTokens })` dengan roster output limit.
- `src/providers/integrations/qoder/qoder-catalog.ts` + `qoder.ts` — `qoderRosterMaxOutputFor`; discovery set `out` dari roster; 65_536 fallback hanya bila caller+roster tidak menyatakan limit.
- `src/protocol/translation/quirks.ts` — komentar O-03.
- `scripts/tools/generate-models-util.ts` (baru) + `generate-models.ts` + `catalog-format.ts` — `checkedPackedLimit` (throw ≥ 2^31) untuk `ctx`/`out`.

**Test baru:** Messages budget 1e6 + limit 64k → 400 / clamp; Responses 1e9 → clamp; Trae huge → clamp ke 128k; qoder discovery tidak shrink; `generate-models-util.test.ts` guard 2^31.

**Validasi (tereksekusi):**
| Gate | Hasil |
|---|---|
| `bunx tsc --noEmit` | 0 error |
| Dashboard typecheck | 0 |
| Backend suite | **4258 pass / 0 fail** |
| Protocol suite | **605 pass / 0 fail** (+6) |

Catatan: untuk input normal (budget ≤ catalog limit) wire byte-identical; hanya request ekstrem yang kini di-clamp. Local only, no push.
