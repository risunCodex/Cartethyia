/**
 * Reconciles the raw telemetry mirror back into the SQL table.
 *
 * The durable record is `telemetry_events`, written transactionally on the
 * request path. The raw JSONL mirror is at-least-once: a drain that retried
 * after a crash can have appended a line whose SQL row never landed (or landed
 * and was rolled back). This job is how an operator recovers that gap, and how
 * a deployment that ran before `telemetry_events` was written gets its history
 * back.
 *
 * Design constraints, in the order they bind:
 *
 * - **Idempotent.** The unique index on `(tenant_id, request_id)` is the
 *   boundary: `ON CONFLICT DO NOTHING` plus `RETURNING` means a re-run
 *   inserts nothing and charges nothing. The checkpoint can therefore be
 *   advanced optimistically and still be safe.
 * - **Resumable.** Progress is a `(file_name, byte_offset)` checkpoint written
 *   in the SAME transaction as the rows it covers, so a crash replays at most
 *   one chunk and never loses a completed one.
 * - **Leased.** Several processes share one database; a lease row
 *   (`telemetry_reconciliation_state`) means one runner at a time. The lease
 *   expires, so a crashed runner does not wedge the job forever.
 * - **Bounded.** Chunked reads, a chunk cap, and a transaction cap. A 512 MiB
 *   backlog drains over successive runs instead of one unbounded sweep.
 * - **Never touches `telemetry_usage_totals`.** Those counters were charged at
 *   request time. Backfilling rows must not double-charge them, so this path
 *   inserts events only.
 */
