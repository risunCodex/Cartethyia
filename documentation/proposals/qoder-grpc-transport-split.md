# Proposal — Qoder transport split + gRPC 1M-context adapter

Status: proposal (2026-11-04)
Owner: `src/providers/integrations/qoder/`
Evidence: `documentation/research/qoder/2026-11-04-qoder-grpc-1m-context.md`

## Problem

1. **Qoder advertises 1M-token windows but the HTTP surface cannot deliver
   them.** The modern HTTP surface (`/model/v1/chat/completions`) hard-fails
   with `500 internal server error` once the request body exceeds ~256 KiB
   (~60K ASCII tokens). Verified live across sizes, gzip, split messages, and
   `context_length` parameters — none raise the cap.
2. **`qoder.ts` is bloated.** 1,892 lines mixing COSY signer, PAT/job-token
   exchange, legacy body builder, modern IDE body builder, SSE→canonical
   parser, leak-marker heuristics, and the adapter class. A third transport
   (gRPC) cannot be added on top cleanly.

## Goal

- Add a **gRPC transport** (`model.chat.ChatService/ChatCompletionStream`)
  capable of carrying real 1M-token contexts (~8M chars ceiling, verified).
- **Split `qoder.ts`** into cohesive modules so each transport is a peer.
- Keep the HTTP surface for small contexts; route to gRPC when body size
  warrants it (or when configured).

## Facts that constrain the design

- gRPC host = same as HTTP (`api2-v2.qoder.sh` for intl prod), port 443,
  path `/model.chat.ChatService/ChatCompletionStream`.
- Auth = same bearer token, delivered as gRPC metadata:
  `authorization`, `x-request-id`, `x-session-id`, `cosy-clienttype`,
  `cosy-machineos`, `cosy-machinetype`, `cosy-machinetoken`.
- Proto is bundled in the unpacked client (`vendor/qoder-proto/chat.proto`); the repo has
  no `.proto` yet — we may either vendor it or generate TS from it.
- The desktop client builds the gRPC request via `QFn()`: OpenAI-shaped body
  mapped onto the proto, `metadata.context.context_length` set from the
  context-window selector. `max_tokens`/`stream` are protobuf wrappers
  (`Int32Value`/`BoolValue`), not scalars.
- gRPC errors surface as gRPC statuses; oversized requests came back as
  `13 INTERNAL: Stream error: 413 Upstream error [stream]` (still 413
  semantics — keep classifying as `context_length_exceeded`/`request_too_large`).

## Module split (target)

```
src/providers/integrations/qoder/
  qoder.ts                  # public surface ONLY: createQoderAdapter/createQoderCnAdapter,
                            #   provider id/registration, re-exports. (~150 lines)
  qoder-types.ts            # QoderAuth, QoderModelConfig, QoderRealm, QoderFetcher,
                            #   shared interfaces. (moved)
  qoder-auth.ts             # PAT/job-token exchange, OAuth identity, machine ids.
                            #   (from qoder.ts:213–442)
  qoder-signer.ts           # COSY signer: alphabet, transformQoderBody, buildCosyHeaders,
                            #   qoderPathSignature. (from qoder.ts:119–372)
  qoder-body.ts             # canonical→Qoder message flattening shared by all transports:
                            #   flattenCanonicalContent, qoderStableRecordId, tool mapping,
                            #   reasoning echo, system prompt assembly. (from qoder.ts:573–796)
  qoder-http.ts             # HTTP surfaces: buildQoderRequest (legacy COSY body),
                            #   buildQoderIdeRequest (modern body), qoderIdeHeaders,
                            #   callQoderIde, entitlement refusal, empty-recovery.
                            #   (from qoder.ts:798–1332)
  qoder-grpc.ts             # NEW transport: proto load, client factory, request mapping
                            #   from the shared canonical body (QFn equivalent), metadata,
                            #   stream→canonical events, status→GatewayError mapping.
  qoder-stream.ts           # SSE frame parsing + canonical event projection
                            #   (from qoder.ts:1342–1667) + gRPC chunk→canonical events.
  qoder-catalog.ts          # roster parse/discovery (unchanged)
  qoder-virtual.ts           # virtual-model mapping (unchanged)
  qoder-oauth.ts            # device login (unchanged)
  qoder-quota.ts / qoder-checkin.ts / qoder-realm.ts / qoder-umid.ts  # unchanged
  vendor/qoder-proto/chat.proto    # vendored gRPC schema (+ generated client if TS-safe)
```

