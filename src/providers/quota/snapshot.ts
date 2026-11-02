/**
 * Persisted quota snapshots.
 *
 * The in-process quota cache is a short TTL and empty on a cold start, so
 * right after a restart the console would render no balance for every account
 * until the sweep re-reads them — while Buddy's usage snapshots survived via a
 * table. This is the generic counterpart: every provider's last successful
 * quota read is persisted on the account row, and the console falls back to it
 * when the cache is cold. A failed fetch leaves the previous snapshot in place,
 * mirroring `quota_plan`.
 */
import { eq, inArray } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { providerAccounts, type ProviderQuotaResultSnapshot } from "../../persistence/schema";
import type { ProviderQuotaResult } from "./quota-contracts";

/**
 * Parses the `quota_snapshot` column. Postgres' jsonb arrives as an object;
 * SQLite's text-backed column arrives as a JSON string — accept both.
 */
function parseSnapshot(value: unknown): ProviderQuotaResultSnapshot | null {
  if (value === null || value === undefined) return null;
  let root: unknown = value;
  if (typeof value === "string") {
    try {
      root = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const rec = root as Record<string, unknown>;
  const { quota, fetchedAt } = rec;
  if (typeof quota !== "object" || quota === null || typeof fetchedAt !== "string") return null;
  return { quota: quota as ProviderQuotaResult, fetchedAt };
}

/** Stores one successful quota read on the account row. Never throws. */
export async function persistQuotaSnapshot(
  db: CartethyiaDatabase,
  accountId: string,
  quota: ProviderQuotaResult,
  fetchedAt: Date = new Date(),
): Promise<void> {
  try {
    await db
      .update(providerAccounts)
      .set({ quotaSnapshot: { quota, fetchedAt: fetchedAt.toISOString() } })
      .where(eq(providerAccounts.id, accountId));
  } catch {
    // A snapshot that cannot be stored is a stale display, not an error the
    // caller must handle.
  }
}

/** Reads one account's last successful quota snapshot, if any. */
export async function readQuotaSnapshot(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<ProviderQuotaResultSnapshot | null> {
  try {
    const rows = await db
      .select({ quotaSnapshot: providerAccounts.quotaSnapshot })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    return parseSnapshot(rows[0]?.quotaSnapshot);
  } catch {
    return null;
  }
}

/** Batch read for one page render: one query for every account. */
export async function readQuotaSnapshots(
  db: CartethyiaDatabase,
  accountIds: readonly string[],
): Promise<Map<string, ProviderQuotaResultSnapshot>> {
  const found = new Map<string, ProviderQuotaResultSnapshot>();
  if (accountIds.length === 0) return found;
  try {
    const rows = await db
      .select({ id: providerAccounts.id, quotaSnapshot: providerAccounts.quotaSnapshot })
      .from(providerAccounts)
      .where(inArray(providerAccounts.id, [...accountIds]));
    for (const row of rows) {
      const snapshot = parseSnapshot(row.quotaSnapshot);
      if (snapshot) found.set(row.id, snapshot);
    }
  } catch {
    // A read failure yields a partial map; callers already treat a missing
    // entry as "no snapshot".
  }
  return found;
}
