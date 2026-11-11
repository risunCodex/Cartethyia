// Network-pool control-plane operations: the store-backed mutations and reads
// behind the routes. Depends only on the contracts and the shared helpers;
// `routes.ts` is the only HTTP surface.
import { ConsoleDomainError, requireTenantScope } from "../../shared/errors";
import { providerRateLimitIsIpScoped } from "../../../providers/provider-metadata";
import { resolvePoolProviderRateLimitCooldownMs } from "../../../config/cooldowns";
import type { PoolHealthEvent } from "../../../network/pool/health";
import type { AccessDecision } from "../../../security/access-control";
import {
  deployRelay as deployRelayWorker,
  isRelayTarget,
  type RelayDeployRequest,
} from "./relay-deploy";
import { parseProxyFile } from "./import-parse";
import { SPEED_TEST_MAX_BYTES, SPEED_TEST_MIN_BYTES } from "./speed-test-sizes";
import {
  MAX_BATCH_PROBE_TARGETS,
  PROVIDER_PROBE_BATCH_CONCURRENCY,
  POOL_BATCH_PROBE_CONCURRENCY,
  POOL_ROUTING_STRATEGIES,
  normalizePoolConfig,
  sanitizePoolResponse,
  validateEndpoint,
  validatePoolLimits,
  validateTransportConfig,
  type CreateNetworkPoolRequest,
  type HealthCheckResult,
  type PoolBatchProviderProbeResult,
  type PoolProviderProbeResult,
  type NetworkPoolConfig,
  type NetworkPoolRecord,
  type NetworkPoolResponse,
  type PoolStatus,
  type PoolBatchProbeResult,
  type PoolSpeedTestResult,
  type PoolStrategySetting,
} from "./contracts";

/**
 * Whether a provider entry is a retired egress rather than a refilling
 * allowance. Read from the stored flag, never from the duration.
 */
function isBlockedEntry(entry: { readonly blocked?: boolean }): boolean {
  return entry.blocked === true;
}

