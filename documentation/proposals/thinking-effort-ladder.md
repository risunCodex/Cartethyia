# Proposal — Effort & Thinking Ladder (desain ulang, pola oh-my-pi)

**Status:** implemented — dieksekusi di commit `cc799f69` (lihat §7). Proposal dipertahankan sebagai catatan desain.
**Tanggal:** 2026-11-02
**Scope:** protocol / routing / provider-catalog / dialect layer (backend). Dashboard & schema tidak tersentuh kecuali tercatat.
**Referensi:** audit `oh-my-pi` (`packages/catalog/src/effort.ts`, `model-thinking.ts`, `compat/resolve.ts`, `compat/axes.ts`, `compat/rules/classes/*.kdl`) — output lengkap di catatan sesi ini.

---

## 1. Kondisi saat ini (dari kode)

### 1.1 Satu ladder canonical + hardcoded resolver

- Ladder tunggal: `REASONING_EFFORT_LADDER = ["instant","minimal","low","medium","high","xhigh","max"]`
  (`src/protocol/translation/thinking.ts:14`).
- `resolveSupportedReasoningEfforts(modelId, wireFamily, declaredEfforts)` (`thinking.ts:304`)
  **mencocokkan string-id secara manual** per family & generasi:

  | Kondisi | Hasil |
  | --- | --- |
  | `requestedEfforts` explicit (catalog) | filter terhadap ladder |
  | `wireFamily === "responses"` & `gpt-5.5` | `[low..xhigh]` |
  | `responses` & `gpt-5.6/gpt-6/daybreak` | `[low..max]` |
  | `responses` lain | `[minimal..xhigh]` |
  | `muse` | `[minimal..xhigh]` |
  | `gemini` | `[minimal..high]` |
  | `mimo-v2.6` | `[low,medium,high]` |
  | `mercury` && chat | `[instant,low,medium,high]` |
  | `claude opus-4-6/sonnet-4-6` | `[low..high]` |
  | `claude fable/mythos/opus-5/...` | `[low..max]` |
  | `claude opus-4-5/dstb` | `[minimal..xhigh]` |
  | default | `[minimal..max]` |

  → Ini **blok hardcode dengan if-chain**: menambah model baru = menambah `if (id.includes(...))`.

### 1.2 Clamp: satu fungsi, tapi terpapar ke dua arah

- `clampReasoningEffort(requested, supported)` (`thinking.ts:415`): clamp **turun** ke tier tertinggi yang didukung ≤ requested; kalau tidak ada, pakai `supported[0]` (floor).
- Tapi di `normalizeThinkingConfig` (`thinking.ts:487`) & ketiga codec (`chat.ts:508`, `responses.ts:320`, `messages.ts:844`) clamp dipanggil dengan `resolveSupportedReasoningEfforts(...)` → hasil yang sama dihitung **ulang setiap request** (pola build-time di OMP dihitung sekali per model).

### 1.3 Dual mapping budget ↔ level (dua sumber kebenaran)

- `LEVEL_TO_BUDGET` (`thinking.ts:56`): level → token budget.
- `BUDGET_LEVEL_CEILINGS` (`thinking.ts:75`) + `budgetToLevel` (`thinking.ts:94`): budget → level (midpoint, sebagian "dipatok" di 4096).
- `reasoningEffortFromIntent` (`src/protocol/reasoning.ts:16`): jika intent Anthropic `thinking_type`+`budget_tokens`, default  "high"; budget → level.
- `messages.ts:699-702`: memakai `LEVEL_TO_BUDGET[level]` + floor 1024 (budget mode).
- OMP: budget per effort disimpan dalam `ThinkingConfig.effortBudgets` (baked sekali), bukan tersebar sebagai konstanta global + if.

### 1.4 Workaround / "other clamp" yang tersebar

