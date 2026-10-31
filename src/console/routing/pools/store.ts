// Drizzle-backed console persistence for network pools.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { networkPools, poolRoutingSettings, providerPoolAccounts } from "../../../persistence/schema";
import { providerRateLimitIsIpScoped } from "../../../providers/provider-metadata";
import {
  DEFAULT_POOL_STRATEGY,
  type CreateNetworkPoolRequest,
  type HealthCheckResult,
  type NetworkPoolRecord,
  type NetworkPoolStore,
  type PoolProviderProbeResult,
  type PoolSpeedTestResult,
  type PoolStrategySetting,
} from "./contracts";
import { classifyPoolConnectError, classifyPoolProbeResponse, parseEgressIp } from "./probe-result";
import { encryptCredential } from "../../../security/crypto";
import { createValidatedFetch } from "../../../network/outbound-fetch";
import { classifyProviderProbeAnswer } from "./probe-verdict";
import { buildProviderProbeRequest } from "../../../providers/provider-probe";
import type { StoredProviderProbe } from "./contracts";
import {
  createHttpProxyAgent,
  createSocks5Agent,
  deriveKind,
  splitEndpointConfig,
  type PoolAgent,
} from "../../../network/pool/agent";
import { DrizzleNetworkPoolLoader } from "../../../network/pool/loader";
import { PoolAgentResolver } from "../../../network/pool/resolver";
import type { SsrfPolicy } from "../../../config/network";
import {
  disablePoolForProxyHttpStatus,
  listNetworkPoolHealthEvents,
  recoverNetworkPool,
} from "../../../network/pool-health-machine";
import { drainPoolByteDelta, recordPoolBytes } from "../../../network/pool/byte-accounting";
import * as poolCooldownStore from "../../../network/pool-cooldown-store";
// Cloudflare's trace endpoint answers with plain `key=value` lines including
// `ip=`, the address the request egressed from. Dialing it THROUGH the pool
// therefore reports the pool's public address — which is what an operator
// means by "the proxy's IP" — rather than the local DNS answer for its
// hostname, which says nothing about where traffic actually leaves.
const NETWORK_POOL_HEALTH_CANARY = "https://www.cloudflare.com/cdn-cgi/trace";
// Fixed-size payload for throughput measurement. Cloudflare's speed endpoint
// streams exactly the requested byte count and answers no-cache, so the number
// reflects the tunnel rather than a CDN cache hit. The default (5 MB) finishes
// in a few seconds on a usable proxy and is large enough that TLS setup does
// not dominate; operators can ask for more when the link is fast enough that
// a short transfer measures ramp-up instead of throughput.
const NETWORK_POOL_SPEED_TEST_URL = "https://speed.cloudflare.com/__down?bytes=";
/** A provider probe is one small request; a slow proxy should not hold the batch. */
/**
 * Bound on one provider probe.
 *
 * Measured through live proxies on 2026-10-17: a healthy dispatch answers in
 * 2–6 s alone, but 16.7 s when four probes run together — the tunnel and TLS
 * handshake queue behind the operator's own uplink. At the previous 20 s that
 * left ~3 s of margin, so a working egress intermittently reported
 * "Probe timed out" and the card said `unreachable` for a pool that serves.
 *
 * 45 s is chosen to clear the measured worst case with room for a slower
 * operator link. It is not a quality threshold: a probe that needs this long is
 * slow, not broken, and the latency it reports is what says so.
 */
const PROVIDER_PROBE_TIMEOUT_MS = 45_000;

/** Worst-case wait for the largest allowed payload on a slow link. */
const NETWORK_POOL_SPEED_TEST_TIMEOUT_MS = 60_000;
/**
 * The stored probe verdict for a row, or nothing when it does not describe the
 * pool as it stands.
 *
 * Two ways it can be stale, and both must read as "never probed" rather than as
 * a verdict:
 *
 * - The endpoint changed. The verdict was measured against a specific egress,
 *   and the pool now points somewhere else.
 * - The row was written before `provider_probe_endpoint` existed. There is no
 *   address to compare against, so the claim cannot be validated.
 */