export function createNetworkPoolOperations(config: NetworkPoolConfig) {
  /**
   * The read-only enrichment projection shared by the pool list and the pool
   * detail page: live inflight (falling back to the stored row counter when no
   * selector is configured), the derived available/utilization figures, and the
   * active provider cooldowns (omitted entirely when there are none).
   */
  async function enrichPoolResponse(res: NetworkPoolResponse, poolId: string): Promise<NetworkPoolResponse> {
    const cooldowns = await config.poolSelector?.getPoolCooldowns(poolId);
    const inflight = config.poolSelector
      ? await config.poolSelector.getInflightAuthoritative(poolId)
      : res.inflight;
    return {
      ...res,
      inflight,
      available: Math.max(0, res.maxInflight - inflight),
      utilization: res.maxInflight > 0 ? Math.min(1, inflight / res.maxInflight) : 1,
      ...(cooldowns && cooldowns.length > 0
        ? {
            providerCooldowns: cooldowns.map((c) => ({
              providerId: c.providerId,
              until: new Date(c.until).toISOString(),
              reason: c.reason,
              blocked: isBlockedEntry(c),
            })),
          }
        : {}),
    };
  }

  const operations = {
    async listPools(access: AccessDecision | undefined): Promise<NetworkPoolResponse[]> {
        const a = requireTenantScope(access, "dashboard:read");
        const rawPools = await config.store.list(a.tenantId);
        return Promise.all(rawPools.map(async (r) => enrichPoolResponse(sanitizePoolResponse(r), r.id)));
      },
    async getPoolDetail(
        access: AccessDecision | undefined,
        poolId: string,
      ): Promise<NetworkPoolResponse> {
        const a = requireTenantScope(access, "dashboard:read");
        const rec = await config.store.get(a.tenantId, poolId);
        if (!rec) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
        return enrichPoolResponse(sanitizePoolResponse(rec), poolId);
      },
    async clearPoolCooldown(
        access: AccessDecision | undefined,
        poolId: string,
        providerId?: string,
      ): Promise<{ success: boolean }> {
        requireTenantScope(access, "dashboard:write");
        if (providerId) {
          await config.poolSelector?.clearProviderCooldown(poolId, providerId);
        } else {
          const active = await config.poolSelector?.getPoolCooldowns(poolId);
          if (active) {
            for (const c of active) {
              await config.poolSelector?.clearProviderCooldown(poolId, c.providerId);
            }
          }
        }
        return { success: true };
      },
    async getStrategy(access: AccessDecision | undefined): Promise<PoolStrategySetting> {
        const a = requireTenantScope(access, "dashboard:read");
        return config.store.getStrategy(a.tenantId);
      },
    async updateStrategy(
        access: AccessDecision | undefined,
        request: Partial<PoolStrategySetting>,
      ): Promise<PoolStrategySetting> {
        const a = requireTenantScope(access, "dashboard:write");
        const current = await config.store.getStrategy(a.tenantId);
        const strategy = request.strategy ?? current.strategy;
        // Runtime check despite the type: the HTTP body is cast at the route
        // boundary, so a hand-crafted request can carry any string here.
        if (!POOL_ROUTING_STRATEGIES.includes(strategy)) {
          throw new ConsoleDomainError("invalid_pool", 400, "Pool strategy is invalid");
        }
        const rotateCount = request.rotateCount ?? current.rotateCount;
        if (!Number.isInteger(rotateCount) || rotateCount < 1 || rotateCount > 1000) {
          throw new ConsoleDomainError(
            "invalid_pool",
            400,
            "rotateCount must be an integer between 1 and 1000",
            { field: "rotateCount" },
          );
        }
        const saved = await config.store.setStrategy(a.tenantId, { strategy, rotateCount });
        await config.auditSink?.record({
          access: a,
          action: "network_pool.strategy_updated",
          target: a.tenantId,
          detail: { strategy: saved.strategy, rotateCount: saved.rotateCount },
        });
        await config.snapshotInvalidator?.invalidate();
        return saved;
      },
    async importPools(
      access: AccessDecision | undefined,
      request: {
        readonly content: string;
        readonly maxInflight?: number | undefined;
        readonly weight?: number | undefined;
        readonly family?: string | null | undefined;
        readonly labelPrefix?: string | undefined;
      },
    ): Promise<{ created: number; skipped: readonly { line: number; reason: string }[] }> {
      const a = requireTenantScope(access, "dashboard:write");
      const parsed = parseProxyFile(request.content);
      const skipped = [...parsed.skipped];
      let created = 0;
      for (const [index, row] of parsed.rows.entries()) {
        try {
          await operations.createPool(a, {
            kind: row.kind,
            endpoint: row.endpoint,
            ...(row.credential === null ? {} : { credential: row.credential }),
            ...(request.maxInflight === undefined ? {} : { maxInflight: request.maxInflight }),
            ...(request.weight === undefined ? {} : { weight: request.weight }),
            ...(request.family === undefined ? {} : { family: request.family }),
            ...(row.label !== null
              ? { label: row.label }
              : request.labelPrefix
                ? { label: `${request.labelPrefix} ${index + 1}` }
                : {}),
          });
          created += 1;
        } catch (error) {
          // One bad node must not abort the list: the rest are still worth
          // having, and the reason is reported against its own line.
          skipped.push({
            line: index + 1,
            reason: error instanceof Error ? error.message.slice(0, 160) : "rejected",
          });
        }
      }
      return { created, skipped };
    },
    async createPoolBatch(
      access: AccessDecision | undefined,
      requests: readonly CreateNetworkPoolRequest[],
    ): Promise<{ created: NetworkPoolResponse[]; failed: number }> {
      const a = requireTenantScope(access, "dashboard:write");
      let failed = 0;
      const records: NetworkPoolRecord[] = [];
      for (const request of requests) {
        try {
          const normalizedConfig = normalizePoolConfig(request.config);
          const endpoint = request.endpoint;
          validateEndpoint(request.kind, endpoint, config.ssrfPolicy);
          validateTransportConfig(request.kind, normalizedConfig);
          validatePoolLimits(request.maxInflight, request.weight);
          records.push({
            id: crypto.randomUUID(),
            kind: request.kind,
            endpoint,
            maxInflight: request.maxInflight ?? 10,
            weight: request.weight ?? 100,
            status: "active",
            inflight: 0,
            consecutiveFailures: 0,
            tenantId: a.tenantId,
            createdAt: new Date().toISOString(),
            ...(request.label === undefined ? {} : { label: request.label }),
            ...(Object.keys(normalizedConfig).length > 0 ? { config: normalizedConfig } : {}),
            ...(request.credential === undefined ? {} : { credential: request.credential }),
            ...(request.credential !== undefined ? { hasCredential: true } : {}),
            ...(typeof request.quotaBytes === "number" ? { quotaBytes: request.quotaBytes } : {}),
            ...(request.family === undefined ? {} : { family: request.family }),
          });
        } catch {
          failed += 1;
        }
      }
      // All rows land in one statement: a long paste was one round trip per
      // proxy, which made a 40-line import take minutes.
      let created: NetworkPoolResponse[] = [];
      if (records.length > 0) {
        if (config.store.createMany) {
          await config.store.createMany(records);
        } else {
          for (const record of records) await config.store.create(record);
        }
        created = records.map((record) => sanitizePoolResponse(record));
        await config.auditSink?.record({
          access: a,
          action: "network_pool.created",
          target: created[0]!.id,
          detail: { count: created.length, failed },
        });
        await config.snapshotInvalidator?.invalidate();
      }
      return { created, failed };
    },
    async deletePoolBatch(
      access: AccessDecision | undefined,
      poolIds: readonly string[],
    ): Promise<{ deleted: number; failed: number }> {
      const a = requireTenantScope(access, "dashboard:write");
      let ok = 0;
      if (config.store.deleteMany) {
        ok = await config.store.deleteMany(a.tenantId, poolIds);
      } else {
        for (const poolId of poolIds) {
          try {
            if (await config.store.delete(a.tenantId, poolId)) ok += 1;
          } catch {
            // Missing rows are not failures for a bulk delete.
          }
        }
      }
      // Cooldown markers and cached agents are best-effort here: the rows are
      // already gone, so a failed cleanup must not report a failed delete.
      await Promise.all(
        poolIds.map(async (poolId) => {
          await config.poolAgentReleaser?.releasePool(poolId, a.tenantId).catch(() => undefined);
          await config.poolSelector?.clearPoolCooldowns(poolId).catch(() => undefined);
        }),
      );
      await config.auditSink?.record({
        access: a,
        action: "network_pool.deleted",
        target: poolIds[0] ?? "",
        detail: { count: ok, failed: poolIds.length - ok },
      });
      if (ok > 0) await config.snapshotInvalidator?.invalidate();
      return { deleted: ok, failed: poolIds.length - ok };
    },
    async setPoolStatusBatch(
      access: AccessDecision | undefined,
      poolIds: readonly string[],
      status: PoolStatus,
    ): Promise<{ updated: number }> {
      const a = requireTenantScope(access, "dashboard:write");
      let updated = 0;
      if (config.store.updateManyStatus) {
        updated = await config.store.updateManyStatus(a.tenantId, poolIds, status);
      } else {
        for (const poolId of poolIds) {
          try {
            if (await config.store.update(a.tenantId, poolId, { status })) updated += 1;
          } catch {
            // Missing rows are not failures for a bulk status change.
          }
        }
      }
      // Any mutation can invalidate the cached dial agent; the batch releases
      // each selected pool's agent so the next dispatch rebuilds fresh.
      await Promise.all(
        poolIds.map(async (poolId) => {
          await config.poolAgentReleaser?.releasePool(poolId, a.tenantId).catch(() => undefined);
        }),
      );
      await config.auditSink?.record({
        access: a,
        action: "network_pool.updated",
        target: poolIds[0] ?? "",
        detail: { status, count: updated },
      });
      if (updated > 0) await config.snapshotInvalidator?.invalidate();
      return { updated };
    },
    async createPool(
        access: AccessDecision | undefined,
        request: CreateNetworkPoolRequest,
      ): Promise<NetworkPoolResponse> {
        const a = requireTenantScope(access, "dashboard:write");
        const normalizedConfig = normalizePoolConfig(request.config);
        const endpoint = request.endpoint;
        validateEndpoint(request.kind, endpoint, config.ssrfPolicy);
        validateTransportConfig(request.kind, normalizedConfig);
        validatePoolLimits(request.maxInflight, request.weight);
        const record: NetworkPoolRecord = {
          id: crypto.randomUUID(),
          kind: request.kind,
          endpoint,
          maxInflight: request.maxInflight ?? 10,
          weight: request.weight ?? 100,
          status: "active",
          inflight: 0,
          consecutiveFailures: 0,
          tenantId: a.tenantId,
          createdAt: new Date().toISOString(),
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(Object.keys(normalizedConfig).length > 0 ? { config: normalizedConfig } : {}),
          ...(request.credential === undefined ? {} : { credential: request.credential }),
          ...(request.credential !== undefined ? { hasCredential: true } : {}),
          // Absent or `null` both mean unmetered; a positive number is the
          // allowance. The body schema already rejects zero and negatives.
          ...(typeof request.quotaBytes === "number" ? { quotaBytes: request.quotaBytes } : {}),
          ...(request.family === undefined ? {} : { family: request.family }),
        };
        await config.store.create(record);
        await config.auditSink?.record({
          access: a,
          action: "network_pool.created",
          target: record.id,
          detail: { kind: record.kind, hasCredential: record.hasCredential === true },
        });
        await config.snapshotInvalidator?.invalidate();
        return sanitizePoolResponse(record);
      },
    async updatePool(
        access: AccessDecision | undefined,
        poolId: string,
        request: Partial<CreateNetworkPoolRequest>,
      ): Promise<NetworkPoolResponse> {
        const a = requireTenantScope(access, "dashboard:write");
        validatePoolLimits(request.maxInflight, request.weight);
        if (
          request.endpoint !== undefined ||
          request.kind !== undefined ||
          request.config !== undefined
        ) {
          const existing = await config.store.get(a.tenantId, poolId);
          if (!existing) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
          const effectiveKind = request.kind ?? existing.kind;
          const effectiveEndpoint = request.endpoint ?? existing.endpoint;
          const mergedConfig = { ...(existing.config ?? {}), ...(request.config ?? {}) };
          const normalizedConfig = normalizePoolConfig(mergedConfig);
          validateEndpoint(effectiveKind, effectiveEndpoint, config.ssrfPolicy);
          validateTransportConfig(effectiveKind, normalizedConfig);
          request = { ...request, endpoint: effectiveEndpoint, config: normalizedConfig };
          // A changed endpoint is a different egress address, so its cooldowns
          // — like its probe verdict — no longer describe this pool. Drop the
          // durable markers with the volatile ones, or a replaced proxy would
          // come back online and immediately be skipped because the previous
          // address's flags were restored at boot.
          if (request.endpoint !== undefined && request.endpoint !== existing.endpoint) {
            await config.poolSelector?.clearPoolCooldowns(poolId).catch(() => undefined);
            await config.store.dropAllProviderCooldownMarkers?.(a.tenantId, poolId);
          }
        }
        const updated = await config.store.update(
          a.tenantId,
          poolId,
          request as Partial<NetworkPoolRecord>,
        );
        if (!updated) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
        // Any mutation can invalidate the cached dial agent (endpoint, credential,
        // kind, config, or a disable via status) — release unconditionally so the
        // next dispatch rebuilds against the fresh row rather than reusing a
        // stale agent/delegate bound to the pre-update configuration.
        await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
        await config.auditSink?.record({
          access: a,
          action: "network_pool.updated",
          target: poolId,
          detail: { fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        return sanitizePoolResponse(updated);
      },
    async deletePool(
        access: AccessDecision | undefined,
        poolId: string,
      ): Promise<{ success: boolean }> {
        const a = requireTenantScope(access, "dashboard:write");
        const ok = await config.store.delete(a.tenantId, poolId);
        if (!ok) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
        await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
        // Drop the pool's cooldown markers and their index set with it. Without
        // this the Redis keys outlive the row, so a pool later reusing the id
        // inherits cooldowns it never earned — and the index set, which has no
        // TTL of its own, would keep listing them.
        await config.poolSelector?.clearPoolCooldowns(poolId);
        await config.auditSink?.record({
          access: a,
          action: "network_pool.deleted",
          target: poolId,
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async listPoolHealthEvents(
      access: AccessDecision | undefined,
      poolId: string,
    ): Promise<readonly PoolHealthEvent[]> {
      const a = requireTenantScope(access, "dashboard:read");
      return config.store.listHealthEvents(a.tenantId, poolId);
    },
    async recoverPool(
      access: AccessDecision | undefined,
      poolId: string,
    ): Promise<{ success: true }> {
      const a = requireTenantScope(access, "dashboard:write");
      const recovered = await config.store.recover(a.tenantId, poolId);
      if (!recovered) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
      // Recover is the operator's "make this pool healthy again": besides
      // resetting the pool-level state, drop every provider-rate-limit marker
      // (volatile and durable) so a just-cleared pool is not still excluded
      // by a stale 429 flag.
      await config.poolSelector?.clearPoolCooldowns(poolId).catch(() => undefined);
      await config.store.dropAllProviderCooldownMarkers?.(a.tenantId, poolId);
      await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
      await config.auditSink?.record({
        access: a,
        action: "network_pool.recovered",
        target: poolId,
      });
      await config.snapshotInvalidator?.invalidate();
      return { success: true };
    },
    async healthCheck(
        access: AccessDecision | undefined,
        poolId: string,
      ): Promise<HealthCheckResult> {
        const a = requireTenantScope(access, "dashboard:read");
        const result = await config.store.healthCheck(a.tenantId, poolId);
        if (result.httpStatus !== undefined) {
          await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
          await config.snapshotInvalidator?.invalidate();
        }
        return result;
      },
    /**
     * Measures download throughput through one saved pool.
     *
     * Read-scoped like the health check: it dials the tenant's own pool and
     * changes no state. A pool that cannot be dialed reports `failed` rather
     * than throwing, so a batch of these returns a per-pool verdict.
     */
    async speedTest(
      access: AccessDecision | undefined,
      poolId: string,
      bytes: number,
    ): Promise<PoolSpeedTestResult> {
      const a = requireTenantScope(access, "dashboard:read");
      if (!config.store.speedTest) {
        throw new ConsoleDomainError("capability_unsupported", 400, "Speed tests are unavailable");
      }
      if (!Number.isInteger(bytes) || bytes < SPEED_TEST_MIN_BYTES || bytes > SPEED_TEST_MAX_BYTES) {
        throw new ConsoleDomainError(
          "invalid_speed_test_size",
          422,
          `Payload must be between ${SPEED_TEST_MIN_BYTES} and ${SPEED_TEST_MAX_BYTES} bytes`,
        );
      }
      return config.store.speedTest(a.tenantId, poolId, bytes);
    },
    /**
     * Asks one provider whether it will serve traffic from this pool.
     *
     * Read-only by default: an operator testing a proxy wants to know its
     * state, not to change it. `block` is the explicit opt-in that also
     * retires the pool for that provider.
     */
    async providerProbe(
      access: AccessDecision | undefined,
      poolId: string,
      providerId: string,
    ): Promise<PoolProviderProbeResult> {
      const a = requireTenantScope(access, "dashboard:read");
      if (!config.store.providerProbe) {
        throw new ConsoleDomainError("capability_unsupported", 400, "Provider probing is unavailable");
      }
      const result = await config.store.providerProbe(a.tenantId, poolId, providerId);
      if (!config.poolSelector) return result;
      // The verdict *is* the enforcement. Storing it and leaving the pool in
      // rotation is what produced "I tested every pool, some are red, and it
      // still picked a red one": the red was a colour, not a decision.
      //
      // `blocked` retires the egress for this provider, so the next dispatch
      // skips it. `allowed` clears a previous block, because the address is
      // serving again — an operator who replaced a proxy must not have to find
      // a separate button to un-retire it.
      //
      // `blocked` retires the egress — but only for a provider whose limits
      // follow the address. `flagProviderBlocked` refuses everyone else, so the
      // verdict reported back is what actually happened, not what was asked.
      if (result.status === "blocked") {
        const entry = await config.poolSelector.flagProviderBlocked(
          poolId,
          providerId,
          "Upstream refused this egress address",
        );
        if (entry.blocked === true) {
          // The retirement claim lands in the mirror and the health history
          // with its provider named, like every other verdict — an enforced
          // state the operator cannot see is the "colour, not a decision"
          // failure mode again.
          await config.store.recordProviderProbeCooldown?.(a.tenantId, poolId, providerId, {
            until: entry.until,
            reason: entry.reason,
            blocked: true,
          });
        }
        return { ...result, blockedPool: entry.blocked === true };
      }
      // A measured success releases the address — in rotation and in the
      // durable mirror the next boot restores from.
      if (result.status === "allowed") {
        await config.poolSelector.clearProviderCooldown(poolId, providerId);
        await config.store.dropProviderCooldownMarker?.(a.tenantId, poolId, providerId, false);
        return { ...result, blockedPool: false };
      }
      // `throttled` (429) proves the address is *serving* — its rate limiter
      // answered — so a stale "retired" claim is corrected. And the throttle
      // itself is a measurement: the egress just demonstrated it is out of
      // allowance, which is exactly when dispatch should skip it **and** the
      // operator sees why. Flag the same (configured) window a dispatch-side
      // 429 would, in rotation memory *and* in the durable mirror, plus the
      // health event the activity panel lists. Only a 429 gap was leaving a
      // rate-limited pool invisible and unflagged.
      if (result.status === "throttled") {
        await config.poolSelector.clearProviderBlockedOnly(poolId, providerId);
        await config.store.dropProviderCooldownMarker?.(a.tenantId, poolId, providerId, true);
        if (providerRateLimitIsIpScoped(providerId)) {
          const durationMs = resolvePoolProviderRateLimitCooldownMs();
          const reason = "Operator probe measured a provider 429";
          await config.poolSelector.flagProviderCooldown(poolId, providerId, durationMs, reason);
          await config.store.recordProviderProbeCooldown?.(a.tenantId, poolId, providerId, {
            until: Date.now() + durationMs,
            reason,
          });
        }
      }
      // `unreachable` learned nothing about the address, so nothing changes.
      return { ...result, blockedPool: false };
    },
    /**
     * Probes many unsaved pool definitions against one provider.
     *
     * Same shape and bounds as `probeAdHocPoolBatch`: the add form tests a
     * pasted list before saving it, and a per-endpoint verdict is what it
     * prints. A single failing probe becomes that endpoint's result rather
     * than failing the batch.
     */
    async probeAdHocProviderBatch(
      access: AccessDecision | undefined,
      requests: readonly CreateNetworkPoolRequest[],
      providerId: string,
    ): Promise<readonly PoolBatchProviderProbeResult[]> {
      const a = requireTenantScope(access, "dashboard:read");
      if (requests.length === 0) return [];
      if (requests.length > MAX_BATCH_PROBE_TARGETS) {
        throw new ConsoleDomainError(
          "batch_too_large",
          422,
          `At most ${MAX_BATCH_PROBE_TARGETS} targets per batch`,
        );
      }
      if (!config.store.probeAdHocProvider) {
        throw new ConsoleDomainError("capability_unsupported", 400, "Provider probing is unavailable");
      }
      const probe = config.store.probeAdHocProvider.bind(config.store);
      const results: PoolBatchProviderProbeResult[] = new Array(requests.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < requests.length) {
          const index = cursor++;
          const request = requests[index]!;
          let result: PoolProviderProbeResult;
          try {
            result = await probe(a.tenantId, request, providerId);
          } catch (error) {
            result = {
              poolId: request.endpoint,
              providerId,
              status: "unreachable",
              reason: error instanceof Error ? error.message : "Probe failed",
            };
          }
          results[index] = { endpoint: request.endpoint, result };
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PROVIDER_PROBE_BATCH_CONCURRENCY, requests.length) }, () => worker()),
      );
      return results;
    },
    async probeAdHocPool(
      access: AccessDecision | undefined,
      request: CreateNetworkPoolRequest,
    ): Promise<HealthCheckResult> {
      const a = requireTenantScope(access, "dashboard:read");
      if (config.store.probeAdHoc) {
        return config.store.probeAdHoc(a.tenantId, request);
      }
      throw new ConsoleDomainError("capability_unsupported", 400, "Ad-hoc pool probing is unavailable");
    },
    /**
     * Probes many unsaved pool definitions in one call.
     *
     * The dashboard tests a pasted list before saving it; doing that one
     * request per proxy made a 100-line paste take a minute. The dials still
     * happen individually — only the round-trips are batched — and run with
     * bounded concurrency so a large list does not open every socket at once.
     */
    async probeAdHocPoolBatch(
      access: AccessDecision | undefined,
      requests: readonly CreateNetworkPoolRequest[],
    ): Promise<readonly PoolBatchProbeResult[]> {
      const a = requireTenantScope(access, "dashboard:read");
      if (requests.length === 0) return [];
      if (requests.length > MAX_BATCH_PROBE_TARGETS) {
        throw new ConsoleDomainError(
          "batch_too_large",
          422,
          `At most ${MAX_BATCH_PROBE_TARGETS} targets per batch`,
        );
      }
      if (!config.store.probeAdHoc) {
        throw new ConsoleDomainError("capability_unsupported", 400, "Ad-hoc pool probing is unavailable");
      }
      const probe = config.store.probeAdHoc.bind(config.store);
      const results: PoolBatchProbeResult[] = new Array(requests.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < requests.length) {
          const index = cursor++;
          const request = requests[index]!;
          // A single failing probe must not fail the batch: the caller wants a
          // per-endpoint verdict, so an error becomes that endpoint's result.
          let result: HealthCheckResult;
          try {
            result = await probe(a.tenantId, request);
          } catch (error) {
            result = {
              poolId: request.endpoint,
              status: "unhealthy",
              errorMessage: error instanceof Error ? error.message : "Probe failed",
            };
          }
          results[index] = { endpoint: request.endpoint, kind: request.kind, result };
        }
      };
      const workers = Array.from(
        { length: Math.min(POOL_BATCH_PROBE_CONCURRENCY, requests.length) },
        () => worker(),
      );
      await Promise.all(workers);
      return results;
    },
    /**
     * Deploys a hosted relay (Cloudflare/Vercel/Deno) and registers its URL as
     * an active HTTP pool. The provider API token is used for the deploy and
     * never persisted; the relay URL is a public host, which is what the pool
     * stores. The deploy fetch is the SSRF-validated one, so the provider API
     * call is checked like every other egress.
     */
    async deployRelay(
      access: AccessDecision | undefined,
      request: RelayDeployRequest,
    ): Promise<NetworkPoolResponse & { relayUrl: string }> {
      const a = requireTenantScope(access, "dashboard:write");
      if (!config.relayFetch)
        throw new ConsoleDomainError("capability_unsupported", 503, "Relay deployment is unavailable");
      if (!isRelayTarget(request.target))
        throw new ConsoleDomainError("invalid_request", 422, `Unsupported relay target: ${String(request.target)}`);
      const result = await deployRelayWorker(config.relayFetch, request);
      const created = await operations.createPool(access, {
        kind: "http",
        endpoint: result.relayUrl,
        label: request.projectName?.trim() || `${result.target} relay`,
      });
      await config.auditSink?.record({
        access: a,
        action: "network_pool.relay_deployed",
        target: created.id,
        detail: { target: result.target, relayUrl: result.relayUrl },
      });
      return { ...created, relayUrl: result.relayUrl };
    },
  };
  return operations;
}
