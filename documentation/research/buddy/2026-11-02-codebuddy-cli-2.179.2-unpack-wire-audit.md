# CodeBuddy CLI 2.179.2 — unpacked wire audit (headers + payload builders)

Source: `@tencent-ai/codebuddy-code@2.179.2` tarball from npm, unpacked to
`D:\tmp\codebuddy-code\package` (no install). Bundles inspected: `dist/codebuddy.js`
(TUI, ~32 MB), `dist/codebuddy-headless.js`, `dist/codebuddy-lite-wb.mjs`,
`dist-server/codebuddy.js`. Live CLI session log from `~/.codebuddy/logs/2026-10-28`
(CLI 2.177.1) used as corroborating wire evidence. All observations dated
2026-11-02; revalidate before treating as a current upstream guarantee.

## 1. Chat endpoint (confirmed from live log)

The reference CLI sends model chat to:

```
POST https://www.codebuddy.ai/v2/chat/completions
```

Log evidence: `[ModelProvider] Sending request: agent=..., model=..., stream=true,
url=https://www.codebuddy.ai/v2/chat/completions` — repeated for every model call.
CN realm origin chain: `https://www.workbuddy.cn` → `https://copilot.tencent.com`
→ `https://wb.tencentbuddy.com` (failover/alternate).

Other live endpoints seen in the log: `/v3/config` (model catalog), `/v1/traces`
(OTLP trace export), `/v2/chat/decisions` (router), `/agenttool/v1/search`,
`/agenttool/v1/webfetch`, `/agenttool/v1/intent/recall` (agent tools).

## 2. Model request header assembly (from bundle)

The chat request headers are assembled from several builders:
`buildConversationHeaders`, the model-request `inject` path, `runIdentityHeaders`,
`IOAUtils.applyIOADefaultHeaders`, and `injectOtelSpanHeaders`.

### Identity / auth
- `Authorization: Bearer <JWT>` — Keycloak token (`iss: https://www.codebuddy.ai/auth/realms/copilot`, `azp: console`).
- `User-Agent: CLI/<v> CodeBuddy/<v>` — one npm CLI package version for both halves (log showed `CLI/2.177.1 CodeBuddy/2.177.1`; current npm latest is 2.179.2).
- `X-Domain: www.codebuddy.ai` (intl) / `copilot.tencent.com` (CN).
- `X-User-Id` — the JWT **`sub`** claim (a UUID), not an internal account id. Log example: `x-user-id":"26fb6257-deeb-428a-954c-f3f6a377c9d1"`.
- `X-Userinfo` — `base64({ uin: uid, owner_uin?: enterpriseId, id_source?: idSource, token_source?: method })`, built by `runIdentityHeaders` when identity fields exist.
- `X-Auth-Method` — the OAuth method, when present.
- `X-Id-Source` — the identity source, when present.
- `X-Enterprise-Id` / `X-Tenant-Id` — only for enterprise accounts; IOA environment injects defaults (`tencent.sso.copilot.tencent.com` domain, enterprise `etahzsqej0n4`, staging `esoikz80kd8g`).

### Agent block
- `X-Agent-Intent` — `craft` by default; sourced from meta `codebuddy.ai/mode`.
- `X-Agent-Type` — `main` | `subagent` | `team` | `compaction` | `auxiliary` (`resolveModelCallAgentType`).
- `X-Agent-Runtime` — `local-agent` | `cloud-agent` | `agent-agent` | `other` (default `other`; `agent-agent` comes from W3C baggage).
- `X-Agent-Purpose` — dynamic: `person_agent` when `PERSONAL_AGENT_ROLE` is set, otherwise the effective agent purpose scope; only sent when one exists.
- `X-Private-Data` — sent as `true` only while the session is in private-data mode; otherwise **deleted** (`applyPrivateDataHeaderPolicy`). Not a constant `false` header.

### Conversation / turn
- `X-Conversation-ID` — session id (`eB.id`).
- `X-Conversation-Request-ID` — 32-hex turn aggregation key (log shows `conversation_request_id`).
- `X-Conversation-Message-ID` — 32-hex message id (= `X-Request-ID`).
- `X-Request-ID` — 32-hex message id.
- `X-Trace-ID` — trace id.
- `X-Root-Request-ID` — only when a root request id exists (conditional).
- `X-Parent-Conversation-ID` — only for subagents (conditional).
- `X-Compaction` / `X-Context-Compacted` — only when compaction context exists (conditional).

