# Shared provisioning (regular VPS and NAT VPS)

Use this reference to understand or repair the host-level pieces. Prefer
`scripts/install.sh`; do not mix these manual examples with a partially
completed installer run. TLS ownership differs by topology and is covered by
[`regular-vps.md`](regular-vps.md) / [`nat-vps.md`](nat-vps.md).

## Packages and Bun

The supported VPS path is Debian/Ubuntu with apt and systemd. Base packages are
`git curl unzip ca-certificates openssl`. Full mode also needs PostgreSQL when
no reachable external `DATABASE_URL` is supplied; Lite never needs it.

Install the Bun version required by `package.json` `engines.bun`, then expose
that binary at `/usr/local/bin/bun`: the service uses `ProtectHome=true`, so a
binary under `/root/.bun/bin` is not executable by the unit. The compiled
gateway carries its runtime; Bun is needed for the checkout build, not as the
service's `ExecStart` interpreter.

## PostgreSQL when local Full mode needs it

Provision a role/database only when no valid external URL exists. Use generated
credentials and `runuser -u postgres --`, not `su - postgres -c`. Check whether
the role and database already exist before creating them, make SQL errors fatal,
and never reset an existing role's password to make a guessed URL work.

Verify the resulting `DATABASE_URL` with an authenticated `SELECT 1`; role or
database existence alone does not prove authentication. Preserve a saved valid
URL on rerun. The installer owns this idempotent flow; do not replace it with a
`CREATE ROLE ... || true` script.

## Checkout and build

Use a clean checkout at `/opt/cartethyia`. Do not reset or pull over local
changes. Record the commit actually deployed with `git log --oneline -1`.

```bash
cd /opt/cartethyia
bun install --linker isolated --frozen-lockfile
bun run build
```

`bun run build` builds the dashboard, AOT artifact, and compiled gateway. The
gateway serves `dist/dashboard` through `DASHBOARD_DIST`; there is no runtime
fallback. Start or restart the service only after the complete build succeeds.

## Environment (`/opt/cartethyia/.env`, mode `0600`)

Generate secrets on the host and preserve them on rerun. Never copy an
encryption key from another deployment: changing it invalidates stored
credentials. Use the installer's atomic env writer rather than appending
duplicate managed keys.

A typical local-Full configuration is:

```dotenv
PORT=12800
DASHBOARD_DIST=/opt/cartethyia/dist/dashboard
CARTETHYIA_PACKAGE_ROOT=/opt/cartethyia
CARTETHYIA_PUBLIC_ORIGIN=https://<domain>
# Only the local reverse proxy may assert a client IP.
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
```

**Drain window vs systemd stop budget.** `CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS`
(default 20 000 ms) must fit inside the unit's `TimeoutStopSec=45`: raising the
drain window past 45 s makes systemd SIGKILL mid-drain, cutting in-flight
streams anyway. The `update` shutdown path (see below) uses the same budget.
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://cartethyia:<generated>@127.0.0.1:5432/cartethyia
CARTETHYIA_DATA_DIR=/opt/cartethyia/data
CARTETHYIA_TELEMETRY_PAYLOAD_DIR=/opt/cartethyia/data/telemetry-payloads
CARTETHYIA_INSTALL_ID_DIR=/opt/cartethyia/data/.cartethyia
CARTETHYIA_ENCRYPTION_KEY=<base64 of 32 random bytes>
```

For Lite, set `CARTETHYIA_DB_MODE=lite` and omit `DATABASE_URL`. Redis is
optional in either mode: `REDIS_URL` set enables shared coordination; unset
uses in-memory coordination. Do not add a `REDIS_MODE` setting.

## Updates (`carte update` / console apply)

`carte update` and the console `POST /console/api/updates/apply` share one
detached installer (`src/console/updates/apply-update.ts`): it runs
`npm install -g cartethyia@latest --prefer-online` in a detached shell, then
restarts the gateway itself (`systemctl restart cartethyia` on Linux) — no
manual restart needed. Progress lands in a status file
(`update-status.json` + `update.log`) under the user config dir
(`resolveUserConfigDir()` in `src/config/package-paths.ts` —
`~/.config/Cartethyia` on Linux, `%APPDATA%\Cartethyia` on Windows), readable
via `GET /console/api/updates/status`. Before exiting, the gateway drains
in-flight streams through the shutdown coordinator (`"update"` reason;
in-flight clients get the "back shortly" notice) — a failed install leaves the
old version running with the failure recorded in the status file, not a dead
gateway.

`CARTETHYIA_PUBLIC_ORIGIN` must match the browser-facing scheme, host, and
port. An `http://` origin behind an HTTPS front door breaks OAuth callback
URLs. Keep custom trusted-proxy CIDRs when already configured; loopback is the
default only for the local Caddy path.

The systemd service runs `dist/cartethyia`, not a production source run. If a
separate development source run explicitly uses `NODE_ENV=production`, it also
needs `CARTETHYIA_SOURCE_RUN=1`; see [`gotchas.md`](gotchas.md).

## systemd unit (`/etc/systemd/system/cartethyia.service`)

```ini
[Unit]
Description=Cartethyia AI gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/cartethyia
EnvironmentFile=/opt/cartethyia/.env
ExecStart=/opt/cartethyia/dist/cartethyia
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/cartethyia/data /opt/cartethyia/.env
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

Only a **locally provisioned** PostgreSQL adds `After=postgresql.service` and
`Requires=postgresql.service`. Lite and external-DB configurations must not
require a local PostgreSQL unit.

`ReadWritePaths` is load-bearing: the gateway writes telemetry and payload
capture under `data/`. `ProtectHome=true` is why a build-time Bun executable
under `/root` cannot be the service executable.

```bash
systemctl daemon-reload
systemctl enable cartethyia
systemctl restart cartethyia
```

Restart only after a successful build and configuration write. Then run the
shared doctor/readiness checks; an enabled unit is not proof of readiness.

## First boot

Open `/console` and complete the first-boot wizard. If an initial gateway key
was configured, setup seeds it through the normal persisted setup path; an
environment value is not an authentication fallback after setup.

If `GET /console/api/auth/first-boot` already reports `requires_setup: false`,
do not run setup again. A backup restore or existing installation may already
have users. Use the current console account-recovery procedure rather than
calling internal modules ad hoc.
