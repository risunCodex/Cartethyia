# Proposal — Wire Dialects (pola oh-my-pi) untuk chat/messages/responses

**Status:** draft v2 — matang, siap dibaca & diputuskan (belum diimplementasikan).
**Tanggal:** 2026-11-02
**Scope:** protocol / routing / provider-catalog / migration / dashboard-minimal (backend-first).
**Pendekatan:** mengadopsi pola *wire dialect* dari `oh-my-pi` (base repo ini). Bukan empat protocol family HTTP terpisah — melainkan satu lapisan dialect di bawah `wireFamily` yang di-resolve per (provider, model).

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Sumbu wire & codec

- `src/protocol/canonical-model.ts:15` — `WIRE_FAMILIES = ["chat", "responses", "messages", "gemini"]`.
- `src/protocol/registry.ts:109-128` — `loadCodec(wireFamily)` dynamic-import per family (cache per family) → `src/protocol/request/{chat,responses,messages,gemini}.ts`.
- `src/protocol/registry.ts:139-177` — `encodeWireRequest(wireFamily, request, context)` meneruskan `CodecContext`: `isOAuth`, `maxBytesOverride`, `supportsPromptCaching`, `chatTokenLimitField`, `maxOutputTokens`, `promptCacheKey`.
- `src/protocol/registry.ts:192-212` — `decodeWireStream` / `decodeWireResponse` juga terima `context`.

### 1.2 Titik injeksi sentral (penting)

Hanya **satu** adapter yang memakai codec di jalur dispatch:

- `src/providers/adapters/compatible-adapter.ts:216` — `encodeWireRequest(candidate.wire_family, effectiveRequest, {...})` di dalam `preparePayload()`.
- `src/providers/adapters/compatible-adapter.ts:376` — `decodeWireStream(wireFamily, res.body, request, { signal })`.
- `src/providers/provider-probe.ts:97` — `encodeWireRequest("chat", prepared, {...})` untuk probe.

Artinya: injeksi policy dialect cukup di satu tempat (`OpenAICompatibleAdapter`) untuk menutup seluruh jalur runtime.

### 1.3 Quirks DeepSeek/Qwen sekarang tersebar

- `src/protocol/request/chat.ts:188` — `tokenLimitField` default `"max_tokens"` (option `"max_completion_tokens"`).
- `src/protocol/request/chat.ts:227-242, 336-405` — literal `reasoning_content` di-hardcode (dipakai WorkBuddy/CodeBuddy + keluarga DeepSeek-style).
- `src/protocol/request/chat.ts:540-551` — `max_tokens` di-clamp & di-delete dengan cara yang sama untuk semua provider.
- `src/protocol/translation/quirks.ts:18-46` — tabel declarative `ParamQuirk`/`WireTokenBound` (precedent data-driven yang sudah ada).
- Qwen `enable_thinking` / `chat_template_kwargs` / tolak `tools: []` tidak punya tempat intrinsik (tidak tampil sebagai field di codec chat).

### 1.4 In-band tool-call: sudah ada 3 parser terpisah

| File | Dialect | Dipakai oleh |
| --- | --- | --- |
| `src/protocol/dsml.ts` | DSML strict (CodeBuddy) + fuzzy (Qoder) — `DsmlStreamParser`, `DsmlParseOptions` | `src/protocol/response/dsml.ts` |
| `src/protocol/response/dsml.ts` | wrapper `DsmlToolCallParser` | `src/protocol/response/chat.ts:13,86,272` |
| `src/protocol/response/omp-tool-call-markup.ts` | markup `calltool_calls:8hex>` (OMP) — `OmpToolCallMarkupParser` | `src/protocol/response/chat.ts:15,58,81,268-270` |

`src/protocol/response/chat.ts` adalah satu-satunya konsumen runtime. Belum ada `<tool_call>` Qwen dan belum ada renderer untuk membangun ulang prompt.

### 1.5 Catalog & routing

