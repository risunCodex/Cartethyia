# OpenCode vs Cartethyia — GitHub Copilot / Luna (Auto) wire

Tanggal: 2026-11-03
Referensi: `anomalyco/opencode` (branch `dev`, sparse-clone
`packages/core/src/github-copilot` + `plugin/provider/github-copilot.ts`).
Akun live: `jinhsera-design` (`free_limited_copilot`, plan `individual`).

---

## 1. Bagaimana OpenCode memanggil Copilot

OpenCode **tidak punya `/auto`** dan **tidak mint token Copilot**:

- Auth: `Authorization: Bearer <raw GitHub OAuth token>` (refresh token) langsung —
  tidak ada pertukaran `/copilot_internal/v2/token`.
- Model dipilih dari catalog (models.dev / `/models`), lalu langsung POST ke endpoint.
- Endpoint: `/responses` untuk gpt-5+ / grok / mai-code; `/chat/completions` untuk
  sisanya; `/v1/messages` untuk Claude.
- Header minimal: `User-Agent` opencode, `Openai-Intent`, `X-GitHub-Api-Version`,
  `X-Interaction-Type`, `X-Interaction-Id`, `x-initiator`. **Tidak ada**
  `VScode-*`, tidak ada `Editor-*`, tidak ada `Copilot-Integration-Id`, tidak ada
  `x-vscode-user-agent-library-version`.
- Entitlement dicek saat OAuth: `copilotEntitlementError(user)` di
  `/copilot_internal/user` (`chat_enabled:false` → tolak login).
- `apiVersion` ganda: `2026-08-01` untuk `/models` + `/auto`-like, `2025-04-01`
  untuk `/copilot_internal/user`.

Konsekuensi: **OpenCode tidak bisa memakai model Auto seperti `gpt-6-luna`**
— dia langsung hit `/responses` dengan id model, dan akun free mendapat
400 `model_not_supported` (luna butuh `/auto` untuk memilih + session token).

## 2. Perbandingan

| Aspek | OpenCode | Cartethyia adapter |
| --- | --- | --- |
| Auth ke inference | raw GitHub OAuth token | Copilot token minted (`/copilot_internal/v2/token`) |
| `/auto` (Auto model) | ❌ tidak ada | ✅ `#selectAutoModel` → POST /auto |
| Pemilihan Luna | gagal (400 model_not_supported) | ✅ /auto pilih `gpt-6-luna` |
| Stream Luna | — | `POST /responses` + `Copilot-Session-Token` |
| Header identity | minimal (tanpa VScode/Editor/Integration-Id) | reference penuh (VScode-*, Editor-*, node-http) |
| Entitlement check | saat OAuth (`/copilot_internal/user`) | discovery `/models` (restricted_to) |

## 3. Alur Auto yang terbukti (live, 200)

```text
1. POST /auto
   body:  { prompt, tier: "efficiency" }
   headers: Authorization: Bearer <githubToken>
            X-GitHub-Api-Version: 2026-08-01
            (headers minimal ala opencode / reference)
   -> 200
      { session_token, selected_model: { id: "gpt-6-luna", ... },
        expires_at, multi_turn, selection_reason }

2. POST /responses
   body:  { model: "gpt-6-luna",
             input: [{ role:"user", content:[{type:"input_text",text}] }],
             stream: true }
   headers: Authorization: Bearer <githubToken>
            Copilot-Session-Token: <session_token>
            X-GitHub-Api-Version: 2026-08-01
   -> 200, SSE streaming (response.created, ...)
```

- `/chat/completions` dengan `gpt-6-luna` → `400 unsupported_api_for_model`
  (luna hanya `/responses`).
- Model id stream harus **persis** `selected_model.id` dari `/auto`
  (bukan alias polos); `gpt-5.6-luna-free-auto` → `400 "Requested model not
  available for session"`.

## 4. Temuan tambahan

- `/auto` **menolak** header reference (VScode-*, Editor-*, Integration-Id,
  node-http) dengan `400 "invalid apiVersion"` saat bearer = **raw GitHub token**.
  Dengan **Copilot token segar** + header reference, `/auto` tetap `200`.
  (Belum sepenuhnya diisolasi mana header yang memicu 400 — perlu probe lebih
  lanjut jika ingin memakai reference headers di `/auto`.)
- `/auto` dengan **expired/stored Copilot token** + headers minimal →
  `403 "token not authorized for this integration"` — token minted waves hidup
  ±25 menit, jadi harus re-mint dari GitHub token.

## 5. Implikasi untuk adapter

- Logic auto kita (`/auto` → `gpt-6-luna` → `/responses`) **sesuai** dan
  terbukti bekerja, termasuk untuk akun free.
- Jika mau meniru OpenCode sepenuhnya: bisa pakai raw GitHub token langsung di
  `/auto` (tanpa mint Copilot token) + headers minimal. Tapi reference
  (VS Code) memakai token minted + headers lengkap, dan itu juga 200 — jadi
  dua-duanya valid selama token segar.
- Yang penting untuk "not licensed": bukan header, bukan alur — tapi
  **entitlement akun** (restricted_to vs SKU) dan **token segar**.
