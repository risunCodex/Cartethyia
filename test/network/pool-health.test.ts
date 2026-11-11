/**
 * Pool block/cooldown flagging.
 *
 * Both functions are fire-and-forget by design — dispatch must never wait on an
 * audit write — so a failure inside them is invisible unless a test looks. The
 * facts worth pinning are the ones that differ between the two paths: a 429
 * refills (cooldown, `rate_limit_transient`), an egress refusal does not
 * (block, `egress_blocked`). Merging those categories would make the console
 * draw a retired address as a temporary throttle, and the pool would re-enter
 * rotation only to be refused again.
 */
import { describe, expect, test } from "bun:test";
import { flagPoolBlocked, flagPoolCooldown } from "../../src/network/pool/health";
import { GatewayError } from "../../src/protocol/gateway-error";

/** One row the recorder is expected to insert into `health_events`. */
interface AuditRow {
  readonly entityKind: string;
  readonly networkPoolId: string;
  readonly toStatus: string;
  readonly reason: string;
  readonly errorCategory: string;
}

/** One call made on the pool selector. */
interface SelectorCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** The subset of the selector these two functions actually use. */
interface FlagSelector {
  flagProviderBlocked(poolId: string, providerId: string, reason: string): Promise<void>;
  flagProviderCooldown(
    poolId: string,
    providerId: string,
    retryAfterMs: number,
    reason: string,
  ): Promise<void>;
}

/** The subset of the database handle these two functions actually use. */
interface AuditSink {
  insert(table: unknown): { values(row: AuditRow): Promise<void> };
}

interface Harness {
  readonly selector: FlagSelector;
  readonly rows: AuditRow[];
  readonly calls: SelectorCall[];
  readonly db: AuditSink;
  /** Resolves once `count` audit rows have been written. */
  readonly settled: (count: number) => Promise<void>;
}

/**
 * Builds the two collaborators and a way to await them.
 *
 * The production functions `void` their promises, so there is no handle to
 * await. `settled` waits on the *condition* — a row landing — rather than a
 * guessed duration, which is both faster and immune to load-induced flake.
 */
function harness(): Harness {
  const rows: AuditRow[] = [];
  const calls: SelectorCall[] = [];
  let notify: (() => void) | undefined;
  const selector: FlagSelector = {
    flagProviderBlocked: async (poolId, providerId, reason) => {
      calls.push({ method: "flagProviderBlocked", args: [poolId, providerId, reason] });
    },
    flagProviderCooldown: async (poolId, providerId, retryAfterMs, reason) => {
      calls.push({ method: "flagProviderCooldown", args: [poolId, providerId, retryAfterMs, reason] });
    },
  };
  const db: AuditSink = {
    insert: () => ({
      values: async (row: AuditRow): Promise<void> => {
        rows.push(row);
        notify?.();
      },
    }),
  };
  const settled = (count: number): Promise<void> =>
    rows.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          notify = () => {
            if (rows.length >= count) resolve();
          };
        });
  return { selector, rows, calls, db, settled };
}

/**
 * Coalescing state is module-global and keyed by (pool, provider), so every
 * test needs its own pair. Reusing one would make the second call in the file
 * a no-op — silently, and only when the suite is run in this order.
 */
let sequence = 0;
function poolId(): string {
  sequence += 1;
  return `pool-${sequence}-${crypto.randomUUID()}`;
}

function rateLimited(retryAfterMs?: number): GatewayError {
  const error = new GatewayError("proxy_pool_cooldown", 429, "slow down");
  if (retryAfterMs !== undefined) {
    (error.details as Record<string, unknown>)["retryAfterMs"] = retryAfterMs;
  }
  return error;
}

function refused(providerCode?: string): GatewayError {
  const error = new GatewayError("proxy_pool_blocked", 403, "refused");
  if (providerCode !== undefined) {
    (error.details as Record<string, unknown>)["providerCode"] = providerCode;
  }
  return error;
}

