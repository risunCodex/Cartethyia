/**
 * The runtime sampler must reach the app so its in-flight source gets bound.
 *
 * `main.ts` passed every dependency except the sampler, so
 * `createGatewayApp`'s `bindInFlight` call never ran and the sampler kept the
 * constructor's `() => 0` placeholder. `cartethyia_process_in_flight` then
 * reported zero while `proxy_in_flight` — the registry the placeholder was
 * meant to read — reported real flights.
 *
 * That is not cosmetic. `checkIdleReclaim` gates on `inFlightSource() > 0`,
 * so a permanently-zero source made the gateway believe nothing was in
 * flight and run a synchronous `Bun.gc(true)` under load. A synchronous
 * collection stalls concurrent requests, which is what pinned latency to the
 * request deadline and produced the wall of client-cancelled 499s.
 *
 * The failure was in composition, not in either class: both behaved exactly
 * as written, and only the wire between them was missing. The gauge can only
 * be written, never read, so these observe what the sampler publishes by
 * wrapping its setter.
 */
import { expect, test } from "bun:test";
import { RuntimeMetricsSampler } from "../../src/observability/runtime-metrics";
import { metrics } from "../../src/observability/metrics";
import {
  performanceMetricsSnapshot,
  resetPerformanceMetricsForTesting,
} from "../../src/observability/performance-metrics";

function makeSampler(): RuntimeMetricsSampler {
  return new RuntimeMetricsSampler({
    routingRoundRobinEntries: () => ({ combo: 0, provider: 0 }),
    ipAbuseKeys: () => 0,
    quotaCacheEntries: () => 0,
    modelCatalogEntries: () => 0,
    inFlight: () => 0,
    telemetryBacklog: () => undefined,
  });
}

/** Observes the value the sampler publishes, by wrapping the gauge's setter. */
function publishedInFlight(sampler: RuntimeMetricsSampler): number | undefined {
  let published: number | undefined;
  const gauge = metrics.cartethyia_process_in_flight;
  const realSet = gauge.set.bind(gauge);
  gauge.set = (value: number) => {
    published = value;
    realSet(value);
  };
  try {
    sampler.sample();
  } finally {
    gauge.set = realSet;
  }
  return published;
}

test("an unbound sampler publishes the zero placeholder", () => {
  expect(publishedInFlight(makeSampler())).toBe(0);
});

test("bindInFlight replaces the placeholder with the live source", () => {
  const sampler = makeSampler();
  let flights = 4;
  sampler.bindInFlight(() => flights);
  expect(publishedInFlight(sampler)).toBe(4);
  // Read per sample, not captured once at bind time.
  flights = 9;
  expect(publishedInFlight(sampler)).toBe(9);
});

test("the source is read fresh on every sample, not captured once", () => {
  const sampler = makeSampler();
  const seen: number[] = [];
  let flights = 0;
  sampler.bindInFlight(() => flights);
  for (const value of [1, 2, 3]) {
    flights = value;
    seen.push(publishedInFlight(sampler) ?? -1);
  }
  expect(seen).toEqual([1, 2, 3]);
});

// The memory four are recorded once per sample into the performance-metrics
// series, and the Prometheus gauges are derived from that same series — the
// two views must always agree, and the snapshot must keep the `external` key
// (which has no gauge equivalent).
test("the memory gauges equal the performance snapshot after one sample", () => {
  resetPerformanceMetricsForTesting();
  try {
    makeSampler().sample();
    const snapshot = performanceMetricsSnapshot().memory_bytes;
    const sampleLine = (name: string): number => {
      const line = metrics.render().split("\n").find((text) => text.startsWith(`${name} `));
      if (line === undefined) throw new Error(`gauge ${name} missing from registry`);
      const value = Number(line.slice(line.lastIndexOf(" ") + 1));
      expect(Number.isFinite(value)).toBe(true);
      return value;
    };
    expect(snapshot["rss"]).toBe(sampleLine("cartethyia_memory_rss_bytes"));
    expect(snapshot["heap_used"]).toBe(sampleLine("cartethyia_memory_heap_used_bytes"));
    expect(snapshot["heap_total"]).toBe(sampleLine("cartethyia_memory_heap_total_bytes"));
    // `external` lives only in the series/snapshot — no gauge exists for it.
    expect(typeof snapshot["external"]).toBe("number");
    expect(Number.isFinite(snapshot["external"])).toBe(true);
    // All four keys are fixed contract.
    expect(Object.keys(snapshot).sort()).toEqual(["external", "heap_total", "heap_used", "rss"]);
  } finally {
    resetPerformanceMetricsForTesting();
  }
});
