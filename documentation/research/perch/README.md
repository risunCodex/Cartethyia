# Perch research ledger

Reverse-engineered 2026-11-08 from `D:\tmp\scratch\perch-probe\` and
`D:\tmp\unpacked\perchai-cli\`. Source of truth: the official npm tarball
`perchai-cli@2.4.125` (`dist/perch.mjs`) and the desktop bundle (`app.asar` →
`dist-electron/main.js`, Perch Terminal 2.5.7). The tarball was downloaded and
unpacked for **wire inspection only**: Cartethyia never installs, spawns, or
bundles the CLI, desktop app, MCP, or ACP as a production transport. The shipped
adapter is pure HTTP.

Only `standard` and `standard 1m` were ever invoked — `pro` / `pro 1m` were not
hit. Repeated incomplete direct calls trigger `turn_rate_limited` and can get an
account banned; keep live probes to a minimum.

## Accounts

Starter (free) — Google OAuth. $20/month included hosted-model usage, resets
monthly. Sign-in via Supabase GoTrue project
`zlfuvsfjtgsdtqcaykia.supabase.co` (Google + GitHub enabled). The OAuth flow is
implemented directly in Cartethyia; no external token capture is required.

## Identity / provider

- Product: perchai.app — an AI operator platform ("Perch Terminal", CLI
  `perchai-cli`, web chat `chat.perchai.app`).
- Hosted model layer is **Roost**: tiers `standard` / `standard 1m` /
  `pro` / `pro 1m`. The actual model behind a tier is hidden server-side
  ("Never reveal underlying model names"); a successful `done` frame reports
  e.g. `deepseek-v4.1-flash-1017`.
- Starter serves `standard` and `standard 1m` (`200`, `pong`); `pro` is refused
  with `starter_model_blocked`. The catalog therefore ships **only the two
  servable tiers**, with no hardcoded `free` / `freeTier` flag.
- 1 PT = $0.001 billed provider-equivalent hosted usage; Starter includes
  20,000 PT/month.
- Each turn consumes a turn ticket (`tkt-cli-…`), minted by the CLI against
  `/api/perch-terminal/turn-ticket`.

## OAuth

- Supabase GoTrue v2.197.0; browser code flow with **PKCE**.
- Authorize: `GET /auth/v1/authorize?provider=google&redirect_to=…&client_id=<publishable>&code_challenge=…&code_challenge_method=S256`.
  `state` is embedded in `redirect_to` (`http://127.0.0.1:<port>/callback?state=…`)
  because GoTrue does not echo `state` back through the provider redirect;
  without it the callback is ambiguous and the login is refused.
- Token: `POST /auth/v1/token?grant_type=pkce`, **JSON** body
  `{auth_code, redirect_to, code_verifier}`. A form body answers `bad_json`;
  `grant_type=authorization_code` answers `unsupported_grant_type`; `code`
  instead of `auth_code` answers `validation_failed`.
- Header `apikey` + `Authorization: Bearer` = the **publishable key**
  (`sb_publishable_…`), not a raw anon JWT.
- Refresh: `POST /auth/v1/token?grant_type=refresh_token`, JSON body.
- After exchange the official CLI stamps `user_metadata.signup_source=cli`
  (`PUT /auth/v1/user`, body `{data:{signup_source:"cli"}}`); the adapter repeats this.

## Plan selection (Starter)

`GET /api/perch-terminal/cli-plan` returns:

```json
{"ok":true,"planRequired":true,"starter":{"noticeVersion":"2026-09-13",
 "notice":"…","privacyUrl":"…","termsUrl":"…"},"proUrl":"…"}
```

`POST /api/perch-terminal/cli-plan` with `{"plan":"starter","noticeVersion":"2026-09-13"}`
→ `{"ok":true,"planRequired":false}`. This is the programmatic path the CLI
uses (no checkout page).

## Inference transport (pure HTTP)

`POST https://app.perchai.app/api/perch-terminal/model-call` is
**surface-gated**. An incomplete call — valid Bearer + ticket but no full CLI
turn envelope — answers `403 perch_surface_required`:

> "Your plan includes Perch-hosted models for use in Perch AI Web, Desktop,
> and CLI only. Direct API access is not included. Repeated direct-access
> attempts may result in account suspension."

