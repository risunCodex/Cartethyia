---
name: cartethyia-engineering
description: "Entry point for Cartethyia repo work and the owner of cross-cutting rules: pick the right skill, find the canonical owner, prove changes, keep repo invariants, and match the house style."
---

# Cartethyia engineering

Entry point for repo work. Most tasks belong to a focused skill — pick it first.

| Work | Use |
|---|---|
| A failing request to attribute to a field; payload/wire bytes | `cartethyia-trace-replay` |
| Getting the evidence off a remote deployment you cannot read from disk | `cartethyia-trace-replay` → `references/remote-debugging.md` |
| A 403 `FreeTierError` (check the egress IP first, then the `tools` gate) | `cartethyia-trace-replay` → `references/opencode-free-tier.md` |
| Schema change, migration, new usage/telemetry field | `cartethyia-schema-telemetry` |
| Add/remove/authenticate a provider; catalog, `/v1/models` | `cartethyia-provider-catalog` |
| What a model can do — vision, tools, reasoning, free tier — and proving it | `cartethyia-provider-catalog` → `references/capabilities.md` |
| Remove a bundled provider and its leftover global row | `cartethyia-provider-catalog` → `references/provider-removal.md` |
| Understand undocumented behavior by tracing this repo's own code | `cartethyia-reverse-engineering` |
| Write a decision-ready implementation proposal (audit first, format, links) | `cartethyia-engineering-proposal` |
| Multi-area campaign: parallel audit → composed proposal → approval → parallel execution → ✅/⛔ marking | `cartethyia-engineering-proposal` |
| Image generation wires, catalog rows, and account entitlement | `cartethyia-provider-catalog` |
| Account health, cooldown class, pool selection, retries, leases | `cartethyia-health-routing` |
| Add/change a `src/console/` domain; contract→store→dashboard mirror | `cartethyia-console-api` |
| `dashboard/` React, layout, social meta, toasts, `agent-browser` verification | `cartethyia-dashboard` |
| Deploying to a server — regular VPS, NAT VPS, Docker | `cartethyia-deployment` |
| Repo invariants, deadness, legacy-era checks, skill upkeep | `references/guards.md` |
| How to write the change: shape, names, types, errors | `references/taste.md` |
| Bug-fix loop, proof, gates | `references/verification.md` |
| Orientation, add a feature, first install, console boot | `references/development.md` |
| How to update skills and docs after the code drifts from them | `references/self-improvement.md` |

## Fast path

1. **Find the owner.** One behavior, one canonical owner. Editing the nearest
   matching file is how symptoms get suppressed instead of fixed.
2. **Ask the index.** `.codegraph/codegraph.db` sits at the repo root.
   `codegraph_explore` returns verbatim source plus call paths in one call,
   including dynamic-dispatch hops grep misses. `Read` for a known range,
   `Grep` for a known literal. Re-verify hits when a file changed after the
   index sync.
3. **Act immediately.** Read, search, reproduce, edit, or run a command. Never
   spend a turn on planning alone. For a wide change (multiple owners, a
   migration, a contract), the "act" is the proposal flow — see
   `cartethyia-engineering-proposal`: parallel per-area audit subagents → one
   composed proposal → operator approval → parallel execution on file-disjoint
   clusters → full validation → honest ✅/⛔ markers → single local commit.
   Do not implement a wide change by editing directly.

## Fix, don't hide

1. **Cause?** State it as a mechanism ("X reads Y, which is undefined when Z").
   Cannot state it → not ready to fix.
2. **Fix or hiding?** Removing a throw, loosening validation, widening a type,
   adding a fallback, raising a timeout, catching an exception = hiding until
   proven otherwise.
3. **Other arm?** A check that looks dead may be load-bearing for a
   partially-implemented dependency. Check before deleting.
4. **Intended design?** Capability degradation, operator-configured fallback, or
   a documented compatibility boundary is legitimate — name it in a comment and
   never masquerade it as a bug fix.

A workaround is fine only as a named temporary boundary with a removal
condition.

### "Built" is not "wired"

A helper that nothing calls has zero runtime effect. Before reporting a
behavior change as done, confirm something on the dispatch path actually
invokes it — `grep` the call site, not just the definition. A unit test over
the helper in isolation passes either way and proves nothing about wiring.

The symmetric trap: wiring a *retry* helper unconditionally can double every
request's upstream cost. Pin the "does NOT fire on the happy path" case
explicitly (e.g. assert the fetch count is exactly 1 for a healthy response),
because that regression is invisible in tests that only exercise failures.

### Read the reference before declaring something unknowable

If a comparison or research doc cites a donor checkout by path, that path is
the first place to look — not `node_modules`, not a filesystem-wide `find`.
Several items here were recorded as "blocked, undocumented" when the answer
sat in the donor named in the doc's own header. "Not in this repo" is not
"unknown".

And a guess that compiles can still be wrong on the wire. Where a wire shape
is unconfirmed, prefer an unwired, tested seam over a plausible invention:
an invented request field is a 400 on a production path, which is worse than
a missing feature.

## Cutover

Rename, move, new feature, or contract change:

1. Search every runtime, script, dashboard, docs, and config caller.
2. Change the canonical definition, migrate all callers, delete the obsolete
   symbol.
3. Search the old name again; only intentional history remains.

No alias or forwarding shim to keep old imports compiling. Deletion needs
proof, not grep — see `references/verification.md`.

## Boundaries

Repo invariants, deadness rules, and the browser-safe boundary live in
`references/guards.md` (consistent with how `references/verification.md`
owns the gates). Read it when a change touches `src/` vs `dashboard/`,
generated output, or security boundaries.

`guards.md` separates **generated** output (a script owns it — change the
generator) from **pinned** history (`migrations/full-postgres/0000_baseline.sql`,
hand-written but hashed into the migration ledger — change it with a new
numbered migration). Both are "do not hand-edit", for different reasons; knowing
which one you are looking at decides the fix.

## Completing a change

The gate list and what each gate proves live in `references/verification.md` —
the single owner, not repeated here. Report done only when the goal checks out
against current evidence: acceptance criteria, callers, exports, docs/config,
known failures. Otherwise continue with the next useful action, or report the
exact blocker and the evidence needed.

## Skills are discovered from `.claude/skills/`

`.skills/` is the committed source; `.claude/` is gitignored, so a fresh clone
has no wiring. Point the discovery dir at the committed one (junction, because
`ln -s` materializes as a copy on Windows):

```bash
mkdir -p .claude/skills
cmd //c 'mklink /J .claude\skills\cartethyia-engineering .skills\cartethyia-engineering'
```

A new skill folder is invisible to the agent until it is wired, and "repeat per
folder" is remembered exactly until the next folder, so wire them all at once:

```bash
for d in .skills/*/; do
  n=$(basename "$d")
  [ -e ".claude/skills/$n" ] && continue
  cmd.exe /c "mklink /J .claude\\skills\\$n .skills\\$n" >/dev/null
done
```

Idempotent, and it covers folders added later. `.skills/` is the source of
truth: if a folder exists there and has no junction, it is unwired, not absent.
