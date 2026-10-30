# Error codes and definitions

Reference for the error vocabulary Cartethyia exposes on the wire and records
in telemetry. This is the complete audit of every code, its HTTP status,
origin, retry semantics, and where it is produced.

---

## 1. Three distinct vocabularies

Cartethyia has **three** error systems. They do not share a registry, and a
code from one is not valid in another:

| System | Class / type | Shape | Where |
| --- | --- | --- | --- |
| **Transport / gateway** | `GatewayError` + `GatewayErrorCode` union | `{ error: { origin, code, message, details } }` | `/v1/*` proxy routes, guards, dispatch, admission, routing |
| **Console API** | `ConsoleDomainError` (string codes) | `{ error, code, details? }` | `/console/api/*` routes |
| **Telemetry only** | terminal categories, `AccountErrorCategory`, pool-health categories | stored in `telemetry_events` / account rows | never sent to clients |

Authoritative definitions:

- `GatewayErrorCode` union + `GatewayError` class: `src/protocol/gateway-error.ts`
- Upstream → gateway classification: `src/transport/failure-policy.ts`
- Account health decision (categories/cooldowns): `src/providers/operations/account-error-classification.ts`
- Console domain errors: `src/console/shared/errors.ts`
- Admission reason → code mapping: `src/security/admission/reasons.ts`
- Error normalization middleware (envelope): `src/transport/guards/error-lifecycle.ts`

---

## 2. The public error envelope

Transport and console shapes differ slightly; both are always JSON.

### 2.1 Gateway envelope (`/v1/*`)

```json
{
  "error": {
    "origin": "cartethyia" | "upstream" | "network",
    "code": "<GatewayErrorCode>",
    "message": "human-readable sentence",
    "details": { "...allowlisted keys only..." }
  }
}
```

Rules (`gateway-error.ts`, `error-lifecycle.ts`):

- **`code`** — stable machine-readable code; the only field clients should
  branch on.
- **`origin`** — which layer produced the failure: `cartethyia` (this
  gateway), `upstream` (the provider/edge), `network` (proxy pool /
  transport infrastructure). Blame for a failure lives here, never in the
  text.
- **`requestId`** — mandatory. The same `requestId` that rides in the
  `x-request-id` header is repeated inside the body (structured field) and
  inside the lead message text as `(request {requestId})`, so a client that
  only reads the message string can still correlate it to the server log.
  The middleware appends the id to any message that does not already carry
  it, so every public error is correlatable even when the producer builds
  the message from upstream prose.
- **`message`** — plain sentence. Legacy prefixes (`Cartethyia Error:`,
  `Upstream Error:`, `Network Error:`) and any leading `<code>:` stamp are
  stripped idempotently (`formatPublicErrorMessage`). The code is never
  stamped into the text. Every lead is English + formal; the tail may carry
  one light emoji (house tone) for transient server-side failures.
- **`details`** — allowlisted keys only (`PUBLIC_ERROR_DETAIL_KEYS`), each
  value bounded: strings sliced to 500 chars, arrays to 32 entries, nested
  depth to 3 (`[redacted]` beyond). Unknown keys are dropped. This is the
  only surface where upstream-provided text can appear (`raw`, `message`,
  `providerCode`), always truncated.
- Elysia built-in errors keep their real status/code; unknown input errors
  normalize to `invalid_request`; unknown server errors to `internal_error`.
- `retry-after` header is emitted when the error carries real evidence
  (`details.retryAfterMs`, `details.retryAt`); otherwise a literal 429 gets
  the safe floor `retry-after: 1`.

### 2.2 Console envelope (`/console/api/*`)

```json
{
  "error": "...",
  "code": "<string>",
  "details": { }   // optional; included when present unless omitted by policy
}
```

`consoleErrorHandler` maps Elysia `ValidationError` to `invalid_request` /
422; everything else goes through `errorResponse` (fallback `internal_error`,
500). Console codes are **free-form strings** (see §6) — not members of the
`GatewayErrorCode` union.

---

