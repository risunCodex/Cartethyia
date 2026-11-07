# Proposal: Cartethyia Devin adapter (from oh-my-pi donor audit)

- **Date:** 2026-11-07
- **Status:** proposal — uncommitted, awaiting Rover review
- **Source of truth:** full audit of `Public/oh-my-pi` Devin/Windsurf references (4 subagents, all files read verbatim) + earlier static/live reverse engineering of the Devin desktop bundle
- **Scope:** newest unified Devin (Codeium Cascade), not legacy Windsurf-branded flows beyond what the donor still uses

---

## 0. TL;DR

Devin's real API is ConnectRPC over protobuf at **`https://server.codeium.com`** — not the JSON REST `api.devin.ai` host (which only mints webapp session tokens). The donor (`oh-my-pi`) contains a complete, working client: chat streaming, model discovery (600+ configs), OAuth seat-key login, and usage/quota. Cartethyia already ships a very similar transport for Cursor (protobufjs + Connect framing + typed errors), so the Devin adapter can follow the same integration pattern.

Implementation is a **new `src/providers/integrations/devin/` folder** wired through `default-registry.ts`, with a ported protobuf codec (MIT donor), a chat adapter over Connect framing, discovery→catalog, an OAuth login flow, and quota collection.

**Only gate:** live model-catalog verification needs a real seat key (`sk-ws-…` or JWT session token). Our `auth1_…` webapp token is not accepted as an API key (proven: every RPC returns `401 {"detail":"invalid api key"}`).

---

## 1. What is proven (evidence status)

| Claim | Evidence |
|---|---|
| Base host is `server.codeium.com`; API is ConnectRPC protobuf | donor `wire/devin.ts:9`; live probe: `POST /exa.api_server_pb.ApiServerService/GetCliModelConfigs` → server replies (not 404) |
| Connect protocol + content-type `application/proto` accepted | live probe with donor codec: 131-byte body → `401 {"code":"unauthenticated","message":"invalid api key"}` (i.e. request parsed fine; credential rejected) |
| `auth1_…` webapp token is **not** an API key | live probes: `GetCliModelConfigs`, `GetUserJwt`, `/api/v1/models` all 401; `ExchangePKCEAuthorizationCode` with consumed Google code → 401 internal error |
| Chat identity tuple `devin-cli`/`chisel`/`3000.11.205` unlocks router assignment + CLI model surface | donor comment `wire/devin.ts:17-21`; tests |
| Discovery identity `chisel`/`0.0.0-dev` + `supportedModelDisplays=[3,4,6,7,8]` unlocks full native catalog | donor `discovery/devin.ts` + tests (`devin-discovery.test.ts:453-468`) |
| JWT 3-segment creds get `devin-session-token$` prefix; `sk-ws-` sent verbatim | donor `encodeDevinCredential` (`wire/devin.ts:47-52`) + tests |
| Windsurf editor login (`windsurf.com/editor/signin`, loopback 59654) → `ExchangePKCEAuthorizationCode` → API key; `gsk-ws-…` stripped to `sk-ws-…` | donor `devin-windsurf.ts` + tests |

Everything else in this proposal is from the donor source + tests (marked *donor* below), read verbatim but not yet re-proven against the live server.

---

## 2. Wire contract (from audit)

### 2.1 Constants

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

### 2.2 Transport

**Unary RPCs** (auth, AssignModel, discovery, exchange, user status): `POST`, headers:

```
content-type: application/proto
connect-protocol-version: 1
accept: */*
```

Body = **raw unframed protobuf**. Response may be raw protobuf **or gzipped protobuf** — decode with gzip fallback (`decodeDevinUnaryMessage`).

**Chat RPC** (GetChatMessage): `POST`, headers:

```
content-type: application/connect+proto
connect-protocol-version: 1
accept-encoding: identity
connect-accept-encoding: gzip
user-agent: connect-go/1.18.1 (go1.26.3)
# + optional connect-content-encoding: gzip when body compressed
```

Body = **Connect frame**: `1 byte flags + 4-byte BE length + payload`. Flags: `0x01` compressed (gzip), `0x02` end-of-stream (trailer JSON). Request compressed when ≥1024 B. Response is a stream of frames; `0x02` trailer carries error envelope `{error:{code,message}}` or end marker. Frame payload cap: **16 MiB**.

