/**
 * Persistence for the Qoder native machine identity (UMID) bound to an
 * account.
 *
 * Same-account probes found that daily 100-credit grant visibility does not
 * depend on machine headers. This store preserves native identities and seeds
 * for deterministic replay and other surfaces that may use device identity.
 * A native identity is a deterministic function of a seed file
 * (`~/.config/.locale_cfg`). The bound record lives in
 * `provider_accounts.native_identity` (plain JSON, not a secret).
 *
 * Uniqueness of the device is enforced by the partial unique index on the
 * extracted `machineToken`; this store keeps the JS side of that internal
 * identity-allocation invariant and surfaces the DB constraint as the backstop.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { providerAccounts, type NativeIdentityRecord } from "../../../persistence/schema";
import {
  mintQoderNativeIdentity,
  replayQoderNativeIdentity,
  type QoderNativeIdentity,
} from "./qoder-umid";

/** Stateful read/write boundary for bound native identities. */
export interface QoderNativeIdentityStore {
  /**
   * The identity bound to one account, or `undefined` when the account has
   * no identity yet.
   */
  get(providerId: string, accountId: string): Promise<NativeIdentityRecord | undefined>;
  /**
   * Machine tokens already bound to **other** accounts, so a caller can mint
   * a fresh identity without colliding. A bound token represents a device identity, and
   * the unique index that backs this spans all `provider_accounts` rows. The
   * account's own bound token is not "occupied" — reusing one's own device is
   * the point.
   */
  occupied(accountId: string): Promise<ReadonlySet<string>>;
  /** Binds an identity to an account (upsert). Throws on a device collision. */
  bind(providerId: string, accountId: string, record: NativeIdentityRecord): Promise<void>;
}

export class DrizzleQoderNativeIdentityStore implements QoderNativeIdentityStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async get(providerId: string, accountId: string): Promise<NativeIdentityRecord | undefined> {
    const rows = await this.db
      .select({ nativeIdentity: providerAccounts.nativeIdentity })
      .from(providerAccounts)
      .where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.providerId, providerId)))
      .limit(1);
    const row = rows[0];
    return row?.nativeIdentity ?? undefined;
  }

  async occupied(accountId: string): Promise<ReadonlySet<string>> {
    const rows = await this.db
      .select({ nativeIdentity: providerAccounts.nativeIdentity })
      .from(providerAccounts)
      .where(
        accountId
          ? and(isNotNull(providerAccounts.nativeIdentity), ne(providerAccounts.id, accountId))
          : isNotNull(providerAccounts.nativeIdentity),
      );
    const occupied = new Set<string>();
    for (const row of rows) {
      const token = row.nativeIdentity?.machineToken;
      if (token !== undefined && token !== "") occupied.add(token);
    }
    return occupied;
  }

  async bind(providerId: string, accountId: string, record: NativeIdentityRecord): Promise<void> {
    await this.db
      .update(providerAccounts)
      .set({ nativeIdentity: record })
      .where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.providerId, providerId)));
  }
}

/**
 * Serializes identity minting across accounts in this process, so two
 * concurrent allocations cannot interleave seed swaps.
 */
let allocationQueue: Promise<unknown> = Promise.resolve();
function withAllocationLock<T>(work: () => Promise<T>): Promise<T> {
  const next = allocationQueue.then(work, work);
  allocationQueue = next.catch(() => undefined);
  return next;
}

/** Identity minting injected for tests; defaults to the real bridge. */
export type NativeIdentityMinter = (accountId: string) => { identity: QoderNativeIdentity; seed: string } | null;
export type NativeIdentityReplayer = (seed: string, accountId: string) => QoderNativeIdentity | null;

const defaultMinter: NativeIdentityMinter = (accountId) => mintQoderNativeIdentity(accountId);
const defaultReplayer: NativeIdentityReplayer = (seed, accountId) => replayQoderNativeIdentity(seed, accountId);

/**
 * Mints and binds a fresh device identity for an account: runs the bridge
 * with a cleared seed, captures the new seed, and persists both. Returns the
 * bound record, or `null` when the bridge fails.
 *
 * `avoidToken` optionally excludes the account's own current token so a
 * regenerate moves to a *different* device.
 */
export function allocateQoderNativeIdentity(
  store: QoderNativeIdentityStore,
  providerId: string,
  accountId: string,
  options: {
    readonly avoidToken?: string;
    readonly mint?: NativeIdentityMinter;
    readonly replayer?: NativeIdentityReplayer;
  } = {},
): Promise<NativeIdentityRecord | null> {
  const mint = options.mint ?? defaultMinter;
  return withAllocationLock(async () => {
    const occupied = await store.occupied(accountId);
    for (let i = 0; i < 6; i += 1) {
      const minted = mint(accountId);
      if (!minted) return null;
      const token = minted.identity.machineToken;
      if (occupied.has(token)) continue; // collision (rare) → mint again
      if (token === options.avoidToken) continue;
      const record: NativeIdentityRecord = {
        machineToken: token,
        machineType: minted.identity.machineType,
        machineCode: minted.identity.machineCode,
        ...(minted.seed ? { seed: minted.seed } : {}),
        source: minted.identity.source,
      };
      await store.bind(providerId, accountId, record);
      return record;
    }
    return null;
  });
}

/**
 * Ensures the bound identity is currently active on this host: replays the
 * stored seed so the bridge yields the same token. Returns `false` when the
 * account has no bound identity or replay failed.
 */
export async function ensureQoderNativeIdentity(
  store: QoderNativeIdentityStore,
  providerId: string,
  accountId: string,
  replayer: NativeIdentityReplayer = defaultReplayer,
): Promise<boolean> {
  const record = await store.get(providerId, accountId);
  if (!record) return false;
  if (!record.seed) return true; // no seed captured → assume already active
  const identity = replayer(record.seed, accountId);
  return identity !== null && identity.machineToken === record.machineToken;
}
