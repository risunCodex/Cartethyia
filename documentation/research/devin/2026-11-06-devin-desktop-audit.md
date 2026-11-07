# Devin Desktop v3.11.238 — Audit (wire, identity, telemetry, installer)

**Date:** 2026-11-06
**Binary:** `DevinUserSetup-x64-3.11.238.exe` (284,545,920 B, Inno Setup 6.4.0.1 Unicode, built 2026-11-06)
**Unpack:** `innounp 2.70.1` → `D:\tmp\unpacked\devin\` (14,616 files, ~1.31 GB; recipe in `.skills/cartethyia-reverse-engineering/references/unpacking-and-wire-capture.md`)
**Method:** static analysis only — no binaries executed. Evidence: ripgrep + windowed reads over unpacked bundles.

---

## 0. Identity: Devin = rebrand Windsurf (Codeium → Exafunction)

`resources/app/product.json` is the primary identity source:

| Key | Value |
|---|---|
| `nameShort`/`nameLong` | Devin |
| `oldNameShort` | Windsurf |
| `aliasName` | `surf` |
| `dataFolderName` | `.devin` (old: `.windsurf`) |
| `win32AppUserModelId` | `Exafunction.Windsurf` |
| `win32x64UserAppId` | `{5A8B7D94-9B5F-4D1F-93FC-5609F7159349}` |
| `darwinBundleIdentifier` | `com.exafunction.windsurf` |
| `urlProtocol` / `oldUrlProtocol` | `devin://` / `windsurf://` |
| `extensionsGallery` | `marketplace.windsurf.com/vscode/gallery` (item, control) |
| `crashReporter` | companyName `Exafunction`, Sentry minidump (all platforms) |
| `aiConfig.ariaKey` | `"windsurf"` (1DS/OneDS instrumentation key) |
| `zendeskTicketApiKey` | 64-hex key in product.json |

Extension marketplace and legacy brand remain windsurf-scoped.

---

## 1. Wire protocol (hosts, auth, payloads, transport)

Source: `out/vs/...` (electron-main, sharedProcess, workbench) + `devin-webapp-host/assets/*.js` (Devin-specific logic lives here; rest is stock VS Code chrome).

### 1.1 Hosts

| Host | Purpose | Evidence |
|---|---|---|
| `api.devin.ai`, `api.beta.devin.ai`, `api.devinenterprise.com` | Backend API | URL map derived at runtime: `planInfo.devinInfo.apiUrl`, fallback hardcoded `webapp-origin → api` map (`app.devin.ai → api.devin.ai`, …) |
| `api.itsdev.in` | Staging backend | same map |
| `auth.devin.ai` (+ `manage.devin.auth0app.com`) | Auth0 OAuth (SPA login) | webapp bundle; client ID `DjKr4B4qtVDBVMBzE4FvveclTSkJYfhk` |
| `unleash.devin.ai` | Feature flags (Unleash) | app name `1793394048` |
| `cdn.agentclientprotocol.com` | ACP registry icons | webapp |
| `windsurf-telemetry.codeium.com/telemetry` (+`/ping`) | Desktop OneDS telemetry | sharedProcessMain.js AppInsightsCore/PostChannel |
| `o4507463137361920.ingest.us.sentry.io/api/4508180955267072/minidump/?sentry_key=8265dd07a51672108f0e0df16dc75238` | Sentry native minidumps | out/main.js + product.json |
| `us3.datadoghq.com` (RUM intake via `/intake/datadog` proxy) | Datadog RUM/Logs | webapp: clientToken `pub84bd5d112205241fc56c168f26d054bb`, applicationId `d7e70a8e-f3a3-470e-a330-41b72b0b9898` |
| `static.devin.ai/desktop-preview-062dcfee/v1/...` | Devin preview build artifacts (webview content) | workbench.desktop.main.js (`YAr`/`XAr`) |
| `marketplace.windsurf.com/vscode/gallery` | Marketplace | product.json |
| `http://localhost:6789` | dev API constant (webapp) | webapp bundle |

### 1.2 Auth