- `applyDeepSeekReasoning` (`reasoning.ts:37`): memaksa `thinking={type:"enabled"}` dan `reasoning_effort="high"` untuk model deepseek (hardcode default).
- `ensureChatReasoningReplayPresence` / `backfillDeepSeekReasoningContent` (`reasoning.ts:79,104`): replay rule per regex model family.
- `geminiThinkingOutputFloor` / `clampedEffortOutputFloor` (`reasoning.ts:145,177`): output-token floor saat effort di-clamp (BUDDY_LEVEL_RANK + CLAMPED_EFFORT_MIN_OUTPUT_TOKENS).
- `claudeUsesAdaptiveThinking` (`thinking.ts:398`): if-chain model id untuk adaptive vs budget.
- `dialect` (DeepSeek/Qwen) mulai dibangun — tapi **belum ada koneksi** antara dialect policy dan ladder/clamp.

### 1.5 Catalog: `reasoningEfforts` sudah ada tapi belum lengkap

- `ModelDefinition.reasoningEfforts?` (`provider-model-definition.ts:56,176`) → disimpan di `models`?
  (cek: seeder belum memakai; `inferhub.ts:434` & `grok.ts:121` mengirim, tapi resolver hanya pakai bila `declaredEfforts` dikirim — **tidak** dibaca dari kandidat route).
- Tidak ada `mode` transport (effort vs budget vs adaptive) di catalog — diturunkan via `claudeUsesAdaptiveThinking` + wire family.

---

## 2. Masalah yang diminta diatasi

1. **Ladder hardcoded per model-id** (`resolveSupportedReasoningEfforts`) — berantakan, sulit diperluas, mudah drift dengan upstream.
2. **Clamp dihitung ulang per request**, padahal deterministik per model → buang CPU tiap turn; dan rentan tidak konsisten antar codec.
3. **Dual mapping budget↔level global** (`LEVEL_TO_BUDGET`/`BUDGET_LEVEL_CEILINGS`) tidak selaras untuk semua provider (contoh: Gemini punya budget threshold sendiri, Anthropic floor 1024).
4. **Workaround tersebar** (deepseek forced high, output floor, adaptive if-chain) tidak punya tempat intrinsik.
5. **Belum terhubung ke dialect layer** yang baru dibangun (DeepSeek/Qwen ladder tidak di-carried lewat dialect policy).

---

## 3. Desain yang diusulkan

### 3.1 `ThinkingConfig` per model (data-driven, baked)

Tambahkan konsep `ThinkingConfig` (dipinjam dari OMP, disesuaikan):

```ts
// src/protocol/translation/dialect/types.ts (perluas)
export type ThinkingControlMode =
  | "effort"               // OpenAI reasoning_effort / reasoning.effort
  | "budget"               // Anthropic budget_tokens / Gemini budgetTokens
  | "google-level"         // Gemini thinking.level
  | "anthropic-adaptive"   // Claude thinking.type:"adaptive" + output_config.effort
  | "anthropic-budget-effort"; // Claude budget + effort (Opus 4.5+)

export interface ThinkingConfig {
  readonly mode: ThinkingControlMode;
  readonly efforts: readonly ReasoningEffortLevel[]; // subset ladder, tak pernah kosong
  readonly defaultLevel?: ReasoningEffortLevel;
  /** peta effort → nilai wire vendor (mis. minimal → "instant" di Inception). */
  readonly effortMap?: Readonly<Partial<Record<ReasoningEffortLevel, string>>>;
  readonly effortBudgets?: Readonly<Partial<Record<ReasoningEffortLevel, number>>>;
  readonly requiresEffort?: boolean; // upstream menolak off/omitted → clamp ke floor
  readonly suppressWhenOff?: boolean; // off harus dieksplisitkan di wire
  readonly supportsDisplay?: boolean;
}
```

- Disimpan di **`ModelDefinition.thinking?`** (optional; absen = non-reasoning / default).
- `dialect` policy terhubung: `DialectPolicy.thinkingFormat` (sudah ada) **menjadi sumber default** `mode`/`efforts` saat model tidak mendeklarasikan sendiri.

### 3.2 Resolver ladder — ganti if-chain dengan tabel data-driven

