import { useProviderProbeNetworkPool } from "../../hooks/network";
import {
  Cloud,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  Gauge,
  Loader2,
  Plus,
  Power,
  PowerOff,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { RelayDeployModal } from "../../components/RelayDeployPanel";
import { useMaskIp, usePrivacyMode } from "../../lib/privacy-mode";
import { liveProbeFor, type StoredProviderResult } from "./probe-freshness";
import { Dialog } from "../../components/ui/dialog";
import { DataTable } from "../../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Select } from "../../components/ui/select";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import {
  SPEED_TEST_DEFAULT_BYTES,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MIN_BYTES,
} from "../../data/contracts";
import type { HealthCheckResult, NetworkPoolResponse } from "../../data/contracts";
import {
  useDeleteNetworkPool,
  useDeleteNetworkPoolBatch,
  useHealthCheckNetworkPool,
  useNetworkPools,
  usePoolStrategy,
  useSetNetworkPoolStatusBatch,
  useSpeedTestNetworkPool,
  useUpdateNetworkPool,
} from "../../hooks/network";
import { sortPools, type PoolSortKey } from "./proxy-metrics";
import { downloadTextFile } from "../../lib/download";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../data/api";
import { PoolEditForm, ProxyBulkForm, PROBE_PROVIDER_ID } from "./sections/poolDialogs";
import {
  PoolRow,
  poolDisplay,
  poolLatencyMs,
  poolName,
  newerSpeedResult,
  serverSpeedResult,
  type StoredSpeedResult,
} from "./sections/poolTable";
import { ProxyLiveProvider, ProxySummaryTiles } from "./sections/poolSummaryTiles";
import { PoolHealthDialog } from "./sections/poolHealthDialog";

export { SchemeChipRow, ProxyBulkForm } from "./sections/poolDialogs";
export { ProxyLiveProvider } from "./sections/poolSummaryTiles";

/**
 * What the split Test control sends.
 *
 * `url` is the neutral Cloudflare canary: it proves the proxy carries traffic
 * and reports the egress address, which is what the table column shows.
 * `opencode` asks the provider itself, because OpenCode refuses a flagged
 * address on its dispatch route while still serving its public catalog from
 * the same address — a neutral probe cannot see that.
 */
type TestPayload = "url" | "opencode";
const TEST_PAYLOAD_STORAGE_KEY = "cartethyia_proxy_test_payload";
const CHECK_RESULTS_STORAGE_KEY = "cartethyia_proxy_check_results";

const TEST_PAYLOAD_OPTIONS = [
  { value: "url", label: "Test URL" },
  { value: "opencode", label: "Test OpenCode" },
];

/**
 * How many provider probes run at once.
 *
 * Lower than the health check's eight: each probe opens a tunnel and a TLS
 * session to the provider, and a wide fan-out across a large selection is what
 * makes a batch probe look like an outage from the upstream's side.
 */
const PROVIDER_PROBE_CONCURRENCY = 4;

// Payload choices for the speed-test split control. Labels are decimal MB
// (1 MB = 1_000_000 bytes) to match how proxy plans are sold.
const SPEED_TEST_SIZES = [
  { value: String(SPEED_TEST_MIN_BYTES), label: "1 MB" },
  { value: String(SPEED_TEST_DEFAULT_BYTES), label: "5 MB" },
  { value: String(50_000_000), label: "50 MB" },
  { value: String(SPEED_TEST_MAX_BYTES), label: "100 MB" },
];

