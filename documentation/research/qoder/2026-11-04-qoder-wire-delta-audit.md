# Qoder wire-delta audit — donor vs gateway (2026-11-04)

Comprehensive audit of the unpacked Qoder desktop client (v1.1.81 bundle
`qoder-worker-runtime.mjs`, 35 MB single-line) across all three transports —
gRPC (`ChatCompletionStream`), HTTP IDE (`/model/v1`), and legacy COSY
(`agent_chat_generation`) — versus the Cartethyia adapter implementation.
Goal: enumerate every wire difference so the gateway can be made 1:1
identical to the client the upstream actually expects. The audit was performed
by three parallel subagents, each reconstructing one transport's request
body, headers, signing, and response parsing from the bundle via offset
slicing (`scripts/scratch/qoder-bundle-slice.ts`).

## Context: the failure being chased

User-visible symptom through the gateway: **"Connection lost while reading the
response: ECONNRESET: The socket connection was closed unexpectedly"** — timed
right at the moment a tool call is expected, and only on the billed gRPC path
(`qfmodel`, Qwen3.8-Flash). The HTTP (lite/COSY) path is fine. A retry loop
then replays the request; the upstream has already refused/closed the stream.

The gateway's tool-call bug (request missing `tools`, response Struct-wrapped
deltas) was already fixed and live-verified earlier today. This audit targets
the *remaining* delta: the transport-level handshake and channel semantics that
could make the upstream drop the connection mid-stream.

---

## 1. gRPC transport — donor vs gateway

### 1.1 Request builder (`QFn`)

Donor `QFn` (offset 19_833_906) produces:

```js
{
  model: A.model,
  messages: A.messages.map(JDl),
  tools: A.tools?.map(YDl) ?? [],
  stream: !0,                                   // plain bool
  stream_options: { include_usage: Iat(!0) },   // {value: true}
  max_tokens: cyl(e.max_tokens ?? A.max_tokens), // {value: int32}
  temperature: fat(e.temperature ?? A.temperature), // {value: double}
  top_p: fat(e.top_p),
  presence_penalty: fat(e.presence_penalty),
  frequency_penalty: fat(e.frequency_penalty),
  parallel_tool_calls: Iat(e.parallel_tool_calls), // {value: bool}
  response_format: qDl(e.response_format),
  reasoning: HDl(A),
  tool_choice: e.tool_choice === void 0 ? void 0 : Qat(e.tool_choice), // Value
  stop: Array.isArray(e.stop) ? e.stop : A.stop,
  patches: ODl(A.patches),
  metadata: {
    context: X6({ request_id: A.requestId, request_set_id: A.requestSetId,
      session_id: A.sessionId, source_session_id: A.sourceSessionId,
      task_id: A.taskId, client_type: t.client_type,
      context_length: e.context_length !== void 0 ? String(e.context_length) : void 0 }),
    business: A.business
  },
  extras: LDl(e),          // { top_k: oBA({top_k: e}) } only when top_k set
  custom_model: VDl(A.customModel)
}
```

Key helper shapes (already mirrored in `qoder-grpc.ts`, verified live):

| Helper | Output shape | Gateway status |
| --- | --- | --- |
| `yG(s)` | `{value: s}` (StringValue) | ✅ used |
| `Iat(b)` | `{value: b}` for booleans (BoolValue) | ✅ used |
| `cyl(n)` | `{value: Math.trunc(n)}` (Int32Value) | ✅ used |
| `fat(n)` | `{value: n}` (DoubleValue) | ✅ used |
| `oBA(obj)` | `{fields: {k: Qat(v)}}` (Struct) | ✅ used |
| `Qat(v)` | `Value` union: `{stringValue}` / `{numberValue}` / `{boolValue}` / `{nullValue:0}` / `{structValue:{fields}}` / `{listValue:{values}}` | ✅ used |
| `jDl(tc)` | ToolCall: `{id: yG(id), call_id: yG(call_id), type: yG("function"), function: {name, arguments: Qat(args)}}` — `arguments` is a `Value`! | ⚠️ gateway sends `{stringValue}` inline, omits `call_id` |
| `YDl(tool)` | `{type:"function", function: X6({name, description: yG(desc), parameters: oBA(params), strict: Iat(strict)})}` | ✅ used (with `parameters` as Struct) |