- `src/providers/provider-model-definition.ts:36-56` — `ModelDefinition` punya `wireFamily`, `reasoningEfforts`, `modalities`; **belum ada field dialect**.
- `src/providers/operations/provider-catalog-seeder.ts:77` — `db.insert(models).values(rows).onConflictDoUpdate(...)`; `src/providers/discovery/probing-service.ts:925` juga insert `models`. ModelDefinition → row `models`.
- `src/transport/routing/route-catalog.ts:308-325` — `MODEL_COLUMNS` memproyeksikan `models` ke kandidat; `RouteCandidate` membawa `wireFamily` (baris 248, 272, 723-835).
- `src/providers/integrations/deepseek.ts:33,45,54` — DeepSeek V4: `wireFamily: "messages"`, endpoint `/v1/messages` (versi Anthropic).
- `models` table saat ini: `id, provider_id, model_id, wire_family, service_kind, endpoint_path, context_limit, output_limit, modalities, reasoning, tool_call, cost, source, source_updated_at, enabled, pro_only, free_tier` — **tidak ada kolom dialect**.
- Migration terakhir: `0039_add_telemetry_provider_model_indexes.sql` (lite & full). Berikutnya: `0040`.

---

## 2. Masalah yang diminta diatasi

1. **Canonical rapuh saat dipaksa general.** Quirks keluarga (DeepSeek `reasoning_content`, `max_tokens`; Qwen `enable_thinking`/`chat_template_kwargs`/tolak `tools:[]`; strip special-token DSML) tidak punya tempat intrinsik → berubah jadi `if (providerId===…)` berserakan di dalam codec generik.
2. **DeepSeek & Qwen bukan family transport baru.** Keduanya dialect dari OpenAI-compatible (`chat`), kecuali DeepSeek anthropic-endpoint (`messages`). Menjadikannya `wireFamily` baru akan melipatgandakan codec & kolom `models.wire_family` (dan konsol validator/dashboard).
3. **In-band tool-call ditangani ad-hoc.** Tiga parser terpisah (`dsml.ts`, `response/dsml.ts`, `omp-tool-call-markup.ts`) tanpa antarmuka bersama & tanpa renderer; Qwen `<tool_call>` belum ada.
4. **Transisi antar-provider bisa lossy** (pivot 2-hop via canonical), persis yang dihindari 9router lewat direct route.

---

## 3. Desain yang diusulkan

### 3.1 Tipe inti

```ts
// src/protocol/translation/dialect/types.ts (baru)
export type DialectId =
  | "chat-default"   // OpenAI-compatible generik (default wire chat)
  | "deepseek"       // DSML + reasoning_content + max_tokens + strip tokens
  | "qwen"           // enable_thinking + <tool_call> + strict chat template
  | "claude"         // Anthropic messages (default wire messages)
  | "kimi" | "glm" | "minimax" | "gemini"; // extensibel

export interface DialectPolicy {
  readonly reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly stripSpecialTokens: "deepseek" | false;
  readonly supportsMultipleSystemMessages: boolean;
  readonly supportsToolChoice: boolean;
  readonly requiresAssistantContentForToolCalls: boolean;
  readonly allowsSyntheticReasoningContent: boolean;
  readonly thinkingFormat: "openai" | "qwen" | "deepseek" | "chat-template";
  readonly inband: DialectId | null; // codec tool-call aktif; null = structured only
}
```

### 3.2 Resolver (pure, selalu return policy)

```ts
// src/protocol/translation/dialect/resolver.ts (baru)
export function resolveDialect(
  modelId: string,
  providerId: string,
  wireFamily: WireFamily,
  override?: DialectId | null,   // dari models.dialect (DB) — menang
): DialectPolicy
```

- Precedence: **override DB** → **eksplisit `ModelDefinition.dialect`** → **heuristic** (table statis mirip `quirks.ts`) → **default family** (`claude` utk messages, `chat-default` utk chat/responses).
- Table statis `DIALECT_RULES` (bukan KDL — repo tidak punya build-step; `quirks.ts` adalah precedent). Contoh baris:

```ts
{ match: { providerId: "deepseek" }, dialect: "deepseek" },
{ match: { modelId: /qwen|portal|alibaba|qwq/i }, dialect: "qwen" },
```

- Resolver **tidak pernah throw**: selalu mengembalikan policy (fallback aman).

### 3.3 Aliran runtime (satu titik injeksi)

