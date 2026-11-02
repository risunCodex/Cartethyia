# Vision handoff on large CLI sessions (2026-11-02)

## Symptom

On a large opencode session, attaching an image to Mercury 3 (non-vision)
broke the request upstream:

- `platform_unavailable` / HTTP 502 from `api.inceptionlabs.ai`
  (`{"error":{"message":"The server had an error while processing your request."}}`),
  or `ECONNRESET` on streaming replays.
- After a few 502s, routing started answering 429 `accounts_rate_limited`
  ("Every account serving 'inception/mercury-3' is cooling down") even while a
  freshly-added sibling account was healthy — the cooldown machinery had
  cooled the account that kept failing the giant payload.

A small fresh chat with the same image worked fine.

## Evidence

Telemetry frame `9cd66a3e-65bf-4ef9-95e4-277a44b82840` (provider request body):

- 782 messages, 1 398 280 chars total body, 774 tool calls.
- The handoff itself had succeeded: the last user turn carried the image
  description. The body size was the problem, not the image.

Live replays of the exact payload:

- `stream: false` → 200 (even at 1.4MB).
- `stream: true` → `ECONNRESET` (socket dropped mid-response), recorded as
  `transport_closed` / cancelled.
- Same payload after condensing history to `system + active turn` (~61KB) with
  `stream: true` → 200 in ~2.6s, `input_tokens` 16K (vs 356K before).

## Root cause

`replaceImagePartsWithText` only swapped image parts for text; the rest of the
session (hundreds of tool-result turns) was forwarded verbatim to the main
model. Upstreams reset/reject those multi-megabyte streaming bodies. Repeated
failures then advanced account health → cooldown → false 429 even with a
healthy sibling (the sibling was unused because the failing account remained
the routed candidate / continuation pin).

## Fix

`condenseHandoffRequest` in `src/transport/request/preparer.ts`:

- Runs before `replaceImagePartsWithText` (while the active turn still carries
  its image, so it can be located).
- When the session is huge (>100 messages or >200K chars), returns only the
  system prompt + the active image-carrying turn; small requests pass through
  untouched.
- The description is framed as `[The user attached an image. A vision model
  described it for you: …]` so the main model does not treat it as user prose.

Verified on the real failing payload: 782 messages → 2, 1.18M chars → 61K,
streamed 200 (previously ECONNRESET/502).
