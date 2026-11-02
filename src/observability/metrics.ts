/**
 * Hand-rolled Prometheus text-format registry (Requirement: no new dependency).
 * A module-level singleton (`metrics`) mirrors the existing `getDb` singleton
 * pattern. Callers obtain pre-registered families as named properties;
 * `render()` emits the Prometheus exposition format on demand.
 */

type MetricLabels = Readonly<Record<string, string | number>>;

interface CounterMetric {
  inc(value?: number, labels?: MetricLabels): void;
}

interface GaugeMetric extends CounterMetric {
  set(value: number, labels?: MetricLabels): void;
  dec(value?: number, labels?: MetricLabels): void;
}

interface HistogramMetric {
  observe(value: number, labels?: MetricLabels): void;
}

function escapeLabelValue(value: string | number): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function serializeLabels(labelNames: readonly string[], labels: MetricLabels | undefined): string {
  return labelNames.map((name) => String(labels?.[name] ?? "")).join("\u0001");
}

function renderLabelSet(labelNames: readonly string[], labels: MetricLabels): string {
  if (labelNames.length === 0) return "";
  const parts = labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

// Cardinality guards prevent unbounded label expansion from untrusted input
// such as attacker-controlled status and reason values from exhausting memory.
export const MAX_SERIES = 100;
export const MAX_LABELS = 8;
export const MAX_LABEL_VALUE_LENGTH = 64;

/** Shared frozen empty label set for the label-free fast path. */
const EMPTY_LABELS: MetricLabels = Object.freeze({});

/** Sanitize and truncate labels to guard cardinality and memory. */
export function normalizeLabels(
  labels: MetricLabels | undefined,
  labelNames: readonly string[],
): MetricLabels {
  if (!labels || labelNames.length === 0) return {};
  const out: Record<string, string> = {};
  let kept = 0;
  for (const name of labelNames) {
    if (kept >= MAX_LABELS) break;
    const raw = labels[name];
    if (raw === undefined) {
      out[name] = "";
      kept += 1;
      continue;
    }
    let value = String(raw).replace(/[\n\r"]/g, "_");
    if (value.length > MAX_LABEL_VALUE_LENGTH) value = value.slice(0, MAX_LABEL_VALUE_LENGTH);
    // Trim whitespace and collapse empty to placeholder to keep key stable.
    value = value.trim();
    out[name] = value;
    kept += 1;
  }
  return out;
}

/** True if a new series key may be added without exceeding MAX_SERIES. */
function canAddSeries(series: Map<string, unknown>, key: string): boolean {
  if (series.has(key)) return true;
  return series.size < MAX_SERIES;
}

/**
 * Shared storage, cardinality guard, and exposition rendering for the scalar
 * families. Counter and Gauge differ only in the Prometheus type word they
 * emit; the sample store, label normalization, series guard, and `inc`
 * accumulation are identical, so both extend this base to keep the wire format
 * single-sourced.
 */
abstract class ScalarMetric {
  private readonly samples = new Map<string, { labels: MetricLabels; value: number }>();

  /** The Prometheus type word emitted on the `# TYPE` line. */
  protected abstract readonly metricType: string;

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
  ) {
    if (labelNames.length > MAX_LABELS) {
      throw new Error(`metric ${name}: too many label names ${labelNames.length} > ${MAX_LABELS}`);
    }
  }

  inc(value = 1, labels?: MetricLabels): void {
    // Label-free fast path: skips normalize (alloc) + join per inc.
    if (this.labelNames.length === 0) {
      const previous = this.samples.get("");
      this.samples.set("", {
        labels: EMPTY_LABELS,
        value: (previous?.value ?? 0) + value,
      });
      return;
    }
    const normalized = normalizeLabels(labels, this.labelNames);
    const key = serializeLabels(this.labelNames, normalized);
    if (!canAddSeries(this.samples, key)) return;
    const previous = this.samples.get(key);
    this.samples.set(key, {
      labels: normalized,
      value: (previous?.value ?? 0) + value,
    });
  }

  /** Absolute assignment for gauge semantics, guarded like `inc`. */
  protected setSample(value: number, labels?: MetricLabels): void {
    const normalized = normalizeLabels(labels, this.labelNames);
    const key = serializeLabels(this.labelNames, normalized);
    if (!canAddSeries(this.samples, key)) return;
    this.samples.set(key, { labels: normalized, value });
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.metricType}`,
    ];
    for (const sample of this.samples.values()) {
      lines.push(`${this.name}${renderLabelSet(this.labelNames, sample.labels)} ${sample.value}`);
    }
    return lines;
  }
}

class Counter extends ScalarMetric implements CounterMetric {
  protected readonly metricType = "counter";
}

class Gauge extends ScalarMetric implements GaugeMetric {
  protected readonly metricType = "gauge";

  set(value: number, labels?: MetricLabels): void {
    this.setSample(value, labels);
  }

  dec(value = 1, labels?: MetricLabels): void {
    this.inc(-value, labels);
  }
}

/** One histogram series: the accumulators for a single label set. */
interface HistogramSeries {
  labels: MetricLabels;
  sum: number;
  count: number;
  bucketCounts: number[];
}

class Histogram implements HistogramMetric {
  private readonly series = new Map<string, HistogramSeries>();
  /**
   * The label names this histogram emits. Declared at registration when the
   * caller passes them to `histogram()`, otherwise fixed by the first LABELLED
   * observation. A Prometheus metric family must expose one consistent label
   * set, so a later observation carrying different keys is normalized against
   * this set rather than creating a second, incompatible series.
   */
  private labelNames: readonly string[] = [];

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
    labelNames: readonly string[] = [],
  ) {
    // A declared set is stable across runs and workers, so the exposition is
    // deterministic even before the first observation arrives. Sorting keeps
    // the order fixed either way.
    this.labelNames = [...labelNames].sort();
  }

  observe(value: number, labels?: MetricLabels): void {
    // Fall back to inferring the set from the first labelled observation when
    // the metric was registered without declaring one.
    if (this.labelNames.length === 0 && labels !== undefined) {
      this.labelNames = Object.keys(labels).sort();
    }
    const normalized = normalizeLabels(labels, this.labelNames);
    const key = serializeLabels(this.labelNames, normalized);
    if (!canAddSeries(this.series, key)) return;
    let sample = this.series.get(key);
    if (sample === undefined) {
      sample = { labels: normalized, sum: 0, count: 0, bucketCounts: this.buckets.map(() => 0) };
      this.series.set(key, sample);
    }
    sample.sum += value;
    sample.count += 1;
    for (let index = 0; index < this.buckets.length; index += 1) {
      const bucket = this.buckets[index];
      if (bucket !== undefined && value <= bucket) sample.bucketCounts[index]! += 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    // An unlabelled histogram that has never been observed still renders its
    // zeroed buckets, so a scrape before the first request is not an absent
    // metric. A labelled one renders one block per observed series.
    const samples =
      this.series.size > 0 ? [...this.series.values()] : [this.emptySeries()];
    for (const sample of samples) {
      const suffix = renderLabelSet(this.labelNames, sample.labels);
      for (let index = 0; index < this.buckets.length; index += 1) {
        const bucket = this.buckets[index];
        if (bucket === undefined) continue;
        const inner = this.bucketLabels(sample.labels, `le="${escapeLabelValue(bucket)}"`);
        lines.push(`${this.name}_bucket{${inner}} ${sample.bucketCounts[index] ?? 0}`);
      }
      lines.push(
        `${this.name}_bucket{${this.bucketLabels(sample.labels, 'le="+Inf"')}} ${sample.count}`,
      );
      lines.push(`${this.name}_sum${suffix} ${sample.sum}`);
      lines.push(`${this.name}_count${suffix} ${sample.count}`);
    }
    return lines;
  }

  /** A zeroed series, used only when nothing has been observed yet. */
  private emptySeries(): HistogramSeries {
    return { labels: {}, sum: 0, count: 0, bucketCounts: this.buckets.map(() => 0) };
  }

  /**
   * The `{...}` body of a `_bucket` line: the declared labels plus the `le`
   * bucket boundary. `le` is appended last so the label order matches what a
   * Prometheus scraper expects to find.
   */
  private bucketLabels(labels: MetricLabels, le: string): string {
    const declared = this.labelNames
      .map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`)
      .filter((part) => part.length > 0);
    return [...declared, le].join(",");
  }
}

