/**
 * The raw→SQL reconciliation job and the retention rule around it.
 *
 * The properties that matter are the ones a recovery path gets wrong:
 *
 * 1. **Idempotent.** Re-running inserts nothing and charges nothing — the
 *    `(tenant_id, request_id)` unique index is the boundary, not application
 *    logic that could drift.
 * 2. **Never touches usage counters.** Backfilled rows must not inflate
 *    `telemetry_usage_totals`, which were charged at request time.
 * 3. **Leased.** Two runners cannot interleave; an expired lease is stolen.
 * 4. **Skips the hours still being written.** Retention and reconciliation
 *    both leave the current and previous UTC hour alone.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

// Sandbox before the first import that resolves TELEMETRY_EVENT_DIR as a
// module-level constant.
const sandbox = await mkdtemp(join(tmpdir(), "carte-reconcile-"));
const previousDataDir = process.env.CARTETHYIA_DATA_DIR;
process.env.CARTETHYIA_DATA_DIR = sandbox;
process.env.CARTETHYIA_DB_MODE = "lite";

const { telemetryEvents, telemetryReconciliationState, telemetryUsageTotals, tenants } = await import("../../src/persistence/schema");
const { createSqliteDatabase, applySqliteMigrations, buildSqliteHandle } = await import(
  "../../src/persistence/db-sqlite"
);
const { TELEMETRY_EVENT_DIR } = await import("../../src/observability/event-log");
const { reconcileTelemetry } = await import("../../src/observability/telemetry-reconciliation");
const { queryTelemetryEvents } = await import("../../src/observability/event-query");

const dbPath = join(sandbox, "reconcile.sqlite");
const sqliteDb = createSqliteDatabase(dbPath);
await applySqliteMigrations(sqliteDb);
const db = buildSqliteHandle(sqliteDb).db;

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CARTETHYIA_DATA_DIR;
  else process.env.CARTETHYIA_DATA_DIR = previousDataDir;
  sqliteDb.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(sandbox, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

/** The FK parent every telemetry row needs. */
async function createTenant(id: string): Promise<void> {
  await db
    .insert(tenants)
    .values({ id, name: `rec-${id}`, slug: `rec-${id}`, status: "active" } as never)
    .onConflictDoNothing();
}

/** One raw line, as the writer would have appended it. */
function line(tenantId: string, requestId: string, at: Date, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: requestId,
    requestId,
    tenantId,
    createdAt: at.toISOString(),
    sourceSurface: "chat",
    requestedModel: "claude-sonnet-4-6",
    stream: true,
    status: "completed",
    inputTokens: 100,
    outputTokens: 50,
    ...extra,
  });
}

/**
 * Writes a raw file for an hour old enough to be eligible (the current and
 * previous UTC hour are skipped by design).
 */
async function writeRawFile(name: string, lines: readonly string[]): Promise<void> {
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  await writeFile(join(TELEMETRY_EVENT_DIR, name), `${lines.join("\n")}\n`, "utf8");
}

/** An hour stamp far enough in the past to be eligible. */
function oldHour(offsetHours: number): string {
  return new Date(Date.now() - offsetHours * 3_600_000)
    .toISOString()
    .slice(0, 13)
    .replaceAll(":", "-");
}

async function countEvents(tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: telemetryEvents.id })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.tenantId, tenantId));
  return rows.length;
}

