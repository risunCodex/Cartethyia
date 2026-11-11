# DeepAI Code 0.3.35 — Desktop unpack & wire audit

- **Date:** 2026-11-11
- **Artifact:** `D:\tmp\binaries\DeepAI-Code-0.3.35-x64.exe` (483,050,896 B, NSIS)
- **Unpacked:** `D:\tmp\unpacked\deepai\` (Electron shell + `app.asar` + `server.asar`)
- **Evidence (scratch):** `D:\tmp\scratch\deepai\scan\` — `url-scan.txt`, `hosts-all.txt`,
  `hosts-filtered.txt`, `oauth-context.txt`, `deepai-context.txt`, `api-paths-context.txt`,
  `providers-context.txt`, `environment-auth.txt`, `auth-final.txt`, `machineid-context.txt`,
  `maincjs-auth.txt`, `models.txt`, `auth-remainder.txt`

## 1. Installer & layout

- **Type:** Nullsoft Installer (NSIS 3 Unicode), deflate solid, 8 top-level entries.
  Payload is a nested `$PLUGINSDIR/app-64.7z` (482 MB, LZMA2:20 BCJ, 9,681 files).
- **Electron app:** `app/` — `DeepAI Code.exe`, `chrome_*.pak`, `resources.pak`, `ffmpeg.dll`, ….
- **App bundle:** `resources/app.asar` (139 files) → `app/`:
  - `package.json` is intentionally **binary/obfuscated** (677 B, not text JSON).
  - `apps/desktop/dist-electron/`: `main.cjs` (5.3 MB), `preload.cjs`, `boot.cjs`,
    `compileCache.cjs`, `snapShot/*`, `electron/WindowsForegroundFocusWorker.cjs`.
  - `apps/desktop/prod-resources/`: icons, dmg backgrounds, `org.deepai.code.metainfo.xml`.
- **Server bundle:** `resources/server.asar` (15,477 files) → `server/`:
  - `package.json`: `t3code-server` v0.3.35 (pnpm@11.10.0).
    Dependencies: `@cursor/sdk@1.0.35`, `@earendil-works/pi-coding-agent@1.3.0`,
    `@ff-labs/fff-node@0.9.4`, `@napi-rs/keyring`, `node-pty@1.2.0-beta.15`,
    `playwright-core@1.60.0`, `undici@8.11.2`,
    `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.276`, `@ff-labs/fff-bin-win32-x64@0.9.4`.
  - `apps/server/dist/`: `binCli-QUOCZvq0.mjs` (14.3 MB — primary logic),
    `bin.mjs`, `claude-history-worker.mjs`, `Effect-CgXElK3U.mjs`, `AcpMcpStdioBridge*.mjs`,
    plus `client/` (Vite web app: `index.html` + 2,421 assets, `.vite/manifest.json`).
- **Clerk SDK versions (pnpm-lock):** `@clerk/backend@3.18.1`, `@clerk/clerk-js@6.32.1`,
  `@clerk/electron@0.0.44`, `@clerk/electron-passkeys@0.0.3`.

## 2. Domains

| Domain | Usage |
|---|---|
| `https://api.deepai.org` | DeepAI API origin (production) |
| `https://deepai.org` | Consumer site (/pricing, /docs, /dashboard/profile, /privacy-policy, /contact) |
| `https://app.t3.codes` | Hosted app (OAuth `/connect` page, `/welcome`, `/settings`, `/pair`) |
| `https://t3.codes` | Site root + `t3.codes/schema/t3.json` |
| `https://downloads.deepai.org/deepai-code/releases` | Auto-updater feed (`app-update.yml`, generic) |
| `https://cdn.agentclientprotocol.com` | Agent Client Protocol registry CDN (`/registry/v1/latest/<agentId>.svg`, `registry.json`) |
| `https://statsigapi.net`, `https://api.statsigcdn.com` | Statsig feature flags |
| `https://api.openai.com` | OpenAI/Codex passthrough (`/v1/models`, `/v1/responses`) |
| `https://chatgpt.com` | Codex session CO (`/backend-api/wham/rate-limit-reset-credits`) |
| `https://api.anthropic.com` | Claude API (`/api/oauth/usage`) |
| `https://cursor.com` | Cursor usage (`/api/dashboard/get-filtered-usage-events`) |
| `https://auth.openai.com` | ChatGPT OAuth (`/api/accounts/authorize`) |
| `https://accounts.google.com` | Google sign-in (`/o/oauth2/v2/auth`) |

## 3. Auth — DeepAI (desktop sign-in)

Two independent auth systems exist: **DeepAI account** (model usage) and
**T3 Connect** (remote environments, Clerk OAuth).

### 3.1 DeepAI sign-in (device-style, loopback)

1. The app picks a loopback port, builds state, and opens:
   `https://api.deepai.org/deepai_code/desktop_auth/?state=<state>&port=<port>`.
2. After browser sign-in, the server redirects to `http://127.0.0.1:<port>/callback?code=…`
   (loopback server listens; `state`/`port` travel as query params).
3. Code is exchanged: `POST https://api.deepai.org/deepai_code/desktop_auth/exchange/`
   body `{"code": "…"}` (Content-Type application/json, 20 s timeout).
   - 400/401 → "sign-in link expired"; 429 → "too many attempts".
4. Success response: `{ "api_key": string, "username": string, "is_pro": boolean }`.
   - Only `api_key` is kept as credential (no refresh token for DeepAI).
   - Account id = `sha256hex(api_key)`.

### 3.2 DeepAI API wire model

- **Model base:** `https://api.deepai.org/deepai_code`.
- **Origin-level endpoints** (not under `/deepai_code`): `/gravity-display-proxy`,
  `/get_usage_summary`, `/chat_attachments/{upload,get,download}`, `/gravity-imp`.
- **Headers on every request:**
  - `Content-Type: application/json`
  - `X-DeepAI-Code-Theos: 4` (lane version — billing/compat marker)
  - `X-DeepAI-Code-Instance: <hex 16 random bytes>` (per-process instance)
  - `X-DeepAI-Code-Machine: <sha256hex(machineId)>` (omitted if unreadable)
  - `Api-Key: <api_key>` (when account-bound)
  - `/theos` additionally carries `X-DeepAI-Code-Check-In: <nonce>` (32-hex, from last
    check-in) and `X-DeepAI-Code-Beacon: v=<appver>;up=<uptime s>;pi=0|1;focus=0|1`.
  - `/gravity-display-proxy` carries `User-Agent: DeepAI-Code`.
- **Machine ID:**
  - macOS: `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID`.
  - Windows: PowerShell `(Get-CimInstance Win32_ComputerSystemProduct).UUID`, else
    `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`.
    SMBIOS placeholders rejected (`00000000-…`, `ffffffff-…`, `03000200-…`).
  - Linux: `/etc/machine-id` or `/var/lib/dbus/machine-id` (32-hex).
  - Header value is `sha256hex(raw)` — raw identifier never leaves the machine.
  - Server answers metered calls with `machine_required` when header missing.
- **Endpoints (paths under model base):**
  - `GET /deepai_code/models` — model catalog (unauthenticated; list of models with
    `id`, `name`, `reasoning`, `input[]`, `contextWindow`, `maxTokens`, optional
    `premier`, `api` ("openai-responses"), `theosPerRequest`, `theosPerSecond {none|low|medium|high: rate}`).
    `gpt-oss-120b` is filtered out client-side.
  - `POST /deepai_code/chat/completions` — OpenAI-compatible streaming.
  - `POST /deepai_code/responses` — OpenAI Responses compatible.
  - `POST /deepai_code/session_turn` — history sync turn (202/204 = accepted, no body).
    Body: `{ session_id, user_id, message: { id, role, content } }`.
  - `GET /deepai_code/sessions/list` → `{ sessions: [{ uuid, title, updated_at, … }] }`
    (rows filtered to `/^[a-zA-Z0-9_-]{1,100}$/`, exclude `deepai-code-preferences*`).
  - `POST /deepai_code/sessions/save` — history/preferences save.
  - `POST /deepai_code/sessions/delete` — history delete.
  - `GET /deepai_code/theos` — allowance/check-in; returns `{ check_in: { nonce, seconds }, enabled, lane_version, balance, granted, refresh_at }`.
  - `GET /get_usage_summary` — entitlement: `{ is_authenticated, is_pro }`.
  - `POST /chat_attachments/upload` (FormData `file`), `GET /chat_attachments/get?uuid=…`,
    `GET /chat_attachments/download?uuid=…` (validated origin + uuid + sha256).
  - `GET /gravity-display-proxy`, `GET /gravity-imp` — sponsored ads (pro only).
- **Bundled model fallback** (when catalog fetch fails): `glm-5.3-flash`
  ("GLM 5.3 Flash", reasoning, text+image, 1,048,576 ctx, 131,072 max tokens).
- **Model naming:** `deepseek-v4.1-flash` labeled "DeepSeek V4.1 Flash 1017" (catalog tweak).

## 4. Auth — T3 Connect (remote environments, Clerk)

- **Clerk OAuth (CLI/desktop):** scopes `openid profile email offline_access`; PKCE S256;
  state + code_challenge ride **URL fragment** of the hosted connect page so they never
  reach server/CDN logs. Route: `https://app.t3.codes/connect` (not Clerk's authorize
  directly, because signed-out browser redirects lose query params).
- **Clerk endpoints (derived from publishable key):** `{frontendApi}/oauth/authorize`,
  `{frontendApi}/oauth/token`, `{frontendApi}/oauth/device_authorization`.
  Publishable key format: `pk_live_<base64(frontendApi)$>` — frontend API hostname is
  `atob(key.slice(2).join("_"))` minus trailing `$`.
- **Clerk frontend API is build-time injected** — both `main.cjs` and `binCli`
  read `T3CODE_CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` with an empty
  build-time fallback; dev key is injected by the harness at build time (not shipped).
- **Device authorization grant** (headless/SSH, no local browser): POST
  `{frontendApi}/oauth/device_authorization` `{ client_id, scope }` →
  `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`,
  then poll `{frontendApi}/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- **Token exchange (connected CLI):** `POST {frontendApi}/oauth/token` (form-urlencoded):
  `grant_type=authorization_code`, `code`, `redirect_uri` (loopback), `client_id`,
  `code_verifier`, optional `resource`. Response `{ access_token, refresh_token?, id_token?,
  expires_in, token_type }`; persisted client-side as `{ accessToken, refreshToken,
  expiresAtEpochMs, identity? }`, refreshed with `grant_type=refresh_token`.
- **Clerk frontend API hostname** also drives the desktop CSP (`script-src` allowlist).
- **Config env vars:** `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, `T3CODE_HOSTED_APP_URL` (default `https://app.t3.codes`),
  `VITE_CLERK_JWT_TEMPLATE`, `VITE_CLERK_CLI_OAUTH_CLIENT_ID`.

## 5. Relay (remote environment) API

Environment server (SSH/cloud machine) exposes a local HTTP API (`Ehttp` on loopback):

- `GET /.well-known/t3/environment` — execution environment descriptor.
- `GET /api/auth/session` — `AuthSessionState` `{ authenticated, auth, scopes?, permissions, sessionMethod?, expiresAt? }`.
- `POST /api/auth/browser-session` — `{ credential }` → authenticated browser session.
- `POST /oauth/token` — auth token exchange (DPoP-capable). Form:
  `{ grant_type: <bootstrap>, subject_token, subject_token_type, requested_token_type, scope?, client_label?, client_device_type?, client_os? }`
  → `{ access_token, issued_token_type, token_type: "Bearer"|"DPoP", expires_in, scope }`.
- `POST /api/auth/websocket-ticket` → `{ ticket, expiresAt }`.
- `POST /api/auth/pairing-token` — create pairing credential `{ label?, scopes? }` → `{ id, credential, label?, expiresAt }`.
- `GET /api/auth/pairing-links`, `POST /api/auth/pairing-links/revoke`.
- MCP OAuth: `GET /.well-known/oauth-authorization-server` (RFC 8414 metadata), registration
  (RFC 7591) at `registration_endpoint`, `POST /oauth/mcp/decision`, `POST /oauth/mcp/token`.
- **Scopes:** `orchestration:read|operate`, `settings:write`, `providers:manage`,
  `environment:maintain`, `preview:operate`, `diagnostics:read`, `terminal:read|operate`,
  `filesystem:read|write`, `review:write`, `source_control:write`, `access:read|write`,
  `relay:read|write`.
- **MCP client access levels:** `read-only`, `approval-required`, `auto-accept-edits`,
  `auto`, `full-access`.

### Relay cloud control plane (`/v1/…`)

- `POST /v1/client/dpop-token` — exchange Clerk token for DPoP-bound access token.
  Request: `{ grant_type: <token-exchange>, subject_token: <Clerk JWT>,
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  resource: <relay issuer URL>, scope, client_id }` where `client_id ∈ {t3-mobile, t3-web}`,
  `dpop` header = ES256 DPoP proof JWT. Response: `{ access_token, issued_token_type,
  token_type: "DPoP", expires_in, scope }`.
- `POST /v1/client/devices`, `POST /v1/mobile/devices`, `/v1/mobile/devices/:deviceId`.
- `/v1/environments` — create/list environments; `/v1/environments/:environmentId/connect`,
  `/status`, `/tunnel`, `/tunnel/recovery`, `/link-preferences`, `/hooks/wake`, `/threads/:threadId/agent-activity`.
- `/v1/hooks/:endpointKey/:hookId/:token` — webhook endpoint.
- `/v1/client/environment-links`, `/environment-links/:environmentId`, `/environment-links/:environmentId/tunnel`, `/environment-link-challenges`.

## 6. Other provider integrations (evidence)

- **Claude (credits/usage):** `API_BASE = https://api.anthropic.com`; reset program
  `cedar_ember`; usage `GET https://api.anthropic.com/api/oauth/usage`; weekly-scoped
  limits decode from `limits[]` (`weekly_scoped` + `scope.model`).
- **ChatGPT/Codex OAuth:** authorize URL `https://auth.openai.com/api/accounts/authorize`
  (validate: redirect `http://127.0.0.1:<port>/auth/callback`, state 16–128 `[\w-]`,
  `response_type=code`); PKCE S256; profile keeps `clientId`, `accessToken`,
  `refreshToken`, `idToken`, `issuer`, `expiresAt`, `scopes`, `subject`, `email`.
  Usage page: `https://chatgpt.com/#settings/Usage`. Credit reset:
  `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`.
- **Cursor usage:** `POST https://cursor.com/api/dashboard/get-filtered-usage-events`
  with `Origin: https://cursor.com` and cookie
  `WorkosCursorSessionToken=<userId>::<accessToken>`.
- **Google sign-in validation:** origin `https://accounts.google.com`, path
  `/o/oauth2/v2/auth`, `iss` claim must equal `https://accounts.google.com`;
  callback forwarded via `forwardAntigravityCallback` (provider setup flow).
- **OpenRouter/others:** provider inventory includes `google`, `google-vertex`,
  `github-copilot`, `amazon-bedrock`, `azure`, `openrouter`, `mistral`, `gitlab`.
- **OpenAI passthrough:** `https://api.openai.com/v1{path}` with `Authorization: Bearer`.

## 7. Telemetry / misc

- PostHog key: `phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m`.
- OTLP traces proxy: `/api/observability/v1/traces` (loopback).
- `T3CODE_*` env: `T3CODE_HOME`, `T3CODE_OTEL_SDK_DISABLED`, `T3CODE_RELAY_URL`,
  `T3CODE_ENV_*`, `T3CODE_CLI_PATH`, `T3CODE_OTLP_HEADERS`, `T3CODE_TELEMETRY_ENABLED`,
  `T3CODE_PORT`, `T3CODE_NO_BROWSER`, `T3CODE_DEEPAI_LOCAL_TEST`,
  `T3CODE_DEEPAI_DEV_API_ORIGIN`, `T3CODE_TAILSCALE_SERVE`, …
- Local test routing (`T3CODE_DEEPAI_LOCAL_TEST=true` + loopback origin) is an explicit
  opt-in; `resolveDeepAIApiOrigin` throws otherwise.
- DeepAI sponsored sidebar eligibility: signed-in + pro + allowance enabled (`/gravity-imp`).
- Branding: `DeepAI Code` (base), stage `Alpha`, version `0.3.35`; desktop scheme
  `deepai-code://app` (dev `deepai-code-dev://app`); updater cache dir
  `deepai-code-desktop-updater`; publisher `Deep AI, Inc`.

## 8. Unverified / unknown

- Actual Clerk publishable key + client ID (build-time injected; not in this dist).
- Actual relay URL (build-time injected; `T3CODE_RELAY_URL` env override).
- DeepAI server-side behavior of `X-DeepAI-Code-Theos: 4` (lane semantics) beyond
  catalog `lane_version` checks.
- Whether `/deepai_code/chat/completions` expects any streaming-only quirks (only
  caller usage observed: summarizer, suggested-next prompts, `stream:false`).
- The `app/package.json` obfuscation scheme (raw bytes, not plain JSON).

## 9. Suggested next steps

1. ~~Run the desktop app once (authorized local setup) and capture the real
   DeepAI sign-in exchange + `/models` + `/theos` wire with mitmproxy to
   verify header set and shapes.~~ ✅ DONE live 2026-11-11 — see
   `2026-11-11-deepai-code-live-wire-verification.md` (exchange, models 22,
   quota, chat hit stream + non-stream all verified).
2. Probe metered model spend (Theos) once a paid/allowance account is worth it.
3. If T3 Connect is in scope, capture the Clerk authorize → token flow live to
   pin the actual frontend API domain and client IDs.