**Remaining deltas in the request object:**

| Field | Donor | Gateway | Impact |
| --- | --- | --- | --- |
| `metadata.context.client_type` | `"6"` (desktop) / `"5"` (IDE) | `"5"` | Low; server may treat as different client family |
| `metadata.context.context_length` | only when `e.context_length` set, as STRING | always `String(contextWindow)` (1_000_000) | Low; declared window vs actual — server may size buffers accordingly |
| `reasoning` | sent when budget/effort present | not sent | Low for tool path |
| `extras` | `{top_k: {structValue: {fields: …}}}` when top_k set | never sent | Low |

### 1.2 gRPC metadata headers — **primary suspect for ECONNRESET**

Donor `bDl` + `patchCompletionStream` (offset 19_832_730 / 19_848_342) sets
**exactly these** keys (all lowercase on the wire):

```
authorization: Bearer <token>
x-request-id: <uuid>
x-session-id: <sessionId>
cosy-version: 1.1.80            ← q8e = S9 || "1.1.80"
cosy-clienttype: 6               ← ~l().client_type (desktop)
cosy-machineos: x86_64_win32    ← `${arch}_${platform}` dynamic
cosy-machinehostname: <sanitized hostname>   ← optional, W8e()
```

**Donor does NOT send:** `cosy-machinetype`, `cosy-machinetoken` on the
gRPC surface (those are HTTP-only, and even there they are deleted for
service accounts). Channel options (`NDl`, offset 19_832_962):

```js
{ "grpc.enable_http_proxy": 0,
  "grpc.default_authority": host, "grpc.ssl_target_name_override": host,
  "grpc.max_receive_message_length": 33554432,   // 32 MiB
  "grpc.max_send_message_length": 33554432 }     // 32 MiB
```

Gateway `qoderGrpcMetadata` currently sends:

```
authorization: Bearer <token>
x-request-id: <uuid>
x-session-id: <sessionId>
cosy-clienttype: 5
cosy-machineos: aarch64_macos        ← hardcoded, not host platform
cosy-machinetype: 5                  ← donor does NOT send
cosy-machinetoken: <auth.machineId>  ← donor does NOT send
```

And the gateway's client is created with default channel options
(grpc-js default `max_receive_message_length` = 4 MiB).

**Delta summary (metadata):**

| Header | Donor | Gateway | Likely effect |
| --- | --- | --- | --- |
| `cosy-version` | `1.1.80` | **missing** | Server-side client-class check could refuse/drop |
| `cosy-clienttype` | `6` (desktop) | `5` | Different client family; `5` may be treated as IDE |
| `cosy-machineos` | `x86_64_win32` (real) | `aarch64_macos` (hardcoded) | **Platform mismatch** — server may flag device anomaly |
| `cosy-machinehostname` | sanitized hostname | missing | Identity completeness |
| `cosy-machinetype` | — | `5` sent | Extra header donor doesn't send — may trip strict validation |
| `cosy-machinetoken` | — | random/device token sent | **Extra header** — if the server validates this against a known device and the value is bogus, it can drop the connection |

The two *extra* headers (`cosy-machinetype`, `cosy-machinetoken`) are the
strongest candidates for a server-side reject/reset: the gateway sends random
or stale identity values the upstream never expects on gRPC, while omitting
`cosy-version` and sending a fake machine OS.

### 1.3 Response parsing (already fixed)

- `delta.tool_calls` = repeated Struct → decoded via donor `pat`/`Eat`
  (snake+camel) → `$Dl` maps to `{index, id, type, function:{name, arguments}}`
  with `arguments` re-stringified. Gateway now does exactly this via
  `fromProtoStruct` (verified live).
- `finish_reason` string; `tool_calls`/`function_call` → tool_use;
  `"null"` is non-terminal. Gateway matches.
- `usage` details: `cached_tokens` + `reasoning_tokens` only. Gateway matches.

