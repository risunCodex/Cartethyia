# Proposal Final: Cartethyia Devin adapter — flow implementasi lengkap

- **Date:** 2026-11-07 (updated)
- **Status:** proposal — uncommitted, awaiting Rover review
- **Basis:** audit 4 donor (oh-my-pi, opencode-devin-provider, devin-proxy, devin2api) + reverse engineering bundle Devin desktop
- **Keputusan inti:** **oh-my-pi adalah sumber utama**; opencode/proxy/devin2api = referensi pelengkap. Proto asli masuk ke `vendor/`, generated masuk langsung ke `src/providers/integrations/devin/`. Tidak ada codegen penuh 69K/236K baris.

---

## 0. TL;DR

| Pertanyaan | Jawaban |
|---|---|
| Sumber utama? | **oh-my-pi** (TS/Bun, paling kecil + paling matang + 12 test jalan) |
| Proto ditaruh mana? | `.proto` asli → `vendor/proto/devin/` (pola Qoder yang sudah ada) |
| Generated ditaruh mana? | **Langsung ke `src/providers/integrations/devin/`** (pola Cursor: `protobufjs` + header license vendored) |
| Ukuran generated? | ±2.678 baris schema (+1.082 codec) — BUKAN 69K/236K |
| Base URL? | `https://server.codeium.com` (ConnectRPC protobuf) |
| Identity chat? | `devin-cli`/`chisel`/`3000.11.205` |
| Identity discovery? | `chisel`/`0.0.0-dev` + `supportedModelDisplays=[3,4,6,7,8]` |

---

## 1. Keputusan arsitektur (kenapa begini)

### 1.1 Kenapa oh-my-pi, bukan opencode

| Metrik | oh-my-pi | opencode | proxy (Py) | devin2api (Go) |
|---|---|---|---|---|
| Baris proto | 2.678 (trimmed) | **69.379** (codegen penuh) | 236 (manual) | **236.771** (.pb.go) |
| Baris hand-written | 2.008 | 1.158 | 6.250 | ~18.900 |
| Total non-test | **5.798** | 70.537 | 6.486 | ~255.700 |
| Chat streaming | ✅ 893 baris | ✅ 686 | ✅ 551 | ✅ 2.439 |
| Discovery + family collapse | ✅ 548 | ⚠️ dangkal (cost 0) | ✅ 634 | ✅ |
| OAuth (2 flow) | ✅ 184 | ⚠️ helper saja | ✅ 632 | ❌ |
| Quota/usage | ✅ 311 | ❌ | ✅ | ⚠️ |
| Error taxonomy | ✅ | ⚠️ boolean | ✅ scoped | ✅⭐ |
| Test | ✅ 12 file jalan | ⚠️ 6 file, **gagal** | ✅ script | ✅⭐ golden |
| Lisensi | ✅ MIT | ✅ MIT | ❌ tanpa LICENSE | ✅ MIT |
| Stack match | ✅ TS/Bun | ✅ TS/Bun | ❌ | ❌ |

- **opencode** kalah karena proto-nya 69K baris generated dan mustahil diambil setengah (semua saling terkait) — sedangkan oh-my-pi **sudah membuktikan** subset 2.678 baris cukup (header `devin-proto.ts`: *"retains only fields consumed by the client or its protocol tests"*).
- **devin2api** paling matang engineering (pool/congest/demote/detached/warm + golden wire tests) tapi Go → TS = reimplementasi arsitektur, bukan port. Yang diserap: **behavior requirements** (golden fixtures, tool_choice=none, call→result re-pairing, error→HTTP mapping).
- **devin-proxy** nilai utamanya di error scoping account/soft/transient + OAuth fallback `ExchangePKCEAuthorizationCode` + kombo identity `devin-cli`/`chisel` (chat) vs `windsurf` (discovery).

### 1.2 Kenapa vendor/ + generated ke integration

Pola yang sudah ada di Cartethyia:

```
vendor/proto/qoder/chat.proto        ← .proto ASLI (322 baris)
vendor/qoder-umid/…                  ← artefak binary/non-TS
src/providers/integrations/cursor/protocol/messages.ts   ← generated/vendored code (99K baris) masukkan ke integration, pakai protobufjs + header license
vendor/turing-sdk/…                  ← SDK native
```

Jadi Devin mengikuti pola yang sama:

```
vendor/proto/devin/…                 ← .proto asli (52 file, 23.276 baris) dari oh-my-pi
src/providers/integrations/devin/protocol/devin-proto.ts  ← generated (protobufjs, trimmed ±2.678 baris)
src/providers/integrations/devin/protocol/protobuf.ts     ← codec (bisa diganti protobufjs)
```

**Kenapa generated (bukan .proto) langsung di integration:** runtime tidak pernah membaca `.proto` — yang dicerna adalah schema TS. `.proto` asli disimpan di `vendor/` sebagai **sumber kebenaran + provenance** (untuk regenerasi, audit drift, dan lisensi), persis peran `vendor/proto/qoder/chat.proto`. `.proto` hasil `proto-parser` (trimmed) tetap dipertahankan sebagai `devin.proto.trimmed` di vendor untuk dokumentasi subset.

**Kenapa protobufjs, bukan codec custom oh-my-pi:** Cartethyia sudah punya `protobufjs` sebagai dependensi (dipakai Cursor). Codec custom oh-my-pi (`protobuf.ts`, 1.082 baris) bisa dipakai, tapi menambah dua implementasi protobuf berbeda di satu repo. Keputusan: **pakai protobufjs** untuk runtime (konsisten dengan Cursor), dan definsikan schema sebagai `protobuf.js` Root (pola `cursor/protocol/messages.ts`). Kalau mau minimal-diff, port codec custom jadi opsi cadangan — tapi rekomendasi utama protobufjs.

---

## 2. Struktur target

```
src/providers/integrations/devin/
├── protocol/
│   ├── devin-proto.ts        # generated schema (protobufjs Root, trimmed ±2.678 baris)
│   └── framing.ts            # Connect frame encode/decode + gzip + 16MiB cap (dari oh-my-pi/opencode)
├── devin-shared.ts           # constants + metadata identity + encodeDevinCredential + UA
├── devin-http.ts             # unary RPC client (application/proto) + gzip-fallback decode
├── devin.ts                  # chat adapter (streamDevin equivalent) — implements ProviderAdapter
├── devin-auth.ts             # login hooks (opencode app.devin.ai + oh-my-pi windsurf + cli)
├── devin-catalog.ts          # discovery (GetCliModelConfigs) + normalisasi + seed
├── devin-quota.ts            # usage (GetUserStatus) → quota windows
└── devin.test.ts             # fake-transport tests

vendor/proto/devin/
├── exa/api_server_pb/api_server.proto          # + semua .proto asli (52 file)
├── exa/codeium_common_pb/codeium_common.proto
├── exa/chat_pb/chat.proto
├── exa/auth_pb/auth.proto
├── exa/seat_management_pb/seat_management.proto
└── README.md                # provenance: sumber (oh-my-pi commit), lisensi MIT, cara regenerasi
```

### Failed.1 Sumber per file

| File target | Sumber utama | Asal |
|---|---|---|
| `protocol/devin-proto.ts` | oh-my-pi `discovery/devin-proto.ts` | trimmed schema (2.678 baris) — konversi ke protobufjs |
| `protocol/framing.ts` | oh-my-pi/opencode `cascade.ts` | Connect frame + gzip + trailer + cap 16MiB |
| `devin-shared.ts` | oh-my-pi `wire/devin.ts` | constants + identity + encodeDevinCredential |
| `devin-http.ts` | oh-my-pi `wire/devin-proto.ts` + `devin.ts` | unary client + gzip fallback |
| `devin.ts` | oh-my-pi `providers/devin.ts` | streamDevin (893 baris) — adapter-ulang |
| `devin-auth.ts` | oh-my-pi `oauth/devin-windsurf.ts` + `devin-cli.ts` + opencode `oauth.ts` | 2 flow OAuth + CLI adopt |
| `devin-catalog.ts` | oh-my-pi `discovery/devin.ts` + `providers/devin.kdl` | discovery + seed + cost rules |
| `devin-quota.ts` | oh-my-pi `usage/devin.ts` | GetUserStatus → buckets + windows |

---

## 3. Wire contract (verifikasi lintas 4 donor)

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

**Unary** (auth, AssignModel, discovery, exchange, status): `POST`, `content-type: application/proto`, `connect-protocol-version: 1`, `accept: */*`; body = raw protobuf; response bisa protobuf polos ATAU gzipped (decode fallback).