import { and, eq, sql } from "drizzle-orm";
import { readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

import type { CartethyiaDatabase } from "../persistence/db-handle";
import { telemetryEvents, telemetryReconciliationState } from "../persistence/schema";
import { TELEMETRY_EVENT_DIR } from "./event-log";
import { clientNameFromUserAgent } from "./client-name";
import type { TelemetryEventRecord } from "./event-log";
import { hourStamp } from "../shared/time";

/** The single job name: one reconciliation stream, one checkpoint. */
const JOB_NAME = "raw_to_sql_v1";

/** How long a runner holds the job. Generous, so a slow run is not stolen. */
const LEASE_MS = 30 * 60_000;

/** One read of a file. Bounds peak memory to one chunk, not one file. */
const CHUNK_BYTES = 256 * 1024;

/**
 * Rows per transaction. Enough to amortise commit cost, small enough that a
 * single transaction is never a long lock or a huge WAL burst.
 */
const ROWS_PER_TRANSACTION = 500;

/** Chunks per run. A backlog drains over successive runs, not one sweep. */
const MAX_CHUNKS_PER_RUN = 512;

/** Files per run, so a fresh backlog is not capped by one huge file. */
const MAX_FILES_PER_RUN = 64;

/**
 * The current and previous UTC hour are skipped: the current one is still
 * being appended to, and the previous one can still receive a batch that was
 * flushed after the boundary. Those rows arrive through the request path
 * itself — reconciling them would race the writer for no gain.
 */
const HOURS_TO_SKIP = 2;

interface ReconcileOptions {
  /** Report only: count the gap without writing anything. */
  readonly verify?: boolean;
  readonly now?: Date;
}

interface ReconcileReport {
  readonly ran: boolean;
  /** Why the run did nothing, when it did nothing. */
  readonly skippedReason?: "lease_held" | "no_files" | "uptodate";
  readonly leaseOwner: string;
  readonly filesCompleted: number;
  readonly eventsExamined: number;
  readonly eventsInserted: number;
  readonly conflicts: number;
  readonly bytesRead: number;
}

/**
 * The checkpoint: which file, and how far into it.
 *
 * `fileName` is compared as a string and files are processed in name order,
 * so an hour that rolls over does not resurrect an older file: once the
 * checkpoint passes a name, files sorting before it never come back.
 */
interface Checkpoint {
  readonly fileName: string;
  readonly byteOffset: number;
}

function nowMs(options: ReconcileOptions): number {
  return (options.now ?? new Date()).getTime();
}

/** Files eligible for reconciliation: JSONL logs, newest-completed-first is irrelevant here. */
async function candidateFiles(): Promise<readonly string[]> {
  const all = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  // The current and previous hour are still being written; see HOURS_TO_SKIP.
  const floor = hourStamp(new Date(Date.now() - HOURS_TO_SKIP * 3_600_000));
  return all
    .filter((file) => file.endsWith(".jsonl") && !file.endsWith(".compacted.jsonl"))
    .filter((file) => file.slice(0, 13) < floor)
    .sort();
}

/**
 * Parses the complete lines in one chunk.
 *
 * `carry` holds the trailing partial line: the chunk boundary falls mid-line
 * whenever the writer's last append was split. It is prepended to the next
 * chunk rather than parsed, because a half line is not a JSON document.
 */
function parseChunk(text: string): { readonly events: TelemetryEventRecord[]; readonly carry: string } {
  const lines = text.split("\n");
  // The last element is either "" (the chunk ended on a newline, so every line
  // is complete) or a partial line (keep it for the next chunk).
  const carry = lines.pop() ?? "";
  const events: TelemetryEventRecord[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A torn line from a crash mid-append. Skipped rather than fatal: the
      // rest of the file is still recoverable, and one bad line must not
      // strand a whole backlog.
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const event = value as Partial<TelemetryEventRecord>;
    if (typeof event.tenantId !== "string" || typeof event.requestId !== "string") continue;
    events.push(value as TelemetryEventRecord);
  }
  return { events, carry };
}

/** The columns the backfill inserts. Mirrors `telemetryEventRow` on the write path. */
function toRow(event: TelemetryEventRecord): typeof telemetryEvents.$inferInsert {
  return {
    // `id = requestId` is what makes the unique index a working idempotency
    // boundary: a retry of the same request carries the same id.
    id: event.requestId,
    tenantId: event.tenantId!,
    requestId: event.requestId,
    sourceSurface: event.sourceSurface as typeof telemetryEvents.$inferInsert.sourceSurface,
    requestedModel: event.requestedModel,
    reportedModel: event.reportedModel,
    requestedEffort: event.requestedEffort,
    providerId: event.providerId,
    accountId: event.accountId,
    networkPoolId: event.networkPoolId,
    endpoint: event.endpoint,
    apiKeyId: event.apiKeyId,
    userAgent: event.userAgent,
    // Derived the same way ingestion derives it, so a backfilled row groups
    // with the rows the request path wrote instead of forming its own bucket.
    clientName: clientNameFromUserAgent(event.userAgent),
    clientIp: event.clientIp,
    latencyMs: event.latencyMs,
    ttfbMs: event.ttfbMs,
    stream: event.stream,
    httpStatus: event.httpStatus,
    status: event.status as typeof telemetryEvents.$inferInsert.status,
    errorCategory: event.errorCategory,
    errorOrigin: event.errorOrigin,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    estimatedCostUsd:
      event.estimatedCostUsd === null ? null : String(event.estimatedCostUsd),
    createdAt: new Date(event.createdAt),
  };
}

/**
 * Acquires (or steals an expired) lease.
 *
 * `insert ... on conflict` in one statement: the row is created on first run
 * and refreshed afterwards without a read-modify-write that two runners could
 * interleave. `lease_expires_at` is the only arbiter, so a runner that died
 * mid-file is replaced once its lease lapses rather than blocking forever.
 */
async function acquireLease(db: CartethyiaDatabase, owner: string, now: Date): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const result = await db
    .insert(telemetryReconciliationState)
    .values({
      jobName: JOB_NAME,
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      fileName: "",
      byteOffset: 0,
      filesCompleted: 0,
      eventsExamined: 0,
      eventsInserted: 0,
      conflicts: 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: telemetryReconciliationState.jobName,
      set: { leaseOwner: owner, leaseExpiresAt: expiresAt, updatedAt: now },
      // Take the lease only when nobody holds a live one: an expired lease or
      // no lease at all means the previous runner is gone.
      where: sql`(${telemetryReconciliationState.leaseExpiresAt} is null or ${telemetryReconciliationState.leaseExpiresAt} < ${now} or ${telemetryReconciliationState.leaseOwner} = ${owner})`,
    })
    .returning({ owner: telemetryReconciliationState.leaseOwner });
  return result.length > 0;
}

async function releaseLease(db: CartethyiaDatabase, owner: string, now: Date): Promise<void> {
  await db
    .update(telemetryReconciliationState)
    .set({ leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(telemetryReconciliationState.jobName, JOB_NAME),
        eq(telemetryReconciliationState.leaseOwner, owner),
      ),
    );
}

async function readCheckpoint(db: CartethyiaDatabase): Promise<Checkpoint> {
  const [row] = await db
    .select({
      fileName: telemetryReconciliationState.fileName,
      byteOffset: telemetryReconciliationState.byteOffset,
    })
    .from(telemetryReconciliationState)
    .where(eq(telemetryReconciliationState.jobName, JOB_NAME))
    .limit(1);
  return { fileName: row?.fileName ?? "", byteOffset: row?.byteOffset ?? 0 };
}

/**
 * One run of the reconciliation job.
 *
 * Returns a report rather than throwing on "nothing to do": a scheduled or
 * CLI invocation has to distinguish "no gap" from "could not run", and a
 * thrown error would read as a failure of the whole command.
 */