export function storedProviderProbe(
  row: typeof networkPools.$inferSelect,
  currentEndpoint: string,
): StoredProviderProbe | undefined {
  const status = row.providerProbeStatus;
  if (
    status !== "allowed" &&
    status !== "blocked" &&
    status !== "throttled" &&
    status !== "unreachable"
  ) {
    return undefined;
  }
  if (row.providerProbeEndpoint !== currentEndpoint) return undefined;
  const providerId = row.providerProbeProviderId;
  if (!providerId) return undefined;
  return {
    providerId,
    status,
    endpoint: currentEndpoint,
    checkedAt: (row.providerProbeAt ?? new Date(0)).toISOString(),
    ...(row.providerProbeHttpStatus === null || row.providerProbeHttpStatus === undefined
      ? {}
      : { httpStatus: row.providerProbeHttpStatus }),
    ...(row.providerProbeReason ? { reason: row.providerProbeReason } : {}),
    ...(row.providerProbeLatencyMs === null || row.providerProbeLatencyMs === undefined
      ? {}
      : { latencyMs: row.providerProbeLatencyMs }),
  };
}

/** Real Drizzle-backed network pool repository. */
export class DrizzleNetworkPoolStore implements NetworkPoolStore {
  /**
   * Shared pool-agent builder: validates the pool host against the SSRF policy
   * on every dial and applies the per-connect SOCKS5 revalidation, instead of
   * this store hand-rolling `createHttpProxyAgent`/`createSocks5Agent`.
   */
  private readonly poolAgents: PoolAgentResolver;

  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly ssrfPolicy: SsrfPolicy = {},
  ) {
    this.poolAgents = new PoolAgentResolver(new DrizzleNetworkPoolLoader(db), { ssrfPolicy, db });
  }
  private map(row: typeof networkPools.$inferSelect, tenantId: string): NetworkPoolRecord {
    const raw = (row.endpointConfig ?? {}) as Record<string, unknown>;
    const { endpoint, label, rest } = splitEndpointConfig(raw);
    return {
      id: row.id,
      kind: deriveKind(row.kind, endpoint ?? ""),
      endpoint: endpoint ?? "",
      ...(label ? { label } : {}),
      maxInflight: row.maxInflight ?? 10,
      weight: row.weight ?? 100,
      status: row.status,
      inflight: 0,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
      ...(row.lastLatencyMs !== null && row.lastLatencyMs !== undefined
        ? { lastLatencyMs: row.lastLatencyMs }
        : {}),
      ...(row.lastHealthCheckAt ? { lastHealthCheckAt: row.lastHealthCheckAt.toISOString() } : {}),
      ...(row.lastErrorAt ? { lastErrorAt: row.lastErrorAt.toISOString() } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.lastErrorCategory ? { lastErrorCategory: row.lastErrorCategory } : {}),
      ...(row.egressIp ? { egressIp: row.egressIp } : {}),
      ...(row.quotaBytes !== null && row.quotaBytes !== undefined
        ? { quotaBytes: row.quotaBytes }
        : {}),
      ...(row.bytesSentTotal !== null && row.bytesSentTotal !== undefined
        ? { bytesSentTotal: row.bytesSentTotal }
        : {}),
      ...(row.bytesReceivedTotal !== null && row.bytesReceivedTotal !== undefined
        ? { bytesReceivedTotal: row.bytesReceivedTotal }
        : {}),
      ...(row.lastSpeedtestBytes !== null && row.lastSpeedtestBytes !== undefined
        ? { lastSpeedtestBytes: row.lastSpeedtestBytes }
        : {}),
      ...(row.lastSpeedtestDurationMs !== null && row.lastSpeedtestDurationMs !== undefined
        ? { lastSpeedtestDurationMs: row.lastSpeedtestDurationMs }
        : {}),
      ...(row.lastSpeedtestStatus === "ok" || row.lastSpeedtestStatus === "failed"
        ? { lastSpeedtestStatus: row.lastSpeedtestStatus }
        : {}),
      ...(row.lastSpeedtestError ? { lastSpeedtestError: row.lastSpeedtestError } : {}),
      ...(row.lastSpeedtestAt ? { lastSpeedtestAt: row.lastSpeedtestAt.toISOString() } : {}),
      ...(() => {
        // A verdict describes the address recorded beside it. Once the pool is
        // re-pointed, that address is gone and the verdict is a claim about an
        // address the pool no longer uses — report "never probed" instead of
        // showing a colour the operator cannot trust.
        const probe = storedProviderProbe(row, endpoint ?? "");
        return probe === undefined ? {} : { providerProbe: probe };
      })(),
      ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
      ...(row.credentialCiphertext ? { hasCredential: true } : {}),
      ...(row.family ? { family: row.family } : {}),
      tenantId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Reads the pool's egress address through an already-resolved agent.
   *
   * Separate from `dialPoolCanary` because a caller that already measured
   * something (the speed test) needs the address without paying for another
   * timed probe: the canary body is a few hundred bytes, so this is cheap, and
   * a failure yields no address rather than failing the caller's operation.
   */
  private async readEgressIp(agent: PoolAgent): Promise<string | undefined> {
    try {
      const response = await createValidatedFetch({ agent })(NETWORK_POOL_HEALTH_CANARY, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      return parseEgressIp(await response.text());
    } catch {
      return undefined;
    }
  }

  private async dialPoolCanary(agent: PoolAgent): Promise<{ response: Response; latencyMs: number; egressIp?: string }> {
    const started = performance.now();
    const response = await createValidatedFetch({ agent })(NETWORK_POOL_HEALTH_CANARY, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Math.round(performance.now() - started);
    // The body is tiny and already buffered by the time we read it; a failure
    // to read it must not turn a healthy probe into an error.
    let egressIp: string | undefined;
    try {
      const body = await response.clone().text();
      egressIp = parseEgressIp(body);
    } catch {
      egressIp = undefined;
    }
    return { response, latencyMs, ...(egressIp ? { egressIp } : {}) };
  }

  /**
   * Asks one provider whether it will serve traffic from this pool's egress.
   *
   * The request is built by the provider's own adapter spec, so the probe
   * exercises the headers and body a real dispatch would send rather than a
   * stand-in that could pass while dispatch fails. `big-pickle` is the model
   * used because it is the one free id the listing always carries.
   *
   * The payload is deliberately minimal: the gate rejects a flagged address
   * before it reads the body (verified live — `{model, stream:true}` with no
   * `messages` still answers `403 FreeTierError`), so nothing is inferred and
   * no tokens are spent.
   *
   * A `blocked` outcome also retires the pool for that provider, which is the
   * same write a real refused dispatch performs. The probe is the only way to
   * learn this before spending a user request.
   */
  async providerProbe(
    tenantId: string,
    poolId: string,
    providerId: string,
  ): Promise<PoolProviderProbeResult> {
    const rec = await this.get(tenantId, poolId);
    if (!rec) throw new Error(`Pool ${poolId} not found`);
    let agent: PoolAgent;
    try {
      agent = await this.poolAgents.resolveAgent(rec.id, tenantId);
    } catch (error) {
      return {
        poolId,
        providerId,
        status: "unreachable",
        reason: error instanceof Error ? error.message : "Failed to build pool agent",
      };
    }
    return await this.dialProviderProbe(agent, poolId, providerId, poolId, rec.endpoint);
  }

  /**
   * The same probe against an endpoint the operator has not saved yet.
   *
   * The add form tests a pasted list before it exists as rows, so there is no
   * pool id to resolve. `poolId` in the result is the endpoint, which is what
   * the form prints beside each line.
   */
  async probeAdHocProvider(
    _tenantId: string,
    request: CreateNetworkPoolRequest,
    providerId: string,
  ): Promise<PoolProviderProbeResult> {
    const rawEndpoint = request.endpoint.includes("://")
      ? request.endpoint
      : `${request.kind}://${request.endpoint}`;
    let agent: PoolAgent;
    try {
      agent =
        request.kind === "socks5"
          ? createSocks5Agent(rawEndpoint, request.credential, this.ssrfPolicy)
          : createHttpProxyAgent(rawEndpoint, request.credential, this.ssrfPolicy);
    } catch (error) {
      return {
        poolId: request.endpoint,
        providerId,
        status: "unreachable",
        reason: error instanceof Error ? error.message : "Failed to build pool agent",
      };
    }
    return await this.dialProviderProbe(agent, request.endpoint, providerId);
  }

  /**
   * One provider dial through an already-built agent.
   *
   * `label` is what the result reports (a pool id, or a pasted endpoint that
   * has no row yet). `poolId` is the row to bank the verdict on — omitted for
   * an ad-hoc probe, because there is nothing to attach it to. `endpoint` is
   * the address the verdict describes, recorded beside it so
   * `storedProviderProbe` can verify it later — it must be the pool's *current
   * endpoint*, never the label: a verdict banked against the pool id fails the
   * endpoint comparison on read and is hidden as "never probed", which is
   * exactly the disappearing-verdict report.
   */
  private async dialProviderProbe(
    agent: PoolAgent,
    label: string,
    providerId: string,
    poolId?: string,
    endpoint?: string,
  ): Promise<PoolProviderProbeResult> {
    const spec = await buildProviderProbeRequest(providerId);
    if (!spec) {
      return { poolId: label, providerId, status: "unreachable", reason: "Unknown provider" };
    }

    const started = performance.now();
    let response: Response;
    try {
      response = await createValidatedFetch({ agent })(spec.url, {
        method: "POST",
        headers: spec.headers,
        body: JSON.stringify(spec.body),
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Probe failed";
      const timedOut =
        (error instanceof Error && error.name === "AbortError") ||
        /timed out|timeout|ETIMEDOUT/i.test(message);
      return {
        poolId: label,
        providerId,
        status: "unreachable",
        latencyMs: Math.round(performance.now() - started),
        reason: timedOut ? "Probe timed out" : message,
      };
    }
    const latencyMs = Math.round(performance.now() - started);
    const text = await response.text().catch(() => "");
    // One classifier for the console, the CLI probe, and the tests — see
    // `probe-verdict.ts` for why a 4xx reads as `allowed`.
    const verdict = classifyProviderProbeAnswer(response.status, text);
    const result: PoolProviderProbeResult = {
      poolId: label,
      providerId,
      status: verdict.status,
      httpStatus: response.status,
      latencyMs,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    };
    if (poolId !== undefined) await this.persistProviderProbe(poolId, endpoint ?? label, result);
    return result;
  }

  /**
   * Banks a probe verdict on the pool row.
   *
   * The verdict is stored here rather than per-viewer so every reader agrees:
   * another machine, the gateway, and the operator alike. Otherwise admission
   * keeps choosing the pool the badge calls blocked. Storing it here is what
   * makes the badge a fact about the pool rather than about one tab.
   *
   * `poolId` is the pool row; `endpoint` is what the verdict was measured
   * against, so a later edit invalidates it on read. A probe against an unsaved
   * endpoint has no row and is skipped — there is nothing to attach it to.
   */
  private async persistProviderProbe(
    poolId: string,
    endpoint: string,
    result: PoolProviderProbeResult,
  ): Promise<void> {
    try {
      await this.db
        .update(networkPools)
        .set({
          providerProbeProviderId: result.providerId,
          providerProbeStatus: result.status,
          providerProbeHttpStatus: result.httpStatus ?? null,
          providerProbeReason: result.reason ?? null,
          providerProbeLatencyMs: result.latencyMs ?? null,
          providerProbeAt: new Date(),
          providerProbeEndpoint: endpoint,
        })
        .where(eq(networkPools.id, poolId));
    } catch {
      // A verdict that cannot be stored must not fail the probe: the operator
      // still gets the answer they asked for, and the next probe retries.
    }
  }

  async list(tenantId: string): Promise<readonly NetworkPoolRecord[]> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(eq(networkPools.tenantId, tenantId))
      .orderBy(asc(networkPools.createdAt), asc(networkPools.id));
    return rows.map((row) => this.map(row, tenantId));
  }

  async get(tenantId: string, poolId: string): Promise<NetworkPoolRecord | undefined> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .limit(1);
    const row = rows[0];
    return row ? this.map(row, tenantId) : undefined;
  }

  async create(record: NetworkPoolRecord): Promise<void> {
    await this.createMany([record]).then(() => undefined);
  }

  /**
   * Inserts every record in one statement.
   *
   * A batch import used to be one round trip per proxy, so a long paste took
   * minutes and the dialog sat there while the operator waited. Drizzle emits a
   * single multi-row INSERT, which makes the cost independent of the paste
   * length.
   */
  async createMany(records: readonly NetworkPoolRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const values = records.map((record) => ({
      id: record.id,
      tenantId: record.tenantId,
      createdAt: new Date(record.createdAt),
      kind: record.kind === "https" ? "http" : record.kind,
      endpointConfig: {
        endpoint: record.endpoint,
        ...(record.label ? { label: record.label } : {}),
        ...(record.config ?? {}),
      },
      ...(record.credential !== undefined
        ? { credentialCiphertext: encryptCredential(record.credential) }
        : {}),
      maxInflight: record.maxInflight,
      weight: record.weight,
      status: record.status,
      consecutiveFailures: 0,
      ...(record.quotaBytes !== undefined ? { quotaBytes: record.quotaBytes } : {}),
      ...(record.family !== undefined ? { family: record.family } : {}),
    }));
    await this.db.insert(networkPools).values(values);

    // Materialize pool-as-account rows for ip-scoped, credential-less
    // providers (OpenCode Free today): the operator sees the egress in the
    // provider's Accounts card, and routing excludes a spent egress like a
    // cooling account. Every other provider gets no row.
    if (providerRateLimitIsIpScoped("opencode")) {
      const now = new Date();
      const poolAccounts = values.map((value) => ({
        id: randomUUID(),
        tenantId: value.tenantId,
        networkPoolId: value.id,
        providerId: "opencode",
        label: `Pool ${value.id.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
      }));
      await this.db.insert(providerPoolAccounts).values(poolAccounts);
    }
    return values.length;
  }

  /**
   * Sets one status on every named pool in a single statement.
   *
   * Bulk enable/disable was a loop of per-row updates — one round trip each,
   * and one snapshot invalidation each. A tenant-wide selection is exactly the
   * case where that is felt.
   */
  async updateManyStatus(
    tenantId: string,
    poolIds: readonly string[],
    status: NetworkPoolRecord["status"],
  ): Promise<number> {
    if (poolIds.length === 0) return 0;
    const rows = await this.db
      .update(networkPools)
      .set({ status })
      .where(
        and(
          eq(networkPools.tenantId, tenantId),
          inArray(networkPools.id, [...poolIds]),
        ),
      )
      .returning({ id: networkPools.id });
    return rows.length;
  }

  /** Deletes every named pool in one statement. */
  async deleteMany(tenantId: string, poolIds: readonly string[]): Promise<number> {
    if (poolIds.length === 0) return 0;
    const rows = await this.db
      .delete(networkPools)
      .where(
        and(
          eq(networkPools.tenantId, tenantId),
          inArray(networkPools.id, [...poolIds]),
        ),
      )
      .returning({ id: networkPools.id });
    return rows.length;
  }

  async update(
    tenantId: string,
    poolId: string,
    patch: Partial<NetworkPoolRecord>,
  ): Promise<NetworkPoolRecord | undefined> {
    const current = await this.get(tenantId, poolId);
    if (!current) return undefined;
    const endpointConfig: Record<string, unknown> = {
      endpoint: patch.endpoint ?? current.endpoint,
      ...((patch.label ?? current.label) ? { label: patch.label ?? current.label } : {}),
      ...(current.config ?? {}),
      ...(patch.config ?? {}),
    };
    const effectiveKind = patch.kind ?? current.kind;
    // A verdict describes the address it was measured against. Re-pointing the
    // pool — or changing the transport it speaks — invalidates it outright, so
    // the row is cleared rather than left holding a claim about a proxy that no
    // longer exists. The read path also compares endpoints, so a stale row can
    // never be shown; clearing here keeps the database honest too.
    const endpointChanged =
      (patch.endpoint !== undefined && patch.endpoint !== current.endpoint) ||
      (patch.kind !== undefined && patch.kind !== current.kind);
    const clearsProxyResponseFailure =
      patch.status === "active" &&
      current.status === "disabled" &&
      (current.lastErrorCategory === "proxy_payment_required" ||
        current.lastErrorCategory === "proxy_auth_required");
    const rows = await this.db
      .update(networkPools)
      .set({
        endpointConfig,
        kind: effectiveKind === "https" ? "http" : effectiveKind,
        // Fields default to `undefined` when omitted from the patch, which
        // would overwrite the current row with `undefined` and clobber
        // existing values. Fall back to the current record so a partial
        // PATCH truly leaves un-mentioned fields alone.
        maxInflight: patch.maxInflight ?? current.maxInflight,
        weight: patch.weight ?? current.weight,
        // An explicit `null` clears the quota (back to unmetered); omitting the
        // field leaves it as-is.
        ...("quotaBytes" in patch ? { quotaBytes: patch.quotaBytes ?? null } : {}),
        ...(clearsProxyResponseFailure
          ? {
              consecutiveFailures: 0,
              cooldownUntil: null,
              lastError: null,
              lastErrorCategory: null,
              lastErrorAt: null,
            }
          : {}),
        status: patch.status ?? current.status,
        ...(patch.credential !== undefined
          ? { credentialCiphertext: encryptCredential(patch.credential) }
          : {}),
        // An explicit `null` clears the family tag; omitting the field leaves
        // it as-is, matching `quotaBytes`.
        ...("family" in patch ? { family: patch.family ?? null } : {}),
        ...(endpointChanged
          ? {
              providerProbeProviderId: null,
              providerProbeStatus: null,
              providerProbeHttpStatus: null,
              providerProbeReason: null,
              providerProbeLatencyMs: null,
              providerProbeAt: null,
              providerProbeEndpoint: null,
            }
          : {}),
      })
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .returning();
    const row = rows[0];
    return row ? this.map(row, tenantId) : undefined;
  }

  async delete(tenantId: string, poolId: string): Promise<boolean> {
    const rows = await this.db
      .delete(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .returning({ id: networkPools.id });
    return rows.length > 0;
  }

  async listHealthEvents(tenantId: string, poolId: string) {
    return listNetworkPoolHealthEvents(this.db, tenantId, poolId);
  }

  async dropProviderCooldownMarker(
    tenantId: string,
    poolId: string,
    providerId: string,
    onlyBlocked: boolean,
  ): Promise<void> {
    if ((await this.get(tenantId, poolId)) === undefined) return;
    await poolCooldownStore.dropProviderCooldownMarker(this.db, poolId, providerId, onlyBlocked);
  }

  async dropAllProviderCooldownMarkers(
    tenantId: string,
    poolId: string,
  ): Promise<void> {
    if ((await this.get(tenantId, poolId)) === undefined) return;
    await poolCooldownStore.dropAllProviderCooldownMarkers(this.db, poolId);
  }

  async recordProviderProbeCooldown(
    tenantId: string,
    poolId: string,
    providerId: string,
    marker: { until: number; reason: string; blocked?: boolean },
  ): Promise<void> {
    if ((await this.get(tenantId, poolId)) === undefined) return;
    await poolCooldownStore.recordProbeVerdict(this.db, poolId, providerId, marker);
  }

  async recover(tenantId: string, poolId: string): Promise<boolean> {
    return recoverNetworkPool(this.db, tenantId, poolId);
  }
  async getStrategy(tenantId: string): Promise<PoolStrategySetting> {
    const rows = await this.db
      .select()
      .from(poolRoutingSettings)
      .where(eq(poolRoutingSettings.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    // No row = never configured = the default least-loaded scan.
    if (!row) return DEFAULT_POOL_STRATEGY;
    return { strategy: row.strategy, rotateCount: row.rotateCount };
  }

  async setStrategy(
    tenantId: string,
    setting: PoolStrategySetting,
  ): Promise<PoolStrategySetting> {
    await this.db
      .insert(poolRoutingSettings)
      .values({ tenantId, strategy: setting.strategy, rotateCount: setting.rotateCount })
      .onConflictDoUpdate({
        target: poolRoutingSettings.tenantId,
        set: { strategy: setting.strategy, rotateCount: setting.rotateCount },
      });
    return setting;
  }

  async healthCheck(tenantId: string, poolId: string): Promise<HealthCheckResult> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .limit(1);
    const row = rows[0];
    if (!row) return { poolId, status: "unhealthy", errorMessage: "Pool not found" };
    // Resolve the pool's dispatch agent and dial a public canary THROUGH it.
    // This fixes the prior dual bug: `socks5://` endpoints were fed to
    // `createValidatedFetch` as a target URL (TypeError), and HTTP endpoints
    // were probed directly (listener reach, not end-to-end tunnel).
    let agent: PoolAgent;
    try {
      // Same builder dispatch uses, so the health check inherits the
      // per-connect SSRF revalidation instead of a second, weaker path.
      agent = await this.poolAgents.resolveAgent(poolId, tenantId);
    } catch (error) {
      return {
        poolId,
        status: "unhealthy",
        errorMessage: error instanceof Error ? error.message : "Failed to build pool agent",
      };
    }
    const started = performance.now();
    let result: HealthCheckResult;
    try {
      const { response, latencyMs, egressIp } = await this.dialPoolCanary(agent);
      result = classifyPoolProbeResponse(poolId, response, latencyMs);
      if (egressIp) result = { ...result, egressIp };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const proxyResponse = classifyPoolConnectError(poolId, error, latencyMs);
      if (proxyResponse) {
        result = proxyResponse;
      } else {
        // Only real timeouts are labeled "timeout" — anything else (refused,
        // reset, cert mismatch, CONNECT rejection) is "unhealthy".
        const message = error instanceof Error ? error.message : "Health check failed";
        const timedOut =
          (error instanceof Error && error.name === "AbortError") ||
          /timed out|timeout|ETIMEDOUT|EAI_AGAIN/i.test(message);
        result = {
          poolId,
          status: timedOut ? "timeout" : "unhealthy",
          latencyMs,
          errorMessage: message,
        };
      }
    }
    // Manual probes update check diagnostics, not dispatch-health state.
    // Metered bytes ride along in the same write: the probe does not add a
    // second UPDATE, it just banks whatever the sockets tallied since the
    // last pool-touching write.
    const now = new Date();
    const delta = drainPoolByteDelta(poolId);
    await this.db
      .update(networkPools)
      .set({
        lastHealthCheckAt: now,
        lastLatencyMs: result.latencyMs ?? null,
        // The outcome is the last known state, so it has to live on the row.
        // A browser cache cannot: it dies with the browser, and another
        // machine never sees it.
        ...(result.status === "healthy" || result.status === "reachable"
          ? { lastSuccessAt: now, lastError: null, lastErrorCategory: null, lastErrorAt: null }
          : {
              lastError: result.errorMessage ?? result.status,
              lastErrorCategory: result.status,
              lastErrorAt: now,
            }),
        // Keep the previous address when this probe could not read one.
        ...(result.egressIp ? { egressIp: result.egressIp } : {}),
        ...(delta.sent > 0 || delta.received > 0
          ? {
              bytesSentTotal: sql`${networkPools.bytesSentTotal} + ${delta.sent}`,
              bytesReceivedTotal: sql`${networkPools.bytesReceivedTotal} + ${delta.received}`,
            }
          : {}),
      })
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
    if (result.httpStatus !== undefined) {
      await disablePoolForProxyHttpStatus(this.db, poolId, result.httpStatus);
    }
    return result;
  }
  /**
   * Measures download throughput by streaming a fixed payload through the pool.
   *
   * The transfer runs through the same SSRF-validated agent dispatch uses, so
   * a measurement cannot be taken over a path production would refuse. The
   * whole payload is pulled into memory (5 MB) — bounded by the endpoint's
   * fixed size, not by what the peer chooses to send.
   */
  async speedTest(tenantId: string, poolId: string, bytes: number): Promise<PoolSpeedTestResult> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .limit(1);
    if (!rows[0]) {
      return { poolId, status: "failed", bytes: 0, durationMs: 0, errorMessage: "Pool not found" };
    }
    // The measurement costs real bytes off the operator's proxy plan, so the
    // outcome is banked on the pool row (not only returned): the Proxy page
    // reads the last known throughput from the server after any reload.
    const persist = async (
      result: PoolSpeedTestResult & { egressIp?: string },
    ): Promise<PoolSpeedTestResult> => {
      const measuredAt = new Date();
      const delta = drainPoolByteDelta(poolId);
      await this.db
        .update(networkPools)
        .set({
          lastSpeedtestBytes: result.status === "ok" ? result.bytes : 0,
          lastSpeedtestDurationMs: result.durationMs,
          lastSpeedtestStatus: result.status,
          lastSpeedtestError: result.errorMessage ?? null,
          lastSpeedtestAt: measuredAt,
          // The Proxy page reads the egress address off the pool row, so a
          // measurement that read one banks it — otherwise the Test button
          // leaves the address column showing "not probed" forever.
          ...(result.egressIp ? { egressIp: result.egressIp } : {}),
          ...(delta.sent > 0 || delta.received > 0
            ? {
                bytesSentTotal: sql`${networkPools.bytesSentTotal} + ${delta.sent}`,
                bytesReceivedTotal: sql`${networkPools.bytesReceivedTotal} + ${delta.received}`,
              }
            : {}),
        })
        .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
      return { ...result, measuredAt: measuredAt.toISOString() };
    };
    let agent: PoolAgent;
    try {
      agent = await this.poolAgents.resolveAgent(poolId, tenantId);
    } catch (error) {
      return persist({
        poolId,
        status: "failed",
        bytes: 0,
        durationMs: 0,
        errorMessage: error instanceof Error ? error.message : "Failed to build pool agent",
      });
    }
    const started = performance.now();
    try {
      const response = await createValidatedFetch({ agent })(
        `${NETWORK_POOL_SPEED_TEST_URL}${bytes}`,
        { method: "GET", signal: AbortSignal.timeout(NETWORK_POOL_SPEED_TEST_TIMEOUT_MS) },
      );
      if (!response.ok) {
        return persist({
          poolId,
          status: "failed",
          bytes: 0,
          durationMs: Math.round(performance.now() - started),
          errorMessage: `HTTP ${response.status} from speed endpoint`,
        });
      }
      const payload = await response.arrayBuffer();
      // Stop the clock after the body is fully read: a stalled tail is part of
      // the throughput, so timing only the response headers would flatter a
      // slow tunnel.
      const durationMs = Math.round(performance.now() - started);
      const transferred = payload.byteLength;
      // The speed-test download itself is metered traffic through the pool, so
      // it is counted before banking: the quota bar must include the bytes the
      // measurement consumed.
      recordPoolBytes(poolId, "received", transferred);
      // Read the egress address only after the clock has stopped. The speed
      // payload carries no address of its own, so the probe uses the same
      // canary a health check dials; doing it after the timing means the
      // measurement still covers the download alone. A failure here is not a
      // failed speed test — it only costs the address.
      const egressIp = await this.readEgressIp(agent);
      if (durationMs <= 0)
        return persist({ poolId, status: "ok", bytes: transferred, durationMs, ...(egressIp ? { egressIp } : {}) });
      const bytesPerSecond = transferred / (durationMs / 1000);
      return persist({
        poolId,
        status: "ok",
        bytes: transferred,
        durationMs,
        bytesPerSecond,
        megabitsPerSecond: (bytesPerSecond * 8) / 1_000_000,
        ...(egressIp ? { egressIp } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speed test failed";
      return persist({
        poolId,
        status: "failed",
        bytes: 0,
        durationMs: Math.round(performance.now() - started),
        errorMessage: message,
      });
    }
  }
  /**
   * Dials a public canary through an unsaved pool definition.
   *
   * Every `TransportKind` dials directly and gets a real end-to-end probe: an
   * http/https/socks5 pool tunnels to the canary — a hosted relay front door
   * answers the canary through its own header relay — so a passing probe
   * always means real traffic reached the canary through the configured egress.
   * (A former daemon-backed kind returned a fabricated `"healthy"` here because
   * its activation happened on save; with that flavor removed, a pass is real.)
   */
  async probeAdHoc(
    _tenantId: string,
    request: CreateNetworkPoolRequest,
  ): Promise<HealthCheckResult> {
    const started = performance.now();
    try {
      const rawEndpoint = request.endpoint.includes("://") ? request.endpoint : `${request.kind}://${request.endpoint}`;
      const agent =
        request.kind === "socks5"
          ? createSocks5Agent(rawEndpoint, request.credential, this.ssrfPolicy)
          : createHttpProxyAgent(rawEndpoint, request.credential, this.ssrfPolicy);
      const { response, latencyMs, egressIp } = await this.dialPoolCanary(agent);
      const result = classifyPoolProbeResponse("adhoc", response, latencyMs);
      return egressIp ? { ...result, egressIp } : result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Probe failed";
      return {
        poolId: "adhoc",
        status: "unhealthy",
        latencyMs: Math.round(performance.now() - started),
        errorMessage: message,
      };
    }
  }
}
