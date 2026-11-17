# Final Proposal: Cartethyia Devin adapter — full implementation flow

- **Date:** 2026-11-07 (updated)
- **Status:** historical research note — retained for reference; not a pending proposal
- **Basis:** audit of 4 donors (oh-my-pi, opencode-devin-provider, devin-proxy, devin2api) + reverse engineering of the Devin desktop bundle
- **Core decision:** **oh-my-pi is the primary source**; opencode/proxy/devin2api = supporting references. The original proto goes into `vendor/`, generated code goes directly into `src/providers/integrations/devin/`. No full 69K/236K-line codegen.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Primary source? | **oh-my-pi** (TS/Bun, smallest + most mature + 12 tests passing) |
| Where do the .proto files go? | The original `.proto` → `vendor/proto/devin/` (existing Qoder pattern) |
| Where does generated code go? | **Directly into `src/providers/integrations/devin/`** (Cursor pattern: `protobufjs` + vendored license header) |
| Generated size? | ±2,678 schema lines (+1,082 codec) — NOT 69K/236K |
| Base URL? | `https://server.codeium.com` (ConnectRPC protobuf) |
| Identity chat? | `devin-cli`/`chisel`/`3000.11.205` |
| Identity discovery? | `chisel`/`0.0.0-dev` + `supportedModelDisplays=[3,4,6,7,8]` |

---

## 1. Architecture decisions (and why)

### 1.1 Why oh-my-pi, not opencode

| Metric | oh-my-pi | opencode | proxy (Py) | devin2api (Go) |
|---|---|---|---|---|
| Proto lines | 2,678 (trimmed) | **69,379** (full codegen) | 236 (manual) | **236,771** (.pb.go) |
| Hand-written lines | 2,008 | 1,158 | 6,250 | ~18,900 |
| Total non-test | **5,798** | 70,537 | 6,486 | ~255,700 |
| Chat streaming | ✅ 893 lines | ✅ 686 | ✅ 551 | ✅ 2,439 |
| Discovery + family collapse | ✅ 548 | ⚠️ shallow (cost 0) | ✅ 634 | ✅ |
| OAuth (2 flows) | ✅ 184 | ⚠️ helpers only | ✅ 632 | ❌ |
| Quota/usage | ✅ 311 | ❌ | ✅ | ⚠️ |
| Error taxonomy | ✅ | ⚠️ boolean | ✅ scoped | ✅⭐ |
| Tests | ✅ 12 files passing | ⚠️ 6 files, **failing** | ✅ script | ✅⭐ golden |
| License | ✅ MIT | ✅ MIT | ❌ no LICENSE | ✅ MIT |
| Stack match | ✅ TS/Bun | ✅ TS/Bun | ❌ | ❌ |

- **opencode** loses because its proto is 69K generated lines and impossible to take half of (everything is interrelated) — whereas oh-my-pi **has already proven** that a 2,678-line subset is enough (`devin-proto.ts` header: *"retains only fields consumed by the client or its protocol tests"*).
- **devin2api** has the most mature engineering (pool/congest/demote/detached/warm + golden wire tests) but Go → TS = architectural reimplementation, not a port. What to absorb: **behavior requirements** (golden fixtures, tool_choice=none, call→result re-pairing, error→HTTP mapping).
- **devin-proxy**'s main value is account/soft/transient error scoping + the OAuth fallback `ExchangePKCEAuthorizationCode` + the identity combo `devin-cli`/`chisel` (chat) vs `windsurf` (discovery).

### 1.2 Why vendor/ + generated code goes into the integration

The pattern already present in Cartethyia:

```
vendor/proto/qoder/chat.proto        ← ORIGINAL .proto (322 lines)
vendor/qoder-umid/…                  ← binary/non-TS artifacts
src/providers/integrations/cursor/protocol/messages.ts   ← generated/vendored code (99K lines) placed in the integration, uses protobufjs + license header
vendor/turing-sdk/…                  ← native SDK
```

So Devin follows the same pattern:

