# Qoder prompt-cache: upstream does NOT report cache hits

**Date:** 2026-11-05 · **Probe:** `scripts/provider-probing/qoder/direct/direct-cache-hit.ts`

## Question

Does the Qoder gRPC upstream report prompt-cache hits? The `Usage` proto
carries `prompt_tokens_details.cached_tokens` / `cacheable_tokens`, but the
field had never been observed on the wire. If the upstream is silent, the
gateway should apply the shared session-cache estimator (the Trae/Kiro
workaround) to Qoder too.

## Setup (direct gRPC, gateway-identical shape)

- Credential: OAuth device token (`dt-…`), used directly as Bearer (same as
  `qoderOAuthAuth` / gateway gRPC path).
- Session id: **stable** `qoderSessionId(userId, model)` — NOT a fresh id per
  call — so upstream byte-identical prefix caching can engage.
- Same request shape as the gateway: `stream_options.include_usage`, `metadata`
  context block, `cosy-*` headers, `context_length: "8000000"`.

Call sequence (all share message P; user-level plain text):

| call | messages | meaning |
|---|---|---|
| A1 | `[P]` | fresh |
| A2 | `[P]` | byte-identical repeat → full hit if cached |
| A3 | `[P, R1]` | repeated prefix P → partial hit if cached |
| A4 | `[P, R1, R2]` | repeated prefix P+R1 → partial hit if cached |

## Observed usage (model `dfmodel`, realm intl)

| call | prompt_tokens | cached_tokens | cacheable_tokens | reasoning_tokens |
|---|---|---|---|---|
| A1 | 49 | — (absent) | — (absent) | 68 |
| A2 | 49 | — (absent) | — (absent) | 37 |
| A3 | 64 | — (absent) | — (absent) | 331 |
| A4 | 75 | — (absent) | — (absent) | 629 |

- `prompt_tokens_details` is **absent entirely** in every chunk — not `0`, not
  an empty object. The upstream never emits the details field.
- `extras` empty in all calls; trailers carry only `x-request-id`.
- No `cached_tokens > 0` ever observed.

## Verdict

**Qoder gRPC does NOT report prompt-cache hits.** Even byte-identical repeats
in the same stable session show no cached/cacheable token counts. The underlying
models may well cache internally, but the wire never tells us.

Score: prompt_tokens *unchanged* across repeat calls (49 → 49) — consistent
with either a real cache (not reported) or a pure stateless fee model. Note:
the provider may be charging per-request without a cache discount, which would
make estimation a *pricing-correctness* fix, not just telemetry cosmetics.

## Status (2026-11-05, after fix)

**Implemented:** the shared session-cache estimator is now wired for Qoder
(`src/providers/integrations/qoder/qoder-cache.ts`), exactly like Trae and
Kiro. The gRPC surface also had to be fixed to *carry* usage: the upstream
streams `usage` in a trailing chunk *after* the finish-reason chunk, and the
old code skipped it once `finished` was set — so no usage reached telemetry at
all. `usage` is now attached to the terminal event (the IDE surface shape),
which both restores telemetry and lets the estimator run.

Verified live (gateway, `qoder/ultimate`, two byte-identical streamed
requests):

| request | input_tokens | cached_input_tokens |
|---|---|---|
| #1 fresh | 32 | null (no history yet) |
| #2 identical | 32 | **32** (100% cached estimate) |


## Implication / next step (next version — NOT a hotfix)

Apply the shared estimator to Qoder, exactly like Trae and Kiro:

- `src/providers/integrations/shared/session-cache.ts` (factory is
  per-provider isolated; wrapper files exist for `trae-cache.ts` /
  `kiro-cache.ts`).
- Wire a `qoder-cache.ts` wrapper, call it in the Qoder adapter where the
  usage record lands (gRPC terminal event / `usageFromProvider` output),
  passing the canonical messages and the session id
  (`qoderSessionId(userId, modelId)`).
- The estimator already trusts a genuine upstream report (>0) when one exists;
  it only fills the gap when the upstream reports nothing — which for Qoder is
  every call today.
- Verify: cached `input_tokens` surface in chat/responses/messages surfaces
  (usage encode paths already read `cached_input_tokens`), and console usage
  shows non-zero cache reads for multi-turn sessions.

## References

- `src/providers/integrations/qoder/chat-proto.ts` — `Usage.prompt_tokens_details`
  (field exists in proto, upstream never fills it).
- `src/providers/provider-usage.ts` — `normalizeUsage` reads
  `prompt_tokens_details.cached_tokens`; absent → `cached_input_tokens:
  "unavailable"`.
- `src/providers/integrations/shared/session-cache.ts` — the estimator used by
  Trae/Kiro.
- `src/providers/integrations/trae/trae-cache.ts`, `kiro/kiro-cache.ts` —
  wrapper pattern to follow.
