import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, Eye, EyeOff, Radio } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { DataTable } from "../../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { useMaskIp } from "../../lib/privacy-mode";
import { useProviders } from "../../hooks/providers";
import { useUsageRequests, useUsageSummary } from "../../hooks/system";
import {
  DEFAULT_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
} from "../../lib/format/tokens";
import {
  asDimension,
  asMetric,
  asPeriod,
  asTokenScale,
  usageHeadline,
} from "./sections/formatters";
import { periodLabel, PeriodSelector } from "./sections/period-selector";
import { ChartPanel } from "./sections/chart-panel";
import { PanelKey, PanelWidthToggle, PillTabs } from "./sections/controls";
import { StatusFilters } from "./sections/status";
import { InFlightProvider, LiveInFlightPill } from "./sections/in-flight";
import { SummaryMetricCards } from "./sections/summary-cards";
import { BreakdownSnapshot } from "./sections/breakdown-snapshot";
import { RequestDetailDrawer } from "./sections/request-detail-drawer";
import { RequestRow, RoutingLatencyBar } from "./sections/requests-table";

export { formatCredit, surfaceFamilyLabel, formatAgo } from "./sections/formatters";

/**
 * Returns `current` with one parameter set, leaving every other parameter
 * untouched.
 *
 * The page re-renders on its own every 10s (four queries carry
 * `refetchInterval`), so a handler that built its `URLSearchParams` from the
 * `searchParams` of an earlier render could write that stale snapshot back and
 * silently revert a sibling parameter — the "breakdown tab will not switch"
 * symptom, where a click set `dim` and a concurrent update from an older
 * closure restored the previous value.
 *
 * React Router 7's `setSearchParams` accepts a functional updater that reads
 * the *current* params, so the snapshot never goes stale. This helper is the
 * pure core of that updater, kept separate so it can be tested directly.
 */
export function withParam(
  current: URLSearchParams,
  key: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set(key, value);
  return next;
}

/**
 * Returns `set` with `key` flipped: removed when present, added when absent.
 *
 * Backs the per-panel collapse and widen toggles. Kept pure and separate from
 * the component so the transition can be tested without a DOM.
 */
