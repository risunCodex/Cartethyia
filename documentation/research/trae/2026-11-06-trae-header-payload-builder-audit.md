# Trae 3.6.13 — header & payload builder audit vs Cartethyia adapter

**Date:** 2026-11-06
**Source:** `D:\tmp\unpacked\TRAE\code$GetDestDir\resources\app\modules\ai-agent\ai_agent.dll`
(Rust harness — the only place the request builder lives; JS bundles carry no
header/endpoint literals).

**Status:** audit → probe A/B → adapter applied (2026-11-06). The three
low-risk harness headers (`X-App-Version`, `X-App-Version-Code`,
`x-ide-version`, `request-traffic-type`) are now sent by the adapter by
default; the rest are intentionally not adopted (internal/telemetry only).

---

## 1. Header inventory from the harness

### 1.1 `HTTPClient` header list (http.rs — shared client)

```
X-APP-ID
X-App-Version
X-Ide-Version-Code
X-App-Version-Code
X-Plugin-Channel
X-Tt-Env1
X-Use-Ppe
X-Trae-Authorized-Services
X-Custom-Trace-Id
X-Device-Brand
X-Device-Cpu
X-Device-Id
X-Machine-Id
X-Web-Id
X-Os-Version
X-Device-Type
x-ide-version
x-ide-version-type
request-traffic-type
```

Hit 2 adds (dynamic config path):

```
X-User-Real-IP
X-Trae-Mobile-Commit-Id
X-Agent-Debug-Mode
x-flow-traceparent
```

### 1.2 `LLMAdapter` header list (chat-model path, `[LLMAdapter] headers:`)

```
X-Request-Pin
X-Requested-At
X-App-Function
X-Ide-Function
x-flow-traceparent
x-ide-version
x-ide-version-type
ICUBE_QUALITY                (value comes from env constant)
DISABLE_FORNAX_PROMPT        (feature flag)
x-agent-debug-mode
```

### 1.3 Header values — `ICUBE_*` environment constants

```
ICUBE_APP_VERSION             → X-App-Version / X-App-Version-Code
ICUBE_MACHINE_ID              → X-Machine-Id
ICUBE_QUALITY                 → x-ide-version-type / ICUBE_QUALITY
ICUBE_PRODUCT_QUALITY         → x-ide-version-type
ICUBE_PRODUCT_PROVIDER        → provider identity
ICUBE_PRODUCT_BRAND_NAME      → brand (Trae)
ICUBE_VSCODE_VERSION          → IDE version
ICUBE_BUILD_VERSION / BUILD_TIME
ICUBE_APP_CHANNEL             → X-Plugin-Channel (value: "icube-ai" — verified literal)
OS_RELEASE                    → X-Os-Version
IDE_ENVIRONMENT_ID
```

### 1.4 Env metadata shape (`LiteHandler`)

```
env_metadata = {
  version_code, region,
  environment: "trae_desktop" | "trae_desktop_bytedance",
  channel: "icube-ai",
  ide_version, extension_version
}
```

### 1.5 Auth headers

| Header | Context |
|---|---|
| `Authorization: Cloud-IDE-JWT <token>` | everywhere (upload, report, hub fallback, skill import) |
| `x-ide-token` | hub-net; appears next to `Authorization` in `[HubNetService] auth headers updated`; listed in `http.rs:4296` redaction/filter list |
| `x-cloudide-token` | plugin connector only (`/trae/api/v3/SetConnectorToken`, `ResolveConnectorToken`) |
| `Sec-WebSocket-Protocol: x-bridge-transportaha` | frontier WS |
| `User-Agent: TraeClient/TTNet` | verified literal (frontier `aha_ffi_frontier.rs`, net-bridge) |
| `x-tt-logid` | request log id |

---

## 2. Gap audit vs `buildTraeHeaders` (adapter)

