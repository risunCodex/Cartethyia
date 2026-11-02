# Proposal — Wire Dialects (pola oh-my-pi) untuk chat/messages/responses

**Status:** draft untuk dibaca, belum diimplementasikan.
**Tanggal:** 2026-11-02
**Scope:** protocol / routing / provider-catalog (backend). Dashboard & schema tidak tersentuh kecuali tercatat.
**Pendekatan:** mengadopsi pola *wire dialect* dari `oh-my-pi` (base repo ini), bukan membuat empat protocol family HTTP terpisah.

---

## 1. Kondisi saat ini (dari kode)

- `src/protocol/canonical-model.ts:15` — hanya ada satu sumbu wire:
  `WIRE_FAMILIES = ["chat", "responses", "messages", "gemini"]`.
- `src/protocol/registry.ts:109-128` — `loadCodec()` memilih codec per `wireFamily` (dynamic import, cache per family). Ini sudah benar: per-wire module terpisah.
- `src/protocol/request/chat.ts:188` — `tokenLimitField` default `"max_tokens"`, option `"max_completion_tokens"`.
- `src/protocol/request/chat.ts:227-242, 336-405` — `reasoning_content` side-channel di-hardcode di codec chat (dipakai untuk WorkBuddy/CodeBuddy dan keluarga DeepSeek-style).
- `src/protocol/request/messages.ts:649-662` — codec Anthropic menangani `max_tokens` wajib, floor, dsb.
- `src/protocol/dsml.ts:21-58` — sudah ada `DsmlParseOptions` (dialect CodeBuddy strict vs Qoder fuzzy): seed untuk DSL.
- `src/protocol/translation/quirks.ts:18-46` — tabel *declarative* `ParamQuirk`/`WireTokenBound`: precedent untuk pendekatan data-driven.
- `src/providers/integrations/deepseek.ts:33,45,54` — DeepSeek V4 masuk `wireFamily: "messages"` (endpoint `/v1/messages`, versi Anthropic).
- `src/providers/provider-model-definition.ts:36-56` — `ModelDefinition` punya `wireFamily`, `reasoningEfforts`, `modalities`, tapi **belum ada field dialect/compat**.
- Tidak ada konsep `DialectId` / `DialectPolicy` / `InbandScanner` yang menyeluruh; `dsml.ts` adalah satu-satunya mekanisme in-band tool-call.

## 2. Masalah yang diminta diatasi

1. **Canonical rapuh saat dipaksa general.** Quirks keluarga (DeepSeek `reasoning_content`, `max_tokens`; Qwen `enable_thinking`/`chat_template_kwargs`/tolak `tools:[]`; strip special-token DSML) tidak punya tempat intrinsik → berubah jadi `if (providerId===…)` berserakan di dalam codec generik.
2. **DeepSeek & Qwen bukan family transport baru.** Keduanya adalah dialect dari OpenAI-compatible (chat), kecuali DeepSeek anthropic-endpoint (messages). Memaksa mereka jadi `wireFamily` baru akan melipatgandakan codec.
3. **In-band tool-call (DSML / `<tool_call>` Qwen) ditangani ad-hoc**, hanya recovery parsial (`dsml.ts`), tanpa renderer untuk membangun ulang prompt & tanpa scanner generik.
4. **Transisi antar-provider bisa lossy** (pivot 2-hop), persis yang dihindari 9router lewat direct route.

## 3. Desain yang diusulkan

Mengadopsi tiga pola utama oh-my-pi, dengan penyesuaian terhadap struktur Cartethyia.

### 3.1 `DialectId` + `DialectPolicy` (resolved compat object)

Tambahkan lapisan di bawah `wireFamily`, tidak menggantikannya:

```ts
// src/protocol/translation/dialect/types.ts (baru)
export type DialectId =
  | "chat-default"      // OpenAI-compatible generik
  | "deepseek"          // DSML + reasoning_content + max_tokens + strip tokens
  | "qwen"              // enable_thinking + <tool_call> + strict chat template
  | "claude"            // Anthropic messages (default utk wireFamily messages)
  | "kimi" | "glm" | "minimax" | "gemini"; // extensible

export interface DialectPolicy {
  readonly reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly stripSpecialTokens: "deepseek" | false;
  readonly supportsMultipleSystemMessages: boolean;
  readonly supportsToolChoice: boolean;
  readonly requiresAssistantContentForToolCalls: boolean;
  readonly allowsSyntheticReasoningContent: boolean;
  readonly thinkingFormat: "openai" | "qwen" | "deepseek" | "chat-template";
  readonly inband: DialectId | null; // tool-call codec aktif, atau null = structured only
}
```

