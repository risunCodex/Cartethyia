# Protocol and translation

How one client payload becomes one provider payload and back. Read this before
changing request or response handling. For the procedure to attribute a failing
request to one field, use the
[trace-replay skill](../SKILL.md) instead —
this file explains the seams, not the bisection method.

## What the gateway translates between

| Client surface | Path | Owner |
| --- | --- | --- |
| Chat Completions | `/v1/chat/completions` | `src/transport/surface/chat/` |
| Responses | `/v1/responses` | `src/transport/surface/responses/` |
| Messages | `/v1/messages` | `src/transport/surface/messages/` |
| Completions | `/v1/completions` | `src/transport/surface/completion.ts` |

Each adapter implements `SurfaceAdapter` (`src/transport/surface/adapters.ts`):
`matchesBodyShape`, `parse`, `encode`. Detection runs once, in fixed order:
`x-cartethyia-surface` header, then path, then an unambiguous body shape, then
chat as the default. Path wins over body on purpose — user-agent sniffing never
influences routing. A path-vs-body disagreement is normal traffic; only a
marker-vs-path conflict is logged at warn.

Codex and Gemini are client-visible only through their providers, not as public
surfaces. `WIRE_FAMILIES` declares four provider-side families: `chat`,
`responses`, `messages`, and `gemini`. The shared registry has codec pairs for
the first three; Gemini uses its own request/response builders. There is no
`native` family. A provider that frames its own bytes says so with
`bespokeWire` on its metadata, which exempts it from the codec matrices.
## The canonical model

`src/protocol/canonical-model.ts` holds the vocabulary both sides encode from:
`CanonicalRequest`, `ContentPart`, `CanonicalEvent`,
`CanonicalTerminalEvent`, and `UsageRecord`.

The canonical form exists so policy has one input. Routing, capability
preflight, degradation, tool repair, quota, admission, and telemetry all read
`CanonicalRequest` and never see a wire body. Adding a client field costs one
canonical field plus the codecs that carry it; adding a provider costs one codec
pair. Without a canonical form each client surface would need an N-way
translation table per provider, and a chat client could never be served by a
Messages account.

Two decisions carry most of the weight:

- **Stop reasons are canonical.** Decoders map the provider's vocabulary in,
  encoders map it back out. The raw string survives on `provider_stop_reason`
  for diagnostics, and encoders must not switch on it.
- **Tool results live in `tool` or `user` turns.** The Messages ledger re-homes
  them into `user` turns, so `canContainToolResult` is the predicate, not
  `role === "tool"`. Testing the role directly is how broken sequences reached
  upstream.

Values with no stable intersection stay opaque: `extension` parts, `reasoning`
payloads, and `GenerationControls` keys prefixed `extension:`. Reasoning is one
canonical part however the client sent it. Empty reasoning is preserved, never
invented.

## Request path

Client payload → canonical → upstream payload, in three stages.

**Parse.** `createCanonicalRequestMiddleware` picks the surface adapter and calls
`parse` (`src/transport/guards/request-context.ts`). It reads the body the
ingress policy already decoded — never a second read. Dialect-specific field
precedence lives in `src/transport/surface/dialects.ts`: `parseToolDefinition`, `parseToolChoice`, `parseReasoningIntent`,
`parseResponseFormat`. Shared content normalization is in
`src/transport/surface/content-parts.ts` (the `data:` URI split) and
`src/protocol/codecs.ts`.

**Prepare.** `ProxyRequestPreparer.prepare` (`src/transport/request/preparer.ts`)
runs everything that needs no knowledge of the chosen provider: the `model(high)`
thinking suffix is stripped before anything matches on the model name,
alias and CLI remapping resolve the target
([alias and combo resolution](../../../documentation/features/02-routing-aliases-combos.md),
[CLI model mapping](../../../documentation/features/01-cli-model-mapping.md)), corrupt attachments are
dropped, capabilities are derived and the plan is built, degraded
variants are tried when nothing supports the full request, tool rounds
are repaired, and the request is projected onto the winning candidate
(`projectForRoute`, `src/protocol/translation/capabilities.ts`). Projection
throws `capability_unsupported` rather than silently dropping semantics. The
attempt loop re-projects per candidate in
`src/transport/dispatch/proxy-request.ts`.

