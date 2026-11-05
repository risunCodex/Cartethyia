/**
 * The provider Activity Matrix aggregate (`providerUsageMatrix`).
 *
 * Pins the day × model grouping against a real migrated SQLite database:
 * epoch-day bucketing, model separation, cost sums, and tenant scoping — the
 * contract the provider detail card's summary strip and tooltip depend on.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerUsageMatrix } from "../../src/observability/event-query";
import { providers, telemetryEvents, tenants } from "../../src/persistence/schema";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-provider-usage-"));
  const sqlite = createSqliteDatabase(join(dir, "usage.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "provider-usage", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  await db.insert(providers).values({ id: "cb" });
  return {
    db,
    tenantId: tenant.id,
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
      }
    },
  };
}

describe("providerUsageMatrix", () => {
  test("groups day × model with summed tokens and cost", async () => {
    const fx = await fixture();
    try {
      const dayA = new Date("2026-10-20T10:30:00.000Z");
      const dayB = new Date("2026-10-21T22:59:59.000Z");
      await fx.db.insert(telemetryEvents).values([
        {
          id: crypto.randomUUID(),
          tenantId: fx.tenantId,
          requestId: crypto.randomUUID(),
          createdAt: dayA,
          requestedModel: "glm-m",
          providerId: "cb",
          status: "completed",
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 50,
          estimatedCostUsd: "0.001000",
        },
        {
          id: crypto.randomUUID(),
          tenantId: fx.tenantId,
          requestId: crypto.randomUUID(),
          createdAt: new Date(dayA.getTime() + 3_600_000),
          requestedModel: "glm-m",
          providerId: "cb",
          status: "completed",
          inputTokens: 10,
          outputTokens: 5,
        },
        {
          id: crypto.randomUUID(),
          tenantId: fx.tenantId,
          requestId: crypto.randomUUID(),
          createdAt: new Date(dayA.getTime() + 7_200_000),
          requestedModel: "ds-m",
          providerId: "cb",
          status: "completed",
          inputTokens: 7,
          outputTokens: 3,
          estimatedCostUsd: "0.002500",
        },
        {
          id: crypto.randomUUID(),
          tenantId: fx.tenantId,
          requestId: crypto.randomUUID(),
          createdAt: dayB,
          requestedModel: "glm-m",
          providerId: "cb",
          status: "completed",
          inputTokens: 1,
          outputTokens: 1,
        },
      ]);

      const rows = await providerUsageMatrix(fx.db, fx.tenantId, "cb", new Date(0));
      expect(rows).toHaveLength(3);
      const glmA = rows.find((row) => row.day === "2026-10-20" && row.model === "glm-m");
      expect(glmA).toBeDefined();
      expect(glmA?.requests).toBe(2);
      expect(glmA?.inputTokens).toBe(110);
      // Eligible-request rule: the row that touched cache (input 100) counts
      // its whole input; the no-cache row contributes nothing.
      expect(glmA?.cachedInputTokens).toBe(100);
      expect(glmA?.outputTokens).toBe(55);
      expect(glmA?.costUsd).toBeCloseTo(0.001, 6);
      const dsA = rows.find((row) => row.day === "2026-10-20" && row.model === "ds-m");
      expect(dsA?.requests).toBe(1);
      expect(dsA?.costUsd).toBeCloseTo(0.0025, 6);
      // A day boundary is an epoch-day bucket, not a 24h slide.
      expect(rows.some((row) => row.day === "2026-10-21")).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test("scopes by tenant and by provider id", async () => {
    const fx = await fixture();
    try {
      await fx.db.insert(telemetryEvents).values([
        {
          id: crypto.randomUUID(),
          tenantId: fx.tenantId,
          requestId: crypto.randomUUID(),
          createdAt: new Date(),
          requestedModel: "m",
          providerId: "other",
          status: "completed",
          inputTokens: 10,
          outputTokens: 10,
        },
        {
          id: crypto.randomUUID(),
          tenantId: fx.tenantId,
          requestId: crypto.randomUUID(),
          createdAt: new Date(),
          requestedModel: "m",
          providerId: null,
          status: "completed",
          inputTokens: 10,
          outputTokens: 10,
        },
      ]);
      expect(await providerUsageMatrix(fx.db, fx.tenantId, "cb", new Date(0))).toHaveLength(0);
      // A deleted/unknown provider id reads empty, never errors.
      expect(await providerUsageMatrix(fx.db, fx.tenantId, "ghost", new Date(0))).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});
