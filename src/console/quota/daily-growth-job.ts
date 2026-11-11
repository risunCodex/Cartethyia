/**
 * Background execution for the manual daily-growth batch (`POST /quota/daily-growth`).
 *
 * The route used to run the whole batch synchronously — chunked 3-parallel,
 * up to two upstream HTTP calls per account, no global timeout — so a large
 * roster held the console request open and blocked the event loop. This module
 * moves the orchestration to an in-process background job: the route enqueues
 * and returns `{ jobId }` immediately, and a status route reads the job's
 * progress.
 *
 * The per-account runner (report then claim, egress rotation, per-leg timeout)
 * is injected by the route — the job owns only the orchestration: the
 * bounded-concurrency worker loop, the single-result aggregation, and the
 * deduplication guards. This keeps the module free of the route's imports and
 * avoids a cycle between the two quota modules.
 *
 * One job per (tenant, provider) key is allowed at a time. The key is the
 * double-claim guard between two manual triggers: enqueuing again while a job
 * for the same tenant+provider is still queued/running returns the existing
 * job id instead of stamping the same accounts twice. In parallel with the
 * daily sweep, the ledger is the guard — the runner stamps
 * `markCheckinAttempted` after a successful claim, and this runner skips
 * accounts the sweep (or an earlier run) already settled today, so the same
 * account is never claimed twice in one window.
 *
 * The registry is intentionally process-local: the manual trigger is an
 * operator action on a single gateway, so a cross-process queue would buy
 * nothing here.
 */
import { randomUUID } from "node:crypto";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RedisClient } from "../../persistence/redis";
import { checkinAttemptedToday } from "../../workers/daily-checkin";
import type { ValidatedFetch } from "../../network/egress/fetch";

/** Lifecycle states of a daily-growth job. */
export type DailyGrowthJobState = "queued" | "running" | "done" | "failed";

/** One account the job failed to settle, with the reason. */
export interface DailyGrowthJobError {
  readonly accountId: string;
  readonly error: string;
}

/** Aggregate outcome of one job. */
export interface DailyGrowthJobResult {
  /** Accounts the job actually attempted (excludes skipped/already-settled). */
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: readonly DailyGrowthJobError[];
}

/** Public view of a job, as the status route returns it. */
export interface DailyGrowthJobView {
  readonly jobId: string;
  readonly state: DailyGrowthJobState;
  readonly providerId: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: readonly DailyGrowthJobError[];
}

/** One account the job will run the daily-growth pass over. */
export interface DailyGrowthJobAccount {
  readonly id: string;
  readonly tenantId: string | null;
  readonly label: string;
}

/** Outcome the route's per-account runner reports. */
export interface DailyGrowthAccountOutcome {
  readonly ok: boolean;
  /** Present when `ok` is false: the reason the account was not settled. */
  readonly error?: string;
}

/** Everything the background runner needs to execute one job. */
export interface DailyGrowthJobDeps {
  readonly db: CartethyiaDatabase;
  readonly redis: RedisClient | undefined;
  /** Runs one account's daily-growth pass (report then claim). */
  readonly runAccount: (account: DailyGrowthJobAccount) => Promise<DailyGrowthAccountOutcome>;
  /** Invalidated once when the job finishes, so the page re-reads the ledger. */
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
}

/** Bound on accounts processed at once. Mirrors the old synchronous chunk size. */
const DAILY_GROWTH_CONCURRENCY = 3;
/**
 * Per-account leg budget. Each individual upstream call already carries its own
 * 15s abort timeout; this bounds the whole leg (credential resolve + report +
 * check-in) so a single stuck account cannot hold a job worker open forever.
 */
export const DAILY_GROWTH_LEG_TIMEOUT_MS = 60_000;

/**
 * Wraps a fetcher so every request also carries `budget`, even when the callee
 * sets its own per-request timeout. The buddy/qoder billing helpers pass an
 * `AbortSignal.timeout(...)` of their own, which would override a plain
 * `signalFetch`-style injection; combining signals intersects both bounds.
 */
export function withLegBudget(
  fetcher: ValidatedFetch | typeof fetch,
  budget: AbortSignal,
): typeof fetch {
  const wrapped = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> =>
    fetcher(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([budget, init.signal]) : budget,
    });
  return Object.assign(wrapped, {
    preconnect: (fetcher as typeof fetch).preconnect,
  });
}

/** Registry cap; oldest finished jobs are evicted so the map cannot grow unbounded. */
const DAILY_GROWTH_JOB_MAX = 64;

interface DailyGrowthJobRecord {
  readonly id: string;
  readonly key: string;
  readonly tenantId: string;
  readonly providerId: string;
  readonly createdAt: number;
  state: DailyGrowthJobState;
  finishedAt: number | null;
  readonly accounts: readonly DailyGrowthJobAccount[];
  result: DailyGrowthJobResult;
}

const jobs = new Map<string, DailyGrowthJobRecord>();
/** tenant+provider key → job id; the double-trigger guard. */
const jobsByKey = new Map<string, string>();
/**
 * Accounts currently being worked by any job. Global accounts (`tenant_id IS
 * NULL`) are visible to every tenant, so two tenants can enqueue jobs over the
 * same global account; this set keeps them from stamping it twice in the same
 * window. Tenant-owned accounts cannot collide this way (they are unique to
 * their tenant), but the set is uniform and cheap.
 */