Desktop injects **four Devin auth headers** from localStorage via `createDevinAuth1TokenInterceptor`:
`X-Devin-Auth1-Token`, `X-Devin-Account-Id`, `X-Devin-Primary-Org-Id`, `X-Devin-Session-Token`
(storage keys: `devin_auth1_token`, `devin_account_id`, `devin_primary_org_id`, `devin_session_token`).

Plus `Authorization: Bearer` + `X-Account-Type` (desktop client); webapp REST adds `x-cog-org-id`.

Login is OAuth (GitHub/Google/ChatGPT/Microsoft/SSO) → `devin_code`/`access_token` URL param → **`ExchangeDevinCode`** RPC returns `{sessionToken, auth1Token, accountId, primaryOrgId}`. Legacy one-time flows use `X-Auth-Token`.

### 1.3 Chat/model endpoints + payload

Two layers:

- **ACP JSON-RPC 2.0**: methods `session/new`, `session/prompt`, `session/load`, … `session/prompt` params: `{sessionId, prompt, _meta:{cognition.ai/clientMessageId, cognition.ai/replyThread}}` over a stream.
- **ConnectRPC (protobuf) `ApiServerService`**: `GetDevstralStream`, `GetStreamingCompletions`, `GetChatMessage`, `GetStreamingExternalChatCompletions` — all server-streaming. Core payload = `ChatMessagePrompt` (`message_id`, `prompt`, `tool_calls[]`, `tool_call_id`, `images[]`, `thinking`, `signature`, `generation_model_uid`, …) wrapped in `GetDevstralStreamRequest{metadata, chat_message_prompts[], tools_json}`.

### 1.4 Transport

- REST JSON via `ky`.
- ConnectRPC over fetch (server-streaming RPCs; content types `text/event-stream`, `application/x-ndjson`).
- Voice over **WebSocket** (`?token=`; JSON frames `start_session`/`resume_session`).
- ACP over a stream writer.

### 1.5 Models & tools

- Enum roster: GPT-5 series (nano/minimal/low/base/high/codex), o1/o3/o3-pro, GPT-OSS; model selection via `model_uid` + `ChatNodeConfig`.
- Tools: `ChatToolDefinition{name, description, json_schema_string, server_name, computer_use_config, is_custom_tool}`, MCP remote servers, ACP `_cognition.ai/mcp/*` methods.

### 1.6 Unusual

Hardcoded internal Datadog dashboard URLs; client-id `pub84bd5d112205241fc56c168f26d054bb`; opaque config string `DjKr4B4qtVDBVMBzE4FvveclTSkJYfhk` (Auth0 client id); `http://localhost:6789` dev API constant; CSP allowing `ws:` + localhost (session tunneling/SSH gateway).

---

## 2. Device identity & telemetry

Source: `out/main.js`, `out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js`, `node_modules/@vscode/deviceid`, webapp bundles.

### 2.1 Device IDs

| ID | Algorithm | Storage | Evidence |
|---|---|---|---|
| `machineId` (VS Code classic) | `machineid` file if exists (UUID regex); else **SHA-256(first non-virtual MAC)** hex; fallback random UUID v4 | `%APPDATA%\Devin\machineid` (plain text); cached in state `telemetry.machineId`/`storage.serviceMachineId` | out/main.js `UM()` = `xJ() || He()`; MAC picker skips null/VM OUIs |
| `devDeviceId` | UUID v4 via `@vscode/deviceid` | Windows registry (`Microsoft\DeveloperTools`) / `deviceid` file on macOS/Linux | devdeviceid.js |
| `sqmId` | Windows SQM registry MachineId | `HKLM\Software\Microsoft\SQMClient\MachineId` | out/main.js `FM()` |
| session ID | `UUID+Date.now()` per launch | in-memory | `common.sessionID` |
| webapp analytics session | `crypto.randomUUID()` | sessionStorage `analytics_session_id` | webapp |

### 2.2 Telemetry sinks