interface RenderableMetric {
  render(): string[];
}

const REQUEST_LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
const ADAPTER_LOAD_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;

export class PrometheusRegistry {
  readonly cartethyia_pg_pool_total: GaugeMetric;
  readonly cartethyia_pg_pool_idle: GaugeMetric;
  readonly cartethyia_pg_pool_waiting: GaugeMetric;
  readonly cartethyia_redis_up: GaugeMetric;
  readonly proxy_requests_total: CounterMetric;
  readonly proxy_admission_total: CounterMetric;
  /**
   * Refusals from the per-IP abuse layer, by reason.
   *
   * These are the only 429s this process produces before dispatch, and they
   * were invisible: a client-facing 429 could come from here, from admission,
   * or from the upstream, and nothing recorded which. `ip-rate-limited` is the
   * sliding window and `ip-banned` the escalation — different remedies, so
   * they must not share a number.
   */
  readonly cartethyia_ip_abuse_refusals_total: CounterMetric;
  readonly proxy_in_flight: GaugeMetric;
  readonly proxy_request_latency_ms: HistogramMetric;
  readonly cartethyia_telemetry_buffered: GaugeMetric;
  readonly cartethyia_telemetry_dropped_total: CounterMetric;
  readonly cartethyia_memory_rss_bytes: GaugeMetric;
  readonly cartethyia_memory_heap_used_bytes: GaugeMetric;
  readonly cartethyia_memory_heap_total_bytes: GaugeMetric;
  readonly cartethyia_memory_limit_bytes: GaugeMetric;
  readonly cartethyia_routing_roundrobin_entries: GaugeMetric;
  readonly cartethyia_ip_abuse_keys: GaugeMetric;
  readonly cartethyia_quota_cache_entries: GaugeMetric;
  readonly cartethyia_model_catalog_entries: GaugeMetric;
  readonly cartethyia_process_in_flight: GaugeMetric;
  readonly cartethyia_telemetry_backlog_items: GaugeMetric;
  readonly cartethyia_telemetry_backlog_bytes: GaugeMetric;
  readonly cartethyia_proxy_dial_proxy_resolved_total: CounterMetric;
  readonly proxy_provider_adapter_load_ms: HistogramMetric;
  readonly pool_cooldown_record_failed: CounterMetric;
  readonly quota_cache_invalidate_failed: CounterMetric;
  /** Payload frames dropped because the writer backlog was at its bound. */
  readonly cartethyia_payload_backlog_dropped_total: CounterMetric;
  /**
   * Telemetry backfill conflicts: same (tenant, request) identity with
   * different content. Reported, never overwritten.
   */
  readonly cartethyia_telemetry_raw_conflicts_total: CounterMetric;

