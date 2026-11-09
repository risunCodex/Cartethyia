/**
 * Cached-token aggregation must sum the cached count, not the whole input.
 *
 * A request that hits the cache at all still carries fresh tokens, and the
 * Usage page prices nothing itself — it only displays what the aggregate
 * reports. Counting every input token of a cache-touching request as cached
 * made a 99.6% hit rate out of traffic that was not, and made the estimated
 * cost look like it ignored the cache. The cost is computed per request from
 * the real split; only the displayed cached total was wrong.
 *
 * The read surface is the canonical SQL reader (`event-query.ts`): the same
 * `summarizeUsageWithPerformance` aggregate the Usage page runs, so this pins
 * the contract the console depends on. The raw-file fold (the old `accumulate`
 * helper) is gone with the file reader that used it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import { telemetryEvents, tenants } from "../../src/persistence/schema";
import { summarizeUsageWithPerformance } from "../../src/observability/event-query";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-cached-tokens-"));
  const sqlite = createSqliteDatabase(join(dir, "cached.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "cached-token", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  const insert = (inputTokens: number, cachedInputTokens: number | null) =>
    db.insert(telemetryEvents).values({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      requestId: crypto.randomUUID(),
      createdAt: new Date(),
      sourceSurface: "chat",
      status: "completed",
      httpStatus: 200,
      inputTokens,
      cachedInputTokens,
      outputTokens: 0,
    });
  return {
    db,
    tenantId: tenant.id,
    insert,
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
      }
    },
  };
}

describe("cached token totals", () => {
  test("a partial cache hit counts only the cached tokens, not the whole input", async () => {
    const fx = await fixture();
    try {
      // Hit: carries cache -> whole input counts as cached (eligible-request rule).
      await fx.insert(1_000, 900);
      // Miss: no cache -> nothing counts as cached.
      await fx.insert(500, null);
      const { summary } = await summarizeUsageWithPerformance(fx.db, fx.tenantId, new Date(0));
      expect(summary.inputTokens).toBe(1_500);
      expect(summary.cachedInputTokens).toBe(1_000);
    } finally {
      fx.cleanup();
    }
  });

  test("a reported zero cache is a miss, not a hit", async () => {
    const fx = await fixture();
    try {
      await fx.insert(300, 0);
      const { summary } = await summarizeUsageWithPerformance(fx.db, fx.tenantId, new Date(0));
      expect(summary.cachedInputTokens).toBe(0);
    } finally {
      fx.cleanup();
    }
  });
});