| Sink | What is sent | Evidence |
|---|---|---|
| `windsurf-telemetry.codeium.com/telemetry` | OneDS/1DS: event prefix `monacoworkbench/`, `common.machineId/sqmId/devDeviceId`, sessionID, commitHash, version, platform; consent flag `GPC_DataSharingOptIn=false` | sharedProcessMain.js (`vw` endpoint, `X_()` AppInsightsCore + PostChannel with `endpointUrl`, `Am.log()` → `track({name: eventPrefix+"/"+event})`) |
| Sentry (DSN above) | Native minidumps; tags `sentry[tags][crash_reporter_id]`/`sentry[user][id]` = crash-reporter-id UUID; `sentry[release]`=`windsurf@<version>`; `sentry[environment]`=stable/insider/next. JS SDK is generic (config-provided DSN, not hardcoded) | out/main.js `EX()`; chat client bundles |
| Datadog RUM (us3) | RUM actions/errors/views, session replay, `view_timing`, `render_crash`, `query_retry_cycle`, `renderer_session_switch`, `_dd.context` (`analyticsSessionId`); `DD_LOGS` console/error forwarding | webapp `app-initial-Sul-BBHA.js`, `entry-host-index-DLIC45qr.js` |
| `POST /analytics/ingest` (api.devin.ai) | Envelope `{user_id, user_agent, events:[{name, timestamp, user, session_id, page, payload, context, id:uuid, feature_flags}]}`; events `$identify`, `$logout`, app events (e.g. `Composer:Submit:SlackLink`); `POST /analytics/reset` clears client UUID | webapp IngestDriver (`ingestUrl`/`resetUrl`) |
| OpenAI-style | — | none found (no PostHog/Mixpanel/Segment/Amplitude/Intercom/Customer.io/GA anywhere in `out/`) |

Analytics queue persists in localStorage `__ingest_driver_queue_<host>`; flushed via `sendBeacon`/fetch, batch 10, retry 3. Conversion click IDs in localStorage `__devin_conversion_click_ids_v1` (gclid/gbraid/wbraid/fbclid/twclid/rdt_cid/li_fat_id).

### 2.3 Local persistence

