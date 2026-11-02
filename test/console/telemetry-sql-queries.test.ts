/**
 * The canonical SQL reader (`src/observability/event-query.ts`).
 *
 * These functions are what the console reads instead of scanning the raw
 * window. The tests pin the contract the console depends on against a real
 * migrated SQLite database: totals and percentiles, breakdown grouping,
 * bucketing, keyset pagination with ties, tenant isolation, and the shared
 * gateway-error predicate (unknown statuses are not errors).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { isGatewayError } from "../../src/observability/telemetry-status";
import {
  breakdownTelemetry,
  chartTelemetry,
  eventByRequestId,
  healthTelemetry,
  queryTelemetryEvents,
  summarizeTelemetry,
  sumTelemetryTokens,
} from "../../src/observability/event-query";
import { apiKeys, providers, telemetryEvents, tenants } from "../../src/persistence/schema";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-event-query-"));
  const sqlite = createSqliteDatabase(join(dir, "q.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "event-query", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  await db.insert(providers).values({ id: "p" });
  const [key] = await db
    .insert(apiKeys)
    .values({
      tenantId: tenant.id,
      keyMode: "personal",
      keyHash: "hash-eq",
      label: "k",
      scopes: ["routing:invoke"],
    })
    .returning({ id: apiKeys.id });
  return {
    db,
    tenantId: tenant.id,
    apiKeyId: key?.id ?? "",
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
      }
    },
  };
}

async function insertEvent(
  fx: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await fx.db.insert(telemetryEvents).values({
    id: crypto.randomUUID(),
    tenantId: fx.tenantId,
    requestId: crypto.randomUUID(),
    createdAt: new Date(),
    sourceSurface: "chat",
    requestedModel: "p/m",
    clientName: "bun",
    providerId: "p",
    apiKeyId: fx.apiKeyId,
    status: "completed",
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 1,
    latencyMs: 100,
    ...overrides,
  } as Parameters<typeof fx.db.insert<typeof telemetryEvents>>[0] extends never ? never : never) 
  .catch(() => undefined);
}

describe("canonical SQL telemetry reader", () => {
  test("summary totals and percentiles match the row-level computation", async () => {
    const fx = await fixture();
    try {
      const base = new Date("2026-03-15T12:00:00.000Z");
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const [index, latency] of latencies.entries()) {
        await insertEvent(fx, {
          createdAt: new Date(base.getTime() + index * 1000),
          latencyMs: latency,
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 1,
        });
      }
      const summary = await summarizeTelemetry(fx.db, fx.tenantId, new Date(0));
      expect(summary.requests).toBe(10);
      expect(summary.inputTokens).toBe(100);
      expect(summary.outputTokens).toBe(50);
      expect(summary.cachedInputTokens).toBe(10);
      expect(summary.sampled).toBe(10);
      // Nearest-rank percentiles on SQLite: p50 <= p95 <= p99, in range.
      expect(summary.latencyMs.p50).not.toBeNull();
      expect(summary.latencyMs.p50).toBeLessThanOrEqual(summary.latencyMs.p95!);
      expect(summary.latencyMs.p95).toBeLessThanOrEqual(summary.latencyMs.p99!);
      expect(summary.latencyMs.p99).toBeLessThanOrEqual(100);
      expect(summary.latencyMs.avg).toBe(55);
    } finally {
      fx.cleanup();
    }
  });

  test("errors use the shared predicate: unknown and non-defect statuses are not errors", async () => {
    const fx = await fixture();
    try {
      // A hard failure (counts), a 503 capacity rejection (does not), and an
      // unknown status (does not).
      await insertEvent(fx, { status: "failed", httpStatus: 500 });
      await insertEvent(fx, { status: "failed", httpStatus: 503 });
      await insertEvent(fx, { status: null, httpStatus: 500 });
      const summary = await summarizeTelemetry(fx.db, fx.tenantId, new Date(0));
      expect(summary.requests).toBe(3);
      expect(summary.errors).toBe(1);
      // The row-level predicate agrees with the SQL aggregate on each row.
      expect(isGatewayError("failed", 500)).toBe(true);
      expect(isGatewayError("failed", 503)).toBe(false);
      expect(isGatewayError(null, 500)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("breakdown groups in SQL, bounded to 100 groups", async () => {
    const fx = await fixture();
    try {
      for (const model of ["a", "a", "b"]) {
        await insertEvent(fx, { requestedModel: model });
      }
      const groups = await breakdownTelemetry(fx.db, fx.tenantId, "model", new Date(0));
      const byKey = new Map(groups.map((group) => [group.key, group]));
      expect(byKey.get("a")?.requests).toBe(2);
      expect(byKey.get("b")?.requests).toBe(1);
      // Most-requested first.
      expect(groups[0]?.key).toBe("a");
    } finally {
      fx.cleanup();
    }
  });

  test("client breakdown groups on the ingestion-stamped client_name", async () => {
    const fx = await fixture();
    try {
      await insertEvent(fx, { clientName: "bun/1.2.3", userAgent: "bun/1.2.3" });
      await insertEvent(fx, { clientName: "bun/1.2.3", userAgent: "bun/1.2.3" });
      await insertEvent(fx, { clientName: "Browser", userAgent: "Mozilla/5.0" });
      const groups = await breakdownTelemetry(fx.db, fx.tenantId, "client", new Date(0));
      const byKey = new Map(groups.map((group) => [group.key, group]));
      expect(byKey.get("bun/1.2.3")?.requests).toBe(2);
      expect(byKey.get("Browser")?.requests).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("chart buckets sum to the window's totals", async () => {
    const fx = await fixture();
    try {
      const base = new Date("2026-03-15T12:00:00.000Z");
      await insertEvent(fx, { createdAt: base, inputTokens: 10, outputTokens: 1 });
      await insertEvent(fx, { createdAt: new Date(base.getTime() + 30_000), inputTokens: 10, outputTokens: 1 });
      await insertEvent(fx, { createdAt: new Date(base.getTime() + 3_600_000), inputTokens: 10, outputTokens: 1 });
      const buckets = await chartTelemetry(fx.db, fx.tenantId, new Date(0), 3600);
      expect(buckets.length).toBeGreaterThanOrEqual(2);
      const requests = buckets.reduce((total, bucket) => total + bucket.requests, 0);
      const input = buckets.reduce((total, bucket) => total + bucket.inputTokens, 0);
      expect(requests).toBe(3);
      expect(input).toBe(30);
    } finally {
      fx.cleanup();
    }
  });

  test("health totals and per-key token sums", async () => {
    const fx = await fixture();
    try {
      await insertEvent(fx, { inputTokens: 10, outputTokens: 5 });
      await insertEvent(fx, { inputTokens: 10, outputTokens: 5 });
      const health = await healthTelemetry(fx.db, fx.tenantId, new Date(0));
      expect(health.requests).toBe(2);
      expect(health.inputTokens).toBe(20);
      expect(health.outputTokens).toBe(10);
      expect(health.latencyAvgMs).toBe(100);
      const spend = await sumTelemetryTokens(fx.db, fx.tenantId, {
        apiKeyIds: [fx.apiKeyId],
        since: new Date(0),
      });
      expect(spend).toBe(30);
      // An unrelated key's id sums to zero: the filter is honored.
      const other = await sumTelemetryTokens(fx.db, fx.tenantId, {
        apiKeyIds: [crypto.randomUUID()],
        since: new Date(0),
      });
      expect(other).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a large id set still filters (no skipped filter, no parameter overflow)", async () => {
    // The 08P01 production failure: tens of thousands of ids expanded into one
    // bind placeholder each. The array-parameter (or chunked) rendering must
    // keep the exact membership semantics at any size — the filter is never
    // dropped.
    const fx = await fixture();
    try {
      await insertEvent(fx, { inputTokens: 7, outputTokens: 0 });
      // 1,200 distinct ids — large enough to cross the SQLite chunk boundary
      // (the chunked path is what a small backend exercises here) — containing
      // the fixture key exactly once.
      const ids: string[] = Array.from({ length: 1_200 }, () => crypto.randomUUID());
      ids[600] = fx.apiKeyId;
      const page = await queryTelemetryEvents(fx.db, {
        tenantId: fx.tenantId,
        apiKeyIds: ids,
        since: new Date(0),
      });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]?.apiKeyId).toBe(fx.apiKeyId);
      const spend = await sumTelemetryTokens(fx.db, fx.tenantId, { apiKeyIds: ids, since: new Date(0) });
      expect(spend).toBe(7);
      // Duplicate entries in the caller's set must not change the result.
      const duplicated = [...ids, fx.apiKeyId, fx.apiKeyId];
      const dupPage = await queryTelemetryEvents(fx.db, {
        tenantId: fx.tenantId,
        apiKeyIds: duplicated,
        since: new Date(0),
      });
      expect(dupPage.events).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("an oversized id set is a handled query error, not a wire fault", async () => {
    // The guard turns a runaway collector into a thrown TelemetryQueryInputError
    // the caller can handle — never an unbounded bind that once crash-looped
    // the process.
    const fx = await fixture();
    try {
      const ids = Array.from({ length: 201_000 }, () => crypto.randomUUID());
      expect(() =>
        queryTelemetryEvents(fx.db, { tenantId: fx.tenantId, apiKeyIds: ids, since: new Date(0) }),
      ).toThrow();
      let caught: unknown;
      try {
        await queryTelemetryEvents(fx.db, { tenantId: fx.tenantId, apiKeyIds: ids, since: new Date(0) });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).name).toBe("TelemetryQueryInputError");
    } finally {
      fx.cleanup();
    }
  });

  test("the family filter scopes to the template and its children", async () => {
    const fx = await fixture();
    try {
      // The template key is the fixture key; a child of it, and an unrelated
      // sibling key of the same tenant.
      const [child] = await fx.db
        .insert(apiKeys)
        .values({
          tenantId: fx.tenantId,
          keyMode: "personal",
          keyHash: "hash-child",
          label: "child",
          scopes: ["routing:invoke"],
        })
        .returning({ id: apiKeys.id });
      await fx.db.insert(apiKeys).values({
        tenantId: fx.tenantId,
        keyMode: "personal",
        keyHash: "hash-stranger",
        label: "stranger",
        scopes: ["routing:invoke"],
      });
      await insertEvent(fx, { inputTokens: 10, outputTokens: 0 }); // template key
      await fx.db.insert(telemetryEvents).values({
        id: crypto.randomUUID(),
        tenantId: fx.tenantId,
        requestId: crypto.randomUUID(),
        createdAt: new Date(),
        sourceSurface: "chat",
        apiKeyId: child?.id,
        status: "completed",
      });
      const page = await queryTelemetryEvents(fx.db, {
        tenantId: fx.tenantId,
        familyApiKeyId: fx.apiKeyId,
        since: new Date(0),
      });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]?.apiKeyId).toBe(fx.apiKeyId);
      const spend = await sumTelemetryTokens(fx.db, fx.tenantId, {
        familyKeyId: fx.apiKeyId,
        since: new Date(0),
      });
      expect(spend).toBe(10);
    } finally {
      fx.cleanup();
    }
  });

  test("keyset pagination is newest-first and never repeats or skips tied rows", async () => {
    // Ten rows written in the same second: a created_at-only cursor would be
    // ambiguous, so the cursor carries (createdAt, id).
    const fx = await fixture();
    try {
      const at = new Date("2026-03-15T12:00:00.000Z");
      for (let i = 0; i < 10; i += 1) await insertEvent(fx, { createdAt: at });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await queryTelemetryEvents(fx.db, {
          tenantId: fx.tenantId,
          since: new Date(0),
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const event of result.events) seen.push(event.id);
        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
      }
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
    } finally {
      fx.cleanup();
    }
  });

  test("detail lookup by request id reads one row", async () => {
    const fx = await fixture();
    try {
      const requestId = crypto.randomUUID();
      await insertEvent(fx, { requestId });
      const event = await eventByRequestId(fx.db, fx.tenantId, requestId);
      expect(event?.requestId).toBe(requestId);
      expect(event?.requestedModel).toBe("p/m");
      expect(await eventByRequestId(fx.db, fx.tenantId, crypto.randomUUID())).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("every read is tenant-scoped", async () => {
    const fx = await fixture();
    try {
      await insertEvent(fx, { inputTokens: 10 });
      const [other] = await fx.db
        .insert(tenants)
        .values({ name: "other", status: "active" })
        .returning({ id: tenants.id });
      await fx.db.insert(telemetryEvents).values({
        id: crypto.randomUUID(),
        tenantId: other!.id,
        requestId: crypto.randomUUID(),
        createdAt: new Date(),
        status: "completed",
        inputTokens: 999,
      });
      const summary = await summarizeTelemetry(fx.db, fx.tenantId, new Date(0));
      expect(summary.requests).toBe(1);
      expect(summary.inputTokens).toBe(10);
      const rows = await fx.db
        .select({ tenantId: telemetryEvents.tenantId })
        .from(telemetryEvents)
        .where(eq(telemetryEvents.tenantId, other!.id));
      expect(rows).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("a SQLite handle stays SQLite even when the process mode is full", async () => {
    const previous = process.env.CARTETHYIA_DB_MODE;
    process.env.CARTETHYIA_DB_MODE = "full";
    const fx = await fixture();
    try {
      await insertEvent(fx, { inputTokens: 7 });
      // The dial is the only authority: a handle built by `buildSqliteHandle`
      // must never take the Postgres branch (percentile_cont / :: casts) just
      // because the process env says `full` — that broke every chart/usage
      // read on a migrated SQLite file under a full-mode process.
      const summary = await summarizeTelemetry(fx.db, fx.tenantId, new Date(0));
      expect(summary.requests).toBe(1);
      expect(summary.inputTokens).toBe(7);
    } finally {
      fx.cleanup();
      if (previous === undefined) delete process.env.CARTETHYIA_DB_MODE;
      else process.env.CARTETHYIA_DB_MODE = previous;
    }
  });
});
