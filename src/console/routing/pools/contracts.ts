// Network-pool control-plane contracts: the request/response shapes, the
// store interface, and the shared validation every surface uses.
// Elysia-free on purpose: the dashboard imports these types, and `routes.ts`
// is the only module allowed to touch the HTTP layer.
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../audit/contracts";
import { ConsoleDomainError } from "../../shared/errors";
import { isIP } from "node:net";
import { isAddressAllowed } from "../../../network/ssrf";
import { TRANSPORT_KINDS, type TransportKind } from "../../../network/pool/agent";
import type { SsrfPolicy } from "../../../config/network";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { PoolHealthEvent } from "../../../network/pool-health-machine";

export interface CreateNetworkPoolRequest {
  kind: TransportKind;
  label?: string;
  endpoint: string;
  credential?: string;
  quotaBytes?: number | null;
  maxInflight?: number;
  /** Routing weight across the pool group; defaults to 100. */
  weight?: number;
  /** Operators may enable/disable pools; health policy also disables them on proxy HTTP 402/407. */
  status?: "active" | "disabled";
  config?: Record<string, unknown>;
  /** Operator-set family/tag naming which family this node belongs to.
   * Purely organisational; `null` clears the tag. */
  family?: string | null;
}
export interface NetworkPoolResponse {
  id: string;
  kind: TransportKind;
  label?: string;
  endpoint: string;
  maxInflight: number;
  weight: number;
  status: "active" | "cooldown" | "disabled";
  inflight: number;
  available?: number;
  utilization?: number;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastLatencyMs?: number;
  lastHealthCheckAt?: string;
  lastErrorAt?: string;
  lastErrorCategory?: string;
  lastError?: string;
  cooldownUntil?: string;
  tenantId: string;
  /** Operator-set family/tag; absent or null when untagged. */
  family?: string | null;
  /** Non-secret transport settings (e.g. timeout); never contains credential material. */
  config?: Record<string, unknown>;
  /** True when an encrypted credential is stored for this pool; never the credential itself. */
  hasCredential?: boolean;
  /** Public address the pool egresses from, as reported by the last successful
   * probe. Absent until the pool has been probed. */
  egressIp?: string;
  /** Operator-set egress allowance in bytes; absent when unmetered. */
  quotaBytes?: number;
  /** Metered totals banked in the pool row; they survive a gateway restart,
   * unlike the live session counters on the SSE stream. Absent when never measured. */
  bytesSentTotal?: number;
  /** Metered ingress total; see `bytesSentTotal`. */
  bytesReceivedTotal?: number;
  /** Last speed-test payload actually transferred, in bytes; absent until measured. */
  lastSpeedtestBytes?: number;
  /** Wall-clock duration of the last speed-test transfer, in milliseconds. */
  lastSpeedtestDurationMs?: number;
  /** "ok" | "failed" for the last speed-test; absent until measured. */
  lastSpeedtestStatus?: "ok" | "failed";
  /** Failure message of the last speed-test; absent on success or unmeasured. */
  lastSpeedtestError?: string;
  /** ISO timestamp of when the last speed-test ran. */
  lastSpeedtestAt?: string;
  /**
   * Provider-scoped refusals on this pool.
   *
   * `blocked` is not a longer `cooldown`: a 429 is an allowance that refills,
   * while a block means the upstream retired the egress address and only
   * replacing the proxy clears it. The console renders them differently so an
   * operator does not wait for a block to expire.
   */
  providerCooldowns?: Array<{
    providerId: string;
    until: string;
    reason: string;
    blocked: boolean;
  }>;
  /**
   * Last provider probe recorded **on the row**, so every reader sees the same
   * answer — another machine, the gateway, and the operator alike.
   *
   * Absent when never probed, and also when the pool's endpoint has changed
   * since the probe: the stored verdict describes an address that no longer
   * exists, so reporting it would be a stale claim rather than a measurement.
   */
  providerProbe?: StoredProviderProbe;
}

export interface StoredProviderProbe {
  readonly providerId: string;
  readonly status: "allowed" | "blocked" | "throttled" | "unreachable";
  readonly httpStatus?: number;
  readonly reason?: string;
  readonly latencyMs?: number;
  /** ISO timestamp of the probe. */
  readonly checkedAt: string;
  /** The endpoint this verdict was measured against. */
  readonly endpoint: string;
}