`QoderAdapter` lives in `qoder.ts` and selects transport by policy:

```
transport = chooseTransport(modelId, bodyBytes, config)
  default: grpc            // proven 1M-capable
  fallback: http-ide       // when body < ~256 KiB and grpc unavailable
  legacy cosy               // existing free-tier 402 fallback unchanged
```

## gRPC transport design

- **Client**: bundle `@grpc/grpc-js` + `protobufjs` (or the exact versions
  the desktop client bundles) as optional deps, or generate a minimal
  protobuf encode/decode with `protobufjs` static codegen at build time.
- **Request mapping** (`QFn` equivalent):
  - `messages[]` → `ChatMessage { role, text_content | parts_content }`
  - `tools[]` → `Tool` / `Function` (with `parameters` Struct)
  - `stream: true`, `max_tokens` (Int32Value), `temperature` (DoubleValue)
  - `metadata.context` → `ContextMetadata { request_id, session_id, task_id,
    request_set_id, client_type, source_session_id }`
  - `metadata.business` → `BusinessMetadata { product, type, version, scene }`
  - context window → `metadata.context.context_length = String(window)` (as the
    desktop client does)
- **Streaming**: consume `ChatCompletionChunk` stream; map `delta.content`,
  `delta.reasoning_content`, `choices[].finish_reason`, `usage` to canonical
  events (reuse `qoderBodyToCanonicalEvents` shape).
- **Errors**: map gRPC statuses → GatewayError:
  - `13 INTERNAL` + `413` → `context_length_exceeded` (413)
  - `16 UNAUTHENTICATED` → `authentication_failed`
  - `4 DEADLINE_EXCEEDED` → `deadline_exceeded`
  - else → `platform_unavailable` / `upstream_unprocessable`

## Routing policy (body-size aware)

- Compute outbound body byte size before dispatch (JSON or protobuf).
- If `grpc` transport is available and body > ~240 KiB → send gRPC.
- Otherwise HTTP modern surface (current default for small bodies).
- Legacy COSY fallback (free-tier 402) unchanged.

## Open questions

1. **Dependency policy**: add `@grpc/grpc-js` + `protobufjs` (or the exact
   pinned versions from the client) to `package.json`. The gateway currently
   has no gRPC deps; this is a new, justified one.
2. **Proto source**: vendor `chat.proto` from the unpacked client verbatim
   (with provenance comment), or generate TS from it.
3. **`QODER_MODEL_SERVER_HOST` override** (env in the client) — decide
   whether the gateway exposes a similar config knob for the gRPC host.
4. Timeouts: gRPC 6M+ requests take minutes; make sure upstream deadline
   lifecycle and idle timeouts accommodate large streams.

## Estimated impact

- `qoder.ts` shrinks from ~1,890 → ~150 lines (public façade).
- No behavior change for HTTP path (pure move + re-export).
- New gRPC path active only when body size/transport policy selects it.
- Tests: keep existing transport tests green; add gRPC tests with a fake
  gRPC server (or a stub `ChatService`) covering mapping, streaming, error
  classification, and the body-size switch threshold.

## Acceptance criteria

- [ ] `qoder.ts` split landed; existing tests pass unchanged.
- [ ] gRPC transport sends a 1M-token request (≈4.2M chars) successfully
      against live Qoder (manual verification gate).
- [ ] Small-body requests still use HTTP by default (no perf regression).
- [ ] 413 gRPC error maps to `context_length_exceeded` (client sees a clear
      "context too large" instead of a generic 500).
- [ ] Docs updated: research ledger + `documentation/reference/providers.md`.