export default function Proxy(): ReactNode {
  const poolsQuery = useNetworkPools();
  const poolStrategyQuery = usePoolStrategy();
  const poolStrategy = poolStrategyQuery.data;
  const poolRuleLabel =
    poolStrategy === undefined
      ? null
      : poolStrategy.strategy === "round_robin"
        ? `Round robin · ${poolStrategy.rotateCount}/rotation`
        : poolStrategy.strategy === "random"
          ? "Random"
          : "Least loaded";
  const deletePool = useDeleteNetworkPool();
  const deletePoolBatch = useDeleteNetworkPoolBatch();
  const setPoolStatusBatch = useSetNetworkPoolStatusBatch();
  const updatePool = useUpdateNetworkPool();
  const healthCheck = useHealthCheckNetworkPool();
  const [showProxyForm, setShowProxyForm] = useState(false);
  const closeAddProxy = useCallback(() => setShowProxyForm(false), []);
  const [addProxyActions, setAddProxyActions] = useState<ReactNode>(null);
  const [editProxyActions, setEditProxyActions] = useState<ReactNode>(null);
  const [showRelayDeploy, setShowRelayDeploy] = useState(false);
  const [editingPool, setEditingPool] = useState<NetworkPoolResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const privacy = usePrivacyMode();
  const maskValues = privacy.enabled;
  const ipMask = useMaskIp();
  const maskIp = ipMask.enabled;
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(new Set());
  // The split control's payload choice, persisted like the other view
  // preferences: an operator debugging OpenCode wants that payload on return.
  const [testPayload, setTestPayload] = useState<TestPayload>(() => {
    try {
      return localStorage.getItem(TEST_PAYLOAD_STORAGE_KEY) === "opencode" ? "opencode" : "url";
    } catch {
      return "url";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(TEST_PAYLOAD_STORAGE_KEY, testPayload);
    } catch {
      // A blocked storage must not break the page.
    }
  }, [testPayload]);
  const [providerTestingIds, setProviderTestingIds] = useState<ReadonlySet<string>>(new Set());
  /**
   * Verdicts measured in this tab, before the refetched row carries them.
   *
   * The stored verdict lives on the pool row (`providerProbe`) — that is the
   * one every reader shares. This map only bridges the moment between a probe
   * finishing and the query refetch landing, and it seeds the add form's
   * verdict onto a row created in the same session. It is deliberately not
   * persisted: `localStorage` made the verdict visible to one browser and to
   * nobody else, so a pool could read "OpenCode blocked" here while dispatch
   * kept routing through it.
   */
  const [providerResults, setProviderResults] = useState<Record<string, StoredProviderResult>>({});
  const providerProbe = useProviderProbeNetworkPool();
  const speedTest = useSpeedTestNetworkPool();
  const [speedBytes, setSpeedBytes] = useState(SPEED_TEST_DEFAULT_BYTES);
  // Persisted like `checkResults`: a measurement is expensive to take (it pulls
  // real bytes through the operator's proxy plan) and is still the last known
  // throughput after a reload, so throwing it away on navigation is wasteful.
  const [speedResults, setSpeedResults] = useState<Record<string, StoredSpeedResult>>(() => {
    try {
      const saved = localStorage.getItem("cartethyia_proxy_speed_results");
      return saved ? (JSON.parse(saved) as Record<string, StoredSpeedResult>) : {};
    } catch {
      return {};
    }
  });
  const [speedTestingIds, setSpeedTestingIds] = useState<ReadonlySet<string>>(new Set());
  const rememberSpeedResult = useCallback((poolId: string, result: StoredSpeedResult) => {
    const stamped = { ...result, measuredAt: new Date().toISOString() };
    setSpeedResults((prev) => {
      const next = { ...prev, [poolId]: stamped };
      try {
        localStorage.setItem("cartethyia_proxy_speed_results", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const [checkResults, setCheckResults] = useState<Record<string, HealthCheckResult>>(() => {
    // Seeded from the server row (`lastSuccessAt`/`lastErrorAt`) by
    // `derivePoolView`, so this map only carries what the browser measured
    // since the page opened. A bulk import that tests and then saves reports
    // both verdicts here, and losing them on reload would put the rows back to
    // "Untested" for a check the operator already paid for.
    try {
      const saved = localStorage.getItem(CHECK_RESULTS_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as Record<string, HealthCheckResult>) : {};
    } catch {
      return {};
    }
  });
  const [sort, setSort] = useState<{ key: PoolSortKey; direction: "asc" | "desc" }>({
    key: "name",
    direction: "asc",
  });
  const [deleteTargets, setDeleteTargets] = useState<NetworkPoolResponse[] | null>(null);
  const [activityPool, setActivityPool] = useState<NetworkPoolResponse | null>(null);
  const pools = poolsQuery.data ?? [];
  const sortedPools = useMemo(
    () => sortPools(pools, sort.key, sort.direction, (pool) => poolLatencyMs(pool, checkResults[pool.id])),
    [pools, sort, checkResults],
  );
  const toggleSort = useCallback((key: string) => {
    const next = key as PoolSortKey;
    setSort((prev) =>
      prev.key === next
        ? { key: next, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key: next, direction: "asc" },
    );
  }, []);
  const isPending = poolsQuery.isPending;
  const isError = poolsQuery.isError;

  const allSelected = pools.length > 0 && pools.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(pools.map((p) => p.id)));
  };
  // Stable identities: the memoized rows only skip a re-render when the props
  // they receive keep the same reference across the parent's renders.
  const toggleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CHECK_RESULTS_STORAGE_KEY, JSON.stringify(checkResults));
    } catch {
      // A blocked storage must not break the page.
    }
  }, [checkResults]);

  const results = Object.values(checkResults);
  const testedCount = results.length;
  const successCount = results.filter((r) => r.status === "healthy" || r.status === "reachable").length;
  const errorCount = results.filter((r) => r.status !== "healthy" && r.status !== "reachable").length;

  const runCheck = useCallback((pool: NetworkPoolResponse) => {
    setTestingIds((prev) => new Set(prev).add(pool.id));
    healthCheck.mutate(pool.id, {
      onSuccess: (result) => {
        setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
        const label = poolName(pool);
        if (result.status === "healthy") {
          toast.success(`${label}: connected`, `${result.latencyMs ?? 0}ms`);
        } else if (result.status === "reachable") {
          toast.error(`${label}: proxy reachable · disabled`, result.errorMessage);
        } else {
          toast.error(
            `${label}: ${result.status === "timeout" ? "timeout" : "unhealthy"}`,
            result.errorMessage,
          );
        }
      },
      onError: (err) => {
        const label = poolName(pool);
        toast.error(`${label}: check failed`, getErrorMessage(err, "Health check failed"));
      },
      onSettled: () => {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(pool.id);
          return next;
        });
      },
    });
  }, [healthCheck]);

  // Eight at a time: a health check is a small probe, so a wider batch finishes
  // the list without flooding the endpoints the way an unbounded fan-out would.
  const runAllChecks = async () => {
    const targets = pools;
    if (targets.length === 0) return;
    let healthy = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await healthCheck.mutateAsync(pool.id);
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
          if (result.status === "healthy") healthy += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          const result: HealthCheckResult = {
            poolId: pool.id,
            status: "timeout",
            errorMessage: getErrorMessage(err, "Health check failed"),
          };
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
        } finally {
          setTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));
    toast.success(`Tested ${targets.length} pools · ${healthy} healthy · ${failed} failed`);
  };

  /**
   * The same bounded health check as `runAllChecks`, restricted to the current
   * selection. The selected row is the operator's "test this one first" intent;
   * without it the only way to test a subset was to select everything else and
   * use Test all.
   */
  const runTestSelected = async () => {
    const targets = pools.filter((pool) => selectedIds.has(pool.id));
    if (targets.length === 0) return;
    let healthy = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await healthCheck.mutateAsync(pool.id);
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
          if (result.status === "healthy") healthy += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          const result: HealthCheckResult = {
            poolId: pool.id,
            status: "timeout",
            errorMessage: getErrorMessage(err, "Health check failed"),
          };
          setCheckResults((prev) => ({ ...prev, [pool.id]: result }));
        } finally {
          setTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));
    toast.success(`Tested ${targets.length} pools · ${healthy} healthy · ${failed} failed`);
  };

  /**
   * Asks OpenCode, through each selected pool, whether it will serve us.
   *
   * Bounded like the health check but narrower: each probe opens a tunnel and
   * a TLS session to the provider, so four at a time finishes a selection
   * without the fan-out reading as an outage upstream.
   *
   * Read-only. The probe reports what it saw and leaves the pool in rotation;
   * a real dispatch that is refused is what retires the egress. An operator
   * testing a proxy wants to know its state, not to change it — and a probe
   * that mutated would make "test" unsafe to press.
   */
  const runProviderProbeSelected = async () => {
    const targets = pools.filter((pool) => selectedIds.has(pool.id));
    if (targets.length === 0) return;
    let allowed = 0;
    let blocked = 0;
    let throttled = 0;
    let unreachable = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setProviderTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await providerProbe.mutateAsync({
            poolId: pool.id,
            providerId: PROBE_PROVIDER_ID,
          });
          setProviderResults((prev) => ({
            ...prev,
            [pool.id]: { endpoint: pool.endpoint ?? "", result },
          }));
          if (result.status === "allowed") allowed += 1;
          else if (result.status === "blocked") blocked += 1;
          else if (result.status === "throttled") throttled += 1;
          else unreachable += 1;
        } catch (err) {
          unreachable += 1;
          setProviderResults((prev) => ({
            ...prev,
            [pool.id]: {
              endpoint: pool.endpoint ?? "",
              result: {
                poolId: pool.id,
                providerId: PROBE_PROVIDER_ID,
                status: "unreachable",
                reason: getErrorMessage(err, "Provider probe failed"),
              },
            },
          }));
        } finally {
          setProviderTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROVIDER_PROBE_CONCURRENCY, targets.length) }, () => worker()),
    );
    toast.success(
      `OpenCode: ${allowed} allowed · ${blocked} blocked` +
        (throttled > 0 ? ` · ${throttled} rate-limited` : "") +
        (unreachable > 0 ? ` · ${unreachable} unreachable` : ""),
    );
  };

  // One at a time. Each test pulls several megabytes, and two running together
  // share the operator's uplink, so neither number is the pool's real speed.
  const runSpeedTestSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setSpeedTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await speedTest.mutateAsync({ poolId: pool.id, bytes: speedBytes });
          rememberSpeedResult(pool.id, result);
        } catch (err) {
          rememberSpeedResult(pool.id, {
            poolId: pool.id,
            status: "failed",
            bytes: 0,
            durationMs: 0,
            errorMessage: getErrorMessage(err, "Speed test failed"),
          });
        } finally {
          setSpeedTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await worker();
    toast.success(`Speed tested ${targets.length} pool(s)`);
  };

  const enableSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    await setPoolStatusBatch.mutateAsync({
      ids: targets.map((p) => p.id),
      status: "active",
    });
    setSelectedIds(new Set());
    toast.success(`Enabled ${targets.length} pool(s)`);
  };

  const disableSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    await setPoolStatusBatch.mutateAsync({
      ids: targets.map((p) => p.id),
      status: "disabled",
    });
    setSelectedIds(new Set());
    toast.success(`Disabled ${targets.length} pool(s)`);
  };

  const exportSelected = () => {
    const targets = selectedIds.size > 0 ? pools.filter((p) => selectedIds.has(p.id)) : pools;
    if (targets.length === 0) return;
    const content = targets.map((p) => poolDisplay(p).endpoint || p.endpoint).join("\n");
    downloadTextFile("cartethyia-proxies.txt", content, "text/plain;charset=utf-8");
    toast.success(`Exported ${targets.length} pool(s)`);
  };

  const requestDeletePool = useCallback(
    (id: string) => {
      const pool = pools.find((p) => p.id === id);
      if (pool) setDeleteTargets([pool]);
    },
    [pools],
  );

  const requestDeleteSelected = () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    setDeleteTargets(targets);
  };

  const confirmDelete = async () => {
    if (!deleteTargets) return;
    await deletePoolBatch.mutateAsync(deleteTargets.map((p) => p.id));
    setSelectedIds(new Set());
    toast.success(`Deleted ${deleteTargets.length} pool(s)`);
    setDeleteTargets(null);
  };

  return (
    <ProxyLiveProvider>
      <Stack gap="16px">
      <Dialog
        open={showProxyForm}
        onClose={closeAddProxy}
        title="Add Proxy"
        footer={addProxyActions}
      >
        <ProxyBulkForm
          onClose={closeAddProxy}
          actionsRef={setAddProxyActions}
          onProbeResult={(poolId, result) => {
            // The row may not exist in this list yet (the add form reports
            // before the refetch lands), so the endpoint is read from the
            // payload the probe itself carried rather than from `pools`.
            const created = pools.find((entry) => entry.id === poolId);
            setProviderResults((prev) => ({
              ...prev,
              [poolId]: { endpoint: created?.endpoint ?? "", result },
            }));
          }}
          onHealthResult={(poolId, result) => {
            setCheckResults((prev) => ({ ...prev, [poolId]: result }));
          }}
        />
      </Dialog>

      <Dialog
        open={editingPool !== null}
        onClose={() => setEditingPool(null)}
        title="Edit pool"
        footer={editProxyActions}
      >
        {editingPool && (
          <PoolEditForm
            key={editingPool.id}
            pool={editingPool}
            onClose={() => setEditingPool(null)}
            actionsRef={setEditProxyActions}
          />
        )}
      </Dialog>

      <Card
        style={pools.length === 0 && !isPending && !isError ? { minHeight: "min(78dvh, calc(100dvh - 160px))", display: "flex", flexDirection: "column" } : undefined}
      >
        <CardHeader
          title="Proxy Pool"
          subtitle="Outbound proxy servers — HTTP, HTTPS, and SOCKS5"
          icon={<ShieldCheck size={16} />}
          action={
            <Inline gap="8px">
              {poolRuleLabel ? (
                <Badge tone="accent" title="Proxy pool selection mode">
                  Pool routing: {poolRuleLabel}
                </Badge>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                icon={<Cloud size={13} />}
                onClick={() => setShowRelayDeploy(true)}
              >
                Deploy relay
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setShowProxyForm(true)}
              >
                Add proxies
              </Button>
            </Inline>
          }
        />
        <CardBody
          style={pools.length === 0 && !isPending && !isError ? { flex: 1, display: "flex", flexDirection: "column", gap: "16px" } : undefined}
        >
          <ProxySummaryTiles pools={pools} />

          {/* Selection & Batch Toolbar (Image 2 style) */}
          {pools.length > 0 && (
            <div className="nested-panel flex flex-wrap items-center justify-start overflow-x-auto rounded-card border border-inner-border bg-surface-2 p-4 text-badge">
              <div className="flex flex-wrap items-center gap-5">
                <label
                  className="flex items-center gap-3 cursor-pointer text-text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all proxies"
                  />
                  Select all
                  {selectedIds.size > 0 && (
                    <span className="text-text-tertiary">({selectedIds.size})</span>
                  )}
                </label>
                {testedCount > 0 && (
                  <Inline gap="6px">
                    <span className="text-text-tertiary">
                      Tested {testedCount}/{pools.length}
                    </span>
                    {successCount > 0 && <Badge tone="ok">{successCount} success</Badge>}
                    {errorCount > 0 && <Badge tone="err">{errorCount} errors</Badge>}
                  </Inline>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={maskValues ? <EyeOff size={12} /> : <Eye size={12} />}
                  onClick={() => privacy.setEnabled(!maskValues)}
                  title={maskValues ? "Show proxy names and addresses" : "Hide proxy names and addresses"}
                >
                  {maskValues ? "Unmask" : "Mask"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={maskIp ? <EyeOff size={12} /> : <Eye size={12} />}
                  onClick={() => ipMask.setEnabled(!maskIp)}
                  title={maskIp ? "Show egress addresses" : "Hide egress addresses"}
                >
                  {maskIp ? "Show IP" : "Mask IP"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={testingIds.size > 0 || pools.length === 0}
                  icon={
                    testingIds.size > 0 ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <FlaskConical size={12} />
                    )
                  }
                  onClick={() => void runAllChecks()}
                >
                  Test all
                </Button>
                {/* Split control: the primary half runs the payload the
                    dropdown selects against the current selection. Test all
                    stays outside this control because it deliberately ignores
                    the selection. */}
                <div className="inline-flex items-stretch h-15">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-tr-none rounded-br-none"
                    disabled={
                      testingIds.size > 0 ||
                      providerTestingIds.size > 0 ||
                      selectedIds.size === 0
                    }
                    icon={
                      testingIds.size > 0 || providerTestingIds.size > 0 ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <FlaskConical size={12} />
                      )
                    }
                    onClick={() =>
                      void (testPayload === "opencode"
                        ? runProviderProbeSelected()
                        : runTestSelected())
                    }
                  >
                    {testPayload === "opencode" ? "Test OpenCode" : "Test URL"}
                  </Button>
                  <Select
                    aria-label="Test payload"
                    value={testPayload}
                    onValueChange={(value) => setTestPayload(value as TestPayload)}
                    options={TEST_PAYLOAD_OPTIONS}
                    disabled={testingIds.size > 0 || providerTestingIds.size > 0}
                    className="w-auto min-w-38 h-15 rounded-tl-none rounded-bl-none -ml-0.5"
                  />
                </div>
                {/* Split control: the primary half runs the test at the
                    currently-selected payload, the chevron half picks the
                    payload. Kept as two elements in one bordered shell so it
                    reads as a single control without a bespoke component. */}
                <div
                  className="inline-flex items-stretch h-15"
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-tr-none rounded-br-none"
                    disabled={
                      selectedIds.size === 0 || speedTestingIds.size > 0 || speedTest.isPending
                    }
                    icon={
                      speedTestingIds.size > 0 ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Gauge size={12} />
                      )
                    }
                    onClick={() => void runSpeedTestSelected()}
                  >
                    Speedtest selected
                  </Button>
                  <Select
                    aria-label="Speed test payload size"
                    value={String(speedBytes)}
                    onValueChange={(value) => setSpeedBytes(Number(value))}
                    options={SPEED_TEST_SIZES}
                    disabled={speedTestingIds.size > 0 || speedTest.isPending}
                    className="w-auto min-w-38 h-15 rounded-tl-none rounded-bl-none -ml-0.5"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pools.length === 0}
                  icon={<Download size={12} />}
                  onClick={exportSelected}
                >
                  Export
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selectedIds.size === 0 || updatePool.isPending}
                  icon={<Power size={12} />}
                  onClick={() => void enableSelected()}
                >
                  Enable selected
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selectedIds.size === 0 || updatePool.isPending}
                  icon={<PowerOff size={12} />}
                  onClick={() => void disableSelected()}
                >
                  Disable selected
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={selectedIds.size === 0 || deletePool.isPending}
                  icon={<Trash2 size={12} />}
                  onClick={requestDeleteSelected}
                >
                  Delete selected
                </Button>
              </div>
            </div>
          )}

          {isPending && <LoadingState />}
          {isError && <ErrorState title="Error" message="Failed to load network pools" />}
          {!isPending && !isError && pools.length === 0 && (
            <div className="flex-1 flex items-center justify-center p-12 border border-dashed border-transparent rounded-card bg-transparent text-center">
              <EmptyState
                title="No proxy pools configured"
                message="The summary above is empty because nothing is routing yet. Use Add proxies or Deploy relay in the header to start one."
              />
            </div>
          )}
          {!isPending && !isError && pools.length > 0 && (
            <div className="proxy-table-scroll rounded-control border border-inner-border bg-surface-1">
              <DataTable
                maxHeight={460}
                scrollRegion
                headers={[
                  "",
                  { key: "name", label: "Proxy", sortable: true },
                  { key: "family", label: "Family", sortable: true },
                  { key: "address", label: "Address", sortable: true },
                  { key: "load", label: "Load", sortable: true },
                  "Actions",
                ]}
                sortKey={sort.key}
                sortDirection={sort.direction}
                onSort={toggleSort}
              >
                {sortedPools.map((pool) => (
                  <PoolRow
                    key={pool.id}
                    pool={pool}
                    isSelected={selectedIds.has(pool.id)}
                    onToggleSelect={toggleSelectOne}
                    checkResult={checkResults[pool.id]}
                    probe={
                      // The row's own verdict wins: it is the one every reader
                      // shares and the one a reload keeps. The local map only
                      // covers the gap before the refetch lands.
                      pool.providerProbe !== undefined
                        ? {
                            poolId: pool.id,
                            providerId: pool.providerProbe.providerId,
                            status: pool.providerProbe.status,
                            ...(pool.providerProbe.httpStatus === undefined
                              ? {}
                              : { httpStatus: pool.providerProbe.httpStatus }),
                            ...(pool.providerProbe.reason === undefined
                              ? {}
                              : { reason: pool.providerProbe.reason }),
                            ...(pool.providerProbe.latencyMs === undefined
                              ? {}
                              : { latencyMs: pool.providerProbe.latencyMs }),
                          }
                        : liveProbeFor(providerResults[pool.id], pool.endpoint)
                    }
                    isTesting={testingIds.has(pool.id)}
                    onDelete={requestDeletePool}
                    onEdit={setEditingPool}
                    onHealthCheck={runCheck}
                    onActivity={setActivityPool}
                    speedResult={newerSpeedResult(speedResults[pool.id], serverSpeedResult(pool))}
                    isSpeedTesting={speedTestingIds.has(pool.id)}
                    maskValues={maskValues}
                    maskIp={maskIp}
                  />
                ))}
              </DataTable>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={deleteTargets !== null}
        onClose={() => setDeleteTargets(null)}
        onConfirm={confirmDelete}
        title="Delete proxy pool?"
        message={
          deleteTargets && deleteTargets.length === 1
            ? `Delete "${poolName(deleteTargets[0]!)}"? This cannot be undone.`
            : deleteTargets
              ? `Delete ${deleteTargets.length} proxy pools? This cannot be undone.`
              : "Delete this proxy pool? This cannot be undone."
        }
        confirmLabel="Delete"
        danger
      />
      {activityPool ? (
        <PoolHealthDialog pool={activityPool} onClose={() => setActivityPool(null)} />
      ) : null}
      {showRelayDeploy ? <RelayDeployModal onClose={() => setShowRelayDeploy(false)} /> : null}
      </Stack>
    </ProxyLiveProvider>
  );
}
