# syntax=docker/dockerfile:1.7
# Debian 12 (bookworm) is the runtime base.
#
# Why Debian over Alpine: the standalone binary is compiled against glibc, and
# glibc is what most operators already run on their hosts. Shipping the same
# libc family as the deployment target means no musl/glibc surprises in native
# modules, and `ca-certificates` behaves the way every downstream tool expects.
#
# Build speed comes from layer order, not from a smaller base. Each COPY below
# is placed so that editing source never invalidates an installed dependency:
# manifests -> install -> contracts -> dashboard -> scripts -> AOT -> binary.
# Only the stage holding the changed file rebuilds; the three expensive stages
# (bun install, dashboard bundle, AOT compile) stay cached across ordinary
# commits.

# ---------------------------------------------------------------------------
# Builder: install, bundle the dashboard, then compile the standalone binary.
# ---------------------------------------------------------------------------
# The builder image is pinned to the same Bun version the repo pins in
# `.bun-version` (and that CI installs via setup-bun) so the container and the
# verified toolchain cannot drift apart. Bump both together.
FROM oven/bun:1.4.2-debian AS builder

WORKDIR /build

# Dependency layer first: source changes must not invalidate `bun install`.
# `--frozen-lockfile` keeps the container's tree identical to the committed one,
# so a lockfile drift fails the build loudly instead of silently shipping a
# different Elysia than CI verified.
COPY package.json bun.lock tsconfig.json ./
COPY dashboard/package.json ./dashboard/package.json
RUN bun install --frozen-lockfile

# Contracts before the dashboard build: the dashboard mirrors several backend
# types out of src/ and cannot be typechecked against dashboard/ alone.
COPY src ./src

# Dashboard bundle: one layer, invalidated only by dashboard/ or src/ changes.
COPY dashboard ./dashboard
RUN bun run dashboard:build

# Backend build. Migrations are asserted before compiling so an image is never
# published with a partial migration set — a binary without its migrations
# starts fine and then fails at the first schema step, which is the worst place
# to discover it.
COPY scripts ./scripts
COPY migrations ./migrations
RUN test -f migrations/full-postgres/0000_baseline.sql \
    && test -f migrations/lite-sqlite3/0000_baseline.sql \
    && test -f migrations/full-postgres/0001_allow_multiple_shared_keys_per_ip.sql \
    && test -f migrations/lite-sqlite3/0001_allow_multiple_shared_keys_per_ip.sql
COPY vendor ./vendor
RUN bun run build:aot && bun run build:binary --outfile /build/dist/cartethyia

# ---------------------------------------------------------------------------
# Runtime: only the binary, assets, migrations, and entrypoint ship.
# ---------------------------------------------------------------------------
FROM debian:12-slim AS runtime

WORKDIR /app

# One apt layer, cleaned in the same RUN so the lists never reach the final
# image. Each package is there for a reason:
#   ca-certificates  outbound HTTPS to providers
#   curl             HEALTHCHECK
#   libstdc++6       the compiled binary's C++ runtime
#   libgcc-s1        its GCC support library
#   util-linux       setpriv, used to drop from root to uid 10001
#   tzdata           correct local time in logs and daily quota windows
#   procps           ps/pkill, so `docker exec` diagnostics are usable
# `setpriv` (util-linux) is what makes the non-root drop possible without
# shipping gosu or su-exec.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libstdc++6 \
        libgcc-s1 \
        util-linux \
        tzdata \
        procps; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 10001 cartethyia; \
    useradd --system --uid 10001 --gid cartethyia --no-create-home cartethyia; \
    mkdir -p /app/data; \
    chown -R cartethyia:cartethyia /app

COPY --from=builder --chown=cartethyia:cartethyia /build/migrations ./migrations
RUN test -f /app/migrations/full-postgres/0000_baseline.sql \
    && test -f /app/migrations/lite-sqlite3/0000_baseline.sql \
    && test -f /app/migrations/full-postgres/0001_allow_multiple_shared_keys_per_ip.sql \
    && test -f /app/migrations/lite-sqlite3/0001_allow_multiple_shared_keys_per_ip.sql
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/dashboard ./dist/dashboard
COPY --chmod=755 docker-entrypoint.sh ./entrypoint.sh
COPY --from=builder --chown=cartethyia:cartethyia /build/vendor ./vendor
COPY --from=builder --chown=cartethyia:cartethyia /build/dist/cartethyia ./cartethyia

# AOT prewarm keeps first boot fast; the binary reads this instead of
# re-deriving routes and schema on every container start.
ENV NODE_ENV=production \
    DASHBOARD_DIST=/app/dist/dashboard \
    CARTETHYIA_PACKAGE_ROOT=/app \
    CARTETHYIA_DATA_DIR=/app/data \
    CARTETHYIA_INSTALL_ID_DIR=/app/data/.cartethyia \
    TZ=UTC

EXPOSE 12800
STOPSIGNAL SIGTERM

# /health/ready, not /health: ready reports the dependency state an orchestrator
# should act on, so a container that is up but not yet serving is not killed.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-12800}/health/ready" || exit 1

# Starts as root so a mounted volume's ownership can be repaired, then drops to
# uid 10001 via setpriv. See docker-entrypoint.sh.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["./cartethyia"]