## 3. `GatewayErrorCode` — complete catalog (55 codes)

HTTP status shown is the status the code is normally emitted with; several
codes can carry different statuses in different call sites (noted). Retry
semantics come from `classifyUpstreamFailure` (the canonical list in §4.5).

### 3.1 Request / policy validation

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `invalid_request` | 400 (also 401/403/404/409/413/422/500 at specific sites) | no | The request is malformed, violates a guard, or carries a bad credential/combination | guards (`body-policy`, `api-key-auth`, `auth-guard`, `drain-endpoint`), surface parsers (`completion.ts`, `messages/encode.ts`, `websearch`, `systemone`, `responses-compact`, `token-count`), console convenience routes (`account-reset`, `export-endpoint`), routing continuation (`router.ts`) |
| `unsupported_media_type` | 415 | no | Payload content-type does not match the endpoint (`body-policy.ts`) | `body-policy.ts` |
| `capability_unsupported` | 400 | yes | The route does not support a requested capability (reasoning fields, token counting, empty input) | `route-model.ts`, `completion.ts`, `token-count.ts`, `preparer.ts`, `responses/errors.ts` |
| `unsupported_field` | — | — | Defined in the union but **never constructed** (reserved) | — |
| `tool_call_loop_detected` | 502 | no | Codex whitespace-loop guard tripped (tool call emitted only whitespace deltas) | `protocol/response/codex.ts` |

### 3.2 Model / routing / naming

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `ambiguous_model` | 400 | no | Bare model name matches more than one provider owner | `route-model.ts` (`ambiguousModelError`) |
| `model_not_found` | 404 | yes | Requested model unresolved, alias target missing | `route-model.ts` (`modelNotFoundError`) |
| `model_not_allowed` | 403 | no | Model diizinkan untuk key ini (allowlist/prefix/denylist) — distinct dari "tidak ada" | `preparer.ts`, admission reasons `model-not-allowed`/`model-denied` |
| `upstream_not_found` | 404 | no | Upstream 404 (route/resource missing upstream) — not a model verdict | `failure-policy.ts` status table |
| `accounts_unavailable` | 503 | yes | Model routed but every serving account is unusable (disabled/locked/no healthy candidate) | `route-model.ts` (`accountsUnavailableError`), `auth-guard.ts` (credential store down) |
| `accounts_rate_limited` | 429 | yes | Every candidate is inside a cooldown window; carries real `retryAfterMs` | `route-model.ts` (`accountsRateLimitedError`), `router.ts` continuation |
| `slug_reserved` | 409 | no | Custom/BYOK provider slug collides with a builtin provider | `provider-contracts.ts` (`parseCustomProviderId`), console provider ops |