export interface NetworkPoolRecord extends NetworkPoolResponse {
  createdAt: string;
  /** Write-only: the store encrypts and persists this. Never rehydrated on read. */
  credential?: string;
}
export interface HealthCheckResult {
  poolId: string;
  status: "healthy" | "reachable" | "unhealthy" | "timeout";
  httpStatus?: 402 | 407;
  latencyMs?: number;
  errorMessage?: string;
  /** Public address the pool egressed from, when the probe could read one. */
  egressIp?: string;
}
/**
 * Whether one upstream provider accepts traffic from this pool's egress.
 *
 * Distinct from `HealthCheckResult` in what it asks. A health check says "the
 * proxy carries traffic" by dialing a neutral canary; this says "this
 * particular provider will serve us from this address", which a neutral canary
 * cannot answer — OpenCode's free tier refuses a flagged address on the
 * dispatch route while still answering its public catalog from the same
 * address. Only the dispatch route tells the two apart.
 *
 * `blocked` is not a transient failure: the upstream retired the address, so
 * the pool stays out of rotation for that provider until the proxy is
 * replaced. `unreachable` means the probe itself could not complete, which
 * says nothing about the address. `throttled` means the address was accepted
 * and the rate is spent — it recovers, so the pool stays usable.
 *
 * A `4xx` that is not the free-tier refusal reads as `allowed`: the provider
 * checks the address before it validates the body, so reaching its validation
 * is proof the egress was accepted.
 */
export interface PoolProviderProbeResult {
  poolId: string;
  providerId: string;
  status: "allowed" | "blocked" | "throttled" | "unreachable";
  /** Upstream status when a response arrived. */
  httpStatus?: number;
  latencyMs?: number;
  /** The upstream's own reason, bounded for display. */
  reason?: string;
  /** Whether this probe retired the pool for the provider. */
  blockedPool?: boolean;
}

/**
 * Throughput measured by dialing a fixed-size download through the pool.
 *
 * Distinct from `HealthCheckResult`: a health check asks "can this pool carry
 * traffic at all", a speed test asks "how fast". A pool can be perfectly
 * healthy and still measure a slow or failed transfer.
 */
export interface PoolSpeedTestResult {
  poolId: string;
  status: "ok" | "failed";
  /** Payload actually transferred, in bytes. */
  bytes: number;
  /** Wall-clock duration of the transfer, in milliseconds. */
  durationMs: number;
  bytesPerSecond?: number;
  megabitsPerSecond?: number;
  errorMessage?: string;
  /** ISO timestamp of when the measurement completed; set by the store write. */
  measuredAt?: string;
}
export function validateTransportConfig(
  kind: TransportKind,
  config: unknown,
): void {
  const cfg = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  switch (kind) {
    case "http":
    case "https":
      if (cfg.timeout !== undefined && typeof cfg.timeout !== "number")
        throw new ConsoleDomainError("invalid_pool", 400, "HTTP timeout must be a number", { field: "timeout" });
      return;
    case "socks5":
      return;
    default:
      // Compile-time exhaustiveness: new TransportKind variants must add a case.
      kind satisfies never;
      throw new ConsoleDomainError(
        "invalid_pool",
        400,
        `Unsupported transport kind: ${String(kind)}`,
        { field: "kind" },
      );
  }
}

/**
 * Pool kinds and operator-settable statuses, as runtime tuples. `cooldown` is
 * health-machine-only and deliberately absent from the status tuple. The Elysia
 * body schema, the config validator, and the request types all project these
 * lists.
 */
export const POOL_KINDS = TRANSPORT_KINDS;
export const POOL_STATUSES = ["active", "disabled"] as const;

/** Operator-settable pool status. */
export type PoolStatus = (typeof POOL_STATUSES)[number];

/**
 * Pool-group selection strategies, as a runtime tuple: the Elysia body schema
 * projects its `t.Literal` union from it and the operations layer validates
 * direct callers against the same list (mirrors `POOL_STATUSES`). Values must
 * stay aligned with the `pool_routing_strategy` enum in `schema.ts`.
 */
export const POOL_ROUTING_STRATEGIES = ["least_loaded", "round_robin", "random"] as const;
export type PoolRoutingStrategyValue = (typeof POOL_ROUTING_STRATEGIES)[number];

export interface PoolStrategySetting {
  strategy: PoolRoutingStrategyValue;
  /** Requests served by one pool before round robin advances (1..1000). */
  rotateCount: number;
}

/** No-row default: the weighted least-loaded scan that has always run. */
export const DEFAULT_POOL_STRATEGY: PoolStrategySetting = {
  strategy: "least_loaded",
  rotateCount: 1,
};

function requiredPoolString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ConsoleDomainError("invalid_pool", 400, `Pool ${field} is required`);
  return value;
}

function requiredPoolNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ConsoleDomainError("invalid_pool", 400, `Pool ${field} must be a finite number`);
  return value;
}
/**
 * Strips secret-bearing keys from a pool's transport config before it is
 * echoed through the console API. HTTP(S)/SOCKS5 pools carry no credential
 * material, so this only guards rows written before binary pools were removed.
 */
const REDACTED_POOL_CONFIG_KEYS = new Set(["privateKey", "uuid"]);

/** Case-insensitive substring match for secret-bearing key shapes. */
function isSecretPoolKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("credential") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("auth")
  );
}

function sanitizePoolConfig(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => !REDACTED_POOL_CONFIG_KEYS.has(key) && !isSecretPoolKey(key),
  );
  return Object.fromEntries(entries);
}

/** Returns the request's transport config as the stored `endpoint_config` shape. */
export function normalizePoolConfig(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
}
export function sanitizePoolResponse(pool: unknown): NetworkPoolResponse {
  if (!pool || typeof pool !== "object")
    throw new ConsoleDomainError("invalid_pool", 400, "Pool must be an object");
  const p = pool as Record<string, unknown>;
  if (typeof p.kind !== "string" || !(POOL_KINDS as readonly string[]).includes(p.kind))
    throw new ConsoleDomainError("invalid_pool", 400, "Pool kind is required");
  if (typeof p.status !== "undefined" && !(POOL_STATUSES as readonly string[]).includes(p.status as string))
    throw new ConsoleDomainError("invalid_pool", 400, "Pool status is invalid");
  const maxInflight = requiredPoolNumber(p.maxInflight, "maxInflight", 10);
  const weight = requiredPoolNumber(p.weight, "weight", 100);
  const inflight = requiredPoolNumber(p.inflight, "inflight", 0);
  const consecutiveFailures = requiredPoolNumber(p.consecutiveFailures, "consecutiveFailures", 0);
  const config = sanitizePoolConfig(p.config);
  return {
    id: requiredPoolString(p.id, "id"),
    kind: p.kind as TransportKind,
    ...(typeof p.label === "string" && p.label.length > 0 ? { label: p.label } : {}),
    endpoint: requiredPoolString(p.endpoint, "endpoint"),
    maxInflight,
    weight,
    status: (p.status as NetworkPoolResponse["status"]) ?? "active",
    inflight,
    available: Math.max(0, maxInflight - inflight),
    utilization: maxInflight > 0 ? Math.min(1, inflight / maxInflight) : 1,
    consecutiveFailures,
    ...(typeof p.lastSuccessAt === "string" ? { lastSuccessAt: p.lastSuccessAt } : {}),
    ...(typeof p.lastLatencyMs === "number" && Number.isFinite(p.lastLatencyMs)
      ? { lastLatencyMs: p.lastLatencyMs }
      : {}),
    ...(typeof p.lastHealthCheckAt === "string" ? { lastHealthCheckAt: p.lastHealthCheckAt } : {}),
    ...(typeof p.lastErrorAt === "string" ? { lastErrorAt: p.lastErrorAt } : {}),
    ...(typeof p.lastErrorCategory === "string" ? { lastErrorCategory: p.lastErrorCategory } : {}),
    ...(typeof p.lastError === "string" ? { lastError: p.lastError } : {}),
    ...(typeof p.cooldownUntil === "string" ? { cooldownUntil: p.cooldownUntil } : {}),
    tenantId: requiredPoolString(p.tenantId, "tenantId"),
    // Organisational tag; an empty string reads as untagged rather than as a
    // family literally named "".
    ...(typeof p.family === "string" && p.family.length > 0 ? { family: p.family } : {}),
    ...(config ? { config } : {}),
    ...(p.hasCredential === true ? { hasCredential: true } : {}),
    // An observed address, not a secret: it is the pool's public egress.
    ...(typeof p.egressIp === "string" && isIP(p.egressIp) ? { egressIp: p.egressIp } : {}),
    ...(typeof p.quotaBytes === "number" && Number.isFinite(p.quotaBytes) && p.quotaBytes > 0
      ? { quotaBytes: p.quotaBytes }
      : {}),
    ...(typeof p.bytesSentTotal === "number" && Number.isFinite(p.bytesSentTotal) && p.bytesSentTotal >= 0
      ? { bytesSentTotal: p.bytesSentTotal }
      : {}),
    ...(typeof p.bytesReceivedTotal === "number" && Number.isFinite(p.bytesReceivedTotal) && p.bytesReceivedTotal >= 0
      ? { bytesReceivedTotal: p.bytesReceivedTotal }
      : {}),
    ...(typeof p.lastSpeedtestBytes === "number" && Number.isFinite(p.lastSpeedtestBytes) && p.lastSpeedtestBytes >= 0
      ? { lastSpeedtestBytes: p.lastSpeedtestBytes }
      : {}),
    ...(typeof p.lastSpeedtestDurationMs === "number" && Number.isFinite(p.lastSpeedtestDurationMs) && p.lastSpeedtestDurationMs >= 0
      ? { lastSpeedtestDurationMs: p.lastSpeedtestDurationMs }
      : {}),
    ...(p.lastSpeedtestStatus === "ok" || p.lastSpeedtestStatus === "failed"
      ? { lastSpeedtestStatus: p.lastSpeedtestStatus }
      : {}),
    ...(typeof p.lastSpeedtestError === "string" && p.lastSpeedtestError.length > 0
      ? { lastSpeedtestError: p.lastSpeedtestError }
      : {}),
    ...(typeof p.lastSpeedtestAt === "string" ? { lastSpeedtestAt: p.lastSpeedtestAt } : {}),
  };
}
export interface NetworkPoolStore {
  list(tenantId: string): Promise<readonly NetworkPoolRecord[]>;
  get(tenantId: string, poolId: string): Promise<NetworkPoolRecord | undefined>;
  create(record: NetworkPoolRecord): Promise<void>;
  /** Inserts many rows in one statement; returns how many landed. */
  createMany?(records: readonly NetworkPoolRecord[]): Promise<number>;
  update(
    tenantId: string,
    poolId: string,
    patch: Partial<NetworkPoolRecord>,
  ): Promise<NetworkPoolRecord | undefined>;
  /** Marks many rows `deleted`; returns how many matched. */
  updateManyStatus?(
    tenantId: string,
    poolIds: readonly string[],
    status: NetworkPoolRecord["status"],
  ): Promise<number>;
  delete(tenantId: string, poolId: string): Promise<boolean>;
  /** Deletes many rows in one statement; returns how many matched. */
  deleteMany?(tenantId: string, poolIds: readonly string[]): Promise<number>;
  healthCheck(tenantId: string, poolId: string): Promise<HealthCheckResult>;
  /** Measures download throughput through the pool; never throws for a slow
   * or refused transfer — a failed measurement is itself the result. */
  speedTest?(tenantId: string, poolId: string, bytes: number): Promise<PoolSpeedTestResult>;
  probeAdHoc?(
    tenantId: string,
    request: CreateNetworkPoolRequest,
  ): Promise<HealthCheckResult>;
  /** Asks one provider whether it will serve traffic from this pool. */
  providerProbe?(
    tenantId: string,
    poolId: string,
    providerId: string,
  ): Promise<PoolProviderProbeResult>;
  /** The same probe against an endpoint that has not been saved yet. */
  probeAdHocProvider?(
    tenantId: string,
    request: CreateNetworkPoolRequest,
    providerId: string,
  ): Promise<PoolProviderProbeResult>;
  listHealthEvents(tenantId: string, poolId: string): Promise<readonly PoolHealthEvent[]>;
  recover(tenantId: string, poolId: string): Promise<boolean>;
  /**
   * Drops the durable provider-cooldown markers on one pool row — the mirror
   * the selector restores from at boot. The in-memory/Redis state is cleared
   * separately by the selector; this keeps the two from drifting after a
   * restart. `onlyBlocked` limits the drop to retired-egress markers, mirroring
   * `clearProviderBlockedOnly`: a 429 probe may prove an address was never
   * retired but must not release its live cooldown. Optional (and a no-op in
   * tests without a backing row store).
   */
  dropProviderCooldownMarker?(
    tenantId: string,
    poolId: string,
    providerId: string,
    onlyBlocked: boolean,
  ): Promise<void>;
  /** Drops every provider's marker on one row (disable/replace paths). */
  dropAllProviderCooldownMarkers?(tenantId: string, poolId: string): Promise<void>;
  /**
   * Writes a probe-measured 429 into the durable mirror and the pool's health
   * history. The probe is the only writer that can *flag* a cooldown from the
   * control plane — its 429 is a fresh measurement of the same condition a
   * dispatch-side 429 records, so it lands in both stores and appears as
   * activity. Optional; absent in tests without a backing row store.
   */
  recordProviderProbeCooldown?(
    tenantId: string,
    poolId: string,
    providerId: string,
    marker: { until: number; reason: string; blocked?: boolean },
  ): Promise<void>;
  /** Per-tenant pool-group selection strategy; an absent row reads as
   * `DEFAULT_POOL_STRATEGY`. */
  getStrategy(tenantId: string): Promise<PoolStrategySetting>;
  /** Upserts the tenant's single settings row; returns the stored value. */
  setStrategy(tenantId: string, setting: PoolStrategySetting): Promise<PoolStrategySetting>;
}
/** One entry of a batch provider probe: the requested endpoint plus its outcome. */
export interface PoolBatchProviderProbeResult {
  readonly endpoint: string;
  readonly result: PoolProviderProbeResult;
}