**Resolver** (mirip `detectOpenAICompat` omp): `resolveDialect(modelId, providerId, wireFamily) → DialectPolicy`. Sumber: table statis mirip `quirks.ts` (bukan KDL — repo tidak punya build-step KDL; TS table adalah precedent paling dekat). Fallback:

- `wireFamily === "messages"` → `claude`.
- `providerId === "deepseek"` → `deepseek` (dengan varian: endpoint messages → tetap policy deepseek, tapi di-apply di codec messages).
- `modelId` match qwen/portal/alibaba → `qwen`.
- sisanya → `chat-default`.

### 3.2 Codec membaca `DialectPolicy`, bukan hardcode

`src/protocol/request/chat.ts` (dan `messages.ts` untuk DeepSeek anthropic) menerima `policy: DialectPolicy` via `CodecContext`/options:

- `reasoningContentField` menggantikan literal `reasoning_content` (baris 242, 336, 405).
- `maxTokensField` menggantikan literal `"max_tokens"` (baris 188, 540-551).
- `stripSpecialTokens` mengaktifkan pembersihan DSML/special-token di stream (di `decodeWireStream` chat).
- `supportsMultipleSystemMessages=false` (Qwen) → collapse system jadi satu.
- `supportsToolChoice=false` (DeepSeek) → drop `tool_choice`.
- `requiresAssistantContentForToolCalls` / `allowsSyntheticReasoningContent` → perilaku reasoning saat tool-call turn (eksplisit dari DeepSeek V4).

Poin kunci: **codec tidak lagi menebak dari `providerId`**, ia membaca policy hasil resolve — persis `OpenAICompatPolicy` omp.

### 3.3 `DialectDefinition` + `InbandScanner` (in-band tool-call codec)

Upgrade `dsml.ts` menjadi codec penuh (pola `DialectDefinition` omp):

```ts
// src/protocol/translation/dialect/inband.ts (baru)
export interface InbandScanner {
  feed(text: string): InbandScanEvent[];
  flush(): InbandScanEvent[];
}
export interface DialectDefinition {
  readonly dialect: DialectId;
  readonly prompt: string;
  createScanner(options?: InbandScannerOptions): InbandScanner;
  renderToolCall(call: ToolCall): string;
  renderAssistantToolCalls(calls: readonly ToolCall[]): string;
  renderToolResults(results: readonly DialectToolResult[]): string;
  renderThinking(text: string): string;
}
```

- `deepseek.ts`: DSML (`<｜DSML｜ calls>` dll) + legacy `<｜tool_calls_begin｜>` + `<think>` — re-use `src/protocol/dsml.ts` engine.
- `qwen.ts`: `<tool_call>` JSON + `<think>` + `enable_thinking`.
- `chat-default.ts`: structured-only (scanner kosong).
- Dipasang di **decodeWireStream chat/messages** (scan ke `CanonicalEvent`) dan di **encode** (renderer untuk prompt replay) — sama seperti `InbandScanner` omp dipasang di stream.

### 3.4 Direct route antar pasangan rapuh (pola 9router)

`src/protocol/registry.ts` saat ini hanya memilih codec per family. Tambahkan mekanisme *translation route*:

```ts
// registry: translateRequest(sourceWire, targetWire, body) 
// 1) coba direct route `${source}:${target}`
// 2) fallback: source → openai → target (pivot)
```

Didaftarkan hanya untuk pasangan yang terbukti lossy lewat pivot (contoh: `messages → chat` dengan thinking/DSML; `responses → chat`). Default tetap pivot 2-hop; direct route adalah override terdaftar.

### 3.5 `providerPayload`/`providerMetadata` side-channel (preservasi native)

Verifikasi di `src/protocol/canonical-model.ts`: `CanonicalEvent` **belum punya slot `providerPayload` generik**. Yang sudah ada:

- `ContentPart` `extension` (`canonical-model.ts:320`) — `{ kind: "extension"; name; payload }`, bisa membawa data native per part.
- `ConversationState.provider_state` (`canonical-model.ts:508`) — untuk state stateful/opaque.

