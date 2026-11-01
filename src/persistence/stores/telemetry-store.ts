import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { inArray, sql } from "drizzle-orm";
import { affectedRows, currentTimestamp, laterOf } from "../dialect";
import type { CartethyiaDatabase } from "../db-handle";
import {
  apiKeys,
  telemetryEvents,
  telemetryPayloads,
  telemetryUsageTotals,
  type TelemetryUsageIdentityType,
} from "../schema";
import { isGatewayError } from "../../observability/telemetry-status";
import { TELEMETRY_EVENT_DIR } from "../../observability/event-log";
import { RawTelemetryEventWriter } from "../../observability/raw-event-writer";
import { hourStamp } from "../../shared/time";

interface UsageTotalDelta {
  readonly tenantId: string;
  readonly identityType: TelemetryUsageIdentityType;
  readonly entityId: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

function addUsageDelta(
  deltas: Map<string, UsageTotalDelta>,
  row: typeof telemetryEvents.$inferInsert,
  identityType: TelemetryUsageIdentityType,
  entityId: string | null | undefined,
): void {
  if (entityId == null) return;
  const key = `${row.tenantId}\0${identityType}\0${entityId}`;
  let delta = deltas.get(key);
  if (!delta) {
    delta = {
      tenantId: row.tenantId,
      identityType,
      entityId,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    deltas.set(key, delta);
  }
  delta.requests += 1;
  // Same definition as every read-side error count, including the HTTP-status
  // exclusions (404/499/503/504): this rollup is durable, so a request counted here
  // stays counted after its raw row is pruned and cannot be corrected later.
  if (isGatewayError(row.status, row.httpStatus)) delta.errors += 1;
  delta.inputTokens += row.inputTokens ?? 0;
  delta.outputTokens += row.outputTokens ?? 0;
}

export function aggregateUsage(rows: readonly (typeof telemetryEvents.$inferInsert)[]) {
  const deltas = new Map<string, UsageTotalDelta>();
  for (const row of rows) {
    addUsageDelta(deltas, row, "account", row.accountId);
    addUsageDelta(deltas, row, "api_key", row.apiKeyId);
  }
  return [...deltas.values()];
}

/**
 * Database boundary for durable telemetry writes and bounded retention cleanup.
 * The observability buffer owns queueing and retry policy; this store owns table
 * operations, lifetime aggregates, and retention.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes hourly event files whose whole hour is older than the retention
 * cutoff.
 *
 * The CURRENT and PREVIOUS hour are never touched. The current one is still
 * being appended; the previous one is why retention cannot be an hour
 * boundary: a batch flushed just after a boundary still carries events from
 * the hour that just ended, and the writer files them under that hour. Under
 * multi-process/multi-writer operation a file for the previous hour can also
 * still be open, so deleting it would either fail (Windows) or unlink a file
 * another writer has open (POSIX). Files are named `<hour>-<uuid>.jsonl` now,
 * so an hour is complete only once it is two hours old.
 */
async function pruneEventFiles(before: Date): Promise<void> {
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  // Two hours back: the current hour is open, the previous one can be too.
  const floor = new Date(Math.min(before.getTime(), Date.now() - 2 * 3_600_000));
  const cutoff = hourStamp(floor);
  for (const file of files) {
    if (!file.endsWith(".jsonl") || file.endsWith(".events.jsonl")) continue;
    const hour = file.slice(0, 13);
    if (hour < cutoff) await rm(join(TELEMETRY_EVENT_DIR, file), { force: true });
  }
  // Read-only legacy day logs are pruned only after their whole UTC day has
  // aged out; index files are never consulted for usage anymore.
  const cutoffDay = before.toISOString().slice(0, 10);
  for (const file of files) {
    if (!file.endsWith(".events.jsonl") || file.slice(0, 10) >= cutoffDay) continue;
    await rm(join(TELEMETRY_EVENT_DIR, file), { force: true });
  }
}

/**
 * Appends one JSON line per event. One file per hour, so retention is a file
 * delete and no request is replaced by a compacted summary.
 */
export class DrizzleTelemetryStore {
  private readonly eventWriter: RawTelemetryEventWriter;

  constructor(
    private readonly db: CartethyiaDatabase,
    eventWriter = new RawTelemetryEventWriter(TELEMETRY_EVENT_DIR),
  ) {
    this.eventWriter = eventWriter;
  }

  /**
   * Resolves the share-template key for each distinct api key in a batch.
   *
   * The template is the key itself when it is a top-level template, or its
   * parent when it is a minted child. The column is denormalized onto the
   * event so family rollups do not depend on the key row surviving.
   */
  private async resolveFamilyTemplateIds(
    rows: readonly (typeof telemetryEvents.$inferInsert)[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.apiKeyId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    if (ids.length === 0) return new Map();
    const resolved = await this.db
      .select({ id: apiKeys.id, parentKeyId: apiKeys.parentKeyId })
      .from(apiKeys)
      .where(inArray(apiKeys.id, ids));
    return new Map(resolved.map((row) => [row.id, row.parentKeyId ?? row.id]));
  }

  /**
   * Applies usage deltas inside an enclosing transaction.
   *
   * Takes the transaction handle, not this.db: `insertEvents` runs the event
   * insert and the aggregate upsert in ONE transaction, so usage is charged
   * from the rows actually inserted — never from rows that `ON CONFLICT DO
   * NOTHING` skipped. The deltas are computed by the caller from the
   * inserted-rows result for exactly that reason.
   */
  private async applyUsageDeltas(
    tx: Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0],
    deltas: readonly UsageTotalDelta[],
  ): Promise<void> {
    if (deltas.length === 0) return;
    // Deterministic order so two processes racing the same identities lock
    // rows in the same order and cannot deadlock.
    const ordered = [...deltas].sort((left, right) =>
      left.tenantId.localeCompare(right.tenantId)
      || left.identityType.localeCompare(right.identityType)
      || left.entityId.localeCompare(right.entityId));
    // Resolve the share-template key for each api_key identity in the batch so
    // the durable totals row carries it — family reads then survive the key
    // row being deleted.
    const apiKeyIds = [
      ...new Set(
        ordered
          .filter((delta) => delta.identityType === "api_key")
          .map((delta) => delta.entityId),
      ),
    ];
    const familyTemplates = new Map<string, string>();
    if (apiKeyIds.length > 0) {
      const keyRows = await tx
        .select({ id: apiKeys.id, parentKeyId: apiKeys.parentKeyId })
        .from(apiKeys)
        .where(inArray(apiKeys.id, apiKeyIds));
      for (const row of keyRows) {
        familyTemplates.set(row.id, row.parentKeyId ?? row.id);
      }
    }
    const now = new Date();
    await tx
      .insert(telemetryUsageTotals)
      .values(ordered.map((delta) => ({
        ...delta,
        ...(delta.identityType === "api_key" && familyTemplates.has(delta.entityId)
          ? { familyTemplateKeyId: familyTemplates.get(delta.entityId) }
          : {}),
        requests: delta.requests,
        errors: delta.errors,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        lastUsedAt: now,
      })))
      .onConflictDoUpdate({
        target: [
          telemetryUsageTotals.tenantId,
          telemetryUsageTotals.identityType,
          telemetryUsageTotals.entityId,
        ],
        set: {
          requests: sql`${telemetryUsageTotals.requests} + excluded.requests`,
          errors: sql`${telemetryUsageTotals.errors} + excluded.errors`,
          inputTokens: sql`${telemetryUsageTotals.inputTokens} + excluded.input_tokens`,
          outputTokens: sql`${telemetryUsageTotals.outputTokens} + excluded.output_tokens`,
          lastUsedAt: laterOf(sql`${telemetryUsageTotals.lastUsedAt}`, sql`excluded.last_used_at`, this.db),
          updatedAt: currentTimestamp(),
        },
      });
  }

  /** Writes raw events and maintains their durable identity aggregates. */
  async insertEvents(rows: Array<typeof telemetryEvents.$inferInsert>): Promise<void> {
    if (rows.length === 0) return;
    // The file accepts anything, so a malformed row would be written and then
    // retried forever without ever failing. Rejecting it here keeps the buffer's
    // drop-and-count contract: one bad row fails the batch, once.
    const familyTemplates = await this.resolveFamilyTemplateIds(rows);
    for (const row of rows) {
      if (typeof row.apiKeyId === "string" && row.apiKeyId.length > 0) {
        const template = familyTemplates.get(row.apiKeyId);
        if (template !== undefined) row.familyTemplateKeyId = template;
      }
    }
    const unique: Array<typeof telemetryEvents.$inferInsert> = [];
    const ids = new Set<string>();
    for (const row of rows) {
      if (!UUID_RE.test(row.tenantId)) {
        throw new Error("telemetry event rejected: tenantId is not a uuid");
      }
      // In-batch dedupe on the stable id: keep the first occurrence. A batch
      // containing the same request twice (a buffer bug or a replayed
      // enqueue) writes one row and charges once, instead of relying on the
      // DB to skip the second insert silently.
      if (row.id !== undefined) {
        if (ids.has(row.id)) continue;
        ids.add(row.id);
      }
      unique.push(row);
    }
    // The raw append happens FIRST: the file is the at-least-once mirror. A
    // crash after the append but before the SQL commit is recovered by
    // `carte telemetry reconcile` (the backfill skips rows the unique index
    // already holds). A raw append failure rejects the whole store call so
    // the buffer retries the batch; nothing is committed, nothing charged.
    await this.eventWriter.append(unique);
    // One transaction: insert (skip conflicts), then charge usage from the
    // rows actually inserted. A retried drain or a cross-process race
    // converges to one row and one charge; no compensation transactions.
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(telemetryEvents)
        .values(unique)
        .onConflictDoNothing({
          target: [telemetryEvents.tenantId, telemetryEvents.requestId],
        })
        .returning({
          tenantId: telemetryEvents.tenantId,
          requestId: telemetryEvents.requestId,
          accountId: telemetryEvents.accountId,
          apiKeyId: telemetryEvents.apiKeyId,
          status: telemetryEvents.status,
          httpStatus: telemetryEvents.httpStatus,
          inputTokens: telemetryEvents.inputTokens,
          outputTokens: telemetryEvents.outputTokens,
        });
      // Usage is charged only from what actually landed. `returning` on
      // `ON CONFLICT DO NOTHING` yields exactly the inserted rows on both
      // backends; skipped conflicts contribute nothing.
      const deltas = aggregateUsage(inserted);
      await this.applyUsageDeltas(tx, deltas);
    });
  }

