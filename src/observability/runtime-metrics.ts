/**
 * Periodic runtime gauges: process memory plus bounded-collection sizes.
 *
 * Sampling is driven by `ScheduledTaskRegistry` (unref'd interval) rather than
 * a dedicated timer so it shares the process's existing maintenance lifecycle
 * and stops with it. Map/collection sizes are read through closures supplied at
 * composition time; this module owns no references to the routing or pool
 * layers, keeping the observability boundary one-directional.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import { metrics } from "./metrics";
import { memoryUsageBytes, trackMemoryUsage } from "./performance-metrics";
import { log } from "./logger";
import { resolveMemoryLimitOverrideBytes } from "../config/timeouts";
import { CONFIG_SPEC, readFlag } from "../config/spec";
import type { TelemetryBacklogSnapshot } from "./telemetry-buffer";
/**
 * The memory figures a shed decision needs.
 *
 * Published once per sample instead of re-measured per request:
 * `process.memoryUsage()` is not free, and the headroom guard runs on every
 * request. A snapshot up to one sample interval old is the right trade — the
 * guard is protecting against a spike that arrives over seconds, not one
 * request's worth of allocation.
 */
export interface RuntimeMemorySnapshot {
  readonly rssBytes: number;
  /** The resolved limit; `undefined` when none could be discovered. */
  readonly limitBytes: number | undefined;
  readonly sampledAtMs: number;
}

/** Live collection sizes sampled alongside process memory. */
interface RuntimeMetricSources {
  readonly routingRoundRobinEntries: () => { readonly combo: number; readonly provider: number };
  /**
   * Tracked keys in the in-memory IP abuse store, or 0 when the store is
   * Redis-backed. Unlike the routing maps this one is fed by client-supplied
   * identities, so its size is the leak signal to watch.
   */
  readonly ipAbuseKeys: () => number;
  /**
   * The telemetry backlog's current shape, or `undefined` when no buffer is
   * wired (tests, and the console-only shell).
   */
  readonly telemetryBacklog?: () => TelemetryBacklogSnapshot | undefined;
  /** Tracked keys in the in-process quota cache tier (0 when Redis-only paths are idle). */
  readonly quotaCacheEntries: () => number;

  /**
   * Entries in the per-provider model-catalog cache. Bounded, but a count that
   * sits at the cap means every rebuild is evicting something it needs.
   */
  readonly modelCatalogEntries: () => number;
  /**
   * Live in-flight request count. Zero means the gateway is idle, so a
   * synchronous full collection is safe (no request to stall).
   */
  readonly inFlight: () => number;
}

/** Cooldown between memory-pressure warnings so a sustained high-water mark does not flood logs. */
const PRESSURE_LOG_WINDOW_MS = 60_000;
/** Cooldown between proactive garbage collections while pressure persists. */
const PRESSURE_GC_WINDOW_MS = 60_000;
/** Fraction of the resolved limit at which memory pressure is reported. */
const PRESSURE_THRESHOLD = 0.8;
/**
 * Fallback limit when neither an override nor a cgroup limit is discoverable
 * (native development, macOS, Windows).
 *
 * A fixed 512 MiB made every machine without a cgroup look like a 512 MiB
 * container. On a desktop running the gateway natively that is far below what
 * the machine has, so the pressure check fired against a number that described
 * nothing — "RSS 430 MiB exceeds 80% of the 512 MiB limit" on a machine with
 * gigabytes free — and the concurrency cap derived from it admitted a handful
 * of requests while every tenant-level setting sat unreachable above it.
 *
 * The host's real memory is the honest stand-in. It is what the process can
 * actually grow into here, and it is what "no container limit" means.
 */
function defaultMemoryLimitBytes(): number {
  try {
    const total = os.totalmem();
    if (Number.isFinite(total) && total > 0) return total;
  } catch {
    // Platform without totalmem; fall through to the last-resort constant.
  }
  return LAST_RESORT_MEMORY_LIMIT_BYTES;
}

/**
 * Used only when the host's memory cannot be read at all. Deliberately large
 * so an unmeasurable host is not treated as a small container.
 */
