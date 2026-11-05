
import { assertPoolFitsServerCapacity, bootDatabase, ensureMigrated } from "../persistence/boot";
import { poolMaxFromEnv } from "../persistence/db-pg";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { resolveRedisBackend, resolveRedisClient } from "../persistence/redis";
import { resolveProcessTopology, type ProcessTopology } from "../config/runtime";
import { withTimeout } from "./timeout";
import { createRedisMaintenanceLeaseStore } from "../workers/maintenance-lease";
import { resolveDbMode } from "../persistence/db-mode";
import type { RedisClient } from "../persistence/redis";
import {
  bundledModelCatalog,
  liveProviderUpstreamHosts,
  refreshActiveProviderCatalogs,
  registerByokProviders,
  retireUnbundledProviders,
  seedBundledProviders,
} from "../providers/operations/provider-catalog-service";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import { createDefaultProviderRegistry } from "../providers/default-registry";
import { OAuthRefreshService, loadDueOAuthAccounts, reconcileStaticTokenAccounts } from "../providers/authentication/oauth-refresh-service";
import type { OAuthTokenRefresher } from "../providers/authentication/oauth-refresh-service";
import { oauthRefreshSweep } from "../workers/oauth-refresh-sweep";
import { accountIdentitySweep } from "../workers/account-identity-sweep";
import { pushStructuredConsoleLog } from "../observability/log-ring";
import { createDatabaseSnapshotBuilder } from "../transport/routing/route-catalog";
import { DrizzleProviderCatalogStore } from "../console/providers/catalog/store";
import { InMemoryRouteSnapshotService } from "../transport/routing/route-model";
import { RoutingEngine } from "../transport/routing/router";
import { RedisAdmissionController } from "../transport/routing/admission";
import { admissionKey } from "../transport/routing/admission";
import { ApiKeyAdmissionService } from "../security/admission/service";
import { InMemoryAdmissionCounterStore } from "../security/admission/in-memory-store";
import { RedisAdmissionCounterStore } from "../security/admission/redis-store";
import { sweepLeases } from "../security/admission/lease-sweep";
import { DrizzleApiKeyStore } from "../persistence/stores/api-key-store";
import { UsageFlushBuffer } from "../persistence/usage-flush";
import { setPendingUsageSource } from "../security/api-key-auth";
import { HealthEventFlushBuffer, setHealthEventBuffer } from "../persistence/health-event-flush";
import { subscribePeerSettingsRevisions } from "../persistence/settings-revision";
import { deleteExpiredSessions } from "../console/auth/session-service";
import { InMemoryIpAbuseStore, IpAbuseProtectionService, RedisIpAbuseStore, type IpAbuseStore } from "../security/abuse";
import { checkReadiness } from "../persistence/readiness";
import { ProxyRequestPreparer } from "../transport/request/preparer";
import { DrizzleNetworkPoolLoader } from "../network/pool/loader";
import {
  PoolAgentResolver,
  ValidatedNetworkBindingFactory,
} from "../network/pool/resolver";
import { NetworkPoolSelector } from "../network/pool/selector";
import { restorePoolProbeVerdicts, restoreProviderCooldownMarkers } from "../network/pool-cooldown-store";
import { ScheduledTaskRegistry } from "../workers/scheduler";
import { quotaRefreshSweep } from "../workers/quota-refresh-sweep";
import { registerZcodeGiftClaimTask } from "../workers/zcode-gift-claim";
import { markProviderApiKeyCredential } from "../console/quota/account-quota-shared";
import { dailyCheckinEgressForPass } from "../workers/daily-checkin";
import {
  buddyAdoptTask,
  buddyActivityReportTask,
  buddyStreakTask,
  syncBuddyUsage,
} from "../workers/buddy-growth-tasks";
import { createAccountSecretResolver } from "../providers/operations/provider-credential-service";
import { quotaCacheSize } from "../providers/quota/cache";
import { modelCatalogCacheSize } from "../providers/operations/model-catalog-cache";
import { preferencesReaderFor } from "../persistence/tenant-preferences";
import { sweepExpiredCooldowns } from "../providers/operations/account-health-service";
import { DrizzleTelemetryStore } from "../persistence/stores/telemetry-store";
import { TelemetryPayloadCapture } from "../observability/payload-capture";
import { sweepExpiredPoolCooldowns } from "../network/pool-health-machine";
import { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import { RuntimeMetricsSampler } from "../observability/runtime-metrics";
import {
  resolveIpRateLimit,
} from "../config/security";
import { resolveSsrfPolicy, resolveTrustedProxyBoundary } from "../config/network";
import type { TrustedProxyBoundary } from "../config/network";
import { resolveTelemetryRetentionDays } from "../config/telemetry";
import { resolveConcurrencyTolerance } from "../config/resources";
import { CONFIG_SPEC, readInt, readList } from "../config/spec";
import type { ProviderAdapter } from "../providers/provider-contracts";
import type { ProviderRegistry } from "../providers/provider-registry";
import type { ByokUpstreamHost } from "../providers/operations/provider-catalog-service";
import type { ReadinessCheckResult } from "../persistence/readiness";
import { log } from "../observability/logger";
import { refreshProviderClientVersions } from "../providers/operations/client-versions";
import type { ModelDefinition } from "../providers/provider-model-definition";


export interface ProductionDeps {
  db: CartethyiaDatabase;
  redis: RedisClient | undefined;
  snapshotService: InMemoryRouteSnapshotService;
  /** Live routing admission snapshot scoped to one provider/tenant for console reads. */
  readRoutingAccountInflight: (
    providerId: string,
    tenantId: string | null,
  ) => Promise<readonly { accountId: string; inflight: number }[]>;
  /** On-demand adapter resolution keeps heavy providers out of the boot path. */
  resolveProviderAdapter: (providerId: string) => Promise<ProviderAdapter | undefined>;
  bundledModelCatalog: BundledProviderCatalog;
  /** Live lookup of a provider's SSRF-validated upstream host. */
  byokUpstreamHosts: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
  proxyPreparer: ProxyRequestPreparer;
  networkBindingFactory: ValidatedNetworkBindingFactory;
  ipAbuseProtection: IpAbuseProtectionService;
  /** The abuse store backing manual IP bans and the ban list. */
  ipAbuseStore: IpAbuseStore;
  readiness: () => Promise<ReadinessCheckResult>;
  scheduledTasks: ScheduledTaskRegistry;
  poolAgentResolver: PoolAgentResolver;
  poolSelector: NetworkPoolSelector;
  telemetryBuffer: TelemetryBatchBuffer;
  usageFlush: UsageFlushBuffer;
  healthEventFlush: HealthEventFlushBuffer;
  trustedProxyBoundary: TrustedProxyBoundary;
  providerRegistry: ProviderRegistry;
  resolveOAuthRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  oauthRefreshService: OAuthRefreshService;
  admissionService: ApiKeyAdmissionService;
  /** Graduated strikes for repeated invalid-model requests. */
  /** Memory sampler; in-flight source is bound once the request store exists. */
  runtimeMetricsSampler: RuntimeMetricsSampler;
}

/**
 * Pause between accounts in the OAuth refresh sweep. The token endpoints
 * rate-limit a burst of refreshes even at low concurrency.
 */
const OAUTH_REFRESH_INTER_ITEM_DELAY_MS = 1_500;

/**
 * Client identities are refreshed out of band so provider dispatch never waits
 * on npm/provider version endpoints. Resolver TTLs deduplicate the sources.
 */
// Matched to the resolver's own 30 min cache TTL: a shorter interval makes
// every second pass a pure cache read that cannot discover anything new.
const CLIENT_VERSION_MONITOR_INTERVAL_MS = 30 * 60_000;
// B-05: first external fetch is pushed out to 90 s so the listener, the route
// snapshot warm, and the first-minute sweeps all settle first.
const CLIENT_VERSION_INITIAL_DELAY_MS = 90_000;

/** Bound on the boot-time Redis probe: a start must fail, not hang. */
const REDIS_PROBE_TIMEOUT_MS = 2_000;

/** Bounded Redis reachability probe: fails rather than hangs. */
async function redisIsReachable(): Promise<boolean> {
  const client = resolveRedisClient();
  if (!client) return false;
  try {
    const result = await withTimeout(client.ping(), REDIS_PROBE_TIMEOUT_MS);
    return result === "PONG";
  } catch {
    return false;
  }
}

/**
 * Refuses to start a multi-process deployment whose shared state is not
 * actually shared.
 *
 * Every process shares one port via `SO_REUSEPORT`, so the kernel balances
 * across them — and each process keeps its own in-memory admission counters,
 * quota cache, and cooldown map. Those are only correct when they live in
 * Redis. Starting anyway does not fail loudly; it enforces every per-key limit
 * N times over, which then reads as "the limit did not work".
 *
 * Redis is checked by PING with a hard bound, not merely for being configured:
 * a configured-but-unreachable Redis is the failure mode that matters, and an
 * unbounded connect at boot would hang the start instead of failing it.
 */
async function assertMultiProcessPreconditions(
  topology: ProcessTopology,
  redisReachable: () => Promise<boolean>,
): Promise<void> {
  if (!topology.multiProcess) return;
  if (process.platform !== "linux") {
    throw Object.assign(
      new Error(
        `CARTETHYIA_PROCESS_COUNT=${topology.count} requires Linux (SO_REUSEPORT); ` +
          `this process is on ${process.platform}`,
      ),
      { code: "multi_process_unsupported_platform" },
    );
  }
  if (resolveDbMode() !== "full") {
    throw Object.assign(
      new Error(
        `CARTETHYIA_PROCESS_COUNT=${topology.count} requires CARTETHYIA_DB_MODE=full (PostgreSQL); ` +
          "two processes on one SQLite file corrupt it — there is no cross-process lock in the driver",
      ),
      { code: "multi_process_requires_postgres" },
    );
  }
  const reachable = await redisReachable();
  if (!reachable) {
    throw Object.assign(
      new Error(
        `CARTETHYIA_PROCESS_COUNT=${topology.count} requires a REACHABLE Redis: admission counters, ` +
          "quotas, and cooldowns are per-process without one, so every per-key limit would be " +
          `enforced ${topology.count} times over`,
      ),
      { code: "multi_process_requires_redis" },
    );
  }
}

export async function buildProductionDeps(): Promise<ProductionDeps> {
  const startupStartedAt = performance.now();
  const startupMemoryBefore = process.memoryUsage();
  // Resolved first and validated before any connection is opened: a
  // half-configured multi-process deploy that starts anyway looks healthy
  // until a per-key limit is enforced N times over.
  const topology = resolveProcessTopology();
  await assertMultiProcessPreconditions(topology, redisIsReachable);
  const handle = await measureStartupPhase("database-connect", bootDatabase);
  const db = handle.db;
  // One rule, no mode flag: REDIS_URL set → shared client, unset → memory.
  const redis = resolveRedisClient();
  const ssrfPolicy = resolveSsrfPolicy();
  await measureStartupPhase("database-migrations", async () => {
    await ensureMigrated();
    // Pool sizing is an external-server concern; the embedded backend has no
    // connection budget to fit into.
    if (handle.kind === "pg") await assertPoolFitsServerCapacity(poolMaxFromEnv(), topology.count);
  });
  await measureStartupPhase("provider-seed", () => seedBundledProviders(db));
  // Boot-only: retire global rows for providers the bundle has dropped, so a
  // retired provider cannot linger as a card the console can no longer delete.
  // Kept off the test harness path, which shares one database across suites and
  // installs its own global fixtures.
  await measureStartupPhase("retired-provider-cleanup", () => retireUnbundledProviders(db));
  const registry = createDefaultProviderRegistry();
  // Live view, not a snapshot: custom providers registered after boot (or
  // edited from the console) must resolve their SSRF binding immediately.
  const byokUpstreamHosts = liveProviderUpstreamHosts(registry);
  await measureStartupPhase("byok-registration", () =>
    registerByokProviders(registry, db, ssrfPolicy),
  );
  // B-01: the bundled model catalog (73 providers' integration modules, ~the
  // largest pre-listen cost) is DEFERRED to the first snapshot build, which
  // runs right after listen (`main.ts` warms the snapshot). Every consumer
  // holds a reference to `bundledCatalogModels`, a shared map that starts
  // empty and is populated by the first resolution — the console store and
  // the inflight reader capture the map reference at construction, so once
  // the build fills it, all of them see the data. The snapshot builder's
  // refresh step seeds the DB from the same map (markCatalogSeeded semantics:
  // lastSeededCatalogRevision is -1 until the first build, so the first build
  // seeds exactly once and later rebuilds see an unchanged revision and skip).
  const bundledCatalogModels = new Map<string, readonly ModelDefinition[]>();
  let bundledCatalogResolved = false;
  const resolveBundledCatalog = async (): Promise<BundledProviderCatalog> => {
    if (bundledCatalogResolved) return { modelsByProvider: bundledCatalogModels };
    const catalog = await bundledModelCatalog(registry);
    for (const [providerId, models] of catalog.modelsByProvider) {
      bundledCatalogModels.set(providerId, models);
    }
    bundledCatalogResolved = true;
    return { modelsByProvider: bundledCatalogModels };
  };
  const snapshotService = new InMemoryRouteSnapshotService(
    createDatabaseSnapshotBuilder(db, async () => {
      // Compute the lazy catalog first so the refresh shares it and the DB
      // seed uses the same map the console reads (no second full walk).
      const catalog = await resolveBundledCatalog();
      await refreshActiveProviderCatalogs(db, registry, catalog);
    }),
  );
  const routingEngine = new RoutingEngine(
    redis ? new RedisAdmissionController(redis) : undefined,
    redis,
    db,
  );
  // Peer processes' settings mutations arrive here. Subscribed once for the
  // process: the revision counter is process-global, and the handler only
  // moves it forward.
  subscribePeerSettingsRevisions();
  const usageFlush = new UsageFlushBuffer(db);
  // Auth reads lifetime usage to seed the admission counter. The persisted
  // value lags by up to one flush interval, so hand it the in-flight deltas
  // too — otherwise the seed is systematically under what has actually been
  // spent, worst exactly when the key is busiest.
  setPendingUsageSource((apiKeyId) => usageFlush.pendingFor(apiKeyId));
  // Health audit rows are append-only and read by nobody in dispatch, so they
  // are buffered out of the request. The status write they accompany stays
  // synchronous — routing reads it.
  const healthEventFlush = new HealthEventFlushBuffer(db);
  setHealthEventBuffer(healthEventFlush);
  const admissionStore = redis
    ? new RedisAdmissionCounterStore(redis)
    : new InMemoryAdmissionCounterStore();
  const admissionService = new ApiKeyAdmissionService(
    admissionStore,
    undefined,
    // The per-tenant concurrency cap is a `console_settings` preference, read
    // on every admitted request. Reading it directly cost one Postgres round
    // trip per request (multiplied by each failover candidate); the shared
    // revision-keyed reader answers from memory and converges the moment an
    // operator saves, because `DrizzleRuntimeSettingsStore.update` bumps the
    // revision every cached key embeds.
    (tenantId) =>
      preferencesReaderFor(db)
        .readPreferences(tenantId)
        .then((prefs) => prefs?.tenantConcurrencyLimit ?? null),
    ({ apiKeyId, delta }) => {
      // Coalesced: one UPDATE per key per flush instead of one per request.
      // The admission counter is the live total; this only persists it.
      usageFlush.enqueue(apiKeyId, delta);
      return Promise.resolve();
    },
    // Fresh lifetime reader — invoked by the store only when it is about to
    // seed a missing `admission:lifetime:<id>` counter, so the ≤3s-stale auth
    // snapshot value cannot freeze a low baseline in place. Family total: the
    // row plus every child (share recipients admit under the parent id).
    async (apiKeyId) => {
      const store = new DrizzleApiKeyStore(db);
      const row = await store.findActiveById(apiKeyId);
      if (!row) return undefined;
      const children = await store.sumChildrenConsumed(apiKeyId);
      return (row.lifetimeTokensConsumed ?? 0) + children;
    },
    // Slack above every key's concurrency limit. A tenant preference an
    // operator sets in the runtime settings modal, falling back to the
    // deployment default so an unset row does not silently lose the allowance.
    (tenantId) =>
      preferencesReaderFor(db)
        .readPreferences(tenantId)
        .then((prefs) => prefs?.concurrencyTolerance ?? resolveConcurrencyTolerance()),
  );
  const ipStore = redis
    ? new RedisIpAbuseStore(redis)
    : new InMemoryIpAbuseStore();
  const ipAbuseProtection = new IpAbuseProtectionService(ipStore, undefined, {
    maxRequestsPerWindow: resolveIpRateLimit(),
  });

  const readiness = () => checkReadiness(db, redis, resolveRedisBackend(redis));
  // One list covers every periodic task: a small deployment can cut the
  // heaviest sweeps (quota refresh, OAuth refresh, client-version polling)
  // without the codebase growing a flag per task.
  // Leases coordinate the SHARED sweeps across processes. Absent Redis there is
  // nothing to coordinate with, and the registry's local one-at-a-time rule is
  // the correct (and only) guard.
  const scheduledTasks = new ScheduledTaskRegistry(
    readList("CARTETHYIA_DISABLED_TASKS", CONFIG_SPEC.CARTETHYIA_DISABLED_TASKS) ?? [],
    {
      ...(redis ? { lease: createRedisMaintenanceLeaseStore(redis) } : {}),
    },
  );
  if (redis) {
    scheduledTasks.register({
      name: "lease-sweep",
      intervalMs: 30_000,
      run: () => sweepLeases(redis),
    });
  }
  scheduledTasks.register({
    name: "account-health-sweep",
    // G-04: 30 s → 60 s — this is the most frequent snapshot invalidator, and
    // halving its cadence halves the rebuild/cooldown-recovery churn.
    intervalMs: 60_000,
    // Offsets the pass from lease-sweep and runtime-metrics, which share a
    // cadence: under the registry's single-flight gate, aligned ticks make the
    // tasks skip each other when one runs long.
    initialDelayMs: 5_000,
    // G-03: this sweep can invalidate the shared snapshot, so defer it while
    // foreground is busy (bounded) rather than racing a page open.
    deferWhenBusy: true,
    // Recovers cooldowns deployment-wide and invalidates the shared snapshot.
    shared: true,
    run: async () => {
      const recovered = await sweepExpiredCooldowns(db);
      const poolRecovered = await sweepExpiredPoolCooldowns(db);
      if (recovered > 0 || poolRecovered > 0) await snapshotService.invalidate();
    },
  });
  const payloadCapture = new TelemetryPayloadCapture(db);
  const telemetryStore = new DrizzleTelemetryStore(db);
  scheduledTasks.register({
    name: "telemetry-payload-cleanup",
    intervalMs: 15 * 60_000,
    // Deletes payload frames for every tenant: two passes over the same
    // batches is duplicated work, not speedup.
    shared: true,
    run: () => payloadCapture.cleanupExpired(),
  });
  scheduledTasks.register({
    name: "console-session-sweep",
    // Sessions live 48 h, so an hourly sweep deleted nothing 47 times out of
    // 48 — each pass a full scan of the session table for rows that cannot yet
    // be expired. Half the session lifetime is the point where a pass can
    // actually find work, and still leaves a full grace period after it.
    intervalMs: 12 * 60 * 60_000,
    shared: true,
    run: () => deleteExpiredSessions(db),
  });
  scheduledTasks.register({
    name: "telemetry-retention",
    intervalMs: 6 * 60 * 60_000,
    // Retention deletes rows and files for the whole deployment; a second
    // concurrent pass would churn the same batches.
    shared: true,
    run: () =>
      telemetryStore.pruneTelemetry(
        new Date(Date.now() - resolveTelemetryRetentionDays() * 24 * 60 * 60_000),
      ),
  });
  const telemetryBuffer = new TelemetryBatchBuffer(db);
  const poolSelector = new NetworkPoolSelector(redis);
  // Replay the provider cooldown markers the previous process recorded
  // (`network_pools.provider_cooldowns`). Without this a restart made dispatch
  // forget every egress the upstream was still refusing: the flags are
  // process-local otherwise, so the pool re-entered rotation and took 429s the
  // first request after boot re-discovered. Expired entries are dropped by the
  // restore itself. Best-effort: a failed read leaves selection matching what
  // a fresh deployment would do.
  try {
    const restored = await restoreProviderCooldownMarkers(poolSelector, db);
    const replayed = await restorePoolProbeVerdicts(poolSelector, db);
    if (restored > 0 || replayed > 0) {
      log.info("[pool-selector] restored provider cooldown state", { mirrored: restored, probeVerdictsApplied: replayed });
    }
  } catch (error) {
    log.warn("[pool-selector] provider cooldown restore failed", { error: String(error) });
  }
  const poolAgentResolver = new PoolAgentResolver(
    new DrizzleNetworkPoolLoader(db),
    { ssrfPolicy, db },
  );
  const networkBindingFactory = new ValidatedNetworkBindingFactory(
    ssrfPolicy,
    undefined,
    poolAgentResolver,
  );
  // The account-inflight reader the console queries. It lives after the deps
  // it closes over (telemetry buffer, binding factory), so the closure never
  // touches a TDZ binding; it also reuses one catalog store per tenant instead
  // of constructing a fresh store object on every console read. Multi-tenant
  // console polling rotates the tenant id, so the memo is keyed by tenant with
  // a small bound — a single-entry memo rebuilt the heavy store on every
  // switch, and an unbounded map would leak one store per tenant forever.
  const MAX_INFLIGHT_STORES = 16;
  const inflightStores = new Map<string, DrizzleProviderCatalogStore>();
  const readRoutingAccountInflight = async (
    providerId: string,
    tenantId: string | null,
  ): Promise<readonly { accountId: string; inflight: number }[]> => {
    if (providerId === "" || tenantId === null) return [];
    let inflightStore = inflightStores.get(tenantId);
    if (inflightStore === undefined) {
      // B-01: resolve the deferred bundled catalog first so the store's model
      // map is populated (the snapshot warm normally did this already; this
      // is the cold-race fallback).
      await resolveBundledCatalog();
      inflightStore = new DrizzleProviderCatalogStore(db, {
        telemetryBuffer,
        bundledModelCatalog: { modelsByProvider: bundledCatalogModels },
        providerRegistry: registry,
        outboundFetchFor: async () => ({ fetch: networkBindingFactory.fetch(undefined, tenantId) }),
        snapshotInvalidator: snapshotService,
      });
      inflightStores.set(tenantId, inflightStore);
      if (inflightStores.size > MAX_INFLIGHT_STORES) {
        const oldest = inflightStores.keys().next().value;
        if (oldest !== undefined) inflightStores.delete(oldest);
      }
    }
    // P-02: only the account-id set is needed, so select just `id` — the old
    // `listAccounts` recomputed today/lifetime usage aggregates for every
    // account on every console poll.
    const accountIds = await inflightStore.listAccountIds(tenantId, providerId);
    const owned = new Set(accountIds);
    // Scoped read: only the provider's own candidates for this tenant are
    // queried, so the console read costs one exact MGET over the accounts it
    // is about to report on — not a fleet-wide `KEYS` scan whose cost is the
    // size of every bucket every process ever wrote.
    const routeSnapshot = await snapshotService.getSnapshot();
    const ownedCandidates = routeSnapshot.candidates.filter(
      (candidate) =>
        candidate.provider_id === providerId &&
        candidate.provider_account_id !== undefined &&
        owned.has(candidate.provider_account_id),
    );
    const snapshot = await routingEngine.accountInflightSnapshot(ownedCandidates);
    // Map each bucket back to the account it belongs to using the same
    // `admissionKey` format admission writes with — never string-slicing the
    // bucket (the trailing segment is the owner tenant, not the account id).
    const accountByBucket = new Map<string, string>();
    for (const candidate of ownedCandidates) {
      accountByBucket.set(admissionKey(candidate), candidate.provider_account_id!);
    }
    const totals = new Map<string, number>();
    for (const [bucket, count] of snapshot) {
      const accountId = accountByBucket.get(bucket);
      if (accountId === undefined || !owned.has(accountId)) continue;
      totals.set(accountId, (totals.get(accountId) ?? 0) + count);
    }
    return [...totals].map(([accountId, inflight]) => ({ accountId, inflight }));
  };
  // Runtime gauges (memory + bounded-collection sizes) sampled on the shared
  // maintenance cadence. The sampler reads live sizes through closures so the
  // observability layer never holds direct references to routing/pool state.
  const runtimeMetricsSampler = new RuntimeMetricsSampler({
    routingRoundRobinEntries: () => routingEngine.roundRobinEntries(),
    ipAbuseKeys: () => (ipStore instanceof InMemoryIpAbuseStore ? ipStore.keyCount() : 0),
    quotaCacheEntries: () => quotaCacheSize(),
    modelCatalogEntries: () => modelCatalogCacheSize(),
    // Late-bound via bindInFlight once the request state store exists.
    inFlight: () => 0,
    // The buffer is built below; the closure keeps the sampler from holding a
    // reference during construction.
    telemetryBacklog: () => telemetryBuffer?.snapshot(),
  });
  // One sample NOW, not on the first tick. The headroom guard reads
  // `memorySnapshot()` on every gateway request and treats `undefined` as
  // "unknown" — so without this the guard would spend its first interval
  // (seconds, at the configured cadence) unable to shed at all, which is
  // exactly the window a cold start is most likely to be short of memory.
  runtimeMetricsSampler.sample();
  scheduledTasks.register({
    name: "runtime-metrics",
    intervalMs: readInt(
      "CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS",
      CONFIG_SPEC.CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS,
    ),
    run: () => runtimeMetricsSampler.sample(),
  });
  scheduledTasks.register({
    name: "pool-agent-sweep",
    // `resolveAgent` already self-sweeps every 30 s, so a 1 min timer adds a
    // second pass that almost always finds nothing to release. 5 min is well
    // inside the idle timeout this exists to enforce, and outside the path
    // that already runs.
    intervalMs: 5 * 60_000,
    run: () => poolAgentResolver.sweepIdleAgents(),
  });
  const oauthRefreshService = new OAuthRefreshService(db);
  // Converge accounts parked on a dead refresh grant: an account whose stored
  // access token is still usable becomes a static token (and returns to
  // rotation) instead of staying disabled for re-auth.
  await measureStartupPhase("static-token-reconciliation", () =>
    reconcileStaticTokenAccounts(db),
  );
  // Fills in the identity a batch import deliberately skipped, so a paste of
  // many credentials is one instant write and the email/label arrive shortly
  // after rather than blocking the import. Purely CPU on an already-stored
  // credential — no upstream call — so it runs often and cheaply.
  scheduledTasks.register({
    name: "account-enrichment-sweep",
    // Converges via `identity_checked_at`: once every stored credential has
    // been parsed, the listing query returns nothing — a 30 s timer would run
    // that empty query forever, two million times a year. 10 min is still
    // instant for the case that matters (a batch import, where the label and
    // email show up on the next tick) and costs nothing when idle.
    intervalMs: 10 * 60_000,
    run: () => accountIdentitySweep({ db }),
  });
  scheduledTasks.register({
    name: "oauth-refresh-sweep",
    intervalMs: 60_000,
    // G-04: defer when foreground is busy (InvokeGuard), and cap the pass with
    // a budget mirroring quota refresh's 45 s so an OAuth pass cannot run away
    // into a heavy foreground minute.
    deferWhenBusy: true,
    run: () =>
      oauthRefreshSweep({
        loadDueAccounts: () => loadDueOAuthAccounts(db),
        refreshService: oauthRefreshService,
        resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
        // Sequential with a pause between accounts: the OAuth token endpoints
        // rate-limit a burst of refreshes, and a pass over a handful of
        // accounts must not look like one. Per-account outcomes are already
        // pushed to the Console Log ring by `OAuthRefreshService`; this only
        // covers an error that escaped before reaching it.
        interItemDelayMs: OAUTH_REFRESH_INTER_ITEM_DELAY_MS,
        budgetMs: 45_000,
        onAccountError: (accountId, providerId, error) => {
          log.error(
            `[oauth-refresh] account=${accountId} provider=${providerId} failed:`,
            error as Error,
          );
          pushStructuredConsoleLog("error", "OAuth refresh sweep: account failed", {
            event: "token_refresh",
            accountId,
            providerId,
            errorCode: "refresh_sweep_failed",
          });
        },
      }),
  });

  // Client versions are monitor-only metadata; let the listener settle before
  // starting their external fetches. The scheduled task keeps the cache warm.
  scheduledTasks.register({
    name: "client-version-monitor",
    intervalMs: CLIENT_VERSION_MONITOR_INTERVAL_MS,
    initialDelayMs: CLIENT_VERSION_INITIAL_DELAY_MS,
    // Pure outbound reads with no shared rows/files: they must not be gated
    // by the process-wide busy latch, or a nearly-continuous heavy sweep
    // (quota-refresh) starves this monitor at its single initial tick and
    // every 30-minute interval after it.
    skipGate: true,
    run: refreshProviderClientVersions,
  });

  const quotaResolveCredential = createAccountSecretResolver({
    db,
    resolveRefresher: (providerId) => registry.resolveRefresher(providerId),
    refreshService: oauthRefreshService,
  });
  // Keeps every account's cached quota warm so opening the Quota page is a
  // cache read. Without this the only refreshes are user-triggered, so the
  // first open after an expiry always blocks on the provider.
  //
  // It also carries the daily check-in ride-along: each account refreshed
  // here gets its once-per-day WorkBuddy/CodeBuddy credit grant claimed in
  // the same pass (one attempt per account per day, guarded by a day
  // marker), so no second timer duplicates the credential resolution.
  //
  // Registered in **every** mode, not only when Redis is present: gating it on
  // Redis would cost Lite proactive quota warming and the check-in ride-along
  // above that claims the once-per-day WorkBuddy/CodeBuddy credit grant. The
  // whole sweep chain accepts `RedisClient | undefined` and falls back to the
  // in-process TTL cache and an in-process day marker, so Redis is an
  // optimization here rather than a precondition — which is exactly what
  // Lite is for.
  scheduledTasks.register({
    name: "quota-refresh-sweep",
    intervalMs: 60_000,
    // Staggered off the oauth/lease/health ticks so the three sweeps that
    // strike providerAccounts do not land together every minute.
    initialDelayMs: 20_000,
    // G-03: defer while foreground is busy (bounded).
    deferWhenBusy: true,
    run: () =>
      quotaRefreshSweep({
        db,
        redis,
        providerRegistry: registry,
        resolveCredential: quotaResolveCredential,
        snapshotInvalidator: snapshotService,
        // Without this the sweep hands each collector the raw stored secret.
        // For `cline` that means an `sk_...` key reaching the OAuth branch,
        // which prepends `workos:` and is refused with "please make sure
        // you're using the latest version of Cline and re-authenticate" — so
        // every sweep cools a working account with `quota_fetch_failed` while
        // the same account refreshes fine from the console, which binds the
        // same marker through `createQuotaRefreshDeps`.
        markApiKeyCredential: markProviderApiKeyCredential,
        // Below the 60 s interval: a budget longer than the tick guarantees
        // skip/burst under load instead of steady progress.
        passBudgetMs: 45_000,
        // The check-in ride-along rotates egress per account: each account
        // gets the next active pool in its tenant's rotation so check-ins
        // spread across IPs instead of sharing one direct egress. No pool
        // (or an unreadable pool table) falls back to direct egress, and a
        // tenant never borrows another tenant's pool.
        checkinFetcherFor: dailyCheckinEgressForPass({ db, networkBindingFactory }),
        // Per-account lines and the pass summary are emitted by the sweep
        // itself at `info` level, so they survive the production LOG_LEVEL.
        // `onTick` is left for tests.
      }),
  });
  registerZcodeGiftClaimTask(scheduledTasks, {
    db,
    redis,
    resolveCredential: quotaResolveCredential,
    snapshotInvalidator: snapshotService,
    fetcherFor: dailyCheckinEgressForPass({ db, networkBindingFactory }),
  });
  // The buddy growth/credit tasks: one per upstream capability, each
  // independently switchable with `CARTETHYIA_DISABLED_TASKS`. Every one of
  // them is a credit gain the account is entitled to, and none of them can mark
  // an account unhealthy — a growth endpoint that 404s is a display miss, not a
  // dispatch failure.
  //
  // Daily, not hourly: each claim is once per account per day and is
  // ledger-guarded, so at an hourly cadence 23 of every 24 passes are a full
  // scan of active accounts plus a ledger read per account that resolves to
  // nothing. Once a day is the shortest interval where a pass can still find
  // work, which is the only reason to run at all.
  const buddyTaskDeps = {
    db,
    resolveCredential: quotaResolveCredential,
    fetcher: fetch,
    // Spread across accounts so a pass does not look like a burst to the
    // upstream's risk gate.
    interAccountDelayMs: 800,
    // G-04: bound each pass. These are daily/six-hourly tasks, so the budget
    // is deliberately larger than the minute-cadence sweeps' 45 s — it caps a
    // runaway scan without truncating a legitimate fleet mid-pass.
    budgetMs: 5 * 60_000,
  };
  scheduledTasks.register({
    name: "buddy-streak",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 5 * 60_000,
    // G-03: defer while foreground is busy (bounded).
    deferWhenBusy: true,
    run: () => buddyStreakTask(buddyTaskDeps),
  });
  scheduledTasks.register({
    name: "buddy-adopt",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 17 * 60_000,
    deferWhenBusy: true,
    run: () => buddyAdoptTask(buddyTaskDeps),
  });
  // Growth-activity report: the `/v2/report` batch that lights the login streak
  // and scores the daily growth event. Once a day with its own ledger — it used
  // to ride the quota sweep with no marker of its own, so its eight POSTs ran
  // every minute.
  scheduledTasks.register({
    name: "buddy-activity-report",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 15 * 60 * 60_000,
    deferWhenBusy: true,
    run: () => buddyActivityReportTask(buddyTaskDeps),
  });
  // Real credit deductions, stored so the console renders a figure the upstream
  // actually reported. Six-hourly: the upstream's own window is 30 days, so a
  // day's number does not change intraday.
  scheduledTasks.register({
    name: "buddy-usage-sync",
    intervalMs: 6 * 60 * 60_000,
    initialDelayMs: 23 * 60_000,
    deferWhenBusy: true,
    run: () => syncBuddyUsage(buddyTaskDeps),
  });
  // The scheduled tasks are registered here but started by the caller once the
  // listener is actually serving (`main.ts`). Starting them inside this builder
  // would let the first tick — the lease sweep, the health sweep — run against
  // a process that has not begun accepting traffic yet.
  const deps: ProductionDeps = {
    db,
    redis,
    snapshotService,
    readRoutingAccountInflight,
    resolveProviderAdapter: (providerId) => registry.resolve(providerId),
    bundledModelCatalog: { modelsByProvider: bundledCatalogModels },
    byokUpstreamHosts,
    proxyPreparer: new ProxyRequestPreparer({
      snapshotService,
      routingEngine,
      admissionService,
    }),
    networkBindingFactory,
    ipAbuseProtection,
    ipAbuseStore: ipStore,
    readiness,
    scheduledTasks,
    poolAgentResolver,
    telemetryBuffer,
    usageFlush,
    healthEventFlush,
    poolSelector,
    admissionService,
    trustedProxyBoundary: resolveTrustedProxyBoundary(),
    providerRegistry: registry,
    resolveOAuthRefresher: (providerId) => registry.resolveRefresher(providerId),
    oauthRefreshService,
    runtimeMetricsSampler,
  };
  const startupMemoryAfter = process.memoryUsage();
  log.info(
    `[startup] phase=dependencies-ready elapsed_ms=${Math.round(performance.now() - startupStartedAt)} ` +
      `rss_mb=${toMiB(startupMemoryAfter.rss)} ` +
      `rss_delta_mb=${toMiB(startupMemoryAfter.rss - startupMemoryBefore.rss)} ` +
      `heap_used_mb=${toMiB(startupMemoryAfter.heapUsed)} ` +
      `heap_delta_mb=${toMiB(startupMemoryAfter.heapUsed - startupMemoryBefore.heapUsed)}`,
  );
  return deps;
}

async function measureStartupPhase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const before = process.memoryUsage();
  log.info(
    `[startup] phase=${name} status=started rss_mb=${toMiB(before.rss)} heap_used_mb=${toMiB(before.heapUsed)}`,
  );
  try {
    const result = await operation();
    const after = process.memoryUsage();
    log.info(
      `[startup] phase=${name} status=completed elapsed_ms=${Math.round(performance.now() - startedAt)} ` +
        `rss_mb=${toMiB(after.rss)} rss_delta_mb=${toMiB(after.rss - before.rss)} ` +
        `heap_used_mb=${toMiB(after.heapUsed)} heap_delta_mb=${toMiB(after.heapUsed - before.heapUsed)} ` +
        `external_mb=${toMiB(after.external)}`,
    );
    return result;
  } catch (error) {
    log.error(
      `[startup] phase=${name} status=failed elapsed_ms=${Math.round(performance.now() - startedAt)}`,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  }
}

function toMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