export function toggleInSet<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function Usage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = asPeriod(searchParams.get("period"));
  const metric = asMetric(searchParams.get("metric"));
  const dimension = asDimension(searchParams.get("dim"));
  const tokenScale = asTokenScale(searchParams.get("scale"));
  // Per-panel presentation state. Deliberately not in the URL: a widened panel
  // is a local reading preference, and putting it in the query string would
  // make every toggle a navigation.
  const [widePanels, setWidePanels] = useState<ReadonlySet<PanelKey>>(() => new Set());
  const togglePanel = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<PanelKey>>>,
    key: PanelKey,
  ) => {
    setter((prev) => toggleInSet(prev, key));
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Client IPs on the request rows follow the same privacy switch as the proxy
  // page's egress addresses.
  const { enabled: maskIpEnabled, setEnabled: setMaskIpEnabled } = useMaskIp();
  const [hideProviderName, setHideProviderName] = useState(() => {
    try {
      return localStorage.getItem("cartethyia:usage:hide-provider") === "true";
    } catch {
      return false;
    }
  });
  const toggleHideProviderName = () => {
    setHideProviderName((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("cartethyia:usage:hide-provider", String(next));
      } catch {}
      return next;
    });
  };
  /**
   * The model the upstream reported is always shown beside the one we asked
   * for when they differ: it is evidence, not a diagnostic to hide.
   */
  const summaryQuery = useUsageSummary(period);
  const providersQuery = useProviders();
  const providerNames = useMemo(
    () => new Map((providersQuery.data ?? []).map((provider) => [provider.providerId, provider.label || provider.displayName])),
    [providersQuery.data],
  );
  const [requestLimit, setRequestLimit] = useState(50);
  const [requestStatusFilter, setRequestStatusFilter] = useState<number | null>(null);
  const requestsQuery = useUsageRequests(period, requestLimit, requestStatusFilter);
  /** Scroll offset of the Requests table, restored after each live refresh. */
  const requestsScrollTopRef = useRef(0);
  const [requestSortKey, setRequestSortKey] = useState<"startedAt" | "model" | "status" | "tokens" | "tps" | "ttft" | "duration">("startedAt");
  const [requestSortDirection, setRequestSortDirection] = useState<"asc" | "desc">("desc");
  const toggleRequestSort = (key: typeof requestSortKey): void => {
    setRequestSortKey((current) => {
      if (current !== key) {
        setRequestSortDirection(key === "model" ? "asc" : "desc");
        return key;
      }
      setRequestSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return current;
    });
  };
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [newRowIds, setNewRowIds] = useState<Set<string>>(new Set());

  // Detect newly arrived requests and briefly highlight them
  useEffect(() => {
    const items = requestsQuery.data?.items ?? [];
    if (items.length === 0) return;
    const seen = seenIdsRef.current;
    if (seen.size === 0) {
      // First load: seed without highlighting
      for (const item of items) seen.add(item.requestId);
      return;
    }
    const fresh = new Set<string>();
    for (const item of items) {
      if (!seen.has(item.requestId)) {
        seen.add(item.requestId);
        fresh.add(item.requestId);
      }
    }
    if (fresh.size > 0) {
      setNewRowIds((prev) => new Set([...prev, ...fresh]));
      const timer = window.setTimeout(() => {
        setNewRowIds((current) => {
          const next = new Set(current);
          for (const id of fresh) next.delete(id);
          return next;
        });
      }, 3000);
      return () => window.clearTimeout(timer);
    }
  }, [requestsQuery.data?.items]);

  const handleTableScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    // Recorded on every scroll so a live poll that replaces the rows can put
    // the operator back where they were. `requestItems` is keyed by request id,
    // so a refetch remounts the rows and the browser resets scrollTop to 0.
    requestsScrollTopRef.current = target.scrollTop;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 40) {
      if (!requestsQuery.isFetching && requestItems.length >= requestLimit && requestLimit < 500) {
        setRequestLimit((prev) => prev + 50);
      }
    }
  };
  const summary = summaryQuery.data?.totals;
  const requestItems = useMemo(() => {
    const items = [...(requestsQuery.data?.items ?? [])];
    const direction = requestSortDirection === "asc" ? 1 : -1;
    const numeric = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : -1);
    items.sort((left, right) => {
      switch (requestSortKey) {
        case "model":
          return `${left.providerId ?? ""}/${left.model ?? ""}`.localeCompare(`${right.providerId ?? ""}/${right.model ?? ""}`) * direction
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "status":
          return ((left.httpStatus ?? 0) - (right.httpStatus ?? 0)) * direction
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "tokens":
          return (((left.totalTokens ?? 0) - (right.totalTokens ?? 0)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "tps":
          return ((numeric(left.tokensPerSec) - numeric(right.tokensPerSec)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "ttft":
          return ((numeric(left.ttfbMs) - numeric(right.ttfbMs)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "duration":
          return ((numeric(left.durationMs) - numeric(right.durationMs)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "startedAt":
        default:
          return left.startedAt.localeCompare(right.startedAt) * direction;
      }
    });
    return items;
  }, [requestsQuery.data?.items, requestSortKey, requestSortDirection]);

  /**
   * Puts the Requests table back at the offset it was scrolled to.
   *
   * The rows are keyed by request id, so a live poll that swaps the data
   * replaces the `<tr>` elements and the browser resets the scroll container to
   * 0 — the operator is thrown back to the newest row mid-read. Restore only
   * when the row count changed, so an ordinary re-render with the same rows
   * never fights the user's own scrolling. A deliberate reset (status filter,
   * period change) clears the offset first via `resetRequestsScroll`.
   */
  useLayoutEffect(() => {
    const scroller = document.getElementById("usage-requests-scroll");
    if (scroller === null) return;
    const target = Math.min(requestsScrollTopRef.current, scroller.scrollHeight);
    scroller.scrollTop = target;
  }, [requestItems.length]);

  const resetRequestsScroll = () => {
    requestsScrollTopRef.current = 0;
  };
  const toggleRequestStatus = (status: number): void => {
    resetRequestsScroll();
    setRequestLimit(50);
    setRequestStatusFilter((current) => (current === status ? null : status));
  };

  const setParam = (key: string, value: string) => {
    setSearchParams((current) => withParam(current, key, value), { replace: true });
  };
  const setTokenScale = (next: number) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === DEFAULT_TOKEN_SCALE) params.delete("scale");
        else if (next === TOKEN_SCALE_AUTO) params.set("scale", "auto");
        else params.set("scale", String(next));
        return params;
      },
      { replace: true },
    );
  };

  return (
    <InFlightProvider>
      <Stack gap="16px">
      <Card>
        <CardHeader
          title="Usage"
          subtitle={usageHeadline(period, summaryQuery.isPending, summary)}
          icon={<Activity size={16} />}
        />
        <CardBody className="flex flex-col gap-8">
      <SummaryMetricCards
        pending={summaryQuery.isPending}
        summary={summary}
        tokenScale={tokenScale}
        onTokenScaleChange={setTokenScale}
      />

      <div className="grid grid-cols-2 gap-8 w-full min-w-0 max-medium:grid-cols-1">

        <BreakdownSnapshot
          period={period}
          dimension={dimension}
          onDimensionChange={(value) => setParam("dim", value)}
          wide={widePanels.has("breakdown")}
          onToggleWide={() => togglePanel(setWidePanels, "breakdown")}
        />
        <Card
          className={widePanels.has("traffic") ? "col-span-full" : ""}
        >
          <CardHeader
            title="Traffic"
            subtitle={`Requests per bucket · ${periodLabel(period)}`}
            icon={<Radio size={16} />}
            leading={
              <PanelWidthToggle
                label="Traffic"
                wide={widePanels.has("traffic")}
                onToggleWide={() => togglePanel(setWidePanels, "traffic")}
              />
            }
            action={
              <Inline gap="6px" className="flex-wrap">
                <PillTabs
                  ariaLabel="Traffic metric"
                  value={metric}
                  onChange={(value) => setParam("metric", value)}
                  options={[
                    { id: "requests", label: "Requests" },
                    { id: "tokens", label: "Tokens" },
                    { id: "cached", label: "Cached" },
                  ]}
                />
                <PeriodSelector
                  value={period}
                  onChange={(value) => setParam("period", value)}
                />
              </Inline>
            }
          />
          <CardBody>
            <ChartPanel period={period} metric={metric} />
          </CardBody>
        </Card>
      </div>

        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Requests"
          subtitle={`Most recent first · ${requestItems.length} entries · open a row to inspect`}
          subtitleAddon={
            <StatusFilters
              counts={summary?.statusCounts ?? []}
              active={requestStatusFilter}
              onToggle={toggleRequestStatus}
            />
          }
          icon={<Activity size={16} />}
          action={
            <Inline gap="12px" align="center" className="flex-wrap">
              <Button
                variant="ghost"
                size="sm"
                icon={hideProviderName ? <EyeOff size={13} /> : <Eye size={13} />}
                onClick={toggleHideProviderName}
                title={hideProviderName ? "Show real provider names" : "Mask provider names as Mysterious"}
                className="text-badge h-13 px-4 py-0 text-text-secondary"
              >
                {hideProviderName ? "Provider masked" : "Mask provider"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={maskIpEnabled ? <EyeOff size={13} /> : <Eye size={13} />}
                onClick={() => setMaskIpEnabled(!maskIpEnabled)}
                title={maskIpEnabled ? "Show client addresses" : "Hide client addresses"}
                className="text-badge h-13 px-4 py-0 text-text-secondary"
              >
                {maskIpEnabled ? "IP masked" : "Mask IP"}
              </Button>
              <LiveInFlightPill />
            </Inline>
          }
        />
        <CardBody className="p-0">
          {/* `compact`: these sit in a card body, not a route, so they must not
              reserve the route-level 220px centering floor on top of the card's
              own padding. */}
          {requestsQuery.isPending && requestItems.length === 0 ? (
            <LoadingState compact label="Loading requests…" />
          ) : requestsQuery.isError && requestItems.length === 0 ? (
            <ErrorState compact message="Could not load recent requests." onRetry={() => void requestsQuery.refetch()} />
          ) : requestItems.length === 0 ? (
            <EmptyState
              compact
              title="No requests recorded for this period"
              message="Route requests through the gateway to populate the table."
              icon={<Activity size={20} />}
            />
          ) : (
            <div id="usage-requests-scroll" className="rounded-control border border-inner-border bg-surface-1">
              <RoutingLatencyBar
                pending={summaryQuery.isPending}
                avgMs={summary?.avgResolveMs}
                p50Ms={summary?.latencyP50Ms}
                p95Ms={summary?.latencyP95Ms}
                p99Ms={summary?.latencyP99Ms}
                latencySampleCount={summary?.latencySampleCount}
                resolveSampleCount={summary?.resolveSampleCount}
                periodLabel={periodLabel(period)}
              />
              <DataTable
                maxHeight={445}
                onScroll={handleTableScroll}
                headers={[
                  { key: "startedAt", label: "Time", sortable: true },
                  { key: "model", label: "Provider/model", sortable: true },
                  { key: "apiKey", label: "API Key" },
                  { key: "status", label: "Status", sortable: true },
                  { key: "tokens", label: "Tokens", sortable: true },
                  { key: "tps", label: "TPS", sortable: true },
                  { key: "ttft", label: "TTFT", sortable: true },
                  { key: "duration", label: "Done", sortable: true },
                ]}
                sortKey={requestSortKey}
                sortDirection={requestSortDirection}
                onSort={(key) => toggleRequestSort(key as typeof requestSortKey)}
              >
                {requestItems.map((row) => (
                  <RequestRow
                    key={row.requestId}
                    row={row}
                    hideProviderName={hideProviderName}
                    maskIpEnabled={maskIpEnabled}
                    providerNames={providerNames}
                    isNew={newRowIds.has(row.requestId)}
                    onSelect={() => setSelectedId(row.requestId)}
                  />
                ))}
              </DataTable>
            </div>
          )}
        </CardBody>
      </Card>

      <RequestDetailDrawer requestId={selectedId} onClose={() => setSelectedId(null)} />
      </Stack>
    </InFlightProvider>
  );
}
