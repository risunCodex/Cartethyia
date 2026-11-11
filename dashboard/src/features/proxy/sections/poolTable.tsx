import { memo, useContext, type ReactNode } from "react";
import { Activity, FlaskConical, Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Badge, type BadgeTone } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Inline } from "../../../components/ui/inline";
import { Switch } from "../../../components/ui/switch";
import type {
  HealthCheckResult,
  NetworkPoolResponse,
  PoolProviderProbeResult,
  PoolSpeedTestResult,
} from "../../../data/contracts";
import {
  useClearNetworkPoolCooldown,
  useRecoverNetworkPool,
  useUpdateNetworkPool,
} from "../../../hooks/network";
import type { PoolUsageRow } from "../../../hooks/live";
import { formatBytes } from "../../../lib/format/numbers";
import { PoolUsageContext } from "./poolSummaryTiles";

const MYSTERIOUS_PROXY = "Mysterious Proxy";

/** Derives a friendly `host:port` name and a normalized full endpoint URL from a pool. */
export function poolDisplay(pool: NetworkPoolResponse): { name: string; endpoint: string } {
  const raw = pool.endpoint || "";
  const candidate = raw.includes("://") ? raw : `${pool.kind}://${raw}`;
  const defaultPorts: Record<string, string> = {
    "https:": "443",
    "http:": "80",
    "socks5:": "1080",
    "socks:": "1080",
  };
  try {
    const u = new URL(candidate);
    const port = u.port || defaultPorts[u.protocol] || "";
    const authority = `${u.hostname}${port ? `:${port}` : ""}`;
    return {
      name: authority,
      endpoint: `${u.protocol}//${authority}${u.pathname !== "/" ? u.pathname : ""}${u.search}`,
    };
  } catch {
    return { name: pool.label || raw, endpoint: raw };
  }
}

/** Human-friendly pool name: explicit label first, then the derived `host:port`. */
export function poolName(pool: NetworkPoolResponse): string {
  return pool.label || poolDisplay(pool).name || pool.id;
}

// A measurement plus when it was taken. The server now stamps and persists
// each speed test on the pool row (`measuredAt` + `lastSpeedtest*`), so the
// localStorage entry is only a fallback for the just-measured moment before
// the pool list refetches — the server row is the authority after any reload.
export type StoredSpeedResult = PoolSpeedTestResult & { readonly measuredAt?: string };

/** Last server-persisted speed-test measurement for a pool, if any. */
export function serverSpeedResult(pool: NetworkPoolResponse): StoredSpeedResult | undefined {
  if (pool.lastSpeedtestStatus === undefined || pool.lastSpeedtestAt === undefined) return undefined;
  const durationMs = pool.lastSpeedtestDurationMs ?? 0;
  const bytes = pool.lastSpeedtestBytes ?? 0;
  const bytesPerSecond = durationMs > 0 ? bytes / (durationMs / 1000) : undefined;
  return {
    poolId: pool.id,
    status: pool.lastSpeedtestStatus,
    bytes,
    durationMs,
    ...(bytesPerSecond === undefined
      ? {}
      : { bytesPerSecond, megabitsPerSecond: (bytesPerSecond * 8) / 1_000_000 }),
    ...(pool.lastSpeedtestError ? { errorMessage: pool.lastSpeedtestError } : {}),
    measuredAt: pool.lastSpeedtestAt,
  };
}

/** Newer of the local and server-known measurements wins. */
export function newerSpeedResult(
  local: StoredSpeedResult | undefined,
  server: StoredSpeedResult | undefined,
): StoredSpeedResult | undefined {
  if (!local) return server;
  if (!server) return local;
  const localAt = local.measuredAt ? new Date(local.measuredAt).getTime() : 0;
  const serverAt = server.measuredAt ? new Date(server.measuredAt).getTime() : 0;
  return serverAt >= localAt ? server : local;
}

export function poolLatencyMs(
  pool: NetworkPoolResponse,
  checkResult?: HealthCheckResult,
): number | undefined {
  if (checkResult?.status === "healthy" || checkResult?.status === "reachable") {
    return checkResult.latencyMs;
  }
  if (pool.lastSuccessAt) return pool.lastLatencyMs ?? undefined;
  return undefined;
}
export function proxyResponseLabel(category: string | undefined): string | undefined {
  if (category === "proxy_payment_required") return "HTTP 402 Payment Required";
  if (category === "proxy_auth_required") return "HTTP 407 Proxy Authentication Required";
  return undefined;
}

