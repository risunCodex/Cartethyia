/**
 * Disk cache for Qoder native machine identities.
 *
 * Adopted from the donor reference implementation (`qoder_accounts.py`
 * §native_machine_identity):
 *
 *  - **Disk cache** (`machine_identity.json` per data dir): the machine-level
 *    identity is host-derived and stable, but container rebuilds/upgrades
 *    would otherwise re-derive it (and any per-run jitter would churn it) —
 *    a disk cache keeps the device identity stable across restarts. Cache
 *    wins: when a valid cache entry exists for the realm, the mint is not
 *    re-run.
 *  - **Expired-cache fallback**: when the mint fails, fall back to the cached
 *    identity even if expired — a real identity is better than a generated
 *    one.
 *
 * The cache is per-realm (intl vs cn use different env codes and produce
 * different identities). It is machine-global, not per-account: the seed is
 * machine-scoped, and per-account isolation stays in the database
 * (`provider_accounts.native_identity`).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Path to the machine-identity cache file. */
export function machineIdentityCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir(env), "machine_identity.json");
}

/**
 * Memoized parsed cache document, keyed by resolved cache path (the path is
 * env-parameterized; tests and sandboxes point it at distinct directories).
 * The document is memoized, not the per-realm read result: the TTL check runs
 * on every call with a fresh `Date.now()`, so an entry still expires to
 * `null` without any file write. Freshness is validated with one `statSync`
 * per read — a changed mtime/size (or a vanished file) re-reads from disk, so
 * external edits to `machine_identity.json` stay observable on the next read.
 */
interface MemoizedCacheDoc {
  readonly mtimeMs: number;
  readonly size: number;
  readonly doc: MachineIdentityCacheDoc;
}

const cacheDocMemo = new Map<string, MemoizedCacheDoc>();

/** mtime+size fingerprint of the cache file, or `null` when it does not exist. */
function cacheDocStat(path: string): { readonly mtimeMs: number; readonly size: number } | null {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

/** Full disk read + validation (the previous body of `readCacheDoc`). */
function parseCacheDoc(path: string): MachineIdentityCacheDoc {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MachineIdentityCacheDoc>;
    if (raw.version !== CACHE_VERSION || typeof raw.realm !== "object" || raw.realm === null) {
      return { version: CACHE_VERSION, realm: {} };
    }
    return { version: CACHE_VERSION, realm: raw.realm as MachineIdentityCacheDoc["realm"] };
  } catch {
    return { version: CACHE_VERSION, realm: {} };
  }
}

function readCacheDoc(path: string): MachineIdentityCacheDoc {
  const memoKey = resolve(path);
  const memo = cacheDocMemo.get(memoKey);
  const stat = cacheDocStat(path);
  if (memo !== undefined && stat !== null && stat.mtimeMs === memo.mtimeMs && stat.size === memo.size) {
    // Fresh object graph per read, as `JSON.parse` would produce: callers
    // mutate `realm` when writing (see `writeMachineIdentityCache`). Entries
    // are flat primitive records, so a spread clones them fully; a null entry
    // (writable JSON) passes through falsy, as readers expect.
    const realm: MachineIdentityCacheDoc["realm"] = {};
    for (const [realmKey, realmEntry] of Object.entries(memo.doc.realm)) {
      realm[realmKey] = realmEntry ? { ...realmEntry } : realmEntry;
    }
    return { version: memo.doc.version, realm };
  }
  const doc = parseCacheDoc(path);
  if (stat === null) cacheDocMemo.delete(memoKey);
  else cacheDocMemo.set(memoKey, { mtimeMs: stat.mtimeMs, size: stat.size, doc });
  return doc;
}

function writeCacheDoc(path: string, doc: MachineIdentityCacheDoc): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
    // Atomic replace so a crash never leaves a half-written cache.
    renameSync(tmp, path);
    // Refresh the memo only after the rename succeeded: a failed write is
    // swallowed below and must never leave the memo serving an entry that
    // never reached the disk.
    const stat = cacheDocStat(path);
    if (stat === null) cacheDocMemo.delete(resolve(path));
    else cacheDocMemo.set(resolve(path), { mtimeMs: stat.mtimeMs, size: stat.size, doc });
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
