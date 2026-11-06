import type { QueryFunctionContext } from "@tanstack/react-query";
import { isRecord } from "./api";
import { USAGE_DIMENSIONS } from "./contracts";
import type { ApiErrorShape } from "./api";
import type {
  ApiKeyResponse,
  AuditEntry,
  AuditListPage,

  ModelAliasRow,
  ModelCatalogEntry,
  DiscoverModelCandidate,
  DiscoverModelsResponse,
  ModelComboRow,
  ModelWarning,
  NetworkPoolResponse,
  PoolStrategySetting,
  ProviderResponse,
  ProviderRoutingResponse,
  SystemHealthResponse,
  LatestRelease,
  UsageByResponse,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestsResponse,
  UsageSummaryResponse,
} from "./contracts";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalidResponse(message: string): ApiErrorShape {
  return { status: 500, code: "invalid_response", message };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates the latest-release payload. `null` is a valid answer — it means no
 * release is known, which is what the server returns when GitHub is unreachable
 * — so an absent badge, not an error, is what the operator sees.
 */
export function assertLatestRelease(value: unknown): LatestRelease | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.tag_name !== "string" ||
    typeof value.html_url !== "string"
  ) {
    throw invalidResponse("Invalid release response");
  }
  return { tag_name: value.tag_name, html_url: value.html_url };
}

export function assertSystemHealth(value: unknown): SystemHealthResponse {
  if (!isRecord(value) || !["healthy", "degraded", "unhealthy"].includes(value.status as string)) {
    throw invalidResponse("Invalid system health response");
  }
  const numericFields = [
    "uptime_seconds",
    "memory_bytes",
    "memory_heap_bytes",
    "memory_external_bytes",
    "memory_percent",
    "request_count",
    "error_count",
    "latency_avg_ms",
    "latency_p95_ms",
    "latency_p99_ms",
  ];
  // `cpu_percent` is deliberately absent from that list: there is no `loadavg`
  // on Windows, so the backend reports `null` there. Validating it as a number
  // made the whole health payload invalid on Windows — every tile then read
  // "Unavailable" because of one metric the platform cannot supply. It is
  // checked as nullable separately below.
  if (
    !numericFields.every((field) => isFiniteNumber(value[field])) ||
    typeof value.database_healthy !== "boolean" ||
    typeof value.redis_healthy !== "boolean" ||
    typeof value.redis_configured !== "boolean" ||
    typeof value.database_in_process !== "boolean"
  ) {
    throw invalidResponse("Invalid system health response");
  }
  const cpuPercent = value["cpu_percent"];
  if (cpuPercent !== null && !isFiniteNumber(cpuPercent)) {
    throw invalidResponse("Invalid system health response");
  }
  return value as unknown as SystemHealthResponse;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

export function assertUsageSummary(value: unknown): UsageSummaryResponse {
  if (!isRecord(value) || typeof value.period !== "string" || !isRecord(value.totals)) {
    throw invalidResponse("Invalid usage summary response");
  }
  const totals = value.totals;
  const numericFields = [
    "requests",
    "inputTokens",
    "cachedTokens",
    "outputTokens",
    "errors",
    "cancelled",
    "truncated",
    "avgResolveMs",
    "avgDurationMs",
    "latencyP50Ms",
    "latencyP95Ms",
    "latencyP99Ms",
    "latencySampleCount",
    "resolveSampleCount",
    "estimatedCostUsd",
    "cacheHitRate",
  ];
  if (!numericFields.every((field) => isFiniteNumber(totals[field])) || typeof totals.partial !== "boolean") {
    throw invalidResponse("Invalid usage summary response");
  }
  if (
    !Array.isArray(totals.statusCounts) ||
    !totals.statusCounts.every(
      (item) => isRecord(item) && isFiniteNumber(item.status) && isFiniteNumber(item.count),
    )
  ) {
    throw invalidResponse("Invalid usage status counts");
  }
  return value as unknown as UsageSummaryResponse;
}

export function assertUsageChart(value: unknown): UsageChartResponse {
  if (!isRecord(value) || !Array.isArray(value.buckets)) {
    throw invalidResponse("Invalid usage chart response");
  }
  for (const bucket of value.buckets) {
    if (
      !isRecord(bucket) ||
      typeof bucket.t !== "string" ||
      !["requests", "input", "cached", "output"].every((field) => isFiniteNumber(bucket[field]))
    ) {
      throw invalidResponse("Invalid usage chart response");
    }
  }
  return value as unknown as UsageChartResponse;
}
export function assertUsageBy(value: unknown): UsageByResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.rows) ||
    !(USAGE_DIMENSIONS as readonly string[]).includes(String(value.dimension))
  ) {
    throw invalidResponse("Invalid usage breakdown response");
  }
  for (const row of value.rows) {
    if (
      !isRecord(row) ||
      typeof row.name !== "string" ||
      !["requests", "input", "output", "cached", "total", "errors"].every((field) =>
        isFiniteNumber(row[field]),
      ) ||
      !(row.costUsd === null || isFiniteNumber(row.costUsd)) ||
      (row.label !== undefined && typeof row.label !== "string")
    ) {
      throw invalidResponse("Invalid usage breakdown response");
    }
  }
  return value as unknown as UsageByResponse;
}