```ts
// src/protocol/translation/dialect/thinking-ladder.ts (baru)
export interface ThinkingLadderRule {
  readonly id?: RegExp | ((id: string) => boolean);
  readonly wireFamily?: WireFamily;
  readonly provider?: string;
  readonly efforts: readonly ReasoningEffortLevel[];
  readonly mode?: ThinkingControlMode;
  readonly defaultLevel?: ReasoningEffortLevel;
  readonly effortMap?: ThinkingConfig["effortMap"];
  readonly effortBudgets?: ThinkingConfig["effortBudgets"];
  readonly requiresEffort?: boolean;
}
export const THINKING_LADDER_RULES: readonly ThinkingLadderRule[] = [ /* dari if-chain hari ini → literal tabel */ ];

export function resolveThinkingForModel(
  modelId: string,
  providerId: string,
  wireFamily: WireFamily,
  declared?: ModelDefinition["thinking"],
): ThinkingConfig | undefined;
```

- Prioritas: **declared (catalog/dialect) → rule table → default family** (sama pola `resolveDialect`).
- Rule table diisi dari seluruh if-chain `resolveSupportedReasoningEfforts` hari ini + `claudeUsesAdaptiveThinking` (jadi `thinkingMode` ikut terbawa).

### 3.3 Satu clamp canonical

```ts
// model-thinking.ts (baru, mirip OMP)
export function clampThinkingLevelForModel(
  thinking: ThinkingConfig | undefined,
  requested: ReasoningEffortLevel | undefined,
): ReasoningEffortLevel | undefined {
  if (thinking === undefined || requested === undefined) return requested;
  if (thinking.efforts.includes(requested)) return requested;
  const i = REASONING_EFFORT_LADDER.indexOf(requested);
  if (i === -1) return undefined;
  let clamped: ReasoningEffortLevel | undefined;
  for (const e of thinking.efforts) {
    if (REASONING_EFFORT_LADDER.indexOf(e) > i) break;
    clamped = e;
  }
  return clamped ?? thinking.efforts[0];
}
```

- Menggantikan `clampReasoningEffort` di semua codec. Sesuai aturan cutover repo
  (tanpa alias/forwarding shim), `clampReasoningEffort` dan
  `resolveSupportedReasoningEfforts` **dihapus langsung** dan semua caller
  dimigrasi dalam satu change.
- `requiresEffort === true` & requested off/omitted → clamp **naik** ke `defaultLevel ?? efforts[0]` (mirip OMP `normalizeMandatoryReasoningOptions`).

### 3.4 Budget = milik model, bukan global

- `effortBudgets` default per model (dari rule table): Anthropic floor 1024, Gemini threshold sendiri, dll.
- `LEVEL_TO_BUDGET`/`BUDGET_LEVEL_CEILINGS` menjadi fallback global bila model tak deklarasikan; `budgetToLevel` tetap, tapi membaca `effortBudgets` dulu.
- `reasoningEffortFromIntent`: gunakan `thinking.effortBudgets`; default "high" hanya bila tak ada budget.

### 3.5 Rapikan workaround

- `applyDeepSeekReasoning`: default effort diambil dari `ThinkingConfig.defaultLevel` (alias `efforts[0]`? urutan ascending → default = teratas/terendah sesuai `requiresEffort`), bukan hardcode `"high"`.
- `geminiThinkingOutputFloor` & `clampedEffortOutputFloor`: jadikan method di `ThinkingConfig` (optional `outputFloorFor(requested, applied)`), sumber nilai dari `effortBudgets`/rule table; hapus `BUDDY_LEVEL_RANK` global.
- `claudeUsesAdaptiveThinking`: hapus; diganti `thinking.mode` (rule table).

### 3.6 Integrasi dialect layer

