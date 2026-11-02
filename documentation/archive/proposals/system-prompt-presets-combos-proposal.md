# Proposal — Inject System Prompt: presets, per-combo/alias, clear button

**Status:** ✅ diimplementasikan (`c4e1ef9e` … `53e62251`).
**Tanggal:** 2026-11-01
**Scope:** dashboard (InjectSystemPromptPanel) + console API + dispatch injection (system-prompt-injection.ts) + schema/persistensi.

---

## 1. Kondisi saat ini (dari kode)

Alur sekarang: `InjectSystemPromptPanel.tsx` (dashboard) → `PUT /system-prompt`
(console routes) → `writeTenantSystemPrompts` (store) → saat request,
`readTenantSystemPromptsForDispatch` → `applyInjectSystemPrompt`
(`src/transport/request/system-prompt-injection.ts`).

Struktur data yang disimpan (per tenant, satu row di `tenant_system_prompts`):

```ts
interface TenantSystemPrompts {
  global: PromptSetting | null;          // null = belum pernah disetel
  providers: Record<string, ProviderPromptEntry>; // providerId -> { followGlobal, setting? }
  models: Record<string, PromptSetting>; // "providerId::modelId" -> setting
}

interface PromptSetting { enabled: boolean; mode: "append" | "override"; text: string }
interface ProviderPromptEntry { followGlobal: boolean; setting?: PromptSetting }
```

- **Global:** satu prompt. Switch on/off; `null` = off. **Tidak ada tombol clear
  terpisah** — untuk menghapus harus matikan switch (yang menghasilkan `null`),
  tapi teks tidak "hilang" dari sudut pandang pengguna karena `null` dihasilkan
  dari `enabledSetting()` yang membuang teks. UI saat ini tidak punya cara
  eksplisit "hapus semua" / "clear".
- **Per provider:** tiap provider punya toggle `followGlobal` (default ikut
  global) atau custom setting. **Satu** setting per provider.
- **Per model:** `models["providerId::modelId"]` → satu setting per model.
- **Resolver (backend):** `resolveTenantSystemPrompt()` = *most-specific-wins*:
  model → provider → global. Provider dengan `followGlobal: true` pakai global.
- **Belum ada konsep "preset" sama sekali** — yang ada cuma "global" (satu),
  dan per-provider/per-model (hardcoded, bukan referensi ke preset).
- **Belum ada hook untuk combos/alias:** request yang masuk lewat alias/combo
  hanya kelihatan sebagai `providerId + modelId` hasil resolve (dari
  `candidate.provider_id` + `candidate.model_id`). Nama alias/combo asli tidak
  dibawa sampai ke resolver injection.

**Masalah yang diminta diatasi:**
1. Saat toggle **disable**, setting tidak hilang (cuma mati) — maunya ada
   **tombol clear** yang menghapus teks/setting secara eksplisit.
2. Combos/alias **tidak bisa** dapat inject sendiri — maunya per-combo/per-alias
   bisa disetel (ikut global, atau preset sendiri).
3. Hanya ada **satu** global — maunya ada **presets** (banyak), dan tiap
   provider/model/combo/alias bisa **ikut preset** mana pun (multi, bukan cuma
   satu).

---

## 2. Desain yang diusulkan

### 2.1 Konsep "Preset" (baru)

Tambahkan koleksi preset bernama. Nama unik per tenant. Tiap preset adalah
`PromptSetting` (enabled, mode, text) + label.

```ts
interface SystemPromptPreset {
  id: string;            // uuid
  name: string;          // unik per tenant, mis. "Tone: formal", "Rules"
  enabled: boolean;      // apakah preset ini "aktif" utk scope yang merujuknya
  mode: "append" | "override";
  text: string;
}
```

Penempelan pas request: sebuah scope (provider/model/combo/alias) mereferensikan
preset lewat `presetId`, atau membawa setting inline sendiri (`custom`), atau
ikut global. Jadi tiap scope punya **tiga mode**:

```ts
type ScopePromptRef =
  | { kind: "global" }                    // ikut global (default)
  | { kind: "preset"; presetId: string }  // ikut satu preset
  | { kind: "custom"; setting: PromptSetting }; // setting sendiri
```

- Multi-preset tercapai karena ada **banyak preset**, dan tiap scope bisa pilih
  **salah satu** (atau global, atau custom) — bukan cuma satu global.
- Backward-compatible: `global` lama menjadi preset internal khusus, atau
  tetap field `global` (lihat §2.4).

### 2.2 Per-combo / per-alias (baru)

Karena request cuma membawa `providerId + modelId` setelah resolve, kita perlu
membawa **nama asli** yang diminta client ke resolver injection. Ada dua opsi:

**Opsi A (digemari): bawa `requestedName` di canonical request / candidate.**
Routing sudah punya `requestedModel` (baca dari request). Kita tambahkan
`requestedModel` (atau `requestedAliasCombo`) ke `SystemPromptRoute`, lalu
resolver cek: kalau `requestedModel` cocok dengan nama alias/combo yang
terdaftar → cari di map `combos`/`aliases` (key = nama) → kalau ada ref, pakai
itu (preset/custom/global) → fallback ke model → provider → global.

```ts
interface SystemPromptRoute {
  providerId: string;
  modelId: string;          // hasil resolve (kandidat)
  requestedModel?: string;  // nama asli dari client (alias/combo/model)
  serviceKind: ServiceKind;
}
```

Penyimpanan: dua map baru di `TenantSystemPrompts`:

```ts
interface TenantSystemPrompts {
  // … existing
  combos: Record<string, ScopePromptRef>;   // key = nama combo
  aliases: Record<string, ScopePromptRef>;  // key = nama alias
}
```

**Opsi B:** resolve di router sebelum candidate dipilih (lebih invasif; kurang
diperlukan). → Pilih Opsi A: perubahan kecil, dan nama asli memang sudah ada di
`requestedModel`.

### 2.3 UI — InjectSystemPromptDialog

- **Section Presets (baru, di atas Global):**
  - Grid kartu preset: nama, badge aktif/off, mode, pratinjau teks (clamp).
  - Tiap kartu: toggle enabled, tombol **Edit** (modal kecil: nama, mode,
    textarea, import), tombol **Delete** (dengan konfirmasi).
  - Tombol **+ New preset**.
  - Tombol **Clear** per preset (hapus teks → kosongkan, atau delete preset).
- **Global:**
  - Tetap, tapi "Clear" eksplisit: tombol kecil di pojok "Clear" → set global
    ke `null` (hapus teks + matikan). Ini jawaban poin 1: disable ≠ hilang,
    clear = hilang.
- **Per provider / per model / per combo / per alias:**
  - Tiap scope punya **pemilih mode**: `Global | Preset… | Custom`.
  - Kalau "Preset": dropdown daftar preset (yang ada) — bisa pilih mana pun
    (multi, karena banyak preset ada).
  - Kalau "Custom": editor yang sama seperti sekarang (mode + textarea +
    import).
  - Per provider: tambah **tab/section Combo & Alias** (atau di dalam section
    provider: daftar combo + alias yang terdaftar). Tiap baris = satu combo /
    satu alias dengan pemilih mode yang sama.

### 2.4 Skema & API

**Persistensi (tenant_system_prompts):**
- Tambah kolom `presets` (jsonb): `Record<string, SystemPromptPreset>` (atau
  array; pilih record keyed by id).
- Ubah `providers`, `models`, tambah `combos`, `aliases` untuk menyimpan
  `ScopePromptRef` (bukan `ProviderPromptEntry`/`PromptSetting` lagi).
- **Migrasi:** karena ini lite + full, tambah migration baru (nomor berikutnya).
  Untuk data lama: `global` → biarkan (atau jadi preset default "Global");
  `providers` dengan `followGlobal` → `{ kind: "global" }`; yang custom →
  `{ kind: "custom", setting }`; `models` → `{ kind: "custom", setting }`.
