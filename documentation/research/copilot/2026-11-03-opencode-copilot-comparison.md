# OpenCode vs Cartethyia — GitHub Copilot / Luna (Auto) wire

Date: 2026-11-03
Reference: `anomalyco/opencode` (branch `dev`, sparse-clone
`packages/core/src/github-copilot` + `plugin/provider/github-copilot.ts`).
Live account: `jinhsera-design` (`free_limited_copilot`, plan `individual`).

---

## 1. How OpenCode calls Copilot

OpenCode **has no `/auto`** and **does not mint a Copilot token**:

- Auth: `Authorization: Bearer <raw GitHub OAuth token>` (refresh token) directly —
  no `/copilot_internal/v2/token` exchange.
- The model is chosen from the catalog (models.dev / `/models`), then POSTed straight to the endpoint.
- Endpoints: `/responses` for gpt-5+ / grok / mai-code; `/chat/completions` for
  the rest; `/v1/messages` for Claude.
- Minimal headers: `User-Agent` (opencode), `Openai-Intent`, `X-GitHub-Api-Version`,
  `X-Interaction-Type`, `X-Interaction-Id`, `x-initiator`. **No**
  `VScode-*`, no `Editor-*`, no `Copilot-Integration-Id`, no
  `x-vscode-user-agent-library-version`.
- Entitlement is checked during OAuth: `copilotEntitlementError(user)` on
  `/copilot_internal/user` (`chat_enabled:false` → login rejected).
- Dual `apiVersion`: `2026-08-01` for `/models` + `/auto`-like, `2025-04-01`
  for `/copilot_internal/user`.

Consequence: **OpenCode cannot use Auto models such as `gpt-6-luna`**
— it hits `/responses` directly with the model id, and a free account gets
400 `model_not_supported` (luna needs `/auto` for selection + a session token).

## 2. Comparison

| Aspect | OpenCode | Cartethyia adapter |
| --- | --- | --- |
| Auth to inference | raw GitHub OAuth token | Copilot token minted (`/copilot_internal/v2/token`) |
| `/auto` (Auto model) | ❌ none | ✅ `#selectAutoModel` → POST /auto |
| Luna selection | fails (400 model_not_supported) | ✅ /auto selects `gpt-6-luna` |
| Luna stream | — | `POST /responses` + `Copilot-Session-Token` |
| Identity headers | minimal (no VScode/Editor/Integration-Id) | full reference (VScode-*, Editor-*, node-http) |
| Entitlement check | during OAuth (`/copilot_internal/user`) | discovery `/models` (restricted_to) |

## 3. The proven Auto flow (live, 200)

```text
1. POST /auto
   body:  { prompt, tier: "efficiency" }
   headers: Authorization: Bearer <githubToken>
            X-GitHub-Api-Version: 2026-08-01
            (minimal opencode-style / reference headers)
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

- `/chat/completions` with `gpt-6-luna` → `400 unsupported_api_for_model`
  (luna is `/responses` only).
- The streamed model id must be **exactly** `selected_model.id` from `/auto`
  (not a plain alias); `gpt-5.6-luna-free-auto` → `400 "Requested model not
  available for session"`.

## 4. Additional findings

- `/auto` **rejects** the reference headers (VScode-*, Editor-*, Integration-Id,
  node-http) with `400 "invalid apiVersion"` when the bearer is the **raw GitHub token**.
  With a **fresh Copilot token** + reference headers, `/auto` stays `200`.
  (Not yet fully isolated which header triggers the 400 — needs further
  probing if reference headers are to be used on `/auto`.)
- `/auto` with an **expired/stored Copilot token** + minimal headers →
  `403 "token not authorized for this integration"` — a minted token is alive
  for ~25 minutes, so it must be re-minted from the GitHub token.

## 5. Implications for the adapter

- Our auto logic (`/auto` → `gpt-6-luna` → `/responses`) **matches** and is
  proven to work, including for free accounts.
- To imitate OpenCode fully: you could use the raw GitHub token directly on
  `/auto` (without minting a Copilot token) + minimal headers. But the
  reference (VS Code) uses a minted token + full headers, and that is also 200
  — so both are valid as long as the token is fresh.
- What matters for "not licensed": not the headers, not the flow — but
  **account entitlement** (restricted_to vs SKU) and a **fresh token**.