| Harness header | Adapter sends | Status |
|---|---|---|
| `X-App-Id` | `X-App-Id` (app id `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`) | ✅ same name; value same |
| `X-Plugin-Channel` | `x-plugin-channel` | ⚠️ case differs (HTTP case-insensitive → OK) |
| `X-Ide-Version-Code` | `x-ide-version-code` | ⚠️ case differs → OK; but harness also sends `x-ide-version` |
| `X-App-Version` | `X-App-Version` (appVersion) | ✅ **ADDED** (2026-11-06) |
| `X-App-Version-Code` | `X-App-Version-Code` (appVersion) | ✅ **ADDED** (2026-11-06) |
| `X-Tt-Env1` | — | ❌ **GAP** (internal env flag — not adopted) |
| `X-Use-Ppe` | — | ❌ **GAP** (PPE test flag — not adopted) |
| `X-Trae-Authorized-Services` | — | ❌ **GAP** |
| `X-Custom-Trace-Id` | — | ❌ **GAP** |
| `X-Web-Id` | — | ❌ **GAP** |
| `x-ide-version` | `x-ide-version` (appVersion) | ✅ **ADDED** (2026-11-06) |
| `x-ide-version-type` | — | ❌ **GAP** |
| `request-traffic-type` | `request-traffic-type` (agent/chat) | ✅ **ADDED** (2026-11-06) |
| `X-User-Real-IP` | — | ❌ **GAP** |
| `X-Trae-Mobile-Commit-Id` | — | ❌ **GAP** |
| `X-Agent-Debug-Mode` | — | ❌ **GAP** (only when debug) |
| `x-flow-traceparent` | — | ❌ **GAP** (trace) |
| `X-Request-Pin` | — | ❌ **GAP** (LLMAdapter) |
| `X-Requested-At` | — | ❌ **GAP** (LLMAdapter) |
| `X-App-Function` | — | ❌ **GAP** (LLMAdapter) |
| `X-Ide-Function` | — | ❌ **GAP** (LLMAdapter) |
| `X-Device-Brand` | `X-Device-Brand` | ✅ |
| `X-Device-Cpu` | `X-Device-Cpu` | ✅ |
| `X-Device-Id` | `X-Device-Id` | ✅ |
| `X-Machine-Id` | `X-Machine-Id` | ✅ |
| `X-Os-Version` | `X-Os-Version` | ✅ |
| `X-Device-Type` | `X-Device-Type` | ✅ |
| `User-Agent` | `TraeClient/TTNet` | ✅ |
| `Accept` | `text/event-stream` (stream) / `application/json` | ✅ |
| `Content-Type` | `application/json` | ✅ |

### Missing in the adapter (would likely be tolerated, but unverified)

- `X-App-Version` / `X-App-Version-Code` — app version headers; server may use
  them for telemetry/entitlement correlation.
- `X-Tt-Env1` / `X-Use-Ppe` — environment/PPE (pre-production env) flags; almost
  certainly **internal-only** (ByteDance testing), safe to omit.
- `X-Trae-Authorized-Services` — authorized-services token; likely used for
  feature gating, optional.
- `X-Web-Id`, `X-User-Real-IP` — analytics/abuse headers; harmless to omit.
- `X-Custom-Trace-Id`, `x-flow-traceparent` — tracing; optional.
- `x-ide-version` (non-code header) vs `x-ide-version-code` — version split
  (semver vs date code). Our adapter sends only the date code.
- `request-traffic-type` — traffic classification (e.g. `chat`, `agent`).

---

## 3. Payload builder gaps

### 3.1 Chat body (`llm_raw_chat`)

Adapter sends (toTraeChatBody): `model_name`, `messages[]`, `stream`, `region`,
`ai_region`, `session_id`, `temperature`, `top_p`, `max_tokens`, `stop`, `tools`.

Harness evidence (`[LLMAdapter] llm_raw_chat_custom_model req:` + `llm_stream.rs`):
- `prompt_set`, `ab_version`, `config_name`, `model_name`, `pass_back_reasoning`
- `project_rules`, `user_rules`, `__internal_run_agent_id`, `is_first_message_in_session`,
  `diagnostic_mode_activated`, `__internal_is_sub_agent`, `is_init_command`,
  `__internal_agent_id`, `should_condense_shallow_memento`
