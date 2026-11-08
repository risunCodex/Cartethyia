# Installation

`scripts/install.sh` is the one-command installer for local Linux/macOS, VPS,
and Docker. It checks dependencies, configures the selected mode, builds or
starts the application, and runs the doctor automatically.

Local/source and VPS builds use **Bun only**. The installer does not install
Node.js or npm. The npm distribution and downloadable compiled artifacts are
separate delivery options; their requirements are not combined with a local
Bun install.

> [!WARNING]
> Cartethyia stores provider credentials and API keys on the host. Restrict
> console access, keep `.env` private, and store backups somewhere you control.

## Commands

From a checkout:

```bash
# Local Linux or macOS, embedded SQLite
bash scripts/install.sh --local --lite

# Local with PostgreSQL (uses an existing DATABASE_URL or provisions local DB)
bash scripts/install.sh --local --full

# Regular VPS: compiled gateway, systemd, Caddy and public TLS
bash scripts/install.sh --vps --regular --lite --domain app.example.com
bash scripts/install.sh --vps --regular --full --domain app.example.com

# NAT VPS: provider owns forwarding/TLS; no Caddy is installed
bash scripts/install.sh --vps --nat --lite --port 8080 --public-origin https://app.example.com:8080
bash scripts/install.sh --vps --nat --full --port 8080 --public-origin https://app.example.com:8080

# Existing checkout with Docker Engine and Compose
bash scripts/install.sh --docker --lite
bash scripts/install.sh --docker --full   # requires external DATABASE_URL
```

For a fresh local/VPS host, the same script can fetch the source checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/risunCodex/Cartethyia/dev/scripts/install.sh \
  | bash -s -- --vps --regular --full --domain app.example.com
