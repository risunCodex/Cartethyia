import { consoleRequest, fetchSessionUser } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import { queryKeys } from "../data/query-keys";
import type { SessionUser, UsageDimension } from "../data/contracts";
import { assertAuditListPage, assertLatestRelease, assertSystemHealth, assertUsageBy, assertUsageChart, assertUsageRequestDetail, assertUsageRequests, assertUsageSummary, querySignal } from "../data/assert";
import { DASHBOARD_QUERY_OPTIONS, POLL } from "../data/query-policy";
import { GITHUB_RELEASES_URL } from "../lib/links";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useConsoleEventSource } from "./use-console-event-source";

export interface NotificationItem {
  readonly id: string;
  readonly kind: "memory-high" | "memory-growth" | "update-available";
  readonly title: string;
  readonly message: string;
  readonly createdAt: string;
  readonly level: "warning" | "info";
  readonly href?: string;
  /** Release tag behind an `update-available` alert (`v` prefix stripped). */
  readonly version?: string;
}

const NOTIFICATION_MAX_ITEMS = 20;

function readNotification(value: unknown): NotificationItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.title !== "string" ||
    typeof item.message !== "string" ||
    typeof item.createdAt !== "string" ||
    (item.kind !== "memory-high" && item.kind !== "memory-growth" && item.kind !== "update-available") ||
    (item.level !== "warning" && item.level !== "info")
  ) return undefined;
  const notification: NotificationItem = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    message: item.message,
    createdAt: item.createdAt,
    level: item.level,
    // Only the project's own release URL is trustworthy enough to render as a
    // link; anything else a notification might carry is shown as plain text.
    // Compared against the shared constant, not a literal: a rename would
    // otherwise silently stop matching and strip the link from every
    // update-available notification.
    ...(item.href === GITHUB_RELEASES_URL ? { href: item.href } : {}),
    ...(typeof item.version === "string" && item.version.length > 0
      ? { version: item.version.replace(/^v/, "") }
      : {}),
  };
  return notification;
}

/** Streams server-generated memory and release alerts without blocking shell rendering. */
export function useNotifications(): readonly NotificationItem[] {
  const [notifications, setNotifications] = useState<readonly NotificationItem[]>([]);

  useConsoleEventSource({
    url: "/console/api/notifications/stream",
    events: ["notification"],
    onEvent: (event, data) => {
      if (event !== "notification") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const notification = readNotification(parsed);
      if (!notification) return;
      setNotifications((current) => [
        notification,
        ...current.filter((item) => item.id !== notification.id),
      ].slice(0, NOTIFICATION_MAX_ITEMS));
    },
  });

  return notifications;
}

/** Loads the current signed-in console user, including `isPlatformAdmin`,
 * so pages can hide (never solely rely on hiding — the server remains the
 * real enforcement) controls the user's scope cannot use. */