```
vendor/proto/devin/…                 ← original .proto (52 files, 23,276 lines) from oh-my-pi
src/providers/integrations/devin/protocol/devin-proto.ts  ← generated (protobufjs, trimmed ±2,678 lines)
src/providers/integrations/devin/protocol/protobuf.ts     ← codec (can be replaced with protobufjs)
```

**Why generated code (not `.proto`) goes straight into the integration:** the runtime never reads `.proto` — what it consumes is the TS schema. The original `.proto` is kept in `vendor/` as the **source of truth + provenance** (for regeneration, drift auditing, and licensing), exactly the role of `vendor/proto/qoder/chat.proto`. The `proto-parser` output (trimmed `.proto`) is also kept as `devin.proto.trimmed` in vendor for subset documentation.

**Why protobufjs, not oh-my-pi's custom codec:** Cartethyia already has `protobufjs` as a dependency (used by Cursor). oh-my-pi's custom codec (`protobuf.ts`, 1,082 lines) could be used, but it would add two different protobuf implementations to one repo. Decision: **use protobufjs** for the runtime (consistent with Cursor), and define the schema as a `protobuf.js` Root (the `cursor/protocol/messages.ts` pattern). For a minimal diff, porting the custom codec is a backup option — but protobufjs is the primary recommendation.

---

## 2. Target structure

```
src/providers/integrations/devin/
├── protocol/
│   ├── devin-proto.ts        # generated schema (protobufjs Root, trimmed ±2,678 lines)
│   └── framing.ts            # Connect frame encode/decode + gzip + 16MiB cap (from oh-my-pi/opencode)
├── devin-shared.ts           # constants + metadata identity + encodeDevinCredential + UA
├── devin-http.ts             # unary RPC client (application/proto) + gzip-fallback decode
├── devin.ts                  # chat adapter (streamDevin equivalent) — implements ProviderAdapter
├── devin-auth.ts             # login hooks (opencode app.devin.ai + oh-my-pi windsurf + cli)
├── devin-catalog.ts          # discovery (GetCliModelConfigs) + normalization + seed
├── devin-quota.ts            # usage (GetUserStatus) → quota windows
└── devin.test.ts             # fake-transport tests

vendor/proto/devin/
├── exa/api_server_pb/api_server.proto          # + all original .proto files (52 files)
├── exa/codeium_common_pb/codeium_common.proto
├── exa/chat_pb/chat.proto
├── exa/auth_pb/auth.proto
├── exa/seat_management_pb/seat_management.proto
└── README.md                # provenance: source (oh-my-pi commit), MIT license, how to regenerate
```

### Failed.1 Source per file

| Target file | Primary source | Origin |
|---|---|---|
| `protocol/devin-proto.ts` | oh-my-pi `discovery/devin-proto.ts` | trimmed schema (2,678 lines) — converted to protobufjs |
| `protocol/framing.ts` | oh-my-pi/opencode `cascade.ts` | Connect frame + gzip + trailer + 16MiB cap |
| `devin-shared.ts` | oh-my-pi `wire/devin.ts` | constants + identity + encodeDevinCredential |
| `devin-http.ts` | oh-my-pi `wire/devin-proto.ts` + `devin.ts` | unary client + gzip fallback |
| `devin.ts` | oh-my-pi `providers/devin.ts` | streamDevin (893 lines) — re-adapted |
| `devin-auth.ts` | oh-my-pi `oauth/devin-windsurf.ts` + `devin-cli.ts` + opencode `oauth.ts` | 2 OAuth flows + CLI adopt |
| `devin-catalog.ts` | oh-my-pi `discovery/devin.ts` + `providers/devin.kdl` | discovery + seed + cost rules |
| `devin-quota.ts` | oh-my-pi `usage/devin.ts` | GetUserStatus → buckets + windows |

---

## 3. Wire contract (verified across the 4 donors)

### 3.1 Constants

