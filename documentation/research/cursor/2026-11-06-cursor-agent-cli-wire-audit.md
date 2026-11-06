# Cursor agent CLI 2026.11.05 — wire audit vs Cartethyia adapter

**Date:** 2026-11-06
**Source:** `D:\tmp\binaries\cursor-agent-windows-x64\dist-package\` —
npm runtime package `@anysphere/agent-cli-runtime` (webpack bundle, 102 chunks)
for the `cursor-agent` CLI (Windows x64). Source of truth: `index.js` (CLI
main), `8123.index.js` (bridge worker), `connect-pool-worker.js` (pool worker).
Build commit is `cli-2026.11.05-86047df` (header literal, verified below).

This is the CLI's own wire; it does not describe the desktop IDE's wire (the
IDE may send more — `x-cursor-checksum` shape, host-app headers — see §5).

---

## 1. Hosts

From `service-urls.ts` (bundle literal):

```js
const n = "prod";
const s = {
  prod: {
    apiUrl: "https://api2.cursor.sh",
    websiteUrl: "https://cursor.com",
    metricsUrl: "https://api3.cursor.sh",
  },
  playground: { apiUrl: "https://api.playground.cursor.sh", websiteUrl: "https://playground.cursor.com" },
  staging: { apiUrl: "https://staging.cursor.sh", ... },
};
```

| Host | Used for | Adapter |
|---|---|---|
| `api2.cursor.sh` | all unary Connect API (auth, catalog, dashboard, server config) | ✅ `CURSOR_API_HOST` |
| `api2direct.cursor.sh` | **bridge worker** only: `r.replace("api2.cursor.sh","api2direct.cursor.sh")` when the URL contains `api2.cursor.sh`, with `host` header set back to `api2.cursor.sh` (ALB routing). **Not** the CLI's normal path. | ❌ not used (N/A) |
| `api3.cursor.sh` | metrics/telemetry | ❌ (N/A) |
| `api.cursor.com` | auth/identity for `x-cursor-auth` flows (`x-cursor-auth` header seen next to `l="api.cursor.com"` in `index.js`) | ❌ |
| `agentn.*.api5.cursor.sh` (+ `agent.*`, `api5`, …) | Run stream origin from `GetServerConfig` | ✅ `normalizeAgentRunOrigin` / `isAllowedAgentHost` |
| `cursor.com` | website, login, download | ✅ `CURSOR_WEBSITE_HOST` |

**Adapter matches the CLI's host map.** `api2direct` is a bridge-worker
special case only; the gateway does not run bridge workers.

---

## 2. Connect-RPC endpoint inventory (from bundle service defs)

Services referenced (all `aiserver.v1.*` unless noted):

| Service | Methods seen |
|---|---|
| `agent.v1.AgentService` | `Run` (biDi), **`RunSSE`** (server-streaming), **`RunPoll`** (server-streaming), `NameAgent`, `UpdateConversationMetadata`, `CreateTranscriptOverview`, `GetUsableModels`, `GetDefaultModelForCli` |
| `aiserver.v1.AiService` | `AvailableModels`, `GetDefaultModelForCli`, `GetUsableModels`, `StreamChatTryReallyHard`, `RerankDocuments`, `StreamComposer`, `StreamComposerContext`, `WarmComposerCache` |
| `aiserver.v1.ServerConfigService` | `GetServerConfig`, `ResolveNewRepoFlowBackendProbe`, `GetNewRepoFlowConfig` |
| `aiserver.v1.DashboardService` | `GetMe`, `GetTeams`, `GetPlanInfo`, `GetCurrentPeriodUsage`, `GetMonthlyBillingCycle`, `GetUserOrganizations`, `GetUserPrivacyMode`, `GetCliDownloadUrl`, `GetGlobalCommands`, `GetTeamCommands`, `GetTeamHooks`, `GetTeamReposOrEmptyIfNotInTeam`, `GetTeamAdminSettingsOrEmptyIfNotInTeam`, `GetEffectiveUserPlugins`, `GetManagedSkills`, `ListMarketplaces`, `ListMarketplacePlugins`, `ResolvePluginsByRef`, `GetAggregatedUsageEvents` |
| `aiserver.v1.AutomationsService` | `ListAutomations`, `GetAutomation`, `GetAutomationRun`, `ListAutomationRuns`, `ValidateAutomationSpec` |
| `aiserver.v1.BackgroundComposerService` | `ListPrivateWorkers`, `ListBackgroundComposers`, `StreamConversation`, + many more (cloud agents) |
| `aiserver.v1.AgentStoreService` | list/read/write/presign/lock/… (agent store sync) |
| `aiserver.v1.AnalyticsService` | `BootstrapStatsig` |
| `aiserver.v1.MetricsService` | `ReportIncrement`, `ReportDecrement`, `ReportDistribution`, `ReportGauge` (protobuf via connect) |
| `aiserver.v1.BidiService` | `BidiAppend` |
| `aiserver.v1.RepositoryService` | repository indexing/search (`search` command) |

**The adapter only implements the three the gateway needs**: `/agent.v1.AgentService/Run`
(Run), `/aiserver.v1.AiService/AvailableModels` (roster), `/aiserver.v1.ServerConfigService/GetServerConfig`
(origin). ✅ matches.

New in this build compared to the 2026-10-20 ledger: `RunSSE` and `RunPoll`
exist as alternative Run transports (server-streaming / polling instead of the
biDi stream). They are not used by this adapter, which follows the biDi shape.

---

## 3. Headers

### 3.1 Shared request middleware (`cursor-config/dist/request.js` → `w.Wn`)

Applies to **every** Connect request (unary and biDi), via
`ot(t, requestMiddleware ?? w.Wn, { baseUrl, apiUrl, configProvider })`:

```js
i.header.set("authorization", `Bearer ${c}`);          // 1. Bearer token
i.header.set("x-ghost-mode", u ? "true" : "false");    // 2. from privacyCache.ghostMode (default true)
(0, w._5)(i.header);                                   // 3. "local-cli-mode": "true" when CURSOR_AGENT_CLI_LOCAL_MODE
(0, w.EL)(i.header, n);                                // 4. "x-cursor-team-id": String(teamId) when set
i.header.set("x-cursor-client-version",
  `cli-2026.11.05-86047df${m}`);                       // 5. version; m = `-${channel}` when channel not prod/prod-stable-internal
