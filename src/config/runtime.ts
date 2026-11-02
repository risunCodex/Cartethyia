/**
 * HTTP listener, dashboard runtime, and graceful-shutdown drain resolvers.
 */

import { CONFIG_SPEC, readInt, readOptionalText, readText } from "./spec";

/** Resolves the HTTP listener port from the process environment. */
export function resolvePort(): number {
  return readInt("PORT", CONFIG_SPEC.PORT);
}

/** Resolves the dashboard static asset directory. */
export function resolveDashboardDist(): string {
  return readText("DASHBOARD_DIST", CONFIG_SPEC.DASHBOARD_DIST);
}

/**
 * Resolves the configured default gateway API key (`CARTETHYIA_API_KEY`), if
 * one is set. Consumers that need the raw secret — first-boot seeding and the
 * console's key recovery from existing installations — read it here instead of
 * probing `process.env` directly.
 */
export function resolveDefaultGatewayApiKey(): string | undefined {
  return readOptionalText("CARTETHYIA_API_KEY", CONFIG_SPEC.CARTETHYIA_API_KEY);
}

/** Resolves the request-body ceiling shared by the Bun listener and ingress middleware. */
export function resolveMaxBodyBytes(): number {
  return readInt("CARTETHYIA_SERVER_MAX_BODY_BYTES", CONFIG_SPEC.CARTETHYIA_SERVER_MAX_BODY_BYTES);
}

/** Resolves the listener idle-socket timeout (seconds). */
export function resolveIdleTimeout(): number {
  return readInt("CARTETHYIA_SERVER_IDLE_TIMEOUT", CONFIG_SPEC.CARTETHYIA_SERVER_IDLE_TIMEOUT);
}

/** Resolves the graceful-shutdown drain window: time for in-flight requests to finish before abort. */
export function resolveShutdownDrainWindowMs(): number {
  return readInt(
    "CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS",
    CONFIG_SPEC.CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS,
  );
}

/** Resolves the operator drain token, or `undefined` when the drain route is disabled. */
export function resolveDrainToken(): string | undefined {
  return readOptionalText("CARTETHYIA_DRAIN_TOKEN", CONFIG_SPEC.CARTETHYIA_DRAIN_TOKEN);
}

/**
 * Whether Elysia precompiles route handlers at startup (AOT).
 *
 * Precompilation takes the eager validator branch, which calls TypeBox's
 * `SchemaCompile(schema)` and then reads `.buildResult.external` off the
 * result. In a source-run process that field is absent — the lazy
 * `require("typebox/schema")` resolves to a namespace that does not carry it —
 * and the process dies at the first schema-bearing route with
 * `undefined is not an object (evaluating 'this.tb.buildResult.external')`.
 * `scripts/build/aot.ts` avoids this by rewriting the call site and bundling
 * the namespaces statically, so only the built artifact can actually take the
 * eager path.
 *
 * So: precompilation is on for production *builds*, and off for a source run
 * even when `NODE_ENV=production`. A deployment that runs
 * `bun run src/main.ts` must not be pushed onto the eager branch.
 *
 * `CARTETHYIA_SOURCE_RUN` marks a source run explicitly. It is set by
 * `scripts/deploy/*.sh`, which are the only supported way to run from source.
 */
export function resolveElysiaPrecompile(): boolean {
  if (process.env.CARTETHYIA_SOURCE_RUN === "1") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * How many gateway processes this deployment runs, and which one this is.
 *
 * Multi-process is opt-in and deliberately narrow. Every process shares the
 * port through `SO_REUSEPORT`, so the kernel load-balances across them — which
 * means state that used to be process-local is now per-process unless it lives
 * somewhere shared. A second process without that sharing is not "twice the
 * capacity", it is two processes disagreeing:
 *
 * - **PostgreSQL, not SQLite.** Two processes on one SQLite file corrupt it;
 *   there is no cross-process lock in the driver.
 * - **Redis configured AND reachable.** Admission counters, quotas, and
 *   cooldowns are per-process without it, so a per-key RPM limit silently
 *   becomes N× the configured value.
 * - **Linux.** `SO_REUSEPORT` is the mechanism; elsewhere it is a silent no-op
 *   and the second process simply fails to bind.
 *
 * These are checked at resolution time rather than left to fail at bind time,
 * because a half-configured multi-process deploy that starts anyway looks fine
 * until a limit is enforced twice.
 */
export interface ProcessTopology {
  readonly count: number;
  readonly index: number;
  /** True when more than one process serves this deployment. */
  readonly multiProcess: boolean;
}

/**
 * Resolves the topology from the environment.
 *
 * `count > 1` requires an explicit index: a process that does not know which
 * one it is cannot own a shard of anything, and a guessed index would have two
 * processes claiming the same one.
 */
export function resolveProcessTopology(): ProcessTopology {
  const count = readInt("CARTETHYIA_PROCESS_COUNT", CONFIG_SPEC.CARTETHYIA_PROCESS_COUNT);
  if (count === 1) return { count: 1, index: 0, multiProcess: false };
  // Mandatory when the count is above one: a process that does not know which
  // one it is cannot own a shard of anything, and a defaulted index would have
  // two processes claiming the same number. The spec's default of 0 cannot
  // express "absent", so the raw value is checked here before it is read.
  const rawIndex = process.env.CARTETHYIA_PROCESS_INDEX?.trim();
  if (rawIndex === undefined || rawIndex.length === 0) {
    throw new Error(
      `CARTETHYIA_PROCESS_INDEX is required when CARTETHYIA_PROCESS_COUNT is ${count} (0 – ${count - 1})`,
    );
  }
  const index = readInt("CARTETHYIA_PROCESS_INDEX", CONFIG_SPEC.CARTETHYIA_PROCESS_INDEX);
  if (index >= count) {
    throw new Error(
      `CARTETHYIA_PROCESS_INDEX must be an integer between 0 and ${count - 1} (got "${rawIndex}")`,
    );
  }
  return { count, index, multiProcess: true };
}
