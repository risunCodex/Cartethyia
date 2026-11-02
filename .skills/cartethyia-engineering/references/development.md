# Development

## Orientation

- Backend is `src/`. Browser code is `dashboard/src/`. The browser calls
  `/console/api` and does not import the backend.
- CodeGraph for owners and call paths. `Read` for a known range. `Grep` for a
  known literal.
- Read the layer and its reference before editing it.
- One behavior, one owner. How the change should read is `taste.md`.

## Add or change a feature

1. Name the acceptance check and the boundary that will prove it.
2. Find the definition, callers, contracts, config, docs, and generated source.
3. Edit the owner first.
4. Migrate every caller and delete the old path. No alias.
5. Update docs and config when a claim or a setting changed.
6. Run `verification.md`.

If the change spans more than one owner, or a migration, or a contract, do not
edit directly — route through the proposal flow
(`cartethyia-engineering-proposal`): parallel per-area audit, one composed
proposal, operator approval, then parallel execution on file-disjoint clusters.

## Add a provider

Follow the `cartethyia-provider-catalog` skill. Do not copy metadata into a
second place without naming which one is the authority. Wire bytes, auth, catalog, account
state, and availability each have their own owner.

## Contract or schema

Find every producer, validator, store, reader, and dashboard mirror. A schema
change updates `src/persistence/schema.ts` and adds matching numbered
migrations for both backends. Preserve released baseline files so deployed
databases keep matching their baseline marker. Update backup validation/mapping
for legacy rows when needed. Existing databases with retired migration history
are recreated and restored from backup. The procedure is in the
`cartethyia-schema-telemetry` skill. Dashboard contracts stay browser-safe.

## Removal

- Prove callers and dynamic reachability before deleting. Grep of the
  declaration is not proof.
- Change the definition, migrate callers, delete the old name.
- If two implementations disagree on policy, settle the policy first, then
  move the code.

## First install

`bun install --linker isolated`, then `bun setup`. Run install at the repository
root; it installs the backend and dashboard workspaces and creates each
workspace's dependency directory. Do not install separately from `dashboard/`.
The wizard creates the env, encryption key, Lite/Full choice, and listen port,
then probes the database. `PORT`
(default 12800) is what `bun dev` and the production build bind. 5173 is only
the default dashboard dev server (with automatic fallback to 1931). Automation uses `bun setup --non-interactive` and
must already have `CARTETHYIA_DB_MODE`, plus a reachable `DATABASE_URL` for
Full. Do not add a second installer that copies `.env.example`.
`scripts/install.sh --local --lite` handles dependencies, setup, build, start,
and the final doctor in one command.

## First console boot

`/console/setup` offers two paths.

| Path | What it does |
| --- | --- |
| New account | Creates the tenant, the administrator, and the default gateway key |
| Restore backup | `POST /console/api/auth/setup/restore` |

Restore runs only while no console user exists. The file must be a Cartethyia
backup, and its `console_users` become the accounts that sign in. This path
creates no account. A file with no users is refused. A failed restore deletes
the tenant it created. Sessions are not in the backup. An export taken before
`console_users` was included cannot use this path. A signed-in restore stays
on `/console/api/backup/import` and still requires the operator password.

## Verify

Gates and the real boundary are in `verification.md`. Run the affected suite
(`bun run test:backend` or `bun run dashboard:test`) alongside them.
