Cartethyia — Agent Guide

Use this guide to orient yourself, then follow the skill that owns the task.
Skills may impose stricter domain requirements. Do not turn this guide into a
second copy of their procedures.

## Work the task

1. Identify the requested outcome, observable acceptance criteria, and
   constraints. Use the user's wording; do not create a specification for a
   small task.
2. Inspect the current worktree, owning implementation, callers, and tests.
   Source code and tests are the authority for current behavior.
3. Read the closest relevant skill. Do not read every skill for every task.
4. Make the smallest complete change at the canonical owner. Update affected
   callers, tests, configuration, and documentation; leave unrelated work
   alone.
5. Verify the affected behavior and report exactly what passed, failed, or
   remains unverified.

Act before deliberating at length: inspect, search, reproduce, edit, or verify.
Work directly unless a separate task is genuinely independent.

Ask only when plausible choices materially change behavior, compatibility,
scope, data handling, or user experience. Otherwise choose a safe, reversible
default and state any assumption that affects the result. Stop for destructive
or hard-to-reverse actions unless the user has already authorized them.

For a bug, identify and verify the mechanism when practical. Do not hide a
failure by weakening validation, widening a type, suppressing an error, or
adding an unexplained fallback. If reproduction is not practical, state what
remains unproven.

## Environment

- **Runtime and package manager:** Bun, at the version required by
  `package.json` `engines.bun`.
- **Backend:** TypeScript and Elysia in `src/`.
- **Dashboard:** React and Vite in `dashboard/`.
- **Persistence:** embedded SQLite in Lite mode; PostgreSQL in Full mode.
  Redis is optional for shared coordination.
- **Installation and setup:** follow `documentation/installation.md` and the
  current scripts in `package.json`.

`CARTETHYIA_DB_MODE` is required. Never silently choose a database mode: Lite
and Full use different databases and migration sets.

### Finding Postgres and Redis — check what already exists first

Before provisioning anything (WSL, Docker, a VM, a download), **check whether
the machine already provides the service.** On a Windows dev box it usually
does: Laragon, XAMPP, Chocolatey/Scoop installs, a native `postgres`, or a
service already listening. Provisioning on top of a running service produces
port collisions and two databases, and wastes a lot of time.

Order:

1. **Probe the ports.** On Windows: `powershell -Command "Get-NetTCPConnection
   -State Listen -LocalPort 5432,6379 ..."` (pipe the PID through
   `Get-Process` to see *what* owns it). Elsewhere: `ss -ltnp | grep -E
   '5432|6379'` or `lsof -i :5432,:6379`.
2. **If something is already listening, that is the service.** Identify the
   binary behind the PID — `C:\laragon\bin\...` means Laragon, and Laragon is
   the answer, not a reason to install more.
3. **Confirm it speaks the protocol**, and get its version, using the same
   driver the tests use — not just a TCP connect:

   ```sh
   bun -e "const {Redis}=await import('ioredis'); const r=new Redis('redis://127.0.0.1:6379/5',{lazyConnect:true}); await r.connect(); console.log((await r.info('server')).match(/redis_version:.*/)[0]); r.disconnect();"
   bun -e "const {Pool}=await import('pg'); const p=new Pool({connectionString:process.env.CARTETHYIA_TEST_DATABASE_URL}); console.log((await p.query('select version()')).rows[0]); await p.end();"
   ```

4. **Only if nothing is listening**, set one up:
   - **Windows:** prefer a native install or Laragon. WSL2 works but has two
     caveats: it has no systemd (use `service <name> start`, not `systemctl`),
     and its services do not survive `wsl --shutdown`.
   - **Linux/macOS:** install natively (`apt-get install redis-server
     postgresql`, `brew install redis postgresql`) and start with the platform
     service manager. Docker is fine too if it is already present.
   - **Never** guess that a service is missing from the absence of a Docker
     container. Docker being unavailable says nothing about whether Redis is
     running.

Then create the role/database the suite expects if they are absent — see
`CARTETHYIA_TEST_DATABASE_URL` in `.env` for the exact names — and verify the
connection string end to end before running a suite.

**Do not conclude a suite is being skipped without checking.** A Redis-gated
suite that reports `17 pass` is *running*, not skipped. Count the skip notices
(`grep -c "\[test-redis\] skipped"`) rather than assuming from the absence of
Redis elsewhere.

Use shell and path syntax appropriate for the active environment. Prefer local
services for development; Docker is an option, not a universal prerequisite.
For visual or interactive dashboard work, follow the browser procedure in
`.skills/cartethyia-dashboard/SKILL.md`.

## Repository map

| Area | Location |
| --- | --- |
| Gateway, console API, providers, protocol, routing, persistence, telemetry | `src/` |
| Browser application | `dashboard/src/` |
| CLI, installer, build, development, tests, generators, and tools | `scripts/` |
| PostgreSQL and SQLite migrations | `migrations/` |
| Backend and dashboard tests | `test/`, `dashboard/test/` |
| Installation, architecture, configuration, and feature guides | `documentation/` |
| Focused procedures and domain guidance | `.skills/` |