```
models.dialect (0040) → MODEL_COLUMNS → RouteCandidate.dialect
                              │
OpenAICompatibleAdapter.preparePayload (compatible-adapter.ts:216)
   policy = resolveDialect(candidate.model_id, candidate.provider_id,
                           candidate.wire_family, candidate.dialect)
   encodeWireRequest(wireFamily, request, { ...context, dialectPolicy: policy })
                              │
registry.ts → codec {chat|messages|responses} membaca options.dialectPolicy
```

`decodeWireStream` (compatible-adapter.ts:376) menerima `context.dialectPolicy` sama — scanner in-band & strip special-token dipakai di sisi decode. Probe (`provider-probe.ts:97`) ikut meneruskan policy.

### 3.4 Perubahan codec

**`src/protocol/request/chat.ts`**
- `reasoningContentField` menggantikan literal `reasoning_content` (baris 242, 336, 405).
- `maxTokensField` menggantikan literal `"max_tokens"` (baris 188, 540-551).
- `supportsToolChoice=false` (DeepSeek) → drop `tool_choice` dari payload.
- `supportsMultipleSystemMessages=false` (Qwen) → collapse beberapa `system` jadi satu.
- `requiresAssistantContentForToolCalls` / `allowsSyntheticReasoningContent` → kebijakan reasoning saat tool-call turn (DeepSeek V4).
- `policy.inband != null` → aktifkan scanner di `decodeWireStream` (lihat 3.5).

**`src/protocol/request/messages.ts`** — DeepSeek anthropic-endpoint: policy `deepseek` diterapkan di wire messages (konten reasoning di assistant, `max_tokens`, dsb). `claude` tetap default messages.

**`src/protocol/request/responses.ts`** — baca `reasoningContentField`/`maxTokensField` (minor).

### 3.5 In-band tool-call: `DialectDefinition` + `InbandScanner` + konsolidasi

```ts
// src/protocol/translation/dialect/inband.ts (baru)
export interface InbandScanner {
  feed(text: string): InbandScanEvent[];
  flush(): InbandScanEvent[];
}
export interface DialectDefinition {
  readonly dialect: DialectId;
  createScanner(options?: InbandScannerOptions): InbandScanner;
  renderToolCall(call: ToolCall): string;
  renderAssistantToolCalls(calls: readonly ToolCall[]): string;
  renderToolResults(results: readonly DialectToolResult[]): string;
  renderThinking(text: string): string;
}
```

- `deepseek.ts` — engine dari `src/protocol/dsml.ts` (strict + fuzzy) + markup `<tool_calls:8hex>` dari `omp-tool-call-markup.ts` + legacy `<｜tool_calls_begin｜>` + `<think>`.
- `qwen.ts` — `<tool_call>` JSON + `<think>` + `enable_thinking`/`chat_template_kwargs` (renderer & scanner).
- `chat-default.ts` — structured-only (scanner kosong).
- **Konsolidasi:** `src/protocol/response/chat.ts` (baris 13-16, 58, 81, 86, 268-272) dialihkan ke registry `DialectDefinition`; file lama `src/protocol/dsml.ts`, `src/protocol/response/dsml.ts`, `src/protocol/response/omp-tool-call-markup.ts` dihapus setelah cutover (tanpa alias — sesuai aturan repo). Pemakai hanya `response/chat.ts`, jadi blast radius kecil.

### 3.6 Direct translation route (pola 9router)

`src/protocol/registry.ts` tetap memilih codec per family. Tambahkan map terdaftar:

```ts
// registry: translateWireRequest(sourceFamily, targetFamily, payload)
// 1) direct route `${source}:${target}` bila ada
// 2) fallback: pivot via canonical
```

- Didaftarkan hanya untuk pasangan yang terbukti lossy lewat canonical: mulai `messages:chat` & `responses:chat` (thinking/DSML/tool pairing).
- Default tetap pivot canonical; direct route adalah override terdaftar.

### 3.7 Side-channel provider-native

Verifikasi di `src/protocol/canonical-model.ts`: `CanonicalEvent` **belum punya slot generik**. Yang ada:
- `ContentPart` `extension` (`:320`) — `{ kind: "extension"; name; payload }`.
- `ConversationState.provider_state` (`:508`).