export async function reconcileTelemetry(
  db: CartethyiaDatabase,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const owner = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date(nowMs(options));
  const verify = options.verify === true;

  const files = await candidateFiles();
  if (files.length === 0) {
    return {
      ran: false,
      skippedReason: "no_files",
      leaseOwner: owner,
      filesCompleted: 0,
      eventsExamined: 0,
      eventsInserted: 0,
      conflicts: 0,
      bytesRead: 0,
    };
  }

  // `--verify` takes no lease: it only reads the mirror and counts, so two
  // concurrent verifications cannot conflict and neither can block a real run.
  if (!verify && !(await acquireLease(db, owner, now))) {
    return {
      ran: false,
      skippedReason: "lease_held",
      leaseOwner: owner,
      filesCompleted: 0,
      eventsExamined: 0,
      eventsInserted: 0,
      conflicts: 0,
      bytesRead: 0,
    };
  }

  const checkpoint = verify ? { fileName: "", byteOffset: 0 } : await readCheckpoint(db);
  const pending = files.filter((file) => file > checkpoint.fileName);
  if (pending.length === 0) {
    if (!verify) await releaseLease(db, owner, new Date());
    return {
      ran: false,
      skippedReason: "uptodate",
      leaseOwner: owner,
      filesCompleted: 0,
      eventsExamined: 0,
      eventsInserted: 0,
      conflicts: 0,
      bytesRead: 0,
    };
  }

  let eventsExamined = 0;
  let eventsInserted = 0;
  let conflicts = 0;
  let filesCompleted = 0;
  let bytesRead = 0;
  let chunks = 0;

  try {
    for (const file of pending.slice(0, MAX_FILES_PER_RUN)) {
      const path = join(TELEMETRY_EVENT_DIR, file);
      const size = (await stat(path).catch(() => undefined))?.size ?? 0;
      const handle = await open(path, "r").catch(() => undefined);
      if (handle === undefined) {
        // Deleted between the listing and the open — retention pruned it.
        continue;
      }
      let offset = file === checkpoint.fileName ? checkpoint.byteOffset : 0;
      let carry = "";
      try {
        while (offset < size && chunks < MAX_CHUNKS_PER_RUN) {
          const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
          const { bytesRead: read } = await handle.read(buffer, 0, buffer.length, offset);
          if (read <= 0) break;
          chunks += 1;
          bytesRead += read;
          offset += read;
          const parsed = parseChunk(carry + buffer.toString("utf8", 0, read));
          carry = parsed.carry;
          eventsExamined += parsed.events.length;
          if (parsed.events.length > 0 && !verify) {
            for (let start = 0; start < parsed.events.length; start += ROWS_PER_TRANSACTION) {
              const slice = parsed.events.slice(start, start + ROWS_PER_TRANSACTION);
              const inserted = await insertChunk(db, slice, file, offset);
              eventsInserted += inserted.inserted;
              conflicts += inserted.conflicts;
            }
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      // Only complete files are marked done: a run that hit its chunk cap
      // resumes inside this file, so the offset must stay.
      if (offset >= size) {
        filesCompleted += 1;
        if (!verify) await writeCheckpoint(db, file, 0, now);
      } else if (!verify) {
        await writeCheckpoint(db, file, offset, now);
      }
      if (chunks >= MAX_CHUNKS_PER_RUN) break;
    }
  } finally {
    if (!verify) await releaseLease(db, owner, new Date());
  }

  return {
    ran: true,
    leaseOwner: owner,
    filesCompleted,
    eventsExamined,
    eventsInserted,
    conflicts,
    bytesRead,
  };
}

/**
 * Inserts one batch and advances the checkpoint in the SAME transaction.
 *
 * `ON CONFLICT DO NOTHING` + `RETURNING` is the idempotency boundary: the
 * unique index on `(tenant_id, request_id)` decides, and only returned rows
 * count. Usage totals are deliberately not touched — those counters were
 * charged at request time, and re-charging from a backfill would inflate
 * every dashboard figure for the affected window.
 */
async function insertChunk(
  db: CartethyiaDatabase,
  events: readonly TelemetryEventRecord[],
  fileName: string,
  byteOffset: number,
): Promise<{ readonly inserted: number; readonly conflicts: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(telemetryEvents)
      .values(events.map(toRow))
      .onConflictDoNothing()
      .returning({ id: telemetryEvents.id });
    await tx
      .update(telemetryReconciliationState)
      .set({
        fileName,
        byteOffset,
        filesCompleted: sql`${telemetryReconciliationState.filesCompleted} + 1`,
        eventsExamined: sql`${telemetryReconciliationState.eventsExamined} + ${events.length}`,
        eventsInserted: sql`${telemetryReconciliationState.eventsInserted} + ${rows.length}`,
        conflicts: sql`${telemetryReconciliationState.conflicts} + ${events.length - rows.length}`,
        updatedAt: new Date(),
      })
      .where(eq(telemetryReconciliationState.jobName, JOB_NAME));
    return { inserted: rows.length, conflicts: events.length - rows.length };
  });
}

async function writeCheckpoint(
  db: CartethyiaDatabase,
  fileName: string,
  byteOffset: number,
  now: Date,
): Promise<void> {
  await db
    .update(telemetryReconciliationState)
    .set({ fileName, byteOffset, updatedAt: now })
    .where(eq(telemetryReconciliationState.jobName, JOB_NAME));
}