### 2.3 Metadata identity

| Field | Chat | Discovery |
|---|---|---|
| ideName | `devin-cli` | `chisel` |
| ideVersion | `3000.11.205` | `0.0.0-dev` |
| ideType | `chisel` | — |
| extensionName | `chisel` | `chisel` |
| extensionVersion | `3000.11.205` | `0.0.0-dev` |
| locale | `en` | `en` |
| os | darwin/windows/linux | same |

`os` from platform: `darwin`→`darwin`, `win32`→`windows`, else `linux`.

Credential encoding (`encodeDevinCredential`): trim → if already prefixed `devin-session-token$`, as-is → if `split(".").length === 3` (JWT), prefix → else verbatim (`sk-ws-…` stays bare).

### 2.4 Messages (field numbers)

**Metadata** (`exa.codeium_common_pb.Metadata`): ideName=1, extensionVersion=2, apiKey=3, locale=4, os=5, disableTelemetry=6, ideVersion=7, hardware=8, requestId=9, sessionId=10, sourceAddress=11, extensionName=12, userAgent=13, url=14, authSource=15, lsTimestamp=16, extensionPath=17, userId=20, userJwt=21, forceTeamId=22, deviceFingerprint=24, triggerId=25, planName=26, id=27, ideType=28, impersonateTier=29, supportedModelDisplays=30 (repeated enum), f=31, teamId=32.

**GetChatMessageRequest**: metadata=1, prompt=2, chatMessagePrompts=3, useInternalChatModel=5, internalChatModel=6 (deprecated), requestType=7, configuration=8, experimentConfig=9, tools=10, disableParallelToolCalls=11, toolChoice=12, systemPromptCacheOptions=13, chatModelName=14, trajectoryReference=15, cascadeId=16, promptId=17, providerSource=18, language=19, plannerMode=20, chatModelUid=21, executionId=22, arenaConvergeCount=24, arenaAssignmentJwt=25, modelAssignmentJwt=26.

**GetChatMessageResponse**: messageId=1, timestamp=2, deltaText=3, deltaTokens=4, stopReason=5, deltaToolCalls=6, usage=7, redact=8, deltaThinking=9, deltaSignature=10, thinkingRedacted=11, latency=12, completionProfile=13, creditCost=14, outputId=15, thinkingId=16 (deprecated), requestId=17, committedCreditCost=18, prompt=19, deltaSignatureType=21, committedAcuCost=22, actualModelUid=23, arenaInvocationCapReached=24, phase=25, committedQuotaCostBasisPoints=26, committedOverageCostCents=27, responseDimensionGroups=28.

**CompletionConfiguration**: numCompletions=1, maxTokens=2, maxNewlines=3, minLogProbability=4, temperature=5, firstTemperature=6, topK=7, topP=8, stopPatterns=9, seed=10, … `topP` is **`Math.fround()`-rounded** (float32 widening quirk).

**ChatToolDefinition**: name=1, description=2, jsonSchemaString=3, attributionFieldNames=5, serverName=6, readOnlyHint=7, computerUseConfig=8, isCustomTool=9, customToolGrammar=10, customToolGrammarSyntax=11, strict=12.

**ChatToolCall** (response): id=1, name=2, argumentsJson=3, invalidJsonStr=4, invalidJsonErr=5, isCustomToolCall=6. Arguments arrive cumulative → take delta from previous prefix; parse on `toolcall_end`.

**ChatMessagePrompt** (history): messageId=1, source=2, prompt=3, numTokens=4, safeForCodeTelemetry=5, toolCalls=6, toolCallId=7, promptCacheOptions=8, toolResultIsError=9, images=10, thinking=11, signature=12, thinkingRedacted=13, promptAnnotationRanges=14, outputId=15, thinkingId=16, geminiThoughtSignature=17, signatureType=18, phase=19. `ChatMessageSource`: USER=1, SYSTEM=2, UNKNOWN=3, TOOL=4, SYSTEM_PROMPT=5.

**AssignModelRequest**: metadata=1, modelRouterUid=2, cascadeId=3, chatMessagePrompt=5. **AssignModelResponse**: assignment=1 (ModelAssignment: assignmentJwt=1, modelUid=2, harnessUids=3).