### Tracing (`injectOtelSpanHeaders`)
- `traceparent: 00-<traceId>-<spanId>-01`
- `b3: <traceId>-<spanId>-1` (+ `-<parentSpanId>` when parented)
- `X-B3-TraceId`, `X-B3-SpanId`, `X-B3-Sampled`, `X-B3-ParentSpanId` (conditional)
- Same shape the gateway's buddy conversation headers already emit.

### Not sent on chat model requests
- `x-stainless-*` — the chat transport is **axios** (`axiosToFetchAdapter`), not the Stainless SDK. The Stainless base client (7.39.0, `JS 7.39.0`) exists in the bundle but serves secondary clients.
- `X-CodeBuddy-Request: 1` — this is the **local daemon / Mod HTTP API** security header (OpenAPI schema: forces CORS preflight, fixed value `1`), not a cloud chat header.
- `X-Product` — appears on web-fetch / web-search service calls, not on chat.

## 3. Payload injections (body)

- `model` — `auto` is rewritten to `default-model` (intl) / `default` (CN).
- `stream: true` — always.
- `reasoning_summary: "auto"` — injected by `injectReasoningSummaryIfNeeded` when reasoning is enabled or an effort (`reasoning_effort` / `reasoning.effort`) is set and no summary is present.
- `reasoning_effort` — passes through; set to `"none"` when the session override or global `alwaysThinkingEnabled` is off.
- **`cache_retention: "long"`** — injected unconditionally when absent (`resolveCacheRetention`); becomes `"short"` when `CODEBUDDY_DISABLE_PROMPT_CACHING_1H` is set.
- `extra_vars` — harness-step JSON (`h6.AR`) injected for non-custom chat models.

## 4. Catalog / models

- CLI reads `/v3/config` first, then the personal-models path (`/v2/enterprises/personal/models` intl, `/console/enterprises/personal/models` CN); both use `{ code, msg, data: { models, agents } }` envelope.
- The big model roster in the bundle (with `baseUrl: https://opencode.ai/zen/go/v1`, provider `opencode-go`, `thinkingLevelMap`) belongs to the **BYOK / opencode-go** provider, NOT to CodeBuddy's own builtin roster. It is not evidence for cb's own effort ladders.
- `deepseek-v4.1-flash` is a real CLI model (confirmed in `cbc --help` roster and the 2026-10-19 dispatch table). Its cb-realm ladder is not derivable from the bundle.

## 5. Gaps vs the gateway's CodeBuddy adapter

| # | Gap | Impact |
|---|---|---|
| 1 | `cache_retention` never sent | upstream default differs; prompt-caching behavior/price can differ |
| 2 | `X-Agent-Purpose` hardcoded to `"conversation"` | reference is dynamic (`person_agent`/scope) — channel-check surface differs |
| 3 | `X-Private-Data` always sent as `"false"` | reference only sends `true` when private mode is active |
| 4 | `X-Userinfo`, `X-Auth-Method`, `X-Id-Source` absent | OAuth identity headers not carried |
| 5 | `X-Root-Request-ID`, `X-Parent-Conversation-ID` absent | conditional turn-context headers not carried |
| 6 | `X-Compaction` / `X-Context-Compacted` absent | conditional |
| 7 | `x-stainless-*` over-sent on chat | reference chat uses axios; broadens the fingerprint |
| 8 | `X-User-Id` sourced from internal `account_id` | reference uses JWT `sub`; diverges when account_id ≠ sub |

## 6. Unverified / open

- Whether the live API enforces any of the gap headers (most are likely optional, like the previously-tested B3 set and agent block).
- CodeBuddy intl's real reasoning-effort ladder for `deepseek-v4.1-flash` (the 2026-10-19 note's free-tier dispatch allowed it; effort acceptance needs a live probe).
- Exact `X-Userinfo` base64 payload acceptance on the chat path.
