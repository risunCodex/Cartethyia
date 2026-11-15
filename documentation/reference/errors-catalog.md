# Error codes — catalog

Reference for the error vocabulary Cartethyia exposes on the wire and records
in telemetry. This file is the catalog: the vocabularies, the public envelope,
every code with its HTTP status, and the console codes. How an upstream failure
is *classified* into one of these codes — identifier sets, retryability,
provider-specific verdicts — lives in
[errors-classification.md](errors-classification.md).

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
- Upstream → gateway classification: `src/protocol/upstream-errors.ts`
  (status table, identifier sets, HTTP mapping) and
  `src/protocol/failure-classify.ts` (retry policy, terminal categories)
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
500). Console codes are **free-form strings** (see §4) — not members of the
`GatewayErrorCode` union.

---

## 3. `GatewayErrorCode` — complete catalog (54 codes)

HTTP status shown is the status the code is normally emitted with; several
codes can carry different statuses in different call sites (noted). Retry
semantics come from `classifyUpstreamFailure` — the canonical list is in
[errors-classification.md, Retryability](errors-classification.md#5-retryability-classifyupstreamfailure).

### 3.1 Request / policy validation

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `invalid_request` | 400 (also 401/403/404/409/413/422/500 at specific sites) | no | The request is malformed, violates a guard, or carries a bad credential/combination | guards (`body-policy`, `api-key-auth`, `auth-guard`, `drain-endpoint`), surface parsers (`completion.ts`, `messages/encode.ts`, `websearch`, `systemone`, `responses-compact`, `token-count`), console convenience routes (`account-reset`, `export-endpoint`), routing continuation (`routing-engine.ts`) |
| `unsupported_media_type` | 415 | no | Payload content-type does not match the endpoint (`body-policy.ts`) | `body-policy.ts` |
| `capability_unsupported` | 400 | yes | The route does not support a requested capability (reasoning fields, token counting, empty input) | `route-model.ts`, `completion.ts`, `token-count.ts`, `preparer.ts`, `responses/errors.ts` |
| `unsupported_field` | — | — | Defined in the union but **never constructed** (reserved) | — |
| `tool_call_loop_detected` | 502 | no | Codex whitespace-loop guard tripped (tool call emitted only whitespace deltas) | `protocol/response/codex.ts` |

### 3.2 Model / routing / naming

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `ambiguous_model` | 400 | no | Bare model name matches more than one provider owner | `route-model.ts` (`ambiguousModelError`) |
| `model_not_found` | 404 | yes | Requested model unresolved, alias target missing | `route-model.ts` (`modelNotFoundError`) |
| `model_not_allowed` | 403 | no | Model allowed for this key (allowlist/prefix/denylist) — distinct from "not found" | `preparer.ts`, admission reasons `model-not-allowed`/`model-denied` |
| `upstream_not_found` | 404 | no | Upstream 404 (route/resource missing upstream) — not a model verdict | `upstream-errors.ts` status table |
| `accounts_unavailable` | 503 | yes | Model routed but every serving account is unusable (disabled/locked/no healthy candidate) | `route-model.ts` (`accountsUnavailableError`), `auth-guard.ts` (credential store down) |
| `accounts_rate_limited` | 429 | yes | Every candidate is inside a cooldown window; carries real `retryAfterMs` | `route-model.ts` (`accountsRateLimitedError`), `routing-engine.ts` continuation |
| `slug_reserved` | 409 | no | Custom/BYOK provider slug collides with a builtin provider | `provider-contracts.ts` (`parseCustomProviderId`), console provider ops |

### 3.3 Capacity / admission / quota / pools

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `admission_unavailable` | 503 | yes | Request could not be admitted (peer address unknown, counter store unreachable, corrupted counters) | `guard-errors.ts`, `abuse.ts` |
| `route_unavailable` | 503 | yes | No eligible route/prep/adapter/binding for the request (internal routing failure, not admission) | `request-context.ts`, `state.ts`, `proxy-request.ts`, native-route exhausted errors |
| `capacity_exhausted` | 429 | yes | API-key concurrency ceiling (admission `concurrency-limit`) — **not** upstream overload | admission `reasons.ts` |
| `upstream_overloaded` | 529 (503 passthrough) | yes | Upstream overload (529 / capacity identifiers) — distinct from the key-level `capacity_exhausted` | `upstream-errors.ts` classification |
| `tenant_capacity_exhausted` | 429 | no | Tenant-wide concurrency ceiling hit (admission `tenant-capacity-exhausted`) | admission `reasons.ts` |
| `provider_capacity_exhausted` | 429 | yes | Every *provider account* in the plan is at its max-inflight — distinct from the key-level `capacity_exhausted` | `route-model.ts` (`capacityExhaustedError`) |
| `quota_exceeded` | 429 (402 passthrough) | yes | Spend/limit verdict: upstream quota, abuse ban | admission `reasons.ts` (spend), `abuse.ts`, `upstream-errors.ts` |
| `rate_limited` | 429 | yes | Pure rate limiting (rpm/daily/monthly/lifetime token, abuse window, console throttle) — distinct from spend quota | admission `reasons.ts`, `abuse.ts`, `console-router-guards.ts` |
| `upstream_queued` | 503 | yes | Upstream accepted the request and queued it (Qoder 403+10605); carries `retryAfterMs` | `upstream-errors.ts` (`mapUpstreamHttpError`) |
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
| `authentication_failed` | 401 | yes | Unknown/revoked/expired/mismatched key; upstream auth rejection (401/403 with auth identifiers) | `src/security/api-key-auth.ts`, `export-endpoint.ts`, `boot/app.ts`, `upstream-errors.ts` classification |
| `policy_rejected` | 403 | no | Deterministic policy/content rejection (upstream `11140` content-policy, loopback-only endpoints) | `upstream-errors.ts` classification, `export-endpoint.ts`, `boot/app.ts` |
| `client_router_denied` | 403 | no | Key's client-router denylist blocks the calling client | `auth-guard.ts` |
| `proxy_auth_required` | 407 | yes | Proxy/upstream demanded proxy authentication | `upstream-errors.ts` status table |

### 3.5 Upstream-shaped failures (HTTP status → code)

| Code | HTTP | Retryable | Meaning | Produced by |
| --- | --- | --- | --- | --- |
| `context_length_exceeded` | 413 | yes | Upstream reports prompt/context overflow (identifier set or measured prose overflow) | `upstream-errors.ts` (`isContextLengthFailure`) |
| `request_too_large` | 413 | no | 413 from upstream, or body exceeds endpoint byte budget | `upstream-errors.ts`, `guard-errors.ts` (`bodyTooLargeError`) |
| `upstream_conflict` | 409 | no | Upstream 409 / `conflict_error` / `already_exists` | `upstream-errors.ts` |
| `upstream_unprocessable` | 422 | no | Upstream 422 / `unprocessable_entity*` | `upstream-errors.ts` |
| `deadline_exceeded` | 504 | yes | Gateway deadline timer, upstream timeout, first-event timeout, WebSocket receive timeout | `state.ts`, `ssrf.ts`, `empty-stream.ts`, `network/pool/resolver.ts`, `upstream-errors.ts` |
| `transport_unavailable` | 502 | mixed | Upstream transport died mid-response, HTML edge page, WebSocket/HTTP2 failures, missing terminal event, socket drop | `upstream-errors.ts`, `empty-stream.ts`, `attempt-finalize.ts`, `network/pool/resolver.ts` |
| `platform_unavailable` | 502/503 | yes | Upstream 5xx band (502/503/520/522/524/530...), platform deployment failure, invoke kill-switch, readiness dependencies | `upstream-errors.ts` classification, `readiness-guard.ts`, `auth-guard.ts`, `relay-deploy.ts` |
| `transport_closed` | 499 | no (cancel) | "No client left" marker: request cancelled, socket closed, drain abort | `failure-classify.ts` (`sleep`), `attempt-loop.ts`, `attempt-finalize.ts`, `ssrf.ts`, `network/pool/resolver.ts` |
| `tunnel_setup_failed` | — | — | Pool-health telemetry category (tunnel setup failed); not constructed as a client GatewayError | `network/pool/health.ts` |
| `tls_rejected` | — | — | Pool-health telemetry category (TLS rejected); not constructed as a client GatewayError | `network/pool/health.ts` |
| `proxy_unreachable` | — | — | Pool-health fallback category for network-origin failures; used in pool health rows | `network/pool/health.ts` |

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

## 4. Console API error codes (string codes)

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
| `ssrf_rejected` | 400 | Private endpoint rejected |
| `payload_too_large` | 413 | Over 5 MB system-prompt payload etc. |
| `self_reference` | 422 | Alias targeting itself |
| `alias_cycle` | 422 | Alias cycle |
| `slug_reserved` | 409 | Reserved provider slug |
| `not_supported` | 400/503 | Feature unavailable (speed tests, probing, relay deploy) |
| `pool_unavailable` | 503 | All pools saturated (domain registration) |
| `capability_unsupported` | 501 | Key share / telemetry not configured |
| `oauth_not_supported` | 400 | OAuth flow not supported for this provider |
| `browser_code_not_supported` | 400 | Browser-code OAuth flow unsupported |
| `device_code_not_supported` | 400 | Device-code OAuth flow unsupported |
| `import_not_supported` | 400 | Model import not supported for this provider |
| `internal_error` | 500 | Fallback |

---

## 5. Adding or changing a code

1. **Union + class** — `src/protocol/gateway-error.ts` (`GatewayErrorCode`,
   `PUBLIC_ERROR_DETAIL_KEYS` if new details keys should surface).
2. **Retry semantics** — add/remove the code in `classifyUpstreamFailure`
   retryable list (`src/protocol/failure-classify.ts`); if it is upstream-
   mapped, also touch `statusToGatewayErrorCode` / `classifyUpstreamError`
   identifier sets (`src/protocol/upstream-errors.ts`).
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

## 6. Source map

| Concern | File |
| --- | --- |
| `GatewayErrorCode` union, class, sanitization, public envelope | `src/protocol/gateway-error.ts` |
| Upstream status/identifier classification, HTTP mapping | `src/protocol/upstream-errors.ts` |
| Retry policy, terminal categories, `sleep` | `src/protocol/failure-classify.ts` |
| Claude HTTP/stream error mapping | `src/protocol/messages-errors.ts` |
| OpenAI-family stream error frames | `src/protocol/stream-error-frames.ts` |
| Codex HTTP error mapping | `src/providers/integrations/codex/codex-errors.ts` |
| Account health decision (categories + cooldowns) | `src/providers/operations/account-error-classification.ts` |
| Error normalization middleware (envelope, `retry-after`) | `src/transport/guards/error-lifecycle.ts` |
| Guard error builders | `src/transport/guards/guard-errors.ts` |
| Admission reasons → codes | `src/security/admission/reasons.ts` |
| Console domain errors + handler | `src/console/shared/errors.ts` |
| Shutdown notice codes | `src/transport/shutdown-notice.ts` |
| Pool health categories | `src/network/pool/health.ts` |
| Responses/messages surface error classes | `src/transport/surface/responses/errors.ts`, `src/transport/surface/messages/errors.ts` |
