---
name: cartethyia-engineering-proposal
description: "Write a Cartethyia implementation proposal: audit the codebase first, produce a decision-ready markdown proposal in documentation/proposals/ with a consistent format, link the owning engineering skill and references, and keep it replayable by another agent."
---

# Cartethyia engineering proposal

A proposal is a decision document, not a plan file. It exists to let the
operator (or another agent) decide *whether* and *how* to build before any code
is written. It is written from the codebase — every claim about current
behavior must trace to a symbol, a call path, or a test — and it is written to
be read, not to be discussed into existence.

## When to use

- A new capability or behavior change that crosses more than one owner:
  routing, dispatch, schema, dashboard, telemetry.
- A change that requires a migration, changes observable behavior widely, or
  touches a contract.
- A request that starts with "audit dulu" or "bikin proposal".

For small, single-owner changes, skip the proposal and implement directly. This
skill exists to prevent the *wide* change from being designed inside a code
edit.

## Workflow

1. **Audit first, write second.** Do not invent the current state. Use
   `codegraph_explore` (or `Read`/`Grep` for what it does not index) to
   establish:
   - the current pipeline the change will touch (entry point → owner → callers),
   - the canonical owner of each behavior,
   - existing precedents for the same shape of work (e.g. an internal dispatch
     that folds a result back into a request),
   - what already exists that the proposal can reuse.
2. **Find the canonical owner of the change.** Read the closest skill from
   `.skills/cartethyia-engineering/SKILL.md` and name it in the proposal. A
   proposal that spans routing + schema + dashboard names all three.
3. **Write the proposal** into `documentation/proposals/` following the format
   below. One file per proposal. Use a descriptive kebab-case slug.
4. **Verify the proposal's code claims.** Every "current behavior" statement
   must name the file/symbol that proves it. If you cannot point at code, say
   so explicitly as an open question — never guess.
5. **Report.** Summarize the audit findings and the open questions that need a
   decision. Do not implement until the operator has read it.

## Proposal format

The format is deliberately stable so another agent can produce and consume it:

```markdown
# Proposal — <short title>

**Status:** draft untuk dibaca, belum diimplementasikan.
**Tanggal:** <YYYY-MM-DD>
**Scope:** <areas touched: routing, dispatch, schema, dashboard, telemetry…>

---

## 1. Kondisi saat ini (dari kode)

Describe the current behavior with code evidence: file, symbol, line where
useful. Include the pipeline the change touches.

## 2. Masalah yang diminta diatasi

The user's requirement, restated as concrete problems in the current behavior.

## 3. Desain yang diusulkan

The design. Options evaluated, with a recommendation. Include:
- new data/config shapes (schema fields, tables),
- the runtime flow with explicit guards and failure fallbacks,
- the dashboard/UI surface,
- telemetry/observability changes.

## 4. File yang tersentuh

A table: area → file(s). Mirror the repository map in AGENTS.md.

## 5. Migrasi & risk

Migrations, backward compatibility, behavior changes that ripple widely, and a
test list that proves the design.

## 6. Pertanyaan terbuka

Decisions the operator must make before implementation. Keep them concrete and
answerable (prefer: "A vs B?" with a recommendation, over open-ended questions).
```

## Writing rules

- **Code evidence over prose.** A claim like "gambar diganti placeholder" is
  weak; "`degradeMediaPart` (`degradation.ts:208`) replaces image parts with
  `{ kind: "text", text: "[image]" }`" is strong.
- **Name precedent.** If a similar mechanism exists (internal dispatch folding a
  result back, a vendored fallback, a degradation ladder), name it — it is the
  cheapest proof the design is feasible.
- **Guard every new path.** Every new runtime flow must state its failure
  fallback and its recursion guard.
- **Default off.** A new behavior that changes routing/dispatch defaults to
  opt-in unless the operator says otherwise.
- **Recommend, don't list.** When evaluating options, end with a
  recommendation and a one-line reason.
- **Language.** Match the proposal language of the repo. `documentation/proposals/`
  entries are bilingual-friendly; the existing ones use Indonesian for prose
  with English code terms. Match the most recent proposal in the folder.

## Links

- `.skills/cartethyia-engineering/SKILL.md` — entry point, canonical owners,
  fix-vs-hide rules, cutover.
- `.skills/cartethyia-engineering/references/verification.md` — the gates a
  proposal's test list must satisfy once implemented.
- `.skills/cartethyia-engineering/references/taste.md` — how the implementation
  should read.
- `.skills/cartethyia-engineering/references/development.md` — how to add a
  feature, contract/schema procedure.
- `.skills/cartethyia-schema-telemetry/SKILL.md` — when the proposal includes a
  migration or telemetry.
- `.skills/cartethyia-dashboard/SKILL.md` — when the proposal includes a
  dashboard surface.

## Done

The proposal is done when: the current behavior is traced to code, the design
has guards and a recommendation, the file list is complete, the migrations/risk
section is present, and open questions are concrete. Do not implement until the
operator has read it.
