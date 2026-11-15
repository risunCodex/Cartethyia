# Error classification — from upstream failure to verdict

How Cartethyia classifies an upstream failure into a `GatewayError`: the
status table, the structured identifier sets, what is authoritative, the
provider-specific code knowledge, and the retry policy. The codes themselves —
the wire catalog — live in [errors-catalog.md](errors-catalog.md).

The single authority is `src/protocol/upstream-errors.ts` /
`src/protocol/failure-classify.ts`. Two entry points:

- **HTTP failures** — `mapUpstreamHttpError(response, providerId)` and, for
  Claude, `mapClaudeHttpError` (`protocol/messages-errors.ts`).
- **In-stream error frames** — `gatewayErrorFromStreamError`
  (`protocol/stream-error-frames.ts`), plus `mapClaudeStreamError`.

---

## 1. Status-only table (`statusToGatewayErrorCode`)

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

---

## 2. Structured identifier sets (`classifyUpstreamError`)

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

---

## 3. Authoritative statuses

- `401`, `402`, `429` are **authoritative**: a body identifier can never
  demote them (`isAuthoritativeFailureStatus`). A 401 with body type
  `invalid_request_error` still yields `authentication_failed`, not
  `invalid_request`.
- `403` is deliberately **absent** from the authoritative set — it is
  ambiguous and two providers depend on reading it: buddy `11140` (content
  policy, must not be treated as auth) and Google Cloud Code / Antigravity
  entitlement wording (must not disable a healthy account).

---

## 4. Provider-specific code knowledge

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

---

## 5. Retryability (`classifyUpstreamFailure`)

An attempt is **retryable** when any of:

1. It mutates account health (`mutatesAccount` — account-scoped failure, try
   a sibling regardless of status).
2. `error.code` ∈ { `capability_unsupported`, `model_not_found`,
   `admission_unavailable`, `capacity_exhausted`,
   `upstream_overloaded`, `provider_capacity_exhausted`,
   `upstream_queued`,
   `accounts_unavailable`, `accounts_rate_limited`, `quota_exceeded`,
   `authentication_failed`, `proxy_auth_required`, `route_unavailable`,
   `rate_limited`,
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

## 6. Telemetry-only categories (never on the wire)

### 6.1 Terminal category (`classifyTerminalCategory`)

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

### 6.2 Account health categories (`AccountErrorCategory`)

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

Notes: `escalateFallbackCooldown` doubles fallback windows per consecutive
failure (max 4 levels, capped); provider-**stated** windows are never
multiplied; deadlines only move later (`latestDeadlineMs`).

### 6.3 Pool-health categories

`proxy_unreachable`, `tunnel_setup_failed`, `proxy_auth_required`,
`tls_rejected`, `transport_unavailable`, `deadline_exceeded` are stored as
pool health / last-error categories (network-origin failures default to
`proxy_unreachable`).