Keep one canonical owner for each behavior and contract. Treat network
responses, environment values, database rows, request bodies, and user input
as untrusted. Preserve intentional provider-specific headers, identity,
authentication, and wire bytes.

Dashboard code must remain browser-safe: no database drivers, Elysia,
filesystem access, secrets, or Node-only runtime dependencies. It communicates
with `/console/api` rather than importing the backend.

Do not hand-edit generated output; change its source or generator and
regenerate. Treat pinned migration history as immutable: add forward migrations
rather than rewriting baselines. The schema/telemetry skill owns the complete
procedure.

Keep TypeScript strict. Do not weaken compiler settings or add `any` or
suppressions merely to silence an error.

## Find the owner

Start with the closest match. A directory is a search starting point, not
permission to edit every file in it.

| Task | Start with |
| --- | --- |
| Cross-cutting conventions, verification, dead code, or repository invariants | `.skills/cartethyia-engineering/SKILL.md` |
| Failing requests, wire bytes, payloads, or remote evidence | `.skills/cartethyia-trace-replay/SKILL.md` |
| Undocumented behavior or reconstruction of an internal flow | `.skills/cartethyia-reverse-engineering/SKILL.md` |
| Schema, migrations, usage, or telemetry | `.skills/cartethyia-schema-telemetry/SKILL.md` |
| Providers, models, authentication, capabilities, or catalogs | `.skills/cartethyia-provider-catalog/SKILL.md` |
| Account health, cooldowns, retries, leases, or routing | `.skills/cartethyia-health-routing/SKILL.md` |
| Console API domains and contracts | `.skills/cartethyia-console-api/SKILL.md` |
| Dashboard, React, layout, or browser verification | `.skills/cartethyia-dashboard/SKILL.md` |
| Local, VPS, NAT VPS, or Docker deployment | `.skills/cartethyia-deployment/SKILL.md` |
| Request parsing, protocol translation, streaming, or errors | `src/protocol/`, `src/transport/`, `src/providers/` |
| Quota reads and Usage floor | `src/console/quota/`, `src/providers/quota/`, `src/workers/` |
| Egress, proxy pools, or SSRF | `src/network/`, `src/console/routing/pools/` |
| Startup, lifecycle, or scheduled work | `src/boot/`, `src/workers/` |
| Environment variables | `src/config/spec.ts` |

When changing a shared contract, inspect its producers, consumers, validation,
and dashboard mirror. For a rename or removal, search direct and indirect
callers, remove obsolete paths, and search the old name again. Do not leave a
compatibility alias merely to avoid completing the cutover.

## Data and test safety

Never point tests, migration checks, or debugging commands at development or
production data. `CARTETHYIA_TEST_DATABASE_URL` is required by backend suites;
use a disposable database, never the runtime `DATABASE_URL`. Dashboard tests
do not require it.

Never run telemetry tests against the real data directory. Isolate
`CARTETHYIA_DATA_DIR` **before importing telemetry modules**; follow
`.skills/cartethyia-schema-telemetry/SKILL.md` for the sandbox procedure.

Prefer reversible database and environment operations. Confirm the target
before any operation that could alter real data.

## Verification

Follow
[`.skills/cartethyia-engineering/references/verification.md`](.skills/cartethyia-engineering/references/verification.md)
for gates, scoped tests, boundary verification, and reporting. Use the
repository test runner rather than bare `bun test`.

Typecheck proves code shape, not behavior. Exercise the changed behavior at
its real boundary when practical: a gateway request, browser surface, provider
flow, isolated migration, or installer lifecycle. Do not claim a check passed
when it was not run.

## Documentation

Use `documentation/installation.md` for installation and local/server setup.
Read `documentation/reference/` for system behavior and
`documentation/features/` for individual features. Update the owning page when
a change would otherwise leave it misleading; do not duplicate long procedures
across AGENTS, skills, and documentation.

Describe durable rules rather than current counts or incidental measurements.
When a value matters, name its owning constant or file. Resolve contradictions
against current code and tests instead of preserving both versions.

**Language:** all repository artifacts — code comments, documentation,
research notes, and release notes — are written in **English only**. Local
languages (e.g. Indonesian) are reserved for chat conversation with the
operator, never for files in the repository.

`documentation/archive/` contains unverified historical records. Never use it
as evidence of current behavior.

## Git and credentials

- Do not commit, push, deploy, or alter production data unless the user asks.
- Preserve unrelated user changes. Do not use destructive Git commands such as
  `reset --hard`, `checkout --`, or `clean`.
- Never place credentials in tracked files, Git diffs, commits, logs, reports,
  or telemetry. Keep replay material and scratch files outside the repository.
- Do not print credentials or repeat them in command text. Keep them out of
  tool output and process arguments; use the intended service's protected
  credential mechanism.
- Inspect `git status` and the staged diff before committing. Include only the
  requested work and its directly required changes.

## Completion

Report what changed, which checks ran and their outcomes, and any important
assumption, skipped verification, or blocker. Be concise and precise about the
evidence; never claim more than was verified.