describe("flagPoolCooldown", () => {
  test("flags the selector and writes a rate_limit_transient row", async () => {
    const h = harness();
    const pool = poolId();
    flagPoolCooldown(h.selector as never, h.db as never, pool, "openai", rateLimited());
    await h.settled(1);
    expect(h.calls[0]?.method).toBe("flagProviderCooldown");
    expect(h.rows[0]?.errorCategory).toBe("rate_limit_transient");
    expect(h.rows[0]?.entityKind).toBe("pool");
    expect(h.rows[0]?.networkPoolId).toBe(pool);
    expect(h.rows[0]?.toStatus).toBe("cooldown");
  });

  test("uses the upstream's retry-after when it named one", async () => {
    const h = harness();
    flagPoolCooldown(h.selector as never, h.db as never, poolId(), "openai", rateLimited(1_000));
    await h.settled(1);
    expect(h.calls[0]?.args[2]).toBe(1_000);
  });

  test("falls back to a default window when upstream named none", async () => {
    const h = harness();
    flagPoolCooldown(h.selector as never, h.db as never, poolId(), "openai", rateLimited());
    await h.settled(1);
    // `CARTETHYIA_POOL_PROVIDER_RATE_LIMIT_COOLDOWN_MS` (default 1h): a
    // request-counted allowance stays refused for hours, and the 15-minute
    // guess put the pool back into rotation to be refused again. An upstream
    // `retryAfterMs` always wins; the other test covers that branch.
    expect(h.calls[0]?.args[2]).toBe(60 * 60 * 1000);
  });

  test("coalesces repeated cooldowns for the same pair", async () => {
    const h = harness();
    const pool = poolId();
    flagPoolCooldown(h.selector as never, h.db as never, pool, "openai", rateLimited());
    await h.settled(1);
    flagPoolCooldown(h.selector as never, h.db as never, pool, "openai", rateLimited());
    // One row per cooldown episode, not one per throttled request. Asserted
    // without waiting: a second row would have to beat the first write, and
    // the first has already landed.
    expect(h.rows).toHaveLength(1);
  });

  test("a different provider on the same pool is a separate episode", async () => {
    const h = harness();
    const pool = poolId();
    flagPoolCooldown(h.selector as never, h.db as never, pool, "openai", rateLimited());
    await h.settled(1);
    flagPoolCooldown(h.selector as never, h.db as never, pool, "anthropic", rateLimited());
    await h.settled(2);
    expect(h.rows).toHaveLength(2);
  });
});

describe("flagPoolBlocked", () => {
  test("flags the selector and writes an egress_blocked row", async () => {
    const h = harness();
    flagPoolBlocked(h.selector as never, h.db as never, poolId(), "opencode", refused());
    await h.settled(1);
    expect(h.calls[0]?.method).toBe("flagProviderBlocked");
    expect(h.rows[0]?.errorCategory).toBe("egress_blocked");
  });

  test("appends the upstream's own code so the row is actionable", async () => {
    const h = harness();
    flagPoolBlocked(
      h.selector as never,
      h.db as never,
      poolId(),
      "opencode",
      refused("FREE_TIER_REFUSED"),
    );
    await h.settled(1);
    expect(h.rows[0]?.reason).toContain("FREE_TIER_REFUSED");
  });

  test("omits the code suffix when upstream named none", async () => {
    const h = harness();
    flagPoolBlocked(h.selector as never, h.db as never, poolId(), "opencode", refused());
    await h.settled(1);
    expect(h.rows[0]?.reason).not.toContain("()");
  });

  test("does not coalesce — a re-enabled pool refused again is a new row", async () => {
    const h = harness();
    const pool = poolId();
    flagPoolBlocked(h.selector as never, h.db as never, pool, "opencode", refused());
    await h.settled(1);
    flagPoolBlocked(h.selector as never, h.db as never, pool, "opencode", refused());
    await h.settled(2);
    expect(h.rows).toHaveLength(2);
  });
});
