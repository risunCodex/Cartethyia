/**
 * Disk cache + majority vote for Qoder native machine identities.
 *
 * Adopted from the donor reference implementation (`qoder_accounts.py`
 * §native_machine_identity):
 *
 *  - **Disk cache** (`machine_identity.json` per data dir): the runtime-info
 *    bridge outputs a machine-level identity derived from a seed file
 *    (`~/.config/.locale_cfg`). Re-running the bridge frequently returns the
 *    same identity, but container rebuilds/upgrades would discard the seed —
 *    a disk cache keeps the device identity stable across restarts. Cache
 *    wins: when a valid cache entry exists for the realm, the bridge is not
 *    re-run.
 *  - **Majority vote**: the bridge's VM classification jitters (1.5–10% of
 *    runs flip between branches). A single sample can permanently fix a user
 *    to the minority branch, so the first uncached acquisition samples the
 *    bridge 3 times and takes the majority (extending to 5 on disagreement).
 *  - **Expired-cache fallback**: when the bridge fails (missing glibc
 *    loader, removed component), fall back to the cached identity even if
 *    expired — a real identity is better than a generated one.
 *
 * The cache is per-realm (intl vs cn use different env codes and produce
 * different identities). It is machine-global, not per-account: the seed is
 * machine-scoped, and per-account isolation stays in the database
 * (`provider_accounts.native_identity`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../../../persistence/db-mode";
import { log } from "../../../observability/logger";

/** Cache record shape, one per realm. */
export interface MachineIdentityCacheEntry {
  readonly machineToken: string;
  readonly machineType: string;
  readonly machineCode: string;
  readonly isVm: boolean;
  readonly source: string;
  /** The env code the identity was minted under (`3` intl desktop, `0` cn). */
  readonly environment: string;
  /** Unix seconds when this entry was written. */
  readonly cachedAt: number;
}

/** Written cache document. */
interface MachineIdentityCacheDoc {
  readonly version: 1;
  readonly realm: Record<string, MachineIdentityCacheEntry | undefined>;
}

const CACHE_VERSION = 1 as const;
const NATIVE_IDENTITY_TTL_MS = 30 * 60 * 1000; // 1800s, matches the donor
const VOTE_EXTEND_ROUNDS = 2;

/** Path to the machine-identity cache file. */
export function machineIdentityCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir(env), "machine_identity.json");
}

function readCacheDoc(path: string): MachineIdentityCacheDoc {
  try {
    if (!existsSync(path)) return { version: CACHE_VERSION, realm: {} };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MachineIdentityCacheDoc>;
    if (raw.version !== CACHE_VERSION || typeof raw.realm !== "object" || raw.realm === null) {
      return { version: CACHE_VERSION, realm: {} };
    }
    return { version: CACHE_VERSION, realm: raw.realm as MachineIdentityCacheDoc["realm"] };
  } catch {
    return { version: CACHE_VERSION, realm: {} };
  }
}

function writeCacheDoc(path: string, doc: MachineIdentityCacheDoc): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
    // Atomic replace so a crash never leaves a half-written cache.
    renameSync(tmp, path);
  } catch (error) {
    log.warn("[qoder] machine identity cache write failed", error as Error);
  }
}

function entryExpired(entry: MachineIdentityCacheEntry, now: number): boolean {
  return now - entry.cachedAt >= NATIVE_IDENTITY_TTL_MS;
}

/** Reads the cached identity for a realm, or `null` when absent/expired. */
export function readMachineIdentityCache(realm: string, env: NodeJS.ProcessEnv = process.env): MachineIdentityCacheEntry | null {
  const doc = readCacheDoc(machineIdentityCachePath(env));
  const entry = doc.realm[realm];
  if (!entry) return null;
  const now = Date.now();
  if (entryExpired(entry, now)) return null;
  return entry;
}

/** Reads the cached identity for a realm, permitting an expired entry. */
export function readMachineIdentityCacheEvenExpired(realm: string, env: NodeJS.ProcessEnv = process.env): MachineIdentityCacheEntry | null {
  const doc = readCacheDoc(machineIdentityCachePath(env));
  const entry = doc.realm[realm];
  return entry ?? null;
}

/** Writes the identity for a realm into the disk cache. */
export function writeMachineIdentityCache(realm: string, entry: Omit<MachineIdentityCacheEntry, "cachedAt">, env: NodeJS.ProcessEnv = process.env): void {
  const path = machineIdentityCachePath(env);
  const doc = readCacheDoc(path);
  doc.realm[realm] = { ...entry, cachedAt: Date.now() };
  writeCacheDoc(path, doc);
}

/**
 * Samples a native identity from the bridge, taking a majority vote to
 * stabilize the VM-classification jitter. `sample` runs the bridge once
 * (with the account id); it is called 3 times and, on disagreement, extended
 * to 5. Returns the majority identity, or `null` when every sample failed.
 */
export function sampleIdentityWithVote(
  sample: (accountId: string) => {
    identity: { machineToken: string; machineType: string; machineCode: string; isVm: boolean; source: "runtime-info" | "generated" | "os" };
    seed: string;
  } | null,
  accountId: string,
): {
  identity: { machineToken: string; machineType: string; machineCode: string; isVm: boolean; source: "runtime-info" | "generated" | "os" };
  seed: string;
} | null {
  const take = (count: number): Array<NonNullable<ReturnType<typeof sample>>> => {
    const out: Array<NonNullable<ReturnType<typeof sample>>> = [];
    for (let i = 0; i < count; i += 1) {
      const s = sample(accountId);
      if (s) out.push(s);
    }
    return out;
  };

  // Sample progressively and abort as soon as two consecutive samples show a
  // *different* machine token: the bridge is either a deterministic fake
  // minter or its seed changed between runs, so voting has nothing to
  // stabilize. This keeps the per-allocation bridge cost at 1-2 samples for
  // unstable identities instead of always paying the full vote.
  const samples: Array<NonNullable<ReturnType<typeof sample>>> = [];
  const first = take(1)[0];
  if (!first) return null;
  samples.push(first);
  const second = take(1)[0];
  if (!second) return first;
  samples.push(second);
  if (second.identity.machineToken !== first.identity.machineToken) return first;
  const third = take(1)[0];
  if (!third) return first;
  samples.push(third);
  if (samples.length === 0) return null;

  // Vote key: the machine token alone distinguishes identities; VM branch is
  // part of the identity but the token is the stable anchor.
  const tally = new Map<string, Array<NonNullable<ReturnType<typeof sample>>>>();
  for (const s of samples) {
    const key = s.identity.machineToken;
    const arr = tally.get(key) ?? [];
    arr.push(s);
    tally.set(key, arr);
  }
  // Every sample produced a *different* token (e.g. a deterministic fake
  // minter, or a bridge whose seed changed each run). Voting cannot pick a
  // majority; take the first sample, matching the donor's "no majority →
  // use first sample" fallback.
  if (tally.size === samples.length) return samples[0]!;
  if (tally.size === 1) return samples[0]!;

  const extended = samples.concat(take(VOTE_EXTEND_ROUNDS));
  const tally2 = new Map<string, Array<NonNullable<ReturnType<typeof sample>>>>();
  for (const s of extended) {
    const key = s.identity.machineToken;
    const arr = tally2.get(key) ?? [];
    arr.push(s);
    tally2.set(key, arr);
  }
  const topKey = [...tally2.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!topKey) return samples[0]!;
  return topKey[1][0] ?? samples[0]!;
}
