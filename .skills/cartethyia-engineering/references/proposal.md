# Proposal workflow

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
flow exists to prevent the *wide* change from being designed inside a code
edit.

## Workflow

1. **Audit first, write second.** Do not invent the current state. For wide
   changes, fan the audit out: one explore subagent per area (in parallel),
   each reading its area fully and writing a per-area report into
   `documentation/proposals/parts/NN-<area>.md` with `file:line` evidence, a
   per-finding verdict, severity, and effort. Within one area a subagent uses
   `codegraph_explore` (or `Read`/`Grep` for what it does not index) to
   establish:
   - the current pipeline the change will touch (entry point → owner → callers),
   - the canonical owner of each behavior,
   - existing precedents for the same shape of work (e.g. an internal dispatch
     that folds a result back into a request),
   - what already exists that the proposal can reuse.
2. **Compose the master proposal.** Aggregate the per-area reports into ONE
   master proposal in `documentation/proposals/` with an executive summary
   table (finding → verdict → behavior-change? → severity → effort) and
   tiered priorities. The parts stay as the per-area source of truth.
3. **Find the canonical owner of the change.** Read the closest section of
   `SKILL.md` in this engineering skill and name it in the proposal. A
   proposal that spans routing + schema + dashboard names all three.
4. **Verify the proposal's code claims.** Every "current behavior" statement
   must name the file/symbol that proves it. If you cannot point at code, say
   so explicitly as an open question — never guess.
5. **Report.** Summarize the audit findings and the open questions that need a
   decision. Do not implement until the operator has read it.
6. **Execute only after approval — and end-to-end.** The approved proposal is
   executed by parallel subagents on **file-disjoint clusters** (so edits never
   collide); the orchestrator closes cross-cluster residuals (conflicting
   intermediate states between sessions) itself; then run the full validation
   against the quoted baseline — `bunx tsc --noEmit`, dashboard typecheck,
   `bun run test:backend`, `bun test test/protocol` — and quote the pass/fail
   counts. Finally write honest **✅/⛔ markers per finding** into the master
   proposal and each part file (an `## Execution status` section per part):
   deliberately-skipped items stay ⛔ **with their reason** — never silently
   dropped, never claimed done without evidence. Single local commit. Work is
   local-only; push only when the operator explicitly asks.

## Proposal format

The format is deliberately stable so another agent can produce and consume it:

```markdown
# Proposal — <short title>

**Status:** awaiting approval | approved | executing | executed (full) |
executed (partial — see Execution status)
**Tanggal:** <YYYY-MM-DD>
**Scope:** <areas touched: routing, dispatch, schema, dashboard, telemetry…>
**Method:** <how it was audited — e.g. "N parallel subagent audits, one per area">

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

For an audit-inventory proposal: a summary table per finding
(verdict, behavior change?, severity, effort) and an execution order.

## 4. File yang tersentuh

A table: area → file(s). Mirror the repository map in AGENTS.md.

## 5. Migrasi & risk

Migrations, backward compatibility, behavior changes that ripple widely, and a
test list that proves the design. Quote the verification baseline
(pass/fail counts per suite) the execution will be measured against.

## 6. Pertanyaan terbuka

Decisions the operator must make before implementation. Keep them concrete and
answerable (prefer: "A vs B?" with a recommendation, over open-ended questions).

## 7. Execution status

Filled in after execution: per-finding ✅ (done, with evidence) or ⛔
(skipped, with reason). Baseline vs after-state validation counts. For
area-scoped audits, each part file carries its own `## Execution status`
section; the master composes them.
```

One master proposal per effort (kebab-case slug). For area-scoped audits, each
area's detailed report lives in `documentation/proposals/parts/NN-<area>.md`
and the master composes them.

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
  with English code terms. Match the most recent proposal in the folder as a
  tie-breaker; the format section above is the authority.
- **Findings carry severity and effort.** Every audit finding gets a severity
  (HIGH/MED/LOW, or the audit's own tiering) and an effort estimate (S/M/L),
  plus an explicit "behavior change?" verdict. An audit that hides effort
  behind prose is not decision-ready.
- **A closed finding needs evidence; a skipped finding needs a reason.** Both
  live in the Execution status. "Did not get to it" is written as ⛔ with that
  reason, not omitted.

## Links

- `SKILL.md` — entry point, canonical owners, fix-vs-hide rules, cutover.
- `verification.md` — the gates a proposal's test list must satisfy once
  implemented.
- `taste.md` — how the implementation should read.
- `development.md` — how to add a feature, contract/schema procedure.
- `../../cartethyia-schema-telemetry/SKILL.md` — when the proposal includes a
  migration or telemetry.
- `../../cartethyia-dashboard/SKILL.md` — when the proposal includes a
  dashboard surface.

## Done

The proposal is done when: the current behavior is traced to code, the design
has guards and a recommendation, the file list is complete, the migrations/risk
section is present (with the verification baseline quoted), and open questions
are concrete. Do not implement until the operator has read it. An executed
proposal is done when its Execution status accounts for every finding — ✅ with
evidence or ⛔ with a reason.
