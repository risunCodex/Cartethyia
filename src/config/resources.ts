/**
 * Canonical resource policy: how much memory this process may use, and how
 * much room it must keep free.
 *
 * The memory figure used to be decided in unrelated places — a host-wide
 * `os.totalmem()` in the headroom guard, a fallback constant in
 * `runtime-metrics.ts` — which meant a container limited to 512 MiB shed on
 * the same threshold as a 4 GiB one and only reacted once the *host* was
 * nearly full. On a 1-core / 2 GiB VPS that is the difference between
 * shedding early and being OOM-killed, and the OOM kills the dashboard too —
 * the one surface that would have explained what happened.
 *
 * How many requests may run at once is NOT decided here. That is admission's
 * job: the tenant ceiling and each key's own limit, both set in Settings. A
 * second, process-wide ceiling derived from memory sat below the number an
 * operator could configure and refused requests that every configured limit
 * still allowed, which is why it is gone.
 */
import { CONFIG_SPEC, readOptionalInt } from "./spec";

/** Used when no limit is discoverable at all (native dev, macOS, Windows). */
export const FALLBACK_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * How many copies of a request body are resident at once.
 *
 * Measured, not assumed: the socket read buffer, the parsed object graph, and
 * the upstream re-serialization each hold a body-sized allocation, and garbage
 * collection lags rather than keeping them to one. Budgeting one copy halves
 * the real peak and lets the process admit twice the concurrency it can hold.
 */

/** Share of the memory limit all in-flight request bodies together may hold. */

/** Share of the memory limit kept free for allocation spikes and GC slack. */
export const MEMORY_HEADROOM_FRACTION = 0.2;

/**
 * Bytes kept free below the memory limit.
 *
 * A guard that only reacts once RSS equals the limit has already lost: the
 * allocation that breaches it happens between two samples, and the spike that
 * matters — an upstream response landing all at once — arrives in far less
 * than one sample interval.
 */
export function deriveMemoryHeadroomBytes(memoryLimitBytes: number): number {
  return Math.ceil(memoryLimitBytes * MEMORY_HEADROOM_FRACTION);
}

/**
 * Slack added on top of every key's concurrency limit.
 *
 * Operator configuration, not something a key carries about itself: it is
 * deliberate hidden allowance so a run that lands a few requests over the
 * number an operator chose is not refused at that number. The effective
 * ceiling is `limit + tolerance`, and only requests past it are refused.
 */
export function resolveConcurrencyTolerance(): number {
  const value = readOptionalInt(
    "CARTETHYIA_CONCURRENCY_TOLERANCE",
    CONFIG_SPEC.CARTETHYIA_CONCURRENCY_TOLERANCE,
  );
  return value === undefined ? 0 : Math.max(0, value);
}