```
BASE_URL        = https://server.codeium.com
SESSION_PREFIX  = devin-session-token$
UA_STRING       = connect-go/1.18.1 (go1.26.3)     // chat only
CHAT_PATH       = /exa.api_server_pb.ApiServerService/GetChatMessage
ASSIGN_PATH     = /exa.api_server_pb.ApiServerService/AssignModel
MODELCFG_PATH   = /exa.api_server_pb.ApiServerService/GetCliModelConfigs
USERJWT_PATH    = /exa.auth_pb.AuthService/GetUserJwt
USERSTATUS_PATH = /exa.seat_management_pb.SeatManagementService/GetUserStatus
EXCHANGE_PATH   = /exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode
```

### 3.2 Transport

**Unary** (auth, AssignModel, discovery, exchange, status): `POST`, `content-type: application/proto`, `connect-protocol-version: 1`, `accept: */*`; body = raw protobuf; the response can be plain protobuf OR gzipped (decode fallback).

**Chat** (GetChatMessage): `POST`, `content-type: application/connect+proto`, `connect-protocol-version: 1`, `accept-encoding: identity`, `connect-accept-encoding: gzip`, `user-agent: connect-go/1.18.1 (go1.26.3)`; body = Connect frame (`[flags 1B][len BE32][payload]`, flag 0x01 gzip, 0x02 end-stream/trailer JSON); the request is compressed when ≥1024B; frame cap 16MiB.

### 3.3 Metadata identity

| Field | Chat | Discovery |
|---|---|---|
| ideName | `devin-cli` | `chisel` |
| ideVersion | `3000.11.205` | `0.0.0-dev` |
| ideType | `chisel` | — |
| extensionName | `chisel` | `chisel` |
| extensionVersion | `3000.11.205` | `0.0.0-dev` |
| locale | `en` | `en` |
| os | darwin/windows/linux | same |
| apiKey | encodeDevinCredential | same |
| userJwt | from GetUserJwt | — |
| sessionId | stable per conversation | — |

`encodeDevinCredential`: trim → already prefixed `devin-session-token$` → as-is → 3-segment JWT (split "." length 3) → prefix → else verbatim (`sk-ws-…` bare). **Cross-donor verification**: oh-my-pi & opencode use this prefix; proxy & devin2api use `Basic <token>-<token>` (a strange marker, not base64) — **we follow oh-my-pi** (token in Metadata.apiKey, not the Basic header).

### 3.4 Important messages (field numbers, from the original proto + cross-donor)

**Metadata** (`exa.codeium_common_pb.Metadata`): ideName=1, extensionVersion=2, apiKey=3, locale=4, os=5, disableTelemetry=6, ideVersion=7, hardware=8, requestId=9, sessionId=10, sourceAddress=11, extensionName=12, userAgent=13, url=14, authSource=15, lsTimestamp=16, extensionPath=17, userId=20, userJwt=21, forceTeamId=22, deviceFingerprint=24, triggerId=25, planName=26, id=27, ideType=28, impersonateTier=29, supportedModelDisplays=30 (repeated enum), f=31, teamId=32.

**GetChatMessageRequest**: metadata=1, prompt=2, chatMessagePrompts=3, useInternalChatModel=5, internalChatModel=6 (deprecated), requestType=7, configuration=8, experimentConfig=9, tools=10, disableParallelToolCalls=11, toolChoice=12, systemPromptCacheOptions=13, chatModelName=14, trajectoryReference=15, cascadeId=16, promptId=17, providerSource=18, language=19, plannerMode=20, chatModelUid=21, executionId=22, arenaConvergeCount=24, arenaAssignmentJwt=25, modelAssignmentJwt=26.

**GetChatMessageResponse**: messageId=1, timestamp=2, deltaText=3, deltaTokens=4, stopReason=5, deltaToolCalls=6, usage=7, redact=8, deltaThinking=9, deltaSignature=10, thinkingRedacted=11, latency=12, completionProfile=13, creditCost=14, outputId=15, thinkingId=16 (deprecated), requestId=17, committedCreditCost=18, prompt=19, deltaSignatureType=21, committedAcuCost=22, actualModelUid=23, arenaInvocationCapReached=24, phase=25, committedQuotaCostBasisPoints=26, committedOverageCostCents=27, responseDimensionGroups=28.