- `session_id` kept

**Gap:** adapter does not send `config_name` on chat (only on agent surface),
nor `prompt_set`/`ab_version`/`pass_back_reasoning`/internal agent metadata. On
agent surface `config_name` is sent (rewritten from `model_name`), but the
agent-specific metadata (`__internal_agent_id`, `is_init_command`, rules) is
absent. These are mostly **internal agent-context fields** — not required for a
plain chat/agent tool-calling call (probes pass without them).

### 3.2 Agent body (`llm_utils_chat`)

Adapter sends: `function: "solo_agent"`, `config_name`, `config_source: 1`,
`messages[]`, `stream`, `region`, `ai_region`, `temperature`, `top_p`,
`max_tokens`, `tools`, `Request: {}` (in probe; adapter rewrite does not add
`Request`).

Harness evidence (`llm_utils_chat` call sites):
- `custom_agent_generation`, `input_optimization`, `title_generation`,
  `branch_name_generation`, `generate_session_title_and_icon_cloud`, fast apply —
  all route through `llm_utils_chat` **with different payloads per function**.
- `target_file`, `json_schema`, `edit_instruction`, `edit_plan`, `code_before`
  (fast-apply payload).
- `recommendation` flow uses `llm_utils_chat` with sessions.

**Gap:** for the *plain chat/agent* path the adapter’s body matches the
verified live wire. The harness uses the same endpoint for **auxiliary
functions** (fast_apply, title generation, branch naming, input optimization)
with function-specific payloads — none of which the gateway exposes.

---

## 4. What is verified working (probes, 2026-11-06)

| Surface | Body shape | Headers | Result |
|---|---|---|---|
| chat v1 | toTraeChatBody | JWT + device + version-code | ✅ 7/9 models |
| agent | toTraeAgentBody | JWT + device + version-code | ✅ 17/27 configs, tool-calling |
| agent + tools | `tools[]` with `parameters` JSON-string | same | ✅ full tool_calls |

So the **current adapter wire is functional**. The gap list above is an
inventory of what the desktop client sends that we do not — mostly telemetry,
trace, environment flags, and agent-context metadata. None have been proven
required by the live server for plain chat/agent calls.

---

## 5. Recommendations (ranked — status 2026-11-06)

1. ✅ **DONE — semver headers.** `x-ide-version` (semver) + `X-App-Version` +
   `X-App-Version-Code` sent by the adapter (from `getTraeVersion()`), with
   `request-traffic-type` set per surface (`agent`/`chat`). Verified live via
   A/B sweep: identical PASS/FAIL outcome with and without them.
2. **Do NOT add environment/PPE headers** (`X-Tt-Env1`, `X-Use-Ppe`) — internal
   ByteDance testing flags; adding them could trigger unintended test-path
   behavior.
3. **Do NOT add agent-context metadata** to chat bodies (`__internal_agent_id`,
   rules, etc.) — internal to the agent harness; the gateway has no such
   context and the server accepts our requests without them.
4. **Trace headers** (`x-flow-traceparent`, `X-Custom-Trace-Id`) — optional; add
   only if we want server-side trace correlation.
5. **`x-ide-version-type`** — the harness pairs `x-ide-version` with a type
   header; low value, not adopted.
6. **`X-Web-Id` / `X-User-Real-IP`** — leave out (privacy decision already made
   for the OS/brand strings).

---

## 6. Evidence

- Harness DLL: `D:\tmp\unpacked\TRAE\code$GetDestDir\resources\app\modules\ai-agent\ai_agent.dll`
- Scan/context scripts: `D:\tmp\scripts\scan-binary.ts`, `ctx-binary.ts`
- Live probes: `scripts/provider-probing/trae/probe-trae-chat.ts` (repo)
- Header literals found in `ai_agent.dll` at offsets around 144,229,000 /
  145,221,000 (HTTPClient) and 142,063,000 / 145,591,000 (LLMAdapter).
