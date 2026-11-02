# Kiro 1.4.62 — wire verification (live probes)

## Adapter audit deltas (2026-11-02, bundle `operator.js` v1.1.641)

The live probes exposed mismatches between the adapter and the bundle's real
request builder. Fixed:

| Found | Adapter before | Bundle/verified | Fix |
| --- | --- | --- | --- |
| `metadata.user_id` fabricated cache key | injected `metadata: {user_id: JSON.stringify({device_id, account_uuid: "", session_id})}` | **0 hits** in bundle; client never sends a `metadata` field on `GenerateAssistantResponse` | removed `withKiroCacheKey` entirely |
| `rootConversationId` | never sent | always sent; defaults to `conversationId` (`rootConversationId: A ?? S`) | added, defaulting to the conversation id |
| `cachePoint` dead interface | `KiroCachePoint` declared but never used | no `cachePoint` / `cache_control` on this wire | removed the dead interface |
| cache reporting | none (relied on imaginary upstream cache fields) | wire never reports hits; only `contextUsageEvent` + `meteringEvent` | added `kiro-cache.ts` session-cache estimator (Trae-style) |

The bundle's `GenerateAssistantResponse` path is `generateViaGar` →
`buildRequestCommand` → `Gfd` (Smithy `KiroRuntimeService`), building
`{conversationState, profileArn, additionalModelRequestFields, agentMode,
systemPrompt}`. `conversationState` carries `conversationId`,
`rootConversationId`, `agentContinuationId`, `agentTaskType` (`spectask` /
`vibe`), `currentMessage`, `history`, `chatTriggerType: "MANUAL"`.

### Usage quota (verified live 2026-11-02)

`GetUsageLimits` is a **GET** with the profile in the query — the 1.4.62
bundle sends `new GetUsageLimitsCommand({origin: "AI_EDITOR", profileArn,
resourceType: "AGENTIC_REQUEST", isEmailRequired: true})`. The adapter previously
omitted `profileArn` from the query (falling back to a fabricated POST surface)
and got `400 Invalid profileArn.` → `management-post: HTTP 400`. Verified live
with a Google account: GET + default social profile ARN → `200` with
`subscriptionInfo.subscriptionTitle: "KIRO FREE"`, `usageBreakdownList`, and
`userInfo.email`. The POST fallback is removed.

### Device flow (verified live 2026-11-02)

AWS SSO OIDC device authorization works against the live service:

- `POST oidc.{region}.amazonaws.com/client/register` → 200 (`clientId`/`clientSecret`).
- `POST oidc.{region}.amazonaws.com/device_authorization` with
  `{clientId, clientSecret, startUrl}` → 200
  (`deviceCode`, `userCode`, `verificationUriComplete`, `interval`, `expiresIn`).
- `POST oidc.{region}.amazonaws.com/token` with
  `{clientId, clientSecret, deviceCode, grantType: "urn:ietf:params:oauth:grant-type:device_code"}`
  → 400 `authorization_pending` before approval (mapped to `pending`).

The adapter now offers both flows: browser (portal social + OIDC PKCE) and
device OIDC. Account rows badge the sign-in family (`Social`/`OIDC`/…) via
`ProviderAccountResponse.authMethod`.



Dated evidence ledger. Revalidate before using these to change current
behavior. Builds pinned: Kiro IDE 1.4.62 (Inno Setup 6.4.0.1, unpacked with
`innoextract 1.13.0` fork), agent extension `kiro.kiro-agent` v1.1.641, CLI
2.37.0. All probes live against the **management** and **runtime** services;
only masked token prefixes are ever printed.

## Wire summary

| Surface | Host | Operation | Method/Path | Service |
| --- | --- | --- | --- | --- |
| Model catalog | `https://management.{region}.kiro.dev` | `ListAvailableModels` | `GET /List-Available-Models` | `KiroControlPlaneBearerService` |
| Usage | same | `GetUsageLimits` | `GET /Get-Usage-Limits` | `KiroControlPlaneBearerService` |
| Profile | same | `GetProfile` | `POST /Get-Profile` | `KiroControlPlaneBearerService` |
| Generation | `https://runtime.{region}.kiro.dev` | `GenerateAssistantResponse` | `POST /generateAssistantResponse` | `KiroRuntimeService` |
| MCP (runtime) | same | `InvokeMCP` / `InvokeMCPStream` | `POST /mcp` / `POST /mcp/stream` | `KiroRuntimeService` |

Both are Smithy `awsJson1_0` (`application/x-amz-json-1.0`) addressed by
`x-amz-target: {service}.{Operation}`. The runtime generation surface answers
with an AWS EventStream (`application/vnd.amazon.eventstream`).

## Probe tools

- `scripts/provider-probing/kiro/probe-kiro.ts` — model list (`--models`) and
  generation (`--model`, `--all`) probes, decoding the EventStream with the
  adapter's own decoder.
