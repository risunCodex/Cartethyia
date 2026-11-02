# Verification

Use for every fix, refactor, removal, or contract change. This is the single
owner of the gate list; other references point here instead of repeating it.

## Gates

```bash
bun run typecheck                # always
bun run dashboard:typecheck      # when dashboard/ changes
bun run build                    # when an entry point or build contract changes
bun run test                     # or scoped: test:backend, dashboard:test, test:watch
bun test test/protocol           # when src/protocol/ or codecs change (no npm alias)
bun run check:migrations         # when src/persistence/schema.ts or migrations/ changes
```

`check:migrations` needs a disposable PostgreSQL server it can create databases
on; set `CARTETHYIA_DRIFT_DATABASE_URL` explicitly. It never falls back to the
development database. It builds two throwaway databases — one from the committed SQL,
one from the DDL Drizzle derives from `schema.ts` — and diffs their catalogs, so
it catches a schema edit that no migration covers. Index and constraint *names*
are normalized away; only structural differences are reported.

The repository carries an active test suite (`test/`, `dashboard/test/`, run via
`scripts/test/run.ts`). Database suites use the disposable
`CARTETHYIA_TEST_DATABASE_URL` configured in the local `.env` or shell; they
never fall back to the development database.

Typecheck proves code shape, not behavior. Run the affected scope alongside the
gates, and exercise the real boundary: a UI surface through the `agent-browser`
CLI (mandatory for dashboard work — follow `cartethyia-dashboard/SKILL.md`;
drive it yourself, no harness, no delegation), a live gateway request, or a
`.tmp-<topic>.ts` calling production code. Delete temporary files in the same
turn you created them.

A test locks a fix only if it fails without it: revert, watch it fail, restore,
watch it pass. Assert on the mechanism (`cn`, `auditSource`, a reducer), not on
one rendered surface. An expected value must be read from its owning constant.

## Bug-fix loop

1. Reproduce with the same input and boundary as the report.
2. Find the canonical owner and callers with CodeGraph or Grep.
3. State the mechanism, not the symptom.
4. Change the owner; migrate callers; do not add a fallback to hide the failure.
5. Re-run the reproduction, then the affected gates and test scope.
6. Report what was proven and what could not be verified.

## Rename or removal

- Search imports, re-exports, dynamic imports, callbacks, scripts, dashboard,
  and docs.
- Remove the old symbol; do not leave an alias or shim.
- Search the old name again after editing.
- A declaration-only grep result does not prove deadness; typecheck and caller
  analysis must rule out indirect dispatch. See `guards.md` for the deadness
  classes.

## Wire and payload changes

For translation bugs, compare client request, provider request, provider
response, and client response. Fix the layer that loses or changes data. Do not
alter upstream bytes that are intentionally preserved. Replay and bisection
procedure is in the `cartethyia-trace-replay` skill.

## Schema changes

Exercise the fresh baseline plus all forward migrations and legacy backup
mappings. Keep the runtime schema, both migration sets, and readers/writers
aligned without rewriting released baselines. Existing databases with retired
migration history are restored into a fresh database; never test that recovery
against development or production data.

## Completion

Report commands, relevant output, the boundary exercised, and limitations. Do
not say a gate passed when it was not run.

**Quote the verification baseline.** State the pass/fail counts per suite
before the change and restate the after-state against them — "backend 4217
pass / 0 fail, protocol 591 pass / 0 fail" is the shape. A report that says
"tests pass" without counts proves nothing and cannot be diffed by the next
session.

**Git discipline.** Work is committed locally. Push only when the operator
explicitly asks — never as a side effect of finishing a task.