- **API:** `PUT /system-prompt` tetap replace wholesale, tapi body baru.
  `DELETE` tetap clear semua. Validasi diperluas (preset name unik, id valid,
  ref valid, cap jumlah preset).

**Resolver (system-prompt-injection.ts):**
Urutan most-specific-wins baru:
1. `requestedModel` cocok alias → ref alias.
2. `requestedModel` cocok combo → ref combo.
3. model (providerId::modelId) → ref model.
4. provider → ref provider.
5. global.
Di tiap ref: `presetId` → ambil text dari preset (yang `enabled`), `custom` →
setting, `global` → global.

### 2.5 Sinkronisasi cache

`readTenantSystemPromptsCached` sudah revision-keyed (bump pada tiap
`writeTenantSystemPrompts` via `currentSettingsRevision()`). Tambahan kolom
tidak mengubah mekanisme — aman.

---

## 3. File yang kena

| File | Perubahan |
| --- | --- |
| `src/console/system-prompt/contracts.ts` | Type baru `SystemPromptPreset`, `ScopePromptRef`; perluas `TenantSystemPrompts` (`presets`, `combos`, `aliases`); update konstanta limit |
| `src/console/system-prompt/routes.ts` | `validateBody` untuk shape baru (preset, ref), cap baru |
| `src/persistence/system-prompt-store.ts` | baca/tulis kolom baru |
| `src/persistence/schema.ts` | + migration (tambah kolom) |
| `migrations/full-postgres/*`, `migrations/lite-sqlite3/*` | migration baru |
| `src/transport/request/system-prompt-injection.ts` | resolver baru (preset/ref/requestedName) |
| `src/transport/request/tenant-preferences.ts` | teruskan `requestedModel` ke route |
| `src/transport/dispatch/proxy-request.ts`, `streaming/stream.ts` | (kalau perlu) teruskan requestedName dari preparer |
| `src/protocol/canonical-model.ts` | (kalau perlu) field requestedName di canonical request |
| `dashboard/src/components/InjectSystemPromptPanel.tsx` | UI preset, clear, pemilih per-scope (provider/model/combo/alias) |
| `dashboard/src/hooks/system-prompt.ts` | type updated |
| `dashboard/src/data/contracts.ts` | re-export type baru |
| `test/…` | test resolver (preset, ref, requestedName), test routes (validasi), test store, test dashboard component |

---

## 4. Keputusan yang perlu dipastikan

1. **Global jadi preset atau tetap field terpisah?** Usulan: tetap field
   `global` (kompatibel), preset lain hidup di `presets`, dan "Global" muncul
   sebagai pilihan di pemilih scope. (Alternatif: jadikan "Global" preset
   built-in — lebih bersih tapi migration lebih besar.)
2. **Nonaktif vs clear:** toggle off = setting tetap ada tapi tidak dipakai.
   Clear = hapus teks (atau delete ref). Setuju?
3. **Hapus preset yang dipakai scope lain?** Usulan: jangan tolak; scope yang
   mereferensikan preset yang terhapus jatuh ke `{ kind: "global" }` saat
   save/read (atau tampilkan warning saat edit).
4. **Combos/alias yang mana yang muncul di UI?** Semua yang terdaftar dari
   `/routing/combos` dan `/routing/aliases` (dengan search).
5. **Limit:** berapa maks preset? (mis. 64) dan maks combo/alias? (mis. 512).

---

## 5. Catatan implementasi

- Jaga backward-compat: response lama yang tanpa `presets`/`combos`/`aliases`
  tetap valid untuk client lama (default kosong).
- `applyInjectSystemPrompt` tetap non-fatal: config rusak → jangan gagalkan
  request.
- Perhatikan `WRAPPED_INJECTION_PROVIDERS` (override tidak dihormati untuk
  provider buddy/cb/cbcn/workbuddy) — tetap berlaku di mode preset/custom.
- Patch kecil: tombol "Clear" di Global bisa langsung dikerjakan tanpa menunggu
  seluruh fitur preset (independent).
