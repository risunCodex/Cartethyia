# Copilot Auto → Responses 500: `repairToolArguments` jsonrepair throw

## Summary

Live `github/gpt-6-luna` requests failed with HTTP 500 `internal_error`
(origin `cartethyia`) after the Copilot `/auto` selection succeeded. The
upstream never saw the second (inference) request: the gateway crashed inside
the Responses payload encoder while repairing a **tool-call argument that
jsonrepair cannot repair**, and the throw escaped as a generic 500 instead of
the raw tool-argument text.

Root cause is a missing try/catch in `repairToolArguments`
(`src/transport/surface/chat/encode.ts`): `jsonrepair()` throws on text that
is not near-JSON (e.g. a multiline `*** Begin Patch` fragment), and that throw
bubbled through `canonicalToResponsesPayload` → `preparePayload` → the error
middleware as `internal_error`.

## Reproduction

- Trace: `C:\Users\Aria\Desktop\500-github.json` (telemetry request detail,
  one failing request captured verbatim).
- Local account: `github/jinhsera-design` (OAuth, active) in the local Lite
  SQLite DB.
- Verbatim replay against the local gateway reproduced the 500 (repeatable).
- A second gateway instance (port 12802) on a `VACUUM INTO` copy of the local
  DB reproduced the same 500; its stderr capture (via a temporary diagnostic
  log in the error middleware, since removed) produced the stack:

```
Error: Object key expected at position 51
    at throwObjectKeyExpected (jsonrepair.js:768)
    at parseObject (jsonrepair.js:235)
    at repairToolArguments (src/transport/surface/chat/encode.ts:40)
    at canonicalToResponsesPayload (src/protocol/request/responses.ts:132)
    at encodeWireRequest (src/protocol/registry.ts:169)
    at preparePayload (src/providers/adapters/compatible-adapter.ts:216)
```

## Mechanism

1. The Copilot `/auto` selection (`POST https://api.individual.githubcopilot.com/auto`)
   returned `selected_model.id = "gpt-6-luna"` with
   `supported_endpoints: ["/responses","ws:/responses"]`.
2. `routeFromAutoModel` therefore routed the follow-up inference to the
   **Responses** wire (`GITHUB_RESPONSES_ENDPOINT_PATH`), one fewer round trip
   than the older roster lookup.
3. The Responses encoder (`canonicalToResponsesPayload`) rewrites every tool
   call argument with `repairToolArguments`.
4. One tool call in the captured payload was the agent's `patch` tool whose
   argument is a multiline patch header (`*** Begin Patch\n*** Update File: …`)
   — not JSON, and not near-JSON.
5. `jsonrepair` throws `Object key expected at position 51` on that text.
   `repairToolArguments` only guarded the *parse validation* inside a
   try/catch; the repair call itself sat outside it, so the throw escaped.

The intended contract was already documented in the function: “anything that
does not parse *to an object* is discarded in favour of the original text”.
The implementation accidentally failed to cover the repair step itself.

## Fix

`src/transport/surface/chat/encode.ts` — move the whole repair+validate cycle
inside the try/catch:

```ts
export function repairToolArguments(raw: string): string {
  if (raw.length === 0) return "{}";
  try {
    const repaired = repairToolArgumentText(raw);
    const parsed: unknown = JSON.parse(repaired);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    return repaired;
  } catch {
    return raw;
  }
}
```

A tool argument that fails repair now passes through unchanged (as the raw
string), matching the documented non-object policy. The caller (tool identity
/ upstream) then sees the original argument instead of a 500.

Regression test: `test/transport/chat-tool-argument-repair.test.ts` — new case
feeding a multiline patch header that makes `jsonrepair` throw, asserting the
raw text is returned unchanged.

## Proof

| Check | Before | After |
|---|---|---|
| Verbatim replay, local gateway | 500 `internal_error` | 200, streaming `gpt-6-luna` |
| Diagnostic error log | `Object key expected at position 51` stack | none |
| `chat-tool-argument-repair` suite | — | 10 pass (incl. new case) |
| Full backend suite | — | 4186 pass / 6 skip / 0 fail |

Other affected call sites of `repairToolArguments` (`encode.ts:250`, chat
wire; `responses.ts:132`) benefit from the same hardening.

## Why this only surfaced now

GitHub Auto previously routed to `/chat/completions`; the `gpt-6-luna`
selection advertises `/responses`-only endpoints, so the tool-argument repair
path in the Responses encoder became reachable for these models. Any
non-JSON tool argument (patch fragments, truncated streaming artifacts) can
hit it.

## Hygiene

All replay material, the second gateway instance, and the DB copy were
scrubbed afterward. No credentials were printed; the diagnostic log was
reverted before completion.
