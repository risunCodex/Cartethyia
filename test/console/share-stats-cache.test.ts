/**
 * The share-stats Redis tier: one family, one computation per tick.
 *
 * The share page re-reads its rollup every 2 s per viewer, and the rollup parses
 * the whole retained telemetry window. Without a shared cache, N viewers of one
 * link cost N parses every 2 s. These lock the three properties that matter:
 * a second tick inside the TTL reuses the first computation, the numbers are
 * identical with and without the cache, and a Redis that fails never fails the
 * page.
 *
 * No database or Redis server is required: the port reads telemetry files, and
 * the cache is a Map-backed fake with the same `{ get, set }` shape as
 * `read-through-cache.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

// Sandbox: resolve the data directory into a throwaway tmpdir *before* any
// module that calls `resolveDataDir()` at import time (event-log exports
// TELEMETRY_EVENT_DIR as a module-level constant derived from it).
const sandbox = await mkdtemp(join(tmpdir(), "carte-share-stats-cache-"));
const previousDataDir = process.env.CARTETHYIA_DATA_DIR;
process.env.CARTETHYIA_DATA_DIR = sandbox;

const { createShareStatsPort, SHARE_STATS_CACHE_TTL_SECONDS } = await import("../../src/console/share/share-stats");
const { telemetryEvents, tenants, apiKeys, telemetryUsageTotals } = await import("../../src/persistence/schema");
const { sql } = await import("drizzle-orm");
const { createSqliteDatabase, applySqliteMigrations, buildSqliteHandle } = await import("../../src/persistence/db-sqlite");

// The port reads telemetry_events (the SQL record), so this needs a migrated
// database rather than a raw file fixture.
const dbPath = join(sandbox, "share-stats-cache.sqlite");
const sqliteDb = createSqliteDatabase(dbPath);
await applySqliteMigrations(sqliteDb);
const db = buildSqliteHandle(sqliteDb).db;

/** Creates the tenant a set of events is written under (FK parent). */
async function createTenant(id: string): Promise<void> {
  await db
    .insert(tenants)
    .values({ id, name: `share-${id}`, slug: `share-${id}`, status: "active" } as never);
}

/**
 * Creates the `api_keys` row behind a telemetry key id: the family rollup
 * scopes by the template key through `api_keys`, so a fixture key must exist
 * for its telemetry to be counted.
 */
async function createKey(tenantId: string, keyId: string): Promise<void> {
  await db
    .insert(apiKeys)
    .values({ id: keyId, tenantId, keyMode: "personal", keyHash: `hash-${keyId}`, label: keyId.slice(0, 8), scopes: ["routing:invoke"] } as never)
    .onConflictDoNothing();
}

interface Recorded {
  readonly reads: string[];
  readonly writes: Array<{ key: string; value: string; ttl: number }>;
}

function fakeClient(
  stored: Map<string, string>,
  options: { failGet?: boolean; failSet?: boolean } = {},
): { client: { get(key: string): Promise<string | null>; set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown> }; recorded: Recorded } {
  const reads: string[] = [];
  const writes: Array<{ key: string; value: string; ttl: number }> = [];
  return {
    recorded: { reads, writes },
    client: {
      async get(key) {
        reads.push(key);
        if (options.failGet === true) throw new Error("redis down");
        return stored.get(key) ?? null;
      },
      async set(key, value, _mode, ttlSeconds) {
        writes.push({ key, value, ttl: ttlSeconds });
        if (options.failSet === true) throw new Error("redis down");
        stored.set(key, value);
      },
    },
  };
}

/** Appends one telemetry event for a share family to the fixture file. */
async function writeEvent(
  tenantId: string,
  apiKeyId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const requestId = crypto.randomUUID();
  await createTenant(tenantId).catch(() => undefined);
  await createKey(tenantId, apiKeyId);
  await db.insert(telemetryEvents).values({
    id: requestId,
    requestId,
    tenantId,
    apiKeyId,
    sourceSurface: "chat",
    requestedModel: "claude-sonnet-4-6",
    stream: true,
    status: "completed",
    createdAt: new Date(),
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  } as never);
  // Mirror production's durable rollup (`insertEvents` charges
  // `telemetry_usage_totals` from inserted rows); the share KPI reads that
  // rollup for lifetime numbers.
  const status = String(overrides.status ?? "completed");
  const httpStatus = overrides.httpStatus as number | undefined;
  await db
    .insert(telemetryUsageTotals)
    .values({
      tenantId,
      identityType: "api_key",
      entityId: apiKeyId,
      familyTemplateKeyId: apiKeyId,
      requests: 1,
      errors:
        (status === "failed" || status === "truncated") &&
        (httpStatus === undefined || (httpStatus >= 500 && ![503, 504, 529].includes(httpStatus)))
          ? 1
          : 0,
      inputTokens: Number(overrides.inputTokens ?? 100),
      outputTokens: Number(overrides.outputTokens ?? 50),
      lastUsedAt: new Date(),
    } as never)
    .onConflictDoUpdate({
      target: [telemetryUsageTotals.tenantId, telemetryUsageTotals.identityType, telemetryUsageTotals.entityId],
      set: {
        requests: sql`${telemetryUsageTotals.requests} + excluded.requests`,
        errors: sql`${telemetryUsageTotals.errors} + excluded.errors`,
        inputTokens: sql`${telemetryUsageTotals.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${telemetryUsageTotals.outputTokens} + excluded.output_tokens`,
      },
    });
}

const RECIPIENTS = { total: 2, active: 1 } as const;

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