/**
 * Everything a pool row or card renders, derived in one place so the desktop
 * table and the mobile cards cannot disagree about status, load, or quota.
 */
interface PoolView {
  readonly display: { name: string; endpoint: string };
  readonly poolLabel: string;
  readonly isEnabled: boolean;
  readonly checkTone: BadgeTone;
  readonly checkTooltip: string | undefined;
  readonly statusText: string;
  readonly latency: number | undefined;
  readonly inflight: number;
  readonly load: number;
  readonly cooldowns: readonly NonNullable<NetworkPoolResponse["providerCooldowns"]>[number][];
  readonly cooldownText: string;
  /** The last OpenCode probe for this pool, when one has run. */
  readonly probe?: PoolProviderProbeResult;
  /** Providers this egress is retired for, as opposed to merely throttled. */
  readonly blocked: readonly NonNullable<NetworkPoolResponse["providerCooldowns"]>[number][];
  readonly cooldownOnly: readonly NonNullable<NetworkPoolResponse["providerCooldowns"]>[number][];
  readonly metered: number;
  readonly session: number;
  readonly used: number;
  readonly proxyFailureLabel: string | undefined;
}

function derivePoolView(
  pool: NetworkPoolResponse,
  checkResult: HealthCheckResult | undefined,
  isTesting: boolean,
  liveBytes: PoolUsageRow | null,
  probe?: PoolProviderProbeResult,
): PoolView {
  const display = poolDisplay(pool);
  const poolLabel = poolName(pool);
  const isEnabled = pool.status !== "disabled";
  const proxyFailureLabel = proxyResponseLabel(pool.lastErrorCategory);
  const proxyResponseDisabled = pool.status === "disabled" && proxyFailureLabel !== undefined;
  const lastSuccess = pool.lastSuccessAt ? new Date(pool.lastSuccessAt).getTime() : 0;
  const lastError = pool.lastErrorAt ? new Date(pool.lastErrorAt).getTime() : 0;
  const persistedOk =
    !checkResult && (lastSuccess > 0 || lastError > 0) ? lastSuccess >= lastError : null;
  const checkTone: BadgeTone = isTesting
    ? "default"
    : proxyResponseDisabled
      ? "warn"
      : checkResult
        ? checkResult.status === "healthy"
          ? "ok"
          : checkResult.status === "reachable"
            ? "warn"
            : "err"
        : persistedOk === true
          ? "ok"
          : persistedOk === false
            ? "err"
            : "default";
  const checkTooltip = proxyResponseDisabled
    ? pool.lastError ?? proxyFailureLabel
    : checkResult?.errorMessage ??
      (persistedOk !== null
        ? `last check ${(pool.lastHealthCheckAt ? new Date(pool.lastHealthCheckAt) : new Date()).toLocaleString()}`
        : undefined);
  const latency = poolLatencyMs(pool, checkResult);
  // Live SSE usage wins over the polled snapshot while the stream is up.
  const inflight = liveBytes?.currentInflight ?? pool.inflight;
  const load = pool.maxInflight > 0 ? Math.min(1, inflight / pool.maxInflight) : 1;
  const cooldowns = pool.providerCooldowns ?? [];
  // A block is not a cooldown with a longer clock: the upstream retired this
  // address, so it will not come back on its own. Rendering the two as one
  // number is what let an operator wait out something that never expires.
  const blocked = cooldowns.filter((entry) => entry.blocked === true);
  const cooldownOnly = cooldowns.filter((entry) => entry.blocked !== true);
  const describe = (entry: NonNullable<NetworkPoolResponse["providerCooldowns"]>[number]) =>
    entry.blocked === true
      ? `${entry.providerId} blocked: ${entry.reason}`
      : `${entry.providerId} until ${new Date(entry.until).toLocaleTimeString()}: ${entry.reason}`;
  const cooldownText = cooldowns.slice(0, 2).map(describe).join(" · ");
  const statusText = isTesting
    ? "Testing…"
    : proxyResponseDisabled
      ? "Proxy reachable"
      : checkResult
        ? checkResult.status === "healthy"
          ? "Connected"
          : checkResult.status === "reachable"
            ? "Proxy reachable"
            : checkResult.status === "timeout"
              ? "Timeout"
              : "Unhealthy"
        : persistedOk === true
          ? "Connected"
          : persistedOk === false
            ? pool.lastErrorCategory === "timeout"
              ? "Timeout"
              : "Unhealthy"
            : "Untested";
  // Metered lifetime (banked in the pool row, survives restarts) plus the live
  // session counters. The row is banked on nearly every pool-touching write,
  // so the session figure is almost entirely contained in the metered one —
  // max() avoids double-counting while keeping pre-restart history.
  const metered = (pool.bytesSentTotal ?? 0) + (pool.bytesReceivedTotal ?? 0);
  const session = (liveBytes?.bytesSent ?? 0) + (liveBytes?.bytesReceived ?? 0);
  return {
    display,
    poolLabel,
    isEnabled,
    checkTone,
    checkTooltip,
    statusText,
    latency,
    inflight,
    load,
    cooldowns,
    blocked,
    cooldownOnly,
    cooldownText,
    ...(probe === undefined ? {} : { probe }),
    metered,
    session,
    used: Math.max(metered, session),
    proxyFailureLabel,
  };
}

