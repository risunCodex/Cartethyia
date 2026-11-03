import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest, isRecord } from "../data/api";
import { queryKeys } from "../data/query-keys";
import { useConsoleEventSource } from "./use-console-event-source";

export interface InFlightState {
  /** Latest live count, or null before the first snapshot arrives. */
  readonly count: number | null;
  /** Unique client IPs behind the live count, or null before arrival. */
  readonly uniqueIps: number | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

function readSnapshot(payload: unknown): { count: number; uniqueIps: number } | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.inFlight !== "number" || !Number.isFinite(payload.inFlight)) return null;
  const count = Math.max(0, Math.floor(payload.inFlight));
  // Older gateways send no `uniqueIps`: fall back to the count so the pill
  // still renders instead of sticking at its loading state.
  const uniqueIps =
    typeof payload.uniqueIps === "number" && Number.isFinite(payload.uniqueIps)
      ? Math.max(0, Math.min(count, Math.floor(payload.uniqueIps)))
      : count;
  return { count, uniqueIps };
}

/**
 * Live in-flight proxy request count over the console SSE stream
 * (`GET /live/in-flight/stream`, `count` events). Opens with an
 * authenticated snapshot fetch — so a dead session bounces to login through
 * the shell's normal 401 handling instead of spinning a retry loop — then
 * keeps the stream open; on transport failure it re-snapshots and re-opens
 * after a short delay.
 *
 * The stream also delivers `request_completed` events (the same fan-out as
 * `GET /live/requests/stream`), so this single connection both drives the
 * in-flight pill and invalidates the usage requests queries — the Usage page
 * gets one stream and one preflight instead of two.
 */
export function useInFlight(): InFlightState {
  const queryClient = useQueryClient();
  const [count, setCount] = useState<number | null>(null);
  const [uniqueIps, setUniqueIps] = useState<number | null>(null);
  const [live, setLive] = useState(false);

  useConsoleEventSource({
    url: "/console/api/live/in-flight/stream",
    preflight: async () => {
      const snapshot = await consoleRequest<unknown>("/live/in-flight");
      const next = readSnapshot(snapshot);
      if (next !== null) {
        setCount(next.count);
        setUniqueIps(next.uniqueIps);
      }
    },
    events: ["count", "request_completed"],
    onEvent: (event, data) => {
      if (event === "request_completed") {
        // Invalidate all request list queries so the table refreshes
        // immediately. The query key prefix covers every period/limit combo.
        void queryClient.invalidateQueries({
          queryKey: ["console", "usage", "requests"],
          exact: false,
        });
        return;
      }
      if (event !== "count") return;
      try {
        const seen = readSnapshot(JSON.parse(data));
        if (seen !== null) {
          setCount(seen.count);
          setUniqueIps(seen.uniqueIps);
          setLive(true);
        }
      } catch {
        // Malformed frame: keep the last good value.
      }
    },
    onOpen: () => setLive(true),
    onClose: () => setLive(false),
  });

  return { count, uniqueIps, live };
}

export interface PoolUsageRow {
  readonly poolId: string;
  readonly currentInflight: number;
  /** Wire bytes the pool has carried since this process started. */
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export interface PoolUsageState {
  /** Latest per-pool usage rows, or null before the first snapshot arrives. */
  readonly pools: readonly PoolUsageRow[] | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

function readPools(payload: unknown): readonly PoolUsageRow[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.pools)) return null;
  const rows: PoolUsageRow[] = [];
  for (const raw of payload.pools) {
    if (!isRecord(raw) || typeof raw.poolId !== "string") continue;
    const currentInflight = typeof raw.currentInflight === "number" && Number.isFinite(raw.currentInflight)
      ? Math.max(0, Math.floor(raw.currentInflight))
      : 0;
    const bytes = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    rows.push({
      poolId: raw.poolId,
      currentInflight,
      bytesSent: bytes(raw.bytesSent),
      bytesReceived: bytes(raw.bytesReceived),
    });
  }
  return rows;
}