**CompletionConfiguration**: numCompletions=1, maxTokens=2, maxNewlines=3, minLogProbability=4, temperature=5, firstTemperature=6, topK=7, topP=8, stopPatterns=9, seed=10. Quirk: `topP` is `Math.fround()`-ed (float32 widening).

**ChatToolDefinition**: name=1, description=2, jsonSchemaString=3, attributionFieldNames=5, serverName=6, readOnlyHint=7, computerUseConfig=8, isCustomTool=9, customToolGrammar=10, customToolGrammarSyntax=11, strict=12.

**ChatToolCall** (response): id=1, name=2, argumentsJson=3, invalidJsonStr=4, invalidJsonErr=5, isCustomToolCall=6. Args arrive cumulative → a delta from the previous prefix; parsed at `toolcall_end`.

**ChatMessagePrompt** (history): messageId=1, source=2 (USER=1/SYSTEM=2/UNKNOWN=3/TOOL=4/SYSTEM_PROMPT=5), prompt=3, numTokens=4, safeForCodeTelemetry=5, toolCalls=6, toolCallId=7, promptCacheOptions=8, toolResultIsError=9, images=10, thinking=11, signature=12, thinkingRedacted=13, promptAnnotationRanges=14, outputId=15, thinkingId=16, geminiThoughtSignature=17, signatureType=18, phase=19.

**AssignModelRequest**: metadata=1, modelRouterUid=2, cascadeId=3, chatMessagePrompt=5. **AssignModelResponse**: assignment=1 (ModelAssignment: assignmentJwt=1, modelUid=2, harnessUids=3).

**GetUserJwtRequest**: metadata=1. **Response**: userJwt=1, customApiServerUrl=2 (overrides the chat base URL).

**GetCliModelConfigsRequest**: metadata=1. **Response**: clientModelConfigs=1, defaultOverrideModelConfig=3 (DefaultOverrideModelConfig: modelUid=3).

**ClientModelConfig**: label=1, modelOrAlias=2, creditMultiplier=3, disabled=4, supportsImages=5, supportsLegacy=6, isPremium=7, betaWarningMessage=8, isBeta=9, provider=10, isRecommended=11, allowedTiers=12, pricingType=13, apiProvider=14, isNew=15, partialRollout=16, rolloutFraction=17, maxTokens=18, promoStatus=19, isCapacityLimited=20, fastStatus=21, modelUid=22, modelInfo=23, modelCostTier=24, description=27, smartFriendModelUid=29, modelFamilyMetadata=30, isDefaultModelInFamily=31, modelDimensions=32, disabledReason=33.

**ModelInfo**: modelId=1, isInternal=2, modelType=3, maxTokens=4, tokenizerType=5, modelFeatures=6, apiProvider=7, modelName=8, supportsContext=9, embedDim=10, baseUrl=11, chatModelName=12, maxOutputTokens=13, promptTemplaterType=14, toolFormatterType=15, inferenceServerUrl=18, harnessUids=20, arenaConfig=21, displayOption=22, modelFamilyUid=23, inferenceConfig=24, isModelRouter=25.

**ModelFeatures**: supportsImages=11, supportsToolCalls=12, supportsThinking=15, supportsParallelToolCalls=21.

**ModelDimension**: label=1, value=2, denominator=3, minRange=4, maxRange=5, kind=6 (UNSPECIFIED=0/COST=1/COST_FUZZY=2), info=7. **ModelFamilyMetadata**: modelFamilyLabel=1, entries=2, isDefaultModelInFamily=3; entry key=1/value=2; value order=1/name=2.

**ExchangePKCEAuthorizationCodeRequest**: authorizationCode=1, codeVerifier=2. **Response**: apiKey=1 (prefix `gsk-ws-…` → strip `gsk-`), name=2, apiServerUrl=3, devinWebappHost=4, devinApiUrl=5.

