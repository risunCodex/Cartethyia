# Kiro 1.4.62 — wire protocol reconstruction (from unpacked IDE)

Source: `extensions/kiro.kiro-agent/dist/extension.js` (agent v1.1.641), extracted
from the Inno Setup 6.4.0.1 installer with `innoextract 1.13.0` (fork). This is
the *new* client surface; the adapter's legacy `q.*`/`codewhisperer.*` calls are
**superseded**.

## Control plane (management) — `https://management.{region}.kiro.dev`

Service: `KiroControlPlaneBearerService`, protocol `aws.protocols#awsJson1_0`
(`application/x-amz-json-1.0`), apiVersion `2024-10-25`, namespace
`com.amazon.kiro.controlplane` / `com.amazon.kiro.controlplane.bearer`.
Signing name `kirocontrolplanebearerservice` (endpoint suffix
`{Region}.amazonaws.com` partition-resolved, but the client overrides the
endpoint to `https://management.{region}.kiro.dev`).

Operations (HTTP binding):
| Operation | Method | Path | Request body fields |
|---|---|---|---|
| `GetProfile` | POST | `/Get-Profile` | `profileArn` (optional) |
| `GetUsageLimits` | GET | `/Get-Usage-Limits` | query: `origin`, `profileArn` |
| `ListAvailableModels` | GET | `/List-Available-Models` | query: `origin`, `profileArn`, `nextToken`; response `models[]`, `nextToken`, `defaultModel` |
| `GetUserPreference` | GET | `/Get-User-Preference` | query (origin/profileArn) |

Response fields seen in `GetUsageLimits`: `subscriptionInfo.subscriptionTitle`,
`usageBreakdownList[]` (`resourceType`, `currentUsageWithPrecision`,
`usageLimitWithPrecision`, `freeTrialInfo.freeTrialExpiry`,
`currentUsage`, `usageLimit`), `nextDateReset`.

## Runtime (generation) — `https://runtime.{region}.kiro.dev`

Service: `KiroRuntimeService`, protocol `aws.protocols#awsJson1_0`,
apiVersion `2026-01-13`, namespace `com.amazon.kiro.runtimeservice`, signing name
`kiro.runtimeservice` (endpoint override `https://runtime.{region}.kiro.dev`).

Operations (HTTP binding):
| Operation | Method | Path |
|---|---|---|
| `GenerateAssistantResponse` | POST | `/generateAssistantResponse` (eventStream output) |
| `InvokeMCP` | POST | `/mcp` |
| `InvokeMCPStream` | POST | `/mcp/stream` (eventStream output) |
| `GetFeatureConfiguration` | GET | `/featureConfiguration` |

`GenerateAssistantResponse` request body (from `buildRequestCommand`):
```jsonc
{
  "conversationState": { /* legacy ledger shape */ },
  "profileArn": "…",
  "additionalModelRequestFields": { /* optional */ },
  "agentMode": "…",
  "systemPrompt": "…"
}
```
`additionalModelRequestFields` builder adds (when present):
`kiro:agent_mode`, `kiro:agent_task_type` (`spectask`),
`kiro:conversation_id`, `kiro:root_conversation_id`,
`kiro:agent_continuation_id`, plus `{ model: {…} }` metadata.

Legacy `conversationState` shape is unchanged (the same wire shape the adapter
already builds): `agentTaskType` (`vibe`|`spectask`), `agentContinuationId`,
`chatTriggerType` (`MANUAL`), `conversationId`, `currentMessage.userInputMessage`,
`history[]` with `userInputMessage`/`assistantResponseMessage`, tool results in
`userInputMessageContext.toolResults`, tool specs in `userInputMessageContext.tools`.

## Auth/headers

- Runtime request middleware adds `x-amzn-kiro-agent-mode`, `x-amzn-kiro-conversation-id`,
  `x-amzn-kiro-profile-arn`, and `TokenType` (from `qje` map).
- `qje` map: `external_idp → EXTERNAL_IDP`, `machine_token → KIRO_MACHINE_TOKEN`,
  `api_key → API_KEY`, `IdC → SSO_OIDC`, `google/github/builder-id → (none)`;
  `TokenType` header omitted for `SSO_OIDC` and missing methods.
- Activity publisher headers: `Content-Type: application/json`,
  `User-Agent: KiroAgent`, `Authorization: Bearer …`,
  `TokenType: …`, `x-amzn-kiro-profile-arn: …` (when profile).
- `create-response-raw` (CreateResponse path) headers:
  `Content-Type: application/json`, `Authorization: Bearer …`,
  `x-amzn-kiro-origin: …`, `x-amzn-codewhisperer-optout: true|false`,
  `x-amzn-kiro-profile: …`, `TokenType: …`, `User-Agent: …`.
- `x-amzn-codewhisperer-optout` is set to `true` only when content collection is
  disabled (`rOo`/`JIr`), not unconditionally.
- `x-amz-user-agent` / `user-agent` are the AWS SDK UA (with `KiroIDE-{v}-{machineId}`
  marker) for the AWS SDK clients; `Kiro-CLI`/`kiro-cli/2.37.0` for the CLI.
- Machine id (IDE): VS Code's `machineIdSync()` (fallback env `machineId` /
  `"UNDETERMINED_MACHINE_ID"`). No `KotlinNativeAPI`/`KiroAPIKey`/`KiroFallback`
  salts anywhere in the 1.4.62 IDE. Those salts were not re-proven by this build.

## Discovery surface

`ListAvailableModels` now talks to **management** (not `q.{region}.amazonaws.com`).
The `q.*` preset list still exists in the bundle but serves only the legacy
CodeWhisperer streaming client; `management`/`runtime` are the active host names.