**Rekomendasi:** tanpa field baru di `CanonicalEvent`. Pakai `ContentPart.extension` untuk payload native per part (mis. `reasoning_content` raw, DSML raw) & `ConversationState` utk state; strip saat cross-provider, pertahankan saat same-provider. Tambah field event-level hanya jika nanti terbukti perlu.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Tipe + policy | `src/protocol/translation/dialect/types.ts` (baru) |
| Resolver + rules | `src/protocol/translation/dialect/resolver.ts`, `rules.ts` (baru) |
| In-band codec | `src/protocol/translation/dialect/inband.ts`, `deepseek.ts`, `qwen.ts`, `chat-default.ts` (baru) |
| Konsolidasi lama | hapus `src/protocol/dsml.ts`, `src/protocol/response/dsml.ts`, `src/protocol/response/omp-tool-call-markup.ts`; retarget `src/protocol/response/chat.ts` |
| Codec | `src/protocol/request/chat.ts`, `messages.ts`, `responses.ts` |
| Registry | `src/protocol/registry.ts` — `CodecContext.dialectPolicy`, teruskan ke codec; direct-route map |
| Adapter | `src/providers/adapters/compatible-adapter.ts` — resolve+inject di `preparePayload`/`decodeWireStream` |
| Probe | `src/providers/provider-probe.ts` — teruskan policy |
| Catalog | `src/providers/provider-model-definition.ts` (field opsional `dialect?`); `src/providers/integrations/deepseek.ts`, `dashscope-models.ts` (set dialect) |
| Routing | `src/transport/routing/route-catalog.ts` — `MODEL_COLUMNS` + `RouteCandidate.dialect` |
| Persistence | `src/persistence/schema.ts` (models.dialect); seeder `src/providers/operations/provider-catalog-seeder.ts`, `src/providers/discovery/probing-service.ts` |
| Migration | `migrations/lite-sqlite3/0040_add_models_dialect.sql`, `migrations/full-postgres/0040_add_models_dialect.sql` |
| Dashboard (minimal) | `dashboard/src/features/providers/ProvidersPage.tsx` / Models — badge read-only dialect |
| Tes | `test/protocol/dialect*.test.ts`, `test/protocol/request/chat-dialect.test.ts`, `test/protocol/request/messages-deepseek.test.ts`, `test/providers/model-sync-without-account.test.ts` (migration), matrix round-trip |

---

## 5. Migrasi & risk

### 5.1 Migration `0040` (lite & full)

```sql
-- lite-sqlite3/0040_add_models_dialect.sql
ALTER TABLE "models" ADD COLUMN "dialect" TEXT;
```

```sql
-- full-postgres/0040_add_models_dialect.sql
ALTER TABLE "models" ADD COLUMN "dialect" TEXT;
```

- `NULL` = resolver fallback (default aman). Tidak ada backfill wajib; `NULL` justru default.
- `models.dialect` dibaca `MODEL_COLUMNS` → `RouteCandidate.dialect` → override resolver.
- Dashboard `ProvidersPage.tsx:52` tetap `["chat","responses","messages"]` — tidak berubah (kita tidak menambah family).

### 5.2 Default off / backward compatible

- Tanpa `dialect` diset/diresolve → policy sama dengan perilaku hari ini (`chat-default`/`claude`). Payload byte-identik (dibuktikan golden test P0).
- `ModelDefinition.dialect` opsional; resolver heuristic hanya menebak saat tidak ada override.

### 5.3 Guard tiap jalur baru

- `resolveDialect` pure, selalu return, tidak pernah throw.
- Scanner in-band hanya aktif ketika `policy.inband != null`; `chat-default` tidak pernah mengaktifkan.
- Strip special-token hanya untuk `policy.stripSpecialTokens === "deepseek"`.
- Direct route hanya untuk pasangan terdaftar; selain itu pivot canonical.
- `CodecContext.dialectPolicy` opsional — codec yang belum menerima policy tetap berjalan (fallback ke literal lama sampai port selesai).

### 5.4 Risk & mitigation

