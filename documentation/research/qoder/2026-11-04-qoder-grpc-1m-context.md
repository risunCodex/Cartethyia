# Qoder context windows — the 1M-token path is gRPC (2026-11-04)

## TL;DR

Qoder advertises 1M-token context windows (`context_config` / 1M/400K/200K)
on its model roster. **The HTTP IDE surface cannot carry them**: it hard-fails
with `500 {"error":"internal server error"}` as soon as the request body
exceeds ~256 KiB (~60K tokens of ASCII). The **gRPC surface
(`model.chat.ChatService/ChatCompletionStream`) accepts bodies up to ~8M
characters (~1.9M tokens)** — verified live, streaming 200 with real chunks.
The gRPC path is therefore the only proven route for real 1M-token context.

## Verification table (live, account `Akun Ytprem`, model `dmodel`)

| Surface | Payload | Result |
| --- | --- | --- |
| HTTP `/model/v1/chat/completions` | 260K chars (~62K tok) | 200, streams |
| HTTP | 270K chars (~64K tok) | **500 internal server error** |
| HTTP | 300K–1M chars | **500** |
| HTTP (gzip `Content-Encoding`) | 300K+ | 400 `invalid_request_error` (gzip not accepted) |
| HTTP (split across 10 messages) | 270K+ | **500** (byte total matters) |
| HTTP (`context_length` in parameters) | 300K | **500** (does not raise cap) |
| gRPC `ChatCompletionStream` | 300K | 200, streams (17 chunks) |
| gRPC | 800K | 200 |
| gRPC | 1.5M (~360K tok) | 200 |
| gRPC | 3M | 200 |
| gRPC | 4.2M (**≈1M tok**) | **200, streams** ✅ |
| gRPC | 6M | 200 (slow, ~2–3 min) |
| gRPC | 7M | 200 |
| gRPC | 8M | 200 |
| gRPC | 9M | **413 Upstream error** |
| gRPC | 10M | 413 |

HTTP cap ≈ **256 KiB** (~262K ASCII chars). gRPC cap ≈ **8M chars** (~1.9M
tokens) — comfortably above 1M tokens.

## Why the HTTP cap exists

- The 500 is an HTTP-layer limit, not a Qoder API error: the Qoder error
  vocabulary (`QoderApiError`) has `80411 inputContentTooLong`, but it never
  surfaces — the request dies at the proxy/body layer first:
  `{"error":"internal server error"}`.
- Request gzip is rejected (`400 invalid_request_error`), so no compression
  escape hatch on HTTP.
- Splitting content across messages does not help — the cap is the total body
  byte size.
- `parameters.context_length` / `metadata.context.context_length` (the field
  the desktop client sets from its context-window selector) does not raise the
  cap either.
- Qoder does **not** retain history per `session_id`: a marker sent in turn 0
  is unknown in turn 1 ("I don't have to the first message of this…"). So a
  1M-token context cannot be accumulated across turns either — every request
  must carry its full context inline.

## The gRPC surface

From the unpacked Qoder desktop client (worker runtime
`qoder-worker-runtime.mjs`, v1.1.81, bundled `proto/chat.proto`):

```
service model.chat.ChatService {
  rpc ChatCompletion(ChatCompletionRequest) returns (ChatCompletionResponse);
  rpc ChatCompletionStream(ChatCompletionRequest) returns (stream ChatCompletionChunk);
}
```

- Endpoint: `https://{model-server-host}:443/model.chat.ChatService/ChatCompletionStream`
- Model-server host (prod): `api2-v2.qoder.sh` — same host as the HTTP IDE
  surface; the cap difference is the transport (protobuf framing vs JSON).
- Auth: gRPC metadata `authorization: Bearer <token>` (same token as HTTP),
  `x-request-id`, `x-session-id`, `cosy-clienttype`, `cosy-machineos`,
  `cosy-machinetype`, `cosy-machinetoken`.
- The desktop client builds the request via `QFn()` (maps the OpenAI-shaped
  body onto the proto, including `metadata.context.context_length`); the
  gRPC path is used when the transport is configured as `grpc`
  (`settings.transport.protocol = "grpc"`), and the opencode CLI has a
  `--context-window <size>` flag that sets the same `context_length`.

## Implications for the gateway

1. To actually deliver 1M-token context, the Qoder adapter must send **gRPC**
   (new transport), not the HTTP IDE surface.
2. The static/dynamic roster already picks `max_input_tokens` = widest window
   (1M). With gRPC that declaration becomes real.
3. Keep HTTP as a fallback for small contexts (< ~60K tokens) — it is simpler
   and faster; switch to gRPC when the body would exceed ~256 KiB.
4. No session-side accumulation is available, so a 1M-token request must be a
   single gRPC call with the full history inline. At ~8M chars ceiling the
   practical token budget is ≈1.9M tokens — enough for 1M.

## Evidence artifacts

- Unpacked client: `D:\tmp\unpacked\qoder\Qoder-unpacked\npm-package\package\bundle\qoder-worker-runtime.mjs` (35 MB) and `proto/chat.proto`.
- Probe scripts (scratch):
  - `D:\tmp\grpc-test\qoder-grpc-probe.ts` (gRPC live probe)
  - `scripts/provider-probing/qoder/qoder-context-probe.ts` (HTTP live probe)
  - `scripts/provider-probing/qoder/qoder-session-retention-probe.ts` (retention check)
- Roster source of truth (live): `GET /algo/api/v2/model/list?Encode=1` — every
  lite-plan slot carries `context_config: {1M, 400K, 200K}`.