i.header.set("x-cursor-client-type", l);               // 6. surface ("cli" | "acp" | …)
// 7. x-cursor-timezone: Intl.DateTimeFormat().resolvedOptions().timeZone (when absent)
// 8. x-dev-experiment-overrides: when present (statsig dev overrides)
i.header.get("x-request-id") || i.header.set("x-request-id", crypto.randomUUID()); // 9.
```

### 3.2 Run-stream interceptor (`agent-client` wrapper)

Additional headers on the biDi Run stream (and only there):

```js
const u = (t) => async (e) => (e.header.set("x-cursor-streaming", "true"), await t(e));
```

So the Run stream carries `x-cursor-streaming: true`. `x-request-id` is
guaranteed by the transport layer (`stream()` mapper) when absent.

### 3.3 Bridge-worker registration (NOT the CLI Run path)

`8123.index.js` / `connect-pool-worker.js` registration headers — included for
completeness; the gateway does not run a bridge worker:

```
authorization: Bearer <token>
x-working-directory
x-worker-id
x-worker-hostname / x-worker-local-ips (optional)
x-ghost-mode: true|false
x-cursor-client-os: win32
x-cursor-client-arch: x64
x-worker-labels (optional)
x-idle-release-timeout-seconds
x-shared-assignment-allowed / x-computer-use-enabled / x-desktop-share-enabled
x-desktop-control-enabled / x-cursor-server-enabled
x-cursor-checksum: <checksum> (only when cursorChecksumHeader provided)
x-cursor-client-version: cli-2026.11.05-86047df  (also as "2026.11.05-86047df" in a version header)
```

### 3.4 Header audit vs adapter

| Header | CLI sends | Adapter | Status |
|---|---|---|
| `authorization: Bearer <token>` | ✅ every request | ✅ run + unary | ✅ |
| `content-type: application/json` (unary) / `application/connect+proto` (Run) | ✅ | ✅ | ✅ |
| `connect-protocol-version: 1` | ✅ (connect-es default) | ✅ | ✅ |
| `user-agent: connect-es/1.6.1` | ✅ (connect-es 1.6.1 in bundle) | ✅ | ✅ |
| `x-cursor-client-type: cli` | ✅ every request | ✅ run + unary | ✅ |
| `x-cursor-client-version` | ✅ `cli-2026.11.05-86047df` | ✅ (fallback `cli-2026.10.19-6bbf2c4`; discovery-overridden) | ⚠️ fallback is one build older |
| `x-cursor-streaming: true` | ✅ Run stream only | ✅ run only | ✅ |
| `x-ghost-mode: true` | ✅ every request (privacy default true) | ✅ run + unary | ✅ |
| `x-request-id` | ✅ every request (UUID) | ✅ run + unary | ✅ |
| `x-cursor-timezone` | ✅ every request | ❌ | **GAP** |
| `x-cursor-team-id` | ✅ when active team | ❌ | **GAP** (only relevant for team accounts) |
| `local-cli-mode: true` | only when env flag | ❌ | N/A |
| `x-dev-experiment-overrides` | only when dev overrides | ❌ | N/A |
| `x-cursor-checksum` | **bridge worker only** — NOT sent by the CLI's normal Run/API path | ✅ sent on run + unary | ⚠️ **adapter sends a header the CLI does not send on these paths** |
| `x-cursor-client-os` / `x-cursor-client-arch` | bridge worker only | ❌ | N/A |
| `x-cursor-host-app-name` / `x-cursor-host-app-version` | ACP surface only | ❌ | N/A |
| `x-cursor-canary` | only with `--canary` | ❌ | N/A |

**Key finding:** `x-cursor-checksum` is a **bridge-worker** header in this CLI
build; the CLI's own Run and API requests do not send it. The adapter sends it
on the Run stream and unary calls. This matches the earlier donor-derived
protocol (IDE-shaped), but it is one more header than the current CLI sends.
It is not proven harmful — but it is not part of the CLI's wire.

---

## 4. Payload audit

### 4.1 `GetServerConfig` request fields (protobuf JSON)

`GetServerConfigRequest` fields seen in the generated schema:

```
1 telem_enabled (bool)
2 bug_bot_dismissed_notification_last_10_times_unix_ms
3 bug_bot_viewed_notification_last_10_times_unix_ms
4 os_stats
5 os_properties
6 remote_authority
7 in_app_ad_trigger
8 dev_environment
9 client_surface
10 scm_connect_ad_context
```

Adapter sends `{ telem_enabled: false }`. ✅ matches (fields absent are
optional; `telem_enabled` is the only one the gateway needs).

### 4.2 `AvailableModels` request fields

`AvailableModelsRequest` schema:

```
1 is_nightly (bool)
2 include_long_context_models (bool)
3 exclude_max_named_models (bool)
4 additional_model_names (repeated)
5 use_model_parameters (bool?)
6 include_hidden_models (bool?)
7 do_not_use_markdown (bool?)
8 variants_will_be_shown_in_exploded_list (bool?)
9 for_automations (bool?)
10 scope (enum: USER_AVAILABLE | AUTOMATIONS | ADMIN_SETTINGS_ALL_APPLICATION_MODELS)
11 use_react_model_picker (bool?)
12 use_cloud_agent_effort_modes (bool?)
13 admin_settings_group_…
15 use_parameterized_automations_models (bool?)
```

Adapter sends `{ includeLongContextModels: true, useModelParameters: true,
useCloudAgentEffortModes: true }`. ✅ matches the JSON→proto naming
(`include_long_context_models`, `use_model_parameters`,
`use_cloud_agent_effort_modes`).

### 4.3 Run payload

The biDi `AgentClientMessage`/`AgentServerMessage` shape is unchanged from the
2026-10-20 ledger (see `2026-10-20-cursor-run-protocol.md`). No new field or
frame type was found for the Run path in this build.

---

## 5. Conclusions & recommendations

1. **Hosts, paths, auth, and the three payloads match the CLI.** No changes
   required for the gateway's core flow.
2. **`x-cursor-checksum` is not a CLI header.** The adapter sends it on the
   Run stream and unary calls; the CLI sends it only for bridge-worker
   registration. **Decision (2026-11-06): keep** — it matches the IDE profile,
   is accepted by the server, and is not a CLI header only in the sense that
   the CLI's own Run path omits it.
3. **Cheap additions matching the CLI — APPLIED (2026-11-06):**
   `x-cursor-timezone` (from `Intl.DateTimeFormat().resolvedOptions().timeZone`)
   is now sent on the Run stream and on unary catalog calls, exactly where the
   CLI's request middleware sends it. `x-cursor-team-id` was not added: the
   gateway does not model Cursor teams.
4. **`FALLBACK_CLIENT_VERSION` / `VERSION_SOURCES.cursor.fallback` updated** to
   `cli-2026.11.05-86047df`, the build this CLI ships. The two fallbacks are
   kept equal so the console badge and the request header never drift apart.
5. **Do NOT add:** `x-cursor-client-os`/`x-cursor-client-arch`,
   `x-cursor-host-app-*`, `x-cursor-canary`, `x-dev-experiment-overrides`,
   `local-cli-mode` — bridge-worker/env-specific.
6. **Native tool execution — APPLIED (2026-11-06).** The adapter now executes
   Cursor's host tools locally instead of relaying them to the client or
   refusing them: `read`/`pi_read`, `write`/`pi_write`, `grep`/`pi_grep`,
   `shell`/`pi_bash`, `ls`/`pi_ls`, `pi_edit`, `pi_find`, `delete`. Safety:
   every filesystem path resolves inside the workspace root (escape → typed
   `rejected`/`permission_denied`); shell runs via parsed argv with `shell:
   false` and a pinned cwd. `subagent`, `web_search`, `fetch`, and MCP remain
   refused. Harness: `scripts/provider-probing/cursor/harness/native-tool-harness.ts`
   (19 checks, incl. parallel); unit tests in `test/providers/cursor-exec.test.ts`.

---

## 6. Evidence

- Bundle: `D:\tmp\binaries\cursor-agent-windows-x64\dist-package\index.js`
  (CLI), `8123.index.js` / `connect-pool-worker.js` (bridge worker).
- Host map literal: `index.js` (`service-urls.ts` module), `connect-pool-worker.js`.
- Service defs: `index.js` (`agent.v1.AgentService`, `aiserver.v1.*`).
- Middleware header builder: `index.js` (`w.Wn` request middleware, `ot`/`ft`/`ht`/`gt` client factories).
- Run streaming interceptor: `index.js` (`x-cursor-streaming`).
- Bridge registration headers: `8123.index.js` + `connect-pool-worker.js`.
- Build id literal: `cli-2026.11.05-86047df` (multiple sites).
- Applied in: `src/providers/integrations/cursor/cursor-shared.ts` (fallback
  + `resolveCursorTimezone`), `cursor-http2.ts`, `cursor-catalog.ts`,
  `src/providers/operations/client-versions.ts`; tests in
  `test/providers/cursor-auth-catalog.test.ts`.