---

## 2. HTTP IDE transport (`/model/v1`) — donor vs gateway

Donor `PFn` (offset 19_865_358) body:

```js
{
  model, messages: A.messages.map(kyl).filter(Boolean), stream: !0,
  stream_options: { include_usage: !0 },        // ← PLAIN bool, not {value}
  metadata: { context: { request_id, request_set_id, session_id,
    source_session_id, task_id, client_type }, ...(business ? {business} : {}) },
  tools: Myl(A.tools),          // only when non-empty; PLAIN OpenAI shape
  ...(stop && {stop}), ...(max_tokens !== undefined && {max_tokens}),
  ...(temperature !== undefined && {temperature}),
  ...vyl(A.parameters),         // whitelist: top_p, top_k, presence_penalty,
                                //   frequency_penalty, parallel_tool_calls,
                                //   response_format, tool_choice, context_length,
                                //   seed, user, enable_thinking,
                                //   reasoning_budget_tokens, preserve_thinking
  ...(reasoningEffort && {reasoning_effort}),
  ...(patches && Object.keys(patches).length && {patches}),
  ...(customModel && {custom_model: Fyl(customModel)})
}
```

`Myl` (tools) — **plain OpenAI shape, no wrappers**:

```js
A.tools?.map(e => ({ type: "function", function: {
  name: e.function.name,
  ...(e.function.description ? {description: e.function.description} : {}),
  ...(e.function.parameters ? {parameters: e.function.parameters} : {}),
  ...(e.function.strict !== void 0 ? {strict: e.function.strict} : {})
} }))
```

Headers (donor `Rat.openResponse` + `Hc` pipeline):

```
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <token>
X-Request-ID: <uuid UPPERCASE>
X-Session-ID: <sessionId>
Cosy-Version: 1.1.80
Cosy-ClientType: 5            ← Jl().client_type (IDE default)
Cosy-MachineOS: x86_64_win32
Cosy-MachineHostname: <sanitized>   ← only for requestClass "infer-sse"
traceparent: <otel>           ← when tracing enabled
```

Response parsing: SSE envelope `{statusCodeValue, body}` unwrapped by `G6`;
`[DONE]` termination; `[NOT_EXCEED_QUOTA]` / `[EXCEED_QUOTA]` /
`[NOTIFICATIONS]` markers filtered; `delta.tool_calls` read as plain OpenAI
shape; `finish_reason === "null"` treated as non-terminal; tool deltas stream
as fragments (same empty-id continuation rule as gRPC).

**Remaining deltas (IDE):**

| Aspect | Donor | Gateway | Impact |
| --- | --- | --- | --- |
| `stream_options.include_usage` | plain `true` | likely `{value: true}` (to check) | JSON only — server tolerant, but align |
| `X-Request-ID` case | UPPERCASE | lowercase uuid | Cosmetic but visible to server |
| `Cosy-Version` | `1.1.80` | ? | Align to reported version |
| `Cosy-MachineOS` | real platform | ? | Align |
| `Cosy-MachineHostname` | sanitized hostname | ? | Align |
| `tool_choice`/`response_format` | passthrough verbatim from parameters | passthrough | ✅ |
| `reasoning_effort` | input camelCase → wire snake `reasoning_effort` | — | only when set |

---

## 3. Legacy COSY transport — donor vs gateway

Donor `_8r` (offset 34_437_636) body — **plain JSON, no envelope**:

```js
{
  request_id, chat_record_id: request_id, request_set_id, session_id,
  source_session_id,
  stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false,
  source: 1, version: "3", agent_id: "agent_common", aliyun_user_type: "",
  chat_context: { text: <last user text>, features: [],
    extra: { context: [], modelConfig: {key, is_reasoning}, originalContent },
    chatPrompt: "", imageUrls: null },
  session_type: env.QODER_SESSION_TYPE ?? (dev ? "local" : "normal"),
  task_id: taskRouting.taskId ?? policyTaskId ?? "common",
  system: <string | array of {type:"text",text,cache_control?}>,
  messages: vUa(A),       // OpenAI-shaped, roles incl. tool/assistant tool_calls
  tools: HUa(A),          // PLAIN array: [{type:"function", function:{name, description: desc ?? "", parameters: params ?? {}}}]
  parameters: LUa(A),     // {temperature?, max_tokens, stop?, top_p?, top_k?,
                          //  reasoning_effort?, enable_thinking?,
                          //  reasoning_budget_tokens?, preserve_thinking?,
                          //  context_length?, tool_choice?}
  model_config: { key, display_name, outer_provider?|model:"", is_vl,
    is_reasoning, max_input_tokens, source: "system"|"custom_model",
    format: "openai", api_key: "", url: "" },
  custom_model: <undefined | {provider, model, type?, parameters:{api_key}, url?, style?}>,
  patches, business, custom_context
}
```

Signing: the chat path does **not** use `Authorization: Signature` HMAC; it
uses **WASM `prepareInferRequest`** (Rust) which builds the endpoint URL/query
(`FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` — assembled inside
WASM, not visible in JS) and merges headers. Identity headers via `iZt`/
`oZt`/`sZt`:

```
Authorization: Bearer <token>            (from WASM context)
Cosy-Version: 1.1.81 / 1.1.80
Cosy-ClientType: <client_type>
Cosy-MachineOS: x86_64_win32
Cosy-MachineCode / Cosy-MachineToken / Cosy-MachineType: <machine identity>
Cosy-MachineId: <machineId>              (only when machineIdentityRequired)
Cosy-MachineHostname: <sanitized>        (infer stream only)
X-Request-ID: <uuid UPPERCASE>
```

The legacy HMAC signer (`ZKt` — `Signature <hmac>`, `X-Client-Timestamp`,
`X-IDE-Platform: qoder_cli`, `X-Version`, `X-Machine-OS/Id/Type/Code`) exists
in the bundle but is a **separate legacy path**, not the chat transport.

Response: SSE with envelope `{statusCodeValue, body}`; markers `[DONE]`,
`[NOT_EXCEED_QUOTA]`, `[EXCEED_QUOTA]`, `[NOTIFICATIONS]#`; `finish_reason`
mapped via `jUa` (`stop→end_turn`, `tool_calls/function_call→tool_use`,
`length→max_tokens`, `refusal/content_filter/sensitive→refusal`, `null→null`);
thinking via `delta.reasoning_content` / `reasoning_item`; tool deltas via
`delta.tool_calls` (OpenAI shape, fragment streaming) or legacy `function_call`.

---

## 4. Consolidated delta table — what to align

| # | Surface | Delta | Priority | Why it matters |
| --- | --- | --- | --- | --- |
| D1 | gRPC | Add `cosy-version: 1.1.80` metadata | **HIGH** | Client-class handshake missing |
| D2 | gRPC | **Remove** `cosy-machinetype` + `cosy-machinetoken` metadata | **HIGH** | Donor never sends them on gRPC; bogus device identity can trigger server drop |
| D3 | gRPC | Use real machine OS (`${arch}_${platform}`), not hardcoded `aarch64_macos` | **HIGH** | Platform mismatch may be flagged |
| D4 | gRPC | Set channel options: `enable_http_proxy:0`, `default_authority`/`ssl_target_name_override` = host, `max_receive/send_message_length: 32 MiB` | **HIGH** | Default grpc-js 4 MiB receive cap can abort large streams; proxy env could interfere |
| D5 | gRPC | Optionally send `cosy-machinehostname` (sanitized) | MED | Identity completeness |
| D6 | gRPC | `metadata.context.client_type` — decide `"5"` vs `"6"`; donor desktop uses `"6"` | MED | Client family semantics |
| D7 | gRPC | `metadata.context.context_length` only when known/application, as string | LOW | Declared window |
| D8 | gRPC | ToolCall `arguments` as `Value` (`{stringValue}`) + include `call_id` when present | MED | Message history fidelity |
| D9 | IDE | `stream_options.include_usage` plain `true` | LOW | JSON surface, tolerant |
| D10 | IDE | `X-Request-ID` uppercase; `Cosy-Version: 1.1.80`; `Cosy-MachineOS` real; `Cosy-MachineHostname` sanitized | MED | Server-side client fingerprint |
| D11 | COSY | Confirm gateway's COSY builder matches `_8r` (plain body, `agent_id`, `chat_context`, `model_config`, `tools` array, WASM-style identity headers) | MED | Free/lite path health |
| D12 | COSY | Confirm gateway does NOT use legacy HMAC `Signature` for chat | LOW | Only relevant if using legacy endpoints |