### 3.3 Capacity / admission / quota / pools

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `admission_unavailable` | 503 | yes | Request could not be admitted (peer address unknown, counter store unreachable, corrupted counters) | `guard-errors.ts`, `abuse.ts` |
| `route_unavailable` | 503 | yes | No eligible route/prep/adapter/binding for the request (internal routing failure, not admission) | `request-context.ts`, `state.ts`, `proxy-request.ts`, native-route exhausted errors |
| `capacity_exhausted` | 429 | yes | API-key concurrency ceiling (admission `concurrency-limit`) — **not** upstream overload | admission `reasons.ts` |
| `upstream_overloaded` | 529 (503 passthrough) | yes | Upstream overload (529 / capacity identifiers) — distinct from the key-level `capacity_exhausted` | `failure-policy.ts` classification |
| `tenant_capacity_exhausted` | 429 | no | Tenant-wide concurrency ceiling hit (admission `tenant-capacity-exhausted`) | admission `reasons.ts` |
| `provider_capacity_exhausted` | 429 | yes | Every *provider account* in the plan is at its max-inflight — distinct from the key-level `capacity_exhausted` | `route-model.ts` (`capacityExhaustedError`) |
| `quota_exceeded` | 429 (402 passthrough) | yes | Spend/limit verdict: upstream quota, abuse ban | admission `reasons.ts` (spend), `abuse.ts`, `failure-policy.ts` |
| `rate_limited` | 429 | yes | Rate-limit murni (rpm/daily/monthly/lifetime token, abuse window, console throttle) — distinct dari spend quota | admission `reasons.ts`, `abuse.ts`, `console-router-guards.ts` |
| `upstream_queued` | 503 | yes | Upstream accepted the request and queued it (Qoder 403+10605); carries `retryAfterMs` | `failure-policy.ts` (`upstreamQueuedError`) |
| `overloaded` | 503 (529 in telemetry) | **no** (client retries after hint) | Process memory headroom shed (OOM avoidance) | `headroom-guard.ts` |
| `proxy_pool_capacity_exceeded` | 429 | no | Every pool for the provider is at its concurrency limit | `leases.ts` |
| `proxy_pool_provider_capacity_exceeded` | 429 | no | Every pool reached the provider's per-proxy limit | `leases.ts` |
| `proxy_pool_blocked` | 503 | no | Upstream refuses every configured egress (blocked proxies) | `leases.ts` |
| `proxy_pool_cooldown` | 503 | no | Every pool is cooling down after upstream failures; carries `retryAt` | `leases.ts`, `account-test-egress.ts` |
| `proxy_pool_unavailable` | 503 | no | No active pool / coordination unavailable / routing unconfigured | `leases.ts`, `account-quota-tenant.ts` |
| `proxy_pool_unhealthy` | 503 | no | Configured pool cannot be established (WSS mismatch, tunnel bind failure) | `network/pool/resolver.ts`, `leases.ts` |
| `invalid_pool_limits` | 400 | no | Pool limit configuration rejected (console) | console pool contracts/operations |

### 3.4 Authentication / authorization

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `authentication_failed` | 401 | yes | Unknown/revoked/expired/mismatched key; upstream auth rejection (401/403 with auth identifiers) | `api-key-auth.ts`, `export-endpoint.ts`, `boot/app.ts`, `failure-policy.ts` classification |
| `policy_rejected` | 403 | no | Deterministic policy/content rejection (upstream `11140` content-policy, loopback-only endpoints) | `failure-policy.ts` classification, `export-endpoint.ts`, `boot/app.ts` |
| `client_router_denied` | 403 | no | Key's client-router denylist blocks the calling client | `auth-guard.ts` |
| `proxy_auth_required` | 407 | yes | Proxy/upstream demanded proxy authentication | `failure-policy.ts` status table |

### 3.5 Upstream-shaped failures (HTTP status → code)

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `context_length_exceeded` | 413 | yes | Upstream reports prompt/context overflow (identifier set or measured prose overflow) | `failure-policy.ts` (`isContextLengthFailure`) |
| `request_too_large` | 413 | no | 413 from upstream, or body exceeds endpoint byte budget | `failure-policy.ts`, `guard-errors.ts` (`bodyTooLargeError`) |
| `upstream_conflict` | 409 | no | Upstream 409 / `conflict_error` / `already_exists` | `failure-policy.ts` |
| `upstream_unprocessable` | 422 | no | Upstream 422 / `unprocessable_entity*` | `failure-policy.ts` |
| `deadline_exceeded` | 504 | yes | Gateway deadline timer, upstream timeout, first-event timeout, WebSocket receive timeout | `state.ts`, `ssrf.ts`, `empty-stream.ts`, `network/pool/resolver.ts`, `failure-policy.ts` |
| `transport_unavailable` | 502 | mixed | Upstream transport died mid-response, HTML edge page, WebSocket/HTTP2 failures, missing terminal event, socket drop | `failure-policy.ts`, `empty-stream.ts`, `attempt-finalize.ts`, `network/pool/resolver.ts` |
| `platform_unavailable` | 502/503 | yes | Upstream 5xx band (502/503/520/522/524/530...), platform deployment failure, invoke kill-switch, readiness dependencies | `failure-policy.ts` classification, `readiness-guard.ts`, `auth-guard.ts`, `relay-deploy.ts` |
| `transport_closed` | 499 | no (cancel) | "No client left" marker: request cancelled, socket closed, drain abort | `failure-policy.ts` (`sleep`), `attempt-loop.ts`, `attempt-finalize.ts`, `ssrf.ts`, `network/pool/resolver.ts` |
| `tunnel_setup_failed` | — | — | Pool-health telemetry category (tunnel setup failed); not constructed as a client GatewayError | `network/pool-health-machine.ts` |
| `tls_rejected` | — | — | Pool-health telemetry category (TLS rejected); not constructed as a client GatewayError | `network/pool-health-machine.ts` |
| `proxy_unreachable` | — | — | Pool-health fallback category for network-origin failures; used in pool health rows | `network/pool-health-machine.ts` |