| Path | Content |
|---|---|
| `%APPDATA%\Devin\machineid` | machineId |
| `%APPDATA%\Devin\User\globalStorage\storage.json` | telemetry ids, feature flags |
| `%APPDATA%\Devin\User\globalStorage\state.vscdb` | SQLite app state |
| `%APPDATA%\Devin\logs\<timestamp>` | spdlog |
| `%APPDATA%\Devin\argv.json`, `User\History`, `sync/`, `workspaceStorage\` | standard VS Code layout |
| `%USERPROFILE%\.devin\` | product data folder (`dataFolderName`); `.devin-migration-*` markers |
| Windows registry `Microsoft\DeveloperTools` | devDeviceId |
| Electron secret storage (safeStorage/DPAPI) | OAuth tokens (not plain files) |

### 2.4 User/plan attributes (from backend responses)

`planName`, `accountIdentityText`, `startTimestamp`/`endTimestamp`, `remainingMessages`, `remainingFlexCredits`, `includePurchaseCtas`, `showReferralLink`, `hidePurchaseCtas`, `enableAutoRefill`; org/enterprise: `orgId`, `enterpriseId`, `isPrimaryOrg`, `account_id`, `tier` (used in lease-manager queues: `tier, is_api, org_id, account_id, user_id`), roles (`is_owner`, …); usage ACUs/sessions/LOBs.

---

## 3. Installer & OS integration

Source: `install_script.iss` (3.1 MB) + payload inspection.

### 3.1 Installer summary

- AppId `{5A8B7D94-9B5F-4D1F-93FC-5609F7159349}`, publisher Codeium, x64-only, LZMA.
- `PrivilegesRequired=lowest` → **per-user install, no UAC**, all registry writes HKCU.
- Default dir `{code:GetDefaultDirName|{userpf}\Devin}` → `%LocalAppData%\Programs\Devin` (VS Code user-install pattern).
- Min OS: AppX manifest `10.0.19041.0+` (Win10 2004).

### 3.2 Install layout

```
%LocalAppData%\Programs\Devin\
├── Devin.exe                      (PE32+ x64, ~225 MB, v3.11.238; app version 1.126.0)
├── Devin.VisualElementsManifest.xml
├── bin\
│   ├── devin-desktop.cmd          ({code_GetBinDirApplicationCmdFilename}; ELECTRON_RUN_AS_NODE=1 wrapper)
│   └── devin-desktop              ({code_GetBinDirApplicationFilename}; POSIX launcher, COMMIT=9e593c73d4ca24802eb3b302035f33cedad59802, APP_NAME=devin-desktop)
├── policies\Devin.admx
├── resources\app\…                (VS Code fork)
├── tools\inno_updater.exe, vcruntime140.dll
└── appx\devin_x64.appx (stub), devin_explorer_command_x64.dll
```

Note: `install_script.iss` from innounp has **no `[Code]` section** (Pascal bodies stripped); `{code_*}` constants were reconstructed from usage sites. Exact Pascal bodies (telemetry, checks) not recoverable from this dump.

### 3.3 Registry (all HKCU)

- **File associations** (`associatewithfiles` task, ~141 ProgIDs): `HKCU\Software\Classes\.<ext>\OpenWithProgids` → Devin; `Devin.<ext>` class with `AppUserModelID=Exafunction.Windsurf`, `DefaultIcon` → win32 icons, `shell\open\command` → `"{app}\Devin.exe" "%1"`. Plus `DevinSourceFile`, `Applications\Devin.exe`.
- **Context menus**: Win11 path uses COM (AppX `windows.fileExplorerContextMenus` + `windows.comServer`, verb `OpenWithDevin`, CLSID `79B67B12-BD17-4CE4-B89B-F5F1AD10609A`, Path `devin_explorer_command_x64.dll`, STA). Legacy path: `HKCU\Software\Classes\*\shell\Devin`, `directory\shell\Devin`, `directory\background\shell\Devin`, `Drive\shell\Devin`.
- **App Paths**: `HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\devin-desktop.exe` → `{app}\Devin.exe`.
- **PATH**: `HKCU\Environment` `Path` task `addtopath` adds `{app}\bin` (gated by `NeedsAddToPath`).
- **No URL scheme registration in script** — `devin://`/`windsurf://` are self-registered by the app at runtime (product.json `urlProtocol`/`oldUrlProtocol`).
- Uninstall key implicit (Inno-generated).

### 3.4 Run / icons / updates

- `[Run]`: launch `Devin.exe` on interactive install (task `runcode`, `ShouldRunAfterUpdate`); silent install does NOT auto-launch (`WizardNotSilent`).
- Icons: start-menu group, optional desktop (`desktopicon`), quick-launch (`quicklaunchicon`).
- `[InstallDelete]` (upgrade, non-background): clears `resources\app\out`, `plugins`, `extensions`, `node_modules*` — full app refresh on version bump.
- Background updater `tools\inno_updater.exe` stages `old_*`/`new_*`/`updating_version`; `[UninstallDelete]` cleans them.

### 3.5 AppX package = manifest-only stub

`{app}\appx\devin_x64.appx` is a **2,285-byte ZIP** (not the 1.3 GB file at `{app}` in the Inno list — that entry is the *source* `{app}\appx\devin_x64.appx` path; the unpacked artifact on disk is the stub). Contents (3 files): `AppxManifest.xml`, `AppxBlockMap.xml`, `[Content_Types].xml`. Key facts:

