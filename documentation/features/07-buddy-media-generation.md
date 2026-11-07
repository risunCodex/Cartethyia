# Buddy media generation

Cartethyia routes image and video generation for the Buddy provider family
through the shared adapter in
[`buddy-media.ts`](../../src/providers/integrations/buddy/buddy-media.ts).
CodeBuddy's native image API is a single contract; do not assume the realm
variants share every endpoint.

## Current behavior

- **Image: working.** CodeBuddy image generation uses its configured native
  image path and accepts image count and size when supplied.
- **Video: not working end to end.** The Buddy family carries a video
  submission path, but the two variants differ because their base URLs already
  disagree about the version segment — do not assume they share it:

  | Variant | Base URL | Video path | Effective URL |
  | --- | --- | --- | --- |
  | `cb` | `https://www.codebuddy.ai/v2` | `/videos/generations` | `https://www.codebuddy.ai/v2/videos/generations` |
  | `cbcn` | `https://copilot.tencent.com/v2` | `/videos/generations` | `https://copilot.tencent.com/v2/videos/generations` |

  Successful video production has not been verified. Submission can return a
  task ID; the actual provider task-status/poll endpoint is unknown. The
  current `GET <submit-url>/<task-id>` poll URL in the adapter and reusable CLI
  is only a guess and has returned 404 in attempted checks.
- The CLI polls by default; `--no-wait` returns the accepted task information
  without polling.

## Video polling evidence and limitation

Video production through the Buddy family remains **unverified and currently
unsuccessful end to end**. The configured submission path exists, but it does
not establish that the generation completed or identify where to poll it. The
sibling route in the current implementation is an inference, not an observed
provider contract. A passing fake-transport test proves only that Cartethyia
constructs and handles the mocked request; it does not prove that the provider
accepts that URL. HTTP 404 responses from guessed status routes rule out those
specific attempts only.

Static inspection of the user-designated CodeBuddy installer did not
locate a reachable video submit or status-request path. The inspected first
party bundles exposed generic `video_gen` tool naming, but not the Seedance
HTTP request construction. The installer was inspected statically and was not
launched. Therefore the actual provider polling method, path, and response
mapping remain **unknown**.

Do not present the current sibling route as provider-confirmed or add further
route guesses. To resolve this, obtain a sanitized request capture from an
authorized CodeBuddy client or another version-matched source that
traces the status request to its transport call. Use an existing task ID for a
bounded, authorized read-only probe where possible; do not submit a new
generation just to discover the polling path without explicit authorization.
Follow the procedure in
[`cartethyia-reverse-engineering`](../../.skills/cartethyia-reverse-engineering/SKILL.md)
under "A desktop client that behaves differently".

## Where to change what

- Provider request construction and response parsing:
  [`src/providers/integrations/buddy/buddy-media.ts`](../../src/providers/integrations/buddy/buddy-media.ts)
- Reusable media CLI:
  [`scripts/tools/media.ts`](../../scripts/tools/media.ts)
- Provider model paths and metadata:
  [`src/providers/integrations/buddy/buddy-catalog-shared.ts`](../../src/providers/integrations/buddy/buddy-catalog-shared.ts)
- Adapter regression tests:
  [`test/providers/buddy-media.test.ts`](../../test/providers/buddy-media.test.ts)

When the polling contract is verified, update both the adapter and CLI, change
the mock to assert the observed request, and preserve the evidence level in
this page. Run the focused media tests and relevant typechecks.