/**
 * The body keys alone. The cache writes a `:etag` sibling next to every body,
 * so counting raw keys would count each entry twice and stop measuring what
 * these tests are about — how many entries were read or written.
 */
function bodyKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !key.endsWith(":etag"));
}

describe("createShareStatsPort — the Redis tier", () => {
  test("a second tick inside the TTL reuses the first computation", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const port = createShareStatsPort({ db, redis: client as never });

    const first = await port.getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, RECIPIENTS);

    // A third event arrives after the first read. A recompute would include it;
    // a cache hit returns the value computed before it existed.
    await writeEvent(tenantId, keyId, { inputTokens: 999_999, outputTokens: 0 });

    const second = await port.getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, RECIPIENTS);

    expect(second).toEqual(first);
    expect(first.totals.requests).toBe(1);
    expect(first.recipients).toEqual(RECIPIENTS);
    // One miss wrote one entry; the second call read it back rather than
    // computing again (compute is only reachable on a miss). Each body write
    // is paired with its validator, so the body keys are counted alone.
    expect(bodyKeys(recorded.reads)).toHaveLength(2);
    expect(bodyKeys(recorded.writes.map((write) => write.key))).toHaveLength(1);
    // Pinned to the constant rather than a literal, so raising the TTL does
    // not read as a regression here — it is the thing the test is checking
    // shape against.
    expect(recorded.writes[0]?.ttl).toBe(SHARE_STATS_CACHE_TTL_SECONDS);
  });

  test("recipients are reattached per call, not frozen into the cached value", async () => {
    // `recipients` is Postgres-derived, not telemetry, so it is excluded from the
    // cached payload: a recipient-count change must not invalidate the expensive
    // part, and the caller's own value must come back untouched.
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const port = createShareStatsPort({ db, redis: client as never });

    const first = await port.getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, { total: 1, active: 1 });
    const second = await port.getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, { total: 9, active: 4 });

    expect(first.recipients).toEqual({ total: 1, active: 1 });
    expect(second.recipients).toEqual({ total: 9, active: 4 });
    // Still one computation: only the recipient count changed.
    expect(bodyKeys(recorded.writes.map((write) => write.key))).toHaveLength(1);
    // The cached payload carries no `recipients` key at all.
    expect(recorded.writes[0]?.value).not.toContain("recipients");
  });

  test("numbers are identical with and without a cache", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId, { inputTokens: 120, outputTokens: 30 });
    await writeEvent(tenantId, keyId, { inputTokens: 5, outputTokens: 7, status: "failed", httpStatus: 502 });

    const cached = await createShareStatsPort({
      db,
      redis: fakeClient(new Map()).client as never,
    }).getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, RECIPIENTS);
    const direct = await createShareStatsPort({ db }).getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, RECIPIENTS);

    expect(cached).toEqual(direct);
    expect(direct.totals.requests).toBe(2);
    expect(direct.totals.errors).toBe(1);
  });

  test("a failed read falls through to computing", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const { client } = fakeClient(new Map(), { failGet: true });
    const port = createShareStatsPort({ db, redis: client as never });

    const stats = await port.getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, RECIPIENTS);
    expect(stats.totals.requests).toBe(1);
  });

  test("a failed write still returns the computed answer", async () => {
    const tenantId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    await writeEvent(tenantId, keyId);
    const { client } = fakeClient(new Map(), { failSet: true });
    const port = createShareStatsPort({ db, redis: client as never });

    const stats = await port.getFamilyStats(tenantId, { templateKeyId: keyId, memberCount: 1 }, RECIPIENTS);
    expect(stats.totals.requests).toBe(1);
  });

  test("an empty family short-circuits before any cache call", async () => {
    // A freshly created link with no issued keys has no traffic to read, so it
    // must not touch Redis at all.
    const { client, recorded } = fakeClient(new Map());
    const port = createShareStatsPort({ db, redis: client as never });
    const stats = await port.getFamilyStats(crypto.randomUUID(), { templateKeyId: "", memberCount: 0 }, RECIPIENTS);
    expect(stats.totals.requests).toBe(0);
    expect(recorded.reads).toHaveLength(0);
    expect(recorded.writes).toHaveLength(0);
  });

  test("the key separates families and model filters", async () => {
    // Both inputs change the payload, so both are in the key: two different key
    // sets and two different model filters must not share one entry.
    const tenantId = crypto.randomUUID();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await writeEvent(tenantId, a);
    const stored = new Map<string, string>();
    const { client, recorded } = fakeClient(stored);
    const port = createShareStatsPort({ db, redis: client as never });

    await port.getFamilyStats(tenantId, { templateKeyId: a, memberCount: 1 }, RECIPIENTS);
    await port.getFamilyStats(tenantId, { templateKeyId: b, memberCount: 1 }, RECIPIENTS);
    await port.getFamilyStats(tenantId, { templateKeyId: a, memberCount: 1 }, RECIPIENTS, ["claude-sonnet-4-6"]);
    // A member minted between reads must not fold into the smaller family's
    // entry: the covered-key count is part of the key.
    await port.getFamilyStats(tenantId, { templateKeyId: a, memberCount: 2 }, RECIPIENTS);
    await port.getFamilyStats(tenantId, { templateKeyId: b, memberCount: 2 }, RECIPIENTS);

    const keys = new Set(bodyKeys(recorded.reads));
    expect(keys.size).toBe(5);
    for (const key of keys) expect(key.startsWith(`share:v1:stats:${tenantId}:`)).toBe(true);
  });
});
