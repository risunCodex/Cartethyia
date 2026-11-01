# Qoder JetBrains plugin — backend service & endpoint map (2026-11-01)

Static analysis of the unpacked Qoder JetBrains plugin. Extracted from the
instrumented product jar (`instrumented-qoder-product-2026.1030.84844323.jar`),
the bundled `config.json`/`env.json` from `binaries-qoder-2026.1030.1.zip`
(commit `acc39d3`, built 2026-10-30 15:32:57), and the plugin's
`QoderEndpointProvider` / `QoderProductDefinition` classes
(`D:\tmp\qoder-classes\`). No binaries were executed; no live traffic was sent
for this note except where stated.

## Service → host map (from `QoderEndpointProvider` + `env.json`)

The plugin models its backend as services, each with a dedicated host. The
mapping below pairs each service with its host (positional pairing in the
class constant pool, cross-checked against `env.json`):

| Service | Host | `env.json` key |
|---|---|---|
| Account Service / Backend Account Service | `https://www.qoder.com` | `login_url` / `auth_login_url` / `auth_logout_url` |
| Campaign API (CAMPAIGN_API) | `https://api1.qoder.sh` | — |
| API Service | `https://api2.qoder.sh` | — (chat surface host) |
| Inference Service | `https://api3.qoder.sh` | `infer_api_endpoint` |
| OpenAPI Service (OPEN_API) | `https://openapi.qoder.sh` | `open_api_endpoint` |
| Center Service | `https://center.qoder.sh` | `big_model_endpoint` (`/algo`) |
| Remote Agent Service | `https://qts1.qoder.sh` / `https://qts2.qoder.sh` | `quest_server_endpoint` (`qts2`) |
| Repo Service | `https://repo1.qoder.sh` / `https://repo2.qoder.sh` | — |
| Marketplace Service | `https://marketplace.qoder.sh` | — |
| Download Service | `https://download.qoder.com` | — |
| Dynamic Config Service | `https://center.qoder.sh/ide-config/qoder-jb/dynamic-config/latest` | — |
| Dynamic Text Service | `https://center.qoder.sh/ide-text/latest?namespace=qoder-jb` / `?namespace=qoder-ide` | — |
| Error Text Service | `https://center.qoder.sh/ide-text/latest?namespace=error-code` | — |
| Feedback API (FEEDBACK_API) | host not resolved statically | — |

`env.json` remote_config also defines `login_encode: "2"` and `message_encode:
"1"`.

## Product capabilities (from `QoderProductDefinition`)

| Capability | Meaning |
|---|---|
| `CREDITS` | credit/usage tracking |
| `DIRECT_AUTH` | direct authentication strategy |
| `DIRECT_AUTH_SYNC` | sync variant of direct auth |
| `ENTERPRISE_BYOK` | enterprise bring-your-own-key |
| `ENTERPRISE_MODELS` | enterprise model access |
| `LEGACY_CHAT` | legacy chat surface (COSY) |

## `/api/v2` paths observed in strings

| Path | Likely purpose |
|---|---|
| `/api/v2/model/list?Encode=1` | model roster (verified live, signed GET) |
| `/api/v2/quota/usage` | quota usage |
| `/api/v2/byok/config`, `/api/v2/byok/check` | BYOK config/validation |
| `/api/v2/config/getDataPolicy`, `/api/v2/config/updateDataPolicy` | data policy |
| `/api/v2/activity/…` | daily credit / quota reset (verified live) |
| `/api/v2/service/agent/quota` | agent quota |
| `/api/v2/service/ask/queue/status?requestSetId=` | ask queue status |
| `/api/v2/service/ask/finish` | ask finish |
| `/api/v2/service/business/finish` | business finish |
| `/api/v2/service/chat/delete/record` | chat record delete |
| `/api/v2/service/codebase/commit/batchBuildCommitMsg` etc. | codebase commit intelligence |
| `/api/v2/service/integrations/github/app/repo-status` | GitHub app integration |
| `/api/v2/service/migration/personal-migrations/pre-check` | personal migration |
| `/api/v2/remoteAgent/qoder/tasks/` | remote agent tasks |
| `/api/v2/remoteAgent/qoder/sessions/` | remote agent sessions |
| `/api/v2/remoteAgent/qoder/workspaces/allocate` | remote agent workspace allocation |
| `/api/v2/remoteAgent/sse/qoder/tasks/`, `/api/v2/remoteAgent/sse/qoder/user/events/stream` | remote agent SSE |
| `/api/v2/file/diagnose/upload`, `/api/v2/image/upload` | file/image upload |
| `/api/v2/feedback/dislike` | feedback |
| `/api/v2/extension/script/download?ext_id=` | extension script |

## Device login flow (from strings)

- `device/selectAccounts` (`https://www.qoder.com/device/selectAccounts`)
- `device_token_polling.go`, `device_login.go`, `DEVICE_LOGIN_FAILED`
- Device identity: `device.getDiskSerialNumber`, `device.getMacAddress`,
  `device.encodeMachineId`, `device.randomString` — the OAuth device flow
  mints a token tied to hardware.

## Relationship to the adapter

- The chat surface host `api2.qoder.sh` maps to the generic "API Service",
  consistent with the COSY chat path already verified live.
- `center.qoder.sh/algo` = the legacy COSY big-model endpoint.
- The remote agent surface (`qts1/qts2.qoder.sh`) is the quest/agent backend —
  not used by the Cartethyia chat adapter.
- Most `/api/v2` paths above are plugin UI/agent endpoints, not chat; they are
  catalogued for completeness and were not exercised live.

## Evidence files

- `D:\tmp\qoder-jetbrains-unpacked\qoder-jetbrains\lib\instrumented-qoder-product-2026.1030.84844323.jar`
- `D:\tmp\binaries-qoder-2026.1030.1.zip` → `config.json`, `env.json`
- `D:\tmp\qoder-classes\QoderEndpointProvider.class`, `QoderEndpointProvider$1.class`, `QoderProductDefinition.class`
- `D:\tmp\qoder-strings.txt` (713,985 extracted strings)