function assertUsageRequestItem(value: unknown): void {
  if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.startedAt !== "string") {
    throw invalidResponse("Invalid usage request response");
  }
  if (typeof value.status !== "string" || (value.mode !== "stream" && value.mode !== "non_stream")) {
    throw invalidResponse("Invalid usage request response");
  }
  if (value.accountId !== undefined && typeof value.accountId !== "string") {
    throw invalidResponse("Invalid usage request response");
  }
  for (const field of ["endpoint", "apiKeyId", "userAgent", "clientName", "clientIp"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw invalidResponse("Invalid usage request response");
    }
  }
  // Presence bitmask: 1|2|4|8 flag which payload stages were captured, so the
  // highest value is 15. A larger number would mark stages that do not exist.
  const stages: unknown = value.payloadStages;
  if (stages !== undefined && (!Number.isInteger(stages) || (stages as number) < 0 || (stages as number) > 15)) {
    throw invalidResponse("Invalid usage request response");
  }
  for (const field of [
    "durationMs",
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "reasoningTokens",
    "totalTokens",
    "ttfbMs",
    "tokensPerSec",
    "estimatedCost",
    "creditUsed",
    "resolveMs",
  ]) {
    if (!isOptionalFiniteNumber(value[field])) throw invalidResponse("Invalid usage request response");
  }
}

export function assertUsageRequests(value: unknown): UsageRequestsResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse("Invalid usage requests response");
  }
  for (const item of value.items) assertUsageRequestItem(item);
  return value as unknown as UsageRequestsResponse;
}

export function assertUsageRequestDetail(value: unknown): UsageRequestDetail {
  if (!isRecord(value)) throw invalidResponse("Invalid usage request response");
  assertUsageRequestItem(value);
  if (value.payloads !== undefined && value.payloads !== null && !isRecord(value.payloads)) {
    throw invalidResponse("Invalid usage request response");
  }
  if (value.payloadSignals !== undefined) {
    if (!isRecord(value.payloadSignals)) throw invalidResponse("Invalid usage request response");
    for (const field of ["toolCalls", "images", "attachments"]) {
      const count = value.payloadSignals[field];
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw invalidResponse("Invalid usage request response");
      }
    }
  }
  return value as unknown as UsageRequestDetail;
}

export function assertAuditListPage(value: unknown): AuditListPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw invalidResponse("Invalid audit response");
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.actor !== "string" ||
      typeof entry.action !== "string" ||
      typeof entry.target !== "string"
    ) {
      throw invalidResponse("Invalid audit response");
    }
    return entry as unknown as AuditEntry;
  });
  return typeof value.nextCursor === "string"
    ? { entries, nextCursor: value.nextCursor }
    : { entries };
}

export function assertProviders(value: unknown): ProviderResponse[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid provider response");
  return value.map((provider) => {
    if (
      !isRecord(provider) ||
      typeof provider.providerId !== "string" ||
      typeof provider.displayName !== "string" ||
      typeof provider.enabled !== "boolean" ||
      typeof provider.isBuiltIn !== "boolean"
    ) {
      throw invalidResponse("Invalid provider response");
    }
    const serviceKinds =
      provider.serviceKinds === undefined
        ? ["llm"]
        : isStringArray(provider.serviceKinds) && provider.serviceKinds.length > 0
          ? provider.serviceKinds
          : undefined;
    if (serviceKinds === undefined || serviceKinds.includes("all"))
      throw invalidResponse("Invalid provider service kinds");
    return { ...provider, serviceKinds } as unknown as ProviderResponse;
  });
}

export function assertProvider(value: unknown): ProviderResponse {
  const [provider] = assertProviders([value]);
  if (provider === undefined) throw invalidResponse("Invalid provider response");
  return provider;
}

/**
 * The warning projection is optional (migration 0044 is additive), so an old
 * wire stays valid. When present it is filtered rather than validated: one
 * malformed entry must not make the whole catalog unreadable, and the card only
 * ever reads `kind`, `message`, and the optional severity/timestamp.
 */
function looseWarnings(value: unknown): readonly ModelWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings = value.filter(
    (item): item is ModelWarning =>
      isRecord(item) && typeof item.kind === "string" && typeof item.message === "string",
  );
  return warnings.length > 0 ? warnings : undefined;
}