const LAST_RESORT_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
/** Cooldown between idle full collections. */
const IDLE_GC_WINDOW_MS = 5 * 60_000;
/** RSS retained above the post-collection baseline before another idle collection runs. */
const IDLE_GC_MIN_GROWTH_BYTES = 32 * 1024 * 1024;

/**
 * Resolves the effective memory limit for the process.
 *
 * Precedence: an explicit `CARTETHYIA_MEMORY_LIMIT_BYTES` override, then the
 * cgroup v2/v1 limit when running in a container. Falls back to
 * {@link DEFAULT_MEMORY_LIMIT_BYTES} when no limit is discoverable (native
 * development, macOS, Windows) so pressure-based reclaim still runs.
 */
export function resolveMemoryLimitBytes(): number | undefined {
  const override = resolveMemoryLimitOverrideBytes();
  if (override !== undefined) return override;
  if (process.platform !== "linux") return defaultMemoryLimitBytes();
  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content === "max") continue;
      const value = Number(content);
      // The v1 unlimited sentinel is a huge finite number; treat it as unknown.
      if (Number.isInteger(value) && value > 0 && value < 2 ** 53) return value;
    } catch {
      // File absent (cgroup v1 vs v2) or unreadable — try the next source.
    }
  }
  return defaultMemoryLimitBytes();
}

/** Samples process memory and bounded-collection sizes into the metric registry. */
export class RuntimeMetricsSampler {
  private readonly limitBytes: number | undefined;
  private readonly gcOnPressure: boolean;
  private lastPressureLogAt = 0;
  private lastGcAt = 0;
  private lastIdleGcAt = 0;
  private rssAtLastGc = 0;
  private inFlightSource: () => number = () => 0;
  /**
   * The latest snapshot, published once per sample. Stays undefined until the
   * first sample runs; consumers must treat that as "unknown", not as zero.
   */
  private snapshot: RuntimeMemorySnapshot | undefined;

  /**
   * Binds the live in-flight count after the request state store exists. The
   * sampler is constructed before that store, so the source is late-bound.
   */
  bindInFlight(source: () => number): void {
    this.inFlightSource = source;
  }

  /**
   * The last sampled memory state, for consumers on a hot path.
   *
   * Undefined before the first sample: a guard that read zero as "plenty of
   * room" would disable itself exactly when it matters, so callers must fall
   * back to their own judgement when this is absent.
   */
  memorySnapshot(): RuntimeMemorySnapshot | undefined {
    return this.snapshot;
  }

  /**
   * Publishes the effective concurrency ceiling.
   *
   * Late-bound like `bindInFlight`: the ceiling is derived from the memory
   * limit, which is known here, but the guard that owns it is constructed in
   * the transport layer.
   */

  constructor(
    private readonly sources: RuntimeMetricSources,
    limitBytes: number | undefined = resolveMemoryLimitBytes(),
    // Off by default: a forced collection is not how memory is meant to come
    // back. The synchronous form (`Bun.gc(true)`) stops the shared event loop
    // outright, so every concurrent request stalls inside it — which reads as
    // a latency spike with no upstream cause. And it hides the actual defect:
    // a process that only returns memory when something forces it to is a
    // process that is still holding it. Bounded caches, released streams, and
    // batched writers reclaim naturally; this is opt-in for an operator who
    // has measured that they need it.
    gcOnPressure = readFlag("CARTETHYIA_FORCED_GC", CONFIG_SPEC.CARTETHYIA_FORCED_GC),
  ) {
    this.limitBytes = limitBytes;
    this.gcOnPressure = gcOnPressure;
  }

