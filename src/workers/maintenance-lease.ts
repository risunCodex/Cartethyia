/**
 * A Redis lease so one maintenance task runs once across the fleet.
 *
 * Maintenance work is side-effecting and shared: telemetry retention deletes
 * rows for every tenant, the payload sweeper deletes files, the session sweep
 * deletes sessions. Two processes running "telemetry-retention" at once do not
 * produce two correct halves — they produce two passes over the same batches,
 * double the row churn, and a WAL spike on a box that is already short of
 * memory. On a 1-core VPS the second pass is not parallel speedup; it is
 * contention with the request path.
 *
 * The lease is a Redis key with a token. The token matters: release must be
 * conditional (`compare-and-delete`), or a process that overran its lease and
 * was replaced would delete its SUCCESSOR's lease and let a third process in.
 * An unconditional `DEL` is the classic version of that bug.
 */
import { randomUUID } from "node:crypto";

import { redisEvalNumber } from "../persistence/redis";
import type { RedisClient } from "../persistence/redis";

/** Key prefix; the task name is the discriminator. */
const LEASE_KEY_PREFIX = "cartethyia:maintenance:lease:v1:";

/**
 * Bounds on the lease TTL.
 *
 * The floor prevents a fast task from holding a lease so briefly that a peer
 * with a slightly skewed clock steals it mid-run. The ceiling keeps a crashed
 * holder from blocking the task for longer than a maintenance interval is
 * likely to be.
 */
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 60_000;

/**
 * Acquires the lease: `SET key token PX ttl NX`.
 *
 * One atomic statement rather than GET-then-SET: two processes can both read
 * "absent" before either writes, and both would then believe they held it.
 */
const ACQUIRE_SCRIPT = `
local ok = redis.call('set', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]), 'NX')
if ok then return 1 end
return 0
`;

/**
 * Renews only if the token still matches: `GET` + compare + `PEXPIRE`.
 *
 * Extending a lease this process no longer holds — because it overran its TTL
 * and a peer took over — would make two holders of one lease.
 */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('pexpire', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

/**
 * Releases only if the token still matches.
 *
 * An unconditional DEL would delete a successor's lease, letting a third
 * process acquire while the second is still running.
 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('del', KEYS[1])
  return 1
end
return 0
`;

export interface MaintenanceLease {
  readonly taskName: string;
  /** True when this process holds the lease. */
  readonly held: boolean;
  /** Extends the lease. Returns false when it has already been lost. */
  renew(): Promise<boolean>;
  /** Releases the lease. Safe (and a no-op) when it was never held or already lost. */
  release(): Promise<void>;
}

export interface MaintenanceLeaseStore {
  /**
   * One acquisition attempt.
   *
   * Deliberately not a retry loop: a tick that cannot acquire should SKIP, not
   * wait. Waiting would hold the tick open, and the next tick would arrive and
   * queue behind it — turning a missed interval into a catch-up storm.
   */
  tryAcquire(taskName: string, ttlMs: number): Promise<MaintenanceLease>;
}

/** The TTL for a task, clamped into the supported range. */
export function leaseTtlMs(intervalMs: number): number {
  return Math.min(MAX_LEASE_TTL_MS, Math.max(MIN_LEASE_TTL_MS, Math.trunc(intervalMs)));
}

/**
 * A Redis-backed lease store.
 *
 * Every failure is non-throwing at the caller's level: a Redis that is down
 * must not stop a task that only that process can do, and must not crash a
 * maintenance tick. Acquisition failure is reported as "not held" so the
 * registry skips and counts.
 */
export function createRedisMaintenanceLeaseStore(redis: RedisClient): MaintenanceLeaseStore {
  const evalScript = async (
    script: string,
    key: string,
    args: readonly (string | number)[],
  ): Promise<number> => redisEvalNumber(redis, script, 1, key, ...args);

  return {
    async tryAcquire(taskName, ttlMs) {
      const key = `${LEASE_KEY_PREFIX}${taskName}`;
      const token = randomUUID();
      const ttl = leaseTtlMs(ttlMs);
      let held = false;
      try {
        held = (await evalScript(ACQUIRE_SCRIPT, key, [token, ttl])) === 1;
      } catch {
        // Redis unreachable: skip. Reported, not swallowed silently — the
        // registry counts the skip so a persistent outage is visible.
        held = false;
      }
      if (!held) {
        return {
          taskName,
          held: false,
          async renew() {
            return false;
          },
          async release() {
            /* nothing held */
          },
        };
      }
      let released = false;
      return {
        taskName,
        held: true,
        async renew() {
          if (released) return false;
          try {
            return (await evalScript(RENEW_SCRIPT, key, [token, ttl])) === 1;
          } catch {
            return false;
          }
        },
        async release() {
          if (released) return;
          released = true;
          try {
            await evalScript(RELEASE_SCRIPT, key, [token]);
          } catch {
            // Best-effort: the TTL releases it anyway, and a failed release
            // must not turn a successful task run into an error.
          }
        },
      };
    },
  };
}