export function assertModels(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid model response");
  return value.map((model) => {
    if (
      !isRecord(model) ||
      typeof model.modelId !== "string" ||
      typeof model.route !== "string" ||
      typeof model.provider !== "string"
    ) {
      throw invalidResponse("Invalid model response");
    }
    // Still loose against every new field: only the warning array is projected,
    // and only when the server actually sent one.
    const warnings = looseWarnings(model.warnings);
    return (warnings === undefined
      ? model
      : { ...model, warnings }) as unknown as ModelCatalogEntry;
  });
}

/**
 * Discovery is a read-only preview, so an older console that answers with a
 * bare candidate array is still usable: normalize both shapes here rather than
 * making the modal reject a valid roster. Fields inside a candidate are left
 * as the wire sent them — `DiscoverModelCandidate` is a C3 contract, and the
 * UI only reads `modelId` / `alreadyRegistered` / a few display fields.
 */
export function assertDiscoverModels(value: unknown): DiscoverModelsResponse {
  const raw = Array.isArray(value) ? { supported: true, candidates: value } : value;
  if (!isRecord(raw) || raw.supported === false) {
    return { supported: false, candidates: [] };
  }
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter(
        (item): item is DiscoverModelCandidate =>
          isRecord(item) && typeof item.modelId === "string",
      )
    : [];
  return {
    supported: true,
    candidates,
    ...(typeof raw.accountLabel === "string" ? { accountLabel: raw.accountLabel } : {}),
  };
}

export function assertModelAliases(value: unknown): ModelAliasRow[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid model alias response");
  return value.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.tenantId !== "string" ||
      typeof row.alias !== "string" ||
      typeof row.targetModel !== "string" ||
      typeof row.createdAt !== "string" ||
      typeof row.updatedAt !== "string"
    ) {
      throw invalidResponse("Invalid model alias response");
    }
    return row as unknown as ModelAliasRow;
  });
}

export function assertModelCombos(value: unknown): ModelComboRow[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid model combo response");
  return value.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.tenantId !== "string" ||
      typeof row.name !== "string" ||
      !isStringArray(row.members) ||
      typeof row.strategy !== "string" ||
      typeof row.createdAt !== "string" ||
      typeof row.updatedAt !== "string"
    ) {
      throw invalidResponse("Invalid model combo response");
    }
    return row as unknown as ModelComboRow;
  });
}

export function assertProviderRouting(value: unknown): ProviderRoutingResponse {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    typeof value.strategy !== "string" ||
    typeof value.rotateCount !== "number" ||
    value.rotateCount < 1 ||
    value.rotateCount > 1000 ||
    typeof value.enabled !== "boolean" ||
    (value.maxInflight !== null && typeof value.maxInflight !== "number") ||
    (value.maxInflightPerProxy !== null &&
      value.maxInflightPerProxy !== undefined &&
      typeof value.maxInflightPerProxy !== "number") ||
    (value.usageFloor !== null && value.usageFloor !== undefined && typeof value.usageFloor !== "number") ||
    (value.usageFloorUnit !== undefined && value.usageFloorUnit !== "credit" && value.usageFloorUnit !== "percent") ||
    typeof value.skipProxy !== "boolean" ||
    typeof value.userAgent !== "string" ||
    value.userAgent.length > 4096
  ) {
    throw invalidResponse("Invalid provider routing response");
  }
  return value as unknown as ProviderRoutingResponse;
}

export function assertPoolStrategy(value: unknown): PoolStrategySetting {
  if (
    !isRecord(value) ||
    typeof value.strategy !== "string" ||
    typeof value.rotateCount !== "number" ||
    value.rotateCount < 1 ||
    value.rotateCount > 1000
  ) {
    throw invalidResponse("Invalid pool strategy response");
  }
  return value as unknown as PoolStrategySetting;
}

export function assertApiKeys(value: unknown): ApiKeyResponse[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid API key response");
  return value.map((key) => {
    if (
      !isRecord(key) ||
      typeof key.id !== "string" ||
      !isStringArray(key.scopes) ||
      typeof key.createdAt !== "string"
    ) {
      throw invalidResponse("Invalid API key response");
    }
    return key as unknown as ApiKeyResponse;
  });
}

export function assertNetworkPools(value: unknown): NetworkPoolResponse[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid network pools response");
  return value.map((pool) => {
    if (
      !isRecord(pool) ||
      typeof pool.id !== "string" ||
      typeof pool.kind !== "string" ||
      typeof pool.endpoint !== "string" ||
      !["active", "cooldown", "disabled"].includes(pool.status as string)
    ) {
      throw invalidResponse("Invalid network pool response");
    }
    return pool as unknown as NetworkPoolResponse;
  });
}

export function querySignal(context: QueryFunctionContext): AbortSignal {
  return context.signal;
}