**Encode.** `BaseProviderAdapter.dispatch` (`src/providers/adapters/base-adapter.ts`)
calls the adapter's `preparePayload`, which for the OpenAI-compatible family
calls `encodeWireRequest` (`src/protocol/registry.ts`) → one of
`canonicalToChatPayload` (`src/protocol/request/chat.ts`),
`canonicalToResponsesPayload` (`request/responses.ts`), or
`canonicalToClaudeMessagesPayload` (`request/messages.ts`). Bespoke adapters
call their own builder: `canonicalToCodexResponsesPayload`
(`request/codex.ts`), `buildGeminiPayload` (`request/gemini.ts`).

Per-provider quirks are declarative, not scattered `delete payload.x` calls.
`src/protocol/translation/quirks.ts` holds `PARAM_QUIRKS` — a provider id,
an optional model matcher, and the strip/clamp — applied by `applyParamQuirks` before wire translation. Add a row only when a concrete upstream 400/422
proves it. Output-token bounds per wire are one table, `WIRE_TOKEN_BOUNDS`,
resolved by `resolveWireMaxTokens`, so the three codecs cannot drift; each
builder calls it (`request/chat.ts`, `request/responses.ts`). Cache
breakpoint marking is shared in `src/protocol/translation/cache-controls.ts`
because the marker differs per wire but the scan does not.

## Response path

Upstream bytes → `CanonicalEvent` stream → client wire.

Adapters yield canonical events from `transformStream`
(`src/providers/adapters/compatible-adapter.ts`). SSE bodies go through
`decodeWireStream` (`src/protocol/registry.ts`); JSON bodies through
`decodeWireResponse`. Every SSE decoder sits on the shared
`decodeSseEvents` (`src/protocol/sse-decoder.ts`), which is bounded, abort
aware, and strict — a malformed line is a 502 with `origin: "upstream"`, because
a corrupt stream must never decode as valid deltas.

The event vocabulary is small: `message_start`/`response_start`, `content_delta`,
`tool_call_delta`, `tool_result`, `usage`, `keepalive`, `error`, and exactly one
`terminal` (`src/protocol/canonical-model.ts`). `canonicalTerminal`
(`src/protocol/codecs.ts`) is the single builder, so an absent optional is
omitted rather than emitted as `undefined`. Streamed tool calls keep one id across
deltas through `src/protocol/tool-identity.ts`, whose `claimFirstEmission`
is the only gate for call-defining events — a duplicate reaches the client zero
times by construction.

**Client encoding.** Streaming frames come from `StreamEventPipeline`
(`src/transport/dispatch/streaming/encoder.ts`), which owns the surface
encoder, the terminal event, usage, and the first-byte/first-content timestamps
that finalization reads. `createDispatchStreamEncoder`
(`src/transport/dispatch/stream-bridge.ts`) picks the framing per surface:
chat and completion get unnamed `data:` frames plus an explicit `[DONE]`
sentinel, Responses get named `event:` frames, Messages get named frames with a
nested `error` object. The `[DONE]` sentinel and the error frame are emitted by
the bridge, never by an encoder (`src/transport/surface/stream-frame.ts`).
Non-streaming responses are encoded by the surface adapter directly
(`src/transport/dispatch/proxy-request.ts`).

**Usage.** Canonical `UsageRecord` keeps the cache split explicit —
`cached_input_tokens`, `cache_write_tokens`, `uncached_input_tokens` — and each
is `number | "unavailable"`, never a silent zero. Providers that repeat
usage across lifecycle frames are merged by taking the largest cached count
rather than the last one (`src/protocol/response/responses.ts`). The terminal
event's usage wins; a stream with none falls back to
`estimatedUsage(input, output)` (`src/transport/dispatch/attempt-finalize.ts`),
whose `estimated_cost` is `null`, not `0` — unpriced is not free, and the
console's `partial` flag depends on that distinction. `repriceUsage`
(`src/providers/provider-usage.ts`) applies the routed model's catalog rate before the
record is committed, then the wire converters in the same file
(`usageToChatWire` :356, `usageToResponsesWire` :384, `usageToMessagesWire`
:410) render it per surface.