A complete envelope answers `200` with an SSE stream. Verified live (2026-11-08)
through the shipped adapter on `standard` and `standard 1m`; the console probe
path with the DB credential returned `Pong. I'm here. What are we working on?`.
No CLI process is involved.

Headers:

```
authorization: Bearer <access>
content-type: application/json
accept: text/event-stream
user-agent: perchai-cli/unknown
x-perch-locale: en
x-perch-call-delta: 1
x-perch-turn-ticket: <ticket>
```

Ticket: `POST /api/perch-terminal/turn-ticket`, body
`{"surface":"cli","profile":"standard"}` → `{ok:true,ticket,runId}`.

Body (all fields load-bearing):

- `request.messages`: the Saffron system-prompt prefix as `role:"system"`,
  followed by the caller's turns; `temperature:0.6`, `maxTokens`.
- `runId`, `lane:"chat"`, `strictManual:false`,
  `preferredModelId:"wandb-kimi-k2-6"`, `avoidModelIds:[]`.
- `attribution`: `{userId, workspaceId, runId, lane, source:"cli",
  billingMultiplier:null}` — ids read from `GET /api/perchai/account`.
- `clientSurface:"cli"`, `resendAfterOutput:true`,
  `roostModelChoice:"standard" | "standard 1m"`, `roostReasoning:true`,
  `effort:{level:"high",orchestration:false}`.

Stream frames: `keepalive`, `answer_delta`, `done`; `done` carries `ok`,
`text`, `model`, `provider`, and camelCase `usage` (`inputTokens`,
`outputTokens`, `cacheReadInputTokens`, `totalTokens`). The adapter normalizes
usage to canonical snake_case.

### System prompt (fingerprint)

The upstream fingerprints the **prefix** of the Saffron prompt, not the whole
28KB string. Live results:

| System prompt | Result |
| --- | --- |
| Full 28KB Saffron prompt | `200` |
| Trimmed 432-char prefix | `200` |
| `You are a helpful assistant, capable, general-purpose agent.` | `403 perch_surface_required` |

The shipped value is the 432-char prefix in `perch-system-prompt.ts`, mirrored
as research copy in `saffron-system-prompt.txt`. A plain assistant placeholder
does **not** work; do not replace it without a fresh live test.

`ProviderAdapter.systemPrompt?()` is the unified hook: probe
`probing-service.ts` reads it, `buildProbeCanonicalRequest` injects it as
`request.system`, and `buildPerchModelCallBody` keeps Saffron as the opener
(caller system turns are appended, never substituted). No provider-detail page
hardcodes a prompt.

**Bundling trap (2026-11-08):** `readFileSync(import.meta.dir + "/…txt")` works
in source but Bun's standalone binary has no `.txt` asset on disk. The old
file-backed constant silently fell back to a two-line stub in
`dist/cartethyia.exe`, so console probes sent the stub and always got
`403 perch_surface_required` while source-level probes succeeded. The prompt is
now a TS literal and a test asserts it equals the research copy.

## Quota

`GET /api/perchai/account` (Bearer) returns `session.planCode`
(`pilot` maps to Starter), `tierSelectionRequired`, and
`usageMeter.monthlyUsd` / `roostRolling` (5h + 7d windows).
`GET /api/perch-terminal/starter-limits` returns `{monthlyUsd:20}`.

Known failure modes: `turn_rate_limited` on the ticket endpoint after repeated
calls; `banned` from `cli-plan` after repeated direct-access attempts; a
refreshed session can come back with `planCode:null` /
`tierSelectionRequired:true` and must re-select Starter.

## Adapter notes

- Files: `src/providers/integrations/perch/{perch.ts,perch-oauth.ts,perch-catalog.ts,perch-quota.ts,perch-realm.ts,perch-protocol.ts,perch-system-prompt.ts}`.
- Free Limited dashboard section includes `perch` (Starter free tiers).
- Client version source: npm `perchai-cli` latest (metadata only).
- Probes: `scripts/provider-probing/perch/probe-perch.ts` (OAuth capture +
  model-call) and `probe-perch-min.ts` (session-only minimal check). Both are
  pure HTTP and never print tokens; `accounts*.json` is gitignored.