### 3.6 Lifecycle / internal

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `internal_error` | 500 | no | Fallback for unknown server-side failures | `error-lifecycle.ts`, console `errorResponse` |
| `not_found` | 404 | no | No endpoint exists at path (catch-all) / console "row not found" fallback | `boot/app.ts`, quota route returns |
| `link_not_found` / `link_expired` / `link_revoked` / `link_disabled` | 404 | no | Share-link resolution refusals (dynamic `link_${refusal}`) | `console/share/share-router.ts` |
| `invalid_sequence` | 500 | no | Malformed canonical sequence number (Responses surface) | `responses/errors.ts` (`ResponsesSequenceError`) |
| `invalid_lifecycle` | 500 | no | Invalid lifecycle transition (Responses surface) | `responses/errors.ts` (`ResponsesLifecycleError`) |
| `shutting_down` | 503 | no | Graceful shutdown drain or update restart (reason `restart_for_update`), requests refused | `shutdown-notice.ts`, `state.ts` |
| `max_connections_exceeded` | — | — | **Boot-time diagnostic** only: plain `Error` with `code` property (not a GatewayError); Postgres pool sizing check | `persistence/boot.ts` |

---

## 4. Upstream classification machinery (`failure-policy.ts`)

This is the single authority that turns an upstream failure into a
`GatewayError`. Two entry points:

- **HTTP failures** — `mapUpstreamHttpError(response, providerId)` and, for
  Claude, `mapClaudeHttpError` (`protocol/messages-errors.ts`).
- **In-stream error frames** — `gatewayErrorFromStreamError` (`protocol/stream-error-frames.ts`), plus `mapClaudeStreamError`.

### 4.1 Status-only table (`statusToGatewayErrorCode`)