## Error mapping

A provider failure becomes a client-visible error at one of two boundaries, and
both produce the same `GatewayError` so the classification cannot disagree.

`mapUpstreamHttpError` turns a failed HTTP response into a typed error, reading
a machine-readable identifier before falling back to status. Prose is consulted
only to recognize an overflow that names both the measured size and the window,
never as a substring rule. `stream-error-frames.ts` applies the same classifier
to an error envelope that arrived after a 200 status line.

Every error carries `code`, `status`, `origin` (`cartethyia`, `upstream`,
`network`), and `details`. Origin matters: a corrupt SSE stream labelled
`invalid_request` told the client its request was wrong and invited a retry
against a broken upstream. `classifyUpstreamFailure` decides retryability and
account health from that same record, so failover and cooldown never disagree.

Public text goes through `formatPublicErrorMessage`: the code travels in
`error.code`, not prefixed into the sentence. `publicGatewayErrorDetails` is an
allowlist, so an upstream payload cannot leak into the envelope.
`createErrorNormalizationMiddleware` is the gateway error serializer. The
console shapes its errors through its own domain hooks and `errorResponse()`.

Surface failures are typed subclasses: `MessagesLedgerError` for a tool ledger
mismatch, `ResponsesSequenceError` and `ResponsesLifecycleError` for sequence
and lifecycle violations.

## Where to change what

| Change | Start here |
| --- | --- |
| New client request field | `protocol/canonical-model.ts`, then the surface `parse` + `dialects.ts`, then every codec that must carry it |
| New client response field | the surface encoder (`surface/*/encode.ts` or `messages/stream.ts`), and the decoder that must produce the event |
| New wire family | `canonical-model.ts` (`WIRE_FAMILIES`), `protocol/registry.ts`, a `protocol/request/*` + `protocol/response/*` pair, `capabilities.ts` matrices |
| Provider rejects a control combination | `protocol/translation/quirks.ts` (one row, only with a proven 400/422) |
| Output-token floor/ceiling differs per wire | `WIRE_TOKEN_BOUNDS` in `quirks.ts`, then the builder that calls `resolveWireMaxTokens` |
| Capability not granted to a route | `capabilities.ts` (`routeCapabilitiesFor`, `deriveRequiredCapabilities`) and the snapshot profile in `routing/route-catalog.ts` |
| Tool-call ids or indexes disagree across frames | `protocol/tool-identity.ts`, then `protocol/translation/tool-repair.ts` |
| Upstream error lands with the wrong code | `transport/failure-policy.ts` (`classifyUpstreamError`), plus `protocol/stream-error-frames.ts` for in-stream cases |
| Public error envelope shape | `protocol/gateway-error.ts`, then `transport/guards/error-lifecycle.ts` |
| Usage or cost is wrong | decoders → `UsageRecord`; pricing is `repriceUsage` in `providers/provider-usage.ts` |
| Streaming frames or `[DONE]` | `dispatch/stream-bridge.ts`, then the surface encoder |
| Surface detected as the wrong family | `transport/surface/adapters.ts` (`SURFACE_DESCRIPTORS`, `detectOnce`) and the adapter's `matchesBodyShape` |

## Not covered here

Reproducing a failure, bisecting a payload, remote debugging against a live
gateway, and proving a test locks the fix are owned by the
[trace-replay skill](../SKILL.md). Routing,
eligibility, leases, and account cooldowns are covered by the
[architecture reference](../../../documentation/reference/architecture.md) and
[health-routing skill](../../cartethyia-health-routing/SKILL.md).
Provider registration and catalogs are covered by the
[backend reference](../../cartethyia-engineering/references/backend.md) and
[provider-catalog skill](../../cartethyia-provider-catalog/SKILL.md).
