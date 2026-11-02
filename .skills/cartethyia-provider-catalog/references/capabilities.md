# Provider capabilities

Reference for `cartethyia-provider-catalog`. Use when adding, changing, or
verifying what a provider model can do — vision, reasoning, tool calling,
document/audio input, free tier, plan gating — and when proving those
capabilities end to end.

Capabilities are the claims a catalog row makes about what a request to that
model may contain and what it may expect back. They are not cosmetic: routing
uses them to exclude candidates or select a degraded variant, and
`projectForRoute` rejects an unsupported requirement on the selected route with
`capability_unsupported`. A false declaration can therefore reject a valid
request or route it to the wrong provider/model.

## When to use

- A model should accept images, PDFs, audio, tool calls, or reasoning and the
  catalog does not say so (or says the opposite).
- A capability was added to an adapter but the catalog row was never updated.
- A provider publishes its capabilities upstream and the catalog should track
  them instead of hardcoding.
- A capability claim needs proving before it is published.

## The single owner

`defineModel` in `src/providers/provider-model-definition.ts` is the only place
a capability becomes a catalog fact. Adapter code and hand-written literals
produce `ModelHelperRow`; `defineModel` resolves the fallback and publishes
`ModelDefinition`.

Fields to know, and what each one controls:

| field | controls |
|---|---|
| `vision` | accepts an image input part (`image` canonical kind) |
| `document` | accepts PDF/plain-file parts (`document`/`file`) |
| `audio` | accepts audio input parts |
| `toolCall` | the model may be handed `tools`; a false value makes preflight drop them |
| `reasoning` | emits reasoning alongside the answer |
| `reasoningEfforts` | the explicit effort scale; only set when the provider states it; wins over the thinking-ladder rule table |
| `thinking` | full `ThinkingConfig` override (mode + efforts) for the thinking ladder; wins over `reasoningEfforts` heuristics (`provider-model-definition.ts`) |
| `dialect` | explicit wire-dialect id (`models.dialect` via migration 0040); beats the `DIALECT_RULES` heuristic, loses to the DB override |
| `freeTier` | the provider publishes the row as free (billing tier, not cost) |
| `proOnly` | the provider refuses the row on a free plan |

Two traps, both of them silent:

- `toolCall` defaults to `true` in `defineModel`. A row that never mentions tools
  still declares tool support, so "no capability" is not expressed by omission —
  it is `toolCall: false`.
- `vision`/`document`/`audio` are independent. A multimodal row is not
  automatically a document-capable row; a PDF part is `document`, not `image`.

## Publish the capability, then prove it

1. **Find the upstream statement.** A capability upstream actually reports beats
   a guess. Prefer a field in the provider's own model directory (`is_vl`,
   `is_free`, effort lists) over a constant list. When the provider says nothing,
   leave the field unset rather than inventing one — `defineModel` falls back to
   the base catalog, and absence is not `false`.
2. **Set it where the row is built.** Static roster rows set it on the row;
   discovery modules set it on the projected definition; virtual/alias rows
   inherit it from their target rather than restating it.
3. **Persist it when it is per-model.** A capability that differs per model needs
   a column (see `cartethyia-schema-telemetry`), not a recomputed rule. Add the
   migration to **both** `migrations/full-postgres/` and
   `migrations/lite-sqlite3/`, and add the file name to the pinned list in
   `test/persistence/sqlite-baseline.test.ts` — that list is written out, not
   derived, so a new migration to one backend alone fails there.
4. **Surface it.** A capability that reaches the operator needs a wire field and
   a dashboard affordance; a capability that only affects preflight does not.

## Verifying a capability

Order matters: the cheapest check that can fail first.

1. **Static check** — does the row carry the capability? Assert on the
   `ModelDefinition` (or the catalog entry) rather than on rendered UI.
2. **Wire check** — does the adapter actually send the capability when the row
   says it is present? A declaration with no upstream payload is a claim, not a
   behavior. Exercise it with a fake transport and assert on the bytes.
3. **Live check** — when the capability is a real upstream behavior, dispatch one
   request through the running gateway and read the response. A capability that
   only passed a unit test is unproven.

For a live check, use the authorized local setup and never print credentials.

A capability test must assert the *presence of the effect*, not that the call
returned 200: a request that dropped its tools still returns 200.

## Reporting a capability change

State which fields changed, where the upstream evidence came from, and which of
the three checks above actually ran. If a capability is published without a live
check, say so explicitly rather than implying it was exercised.