```

Fresh bootstrap needs Git, curl, and Python 3 for manifest parsing. Python is
not an application runtime. The installer finds/installs Bun from the version
requirement in `package.json`; it never installs Node as a second runtime.
Docker requires a full checkout and is not supported through curl-without-checkout.

## Target requirements

| Target | Required | Not installed automatically |
| --- | --- | --- |
| Local Lite | Linux/macOS, supported package manager, Bun via bootstrap | Node/npm, PostgreSQL, Redis, Caddy, Docker |
| Local Full | Local Lite requirements plus existing or installer-provisioned PostgreSQL | Node/npm; Redis unless requested |
| Regular VPS | Debian/Ubuntu Linux, root or noninteractive sudo, systemd, DNS pointing to the VM | Node/npm; Caddy only with `--no-caddy` |
| NAT VPS | Debian/Ubuntu Linux, systemd, explicitly forwarded port and public origin | Caddy, Node/npm |
| Docker Lite | Full checkout, Docker Engine and Compose | Host Bun/Node/PostgreSQL/Caddy |
| Docker Full | Docker Lite requirements plus reachable external `DATABASE_URL` | Bundled PostgreSQL, host Caddy |

Redis is optional in every mode. `--provision-redis` explicitly installs and
configures local Redis for local/VPS. An existing `REDIS_URL` is preserved and
checked. Unset Redis uses in-memory coordination; there is no `REDIS_MODE`
setting. Docker Compose uses its own `CARTETHYIA_REDIS_URL` behavior.

## Lifecycle and management

Local installation builds the compiled gateway, starts it detached, waits for
readiness, and returns to the shell. From the installation root:

```bash
./carte menu     # attach to the running gateway
./carte doctor   # configuration + readiness
./carte stop     # stop only this installation's gateway
```

A menu reattaches without restarting a healthy detached instance. Leaving an
attached menu does not stop it; use the explicit stop command. The gateway uses
the install's persistent drain token and PID/port ownership marker, never
`pkill`, `nohup`, or a port-wide process kill.

Heavy periodic sweeps can be switched off per task with
`CARTETHYIA_DISABLED_TASKS` (a comma-separated list of task names, e.g.
`oauth-refresh-sweep,buddy-adopt`). The full task list and the config
reference live in [configuration](reference/configuration.md); a disabled task
is logged once at boot and never scheduled. Use this to cut background work on
a small host — the quota/health sweeps are the ones to consider first.

VPS uses `/etc/systemd/system/cartethyia.service` and the compiled
`dist/cartethyia`. Regular VPS manages Caddy only when DNS resolves to the
host. NAT leaves forwarding and TLS to the provider; readiness inside the VM
does not prove public reachability. Docker delegates lifecycle to Compose.

Open `$CARTETHYIA_PUBLIC_ORIGIN/console` after installation and complete the
first-boot wizard. Health/readiness does not enroll providers or prove upstream
connectivity.

## Operator flags

- `--check`: read-only dependency/config report; no installation or writes.
- `--dry-run`: print the ordered plan without mutation.
- `--no-start`: configure/build/install services but skip application start.
- `--skip-deps`: skip dependency installation, not validation.
- `--no-caddy`: Regular VPS behind an existing proxy; requires `--public-origin`.
- `--provision-redis`: install/start local Redis and write its URL.
- `--non-interactive`: no prompts; required flags must be explicit.
- `--root <path>`, `--port <n>`, `--domain <fqdn>`, `--public-origin <url>`.

Fresh bootstrap also accepts `CARTETHYIA_REPO_URL`, `CARTETHYIA_BRANCH`
(default `dev`), and `CARTETHYIA_ROOT`. Dirty developer checkouts are not
reset or pulled automatically. Existing installation roots are updated only by
fast-forward; conflicting non-git directories and live install locks fail.

## Reruns and changing modes

Reruns preserve custom env entries, existing valid encryption keys, database
URLs, and data. Config writes are atomic and use mode `0600` where supported.
The installer never rotates a key, resets an unknown PostgreSQL password,
removes a database/volume, or silently switches Lite to Full (or back).

Changing modes requires a JSON backup export, installation against a new
backend, readiness, then import. It is not an in-place database migration.

## Other delivery paths

The npm global package remains available as `npm install -g cartethyia`, with
`cartethyia setup` and `carte`. Its current launcher starts the Bun CLI, so do
not describe it as Node-only. Downloadable compiled releases bundle their Bun
runtime but still need companion dashboard/migration assets and writable state.
These channels are alternatives to the Bun local installer, not extra local
prerequisites.

## Database modes and configuration

Lite stores embedded SQLite at `<CARTETHYIA_DATA_DIR>/cartethyia.sqlite` and
uses one process/writer. Full uses PostgreSQL through `DATABASE_URL` and can
serve multiple instances. Features are otherwise the same.

`CARTETHYIA_DB_MODE` is required and has no implicit default. The gateway
refuses to boot without it rather than guessing which database and migration
set to use. `CARTETHYIA_ENCRYPTION_KEY` is a required 256-bit secret; the
installer/setup generates it when missing. Keep it out of version control.
`CARTETHYIA_PUBLIC_ORIGIN` must match the browser-facing scheme, host, and
port so OAuth callbacks point to the right place.

For manual source setup instead of the one-command installer:

```bash
bun install --linker isolated
bun setup
bun run build
bun run start
```

`bun setup` creates config, selects Lite/Full and a port, checks PostgreSQL
when Full is selected, and checks Redis only when configured. It does not
install PostgreSQL or start the gateway. `bun run start` requires the compiled
binary from `bun run build`. Development uses `bun run dev` (alias for
`bun run dev:watch`), which runs the stack behind a holding proxy and watches
source, SQL migrations, and dependency manifests — any change restarts the
full stack in place (a new/edited migration re-runs at boot, a manifest change
reinstalls deps). The dashboard development server listens on 5173 (with an
automatic fallback to 1931 or DASHBOARD_PORT if occupied) and proxies to the
configured gateway port.

Useful runtime endpoints:

| Endpoint | Purpose |
| --- | --- |
| `/health`, `/health/ready` | Liveness and database/migration readiness |
| `/metrics` | Prometheus metrics |
| `/v1/*` | Gateway API |
| `/console` | Dashboard and first-boot wizard |
| `/share/:token` | Public child-key enrollment |

## Migrations and backups

Numbered migrations under `migrations/full-postgres/` and
`migrations/lite-sqlite3/` run automatically at boot. Lite-to-Full movement is
a backup transfer, not a backend switch in place: export JSON from **Settings →
Backup**, start Full with an empty/new database, wait for readiness, then
import the backup. Backups contain sensitive configuration and credentials;
store them securely.

## Development verification

Backend tests require `CARTETHYIA_TEST_DATABASE_URL` pointing to a disposable
database, never the development or production `DATABASE_URL`.

```bash
bun run test-db:up       # optional disposable PostgreSQL in Docker
bun run test-db:check
bun run test:backend
bun run test-db:down
```

The Compose test URL is documented in `docker-compose.test.yml`. Add it to the
existing local `.env` or shell when using that service.

Run the relevant gates:

```bash
bun run typecheck
bun run dashboard:typecheck
bun run test:backend
bun run dashboard:test
bun run build
```

Use `bun run test`, `test:backend`, `test:integration`, `dashboard:test`, or
`--scope scripts`, not bare `bun test`. The runner `scripts/test/run.ts`
supplies the TLS certificate bundle and keeps backend, integration,
dashboard, and script scopes explicit instead of widening one scope into
another. Typechecking is not runtime proof; exercise the changed behavior at
its actual boundary.

See the [project README](../README.md) for the product overview, and
[Why Cartethyia](why-cartethyia.md) for the design rationale.