  private readonly all: RenderableMetric[] = [];

  constructor() {
    this.cartethyia_pg_pool_total = this.gauge(
      "cartethyia_pg_pool_total",
      "Total connections in the Postgres pool",
    );
    this.cartethyia_pg_pool_idle = this.gauge(
      "cartethyia_pg_pool_idle",
      "Idle connections in the Postgres pool",
    );
    this.cartethyia_pg_pool_waiting = this.gauge(
      "cartethyia_pg_pool_waiting",
      "Clients waiting for a Postgres pool connection",
    );
    this.cartethyia_redis_up = this.gauge("cartethyia_redis_up", "Redis connectivity (1 = ready)");
    this.proxy_requests_total = this.counter(
      "proxy_requests_total",
      "Completed proxy requests by outcome status",
      ["status"],
    );
    this.proxy_admission_total = this.counter(
      "proxy_admission_total",
      "Admission decisions by reason",
      ["reason"],
    );
    this.cartethyia_ip_abuse_refusals_total = this.counter(
      "cartethyia_ip_abuse_refusals_total",
      "Requests refused by the per-IP abuse limit, by reason",
      ["reason"],
    );
    this.proxy_in_flight = this.gauge(
      "proxy_in_flight",
      "Provider dispatch requests currently in flight on this process",
    );
    this.proxy_request_latency_ms = this.histogram(
      "proxy_request_latency_ms",
      "Request latency in milliseconds",
      REQUEST_LATENCY_BUCKETS,
    );
    this.cartethyia_telemetry_buffered = this.gauge(
      "cartethyia_telemetry_buffered",
      "Telemetry events waiting to be flushed",
    );
    this.cartethyia_telemetry_dropped_total = this.counter(
      "cartethyia_telemetry_dropped_total",
      "Telemetry events dropped because the buffer was full",
    );
    this.cartethyia_memory_rss_bytes = this.gauge(
      "cartethyia_memory_rss_bytes",
      "Resident set size of the process in bytes",
    );
    this.cartethyia_memory_heap_used_bytes = this.gauge(
      "cartethyia_memory_heap_used_bytes",
      "JavaScript heap used in bytes",
    );
    this.cartethyia_memory_heap_total_bytes = this.gauge(
      "cartethyia_memory_heap_total_bytes",
      "JavaScript heap reserved in bytes",
    );
    this.cartethyia_memory_limit_bytes = this.gauge(
      "cartethyia_memory_limit_bytes",
      "Container/cgroup memory limit in bytes (0 when unknown)",
    );
    this.cartethyia_process_in_flight = this.gauge(
      "cartethyia_process_in_flight",
      "Gateway requests currently admitted into this process",
    );
    this.cartethyia_telemetry_backlog_items = this.gauge(
      "cartethyia_telemetry_backlog_items",
      "Telemetry events queued for the next drain",
    );
    this.cartethyia_telemetry_backlog_bytes = this.gauge(
      "cartethyia_telemetry_backlog_bytes",
      "Estimated bytes queued for the next telemetry drain",
    );
    this.cartethyia_routing_roundrobin_entries = this.gauge(
      "cartethyia_routing_roundrobin_entries",
      "Round-robin routing state entries by scope",
      ["scope"],
    );
    this.cartethyia_ip_abuse_keys = this.gauge(
      "cartethyia_ip_abuse_keys",
      "Tracked keys in the in-memory IP abuse store (0 when Redis-backed)",
    );
    this.cartethyia_quota_cache_entries = this.gauge(
      "cartethyia_quota_cache_entries",
      "Entries in the in-process provider quota cache",
    );
    this.cartethyia_model_catalog_entries = this.gauge(
      "cartethyia_model_catalog_entries",
      "Entries in the per-provider model catalog cache (at the cap means eviction churn)",
    );
    this.cartethyia_proxy_dial_proxy_resolved_total = this.counter(
      "cartethyia_proxy_dial_proxy_resolved_total",
      "Pool/relay-bound dials whose target is resolved by the proxy or relay rather than by the local resolver, so local DNS for the target is advisory only",
    );
    this.proxy_provider_adapter_load_ms = this.histogram(
      "proxy_provider_adapter_load_ms",
      "Time to load a provider adapter on first use",
      ADAPTER_LOAD_BUCKETS,
    );
    this.pool_cooldown_record_failed = this.counter(
      "pool_cooldown_record_failed",
      "Pool cooldown writes that failed after a provider rate limit",
    );
    this.quota_cache_invalidate_failed = this.counter(
      "quota_cache_invalidate_failed",
      "Quota cache invalidations that failed",
    );
    this.cartethyia_payload_backlog_dropped_total = this.counter(
      "cartethyia_payload_backlog_dropped_total",
      "Payload captures dropped because the payload writer backlog was full",
    );
    this.cartethyia_telemetry_raw_conflicts_total = this.counter(
      "cartethyia_telemetry_raw_conflicts_total",
      "Telemetry backfill conflicts (same tenant/request identity, different content)",
    );
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): CounterMetric {
    const metric = new Counter(name, help, labelNames);
    this.all.push(metric);
    return metric;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): GaugeMetric {
    const metric = new Gauge(name, help, labelNames);
    this.all.push(metric);
    return metric;
  }

  /**
   * Registers a histogram.
   *
   * `labelNames` declares the label set up front. It is optional because a
   * histogram observed without labels still has to render, but passing it is
   * the correct call: a declared set is stable across runs and workers, so the
   * exposition is deterministic even before the first observation, and an
   * observation carrying undeclared keys cannot create a second, incompatible
   * series.
   */
  histogram(
    name: string,
    help: string,
    buckets: readonly number[],
    labelNames: readonly string[] = [],
  ): HistogramMetric {
    const metric = new Histogram(name, help, buckets, labelNames);
    this.all.push(metric);
    return metric;
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.all) lines.push(...metric.render());
    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new PrometheusRegistry();