describe("telemetry reconcile", () => {
  // The checkpoint is global state (one row for the whole job), so each test
  // starts from "nothing reconciled": without this, a run that advanced the
  // checkpoint would make every later test see an empty pending list.
  beforeEach(async () => {
    await db.delete(telemetryReconciliationState);
    // Files are global state too: a file left by an earlier test would be
    // pending again once the checkpoint is cleared, and every count below
    // would include another test's rows.
    await rm(TELEMETRY_EVENT_DIR, { recursive: true, force: true }).catch(() => undefined);
  });

  test("a raw line with no SQL row is inserted", async () => {
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const file = `${oldHour(6)}-${crypto.randomUUID()}.jsonl`;
    await writeRawFile(file, [line(tenantId, crypto.randomUUID(), new Date(Date.now() - 6 * 3_600_000))]);

    const report = await reconcileTelemetry(db, { verify: false });
    expect(report.ran).toBe(true);
    expect(report.eventsInserted).toBe(1);
    expect(await countEvents(tenantId)).toBe(1);
  });

  test("a second run inserts nothing: the unique index is the boundary", async () => {
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const file = `${oldHour(7)}-${crypto.randomUUID()}.jsonl`;
    const requestId = crypto.randomUUID();
    await writeRawFile(file, [line(tenantId, requestId, new Date(Date.now() - 7 * 3_600_000))]);

    const first = await reconcileTelemetry(db, { verify: false });
    // Rewound to the start of the file, which is what a crash before the
    // checkpoint commit looks like. The first run's rows are still in the
    // table, so the second pass must find every one already present — that is
    // the property under test, not "the file was consumed".
    await db
      .update(telemetryReconciliationState)
      .set({ fileName: "", byteOffset: 0 })
      .where(eq(telemetryReconciliationState.jobName, "raw_to_sql_v1"));
    const second = await reconcileTelemetry(db, { verify: false });
    expect(first.eventsInserted).toBe(1);
    expect(second.eventsInserted).toBe(0);
    expect(second.conflicts).toBe(1);
    expect(await countEvents(tenantId)).toBe(1);
  });

  test("the backfill never charges usage counters", async () => {
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const file = `${oldHour(8)}-${crypto.randomUUID()}.jsonl`;
    await writeRawFile(file, [line(tenantId, crypto.randomUUID(), new Date(Date.now() - 8 * 3_600_000))]);

    await reconcileTelemetry(db, { verify: false });
    const totals = await db.select().from(telemetryUsageTotals);
    expect(totals).toHaveLength(0);
  });

  test("--verify counts the gap without writing", async () => {
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const file = `${oldHour(9)}-${crypto.randomUUID()}.jsonl`;
    await writeRawFile(file, [line(tenantId, crypto.randomUUID(), new Date(Date.now() - 9 * 3_600_000))]);

    const report = await reconcileTelemetry(db, { verify: true });
    expect(report.eventsExamined).toBe(1);
    expect(report.eventsInserted).toBe(0);
    expect(await countEvents(tenantId)).toBe(0);
  });

  test("a raw line carrying the newer telemetry columns backfills them", async () => {
    // The reconciliation mapper must fill exactly the columns the write path
    // persists — a backfilled row that drops tokensPerSec/creditUsed/
    // degenerateStop reads as if those events never happened, and the raw file
    // is pruned after retention so the gap is permanent.
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const file = `${oldHour(6)}-${crypto.randomUUID()}.jsonl`;
    await writeRawFile(file, [
      line(tenantId, crypto.randomUUID(), new Date(Date.now() - 6 * 3_600_000), {
        creditUsed: 1.01,
        resolveMs: 55,
        tokensPerSec: 42.5,
        firstContentDeltaAtMs: 1_800_000_000_000,
        lastEventAtMs: 1_800_000_004_000,
        payloadCaptureState: "captured",
        degenerateStop: true,
      }),
    ]);

    const report = await reconcileTelemetry(db, { verify: false });
    expect(report.eventsInserted).toBe(1);
    // Read back through the canonical reader, which normalizes the stored
    // numeric text to the same numbers the write-path suite asserts.
    const page = await queryTelemetryEvents(db, { tenantId, since: new Date(0) });
    expect(page.events).toHaveLength(1);
    const row = page.events[0];
    expect(row?.creditUsed).toBe(1.01);
    expect(row?.resolveMs).toBe(55);
    expect(row?.tokensPerSec).toBe(42.5);
    expect(row?.firstContentDeltaAtMs).toBe(1_800_000_000_000);
    expect(row?.lastEventAtMs).toBe(1_800_000_004_000);
    expect(row?.payloadCaptureState).toBe("captured");
    expect(row?.degenerateStop).toBe(true);
  });

  test("the current and previous UTC hour are never reconciled", async () => {
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const nowHour = new Date().toISOString().slice(0, 13).replaceAll(":", "-");
    const prevHour = new Date(Date.now() - 3_600_000).toISOString().slice(0, 13).replaceAll(":", "-");
    await writeRawFile(`${nowHour}-${crypto.randomUUID()}.jsonl`, [
      line(tenantId, crypto.randomUUID(), new Date()),
    ]);
    await writeRawFile(`${prevHour}-${crypto.randomUUID()}.jsonl`, [
      line(tenantId, crypto.randomUUID(), new Date(Date.now() - 3_600_000)),
    ]);

    await reconcileTelemetry(db, { verify: false });
    expect(await countEvents(tenantId)).toBe(0);
  });

  test("a torn line is skipped, not fatal", async () => {
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    const file = `${oldHour(10)}-${crypto.randomUUID()}.jsonl`;
    const good = line(tenantId, crypto.randomUUID(), new Date(Date.now() - 10 * 3_600_000));
    await writeRawFile(file, [`${good.slice(0, 40)}`, good]);

    const report = await reconcileTelemetry(db, { verify: false });
    expect(report.eventsInserted).toBe(1);
    expect(await countEvents(tenantId)).toBe(1);
  });

  test("a live lease blocks a second runner", async () => {
    // A pending file is required: with nothing to do the job reports
    // `no_files` before it ever looks at the lease, and the test would pass
    // for the wrong reason.
    const tenantId = crypto.randomUUID();
    await createTenant(tenantId);
    await writeRawFile(`${oldHour(11)}-${crypto.randomUUID()}.jsonl`, [
      line(tenantId, crypto.randomUUID(), new Date(Date.now() - 11 * 3_600_000)),
    ]);
    const far = new Date(Date.now() + 60 * 60_000);
    await db
      .insert(telemetryReconciliationState)
      .values({ jobName: "raw_to_sql_v1", leaseOwner: "other-runner", leaseExpiresAt: far })
      .onConflictDoUpdate({
        target: telemetryReconciliationState.jobName,
        set: { leaseOwner: "other-runner", leaseExpiresAt: far },
      });

    const report = await reconcileTelemetry(db, { verify: false });
    expect(report.ran).toBe(false);
    expect(report.skippedReason).toBe("lease_held");

    // An expired lease is stolen, not waited on.
    await db
      .update(telemetryReconciliationState)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(telemetryReconciliationState.jobName, "raw_to_sql_v1"));
    const after = await reconcileTelemetry(db, { verify: false });
    expect(after.skippedReason).not.toBe("lease_held");
  });
});