**Chat** (GetChatMessage): `POST`, `content-type: application/connect+proto`, `connect-protocol-version: 1`, `accept-encoding: identity`, `connect-accept-encoding: gzip`, `user-agent: connect-go/1.18.1 (go1.26.3)`; body = Connect frame (`[flags 1B][len BE32][payload]`, flag 0x01 gzip, 0x02 end-stream/trailer JSON); request dikompresi bila ≥1024B; frame cap 16MiB.

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
| userJwt | dari GetUserJwt | — |
| sessionId | stabil per percakapan | — |

`encodeDevinCredential`: trim → sudah prefix `devin-session-token$` → as-is → JWT 3-segmen (split "." length 3) → prefix → else verbatim (`sk-ws-…` bare). **Verifikasi lintas donor**: oh-my-pi & opencode pakai prefix ini; proxy & devin2api pakai `Basic <token>-<token>` (marker aneh, bukan base64) — **kita ikut oh-my-pi** (token di Metadata.apiKey, bukan header Basic).

### 3.4 Pesan penting (field numbers, dari proto asli + lintas donor)

**Metadata** (`exa.codeium_common_pb.Metadata`): ideName=1, extensionVersion=2, apiKey=3, locale=4, os=5, disableTelemetry=6, ideVersion=7, hardware=8, requestId=9, sessionId=10, sourceAddress=11, extensionName=12, userAgent=13, url=14, authSource=15, lsTimestamp=16, extensionPath=17, userId=20, userJwt=21, forceTeamId=22, deviceFingerprint=24, triggerId=25, planName=26, id=27, ideType=28, impersonateTier=29, supportedModelDisplays=30 (repeated enum), f=31, teamId=32.

**GetChatMessageRequest**: metadata=1, prompt=2, chatMessagePrompts=3, useInternalChatModel=5, internalChatModel=6 (deprecated), requestType=7, configuration=8, experimentConfig=9, tools=10, disableParallelToolCalls=11, toolChoice=12, systemPromptCacheOptions=13, chatModelName=14, trajectoryReference=15, cascadeId=16, promptId=17, providerSource=18, language=19, plannerMode=20, chatModelUid=21, executionId=22, arenaConvergeCount=24, arenaAssignmentJwt=25, modelAssignmentJwt=26.

**GetChatMessageResponse**: messageId=1, timestamp=2, deltaText=3, deltaTokens=4, stopReason=5, deltaToolCalls=6, usage=7, redact=8, deltaThinking=9, deltaSignature=10, thinkingRedacted=11, latency=12, completionProfile=13, creditCost=14, outputId=15, thinkingId=16 (deprecated), requestId=17, committedCreditCost=18, prompt=19, deltaSignatureType=21, committedAcuCost=22, actualModelUid=23, arenaInvocationCapReached=24, phase=25, committedQuotaCostBasisPoints=26, committedOverageCostCents=27, responseDimensionGroups=28.

**CompletionConfiguration**: numCompletions=1, maxTokens=2, maxNewlines=3, minLogProbability=4, temperature=5, firstTemperature=6, topK=7, topP=8, stopPatterns=9, seed=10. Quirk: `topP` di-`Math.fround()` (float32 widening).

**ChatToolDefinition**: name=1, description=2, jsonSchemaString=3, attributionFieldNames=5, serverName=6, readOnlyHint=7, computerUseConfig=8, isCustomTool=9, customToolGrammar=10, customToolGrammarSyntax=11, strict=12.

**ChatToolCall** (response): id=1, name=2, argumentsJson=3, invalidJsonStr=4, invalidJsonErr=5, isCustomToolCall=6. Args datang cumulative → delta dari prefix sebelumnya; parse di `toolcall_end`.

**ChatMessagePrompt** (history): messageId=1, source=2 (USER=1/SYSTEM=2/UNKNOWN=3/TOOL=4/SYSTEM_PROMPT=5), prompt=3, numTokens=4, safeForCodeTelemetry=5, toolCalls=6, toolCallId=7, promptCacheOptions=8, toolResultIsError=9, images=10, thinking=11, signature=12, thinkingRedacted=13, promptAnnotationRanges=14, outputId=15, thinkingId=16, geminiThoughtSignature=17, signatureType=18, phase=19.

**AssignModelRequest**: metadata=1, modelRouterUid=2, cascadeId=3, chatMessagePrompt=5. **AssignModelResponse**: assignment=1 (ModelAssignment: assignmentJwt=1, modelUid=2, harnessUids=3).

**GetUserJwtRequest**: metadata=1. **Response**: userJwt=1, customApiServerUrl=2 (override base URL chat).

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

