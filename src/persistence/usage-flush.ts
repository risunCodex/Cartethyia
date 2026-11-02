import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "./db-handle";
import { sqliteDialect } from "./dialect";
import { apiKeys } from "./schema";

/** Spelling a uuid column must match before it is inlined into a statement. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coalesces per-request lifetime-usage writes into one UPDATE per flush.
 *
 * The admission counter is the live source of truth and already lives in memory
 * (or Redis). Persisting the same delta on the request path meant one UPDATE
 * per completed request, and on the embedded backend every write queues behind
 * a single writer — so request throughput was bound by usage accounting, not by
 * the work the request did. Callers enqueue and return; a timer flushes the
 * accumulated deltas, and shutdown flushes what remains.
 *
 * A crash loses at most the deltas not yet flushed. The admission counter is
 * re-seeded from the persisted total on its next miss, so the loss is bounded
 * by the flush interval and never compounds.
 */

async function writeLifetimeDelta(db: CartethyiaDatabase, apiKeyId: string, delta: number): Promise<void> {
  await db
    .update(apiKeys)
    .set({
      lifetimeTokensConsumed: sql`COALESCE(${apiKeys.lifetimeTokensConsumed}, 0) + ${delta}`,
    })
    .where(eq(apiKeys.id, apiKeyId));
}

/**
 * One statement for the whole batch, instead of one UPDATE per key.
 *
 * On the embedded backend one write queues behind a single writer, so the cost
 * of a flush is dominated by round-trips rather than by rows: measured on
 * the embedded backend, 300 keys cost 129 ms as separate UPDATEs and 4 ms as one
 * `UPDATE ... FROM (VALUES ...)` — 28x. That difference is the whole reason
 * this path coalesces deltas at all, so a flush that fans back out per key
 * gives the win straight back.
 *
 * `id::uuid` is spelled out because the driver would otherwise infer the
 * VALUES column as text and fail the join against a uuid key.
 */
async function writeLifetimeDeltas(
  db: CartethyiaDatabase,
  deltas: ReadonlyMap<string, number>,
): Promise<void> {
  if (deltas.size === 0) return;
  // Inlined rather than bound: Drizzle turns each interpolated value into a
  // bind parameter, so 300 keys became a 600-parameter VALUES list — slow, and
  // rejected outright at that arity. The values are therefore built with
  // `sql.raw` and validated on the way in, which is what keeps this a literal
  // rather than an injection path: a uuid must match the uuid spelling and a
  // delta must be a finite non-negative integer.
  const rows = [...deltas].map(([apiKeyId, delta]) => {
    if (!UUID_RE.test(apiKeyId)) throw new Error(`usage flush: apiKeyId is not a uuid`);
    if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta < 0) {
      throw new Error(`usage flush: delta is not a non-negative integer (got ${String(delta)})`);
    }
    return { apiKeyId, delta };
  });
  // PostgreSQL needs the casts: the driver infers an uncast VALUES column as
  // text and the join against a uuid key fails. SQLite stores the key as text
  // and rejects `UPDATE ... FROM (VALUES ...)` outright, so the same rows are
  // a SELECT with named columns instead.
  const sqlite = sqliteDialect();
  const source = sqlite
    ? `(${rows.map((row) => `SELECT '${row.apiKeyId}' AS id, ${row.delta} AS delta`).join(" UNION ALL ")})`
    : `(VALUES ${rows.map((row) => `('${row.apiKeyId}'::uuid, ${row.delta}::bigint)`).join(", ")}) AS v(id, delta)`;
  // PostgreSQL already carries its alias in `source`; only the bare SQLite
  // subquery needs the trailing alias appended. Emitting both (`AS v(id, delta) v`)
  // is a syntax error on Postgres, so the flush silently never ran.
  const from = sqlite ? `${source} v` : source;
  await db.execute(sql.raw(`
    UPDATE "api_keys"
    SET "lifetime_tokens_consumed" =
      COALESCE("api_keys"."lifetime_tokens_consumed", 0) + v.delta
    FROM ${from}
    WHERE "api_keys"."id" = v.id
  `));
}
/** Max keys per flush statement; larger windows are chunked. */
const FLUSH_STATEMENT_MAX_KEYS = 500;
/** Max distinct keys retained across windows; oldest dropped first. */
const FLUSH_PENDING_MAX_KEYS = 5000;