- `DialectPolicy.thinkingFormat` (sudah ada) → di-associate ke `ThinkingConfig.mode` (mis. `"qwen"` → `effort` + `effortMap` Qwen `enable_thinking`; `"deepseek"` → `effort` + `effortBudgets` DeepSeek).
- `resolveDialect` & `resolveThinkingForModel` dipanggil di **satu tempat**: `OpenAICompatibleAdapter.preparePayload` (seperti dialect) → diteruskan ke codec via `CodecContext.thinking` (baru). `messages.ts`/`chat.ts`/`responses.ts` membaca `thinking` dari context, bukan memanggil `resolveSupportedReasoningEfforts` lagi.

---

## 4. File yang tersentuh

| Area | File |
| --- | --- |
| Tipe baru | `src/protocol/translation/dialect/types.ts` (`ThinkingConfig`, `ThinkingControlMode`) |
| Resolver ladder | `src/protocol/translation/dialect/thinking-ladder.ts` (baru), `rules.ts` (rule table) |
| Clamp canonical | `src/protocol/translation/dialect/model-thinking.ts` (baru) |
| Thinking lama | `src/protocol/translation/thinking.ts` (`resolveSupportedReasoningEfforts` & `clampReasoningEffort` dihapus, caller dimigrasi; `claudeUsesAdaptiveThinking` dihapus; `LEVEL_TO_BUDGET` jadi fallback) |
| Reasoning helper | `src/protocol/reasoning.ts` (`applyDeepSeekReasoning`, `geminiThinkingOutputFloor`, `clampedEffortOutputFloor` dirapikan; `reasoningEffortFromIntent` pakai effortBudgets) |
| Codec | `src/protocol/request/chat.ts`, `messages.ts`, `responses.ts`, `gemini.ts` — baca `CodecContext.thinking`, clamp sekali |
| Registry | `src/protocol/registry.ts` — tambah `CodecContext.thinking` |
| Adapter | `src/providers/adapters/compatible-adapter.ts` — resolve + inject `thinking` |
| Catalog | `src/providers/provider-model-definition.ts` (`thinking?` field); seeder/discovery menulisnya bila ada |
| Dialect | `src/protocol/translation/dialect/deepseek.ts`, `qwen.ts` — bawa ladder default |
| Tes | `test/protocol/translation/thinking-ladder.test.ts`, `model-thinking.test.ts`, golden payload chat/messages/responses (byte-identik untuk default) |

---

## 5. Migrasi & risk

- **Tanpa migration DB.** `reasoningEfforts` sudah ada di catalog; `thinking` murni runtime/tabel — tidak perlu kolom baru. Opsional: simpan `thought` sebagai JSON di `models` nanti (di luar scope fase 1).
- **Default off / backward compatible:** rule table diisi dari perilaku hari ini → `resolveThinkingForModel` menghasilkan ladder identik dengan `resolveSupportedReasoningEfforts`. Golden test memastikan payload byte-identik untuk semua wire tanpa perubahan.
- **Guard tiap jalur baru:**
  - `resolveThinkingForModel` pure, selalu return (fallback family), never throw.
  - `clampThinkingLevelForModel` tidak mengubah hasil untuk requested yang sudah didukung (identik).
  - `requiresEffort` hanya aktif bila rule menyatakannya (tidak di-invent).
  - `effortBudgets` memprioritaskan deklarasi model > table > global fallback.