/** One entry of a batch probe: the requested endpoint plus its outcome. */
export interface PoolBatchProbeResult {
  readonly endpoint: string;
  readonly kind: TransportKind;
  readonly result: HealthCheckResult;
}

/** How many proxy dials run at once during a batch probe. Shared by the
 * operations worker pool and the routes that expose the endpoint. */
export const POOL_BATCH_PROBE_CONCURRENCY = 10;

/** Upper bound on a single batch probe. Each entry dials an external host, so
 * the cap keeps one request from turning into an unbounded fan-out. */
export const MAX_BATCH_PROBE_TARGETS = 100;

/**
 * Concurrency for a batch provider probe.
 *
 * Lower than `POOL_BATCH_PROBE_CONCURRENCY` because each entry opens a tunnel
 * *and* a TLS session to the provider, rather than one small canary request.
 * A wide fan-out here is what makes a batch look like an outage upstream.
 */
export const PROVIDER_PROBE_BATCH_CONCURRENCY = 4;

export interface NetworkPoolAgentReleaser {
  releasePool(poolId: string, tenantId: string): Promise<void>;
}
export interface NetworkPoolConfig {
  readonly store: NetworkPoolStore;
  readonly accessResolver: ConsoleAccessResolver;
  /** Records privileged mutations to `admin_audit_log`; a no-op when omitted (e.g. tests). */
  readonly auditSink?: AuditSink;
  readonly poolSelector?: NetworkPoolSelector;
  readonly ssrfPolicy?: SsrfPolicy;
  /** Destroys the pool's cached dial agent/delegate subprocess on update,
   * disable, delete, and endpoint/credential rotation — otherwise the old
   * agent lingers for the rest
   * of the process lifetime after the pool's config has already changed. */
  readonly poolAgentReleaser?: NetworkPoolAgentReleaser;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * SSRF-validated outbound fetch used by the hosted-relay deploy endpoint.
   * Deploy calls reach provider APIs (Cloudflare/Vercel/Deno), so they must be
   * checked like every other egress. Omitted in tests, where the deploy fetch
   * is stubbed through the operation itself.
   */
  readonly relayFetch?: (url: string, init: RequestInit) => Promise<Response>;

}