export function useSessionUser() {
  return useQuery<SessionUser | null>({
    queryKey: queryKeys.session.current,
    queryFn: () => fetchSessionUser(),
    staleTime: 60_000,
    gcTime: 300_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Loads current system health; refreshes only while the caller asks it to.
 * Defaults to a single fetch that is cached by react-query — the shell reads
 * the version from the same cache, and a consumer that wants live readings
 * (the notifications popover) passes `refetchInterval` while it is open. */
export function useSystemHealth(options?: { enabled?: boolean; refetchInterval?: number | false }) {
  return useQuery({
    queryKey: queryKeys.system.health,
    queryFn: (context) =>
      consoleRequest<unknown>("/system/health", { signal: querySignal(context) }).then(
        assertSystemHealth,
      ),
    ...DASHBOARD_QUERY_OPTIONS,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * Loads the latest public GitHub release, or `null` when none is known.
 *
 * Proxied through the console API rather than fetched from the browser, so a
 * GitHub outage or rate limit is not one operator's console error. This is the
 * **cold-start fallback** only: the notifications stream is the primary
 * `update-available` badge/dialog source. The fetch runs once on mount (and
 * again when the query is invalidated) and is never polled — a release is
 * published rarely, and the live stream announces it when it appears.
 */
export function useLatestRelease() {
  return useQuery({
    queryKey: queryKeys.releases.githubLatest,
    queryFn: (context) =>
      consoleRequest<unknown>("/updates/release", { signal: querySignal(context) }).then(
        assertLatestRelease,
      ),
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** Loads the 20-beta-style usage summary for a period. */
export function useUsageSummary(period: string) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.summary(period),
    queryFn: (context) =>
      consoleRequest<unknown>(`/system/usage/summary?period=${encodeURIComponent(period)}`, {
        signal: querySignal(context),
      }).then(assertUsageSummary),
    ...DASHBOARD_QUERY_OPTIONS,
    refetchInterval: POLL.status,
  });
}

/** Loads time-series buckets for the traffic chart. */
export function useUsageChart(period: string) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.chart(period),
    queryFn: (context) =>
      consoleRequest<unknown>(`/system/usage/chart?period=${encodeURIComponent(period)}`, {
        signal: querySignal(context),
      }).then(assertUsageChart),
    ...DASHBOARD_QUERY_OPTIONS,
    refetchInterval: POLL.status,
  });
}

/** Loads one usage breakdown dimension (see `USAGE_DIMENSIONS`). */
export function useUsageBy(period: string, dimension: UsageDimension) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.by(period, dimension),
    queryFn: (context) =>
      consoleRequest<unknown>(
        `/system/usage/by-${dimension}?period=${encodeURIComponent(period)}`,
        { signal: querySignal(context) },
      ).then(assertUsageBy),
    ...DASHBOARD_QUERY_OPTIONS,
    refetchInterval: POLL.status,
  });
}

/** Loads the most recent requests for the live table. */
export function useUsageRequests(
  period: string,
  limit = 50,
  httpStatus?: number | null,
) {
  const statusParam = httpStatus === null || httpStatus === undefined
    ? ""
    : `&httpStatus=${encodeURIComponent(String(httpStatus))}`;
  return useQuery({
    queryKey: queryKeys.usageAnalytics.requests(period, limit, httpStatus),
    queryFn: (context) =>
      consoleRequest<unknown>(
        `/system/usage/requests?period=${encodeURIComponent(period)}&limit=${encodeURIComponent(String(limit))}${statusParam}`,
        { signal: querySignal(context) },
      ).then(assertUsageRequests),
    ...DASHBOARD_QUERY_OPTIONS,
    // Keep the previous page's rows visible while a larger `limit` loads. The
    // key includes the limit, so without this a scroll-triggered page bump is
    // treated as a brand-new query with no data: the table empties, the scroll
    // container collapses, and the operator is thrown back to the top.
    placeholderData: (previous) => previous,
    refetchInterval: POLL.live,
  });
}

/** Loads one request's detail for the inspector dialog. */
export function useUsageRequestDetail(requestId: string | null) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.requestDetail(requestId ?? "_"),
    queryFn: (context) => {
      if (!requestId) throw { status: 400, code: "invalid_request", message: "Request is required" } satisfies ApiErrorShape;
      return consoleRequest<unknown>(`/system/usage/requests/${encodeURIComponent(requestId)}`, {
        signal: querySignal(context),
      }).then(assertUsageRequestDetail);
    },
    enabled: requestId !== null,
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

export function useAuditTrail(filters?: {
  action?: string;
  actor?: string;
  cursor?: string;
  limit?: number;
}) {
  return useQuery({
    queryKey: queryKeys.audit.list(filters ?? {}),
    queryFn: (context) => {
      const search = new URLSearchParams();
      if (filters?.action) search.set("action", filters.action);
      if (filters?.actor) search.set("actor", filters.actor);
      if (filters?.cursor) search.set("cursor", filters.cursor);
      if (filters?.limit) search.set("limit", String(filters.limit));
      const suffix = search.toString() ? `?${search.toString()}` : "";
      return consoleRequest<unknown>(`/audit${suffix}`, { signal: querySignal(context) }).then(
        assertAuditListPage,
      );
    },
    ...DASHBOARD_QUERY_OPTIONS,
  });
}