- Identity `Exafunction.Windsurf`, version `1.0.126.0`, publisher `CN=Microsoft Corporation…` (matches DLL CompanyName — actual author Exafunction).
- `Executable="Devin.exe"`, `uap10:RuntimeBehavior="win32App"`, `TrustLevel="mediumIL"`; capabilities `runFullTrust`, `unvirtualizedResources`, `microphone`.
- `desktop6:RegistryWriteVirtualization=disabled` + `FileSystemWriteVirtualization=disabled` — real registry/filesystem writes.
- Extensions: `windows.fileExplorerContextMenus` (verb `OpenWithDevin`, CLSID `79B67B12-BD17-4CE4-B89B-F5F1AD10609A`, for Directory/Directory\Background/*) + `windows.comServer` surrogate → same CLSID, `devin_explorer_command_x64.dll`.

The installer registers this stub via `AddAppxPackage`/`RemoveAppxPackage` Pascal hooks (bodies absent).

### 3.6 `devin_explorer_command_x64.dll` (92,976 B)

PE32 (32-bit), GUI, Authenticode-signed, COM descriptor present. Exports: `DllCanUnloadNow`, `DllGetClassObject`, `DllGetActivationFactory` — classic in-proc COM server. Compiled from `D:\a\windsurf-explorer-command\windsurf-explorer-command\src\explorer_command.cc` (GH Actions), WRL (`RuntimeClass`, `SimpleClassFactory`, `UIExplorerCommand`), imports SHELL32. It is the **Windows 11 Explorer context-menu COM server** (IExplorerCommand), verb `OpenWithDevin` → `Devin.exe`.

### 3.7 ADMX (`policies\Devin.admx`, namespace `Windsurf.Policies.Devin`)

All policies registry-backed under `Software\Policies\Windsurf\Devin` (HKLM/HKCU). Categories:

- **Application → interactiveSessionConfiguration**: `ChatToolsAutoApprove`, `ChatToolsEligibleForAutoApproval`, `ChatAgentHostEnabled` (1.126), `ChatAgentMode`, `ChatAgentExtensionTools`, `ChatMCP` (enum none/registry/all), `ChatHooks`, `ChatApprovedAccountOrganizations`, `ChatAgentAllowedNetworkDomains`/`DeniedNetworkDomains`/`NetworkFilter`, `BrowserChatTools`, `ChatToolsTerminalEnableAutoApprove`, `Claude3PIntegration`, `Codex3PIntegration` (1.126), `CopilotReviewAgent`/`Selection`/`SessionSync`, `McpEnterpriseManagedAuthIdp`, `McpGalleryServiceUrl`, `ChatEnabledPlugins`, `ChatPluginsEnabled`, `ChatStrictMarketplaces`, `ChatExtraMarketplaces`, `ChatAgentSandboxEnabled`/`AllowAutoApprove`/`AllowUnsandboxedCommands`.
- **extensionsConfiguration**: `AllowedExtensions`, `ExtensionGalleryServiceUrl`, `ExtensionsAutoUpdate` (enum), `ExtensionsAutoUpdateDelay`.
- **telemetryConfiguration**: `TelemetryLevel` (all/error/crash/off), `EnableFeedback`.
- **updateConfiguration**: `UpdateMode` (none/manual/start/default).

---

## 4. Live OAuth capture (2026-11-06, Google provider) — proven end-to-end

Reconstructed the OAuth flow purely from static bundle analysis (no donor
code), then validated it live:

**Discovery chain (all from `devin-webapp-host/assets/` bundles):**
- `app-initial-Sul-BBHA.js` → config block: `sd=auth.devin.ai` (Auth0 domain),
  `cd=DjKr4B4qtVDBVMBzE4FvveclTSkJYfhk` (Auth0 client id),
  `ld=https://backend.webapp.devin.ai` (audience/`_`),
  `Ku` API base defaults to `https://api.devin.ai`.
- `app-initial-C64Yu33K.js` → `Jh` connection map (github/google/openai
  authorizeUrl + scope), `wh()` OAuth start, `bh()` redirect_uri builder
  (`https://${g}/login/callback` for external OAuth), state format
  `jm(id, csrf)` = `auth1-<csrf>.<id>` / `auth1-<id>`, PKCE S256.
- `app-initial-B5PhWzwv.js` → `/_default/post-auth/` route + `cu` schema
  (error/error_description/code/state).
- `callback-CQ5-zgeD.js` → **the exchange dispatcher**: for google/github/
  openai: `POST /api/auth1/{provider}/exchange` with body
  `{code, mode, code_verifier, redirect_uri, connection_id?, nonce?,
  signup_consent_version?}`; oidc: `/api/auth1/oidc/exchange`; saml:
  `/api/auth1/saml/request` + `/saml/consume`; openai link:
  `/api/auth1/openai/link`. Success response is
  `{status:"authenticated", token, user_id, email, ...}`.
- `/api/auth1/connections` (POST) returns live per-provider `client_id`
  (OAuth client IDs are NOT hardcoded in the bundle — fetched per request).

**Live result (Google provider):**
- `POST https://app.devin.ai/api/auth1/connections` `{product:"devin"}`
  → `connections[]` with `client_id` for github (`Iv1.fffb955bc006997f`),
  google (`686954959906-ta39pvm0f0hmc71nbou45j6c0liulmfe.apps.googleusercontent.com`),
  openai (`oaiapp_sM97PAyWJkKnotfQdh08eh7O`).
- Built authorize URL with PKCE S256 → signed in via Google → callback
  `https://auth.devin.ai/login/callback?state=...&code=4/0AUn...`.
- `POST /api/auth1/google/exchange` with `{code, mode:"login",
  code_verifier, redirect_uri:"https://auth.devin.ai/login/callback"}`
  → **200** `{status:"authenticated", token:"auth1_...",
  user_id:"user-...", email:"...", is_new_user:false}`.

**Key learnings:**
- Backend API base is `https://api.devin.ai`; webapp page is
  `https://app.devin.ai` (SPA, returns HTML for `/v1/models`).
- Auth1 token alone is NOT enough for API access: every
  `api.devin.ai` endpoint (including `/v1/models`, `/api/user/me`, org
  endpoints) returns **401 `{"detail":"No organizations found for auth1 user"}`**
  for an account without an organization — the app must create/join an org
  (and likely obtain a session token) first.
- PKCE verifier must be kept from link generation time; the exchange fails
  with 401 "Google authentication failed" on verifier mismatch.

**Probe scripts:** `scripts/provider-probing/devin/devin-oauth-capture.mjs`
(mode: webapp|sso|bridge|github|google|openai|capture|listen|flow),
`scripts/provider-probing/devin/devin-oauth-exchange.mjs`
(env: DEVIN_PROVIDER/DEVIN_CODE/DEVIN_VERIFIER),
`probe-devin-v1-models.mjs`, `probe-devin-api.mjs`, `probe-devin-org.mjs`.

---

## 5. Adapter-relevant notes (Cartethyia)

- Backend is `api.devin.ai` (prod), with beta/enterprise/staging variants; auth header set is distinctive (`X-Devin-Auth1-Token` etc.) and obtained via `ExchangeDevinCode` after OAuth.
- Chat model payloads are ConnectRPC protobuf (`GetDevstralStream` etc.) or ACP JSON-RPC; not OpenAI-shaped on the wire — a Cartethyia adapter would need protocol translation.
- Telemetry is Exafunction-owned (Codeium OneDS + Datadog + Sentry + `/analytics/ingest`); no third-party trackers.
- Machine identity is SHA-256-of-MAC (deterministic) + UUID devDeviceId — relevant if API calls bind to machine identity.
- macOS 1.3 GB appx is not part of the payload (stub only) — don't plan around a full MSIX.

---

## 5. Proven vs unknown

**Proven (file evidence):** hosts, auth headers/RPC names, payload field names, transport types, model enum names, device ID algorithms and storage, telemetry sinks, installer layout/registry/ADMX, COM server identity, appx stub contents.

**Inferred / not proven:** exact Pascal function bodies of `install_script.iss` (absent from innounp dump — `GetDestDir`, `AddToPath`, `AddAppxPackage`, `ShouldUseWindows11ContextMenu`, etc. reconstructed from call sites); the `1.3 GB` `{app}\appx\devin_x64.appx` source file (the unpacked artifact on disk is the 2,285-byte stub — if auditing the full MSIX, re-extract and check whether a real appx exists); Auth0/backend behavior beyond static literals (needs live capture); `X-Auth-Token` legacy flow details.

**Next steps:** live wire capture (OAuth + `ExchangeDevinCode` + `GetDevstralStream`) when a real session is available; check `devin-webapp-host` asset bundle naming for version pins; confirm `devin://` protocol registration at runtime.