**GetUserStatusRequest**: metadata=1. **Response**: userStatus=1, planInfo=2.
**UserStatus**: teamId=5, email=7, teamsTier=10, planStatus=13, userId=36.
**PlanInfo**: teamsTier=1, planName=2, monthlyPromptCredits=12, monthlyFlowCredits=13, monthlyFlexCreditPurchaseAmount=14, devinInfo=33 (canUseCascade=1, canUseCli=2, orgId=4, webappHost=5, apiUrl=7, accountDisplayName=8), isDevin=34, billingStrategy=35 (CREDITS=1/QUOTA=2/ACU=3), hideDailyQuota=36, hideWeeklyQuota=37.
**PlanStatus**: planInfo=1, planStart=2, planEnd=3, availableFlexCredits=4, usedFlowCredits=5, usedPromptCredits=6, usedFlexCredits=7, availablePromptCredits=8, availableFlowCredits=9, topUpStatus=10, overageBalanceMicros=16, dailyQuotaRemainingPercent=14, weeklyQuotaRemainingPercent=15, dailyQuotaResetAtUnix=17, weeklyQuotaResetAtUnix=18.
**TeamsTier**: DEVIN_PRO=16, DEVIN_MAX=17, DEVIN_FREE=19, DEVIN_TRIAL=20.

### 3.5 Chat flow

1. `GetUserJwt(metadata w/ apiKey)` → `userJwt` + optional `customApiServerUrl`.
2. If the model is a router (`compat.modelRouter`): `AssignModel(metadata, modelRouterUid, cascadeId)` → `assignmentJwt` + `modelUid`; **share `cascadeId`** with the chat.
3. `GetChatMessage(metadata w/ apiKey+userJwt, chatModelUid = assignment.modelUid ?? chatModelUid ?? requestModelId ?? id, prompt = flattened system prompt, chatMessagePrompts, requestType=CASCADE(5), plannerMode=DEFAULT(1), systemPromptCacheOptions=EPHEMERAL, configuration, tools, cascadeId, executionId=randomUUID())`.
4. Decode frames until the `0x02` trailer. Map `deltaText`→text, `deltaThinking`/`deltaSignature`→thinking, `deltaToolCalls`→tool blocks, `stopReason` (MAX_TOKENS→`length`, tools pending→`toolUse`, else `stop`), `usage`→tokens, `creditCost`/`committedCreditCost`/`committedAcuCost`→credits.
5. Non-2xx → `DevinApiError` (status+headers); trailer error envelope → classification; `invalid_argument` + `internal error` + no output yet + history ≥512KiB → ContextOverflow.

Behavior taken from devin2api (required):
- **call→result re-pairing** — the client history (all calls then all results) is interleaved into pairs on the wire.
- **tool_choice=none** → tools do not enter the wire at all (not merely emptied).
- **images only on the last turn**; documents/videos may be in history.
- **stop sequences handled locally** (the upstream does not honor them) — cut the text + keep `maxPatternLen-1` bytes in anticipation.
- **signature replay** — the thinking client needs the correct `signature` + `signatureType`; wrong type → upstream invalid_argument.
- **error mapping** — Cartethyia's `classifyUpstreamError` + `mapUpstreamHttpError` handle the statuses: `unauthenticated`→401, `resource_exhausted`→429, `invalid_argument`/`failed_precondition`/`permission_denied`→400 (not 403), transport break→502, timeout→504, context length→413.

---

## 4. Implementation per file

### 4.1 `protocol/devin-proto.ts` (generated, ±2,678 lines)