**GetUserJwtRequest**: metadata=1. **Response**: userJwt=1, customApiServerUrl=2 (overrides base URL for chat if present).

**GetCliModelConfigsRequest**: metadata=1. **Response**: clientModelConfigs=1, defaultOverrideModelConfig=3 (DefaultOverrideModelConfig: modelUid=3).

**ClientModelConfig**: label=1, modelOrAlias=2, creditMultiplier=3, disabled=4, supportsImages=5, supportsLegacy=6, isPremium=7, betaWarningMessage=8, isBeta=9, provider=10, isRecommended=11, allowedTiers=12, pricingType=13, apiProvider=14, isNew=15, partialRollout=16, rolloutFraction=17, maxTokens=18, promoStatus=19, isCapacityLimited=20, fastStatus=21, modelUid=22, modelInfo=23, modelCostTier=24, description=27, smartFriendModelUid=29, modelFamilyMetadata=30, isDefaultModelInFamily=31, modelDimensions=32, disabledReason=33.

**ModelInfo**: modelId=1, isInternal=2, modelType=3, maxTokens=4, tokenizerType=5, modelFeatures=6, apiProvider=7, modelName=8, supportsContext=9, embedDim=10, baseUrl=11, chatModelName=12, maxOutputTokens=13, promptTemplaterType=14, toolFormatterType=15, inferenceServerUrl=18, harnessUids=20, arenaConfig=21, displayOption=22, modelFamilyUid=23, inferenceConfig=24, isModelRouter=25.

**ModelFeatures**: supportsImages=11, supportsToolCalls=12, supportsThinking=15, supportsParallelToolCalls=21.

**ModelDimension**: label=1, value=2, denominator=3, minRange=4, maxRange=5, kind=6 (UNSPECIFIED=0/COST=1/COST_FUZZY=2), info=7. **ModelFamilyMetadata**: modelFamilyLabel=1, entries=2, isDefaultModelInFamily=3; entry key=1/value=2; value order=1/name=2.

**ExchangePKCEAuthorizationCodeRequest**: authorizationCode=1, codeVerifier=2. **Response**: apiKey=1, name=2, apiServerUrl=3, devinWebappHost=4, devinApiUrl=5.

**GetUserStatusRequest**: metadata=1. **Response**: userStatus=1, planInfo=2.
**UserStatus**: teamId=5, email=7, teamsTier=10, planStatus=13, userId=36.
**PlanInfo**: teamsTier=1, planName=2, monthlyPromptCredits=12, monthlyFlowCredits=13, monthlyFlexCreditPurchaseAmount=14, devinInfo=33 (canUseCascade=1, canUseCli=2, orgId=4, webappHost=5, apiUrl=7, accountDisplayName=8), isDevin=34, billingStrategy=35 (CREDITS=1/QUOTA=2/ACU=3), hideDailyQuota=36, hideWeeklyQuota=37.
**PlanStatus**: planInfo=1, planStart=2, planEnd=3, availableFlexCredits=4, usedFlowCredits=5, usedPromptCredits=6, usedFlexCredits=7, availablePromptCredits=8, availableFlowCredits=9, topUpStatus=10, overageBalanceMicros=16, dailyQuotaRemainingPercent=14, weeklyQuotaRemainingPercent=15, dailyQuotaResetAtUnix=17, weeklyQuotaResetAtUnix=18.
**TeamsTier**: DEVIN_PRO=16, DEVIN_MAX=17, DEVIN_FREE=19, DEVIN_TRIAL=20 (…).

### 2.5 Chat flow