---

## 5. Root-cause hypothesis for ECONNRESET

The gRPC path is the billed/tool path. The user's failure is a **connection
reset at the moment tool output is expected**. Given the audit:

1. **Most probable:** the gateway's gRPC metadata carries two headers the
   upstream never expects (`cosy-machinetype`, `cosy-machinetoken` with a
   random/stale device token) while missing `cosy-version` and sending a fake
   `cosy-machineos` (`aarch64_macos` on a Windows host). When the request
   transitions into a tool-calling turn (larger/different response), the
   server-side validation/classifier can refuse and reset the connection — a
   classic mid-stream `ECONNRESET`.
2. **Contributing:** default grpc-js channel options — 4 MiB
   `max_receive_message_length` and no authority/SSL overrides — differ from
   the donor's 32 MiB + authority pinning; a large tool turn or a server that
   inspects authority could abort.
3. **Secondary:** `metadata.context.context_length` is always sent as a huge
   `1_000_000`, while the donor sends it only when the client declares it. A
   server that allocates per declared window could behave differently.

These are all safe, donor-faithful changes — none alters semantics the client
sees, and all are verifiable on the already-working live gateway.

---

## 6. Proposal — fix list (ordered)

The proposals are kept as separate documents under `documentation/proposals/`
(standing repo convention), not inline here:

- **`qoder-grpc-wire-alignment.md`** — P1–P4 (gRPC metadata + channel
  options + request metadata). **Primary** — the billed `qfmodel` path and
  the ECONNRESET suspect.
- **`qoder-ide-cosy-wire-alignment.md`** — P5–P6 (IDE headers, COSY body/
  headers). Secondary — free/lite and forced-IDE paths.

Summary of the ordered work items (details in each proposal):

### P1 (gRPC metadata, `qoder-grpc.ts` / `qoderGrpcMetadata`)
- Add `cosy-version: "1.1.80"` (donor constant; keep the adapter's app-version
  in `business.version`).
- Remove `cosy-machinetype` and `cosy-machinetoken` from gRPC metadata.
- Compute `cosy-machineos` from `process.arch`/`process.platform` with the
  same mapping as the donor (`arm64→aarch64`, `x64→x86_64`).
- Add `cosy-machinehostname` via the same sanitization the donor uses
  (normalize, ≤96 chars, else sha256 suffix) — reuse/extract the existing
  `machineHostname` helper from `scripts/provider-probing/qoder/lib/shared.ts`
  into a shared source.

### P2 (gRPC channel options, `qoderGrpcClient`)
- Pass channel options to `new ChatService(addr, creds, opts)`:
  - `"grpc.enable_http_proxy": 0`
  - `"grpc.default_authority": host`
  - `"grpc.ssl_target_name_override": host`
  - `"grpc.max_receive_message_length": 32 * 1024 * 1024`
  - `"grpc.max_send_message_length": 32 * 1024 * 1024`

### P3 (gRPC request metadata)
- `context_length`: only set when the caller declared a window (or keep, but
  confirm server behavior — low priority).
- `client_type`: keep `"5"` unless evidence shows `"6"` is required for the
  billed surface; note in code comment.

### P4 (tool message history, `toProtoChatMessage`)
- Add `call_id: yG(call_id)` when present (donor `jDl`), and keep `arguments`
  as `{stringValue}` (already done).