- Ported from oh-my-pi `discovery/devin-proto.ts` (MIT, provenance header preserved).
- Converted from the custom IR codec → a `protobufjs` Root (the `cursor/protocol/messages.ts` pattern): `addType(root, "Metadata", [...])` etc.
- Only the consumed messages: Metadata, GetChatMessageRequest/Response, ChatMessagePrompt, ChatToolDefinition/Choice/Call, CompletionConfiguration, AssignModelRequest/Response, GetUserJwtRequest/Response, GetCliModelConfigsRequest/Response, ClientModelConfig, ModelInfo, ModelFeatures, ModelDimension, ModelFamilyMetadata, ExchangePKCEAuthorizationCodeRequest/Response, GetUserStatusRequest/Response, UserStatus, PlanInfo, PlanStatus, TeamsTier, enum DisplayOption/StopReason/ChatMessageSource/BillingStrategy/ModelDimensionKind.
- Keep the original `.proto` files (52) in `vendor/proto/devin/` as the source of truth + regeneration.

### 4.2 `protocol/framing.ts` (Connect framing)

- From oh-my-pi/opencode `cascade.ts`:
  - `encodeConnectFrame(payload, {compress})` → gzip when ≥1024B, `[flags=0x01][len BE32][payload]`.
  - `decodeConnectFrame` / `ConnectFrameDecoder` — read the 5-byte header, validate length ≤ 16MiB (`MAX_CONNECT_FRAME_PAYLOAD`), decompress flag 0x01, read the trailer JSON flag 0x02.
  - `readConnectTrailerError` — parse `{error:{code,message}}` → `GatewayError`.
- Structural pattern: `cursor/protocol/framing.ts` (already in the repo).

### 4.3 `devin-shared.ts` (constants)

```
DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com"
DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$"
DIIN_CLI_METADATA = { ideName: "devin-cli", ideType: "chisel", ideVersion: "3000.11.205", extensionName: "chisel", extensionVersion: "3000.11.205", locale: "en", os }
DEVIN_DISCOVERY_METADATA = { ideName: "chisel", ideVersion: "0.0.0-dev", extensionName: "chisel", extensionVersion: "0.0.0-dev", locale: "en", os }
DEVIN_SUPPORTED_MODEL_DISPLAYS = [3, 4, 6, 7, 8]   // MODEL_ROUTER, QUICK_REVIEW, INTERNAL_DEFAULT, UNCLASSIFIED, NORMAL
encodeDevinCredential(apiKey)
```

### 4.4 `devin-http.ts` (unary client)

- `callDevinUnary(path, schema, request, {apiKey, baseUrl, signal, timeoutMs})`.
- Headers: `content-type: application/proto`, `connect-protocol-version: 1`, `accept: */*`.
- Response decode: try `fromBinary` directly, fall back to `gunzipSync` (`decodeDevinUnaryMessage`).
- Combine the signal with `AbortSignal.timeout(15_000)` for discovery (the server often needs 7-15s).

### 4.5 `devin.ts` (chat adapter)

- Implement `ProviderAdapter` (the `src/providers/provider-contracts.ts` contract), **not** `BaseProviderAdapter` (binary payload + streaming framing).
- Flow: `GetUserJwt` → (router?) `AssignModel` → build request → frame → POST → stream decode → canonical events.
- Tool handling: cumulative args accumulation, parse at `toolcall_end`, id sanitize/cap 40, `normalizeSchemaForGoogle` for gemini class.
- Error: `GatewayError` mapping per §3.5; `createUpstreamDeadlineLifecycle` is used.
- Quirks: `Math.fround(topP)`, cascadeId threading, executionId UUID, system prompt flattening.

### 4.6 `devin-auth.ts` (OAuth)

- **Flow 1 — opencode/app.devin.ai** (primary): authorize `https://app.devin.ai/auth/cli/continue` (PKCE S256, state UUID, prompt select_account), callback port 59653, exchange `POST https://api.devin.ai/auth/cli/token` body JSON `{code, code_verifier}` → `{token}`; expires JWT −5m with a 365d fallback.
- **Flow 2 — oh-my-pi/windsurf** (enterprise seat): `https://windsurf.com/editor/signin` (PKCE, port 59654) → `ExchangePKCEAuthorizationCode` → apiKey (strip `gsk-`); stored as `devin`.
- **Flow 3 — CLI adopt**: `%APPDATA%/devin/credentials.toml` → `~/.local/share/devin/credentials.toml` → (macOS) Library; parse `windsurf_api_key`; reject an `api_server_url` outside `KNOWN_API_HOSTS = ["server.codeium.com","server.enterprise.windsurf.com"]`; no network.
- Store: everything is saved as a `devin` credential (api_key row) via `storeLoginApiKey`/`upsertAuthCredential`.
- No refresh (expires ∞ for seat keys; JWT 1 year).

