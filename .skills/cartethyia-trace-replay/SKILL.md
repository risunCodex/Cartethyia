---
name: cartethyia-trace-replay
description: "Attribute a failing request to one field: replay it verbatim, bisect until it turns 200, fix the owning layer, prove the flip. Use for a Request Detail, error envelope, 4xx/5xx trace, or payload dump — plus pulling the evidence off a remote deployment you cannot read from disk."
---

# Trace replay and bisection

Use when a request failed and the cause is not yet pinned to a specific field.
The seam map — wire families, the canonical model, and where a dialect is
applied — is `references/protocol-and-translation.md`.

Method: **reproduce the exact failure, then vary one thing at a time.** A field
whose controlled addition or removal flips the result is the isolated trigger;
confirm its mechanism in the owning layer before calling it the root cause. Do
not stop at a plausible-looking suspect or a one-off status change.

This method attributed a `400 model_param_invalid` on a 3.16M-char prompt to an
**absent** `max_tokens` — not to payload size and not to `reasoning_effort`,
both of which looked like better suspects.

## Steps

1. **Reproduce verbatim** — send the captured body unchanged. If it does not
   fail, you do not yet have the failure. Find out why before bisecting
   (different route, key, or deployment state).
2. **Repeat the baseline.** A single 400 may be transient. Replay it a small,
   bounded number of times and confirm the same failure before bisecting.
   Repeated failures establish a reproducible baseline, not proof that every
   run will fail. Stop early if the endpoint applies rate limits or bans.
3. **Bisect** on the full payload — strip optional controls one at a time
   (`prompt_cache_key`, `reasoning_effort`, `stream_options`, `thinking`,
   `reasoning_summary`), then shrink size, then **add** the field you suspect is
   missing.
4. **Attribute** the field to its owner in this repo (below), and fix there.
5. **Prove the flip** against a real instance, and prove the test locks it.

## When the cause is absent, not present

Bisect-by-removal finds a field that is *wrong*. It cannot find a field that is
**missing**, and worse, removal can flip a status for the wrong reason — strip
`tools` to shrink a body and a gate that reads `tools` membership changes its
answer, which reads like "size" or like a tool-shape bug.

Two tells that the arm is a membership test rather than a field value:

- **Adding** the suspected thing fixes it (not removing it).
- The gate accepts the required set **alongside** unrelated entries — it is
  "contains", not "equals". If the required names plus 128 foreign ones still
  pass, nothing needs to be dropped. Read the required count from
  `FREE_AGENT_TOOL_NAMES_ORDERED` rather than from any doc: it has grown, and
  comments naming a number have gone stale with it.

So when removal has not isolated the cause within a few arms, run the mirror
experiment: take the minimal known-good set, then add one thing at a time to the
failing body. The thing that turns 200 is the gap.

Then check the **pipeline that produces the payload**, not just its final shape.
A backfill that adds a required field and a later clamp/trim/dedupe that removes
it compose into a payload with neither — both sites look correct in isolation.
Reproduce by emulating each stage in order over the captured body and printing
what survives each one.

Gates known to work this way: OpenCode's free tier reads an agent-tool
fingerprint set out of `tools` — see
[`references/opencode-free-tier.md`](references/opencode-free-tier.md).

## Read the decisive test

Same failing body, only that field varies:

| Variation | Reading |
|---|---|
| No `max_tokens` fails, `max_tokens=1` passes | Upstream rejects the **absent** field, not its magnitude |
| Fails at every value | The field is wrong, not missing |
| Passes small, fails large | Size-bound — binary-search the threshold |

Binary-search rather than guessing: known-good low, known-bad high, halve until
they meet. A sharp threshold is a real bound; a fuzzy one usually means you are
not measuring the right variable.

Read the provider's own response/code, not just the gateway's. When retained,
`details.providerCode` may carry it (`model_param_invalid`, `11133`, `11148`);
the public `message` is often generic and names nothing.

**Guard against the size red herring.** A large failing payload makes you
suspect size. Before concluding that, add a tiny explicit limit. If the same
large body with `max_tokens=1` returns 200 under otherwise identical
conditions, that test rules out total prompt size as the trigger; it does not
prove every provider/model accepts every larger body. Treat the field whose
presence changes the result as the trigger, then verify its mechanism.

## Where the owner usually is

| Suspect | Owner |
|---|---|
| Output-limit fields | `WIRE_TOKEN_BOUNDS` / `resolveWireMaxTokens` in `src/protocol/translation/quirks.ts` |
| Chat body | `canonicalToChatPayload` in `src/protocol/request/chat.ts` |
| Responses body | `canonicalToResponsesPayload` in `src/protocol/request/responses.ts` |
| Provider-specific hooks | `buddyPrePayloadCommon` in `src/providers/integrations/buddy/buddy-chat-shared.ts`, and each adapter's `prePayload` |
| Error mapping/classification | `mapUpstreamHttpError` in `src/transport/failure-policy.ts` |
| `tools` array membership / trim | `clampOpenCodeTools` and `ensureFreeAgentRequest` in `src/providers/integrations/opencode/provider.ts` |
| Free-tier refusal (403 `FreeTierError`) | the adapter's fingerprint set, not auth — see [`references/opencode-free-tier.md`](references/opencode-free-tier.md) |

