# Proposal — Vision handoff context preservation (zero-loss paths)

Status: partially implemented — Option E shipped (never delete images silently);
Options A–D remain open recommendations.
Date: 2026-11-06 (Option E implemented 2026-11-08)
Scope: `src/transport/vision-handoff.ts`, `src/transport/request/preparer.ts`,
routing/re-plan wiring, and optional transport improvements. Follow-up to
`documentation/research/opencode/2026-11-02-vision-handoff-large-session.md`
(which recorded the symptom and the `condenseHandoffRequest` fix).

---

## 1. Context: how vision handoff works today

When a request carries an image but the selected model is not image-capable
and the tenant configured `visionHandoffModels`, the gateway:

1. Builds a **sub-request** to a vision model (`selectVisionContextMessages`):
   the active image-carrying user turn plus as much *trailing* history as fits
   the vision model's context window (catalog limit, fallback 200K tokens).
2. Runs it through the same attempt loop as any request (admission, pool,
   retry, cooldown, accounting). First model producing non-empty text wins;
   models are tried in parallel with a 12s per-model budget.
3. Replaces image parts with the description text
   (`replaceImagePartsWithText`), re-plans the route, and forwards the
   text-only request to the main model.
4. Caches descriptions by the full context hash, so the same image in the
   same context is never re-described.

The helper model only reads and describes; the main model answers.

## 2. Findings: two independent mechanisms cause context loss

An operator instinct — "set the handoff model's context size equal to the main
model's, then nothing is lost" — only fixes one half. There are **two**
independent loss mechanisms:

### 2.1 Vision-side loss (bounded by vision model context)

The vision model sees only `[active image turn] + [trailing history that fits
its context]`. If the vision model's context is small, the description is
generated from a thin slice of the conversation — the main model then answers
from a description that may miss context the user takes for granted.

**Fixable by** raising the handoff context limit (catalog row / metadata), but
that alone does not guarantee zero loss for the main model.

### 2.2 Main-side loss (`condenseHandoffRequest`) — the real remaining problem

After handoff, `condenseHandoffRequest` runs on the request *before* it goes
to the main model. When the session is huge — **>100 messages or >200K
chars** — the entire history is dropped, leaving only `system + active turn`
(+ anything after the active turn). The main model loses memory of everything
discussed before the image was attached.

This was introduced as the fix for the "broken on large sessions" report
(upstream 502 / `ECONNRESET` on multi-megabyte streaming bodies; see the
2026-11-02 research doc). It is a transport band-aid, not a semantic choice.

### 2.3 Secondary risks observed

- **Silent image removal (fixed, 2026-11-08):** older image-carrying turns
  (before the active turn) had their images filtered out with no marker; the
  main model did not even know something was there. `replaceImagePartsWithText`
  now substitutes a `[image omitted]` marker instead, so the loss is visible.
- **Perspective mismatch:** the trailing history the vision model sees (bounded
  by its context) is not necessarily the history the main model receives
  (possibly condense-truncated). The description can reference context the main
  model can no longer see, producing answers that seem to come from nowhere.

## 3. Goal

Keep the main model's context **lossless** for image-carrying requests — as
close to zero as the architecture allows — without re-introducing the large
payload failures.

## 4. Options (ordered by loss reduction vs. cost)

### Option A — Route image-heavy sessions to a multimodal main model (only true zero-loss)

Handoff only triggers when the selected model *cannot* carry images. If a
session that frequently receives images is routed to a vision-capable model
(e.g. Gemini 3 Flash, Claude Sonnet 4.6, GPT-6 Luna — when vision-capable in
the gateway), handoff never runs: image intact, history intact, loss = zero.

- **Pros:** strict zero loss; no new code.
- **Cons:** changes main-model price/quality for the session; requires a model
  that is actually vision-capable on the route (must be verified, not assumed).

### Option B — Fix the transport root, then relax/remove the condense gate

`condenseHandoffRequest` exists because streaming bodies > ~1M chars get reset/
rejected upstream. If transport is fixed — HTTP/2, reverse-proxy body limits,
payload splitting — the condense threshold can be raised or removed, and the
main model receives full history.

- **Pros:** keeps the main model choice; addresses the actual root cause.
- **Cons:** transport work is provider-specific (each upstream may behave
  differently); needs verification against the real failing payloads.

### Option C — Adaptive fallback: try full first, condense only on failure

Flip the logic: attempt the full request first; only on 502/`ECONNRESET`,
retry with condense. Full context is preserved whenever upstream can take it;
condense becomes a safety net, not a default.

- **Pros:** full context in the common case; minimal change to existing code.
- **Cons:** one extra retry on failure; retry must be safe (idempotency,
  no double-billing, no duplicate generation side effects).

### Option D — Replace "drop" with "summarize" (rolling summary)

For giant sessions, do not drop history — condense the older part into a
narrative paragraph, keep the recent turns verbatim, and inject the summary +
description into the main request.

- **Pros:** far less loss than dropping; predictable size.
- **Cons:** an extra summarization call (cheap model), added complexity; loss
  is reduced, not zero.

### Option E — Never silently delete: mark removed images

In `replaceImagePartsWithText`, replace removed older images with a marker
(e.g. `[image omitted]`) instead of filtering them out. The main model at
least knows something was there.

- **Pros:** very cheap; eliminates invisible loss.
- **Cons:** does not restore content; only makes loss visible.
- **Status (2026-11-08): implemented.** `replaceImagePartsWithText` emits
  `[image omitted]` for dropped older images; covered by
  `test/transport/vision-handoff.test.ts` ("older image-carrying history turns
  are dropped … but trailing context is carried"). All vision-handoff tests
  pass (4666 backend tests, 0 failures).

## 5. Recommendation

- **Primary:** combine **A + B** for true zero-loss use cases: route
  image-heavy sessions to a verified vision-capable main model, and fix the
  transport path so giant sessions do not need truncation.
- **Safety net:** **C** — try full, condense only on failure.
- **Cheap hygiene:** **E** — never delete images silently; **implemented
  2026-11-08**. If summarization is ever introduced, **D** is the natural
  upgrade over dropping.

## 6. Implementation sketch (for a future session)

1. Verify which configured models are vision-capable on routes (probe / route
   capability profile) — supports Option A.
2. Reproduce the large-session failure with the current code to confirm the
   transport boundary (which upstream, which body size, stream vs non-stream) —
   supports Option B.
3. Implement Option C in `preparer.ts`: on `502`/`ECONNRESET` from the
   upstream attempt, re-plan with `condenseHandoffRequest` applied.
4. ~~Implement Option E in `replaceImagePartsWithText`: emit `[image omitted]`
   for dropped older images.~~ **Done 2026-11-08** — `preparer.ts` flatMaps
   dropped image parts to `{ kind: "text", text: "[image omitted]" }`.
5. Extend `test/transport/vision-handoff*.test.ts` to cover: full-context
   path on large-but-not-failing sessions and condense-only-on-failure (the
   omitted-image marker is already covered).