### 4.7 `devin-catalog.ts` (discovery + seed)

- `loadModelDiscovery`: `GetCliModelConfigs` with identity discovery + `supportedModelDisplays`; timeout 15s; empty-200 or all-disabled → null (stale pin).
- Client-side filter of `QUICK_REVIEW(4)`/`INTERNAL_DEFAULT(6)`; keep `MODEL_ROUTER(3)`/`UNCLASSIFIED(7)`/`NORMAL(8)`.
- Normalization → `defineModel`: id=modelUid, contextWindow=modelInfo.maxTokens (fallback 200k), maxTokens=modelInfo.maxOutputTokens (fallback 64k), cost from `modelDimensions` (COST/COST_FUZZY, stop label `sidekick`, denominator k/m/b), reasoning from ModelFeatures.supportsThinking (authoritative) + a label heuristic, tools from supportsToolCalls, images gated unless in `DEVIN_IMAGE_BLIND_UIDS = {swe-1-6-fast, swe-1-6-slow}`.
- Router slots (`MODEL_ROUTER` without harnessUids) → `compat.modelRouter: true`; harness composites (`fusion`, `fusion-*-sidekick-*`) keep the chat uid + lead-model merging.
- Seed (boot, synchronous): `swe-1-6-fast` + `swe-1-6-slow` + `swe-2-flash-medium` (from the live `GetCliModelConfigs`); discovery replaces them; the account default (`defaultOverrideModelConfig`) wins. `swe-1-6` was removed from the seed — it is not in the live roster and chat fails with `failed_precondition`.
- Cost rules (ported KDL from oh-my-pi): cost-fallback (SWE-2 promo → list 2027-01-01; SWE-1.7; GLM-5.2), cache-write-rate (anthropic 1.25, gpt ≥5.6 <7 1.25, adaptive 1.0), long-context tiers (gpt-6 272k ×2.0 in/1.5 out; gemini-pro ≥3.1<4 & grok 200k ×2.0 in/1.5 out).

### 4.8 `devin-quota.ts` (usage)

- `loadQuotaCollector`: `GetUserStatus(metadata)` → 3 credit buckets (prompt/flow/flex; limits from `PlanInfo.monthly*`, used/available from `PlanStatus.*`; unit `unknown`; zero-triple skipped) + daily/weekly quota windows (percent; hidden ones or resetAtUnix=0 when non-QUOTA are skipped) + the monthly plan window + `overageBalanceUsd = overageBalanceMicros / 1e6`.
- Always returns a non-fatal null on failure.

### 4.9 Registry wiring (`src/providers/default-registry.ts`)

```ts
devin: {
  endpointPathsByWireFamily: { chat: "/exa.api_server_pb.ApiServerService/GetChatMessage" },
  loadAdapter: async () => (await import("./integrations/devin/devin")).devinAdapter,
  loadModels: async () => (await import("./integrations/devin/devin-catalog")).DEVIN_MODELS,
  loadAuthentication: ... // devin-auth hooks (app.devin.ai + windsurf + cli)
  loadQuotaCollector: quotaCapability(() => import("./integrations/devin/devin-quota"), "fetchDevinQuota"),
  loadModelDiscovery: ... discoverDevinModels({ credential, fetcher }),
}
```

Plus: provider metadata/capabilities (`provider-metadata.ts`), env `DEVIN_API_KEY`, dashboard provider row.

---

## 5. Implementation phases

