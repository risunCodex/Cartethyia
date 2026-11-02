# Repo invariants

## Canonical ownership

- One behavior, one source of truth.
- Find every branch using a flag, status, enum, mapping, or envelope before changing it.
- Do not create aliases, forwarding shims, or compatibility names.

## Boundaries

- `dashboard/src` must remain browser-safe: no Elysia, DB, filesystem, secrets,
  or Node-runtime imports.
- Treat every boundary value as untrusted and fail closed by default.
- Preserve intentional provider wire bytes and header behavior.
- Change generated output through its source/generator, never by hand.

## Generated vs. pinned

Two different reasons to leave a file alone, and they call for different moves:

- **Generated** — a script owns the content, so hand-editing is lost on the next
  run. Change the generator and re-run it. In this repo that is
  `migrations/lite-sqlite3/0000_baseline.sql` (`scripts/tools/generate-sqlite.ts`)
  and `src/providers/discovery/catalog/catalog-blob.ts`
  (`scripts/tools/generate-models.ts`).
- **Pinned** — the file is hand-written but its *content hash* is recorded in
  persisted state, so editing it invalidates databases or clients already out
  there. `migrations/full-postgres/0000_baseline.sql` is this: it has no
  generator, and `baselineSchemaMarker()` hashes it into the migration ledger.
  A schema change belongs in a new numbered migration; editing the baseline
  makes existing databases refuse to boot.

Neither rule means "never touch it". Both mean "know which one it is before
editing, and change it the way it is meant to change".

## Naming and structure

- Keep `scripts/` grouped by purpose: `cli/`, `install/`, `build/`, `test/`,
  `dev/`, `tools/`, and `provider-probing/`. Health helpers and standalone
  launchers may remain at the scripts root when their callers expect that
  location.
- **Repo invariant — local only.** Work is committed locally; push only when
  the operator explicitly asks. This is not negotiable per-task.
- How a change should read — names, comments, types, errors — is `taste.md`.
  Do not restate it here.

## Fix, do not hide

Adding a catch, fallback, timeout, cast, or weaker validation is valid only when
it is an intentional, documented compatibility boundary. Otherwise find the
mechanism and fix the owning layer.

## Docs and config

Update README, `.env.example`, layer docs, or references when a change makes a
claim or setting wrong. Do not leave deleted paths or symbols as false authority.

## Skill and doc upkeep

Update a skill or a reference only after a repeated failure, a rejected change,
or a newly found drift class — not after a single surprise. The procedure
(closest owner, procedural guidance, verify cited symbols, remove stale
guidance, never repeat shared rules) lives in `self-improvement.md`.

## Proved deadness

Before deleting a symbol, check imports, re-exports, dynamic imports, callbacks,
simple reflection, scripts, and docs. After deletion, typecheck and search the old name.

Absence of a producer inside `src/` is not proof a reader is dead. Classify the
value by who can still supply it, and record the verdict:

- **Dead** — no producer anywhere, including history. Delete it.
- **Live contract** — the shape is persisted with no backfill migration, so
  pre-existing rows still carry it. Keep it and pin it with a test; deleting it
  silently disables the feature for those rows.
- **Replayable** — the value arrives from a client or a peer instance, not from
  our database. A client replays ids it stored under an older build, and an
  upstream error string can embed another gateway's own formatted text. Keep it.

For the third class, trace the boundary rather than the call site: ask which
remote process could still emit the shape, and whether the wire format rejects
it outright if unrecognized. A separator outside the upstream's accepted
character set is not cosmetic — an undecoded composite fails the provider's own
validation.

## A legacy era must be dated, not assumed

A comment that says "older builds stored X" is a claim about history, and it is
as checkable as any other. Before preserving behavior on its authority, date the
era: `git log --reverse -S'<field>'` shows when each key appeared. If both keys
landed in the same commit, no pre-flag era existed, and the branch is not
preserving old data — it is reinterpreting a shape the *current* UI still
writes.

That distinction decides the fix direction, and they are opposites. Real legacy
data is retired by backfilling it and then deleting the branch. A phantom legacy
rule is retired by deleting the branch, because the "legacy" write is still live
and the branch is actively granting consent nobody gave. Check what still writes
the shape — the current writer, not the imagined old one — before choosing.

Compare against the symmetric sibling: when two controls have identical UI and
one needs a compatibility branch the other does not, suspect the branch rather
than the sibling.

## Evidence

Reports distinguish gates run, boundaries exercised, remaining failures, and
unavailable surfaces. Typecheck is not runtime verification.