| Risk | Mitigasi |
| --- | --- |
| Regresi wire chat | Golden payload P0 (byte-identik) utk default; run full suite |
| `reasoning_content` dobel handling | Satu sumber: `policy.reasoningContentField` |
| Scanner aktif di tempat salah | Gate `policy.inband != null` |
| DeepSeek anthropic salah policy | Test khusus `messages` + provider deepseek |
| Konsolidasi parser pecah | Retarget hanya `response/chat.ts`; pindahkan test parser lama ke test dialect |
| Migration pecah di salah satu dialect | Test sqlite-type-parity & boot/migrate (sudah ada di suite) |

### 5.5 Test matrix

1. **Unit resolver:** `resolveDialect` mapping (deepseek/qwen/claude/default), precedence override DB > ModelDefinition > heuristic > default.
2. **Golden default:** `canonicalToChatPayload` policy `chat-default` → payload **byte-identik** dengan hari ini (tool, reasoning, system, max_tokens).
3. **Golden DeepSeek (chat):** `reasoning_content` + `max_tokens` + drop `tool_choice` + `requiresAssistantContentForToolCalls`; strip `stripDeepseekSpecialTokens` di stream.
4. **Golden Qwen:** `enable_thinking` + `thinking_budget` + satu system + tanpa `tools: []`.
5. **Round-trip:** chat→messages→chat (tool, thinking, image) tidak kehilangan field (matrix ala `tests/translator/matrix.js` 9router).
6. **Stream in-band:** parse DSML strict & fuzzy; parse Qwen `<tool_call>`; sisa teks bersih; nama tool undeclared tidak di-promote.
7. **Direct route:** `messages:chat` dengan thinking & DSML → payload target benar.
8. **Migration:** `0040` diterapkan ke lite & full; `NULL` terserap resolver; model-sync tanpa account tetap hijau.
9. **Regression:** `bun run test:backend` hijau.

---

## 6. Fase implementasi (matang, berurutan)

| Fase | Isi | Bukti keluar |
| --- | --- | --- |
| P0 | Capture golden payload hari ini (chat/messages/responses: tool, reasoning, system, max_tokens, stream) | test golden commit ke repo |
| P1 | `types.ts` + `resolver.ts` + `CodecContext.dialectPolicy` + registry + adapter inject (default = existing) | full suite hijau; payload masih identik |
| P2 | Migration `0040` + `ModelDefinition.dialect` + seeder/probing + `MODEL_COLUMNS` + `RouteCandidate.dialect` | migration test + model-sync test |
| P3 | `chat.ts` baca policy (deepseek/qwen behavior), `responses.ts` minor | golden chat/deepseek/qwen |
| P4 | `inband.ts` + `deepseek.ts` + `qwen.ts` + konsolidasi & hapus parser lama | stream in-band tests |
| P5 | `messages.ts` deepseek + direct translation route | round-trip + direct route tests |
| P6 | Dashboard badge read-only; telemetry opsional (lihat open questions) | dashboard build/typecheck |
| P7 | Test matrix penuh + verifikasi live gateway per provider (deepseek, qwen, claude, chat default) | laporan verifikasi |

> Catatan: P2 boleh maju sebelum P3 — urutan hanya memudahkan review; yang tidak boleh dilanggar adalah **default-off** sampai P3.

---

## 7. Pertanyaan terbuka (dengan rekomendasi)

1. **Mode dashboard:** read-only badge (P6) vs editor untuk override dialect per model? Rekomendasi: **read-only dulu**; editor menyusul (perlu route console + kontrak).
2. **Telemetry:** tambah kolom `dialect` di `telemetry_events` sekarang? Rekomendasi: **nanti** — phase ini cukup memakai payload capture & log warn saat fallback berubah.
3. **Nama kolom:** `dialect` vs `dialect_id`? Rekomendasi: **`dialect`** (nilai string `DialectId`).
4. **Wajibkah `ModelDefinition.dialect` untuk provider baru?** Rekomendasi: **opsional**, resolver fallback menangani.
5. **Scope `gemini` wire:** ikut dialect? Rekomendasi: **belum** — Gemini sudah punya codec sendiri; cukup `chat`/`messages`/`responses` pada fase ini.
6. **Kinerja:** cache resolver per `(modelId, providerId, wireFamily, override)`? Rekomendasi: **ya**, Map kecil + invalidate per snapshot revision.
