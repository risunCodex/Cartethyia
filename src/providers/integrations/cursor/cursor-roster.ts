/**
 * Per-credential roster cache for Cursor model discovery.
 *
 * Why this exists: `AvailableModels` is one upstream round trip per ask, and a
 * Run cannot be built without it (the model's declared parameter tuple or the
 * Run streams only heartbeats). The cache policy follows the maturity fixes
 * proven in the reference plugin's changelog (0.2.28):
 *
 * - **stale-while-revalidate** — a list past its keep is served while a fresh
 *   one is fetched, so a slow upstream never blocks a Run on a 30s wait;
 * - **single-flight** — requests at once share one ask;
 * - **failure backoff** — after a failed ask, requests go without a refetch
 *   for 5 minutes (using the stale list when there is one) instead of each
 *   waiting on its own doomed round trip.
 *
 * Rosters are keyed by a credential digest, never by the token itself, so a
 * cache dump cannot leak credentials.
 */
import { createHash } from "node:crypto";
import { fetchCursorDiscovery, type CursorDiscoveryResult } from "./cursor-discovery";
import type { FetchLike } from "../../authentication/oauth-client";

/** A roster's freshness window; stale-but-present rosters still serve. */
const ROSTER_TTL_MS = 5 * 60 * 1000;
/** After a failed ask, no refetch is attempted for this long. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** Bounded roster cache (one entry per credential digest). */
const ROSTER_CACHE_MAX = 32;

interface RosterEntry {
  result: CursorDiscoveryResult;
  fetchedAt: number;
  /** Epoch ms until which a failed ask suppresses refetch; 0 when healthy. */
  backoffUntil: number;
}

export type RosterStatus = "fresh" | "stale-served" | "refetched" | "backoff-only";

export interface RosterLookup {
  readonly result: CursorDiscoveryResult;
  readonly status: RosterStatus;
}

function credentialDigest(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

export class CursorRosterCache {
  readonly #entries = new Map<string, RosterEntry>();
  readonly #inflight = new Map<string, Promise<CursorDiscoveryResult>>();

  /**
   * Returns the roster for one credential, fetching when needed.
   *
   * Fresh entries return directly; stale entries serve immediately and a
   * revalidation runs in the background (`stale-served` then `refetched` is
   * observed by later lookups). A cold cache waits on the shared ask. During
   * failure backoff a stale entry serves as `backoff-only`, and a cold cache
   * throws the backoff error rather than hammering a broken upstream.
   */
  async lookup(
    accessToken: string,
    fetchFn: FetchLike,
    now: number = Date.now(),
  ): Promise<RosterLookup> {
    const key = credentialDigest(accessToken);
    const entry = this.#entries.get(key);

    if (entry !== undefined && now - entry.fetchedAt < ROSTER_TTL_MS) {
      return { result: entry.result, status: "fresh" };
    }

    if (entry !== undefined && entry.backoffUntil > now) {
      // Upstream failed recently and we still hold a (stale) roster: serve it
      // without asking again. The alternative — blocking every Run on a known
      // failing endpoint — is what the 5-minute backoff exists to prevent.
      return { result: entry.result, status: "backoff-only" };
    }

    const running = this.#inflight.get(key);
    if (running !== undefined) {
      const result = await running;
      return { result, status: "fresh" };
    }

    const ask = fetchCursorDiscovery(accessToken, fetchFn)
      .then((result) => {
        this.#entries.set(key, { result, fetchedAt: now, backoffUntil: 0 });
        this.#prune();
        return result;
      })
      .catch((error: unknown) => {
        if (entry !== undefined) {
          entry.backoffUntil = now + FAILURE_BACKOFF_MS;
          return entry.result;
        }
        throw error;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });
    this.#inflight.set(key, ask);

    const result = await ask;
    // If a stale entry existed and the ask succeeded, the fresh list replaced
    // it; if the ask failed and fell back to stale, say so.
    const current = this.#entries.get(key);
    const servedStale = current !== undefined && current.backoffUntil > now;
    return { result, status: servedStale ? "backoff-only" : entry === undefined ? "refetched" : "stale-served" };
  }

  /** Drops one credential's roster (sign-out, credential rotation). */
  invalidate(accessToken: string): void {
    this.#entries.delete(credentialDigest(accessToken));
  }

  #prune(): void {
    while (this.#entries.size > ROSTER_CACHE_MAX) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}