### 3.5 Alur chat

1. `GetUserJwt(metadata w/ apiKey)` → `userJwt` + optional `customApiServerUrl`.
2. Jika model router (`compat.modelRouter`): `AssignModel(metadata, modelRouterUid, cascadeId)` → `assignmentJwt` + `modelUid`; **share `cascadeId`** dengan chat.
3. `GetChatMessage(metadata w/ apiKey+userJwt, chatModelUid = assignment.modelUid ?? chatModelUid ?? requestModelId ?? id, prompt = flattened system prompt, chatMessagePrompts, requestType=CASCADE(5), plannerMode=DEFAULT(1), systemPromptCacheOptions=EPHEMERAL, configuration, tools, cascadeId, executionId=randomUUID())`.
4. Decode frames sampai trailer `0x02`. Map `deltaText`→text, `deltaThinking`/`deltaSignature`→thinking, `deltaToolCalls`→tool blocks, `stopReason` (MAX_TOKENS→`length`, tools pending→`toolUse`, else `stop`), `usage`→tokens, `creditCost`/`committedCreditCost`/`committedAcuCost`→credits.
5. Non-2xx → `DevinApiError` (status+headers); trailer error envelope → classification; `invalid_argument` + `internal error` + belum ada output + history ≥512KiB → ContextOverflow.

Behavior yang diambil dari devin2api (wajib):
- **call→result re-pairing** — history client (semua call lalu semua result) di-interleave jadi berpasangan di wire.
- **tool_choice=none** → tools tidak masuk wire sama sekali (bukan dikosongkan).
- **gambar hanya di turn terakhir**; dokumen/video boleh di history.
- **stop sequences di-handle lokal** (upstream tidak menghormati) — potong teks + simpan `maxPatternLen-1` byte antisipasi.
- **signature replay** — thinking client butuh `signature` + `signatureType` yang benar; salah type → upstream invalid_argument.
- **error mapping** — `classifyUpstreamError` + `mapUpstreamHttpError` Cartethyia menangani status: `unauthenticated`→401, `resource_exhausted`→429, `invalid_argument`/`failed_precondition`/`permission_denied`→400 (bukan 403), transport break→502, timeout→504, context length→413.

---

## 4. Implementasi per file

### 4.1 `protocol/devin-proto.ts` (generated, ±2.678 baris)

- Port dari oh-my-pi `discovery/devin-proto.ts` (MIT, header provenance dipertahankan).
- Konversi dari codec custom IR → `protobufjs` Root (pola `cursor/protocol/messages.ts`): `addType(root, "Metadata", [...])` dst.
- Hanya message yang dikonsumsi: Metadata, GetChatMessageRequest/Response, ChatMessagePrompt, ChatToolDefinition/Choice/Call, CompletionConfiguration, AssignModelRequest/Response, GetUserJwtRequest/Response, GetCliModelConfigsRequest/Response, ClientModelConfig, ModelInfo, ModelFeatures, ModelDimension, ModelFamilyMetadata, ExchangePKCEAuthorizationCodeRequest/Response, GetUserStatusRequest/Response, UserStatus, PlanInfo, PlanStatus, TeamsTier, enum DisplayOption/StopReason/ChatMessageSource/BillingStrategy/ModelDimensionKind.
- Simpan `.proto` asli (52 file) di `vendor/proto/devin/` sebagai sumber kebenaran + regenerasi.

### 4.2 `protocol/framing.ts` (Connect framing)

- Dari oh-my-pi/opencode `cascade.ts`:
  - `encodeConnectFrame(payload, {compress})` → gzip bila ≥1024B, `[flags=0x01][len BE32][payload]`.
  - `decodeConnectFrame` / `ConnectFrameDecoder` — baca 5-byte header, validasi length ≤ 16MiB (`MAX_CONNECT_FRAME_PAYLOAD`), decompress flag 0x01, baca trailer JSON flag 0x02.
  - `readConnectTrailerError` — parse `{error:{code,message}}` → `GatewayError`.
- Pattern struktur: `cursor/protocol/framing.ts` (sudah ada di repo).

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
- Header: `content-type: application/proto`, `connect-protocol-version: 1`, `accept: */*`.
- Response decode: coba `fromBinary` langsung, fallback `gunzipSync` (±`decodeDevinUnaryMessage`).
- Gabung signal dengan `AbortSignal.timeout(15_000)` untuk discovery (server sering butuh 7-15s).

