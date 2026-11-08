# Proposal: documentation audit — why-cartethyia, installation, feature links

Proposed 2026-11-08. Audit of `documentation/why-cartethyia.md`,
`documentation/installation.md`, and the feature-doc cross-links against the
current codebase. Verified against `src/`, `scripts/`, `package.json`, and
`documentation/features/`.

## Findings

| File | Status | Action |
| --- | --- | --- |
| `why-cartethyia.md` | Mostly current; 4 feature links missing; one wording fix | Add links + tighten |
| `installation.md` | All technical claims verified current | Add missing cross-links; one wording fix |
| `documentation/features/` | 10 files, all paths exist | No content change needed |

### Verified-current (no change)

- `scripts/install.sh` exists and matches the documented flags (`--local`,
  `--vps --regular/--nat`, `--docker`, `--lite/--full`, `--provision-redis`,
  `--no-caddy`, `--dry-run`, `--check`, `--non-interactive`).
- `package.json` scripts match: `bun setup`, `bun run build`, `bun run start`,
  `bun run dev`, `bun run dev:watch`, `test-db:up/down/check`, `dashboard:test`,
  `test:integration`, `typecheck`, `dashboard:typecheck`.
- Health endpoints `/health` and `/health/ready` exist (`src/boot/app.ts`).
- Vite dev server default 5173 with 1931 fallback (`dashboard/vite.config.ts`).
- Tray console still exists (`systray2` dep; `scripts/cli/autostart.ts`).
- OpenCode `403 FreeTierError` example still accurate
  (`src/providers/integrations/opencode/fingerprint.ts`).
- Buddy media generation, CLI model mapping, network pools, usage floor, share
  keys, routing aliases/combos all still exist (checked under `src/`).
- `ninerouter`/`nine_router` credit still valid (backup import format
  `nine_router` still exists in `src/console/backup/nine-router.ts`).

## Proposed edits

### 1. `documentation/why-cartethyia.md`

**a. Add the four missing feature links.** The "Custom-built capabilities"
section lists 01–05 and 07 but skips 06, 08, 09, 10. Append bullets (or
extend existing ones) so every feature doc is reachable:

```markdown
- **Buddy CLI identity.** Device-token identity and per-account binding for
  the Buddy family — see [Buddy CLI identity](features/06-buddy-cli-identity.md).
- **Cursor provider.** The Run protocol adapter, entitlement, and quota — see
  [Cursor provider](features/08-cursor-provider.md).
- **Wire dialects.** How a request is translated per provider dialect — see
  [Wire dialects](features/09-wire-dialects.md).
- **Thinking-effort ladder.** Effort-level translation across providers — see
  [Thinking effort ladder](features/10-thinking-effort-ladder.md).
```

**b. Tighten the Next.js comparison** (drop the memory-footprint digression;
keep the point):

Before:
```markdown
- **HTTP layer: Elysia.** Chosen instead of Next.js for the console and API.
  Next.js carries a React server runtime and a bundler footprint that costs
  hundreds of megabytes of resident memory before it serves a request; a gateway
  that should sit quietly in a tray cannot spend that. Elysia is a plain HTTP
  layer over Bun's server, so the console is a static React bundle served by the
  same process that proxies traffic.
```

After:
```markdown
- **HTTP layer: Elysia.** Chosen instead of Next.js for the console and API:
  a plain HTTP layer over Bun's server, so the console is a static React bundle
  served by the same process that proxies traffic — no React server runtime,
  no bundler memory footprint.
```

**c. "Where to go next" — add the missing index links:**

```markdown
- [Installation](installation.md) — install and choose a database mode.
- [Project README](../README.md) — product overview and installation entrypoint.
- [Feature docs](features/) — CLI model mapping, routing, pools, quota, share keys.
- [Reference](reference/) — configuration, errors, providers, deployment.
```

### 2. `documentation/installation.md`

All technical content verified current — no fact removal. Two wording/link
fixes:

**a. The task-list sentence references the config reference but does not link
it. Add the link:**

Before:
```markdown
Heavy periodic sweeps can be switched off per task with
`CARTETHYIA_DISABLED_TASKS` (a comma-separated list of task names, e.g.
`oauth-refresh-sweep,buddy-adopt`). The full task list and the config
reference live in `documentation/reference/configuration.md`; a disabled task
is logged once at boot and never scheduled. Use this to cut background work on
a small host — the quota/health sweeps are the ones to consider first.
```

After:
```markdown
Heavy periodic sweeps can be switched off per task with
`CARTETHYIA_DISABLED_TASKS` (a comma-separated list of task names, e.g.
`oauth-refresh-sweep,buddy-adopt`). The full task list and the config
reference live in [configuration](reference/configuration.md); a disabled task
is logged once at boot and never scheduled. Use this to cut background work on
a small host — the quota/health sweeps are the ones to consider first.
```

**b. "one-shot script" → keep, but link the reference docs at the end:**

After:
```markdown
See the [project README](../README.md) for the product overview.
```

Add:
```markdown
See also [Why Cartethyia](why-cartethyia.md) for the design rationale and
[Reference](reference/) for configuration and provider details.
```

## Out of scope

- `README.md` (already rephrased separately).
- Feature docs content (all verified accurate).
- `documentation/reference/` contents.