- `scripts/provider-probing/kiro/probe-kiro-oauth.ts` — browser PKCE login
  probe for IdC/Builder-ID and social.
- npm scripts: `probe:kiro`, `probe:kiro-oauth`.

## Runtime streaming (verified live 2026-11-02, real Builder-ID account)

`POST runtime.{region}.kiro.dev/generateAssistantResponse` streams AWS EventStream
frames. Observed event types (structured JSON):

| Event | Payload shape | Meaning |
| --- | --- | --- |
| `initial-response` | `{"conversationId":""}` | first frame; empty conversation id |
| `assistantResponseEvent` | `{"content":"…","modelId":"auto"}` | one text delta (can be a token or several tokens) |
| `reasoningContentEvent` | `{"redactedContent":"…"}` | **envelope only, not text**: base64 → `.KTR~~<base64url-JSON>` → `{"encryptionRegion":null,"mintedAtMs":…,"modelHash":"…","slots":[],"v":1}`. Reasoning text is never exposed on the wire |
| `metadataEvent` | `{"stopReason":"END_TURN"}` | terminal stop reason |
| `contextUsageEvent` | `{"contextUsagePercentage":0.413}` | % of the model's context window in use |
| `meteringEvent` | `{"unit":"credit","unitPlural":"credits","usage":0.0155}` | billed credits |
| error/exception | JSON payload | upstream error |

Two chats in one session (same `conversationId`, second chat carries the first
turn in history) both succeed with `END_TURN`.

### Prompt-cache verdict

The runtime EventStream **does not carry cache metrics**: there is no
`metricsEvent` and no `cacheReadInputTokens`/`cacheWriteInputTokens` field in any
observed frame. The bundle confirms cache accounting exists but lives on the
model-provider side: Kiro merges the underlying model's `input_token_details`
(`cache_read` / `cache_creation` — OpenAI/Anthropic usage shape) via
`mergeInputTokenDetails` and reports those to local telemetry histograms
(`ModelClassifierCacheReadInputTokens` etc.). It is never emitted on the wire.

Behavioral probe (repeated ~7k-token prefix, same session vs fresh session):
same-session turn 2 and a fresh-session control with an identical payload billed
**identical credits** (`0.01889` both) and identical `contextUsagePercentage`
(`1.0511%`), while `contextUsagePercentage` stayed flat versus turn 1
(`1.0482%`) despite replaying the full prefix. So Kiro's billed metering does
not discount replayed prefixes, and no cache hit is observable on the wire.
An adapter cannot detect prompt-cache hits from the Kiro runtime stream.

## Verified live (2026-11-02, real Builder-ID account)

| Probe | Result | Meaning |
| --- | --- | --- |
| `management/List-Available-Models` (no profileArn) | `400 {"message":"Invalid profileArn."}` | the surface requires a profileArn; it cannot be omitted |
| `management/List-Available-Models` (default Builder-ID ARN) | `200` + 8 models | default ARN + no TokenType header works |
| `management/Get-Profile` | `400 Invalid profileArn.` | GetProfile also requires a profileArn |
| `management/List-Available-Profiles` | `403 User is not authorized to access this feature.` | Builder-ID cannot list profiles (as the adapter docs state) |
| `runtime/generateAssistantResponse` (valid token) | not invoked | — |
| OAuth browser PKCE (Builder-ID) | exchange + refresh HTTP 200 | full login flow works against `oidc.{region}.amazonaws.com` |
| CLI real hit — `runtime.us-east-1.kiro.dev/generateAssistantResponse` with User-Agent `Kiro-CLI/2.37.0` | `200`, EventStream, text `pong`, stop `END_TURN` | the CLI's chat surface is the SAME runtime service as the IDE, not a separate `app.kiro.dev` KAS ACP endpoint |
| CLI real hit (captured via mitmproxy, 2026-11-02) — actual wire | `POST https://runtime.us-east-1.kiro.dev/` (root path; IDE uses `/generateAssistantResponse`), UA `aws-sdk-rust/1.6.0 … app/AmazonQ-For-CLI` (Rust SDK, not `Kiro-CLI`), `x-amzn-codewhisperer-optout: false` (IDE sends `true`), `x-kiro-attempt: 1;max=3`, `accept: */*` (not eventstream) | the CLI's client is a Rust codegen client; it shares the service/JSON shape with the IDE but differs in path, UA, optout, and a few headers |

### Key findings

1. **Management `ListAvailableModels` requires `profileArn` in the query and
   rejects it when absent** (`400 Invalid profileArn.`).
2. **The family default profile ARN is the one that works**: Builder-ID →
   `arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX`
   (exactly the bundle's `J8a` map and the adapter's `kiro-profile.ts`).