A call site that consults the bound table **only when the caller sent a value**
forwards an omitted field as absent. Look for `if (typeof x === "number")`
guards around a resolver that also owns a default: the default exists but is
unreachable. That is the shape of this bug class.

Fix the owner, not the adapter that reported it, so every upstream on that wire
gets the guard.

## Image and video replay

Identify the listener before bisecting. `Get-NetTCPConnection -LocalPort 12800
-State Listen` reports a process id, not its command line; inspect the owning
process to confirm it is the intended source or compiled gateway. An old
compiled gateway or a cached adapter can answer with the old payload. Do not
assign `$pid` in PowerShell; it is read-only.

Capture the body at the last boundary that still owns it. For Codex, compare
the object passed to `postUpstreamJson` with the string it hands to the
validated `outboundFetch` (`src/protocol/upstream/post-json.ts`).
If both contain `tools` and the upstream still says `tool_choice` must be
specified with `tools`, those captures did not isolate a missing field. Check
serialization, headers, endpoint, and account/endpoint expectations before
excluding the body entirely. Replay directly only when authorized.

A 200 chat response is not an image. Proof is an `image_generation_call` or
`inlineData` whose decoded bytes start with `89 50 4E 47` (PNG) or `FF D8 FF`
(JPEG). Wire owners and account-boundary errors are in the
[provider-catalog skill](../cartethyia-provider-catalog/SKILL.md).

A 403 or chat-only 200 from `cli-chat-proxy.grok.com` is not necessarily a
payload bug, and the checked-in Grok integration does not implement the console
video flow. Re-check the endpoint and auth with an authorized probe before
changing an adapter.

## Wire bytes and payload capture

When the failure needs the actual bytes rather than a bisect, read
`references/payload-and-tracing.md` — frame layout, the four surfaces to
compare, SSE replay, and what must never be logged.

## Remote debugging

The first-boot setup seeds a tenant API key from `CARTETHYIA_API_KEY` (or
generates one). Requests authenticate against the persisted key, not an
environment fallback, and that key gets `TENANT_KEY_SCOPES`
(`src/security/access-control.ts`), not `platform:admin`. Probe only an
instance and key you are authorized to use.

```bash
curl -s "https://<host>/v1/models" -H "Authorization: Bearer <key>"
```

Two things block a probe before any application code sees it:

- **Cloudflare 1010** — an edge rejection, not an application response.
  Matching the failing client's `user-agent` makes the probe comparable; it
  does not bypass a browser-integrity challenge.
- **401 from an edge proxy** (openresty, APISIX) — rejected before the gateway.
  It says nothing about the payload. Resolve edge auth with the instance owner
  first.

**Getting the recorded request off an instance you cannot read from disk** —
the console endpoints that list and export it, the two auth domains, and the
egress-IP rule for a 403 that survives every payload change — is
[`references/remote-debugging.md`](references/remote-debugging.md). Export the
payload from there rather than retyping it; a retyped body is not the failure.

## Prove the flip

Unit tests and typecheck do not prove a wire change. Replay the original
failing body against an instance carrying the change and compare the result.

```bash
PORT=12801 CARTETHYIA_PUBLIC_ORIGIN=http://127.0.0.1:12801 bun run src/main.ts
curl -s -H "Authorization: Bearer <key>" http://127.0.0.1:12801/v1/models
```

Confirm the route exists first: a local deployment lacks a remote deployment's
aliases, and a 404 there is a fixture gap, not a result.

**Prove the test locks the fix:** revert the change, see the test fail, restore
it, see it pass. A test that passes both ways proves nothing.

## Hygiene

- Never print credentials or place them in command arguments. Load them from
  the existing protected environment/configuration or supply them through
  stdin/file descriptors. Keep them out of tool output, process lists, logs,
  reports, and Git. `AGENTS.md` "Git and credentials" is the owner.
- Shell variables do not persist between independent tool calls. Reuse the
  protected credential source in the same invocation; do not solve that by
  repeating the secret literally.
- **Diagnose `000` before believing it.** An unauthenticated `401` proves the
  host answered; `000` with no HTTP response leaves DNS, TLS, client transport,
  and egress unresolved. Use a second client when the transport is suspect. Do
  not report a host as unreachable on a single `000`.
- **Windows curl can fail independently of the service.** If it reports exit
  43 / HTTP 000 against a host another client reaches, prefer `bun -e` with
  `fetch` for the replay. Record which client produced each result.
- Work in a scratch directory outside the repo; delete it when done. Leave no
  replay scripts or captured payloads in the tree.
- Send the same `user-agent` as the failing client so the gateway takes the same
  path.
- Stop any instance you started.
- Repeated invalid model requests trip the IP strike window ("Warning n/10 … will temporarily ban this IP"). Keep probe counts low and list `/v1/models` before guessing model ids.

## Report

State the exact field that caused it, the replay table (what passed, what
failed), whether the baseline was repeatable, the layer you fixed and why it
owns it, and the before/after result against a real instance. Say plainly what
you could not verify — e.g. whether other upstreams on that wire share the
behavior, when the available routes could not exercise them.