/** Pool name plus status badges; shared by the table cell and the mobile card. */
function PoolTitleBlock({
  pool,
  view,
  maskValues,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
  readonly maskValues: boolean;
}): ReactNode {
  return (
    <>
      <span
        className="block text-caption font-semibold overflow-hidden truncate whitespace-nowrap"
        title={maskValues ? MYSTERIOUS_PROXY : view.poolLabel}
      >
        {maskValues ? MYSTERIOUS_PROXY : view.poolLabel}
      </span>
      <div className="flex items-center gap-3 mt-1.5 min-w-0 flex-wrap">
        {pool.status === "disabled" ? (
          <Badge tone="disabled" title={pool.lastError}>
            Disabled{view.proxyFailureLabel ? ` · ${view.proxyFailureLabel}` : ""}
          </Badge>
        ) : (
          <Badge tone={view.checkTone} title={view.checkTooltip}>
            {view.latency === undefined ? view.statusText : `${view.statusText} · ${view.latency}ms`}
          </Badge>
        )}
        {view.blocked.length > 0 ? (
          <Badge tone="disabled" title={view.cooldownText}>
            {view.blocked.length} blocked
          </Badge>
        ) : null}
        {view.probe ? (
          <Badge
            tone={
              view.probe.status === "blocked"
                ? "disabled"
                : view.probe.status === "allowed"
                  ? "ok"
                  : "warn"
            }
            title={
              view.probe.reason ??
              (view.probe.status === "allowed"
                ? view.probe.httpStatus !== undefined && view.probe.httpStatus >= 400
                  // A 4xx here is the upstream rejecting the *probe body*, not
                  // the egress: its IP gate runs first. Saying "served" would
                  // overclaim, so the badge reports what actually happened.
                  ? `Reachable — upstream answered ${view.probe.httpStatus} for the probe body`
                  : "OpenCode served a probe through this pool"
                : view.probe.status === "throttled"
                  ? "OpenCode accepted this egress; the rate is spent"
                  : "The probe could not complete")
            }
          >
            {/* `unreachable` is reserved for a probe that could not complete.
                A 4xx from the upstream's own validation means the egress was
                accepted, so it is never shown as unreachable. */}
            {view.probe.status === "blocked"
              ? "OpenCode blocked"
              : view.probe.status === "allowed"
                ? view.probe.httpStatus !== undefined && view.probe.httpStatus >= 400
                  ? "OpenCode reachable"
                  : "OpenCode OK"
                : view.probe.status === "throttled"
                  ? "OpenCode rate-limited"
                  : "OpenCode unreachable"}
          </Badge>
        ) : null}
        {view.cooldownOnly.length > 0 ? (
          <Badge tone="warn" title={view.cooldownText}>
            {view.cooldownOnly.length} cooldown{view.cooldownOnly.length > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>
    </>
  );
}

/** Egress address plus the last speed-test badge; shared by table and card. */
function PoolAddressBlock({
  pool,
  view,
  speedResult,
  isSpeedTesting,
  maskIp,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
  readonly speedResult?: StoredSpeedResult;
  readonly isSpeedTesting: boolean;
  readonly maskIp: boolean;
}): ReactNode {
  return (
    <>
      {pool.egressIp ? (
        <span
          className="font-mono tabular-nums block overflow-hidden text-ellipsis whitespace-nowrap text-badge"
          title={maskIp ? "IP masked" : `egress ${pool.egressIp} · ${view.display.endpoint}`}
        >
          {maskIp ? "IP masked" : pool.egressIp}
        </span>
      ) : (
        <span className="text-badge text-text-tertiary" title="Test the pool to read its egress address">
          not probed
        </span>
      )}
      {(isSpeedTesting || speedResult) && (
        <div className="mt-1.5">
          <Badge
            tone={isSpeedTesting ? "default" : speedResult?.status === "ok" ? "ok" : "err"}
            title={
              isSpeedTesting
                ? "Measuring download throughput"
                : speedResult?.status === "ok"
                  ? `${formatBytes(speedResult.bytes)} in ${speedResult.durationMs}ms${
                      speedResult.measuredAt
                        ? ` · last measured ${new Date(speedResult.measuredAt).toLocaleString()}`
                        : ""
                    }`
                  : `${speedResult?.errorMessage ?? "Speed test failed"}${
                      speedResult?.measuredAt
                        ? ` · last measured ${new Date(speedResult.measuredAt).toLocaleString()}`
                        : ""
                    }`
            }
          >
            {isSpeedTesting
              ? "Speed…"
              : speedResult?.status === "ok"
                ? `${(speedResult.megabitsPerSecond ?? 0).toFixed(1)} Mbps`
                : "Speed failed"}
          </Badge>
        </div>
      )}
    </>
  );
}

/** Load bar plus metered quota bar; shared by the table cell and the mobile card. */
function PoolUsageBars({
  pool,
  view,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
}): ReactNode {
  const quota = pool.quotaBytes;
  const ratio = quota && quota > 0 ? Math.min(1, view.used / quota) : 0;
  const over = quota !== undefined && quota > 0 && view.used > quota;
  return (
    <>
      <div
        title={`${view.inflight}/${pool.maxInflight} inflight`}
        className="flex items-center gap-3"
      >
        <div
          className="flex-1 h-3 rounded-micro overflow-hidden"
        >
          <div
            className="h-full rounded-micro"
            style={{
              width: `${Math.round(view.load * 100)}%`,
              background: view.load >= 0.8 ? "var(--orange)" : "var(--green)",
            }}
          />
        </div>
        <span className="font-mono tabular-nums text-micro text-text-secondary whitespace-nowrap">
          {view.inflight}/{pool.maxInflight}
        </span>
      </div>
      <div
        title={
          quota
            ? `${formatBytes(view.used)} of ${formatBytes(quota)} used · ${formatBytes(view.metered)} metered lifetime`
            : `${formatBytes(view.used)} carried (no quota set) · ${formatBytes(view.session)} this session`
        }
        className="flex items-center gap-3 mt-2"
      >
        <div
          className="flex-1 h-3 rounded-micro overflow-hidden"
        >
          <div
            className="h-full rounded-micro"
            style={{
              width: `${Math.round(ratio * 100)}%`,
              background: over ? "var(--red)" : ratio >= 0.8 ? "var(--orange)" : "var(--teal)",
            }}
          />
        </div>
        <span
          className={`font-mono tabular-nums whitespace-nowrap text-micro ${over ? "text-red" : "text-text-secondary"}`}
        >
          {formatBytes(view.used)}
          {quota ? ` / ${formatBytes(quota)}` : ""}
        </span>
      </div>
    </>
  );
}

/** Row/card actions: test, activity, recover, edit, delete, and the enable switch. */
function PoolActionButtons({
  pool,
  view,
  isTesting,
  onDelete,
  onEdit,
  onHealthCheck,
  onActivity,
}: {
  readonly pool: NetworkPoolResponse;
  readonly view: PoolView;
  readonly isTesting: boolean;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (pool: NetworkPoolResponse) => void;
  readonly onHealthCheck: (pool: NetworkPoolResponse) => void;
  readonly onActivity: (pool: NetworkPoolResponse) => void;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const clearCooldown = useClearNetworkPoolCooldown();
  const recoverPool = useRecoverNetworkPool();
  return (
    <>
      {view.cooldowns.length > 0 && (
        <Button
          size="icon"
          variant="secondary"
          disabled={clearCooldown.isPending}
          icon={
            clearCooldown.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCcw size={12} />
            )
          }
          onClick={() => clearCooldown.mutate({ poolId: pool.id })}
          title={`Clear provider cooldowns — ${view.cooldownText}`}
          label="Clear"
        />
      )}
      <Button
        size="icon"
        variant="secondary"
        icon={<Activity size={12} />}
        onClick={() => onActivity(pool)}
        title="Health and error activity"
        label="Activity"
      />
      {(pool.status === "cooldown") && (
        <Button
          size="icon"
          variant="secondary"
          disabled={recoverPool.isPending}
          icon={<RotateCcw size={12} className={recoverPool.isPending ? "animate-spin" : ""} />}
          onClick={() => recoverPool.mutate(pool.id)}
          title="Recover pool"
        >
          Recover
        </Button>
      )}
      {!(!view.isEnabled && view.cooldowns.length > 0) && (
        <Button
          size="icon"
          variant="secondary"
          disabled={isTesting}
          icon={
            isTesting ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />
          }
          onClick={() => onHealthCheck(pool)}
          title={view.checkTooltip ?? "Run health check"}
          label="Test"
        />
      )}
      <Button
        size="icon"
        variant="secondary"
        icon={<Pencil size={12} />}
        onClick={() => onEdit(pool)}
        title="Edit pool"
        label="Edit"
      />
      <Button
        size="icon"
        variant="secondary"
        icon={<Trash2 size={12} />}
        onClick={() => onDelete(pool.id)}
        title="Delete pool"
        label="Delete"
      />
      <Switch
        // Pushed to the far right so the on/off control sits apart from
        // the destructive Delete button beside it.
        className="ml-3"
        checked={view.isEnabled}
        disabled={updatePool.isPending}
        onChange={(next) =>
          updatePool.mutate({
            poolId: pool.id,
            request: { status: next ? "active" : "disabled" },
          })
        }
      />
    </>
  );
}

/**
 * One proxy row.
 *
 * Memoized: the list re-renders on selection, testing, and sorting, and each
 * row carries three mutations of its own. Without this every row re-ran those
 * hooks for a change that touched one of them.
 */
export const PoolRow = memo(function PoolRow({
  pool,
  isSelected,
  onToggleSelect,
  onShiftSelect,
  checkResult,
  isTesting,
  onDelete,
  onEdit,
  onHealthCheck,
  onActivity,
  speedResult,
  isSpeedTesting,
  maskValues,
  maskIp,
  probe,
}: {
  readonly pool: NetworkPoolResponse;
  readonly isSelected: boolean;
  readonly onToggleSelect: (id: string) => void;
  readonly onShiftSelect: (id: string) => void;
  readonly checkResult?: HealthCheckResult;
  readonly probe?: PoolProviderProbeResult;
  readonly isTesting: boolean;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (pool: NetworkPoolResponse) => void;
  readonly onHealthCheck: (pool: NetworkPoolResponse) => void;
  readonly onActivity: (pool: NetworkPoolResponse) => void;
  readonly speedResult?: StoredSpeedResult;
  readonly isSpeedTesting: boolean;
  readonly maskValues: boolean;
  readonly maskIp: boolean;
}): ReactNode {
  // Read live usage here rather than as a prop: the parent would otherwise have
  // to hand every row a fresh value on each stream tick, which is exactly the
  // re-render this memo exists to avoid. Only rows whose own pool changed
  // actually re-render.
  const live = useContext(PoolUsageContext);
  const usage = live.live ? live.byId.get(pool.id) : undefined;
  const view = derivePoolView(pool, checkResult, isTesting, usage ?? null, probe);
  return (
    <tr className={view.isEnabled ? "" : "opacity-60"}>
      <td className="w-13">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(pool.id)}
          onKeyDown={(event) => {
            if (event.shiftKey && event.key === "Enter") {
              event.preventDefault();
              onShiftSelect(pool.id);
            }
          }}
          onClick={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
              onShiftSelect(pool.id);
            }
          }}
          aria-label={`Select ${view.poolLabel}`}
        />
      </td>
      <td className="min-w-0 max-w-150">
        <PoolTitleBlock pool={pool} view={view} maskValues={maskValues} />
      </td>
      <td className="min-w-0 max-w-90">
        {pool.family ? (
          <span
            className="truncate text-caption font-semibold text-text-secondary"
            title={pool.family}
          >
            {pool.family}
          </span>
        ) : (
          <span className="text-badge text-text-tertiary">—</span>
        )}
      </td>
      <td className="max-w-110">
        <PoolAddressBlock
          pool={pool}
          view={view}
          speedResult={speedResult}
          isSpeedTesting={isSpeedTesting}
          maskIp={maskIp}
        />
      </td>
      <td className="min-w-55">
        <PoolUsageBars pool={pool} view={view} />
      </td>
      <td className="whitespace-nowrap pl-36 text-right">
        <Inline gap="4px" justify="end">
          <PoolActionButtons
            pool={pool}
            view={view}
            isTesting={isTesting}
            onDelete={onDelete}
            onEdit={onEdit}
            onHealthCheck={onHealthCheck}
            onActivity={onActivity}
          />
        </Inline>
      </td>
    </tr>
  );
});
