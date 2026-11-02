# `scripts/install.sh`

One command for local Linux/macOS, Regular/NAT VPS, and Docker. The shell file
bootstraps a checkout and Bun; TypeScript modules under `scripts/install/` own
all install policy. Do not add a second implementation in shell wrappers.

```bash
# Fresh Regular VPS, Full mode
curl -fsSL https://raw.githubusercontent.com/risunCodex/Cartethyia/dev/scripts/install.sh \
  | bash -s -- --vps --regular --full --domain app.example.com

# From a checkout
bash scripts/install.sh --local --lite
bash scripts/install.sh --vps --regular --lite --domain app.example.com
bash scripts/install.sh --vps --nat --lite --port 12800 --public-origin https://app.example.com:12800
bash scripts/install.sh --docker --lite
```

## Target flags

Exactly one of `--local`, `--vps`, `--docker`, plus one of `--lite`, `--full`.

- `--regular|--nat`: VPS topology; detection is used only when omitted and
  ambiguous detection never defaults to NAT.
- `--domain`: required for Regular VPS with managed Caddy.
- `--port`: app/external forwarded port; NAT requires it explicitly.
- `--public-origin`: required for NAT and for Regular with `--no-caddy`.
- `--root`: checkout/install root (default `/opt/cartethyia` for VPS).
- `--check`, `--dry-run`: read-only report/plan; no mutation.
- `--no-start`, `--skip-deps`, `--no-caddy`, `--provision-redis`,
  `--non-interactive`.

Bootstrap overrides: `CARTETHYIA_ROOT`, `CARTETHYIA_BRANCH` (default `dev`),
`CARTETHYIA_REPO_URL`.

## What the targets do

Local: Bun dependencies, atomic config, `bun run build`, detached compiled
gateway, readiness, doctor. The command returns to the shell. Reattach with
`./carte menu`; stop explicitly with `./carte stop` from the install root.
No Node/npm, `nohup`, or `pkill`.

VPS: Bun source build and compiled `dist/cartethyia` under systemd. Full uses a
valid existing `DATABASE_URL` or provisions a new local role/database. Existing
roles with unknown passwords are never reset. Regular validates DNS and manages
Caddy after verifying the pinned release checksum. NAT never installs Caddy.

Docker: requires the full checkout, Docker Engine, and Compose. It delegates to
the existing Dockerfile/Compose/entrypoint and named data volume. Full needs an
external `DATABASE_URL`; no PostgreSQL container is added implicitly.

All targets preserve valid secrets/custom env keys on rerun and reject an
implicit Lite↔Full switch. Use backup export/import to change modes. Redis is
optional: `REDIS_URL` set means shared coordination, unset means in-memory;
there is no `REDIS_MODE` flag.

Read [shared provisioning](shared-provisioning.md) for the systemd/config
invariants and the topology references for TLS and forwarding. A health check
proves process/database readiness, not provider egress or external NAT reachability.