| Status | Code |
| --- | --- |
| 401, 403 | `authentication_failed` |
| 402, 429 | `quota_exceeded` |
| 404 | `upstream_not_found` |
| 407 | `proxy_auth_required` |
| 408, 504 | `deadline_exceeded` |
| 409 | `upstream_conflict` |
| 413 | `request_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `upstream_unprocessable` |
| 529 | `upstream_overloaded` |
| 500–599 | `platform_unavailable` |
| other | `invalid_request` |

### 4.2 Structured identifier sets (`classifyUpstreamError`)

Machine-readable `error.code` / `error.type` (and `extError`); matched as
exact identifiers, never prose substrings:

| Set | Members | Result |
| --- | --- | --- |
| Context length | `context_length_exceeded`, `context_too_large`, `model_context_window_exceeded`, `context_too_long`, `4026` (Trae) | `context_length_exceeded` / 413 |
| Quota | `rate_limit_exceeded`, `rate_limit_error`, `insufficient_quota`, `quota_exceeded`, `usage_limit_reached`, `usage_not_included`, `subscription:free-usage-exhausted`, `resource_exhausted`, `110` (Qoder), `rate_limited`, `providers_out_of_quota`, `providers_at_capacity` | `quota_exceeded` / 429 (402/429 passthrough) |
| Auth | `authentication_error`, `invalid_api_key`, `permission_error`, `insufficient_scope`, `unauthenticated`, `permission_denied`, `permissiondenied`, `account_blocked`, `insufficient_key_scope`, `model_not_allowed_for_key` | `authentication_failed` / 401–403, `credentialEvidence: true` |
| Capacity | `overloaded_error`, `capacity_exhausted`, `model_at_capacity`, `server_is_overloaded`, `model_capacity`, `providers_busy`, `providers_overloaded` | `upstream_overloaded` / 529 (503/529 passthrough) |
| Platform | `server_error`, `internal_error`, `internal_server_error`, `api_error`, `service_unavailable`, `service_unavailable_error`, `internal`, `unavailable` | `platform_unavailable` / 502 |
| Policy | `11140` (buddy content-policy) | `policy_rejected` / 403 |
| Policy | `content_rejected` | `policy_rejected` / 403 |
| Model | `model_not_found`, `no_provider` (InferHub) | `model_not_found` / 404 |
| Not found | `not_found_error`, `resource_not_found`, `not_found` | `upstream_not_found` / 404 |
| Conflict | `conflict_error`, `already_exists` | `upstream_conflict` / 409 |
| Too large | `request_too_large`, `payload_too_large` | `request_too_large` / 413 |
| Media type | `unsupported_media_type`, `invalid_content_type` | `unsupported_media_type` / 415 |
| Unprocessable | `unprocessable_entity`, `unprocessable_entity_error` | `upstream_unprocessable` / 422 |
| Timeout | `timeout_error`, `upstream_timeout`, `deadline_exceeded` | `deadline_exceeded` / 504 |
| Invalid request | `invalid_request_error`, `invalid_argument`, `invalid_parameter`, `bad_request` | `invalid_request` / 400 (only when status is not authoritative) |
| Proxy | `proxy_auth_required`, `proxy_authentication_error` | `proxy_auth_required` / 407, origin `network` |

### 4.3 Authoritative statuses

- `401`, `402`, `429` are **authoritative**: a body identifier can never
  demote them (`isAuthoritativeFailureStatus`). A 401 with body type
  `invalid_request_error` still yields `authentication_failed`, not
  `invalid_request`.
- `403` is deliberately **absent** from the authoritative set — it is
  ambiguous and two providers depend on reading it: buddy `11140` (content
  policy, must not be treated as auth) and Google Cloud Code / Antigravity
  entitlement wording (must not disable a healthy account).

### 4.4 Provider-specific code knowledge

| Code | Provider(s) | Meaning |
| --- | --- | --- |
| `11-128` | buddy family | Channel verification refusal. Reused for two unrelated rejections: "conversation id missing" (malformed outbound — **not** account evidence) vs "request illegal"/"failed channel verification" (account-scoped channel verdict). Distinguished by message. |
| `11140` | buddy family | "Request illegal": content-policy or ban. `displayMsg` naming account restriction + `actions` appeal → ban (`policy_blocked_banned`, disabled); otherwise request refusal (`policy_blocked_invalid_request`). |
| `11102` | buddy family | Model not served at all → unsupported-model cooldown (escalating 6h → 24h). |
| `11148`, `11135`, `11133`, `11101`, `12153`, `14017` | buddy family | Request-scoped rejections; never cool the account. |
| `11128` | buddy family | Channel rejection (`unapproved channel`) → policy-block refusal path. |
| `6004` | buddy family | Rate-limit with stated reset stamp; frequency-limit wording → model-scoped `rate_limit_transient`. |
| `110`, `112`, `14018` | Qoder | Billing/quota verdicts (daily count exceeded, pricing URL). `112` keeps the account out of `auth_invalidated`. |
| `10605` | Qoder | Queued (with `isQueued`, `queueCount`, `retryAfterSeconds`) → `upstream_queued`. |
| `499` | Qoder / QoderCN | Closed-stream quota refusal (nginx-style) → `quota_exceeded`, account-scoped. |
| `4026` | Trae | Streaming context overflow. |
| `usage_limit_reached` / `rate_limit_exceeded` | Codex | Friendly "ChatGPT usage limit/rate limit" messages + rate-limit headers in details. |

### 4.5 Retryability (`classifyUpstreamFailure`)

An attempt is **retryable** when any of:

1. It mutates account health (`mutatesAccount` — account-scoped failure, try
   a sibling regardless of status).
2. `error.code` ∈ { `capability_unsupported`, `model_not_found`,
   `admission_unavailable`, `capacity_exhausted`,
   `upstream_overloaded`, `provider_capacity_exhausted`,
   `upstream_queued`,
   `accounts_unavailable`, `accounts_rate_limited`, `quota_exceeded`,
   `authentication_failed`, `proxy_auth_required`,
   `deadline_exceeded`, `context_length_exceeded` }.
3. Status ∈ { 401, 403, 429, 500–599 }.

Never retryable: `overloaded` (client must retry after the hint — a sibling
attempt cannot help), and everything not listed above (e.g. `invalid_request`,
`policy_rejected`, `internal_error`, model/link conflicts).

Provider-code account evidence: `11140` (with ban/channel wording) and
`11-128` (with "request illegal"/"channel verification") mark the failure as
**account-scoped** — that is what lets the health machine cool/disable the
right account.

---

## 5. Telemetry-only categories (never on the wire)

### 5.1 Terminal category (`classifyTerminalCategory`)

One failed attempt terminates as a `GatewayErrorCode` or `unknown_error`:

| Category | HTTP (when no wire status) | Meaning |
| --- | --- | --- |
| `transport_unavailable` | 502 | Upstream transport drop (ECONNRESET/EPIPE/terminated). |
| `platform_unavailable` | 502 | Upstream failure. |
| `deadline_exceeded` | 504 | Our own deadline/stall watchdog. |
| `transport_closed` | 499 | Client cancel / "no client left". |
| `shutting_down` | 503 | Drain. |
| `overloaded` | 529 | Headroom shed. |
| `unknown_error` | 500 | A failure with no abort behind it and no classification. |

`classifyTerminalOutcome` bundles status/category/origin so the three can
never contradict each other (a cancel always carries `transport_closed`).

### 5.2 Account health categories (`AccountErrorCategory`)

| Category | Account verdict | Cooldown |
| --- | --- | --- |
| `quota_exhausted` | cooldown | provider-stated reset, else 1h fallback (Grok: 24h rolling) |
| `rate_limit_transient` | cooldown (model-scoped when frequency-limit) | header/message/body-stated reset, else fallback |
| `model_capacity` | cooldown (model-scoped) | model-capacity constant |
| `model_unreachable` | cooldown | 6h (model unsupported: escalating 6h→24h) |
| `auth_invalidated` | disabled / cooldown (static token → cooldown) | auth-rejected config |
| `policy_blocked` | *deprecated* (kept for old rows) | — |
| `policy_blocked_banned` | **disabled** (immediate) | 0 |
| `policy_blocked_invalid_request` | cooldown | 0 (never mutates) |
| `server_error` | cooldown | 30s–60s transient |
| `timeout` | cooldown | transient |
| `validation_required` | **disabled** (Google account verification, carries `validation_url`) | 0 |
| `unknown` | cooldown | short unclassified fallback (escalating ×2 per consecutive failure, capped) |

![ notes: `escalateFallbackCooldown` doubles fallback windows per consecutive
failure (max 4 levels, capped); provider-**stated** windows are never
multiplied; deadlines only move later (`latestDeadlineMs`).

### 5.3 Pool-health categories

`proxy_unreachable`, `tunnel_setup_failed`, `proxy_auth_required`,
`tls_rejected`, `transport_unavailable`, `deadline_exceeded` are stored as
pool health / last-error categories (network-origin failures default to
`proxy_unreachable`).

---

## 6. Console API error codes (string codes)

`ConsoleDomainError` codes are free-form strings. The complete set currently
in use:

| Code | HTTP | Typical use |
| --- | --- | --- |
| `invalid_request` | 400/401/403/409/422 | Generic validation / body shape / conflicts |
| `unauthorized` | 401 | Missing authentication |
| `insufficient_scope` | 403 | Scope check failed |
| `tenant_required` | 403 | Tenant isolation missing |
| `not_found` | 404 | Fallback "row not found" (quota endpoints) |
| `key_not_found` | 404 | API key rows/share templates |
| `share_not_found` | 404 | Share links |
| `event_not_found` | 404 | Telemetry events/requests |
| `alias_not_found` | 404 | Model aliases |
| `pool_not_found` | 404 | Routing pools |
| `invalid_key` | 400 | Custom key value |
| `invalid_limits` | 400 | Limit values |
| `invalid_key_mode` | 400 | Key mode (personal/share) |
| `invalid_scope` | 400 | Unknown scope |
| `invalid_share_popup` | 400 | Share popup overlong |
| `invalid_level` | 400 | Unknown log level |
| `invalid_limit` | 400 | Query pagination limit |
| `invalid_config` | 400 | Pool config |
| `invalid_pool` | 400 | Pool shape fields |
| `invalid_endpoint` | 400 | Endpoint format |
| `invalid_pool_limits` | 400 | Pool limit validation |
| `ssrf_rejected` | 400 | Private endpoint rejected |
| `payload_too_large` | 413 | Over 5 MB system-prompt payload etc. |
| `self_reference` | 422 | Alias targeting itself |
| `alias_cycle` | 422 | Alias cycle |
| `slug_reserved` | 409 | Reserved provider slug |
| `not_supported` | 400/503 | Feature unavailable (speed tests, probing, relay deploy) |
| `pool_unavailable` | 503 | All pools saturated (domain registration) |
| `capability_unsupported` | 501 | Key share / telemetry not configured |
| `internal_error` | 500 | Fallback |

---

## 7. What to touch when adding or changing a code

1. **Union + class** — `src/protocol/gateway-error.ts` (`GatewayErrorCode`,
   `PUBLIC_ERROR_DETAIL_KEYS` if new details keys should surface).
2. **Retry semantics** — add/remove the code in `classifyUpstreamFailure`
   retryable list (`src/transport/failure-policy.ts`); if it is upstream-
   mapped, also touch `statusToGatewayErrorCode` / `classifyUpstreamError`
   identifier sets.
3. **HTTP status mapping** — `CATEGORY_HTTP_STATUS` when the code is a
   terminal category.
4. **Referenced tests** — the taxonomy is locked by tests; run at minimum
   `test/transport/failure-policy.test.ts`,
   `test/transport/gateway-error-envelope.test.ts`,
   `test/transport/terminal-failure.test.ts`,
   `test/transport/retry-policy.test.ts`,
   `test/providers/account-health-invalidation.test.ts`,
   `test/security/admission.test.ts`, plus any provider-specific
   classification test (`qoder-*`, `antigravity-*`, `trae`).
5. **Keep codes stable** — codes are a public contract; clients branch on
   them. Renaming is a breaking change; prefer adding a new code and
   mapping old ones.

---

## 8. Source map

| Concern | File |
| --- | --- |
| `GatewayErrorCode` union, class, sanitization, public envelope | `src/protocol/gateway-error.ts` |
| Upstream status/identifier classification, retry policy, terminal categories | `src/transport/failure-policy.ts` |
| Claude HTTP/stream error mapping | `src/protocol/messages-errors.ts` |
| OpenAI-family stream error frames | `src/protocol/stream-error-frames.ts` |
| Codex HTTP error mapping | `src/providers/integrations/codex/codex-errors.ts` |
| Account health decision (categories + cooldowns) | `src/providers/operations/account-error-classification.ts` |
| Error normalization middleware (envelope, `retry-after`) | `src/transport/guards/error-lifecycle.ts` |
| Guard error builders | `src/transport/guards/guard-errors.ts` |
| Admission reasons → codes | `src/security/admission/reasons.ts` |
| Console domain errors + handler | `src/console/shared/errors.ts` |
| Shutdown notice codes | `src/transport/shutdown-notice.ts` |
| Pool health categories | `src/network/pool-health-machine.ts` |
| Responses/messages surface error classes | `src/transport/surface/responses/errors.ts`, `src/transport/surface/messages/errors.ts` |