1. `GetUserJwt(metadata w/ apiKey)` → `userJwt` + optional `customApiServerUrl`.
2. If model has router (`compat.modelRouter`): `AssignModel(metadata, modelRouterUid, cascadeId)` → `assignmentJwt` + `modelUid`; **must share `cascadeId`** with the chat call.
3. `GetChatMessage(metadata w/ apiKey+userJwt, chatModelUid = assignment.modelUid ?? chatModelUid ?? requestModelId ?? id, prompt = flattened system prompt, chatMessagePrompts, requestType=CASCADE(5), plannerMode=DEFAULT(1), systemPromptCacheOptions=EPHEMERAL, configuration, tools, cascadeId, executionId=randomUUID())`.
4. Decode frames until `0x02` trailer. Map `deltaText`→text, `deltaThinking`/`deltaSignature`→thinking, `deltaToolCalls`→tool blocks, `stopReason` (MAX_TOKENS→`length`, tools pending→`toolUse`, else `stop`), `usage`→tokens, `creditCost`/`committedCreditCost`/`committedAcuCost`→credits.
5. Non-2xx → `DevinApiError` with status+headers; trailer error envelope → validation/transient classification; `invalid_argument` w/ `internal error` + no output + history ≥512 KiB → ContextOverflow.

---

## 3. Implementation plan

New folder mirrors the Cursor integration pattern (`integrations/cursor/`): wire module, transport, adapter, auth, catalog, quota — all lazy-loaded via `default-registry.ts`.

```
src/providers/integrations/devin/
  protocol/
    codec.ts          # ported protobuf codec (donor protobuf.ts, MIT) — encode/decode + create
    devin-proto.ts    # ported schema (donor devin-proto.ts, MIT, ~90KB generated) OR protobufjs root
  devin-shared.ts     # constants: paths, base url, metadata identity tuples, encodeDevinCredential, UA, flags
  devin-http.ts       # unary RPC client (application/proto) + gzip-fallback decode
  devin-frame.ts      # Connect frame encode/decode + 16MiB cap (pattern: cursor protocol/framing)
  devin.ts            # chat adapter (streamDevin equivalent) — implements ProviderAdapter
  devin-auth.ts       # login hooks: devin-windsurf (PKCE loopback 59654) + devin-cli (adopt credentials.toml)
  devin-catalog.ts    # discovery: GetCliModelConfigs → ModelSpec/defineModel + seed + KDL cost rules
  devin-quota.ts      # GetUserStatus → quota windows + usage report
  devin.test.ts       # fake-transport tests (see §5)
```

### 3.1 Protocol codec — recommendation

**Port the donor codec** (`discovery/protobuf.ts` + `discovery/devin-proto.ts`) rather than generating fresh from `.proto`:

- The donor codec is pure TypeScript, zero deps (only `isRecord`), already shape-tested, and **already proven against the live server** (our 401 probe used it — the server parsed the body correctly).
- The original `.proto` files for Devin also exist in the donor (`packages/ai/src/providers/devin/proto/exa/**`); protobufjs (the Cursor pattern) is a viable alternative but re-implements what the donor codec already does and risks field-number drift in translation.
- License: donor is MIT — keep a provenance header.
- Wire the codec to throw typed errors on unknown/truncated fields; cap decode buffer at frame cap.

### 3.2 Chat adapter