  sample(): void {
    const memory = process.memoryUsage();
    // The performance-metrics memory series is the single memory view: record
    // the four figures once, then derive the Prometheus gauges from that same
    // series. `external` has no gauge equivalent, so it lives only in the
    // series (and in the `/system/performance` snapshot).
    trackMemoryUsage("rss", memory.rss);
    trackMemoryUsage("heap_used", memory.heapUsed);
    trackMemoryUsage("heap_total", memory.heapTotal);
    trackMemoryUsage("external", memory.external);
    const recordedMemory = memoryUsageBytes();
    metrics.cartethyia_memory_rss_bytes.set(recordedMemory["rss"] ?? 0);
    metrics.cartethyia_memory_heap_used_bytes.set(recordedMemory["heap_used"] ?? 0);
    metrics.cartethyia_memory_heap_total_bytes.set(recordedMemory["heap_total"] ?? 0);
    metrics.cartethyia_memory_limit_bytes.set(this.limitBytes ?? 0);
    this.snapshot = {
      rssBytes: recordedMemory["rss"] ?? 0,
      limitBytes: this.limitBytes,
      sampledAtMs: Date.now(),
    };

    const roundRobin = this.sources.routingRoundRobinEntries();
    metrics.cartethyia_routing_roundrobin_entries.set(roundRobin.combo, { scope: "combo" });
    metrics.cartethyia_routing_roundrobin_entries.set(roundRobin.provider, { scope: "provider" });
    metrics.cartethyia_ip_abuse_keys.set(this.sources.ipAbuseKeys());
    metrics.cartethyia_quota_cache_entries.set(this.sources.quotaCacheEntries());
    metrics.cartethyia_model_catalog_entries.set(this.sources.modelCatalogEntries());
    metrics.cartethyia_process_in_flight.set(this.inFlightSource());
    const backlog = this.sources.telemetryBacklog?.();
    if (backlog !== undefined) {
      metrics.cartethyia_telemetry_backlog_items.set(backlog.items);
      metrics.cartethyia_telemetry_backlog_bytes.set(backlog.bytes);
    }

    this.checkPressure(memory.rss);
    this.checkIdleReclaim(memory.rss);
  }

  private checkPressure(rss: number): void {
    if (this.limitBytes === undefined || rss <= this.limitBytes * PRESSURE_THRESHOLD) return;
    const now = Date.now();
    if (this.gcOnPressure && now - this.lastGcAt >= PRESSURE_GC_WINDOW_MS) {
      this.lastGcAt = now;
      // Asynchronous GC: reclaims before the limit is reached without stalling
      // in-flight requests on the shared event loop. A synchronous full
      // collection here would add a latency spike to every concurrent request.
      Bun.gc(false);
    }
    if (now - this.lastPressureLogAt < PRESSURE_LOG_WINDOW_MS) return;
    this.lastPressureLogAt = now;
    log.warn(
      `[memory] RSS ${(rss / 1024 / 1024).toFixed(1)}MiB exceeds 80% of the ` +
        `${(this.limitBytes / 1024 / 1024).toFixed(1)}MiB limit`,
    );
  }

  /**
   * Reclaims memory while the gateway is idle.
   *
   * Triggered on RSS growth rather than heap growth: this process holds most of
   * its footprint off-heap (adapters, TLS contexts, buffers), and `heapUsed`
   * barely moves when those are allocated — a heap-based gate never opens, which
   * is why an idle gateway held its startup peak indefinitely.
   *
   * A synchronous full collection is safe here because no request is in flight to
   * stall, and it is the only form that actually returns pages to the OS; the
   * async form used under pressure does not.
   *
   * Not gated on `gcOnPressure` the way `checkPressure` is. The opt-in exists
   * because a synchronous collection stalls concurrent requests, and this path
   * only runs when there is nothing in flight to stall — so the reason the flag
   * is off does not apply to it. Gating it meant a gateway with no traffic at
   * all never reclaimed anything and held its startup peak for hours.
   */
  private checkIdleReclaim(rss: number): void {
    if (this.inFlightSource() > 0) return;
    const now = Date.now();
    if (now - this.lastIdleGcAt < IDLE_GC_WINDOW_MS) return;
    if (this.rssAtLastGc !== 0 && rss - this.rssAtLastGc < IDLE_GC_MIN_GROWTH_BYTES) return;
    this.lastIdleGcAt = now;
    Bun.gc(true);
    this.rssAtLastGc = process.memoryUsage().rss;
  }
}