| Phase | Contents | Output |
|---|---|---|
| **1 — Vendor + generated** | Copy .proto → `vendor/proto/devin/`; port `devin-proto.ts` (protobufjs) + `framing.ts` | Schema + framing ready |
| **2 — Unary client** | `devin-http.ts` + `devin-shared.ts` + fake transport test | Auth/discovery/exchange callable |
| **3 — Chat adapter** | `devin.ts` + encoder/decoder behavior (re-pairing, tool_choice=none, stop scan) + frame stream test | Chat streaming live |
| **4 — Discovery** | `devin-catalog.ts` + seed + cost rules + fixture response test | Model list + seed |
| **5 — Auth** | `devin-auth.ts` 3 flows + mock exchange test | Devin/Windsurf/CLI login |
| **6 — Quota** | `devin-quota.ts` + fixture test | Usage/limits |
| **7 — Registry + e2e** | Wiring + env + dashboard row; live verification with a seat key | Complete provider |

---

## 6. Test plan

- **Unit (fake transport)**: identity request (chisel/dev, display options, credential encoding, JWT prefix); gzip fallback decode; frame cap 32MiB rejected without buffering; trailer error envelope; stopReason mapping; cumulative tool args; large-history ContextOverflow (≥512KiB); discovery empty-200→null, all-disabled→null, timeout 15s; router/harness; cost dims; family aliases (`claude`→`claude-sonnet-5`, `codex`→`gpt-5-3-codex`, …); quota bucket math + window gating.
- **Golden (from devin2api)**: port the 6 `wire_golden_test.go` fixtures → TS tests — byte-exact request encoder (tools, tool_choice=none, thinking replay, sampling, image last turn).
- **Live (phase 7)**: needs a real seat key (`sk-ws-…`/JWT). Our auth1 token has been proven to be rejected.

---

## 7. Risks & open questions

1. **Live catalog unverified** — needs a real seat key. Until then, the adapter ships with the SWE-1.6 seed + fixture-tested discovery logic.
2. **Identity drift** — the three donors use three different tuples (all claiming to be "correct"). We follow oh-my-pi (`devin-cli`/`chisel`/`3000.11.205` chat, `chisel`/`0.0.0-dev` discovery) because it is the most proven across 2 independent repos. Live verification in phase 7: compare catalog results against the opencode identity (`windsurf/3.2.23/1.48.2`).
3. **Proto drift** — a trimmed schema can miss new fields; mitigation: a `noteSchemaDrift`-style warning on unknown fields (the devin2api pattern), regeneration from the vendor .proto.
4. **OAuth page drift** — `windsurf.com/editor/signin` and `app.devin.ai/auth/cli/continue` can change; the loopback exchange must be resilient + produce clear errors.
5. **AI Gateway** (`server.codeium.com/api/v1`, `AI_GATEWAY_API_KEY`) — a separate surface, out of scope.
6. **Credential sensitivity** — do not log raw keys; reuse Cartethyia's redaction.

---

## 8. References

- Primary donor: `Public/oh-my-pi` (packages/ai/src/providers/devin.ts, registry/oauth/devin{,-windsurf,-cli}.ts, usage/devin.ts, catalog/src/{wire,discovery}/devin{,-proto}.ts, catalog/src/compat/rules/{providers/devin.kdl,auth/devin*.kdl,taxonomy/_collapse.kdl}, catalog/test/devin-discovery.test.ts, ai/test/devin-*.test.ts)
- Supporting references: `Public/opencode-devin-provider` (cascade.ts, oauth.ts, devin-gen/), `Public/devin-proxy` (proto.py, upstream.py, accounts.py, models.py), `Public/devin2api` (internal/adapter/devin/{request_encoder,response_decoder,failure}.go, wire_golden_test.go)
- Cartethyia patterns: `src/providers/integrations/cursor/` (protobufjs + Connect framing), `src/providers/default-registry.ts` (registry), `vendor/proto/qoder/` (vendor .proto)
- Previous audits: `documentation/research/devin/2026-11-06-devin-desktop-audit.md`, `2026-11-07-oh-my-pi-devin-adapter-proposal.md`
- Skill recipe: `.skills/cartethyia-reverse-engineering/references/unpacking-and-wire-capture.md`