3. **Builder-ID sends NO `TokenType` header.** The `TokenType` header is only
   for `api_key` (`API_KEY`), `external_idp` (`EXTERNAL_IDP`), and `idc`
   (`SSO_OIDC`). Sending `SSO_OIDC` for a Builder-ID session does not fail the
   auth (the 400 was profileArn), but it is not what the client sends.
4. Management requests must NOT carry the runtime-only headers
   (`x-amzn-kiro-agent-mode`, `x-amzn-codewhisperer-optout`).
5. **There is no separate public KAS ACP HTTP endpoint.** Direct HTTP to
   `app.kiro.dev` (bare or `/router/mavis-control-plane`) answers `403 Bearer
   token authentication requires a resolvable operation`; `gamma.app.kiro.dev`
   answers `401` with an Amazon Midway/mwinit corporate-auth page (internal
   build host). The 2.37.0 CLI binary embeds the same AWS SDK codegen clients
   as the IDE — `amzn_codewhisperer_streaming_client`
   (`AmazonCodeWhispererStreamingService.GenerateAssistantResponse`) and
   `amzn_codewhisperer_client` (`AmazonCodeWhispererService.*`) — and
   `mavis-control-plane` is the embedded v3 engine's LOCAL service name (ACP
   over stdio/WebSocket, `_kiro.dev/*` extensions). A CLI chat hit is the same
   `/generateAssistantResponse` runtime surface with the CLI User-Agent,
   verified live (row above).
6. **CLI body is camelCase, not snake_case.** Despite the binary containing
   snake_case struct names (`conversation_state`, `profile_arn`), the captured
   request body is the same camelCase awsJson1_0 shape as the IDE:
   `{conversationState:{conversationId,history,currentMessage,chatTriggerType,
   agentTaskType}, profileArn}`. Delta vs the adapter's builder: the CLI sends
   `profileArn` in the body (no `x-amzn-kiro-profile-arn` header), omits
   `rootConversationId`/`agentContinuationId`, and adds
   `currentMessage.userInputMessage.userInputMessageContext.envState`
   (`operatingSystem`, `currentWorkingDirectory`) plus `tools[]` on the current
   turn. `origin: "AI_EDITOR"` and `modelId` are present on the current
   message, exactly like the adapter.
7. **There is no OpenAI/Messages surface.** The CLI binary has no
   `chat/completions`, `chatcmpl`, `api.openai`, `x-api-key`, or
   `/v1/messages` (Anthropic) strings; `No completions available` is LSP
   completions, and `OpenAI Whisper` is only the voice ASR model download.
   The chat wire is exclusively `conversationState` → AWS EventStream.
8. **Captured GenerateAssistantResponse stream shape (prompt-long run):**
   599 frames: `initial-response` ×1, `assistantResponseEvent` ×594,
   `reasoningContentEvent` ×1, `metadataEvent` ×1, `contextUsageEvent` ×1,
   `meteringEvent` ×1; `stopReason=END_TURN`; `contextUsagePercentage=1.96`;
   metering `usage=0.219` credits. No per-chunk `id`/`object`/`created`/
   `model`/`choices`/`usage` fields — those are OpenAI SSE concepts, absent
   here.

The live model list (Builder-ID, us-east-1): `auto` (1M/64K),
`claude-sonnet-4.5` (200K/64K), `claude-haiku-4.5` (200K/64K),
`deepseek-3.2` (164K/64K), `minimax-m2.5` (196K/64K),
`minimax-m2.1` (196K/64K), `glm-5` (200K/64K),
`qwen3-coder-next` (256K/64K).

## Header shapes (from bundle + probes)

### Management (control plane)
- `authorization: Bearer <token>`
- `content-type: application/x-amz-json-1.0`
- `x-amz-target: KiroControlPlaneBearerService.{Operation}`
- `TokenType: API_KEY | EXTERNAL_IDP | SSO_OIDC` (per auth method; omitted for
  social/Builder-ID)
- `user-agent` / `x-amz-user-agent` with `KiroIDE-{version}-{machineId}`
  marker; `x-kiro-machineid`
- `amz-sdk-request` / `amz-sdk-invocation-id`

### Runtime (generation)
All of the above, plus:
- `x-amzn-kiro-agent-mode` (e.g. `vibe`)
- `x-amzn-codewhisperer-optout: true`
- `x-amzn-kiro-profile-arn` (when a profile is resolved)
- `accept: application/vnd.amazon.eventstream`

## Notable divergences from the legacy adapter

- Device-code flow removed: the 1.4.62 client uses browser authorization-code +
  PKCE with loopback `http://127.0.0.1/oauth/callback` (see
  `probe-kiro-oauth.ts`).
- `RegisterClient` now declares `grantTypes: [authorization_code, refresh_token]`
  and `redirectUris: [http://127.0.0.1/oauth/callback]` with `issuerUrl`.
- SDK pin `@aws/codewhisperer-streaming-client` is `1.0.44` (was `1.0.39`).

See `kiro-wire-protocol.md` (this directory) for the full bundle reconstruction.