/** HTTP(S)/SOCKS5 pools dial `endpoint` directly, so it must be safe per SSRF policy. */
export function validateEndpoint(
  kind: TransportKind,
  endpoint: string,
  policy: SsrfPolicy = {},
): void {

  if (kind === "socks5") {
    const candidate = endpoint.includes("://") ? endpoint : `socks5://${endpoint}`;
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      throw new ConsoleDomainError("invalid_pool", 400, "Endpoint must be host:port", { field: "endpoint" });
    }
    if (!u.hostname || !u.port)
      throw new ConsoleDomainError("invalid_pool", 400, "Endpoint must be host:port", { field: "endpoint" });
    if (u.hostname === "localhost" || u.hostname.endsWith(".internal"))
      throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
    if (isIP(u.hostname) !== 0 && !isAddressAllowed(u.hostname, policy))
      throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
    return;
  }
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new ConsoleDomainError("invalid_pool", 400, "Endpoint must be a valid http(s) URL", { field: "endpoint" });
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new ConsoleDomainError("invalid_pool", 400, "Endpoint must be a valid http(s) URL", { field: "endpoint" });
  }
  if (u.hostname === "localhost" || u.hostname.endsWith(".internal")) {
    throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
  }
  if (isIP(u.hostname) !== 0 && !isAddressAllowed(u.hostname, policy)) {
    throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
  }
}
const MAX_POOL_INFLIGHT = 1_000_000;
const MAX_POOL_WEIGHT = 1_000;

export function validatePoolLimits(maxInflight?: number, weight?: number): void {
  if (
    maxInflight !== undefined &&
    (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > MAX_POOL_INFLIGHT)
  ) {
    throw new ConsoleDomainError(
      "invalid_pool",
      400,
      "maxInflight must be an integer between 1 and 1000000",
      { field: "maxInflight" },
    );
  }
  if (
    weight !== undefined &&
    (!Number.isInteger(weight) || weight < 1 || weight > MAX_POOL_WEIGHT)
  ) {
    throw new ConsoleDomainError(
      "invalid_pool",
      400,
      "weight must be an integer between 1 and 1000",
      { field: "weight" },
    );
  }
}