### 4.5 `devin.ts` (chat adapter)

- Implement `ProviderAdapter` (kontrak `src/providers/provider-contracts.ts`), **bukan** `BaseProviderAdapter` (payload biner + framing streaming).
- Alur: `GetUserJwt` → (router?) `AssignModel` → build request → frame → POST → stream decode → canonical events.
- Tool handling: akumulasi args cumulative, parse di `toolcall_end`, id sanitize/cap 40, `normalizeSchemaForGoogle` untuk class gemini.
- Error: `GatewayError` mapping per §3.5; `createUpstreamDeadlineLifecycle` dipakai.
- Quirk: `Math.fround(topP)`, cascadeId threading, executionId UUID, system prompt flattening.

### 4.6 `devin-auth.ts` (OAuth)

- **Flow 1 — opencode/app.devin.ai** (primary): authorize `https://app.devin.ai/auth/cli/continue` (PKCE S256, state UUID, prompt select_account), callback port 59653, exchange `POST https://api.devin.ai/auth/cli/token` body JSON `{code, code_verifier}` → `{token}`; expires JWT −5m fallback 365d.
- **Flow 2 — oh-my-pi/windsurf** (enterprise seat): `https://windsurf.com/editor/signin` (PKCE, port 59654) → `ExchangePKCEAuthorizationCode` → apiKey (strip `gsk-`); store as `devin`.
- **Flow 3 — CLI adopt**: `%APPDATA%/devin/credentials.toml` → `~/.local/share/devin/credentials.toml` → (macOS) Library; parse `windsurf_api_key`; reject `api_server_url` di luar `KNOWN_API_HOSTS = ["server.codeium.com","server.enterprise.windsurf.com"]`; tanpa network.
- Store: semua simpan sebagai `devin` credential (api_key row) via `storeLoginApiKey`/`upsertAuthCredential`.
- Tidak ada refresh (expires ∞ untuk seat key; JWT 1 tahun).

### 4.7 `devin-catalog.ts` (discovery + seed)

- `loadModelDiscovery`: `GetCliModelConfigs` identity discovery + `supportedModelDisplays`; timeout 15s; empty-200 atau all-disabled → null (stale pin).
- Filter client-side `QUICK_REVIEW(4)`/`INTERNAL_DEFAULT(6)`; pertahankan `MODEL_ROUTER(3)`/`UNCLASSIFIED(7)`/`NORMAL(8)`.
- Normalisasi → `defineModel`: id=modelUid, contextWindow=modelInfo.maxTokens (fallback 200k), maxTokens=modelInfo.maxOutputTokens (fallback 64k), cost dari `modelDimensions` (COST/COST_FUZZY, stop label `sidekick`, denominator k/m/b), reasoning dari ModelFeatures.supportsThinking (authoritative) + label heuristic, tools dari supportsToolCalls, image gated kecuali `DEVIN_IMAGE_BLIND_UIDS = {swe-1-6-fast, swe-1-6-slow}`.
- Router slot (`MODEL_ROUTER` + tanpa harnessUids) → `compat.modelRouter: true`; harness composites (`fusion`, `fusion-*-sidekick-*`) tetap chat uid + lead-model merging.
- Seed (boot, synchronous): `swe-1-6-fast` + `swe-1-6-slow` + `swe-2-flash-medium` (dari live `GetCliModelConfigs`); discovery menggantikan; account default (`defaultOverrideModelConfig`) menang. `swe-1-6` dihapus dari seed — tidak ada di roster live dan chat gagal `failed_precondition`.
- Cost rules (port KDL oh-my-pi): cost-fallback (SWE-2 promo → list 2027-01-01; SWE-1.7; GLM-5.2), cache-write-rate (anthropic 1.25, gpt ≥5.6 <7 1.25, adaptive 1.0), long-context tiers (gpt-6 272k ×2.0 in/1.5 out; gemini-pro ≥3.1<4 & grok 200k ×2.0 in/1.5 out).

### 4.8 `devin-quota.ts` (usage)

- `loadQuotaCollector`: `GetUserStatus(metadata)` → 3 bucket credit (prompt/flow/flex; limit dari `PlanInfo.monthly*`, used/available dari `PlanStatus.*`; unit `unknown`; skip zero-triple) + daily/weekly quota windows (percent; skip hidden atau resetAtUnix=0 saat non-QUOTA) + monthly plan window + `overageBalanceUsd = overageBalanceMicros / 1e6`.
- Selalu return null non-fatal saat gagal.

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