Rekomendasi phase 1: **jangan menambah field baru ke `CanonicalEvent`**. Gunakan `ContentPart.extension` untuk payload native per part (mis. `reasoning_content` raw, DSML raw) dan `ConversationState` untuk state; field di-strip saat cross-provider, dipertahankan saat same-provider. Kalau nanti terbukti butuh slot event-level, tambah field opsional saat itu — bukan sekarang.

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Tipe dialect + policy | `src/protocol/translation/dialect/types.ts` (baru) |
| Resolver | `src/protocol/translation/dialect/resolver.ts` (baru) |
| Codec in-band | `src/protocol/translation/dialect/deepseek.ts`, `qwen.ts`, `chat-default.ts`, `inband.ts` (baru); `src/protocol/dsml.ts` direfactor/dipakai ulang |
| Codec chat | `src/protocol/request/chat.ts` (baca policy) |
| Codec messages | `src/protocol/request/messages.ts` (baca policy utk DeepSeek anthropic) |
| Codec responses | `src/protocol/request/responses.ts` (baca policy) |
| Registry | `src/protocol/registry.ts` (teruskan policy; tambah direct-route map) |
| Canonical model | `src/protocol/canonical-model.ts` (`providerPayload`/`providerMetadata` sudah ada? verifikasi; tambah kalau perlu) |
| Catalog | `src/providers/provider-model-definition.ts` (field optional `dialect?: DialectId`); `src/providers/integrations/deepseek.ts`, `dashscope-models.ts` (set dialect eksplisit) |
| Quirks | `src/protocol/translation/quirks.ts` (tetap; bisa jadi sumber data awal resolver) |
| Tes | `test/protocol/dialect*.test.ts`, `test/protocol/request/chat-dialect.test.ts`, matrix round-trip (pola `tests/translator/matrix.js` 9router) |

## 5. Migrasi & risk

- **Tanpa migration DB.** `wireFamily` tetap; hanya bertambah field opsional `dialect` di `ModelDefinition`/catalog (tidak wajib; resolver punya fallback). `WIRE_FAMILIES` tidak berubah → console schema/validator tidak perlu disentuh.
- **Default off / backward compatible:** jika `dialect` tidak di-set, resolver fallback ke perilaku hari ini (`chat-default`/`claude`). Tidak ada perubahan observable sampai suatu model men-set dialect atau resolver memetakannya.
- **Risk & mitigation:**
  - *Regresi wire chat* → golden tests per bentuk request (reasoning, tool, system, max_tokens) sebelum/sesudah refactor; assert payload identik untuk `chat-default`.
  - *DSML scanner aktif di tempat yang salah* → scanner hanya aktif ketika `policy.inband` non-null; mati untuk `chat-default`.
  - *DeepSeek anthropic endpoint salah policy* → test khusus `messages` + provider deepseek (reasoning_content & max_tokens di wire messages).
  - *Double handling reasoning_content* (chat & messages) → satu sumber: `policy.reasoningContentField`.
- **Test list:**
  1. Unit: `resolveDialect` mapping (deepseek/qwen/claude/default).
  2. Golden: `canonicalToChatPayload` dengan policy deepseek → `reasoning_content` + `max_tokens`; policy qwen → `enable_thinking` + satu system + tanpa `tools:[]`; default → payload hari ini byte-identik.
  3. Round-trip: chat→messages→chat (tool, thinking, image) tidak kehilangan field.
  4. Stream: DSML & `<tool_call>` Qwen di-parse jadi `CanonicalEvent` (toolCall), sisa teks bersih.
  5. Regression: full backend suite (target `bun run test:backend`).

## 6. Pertanyaan terbuka

1. **Scope phase 1:** mulai dari `chat` saja (deepseek+qwen via chat), atau sekaligus `messages` (DeepSeek anthropic endpoint)? Rekomendasi: **chat dulu**, messages menyusul — chat adalah mayoritas provider & paling banyak if-branches.
2. **Sumber kebenaran policy:** table TS statis (mirip `quirks.ts`) vs KDL rules (pola omp persis). Rekomendasi: **TS table** — tidak perlu build-step baru, dan `quirks.ts` sudah precedent.
3. **Lokasi direktori:** `src/protocol/translation/dialect/` (dekat quirks/normalize) vs `src/protocol/dialect/`. Rekomendasi: **translation/dialect/**.
4. **Field `dialect` di ModelDefinition** diperbolehkan & bersifat opsional, atau murni resolver berbasis id? Rekomendasi: **opsional di ModelDefinition + fallback resolver** (eksplisit menang, heuristic menebak).
5. **Direct route:** daftarkan pasangan awal mana? Rekomendasi mulai dari `messages:chat` (pivot paling umum dipakai untuk DeepSeek anthropic → model chat) & `responses:chat`.
6. **providerPayload:** sudah terverifikasi — `CanonicalEvent` belum punya slot generik; gunakan `ContentPart.extension` + `ConversationState.provider_state` (lihat §3.5). Perlu keputusan: cukup itu, atau nanti tambah field event-level kalau terbukti perlu.