- Implement `ProviderAdapter` (like `cursor.ts`), **not** `BaseProviderAdapter` subclass: payload is binary protobuf, headers are Connect-specific, and the transport is frame-streaming (BaseProviderAdapter's `preparePayload/executeTransport` JSON-friendly shape is a poor fit). Reuse `createUpstreamDeadlineLifecycle` and the failure-policy helpers (`classifyUpstreamError`, `mapUpstreamHttpError`, `GatewayError`).
- Decode frames with `0x02` trailer handling and 16 MiB cap.
- Preserve quirky behaviors: `Math.fround(topP)`, tool-call id sanitize/cap 40, Gemini schema normalization (`type` array → `nullable`), system prompt flattening, cascadeId threading, executionId UUID.
- Map trailing `stopReason`/tool blocks/usage/credits into canonical events (text/thinking/tool_use/usage/done).

### 3.3 Discovery → catalog

- `loadModelDiscovery`: `GetCliModelConfigs` with discovery identity + `supportedModelDisplays=[3,4,6,7,8]`; timeout 15s; empty-200 or all-disabled → treat as failure (stale pin), do not surface an empty catalog.
- Filter client-side `QUICK_REVIEW(4)`/`INTERNAL_DEFAULT(6)`; keep `MODEL_ROUTER(3)`, `UNCLASSIFIED(7)`, `NORMAL(8)`.
- Normalize → `defineModel` rows: id=modelUid, contextWindow=modelInfo.maxTokens (fallback 200k), maxTokens=modelInfo.maxOutputTokens (fallback 64k), cost from `modelDimensions` (COST/COST_FUZZY, stop at `sidekick` label, denominator k/m/b), reasoning from ModelFeatures.supportsThinking (authoritative) with label heuristic fallback, tools from features.supportsToolCalls, image gated on supportsImages except `DEVIN_IMAGE_BLIND_UIDS = {swe-1-6-fast, swe-1-6-slow}`.
- Router slots (`MODEL_ROUTER` + no harnessUids) → `compat.modelRouter: true`; harness composites (`fusion`, `fusion-*-sidekick-*`) remain chat uids with lead-model merging.
- Seed (boot, synchronous): `swe-1-6-fast` + `swe-1-6-slow` + `swe-2-flash-medium` (from live `GetCliModelConfigs`); discovery replaces seed; account default (`defaultOverrideModelConfig`) wins. `swe-1-6` removed — absent from the live roster and chat failed `failed_precondition`.
- KDL cost rules (port from donor `providers/devin.kdl`): cost-fallback (SWE-2 promo → list 2027-01-01, SWE-1.7, GLM-5.2), cache-write-rate (anthropic 1.25, gpt ≥5.6 <7 1.25, adaptive 1.0), long-context tiers (gpt-6 272k ×2.0 in/1.5 out; gemini-pro >=3.1<4 & grok 200k ×2.0 in/1.5 out), `trust-explicit-thinking-only`.

### 3.4 Auth

- **Windsurf editor login** (`devin-windsurf`): loopback server on `127.0.0.1:59654` (fallback random port), authorize `https://windsurf.com/editor/signin` with `response_type=code`, `redirect_uri=http://127.0.0.1:<port>/callback`, state UUID, PKCE S256 (96-byte verifier), `prompt=login`, `redirect_parameters_type=query`; exchange `ExchangePKCEAuthorizationCode`; strip `gsk-` prefix; store as `devin` credential (api_key row); never refreshes (`expires=∞`).
- **CLI adopt** (`devin-cli`): read `%APPDATA%/devin/credentials.toml` → `~/.local/share/devin/credentials.toml` → (macOS) `~/Library/Application Support/devin/credentials.toml`; parse TOML; use `windsurf_api_key`; reject `api_server_url` not in `KNOWN_API_HOSTS = ["server.codeium.com","server.enterprise.windsurf.com"]`; no network. Store as `devin`.
- **Encode at request time** via `encodeDevinCredential` (§2.3).
- KDL: `auth/devin.kdl` (native app.devin.ai oauth-code flow, port 59653, `https://api.devin.ai/auth/cli/token`) is **secondary/optional** — donor keeps it but Windsurf/Devin unified makes the editor flow the primary. Recommend shipping both hooks but default to windsurf.

### 3.5 Quota

- `loadQuotaCollector`: `GetUserStatus(metadata)` → credit buckets (prompt/flow/flex; limit from `PlanInfo.monthly*`, used/available from `PlanStatus.*`; unit `unknown`; skip zero-triple buckets) + daily/weekly quota windows (percent-based; skip when hidden or when resetAtUnix=0 under non-QUOTA billing) + monthly plan window + `overageBalanceUsd = overageBalanceMicros / 1e6`.
- Always return non-fatal null on any failure (usage pipeline is best-effort).

### 3.6 Registry wiring (`src/providers/default-registry.ts`)

```ts
devin: {
  // path is pinned for probe verification; origin is fixed (server.codeium.com)
  endpointPathsByWireFamily: { chat: "/exa.api_server_pb.ApiServerService/GetChatMessage" },
  loadAdapter: async () => (await import("./integrations/devin/devin")).devinAdapter,
  loadModels: async () => (await import("./integrations/devin/devin-catalog")).DEVIN_MODELS,
  loadAuthentication: ... // custom login hooks (windsurf/cli) + store-as devin
  loadQuotaCollector: quotaCapability(() => import("./integrations/devin/devin-quota"), "fetchDevinQuota"),
  loadModelDiscovery: ... discoverDevinModels({ credential, fetcher }),
}
```

Also register provider `devin` in provider metadata/capabilities, env `DEVIN_API_KEY` (static key path), and the dashboard provider row (with `devin` brand).

---

## 4. Phasing

1. **Phase 1 — Foundation:** protocol codec port + shared constants + unary client (`devin-http.ts`) + tests with fake transport. (No live dependency.)
2. **Phase 2 — Chat adapter:** framing + stream decode + error classification + tests (fake frame stream covering streaming args, trailers, frame cap, large-request recovery).
3. **Phase 3 — Discovery/catalog:** GetCliModelConfigs + normalization + seed + KDL cost rules + tests (fixture responses from donor test shapes).
4. **Phase 4 — Auth:** windsurf PKCE loopback + CLI adopt + credential encoding + tests (mock exchange).
5. **Phase 5 — Quota:** GetUserStatus → windows + tests (fixture protobuf responses).
6. **Phase 6 — Registry + e2e:** wire into `default-registry.ts`, dashboard row, env var; live verification with a real seat key (requires an account with a Devin/Windsurf seat — see risks).

---

## 5. Test plan

- Mirror donor test coverage where meaningful, adapted to Cartethyia's fake-transport harness:
  - request identity assertions (chisel/dev identity, display options, credential encoding, JWT prefix)
  - response decode incl. gzip fallback
  - streaming: cumulative tool args, trailer error envelope, stopReason mapping, credits/usage mapping
  - frame cap rejection (32 MiB attempt without buffering)
  - large-history ContextOverflow classification (≥512 KiB)
  - discovery: empty-200 → null, all-disabled → null, timeout 15s, display filtering, router/harness handling, cost dims, family collapse aliases (`claude`→`claude-sonnet-5`, `codex`→`gpt-5-3-codex`, …)
  - auth: PKCE params, state mismatch rejection, `gsk-` strip, CLI TOML parse/candidates, host allowlist
  - quota: bucket math, quota-window gating, overage USD

---

## 6. Risks & open questions

1. **Live catalog unverified (blocker for exact model list).** Need a real seat key. Options: Windsurf editor login with an account that has a seat; or generate an API key from the Devin dashboard (endpoint not yet located; telemetry hints `SettingsGenerateApiKey`/`SettingsRetrieveApiKey` exist but were traced to enterprise-scoped paths). Until then, adapter ships with the SWE-1.6 seed and discovery logic tested against fixtures.
2. **Proto/identity drift.** The donor pins `devin-cli/3000.11.205`; server may gate newer surfaces on newer versions. Treat version constants as config, re-verify during live phase.
3. **OAuth page drift.** `windsurf.com/editor/signin` params may change; keep the loopback exchange resilient and report clear errors.
4. **`api.devin.ai` REST surface** is not used for chat/usage; only the (optional) native CLI token exchange uses it. If the unified Devin CLI moves off `server.codeium.com` in the future, re-check `KNOWN_API_HOSTS`.
5. **AI Gateway** (`https://server.codeium.com/api/v1`, `AI_GATEWAY_API_KEY`, OpenAI-compatible `/models`) is a separate product surface — out of scope unless requested.
6. **Credentials sensitivity.** Never log raw keys; reuse Cartethyia redaction.

---

## 7. References

- Donor: `Public/oh-my-pi` — `packages/ai/src/providers/devin.ts`, `packages/ai/src/registry/oauth/devin{,-windsurf,-cli}.ts`, `packages/ai/src/usage/devin.ts`, `packages/catalog/src/{wire,discovery}/devin{,-proto}.ts`, `packages/catalog/src/compat/rules/{providers/devin.kdl,auth/devin*.kdl,taxonomy/_collapse.kdl}`, `packages/catalog/test/devin-discovery.test.ts`, `packages/ai/test/devin-*.test.ts`.
- Cartethyia pattern: `src/providers/integrations/cursor/` (protobufjs + Connect framing + typed errors), `src/providers/default-registry.ts` (definitive capabilities wiring).
- Prior audit: `documentation/research/devin/2026-11-06-devin-desktop-audit.md`.
- Skill recipe: `.skills/cartethyia-reverse-engineering/references/unpacking-and-wire-capture.md` (Devin OAuth static→live section).
- Scratch probe harness: `D:\tmp\scratch\devin-probe\` (donor codec + probes; live 401 evidence).