### P5 (IDE surface, `buildQoderIdeRequest` + headers)
Verification of the current gateway code (2026-11-04) shows the body is
already donor-exact for the important fields: `stream: true`,
`stream_options.include_usage: true` (plain), `tools` injected from
`buildQoderRequest`, `parameters` passthrough, `reasoningEffort`,
`model_config`, `metadata.context`/`metadata.business`. Remaining IDE deltas:
- `X-Request-ID` → uppercase (donor `SK` normalizes to upper).
- `Cosy-Version` → constant `"1.1.80"` (currently `getQoderVersion()`; decide
  whether to pin the donor constant).
- `Cosy-MachineOS` → real platform (already dynamic in COSY; ensure IDE path
  uses the same `qoderMachineOs()`).
- `Cosy-MachineHostname` → sanitized hostname (currently absent).

### P6 (COSY surface, `buildQoderCosyRequest`/signer)
Verification of the current gateway code: URL is already donor-exact
(`/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`),
headers already use Bearer + `Cosy-*` (NOT the legacy HMAC `Signature`
path), `cosy-machineos` is dynamic, and `cosy-version` is sent. Remaining
COSY deltas to verify against donor `_8r`:
- Body shape: confirm it matches the plain `{request_id, chat_record_id,
  request_set_id, session_id, source_session_id, stream, chat_task,
  is_reply, is_retry, source, version, agent_id, aliyun_user_type,
  chat_context, session_type, task_id, system, messages, tools, parameters,
  model_config, custom_model, patches, business, custom_context}` shape
  (no `{payload}` envelope).
- `tools` as a plain array `[{type:"function", function:{name, description,
  parameters}}]` (donor `HUa`).
- `chat_context`/`model_config`/`session_type` presence.
- Machine-identity headers (`Cosy-MachineCode/Token/Type/Id/Hostname`) per
  donor `oZt`/`sZt`.

### P7 (verification)
- Re-run the live gateway matrix (tools full / no-choice / no-parallel / no-
  tools) after P1+P2; confirm no ECONNRESET over N runs.
- Add a regression test asserting the gRPC metadata keys (exactly the donor
  set) and channel options.

---

## 6a. Actual code status vs proposal (checked 2026-11-04)

| Item | Donor | Gateway code (checked) | Proposal |
| --- | --- | --- | --- |
| gRPC `cosy-version` | `1.1.80` | **missing** | P1 |
| gRPC `cosy-machinetoken/-type` | not sent | **sent** | P1 (remove) |
| gRPC `cosy-machineos` | real platform | **`aarch64_macos` hardcoded** | P1 |
| gRPC `cosy-machinehostname` | sanitized | missing | P1 |
| gRPC channel options | 32 MiB + authority + no-proxy | **defaults (4 MiB)** | P2 |
| IDE `stream_options.include_usage` | plain `true` | ✅ plain `true` | — |
| IDE `X-Request-ID` | UPPERCASE | lowercase uuid | P5 |
| IDE `Cosy-Version` | `1.1.80` | `getQoderVersion()` | P5 (pin) |
| IDE `Cosy-MachineOS` | real | ? (same as COSY?) | P5 |
| IDE `Cosy-MachineHostname` | sanitized | missing | P5 |
| COSY URL | `agent_chat_generation?...` | ✅ exact | — |
| COSY auth | Bearer + `Cosy-*` | ✅ (not HMAC Signature) | — |
| COSY `cosy-machineos` | real | ✅ `qoderMachineOs()` | — |
| COSY body shape | plain `_8r` | to verify | P6 |
| gRPC tool request (tools/choice/parallel) | donor `QFn` | ✅ verified live | — |
| gRPC response tool_calls decode | Struct → JSON | ✅ fixed + tested | — |

---

## 7. Evidence artifacts

- Bundle: `D:\tmp\unpacked\qoder\Qoder-unpacked\npm-package\package\bundle\qoder-worker-runtime.mjs`
  (offsets in tables above).
- Slice helper: `scripts/scratch/qoder-bundle-slice.ts`.
- Live gateway verification (tool fix): `scripts/scratch/qoder-gateway-live-test.ts`.
- Prior context: `2026-11-04-qoder-grpc-tools.md`, `2026-11-04-qoder-grpc-1m-context.md`.