const inFlightAccounts = new Set<string>();

function jobView(job: DailyGrowthJobRecord): DailyGrowthJobView {
  return {
    jobId: job.id,
    state: job.state,
    providerId: job.providerId,
    createdAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
    total: job.result.total,
    succeeded: job.result.succeeded,
    failed: job.result.failed,
    errors: job.result.errors,
  };
}

/** Evicts the oldest finished jobs once the registry exceeds its cap. */
function evictFinishedJobs(): void {
  if (jobs.size <= DAILY_GROWTH_JOB_MAX) return;
  const finished: DailyGrowthJobRecord[] = [];
  for (const job of jobs.values()) {
    if (job.state === "done" || job.state === "failed") finished.push(job);
  }
  finished.sort((left, right) => left.createdAt - right.createdAt);
  let excess = jobs.size - DAILY_GROWTH_JOB_MAX;
  for (const job of finished) {
    if (excess <= 0) break;
    jobs.delete(job.id);
    if (jobsByKey.get(job.key) === job.id) jobsByKey.delete(job.key);
    excess -= 1;
  }
}

/**
 * Runs one job to completion. Never rejects: every failure is collected into
 * the job's result, so the status route always has an answer.
 */
async function runJob(record: DailyGrowthJobRecord, deps: DailyGrowthJobDeps): Promise<void> {
  record.state = "running";
  const succeeded: string[] = [];
  const errors: DailyGrowthJobError[] = [];
  const attempted: string[] = [];
  let cursor = 0;
  const accounts = record.accounts;

  const runOne = async (account: DailyGrowthJobAccount): Promise<void> => {
    // Double-claim guard with the daily sweep (and any other job): the ledger
    // is shared, so an account the sweep already settled today is skipped
    // rather than claimed again — the same `markCheckinAttempted` semantics
    // the button uses.
    if (inFlightAccounts.has(account.id)) return;
    try {
      if (await checkinAttemptedToday({ db: deps.db, redis: deps.redis, accountId: account.id })) {
        return;
      }
    } catch {
      // An unreadable ledger reads as "not attempted" — the safe direction for
      // a manual trigger, which asserts "try now".
    }
    inFlightAccounts.add(account.id);
    attempted.push(account.id);
    try {
      const outcome = await deps.runAccount(account);
      if (outcome.ok) {
        succeeded.push(account.id);
      } else {
        errors.push({ accountId: account.id, error: outcome.error ?? "Daily growth failed" });
      }
    } finally {
      inFlightAccounts.delete(account.id);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DAILY_GROWTH_CONCURRENCY, accounts.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= accounts.length) return;
        await runOne(accounts[index]!);
      }
    }),
  );

  record.result = {
    total: attempted.length,
    succeeded: succeeded.length,
    failed: errors.length,
    errors,
  };
  record.finishedAt = Date.now();
  record.state = "done";
  if (deps.snapshotInvalidator) {
    try {
      await deps.snapshotInvalidator.invalidate();
    } catch {
      // Best-effort: a failed snapshot invalidate must not fail the job.
    }
  }
}

/**
 * Enqueues a daily-growth job and returns its id immediately. When a job for
 * the same (tenant, provider) is already queued or running, the existing job
 * id is returned instead — the operator pressed the button twice, and running
 * the same accounts twice would double-claim.
 */
export function enqueueDailyGrowthJob(args: {
  readonly deps: DailyGrowthJobDeps;
  readonly tenantId: string;
  readonly providerId: string;
  readonly accounts: readonly DailyGrowthJobAccount[];
}): string {
  const key = `${args.tenantId}:${args.providerId}`;
  const existing = jobsByKey.get(key);
  if (existing !== undefined) {
    const job = jobs.get(existing);
    if (job !== undefined && (job.state === "queued" || job.state === "running")) {
      return job.id;
    }
    jobsByKey.delete(key);
  }

  const id = randomUUID();
  const record: DailyGrowthJobRecord = {
    id,
    key,
    tenantId: args.tenantId,
    providerId: args.providerId,
    createdAt: Date.now(),
    state: "queued",
    finishedAt: null,
    accounts: args.accounts,
    result: { total: 0, succeeded: 0, failed: 0, errors: [] },
  };
  jobs.set(id, record);
  jobsByKey.set(key, id);
  evictFinishedJobs();
  void runJob(record, args.deps).catch(() => {
    record.state = "failed";
    record.finishedAt = Date.now();
  });
  return id;
}

/**
 * Reads one job's status. Scoped to the requesting tenant: a job enqueued by
 * another tenant is not visible, so one tenant cannot probe another's work.
 */
export function getDailyGrowthJob(jobId: string, tenantId: string): DailyGrowthJobView | null {
  const job = jobs.get(jobId);
  if (job === undefined || job.tenantId !== tenantId) return null;
  return jobView(job);
}

/** Test seam: clears the registry so suites do not leak state across runs. */
export function clearDailyGrowthJobsForTests(): void {
  jobs.clear();
  jobsByKey.clear();
  inFlightAccounts.clear();
}