## 5. Fase implementasi

| Fase | Isi | Keluar |
|---|---|---|
| **1 — Vendor + generated** | Copy .proto → `vendor/proto/devin/`; port `devin-proto.ts` (protobufjs) + `framing.ts` | Schema + framing siap |
| **2 — Unary client** | `devin-http.ts` + `devin-shared.ts` + test fake transport | Auth/discovery/exchange bisa dipanggil |
| **3 — Chat adapter** | `devin.ts` + encoder/decoder behavior (re-pairing, tool_choice=none, stop scan) + test frame stream | Chat streaming hidup |
| **4 — Discovery** | `devin-catalog.ts` + seed + cost rules + test fixture response | Model list + seed |
| **5 — Auth** | `devin-auth.ts` 3 flow + test mock exchange | Login Devin/Windsurf/CLI |
| **6 — Quota** | `devin-quota.ts` + test fixture | Usage/limits |
| **7 — Registry + e2e** | Wiring + env + dashboard row; live verification pakai seat key | Provider lengkap |

---

## 6. Test plan

- **Unit (fake transport)**: identity request (chisel/dev, display options, credential encoding, JWT prefix); gzip fallback decode; frame cap 32MiB ditolak tanpa buffering; trailer error envelope; stopReason mapping; cumulative tool args; large-history ContextOverflow (≥512KiB); discovery empty-200→null, all-disabled→null, timeout 15s; router/harness; cost dims; family aliases (`claude`→`claude-sonnet-5`, `codex`→`gpt-5-3-codex`, …); quota bucket math + window gating.
- **Golden (dari devin2api)**: port 6 fixture `wire_golden_test.go` → test TS — request encoder byte-exact (tools, tool_choice=none, thinking replay, sampling, image last turn).
- **Live (fase 7)**: butuh seat key asli (`sk-ws-…`/JWT). auth1 token kita sudah terbukti ditolak.

---

## 7. Risiko & open questions

1. **Live catalog unverified** — butuh seat key asli. Sampai itu, adapter ship dengan seed SWE-1.6 + discovery logic teruji fixture.
2. **Drift identity** — tiga donor pakai tiga tuple beda (semua klaim "benar"). Kita ikut oh-my-pi (`devin-cli`/`chisel`/`3000.11.205` chat, `chisel`/`0.0.0-dev` discovery) karena paling teruji lintas 2 repo independen. Verifikasi live saat fase 7: bandingkan hasil katalog vs identity opencode (`windsurf/3.2.23/1.48.2`).
3. **Proto drift** — schema trimmed bisa miss field baru; mitigation: `noteSchemaDrift`-style warn pada unknown field (pola devin2api), regenerasi dari vendor .proto.
4. **OAuth page drift** — `windsurf.com/editor/signin` dan `app.devin.ai/auth/cli/continue` bisa berubah; loopback exchange harus resilient + error jelas.
5. **AI Gateway** (`server.codeium.com/api/v1`, `AI_GATEWAY_API_KEY`) — surface terpisah, out of scope.
6. **Credentials sensitivity** — jangan log raw keys; reuse redaction Cartethyia.

---

## 8. Referensi

- Donor utama: `Public/oh-my-pi` (packages/ai/src/providers/devin.ts, registry/oauth/devin{,-windsurf,-cli}.ts, usage/devin.ts, catalog/src/{wire,discovery}/devin{,-proto}.ts, catalog/src/compat/rules/{providers/devin.kdl,auth/devin*.kdl,taxonomy/_collapse.kdl}, catalog/test/devin-discovery.test.ts, ai/test/devin-*.test.ts)
- Referensi pelengkap: `Public/opencode-devin-provider` (cascade.ts, oauth.ts, devin-gen/), `Public/devin-proxy` (proto.py, upstream.py, accounts.py, models.py), `Public/devin2api` (internal/adapter/devin/{request_encoder,response_decoder,failure}.go, wire_golden_test.go)
- Pola Cartethyia: `src/providers/integrations/cursor/` (protobufjs + Connect framing), `src/providers/default-registry.ts` (registry), `vendor/proto/qoder/` (vendor .proto)
- Audit sebelumnya: `documentation/research/devin/2026-11-06-devin-desktop-audit.md`, `2026-11-07-oh-my-pi-devin-adapter-proposal.md`
- Skill recipe: `.skills/cartethyia-reverse-engineering/references/unpacking-and-wire-capture.md`