/**
 * Hard bound on remembered per-pool byte peaks.
 *
 * Neither `pools` frame is a complete list of the tenant's configured pools:
 * `NetworkPoolSelector.snapshotPoolUsage()` only rows pools that currently hold
 * a slot (an idle pool drops out on release) and the live route unions that
 * with the byte-accounting map. Entries therefore cannot be pruned against a
 * snapshot without snapping a legitimately idle pool's peak to 0B — which is
 * exactly what this map exists to prevent. Bound it the way
 * `enforceInflightLimit` bounds the backend's inflight map instead: evict
 * oldest-inserted entries past the cap.
 */
export const MAX_TRACKED_POOL_PEAKS = 500;

function enforcePeakLimit(peaks: Map<string, PoolUsageRow>): void {
  while (peaks.size > MAX_TRACKED_POOL_PEAKS) {
    const oldest = peaks.keys().next().value;
    if (oldest === undefined) break;
    peaks.delete(oldest);
  }
}

/**
 * Folds one frame of pool rows into the remembered peaks and returns the rows
 * to render. Shared by the snapshot fetch and the stream so both paths get the
 * same merge and the same bound.
 */
export function mergePools(
  peaks: Map<string, PoolUsageRow>,
  parsed: readonly PoolUsageRow[],
): PoolUsageRow[] {

  const present = new Set<string>();
  const next: PoolUsageRow[] = [];
  for (const row of parsed) {
    present.add(row.poolId);
    const prev = peaks.get(row.poolId);
    const merged: PoolUsageRow = prev
      ? {
          poolId: row.poolId,
          currentInflight: row.currentInflight,
          bytesSent: Math.max(prev.bytesSent, row.bytesSent),
          bytesReceived: Math.max(prev.bytesReceived, row.bytesReceived),
        }
      : row;
    peaks.set(row.poolId, merged);
    next.push(merged);
  }
  enforcePeakLimit(peaks);
  // Pools that dropped out of this frame keep their last max (union is backend-driven; this is the frontend guard).
  for (const [poolId, prev] of peaks) {
    if (!present.has(poolId)) next.push(prev);
  }
  return next;
}

/** Debounce window for the pools-query invalidation triggered by SSE health events. */
const POOLS_HEALTH_INVALIDATE_DEBOUNCE_MS = 2_000;

/**
 * Live per-pool proxy usage over the console SSE stream
 * (`GET /live/pools/stream`, `pools` events). Same open pattern as
 * `useInFlight`: authenticated snapshot first, then the stream, with
 * re-snapshot + re-open on transport failure. Rows cover only pools with an
 * active slot — an idle pool reads as absent (zero), keyed by pool id so the
 * Proxy page can join against its pool list.
 *
 * A `health` event invalidates the pools list query, debounced so a burst of
 * health transitions (a sweep recovering many pools) coalesces into one
 * refetch instead of N.
 */
export function usePoolUsage(): PoolUsageState {
  const queryClient = useQueryClient();
  const [pools, setPools] = useState<readonly PoolUsageRow[] | null>(null);
  const [live, setLive] = useState(false);
  const maxBytesByPool = useState(() => new Map<string, PoolUsageRow>())[0];
  const healthInvalidateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const timer = healthInvalidateTimer;
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  useConsoleEventSource({
    url: "/console/api/live/pools/stream",
    preflight: async () => {
      const snapshot = await consoleRequest<unknown>("/live/pools");
      const parsed = readPools(snapshot);
      if (parsed !== null) {
        // Keep the highest bytesSent/received seen per pool so a reconnect
        // that temporarily yields an empty snapshot does not snap the bar to 0B.
        setPools(mergePools(maxBytesByPool, parsed));
      }
    },
    events: ["pools", "health"],
    onEvent: (event, data) => {
      if (event === "health") {
        if (healthInvalidateTimer.current !== undefined) {
          clearTimeout(healthInvalidateTimer.current);
        }
        healthInvalidateTimer.current = setTimeout(() => {
          healthInvalidateTimer.current = undefined;
          void queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
        }, POOLS_HEALTH_INVALIDATE_DEBOUNCE_MS);
        return;
      }
      if (event !== "pools") return;
      try {
        const parsed = readPools(JSON.parse(data));
        if (parsed !== null) {
          setPools(mergePools(maxBytesByPool, parsed));
          setLive(true);
        }
      } catch {
        // Malformed frame: keep the last good value.
      }
    },
    onOpen: () => setLive(true),
    onClose: () => setLive(false),
  });

  return { pools, live };
}