  /** Inserts one redacted payload and returns its generated identity. */
  async insertPayload(
    row: typeof telemetryPayloads.$inferInsert,
  ): Promise<{ id: string; expiresAt: Date }> {
    const [inserted] = await this.db
      .insert(telemetryPayloads)
      .values(row)
      .returning({ id: telemetryPayloads.id, expiresAt: telemetryPayloads.expiresAt });
    if (!inserted) throw new Error("payload capture insert returned no row");
    return inserted;
  }

  /**
   * Deletes at most one bounded batch of expired payloads in a single
   * statement, so concurrent sweeps atomically claim disjoint rows and the
   * returned count matches the rows actually deleted.
   */
  async deleteExpiredPayloads(batchSize = 5000, before = new Date()): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${telemetryPayloads}
      WHERE ${telemetryPayloads.id} IN (
        SELECT ${telemetryPayloads.id} FROM ${telemetryPayloads}
        WHERE ${telemetryPayloads.expiresAt} < ${before}
        ORDER BY ${telemetryPayloads.expiresAt}
        LIMIT ${batchSize}
      )
    `);
    return affectedRows(result);
  }

  /**
   * Deletes at most one bounded batch of aged events in a single statement, so
   * concurrent sweeps atomically claim disjoint rows and the returned count
   * matches the rows actually deleted. Ordered by `created_at`, which
   * `idx_telemetry_created_at` backs.
   */
  async deleteExpiredEvents(batchSize = 5000, before: Date): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${telemetryEvents}
      WHERE ${telemetryEvents.id} IN (
        SELECT ${telemetryEvents.id} FROM ${telemetryEvents}
        WHERE ${telemetryEvents.createdAt} < ${before}
        ORDER BY ${telemetryEvents.createdAt}
        LIMIT ${batchSize}
      )
    `);
    return affectedRows(result);
  }

  /**
   * Deletes telemetry older than the supplied cutoff. Payloads follow their
   * `expires_at` contract (15 minutes per row) rather than capture time.
   *
   * Events are pruned in bounded batches rather than one `DELETE`, because
   * `telemetry_events` is the highest-volume table and a single statement
   * covering every aged row grows without limit: it holds locks and WAL for the
   * whole sweep, and on a deployment that has run for months it can exceed the
   * pool's `statement_timeout` and be cancelled, so the sweep never converges
   * and retention silently stops working. Each batch commits independently, so
   * progress survives a cancel or a restart. The loop is bounded so one pass
   * cannot run unbounded — a backlog drains over successive sweeps — mirroring
   * the payload sweeper's `cleanupExpired`.
   */
  async pruneTelemetry(before: Date): Promise<void> {
    await this.eventWriter.idle();
    await pruneEventFiles(before);
    const MAX_BATCHES_PER_SWEEP = 40;
    for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
      const deleted = await this.deleteExpiredEvents(5000, before);
      if (deleted < 5000) break;
    }
    await this.deleteExpiredPayloads(5000, before);
  }
}