- **Risk & mitigation:**
  - *Regresi wire bytes* → golden payload P0 (chat/messages/responses: tool+reasoning+system) di-assert identik.
  - *Clamp double* → hapus `clampReasoningEffort` di codec, ganti satu panggilan `clampThinkingLevelForModel`.
  - *Budget mismatch* → unit test `budgetToLevel` vs `effortBudgets` per family (Anthropic/Gemini/DeepSeek).
  - *Perubahan default deepseek* → [ hanya bila `defaultLevel` dideklarasikan di rule; default eksplisit (high) dipertahankan di tabel agar tidak mengubah behavior.

---

## 6. Keputusan final (dfinalkan 2026-11-02)

1. **Lokasi `ThinkingConfig`: rule table + `ModelDefinition.thinking?` opsional.**
   `reasoningEfforts` yang sudah ada tetap menjadi sumber "declared"; `thinking`
   disimpan sebagai field opsional di `ModelDefinition` (compile-time), bukan
   kolom DB. Tidak ada migration di fase 1. Operator override per-row (dashboard)
   menyusul hanya bila diminta.
2. **API lama: hapus langsung, tanpa wrapper.** Sesuai aturan repo (cutover tanpa
   alias/forwarding shim): `clampReasoningEffort` & `resolveSupportedReasoningEfforts`
   dihapus, semua caller dimigrasi ke `clampThinkingLevelForModel` /
   `resolveThinkingForModel` dalam satu change.
3. **Scope: sekali jalan** — `chat` + `responses` + `messages` + `gemini` sekaligus,
   karena inti berubah di satu tempat (rule table + clamp + `CodecContext.thinking`);
   golden payload melindungi regresi.
4. **Output floor: helper murni** `outputFloorFor(thinking, requested, applied, modelOutputLimit)`
   di `model-thinking.ts`, disusun dari `effortBudgets`/rule table (bukan
   `BUDDY_LEVEL_RANK` global). `ThinkingConfig` tetap data type, bukan class.
5. **`thinkingFormat` vs `mode`: pertahankan keduanya, satu arah.** `thinkingFormat`
   (dialek wire) milik `DialectPolicy`; `mode` (transport) milik `ThinkingConfig`.
   Dua resolver berbeda (`resolveDialect`, `resolveThinkingForModel`) membaca sumber
   rule yang sama, tanpa duplikasi; mapping diikat di tabel rule.
6. **Telemetry: fase 1 tanpa kolom baru.** Saat clamp mengubah effort → log
   `warn` + payload capture. Fase 2 opsional: kolom nullable
   `requested_effort`/`applied_effort` hanya bila operasional meminta.

---

## 7. Ringkasan implementasi (2026-11-02)

Dieksekusi end-to-end sesuai keputusan final (commit `cc799f69`):

- **Baru:** `src/protocol/translation/dialect/thinking-ladder.ts`
  (`ThinkingConfig`, `ThinkingControlMode`, `THINKING_LADDER_RULES`,
  `resolveThinkingForModel`, `DEEPSEEK_DEFAULT_EFFORT`).
  `src/protocol/translation/dialect/model-thinking.ts`
  (`clampThinkingLevelForModel`, `outputFloorFor`).
- **Dihapus:** `resolveSupportedReasoningEfforts`, `clampReasoningEffort`,
  `claudeUsesAdaptiveThinking`, konstanta ladder lama di `thinking.ts` —
  tanpa wrapper (cutover repo). `clampedEffortOutputFloor`/`BUDDY_LEVEL_RANK`
  di `reasoning.ts` diganti re-export `outputFloorFor` dari `model-thinking.ts`.
- **Integrasi:** `CodecContext.thinking` + `encodeWireRequest` meneruskan ke
  ketiga codec; `OpenAICompatibleAdapter.preparePayload` resolve sekali via
  `resolveThinkingForModel`; `chat.ts`/`responses.ts`/`messages.ts` baca
  `thinking` (fallback resolver saat dipanggil langsung tanpa context);
  `messages.ts` pakai `thinking.mode` (anthropic-adaptive) menggantikan
  `claudeUsesAdaptiveThinking`; `applyDeepSeekReasoning` default
  `DEEPSEEK_DEFAULT_EFFORT`.
- **Catalog:** `ModelDefinition.thinking?` + `ModelHelperRow.thinking?`
  compile-time opsional, diteruskan `defineModel` — tanpa migration DB.
- **Test:** `test/protocol/translation/thinking-ladder.test.ts`
  (17 test: ladder, clamp, golden payload); `mercury-effort-clamp.test.ts`
  dimigrasi ke API baru.
- **Verifikasi:** typecheck backend+dashboard bersih; backend 4217 pass / 0
  fail; protocol suite 591 pass / 0 fail.
- **Deferred (sesuai keputusan):** telemetry kolom baru (fase 2), operator
  override per-row (dashboard).