/**
 * Consecutive fully-failed flushes before the writer backs off.
 *
 * A database that is down stays down: retrying every `intervalMs` means a
 * write attempt per second against a backend that is already overloaded, which
 * is load the operator cannot distinguish from real traffic and which delays
 * recovery. After this many failures the buffer stops probing and waits out a
 * cooldown instead.
 */
const FLUSH_FAILURE_STREAK_LIMIT = 3;
/** How long a failing writer waits before probing again. */
const FLUSH_BACKOFF_MS = 15_000;
export class UsageFlushBuffer {
  private readonly pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private stopped = false;
  /** Consecutive flushes that failed outright; drives the backoff below. */
  private failureStreak = 0;
  /** Wall-clock time before which no flush is attempted. */
  private backoffUntil = 0;
  /** Deltas abandoned because the buffer could not persist them. */
  private droppedDelta = 0;

  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly intervalMs = 1_000,
    private readonly write: (db: CartethyiaDatabase, apiKeyId: string, delta: number) => Promise<void> = writeLifetimeDelta,
  ) {
    this.arm();
  }

  /** Records a delta. Never touches the database; safe to call per request. */
  enqueue(apiKeyId: string, delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.pending.set(apiKeyId, (this.pending.get(apiKeyId) ?? 0) + delta);
    if (this.pending.size > FLUSH_PENDING_MAX_KEYS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
  }

  /**
   * Deltas recorded but not yet persisted, for one key.
   *
   * Exposed so a reader of `lifetime_tokens_consumed` can add what is in
   * flight to what Postgres last stored. Without it such a reader saw a value
   * that was behind by up to one flush interval, and — because the flush is
   * coalescing by design — behind by the largest amount exactly when the key
   * was busiest.
   */
  pendingFor(apiKeyId: string): number {
    return this.pending.get(apiKeyId) ?? 0;
  }

  /**
   * Writes everything accumulated so far, in bounded statements of at most
   * 500 keys each. One giant statement grows the SQL string with the
   * distinct-key count per window; chunking keeps each statement bounded.
   *
   * A chunk that fails falls back to one write per key so one bad key cannot
   * cost the others their delta. A key whose write fails goes back into the
   * pending map, added to anything enqueued while the flush ran, so a
   * transient failure retries instead of dropping.
   *
   * `force` bypasses the outage backoff. The scheduled timer never passes it —
   * a failing database should not be probed on every tick — but `stop({flush:
   * true})` must, or a shutdown during a backoff window would return without
   * even attempting to persist the pending deltas.
   */
  async flush(options?: { force?: boolean }): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    // Backing off during a sustained outage: without this the writer probed a
    // failing database on every tick, adding write load to the very overload
    // that caused the failure.
    if (Date.now() < this.backoffUntil && options?.force !== true) return;
    this.flushing = true;
    const batch = new Map(this.pending);
    this.pending.clear();
    let failed = 0;
    try {
      const entries = [...batch];
      for (let offset = 0; offset < entries.length; offset += FLUSH_STATEMENT_MAX_KEYS) {
        const chunk = new Map(entries.slice(offset, offset + FLUSH_STATEMENT_MAX_KEYS));
        try {
          await writeLifetimeDeltas(this.db, chunk);
          continue;
        } catch {
          // Fall through to the per-key path: one statement failing tells us
          // nothing about which key caused it.
        }
        for (const [apiKeyId, delta] of chunk) {
          try {
            await this.write(this.db, apiKeyId, delta);
          } catch {
            // A transient failure retries, but only while the buffer is not
            // itself saturated: an outage that outlasts the cap must drop
            // accounting rather than grow the pending map without bound.
            if (this.pending.size < FLUSH_PENDING_MAX_KEYS) {
              this.pending.set(apiKeyId, (this.pending.get(apiKeyId) ?? 0) + delta);
            } else {
              this.droppedDelta += delta;
            }
            failed += 1;
          }
        }
      }
    } finally {
      if (failed > 0) {
        this.failureStreak += 1;
        if (this.failureStreak >= FLUSH_FAILURE_STREAK_LIMIT) {
          this.backoffUntil = Date.now() + FLUSH_BACKOFF_MS;
          this.failureStreak = 0;
        }
      } else {
        this.failureStreak = 0;
        this.backoffUntil = 0;
      }
      this.flushing = false;
    }
  }

  /** Total usage delta abandoned after sustained write failure. */
  get droppedTotal(): number {
    return this.droppedDelta;
  }

  /** Stops the timer. Pass `{ flush: true }` to persist what is still pending. */
  async stop(options?: { flush?: boolean }): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (options?.flush) await this.flush({ force: true });
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().finally(() => this.arm());
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}
