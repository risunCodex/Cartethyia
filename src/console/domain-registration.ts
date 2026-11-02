import { type AnyElysia } from "elysia";
import { ConsoleDomainError } from "./shared/errors";
import { createCliToolsRoutes } from "./cli-tools/routes";
import { createAccountQuotaRoutes } from "./quota/account-quota";
import { createApiKeyRoutes } from "./api-keys/routes";
import { familyBucketSpend } from "./api-keys/bucket-spend";
import { createProviderCatalogRoutes } from "./providers/catalog/routes";
import { createInferhubRoutes } from "./inferhub/routes";
import { createInferhubKeyStore } from "./inferhub/key-store";
import {
  createProviderDetailRoutes,
} from "./providers/detail/routes";
import {
  createOAuthLoginRoutes,
  completeLogin,
  DrizzleOAuthAccountStore,
  type OAuthLoginConfig,
} from "./providers/oauth/routes";
import {
  DrizzleProviderCatalogStore,
} from "./providers/catalog/store";
import { DrizzleProviderDetailStore } from "./providers/detail/store";
import { createModelRoutingRoutes } from "./routing/model/routes";
import { createNetworkPoolRoutes } from "./routing/pools/routes";
import { DrizzleModelRoutingStore } from "./routing/model/store";
import { DrizzleNetworkPoolStore } from "./routing/pools/store";
import { createRuntimeSettingsRoutes } from "./settings/routes";
import { createSystemPromptRoutes } from "./system-prompt/routes";
import { createDataManagementRoutes } from "./data-management/routes";
import { healthEventBuffer } from "../persistence/health-event-flush";
import { countAllHealthEvents, deleteAllHealthEvents } from "../providers/operations/account-health-service";
import { DrizzleRuntimeSettingsStore } from "./settings/store";
import { createObservabilityRoutes } from "./observability/routes";
import { DrizzleObservabilityStore } from "./observability/store";
import { createLiveRoutes } from "./observability/live";
import { createLogRoutes } from "./observability/logs";
import { createAuditRoutes } from "./audit/routes";
import { DrizzleAuditReadStore } from "./audit/store";
import { createPerformanceRoutes } from "./observability/performance";
import { createUpdateRoutes } from "./updates/routes";
import { createRemoteSupportRoutes } from "./remote-support/routes";
import { createRemoteSupportService } from "./remote-support/service";
import { resolvePort } from "../config/runtime";
import { createBackupRoutes } from "./backup/routes";
import { BackupService } from "./backup/service";
import type { ConsoleCredentialService } from "./auth/credentials";
import { resolveTelemetryRetentionDays } from "../config/telemetry";
import { payloadRetentionMs, resolvePayloadCapture } from "../observability/payload-capture";
import { TELEMETRY_EVENT_DIR } from "../observability/event-log";
import { providerUsageMatrix } from "../observability/event-query";

import { InMemoryOAuthFlowStore, OAuthFlowStore } from "../providers/authentication/oauth-flow-store";
import { OAuthCallbackListener } from "./providers/oauth/callback-listener";
import {
  createAccountExportCredentialsResolver,
  createAccountSecretResolver,
} from "../providers/operations/provider-credential-service";
import { syncByokProvider } from "../providers/operations/provider-catalog-service";
import { DrizzleApiKeyStore } from "../persistence/stores/api-key-store";
import {
  DrizzleShareLinkStore,
  type ShareLinkStore,
} from "../persistence/stores/share-store";
import { createShareUsagePort } from "./share/share-usage";
import { resolveSsrfPolicy } from "../config/network";
import { createValidatedFetch } from "../network/outbound-fetch";
import type { AuditRecorder } from "./auth/audit-recorder";
import type { CliToolService } from "./cli-tools/service";
import type { NetworkPoolSelector } from "../network/pool/selector";
import type { LiveInFlightSource } from "./observability/live";
import type { ApiKeyAdmissionService } from "../security/admission/service";
import type { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import type { OAuthRefreshService } from "../providers/authentication/oauth-refresh-service";
import { resolveRedisBackend } from "../persistence/redis";
import type { RedisClient } from "../persistence/redis";
import type { ProviderRegistry } from "../providers/provider-registry";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import type { ConsoleAccessResolver } from "./auth/access";

export interface ConsoleDomainContext {
  readonly db: CartethyiaDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  readonly providerRegistry: ProviderRegistry;
  readonly bundledModelCatalog: BundledProviderCatalog;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly oauthRefreshService: OAuthRefreshService;
  readonly auditRecorder: AuditRecorder;
  readonly cliToolService: CliToolService;
  readonly redis: RedisClient | undefined;
  /** Drops the cached route snapshot after a catalog write. Structurally
   * satisfied by `RouteSnapshotService`. */
  readonly routeSnapshotService: { invalidate(): Promise<number> };
  readonly poolSelector: NetworkPoolSelector;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  /**
   * Queued writers the console can drain on demand. Optional because a flush
   * is only meaningful when the process owns the buffers; a caller that does
   * not pass them simply loses the button rather than failing to boot.
   */
  readonly flushBuffers?: {
    flush(): Promise<void>;
  };
  /** Owns the live in-flight gauge the console surfaces. */
  readonly stateStore?: LiveInFlightSource;
  /**
   * Share-link store shared with the public share router, so both surfaces
   * wrap the same table through one instance. Falls back to a fresh store
   * when absent (reduced compositions, tests).
   */
  readonly shareStore?: ShareLinkStore;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey">;
  readonly readRoutingAccountInflight?:
    | ((
        providerId: string,
        tenantId: string | null,
      ) => Promise<readonly { accountId: string; inflight: number }[]>)
    | undefined;
  /**
   * Loads the signed-in console user, for surfaces that re-authenticate the
   * operator rather than trusting the session alone (backup export/restore).
   */
  readonly loadConsoleUser: (request: Request) => Promise<{ readonly passwordHash: string } | null>;
  /** Password verification against the console user's stored hash. */
  readonly credentialService: Pick<ConsoleCredentialService, "verifyPassword">;
}
import { and, eq, isNull, or } from "drizzle-orm";
import { networkPools, providerRoutingSettings } from "../persistence/schema";
import { resolveTenantOverride } from "../persistence/tenant-scope";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../providers/provider-metadata";
import type { ProbeOutboundBinding } from "../providers/discovery/probing-service";


export function registerConsoleDomains(
  console: AnyElysia,
  ctx: ConsoleDomainContext,
): void {
  const observabilityStore = new DrizzleObservabilityStore(ctx.db, ctx.redis);
  const auditReadStore = new DrizzleAuditReadStore(ctx.db);
  /** Refresh-aware credential resolution for quota routes. */
  const resolveCredential = createAccountSecretResolver({
    db: ctx.db,
    resolveRefresher: (id) => ctx.providerRegistry.resolveRefresher(id),
    refreshService: ctx.oauthRefreshService,
  });
  const resolveExportCredentials = createAccountExportCredentialsResolver({
    db: ctx.db,
    resolveRefresher: (id) => ctx.providerRegistry.resolveRefresher(id),
    refreshService: ctx.oauthRefreshService,
  });
  const providerCatalogStore = new DrizzleProviderCatalogStore(ctx.db, {
    telemetryBuffer: ctx.telemetryBuffer,
    bundledModelCatalog: ctx.bundledModelCatalog,
    providerRegistry: ctx.providerRegistry,
    outboundFetchFor: async (tenantId: string, providerId?: string): Promise<ProbeOutboundBinding> => {
      let bypass = false;
      if (providerId) {
        const rows = await ctx.db
          .select({
            tenantId: providerRoutingSettings.tenantId,
            skipProxy: providerRoutingSettings.skipProxy,
          })
          .from(providerRoutingSettings)
          .where(
            and(
              eq(providerRoutingSettings.providerId, providerId),
              or(
                eq(providerRoutingSettings.tenantId, tenantId),
                isNull(providerRoutingSettings.tenantId),
              ),
            ),
          );
        const tenantSetting = rows.find((row) => row.tenantId === tenantId)?.skipProxy;
        const globalSetting = rows.find((row) => row.tenantId === null)?.skipProxy;
        bypass = resolveTenantOverride(
          tenantSetting,
          globalSetting,
          DEFAULT_PROXY_SKIP_PROVIDER_IDS.has(providerId),
        );
      }

      if (!bypass) {
        const activePools = await ctx.db
          .select({
            id: networkPools.id,
            maxInflight: networkPools.maxInflight,
            weight: networkPools.weight,
          })
          .from(networkPools)
          .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.status, "active")));

        if (activePools.length > 0) {
          const limits: Record<string, number> = {};
          const weights: Record<string, number> = {};
          for (const p of activePools) {
            limits[p.id] = p.maxInflight ?? 10;
            weights[p.id] = p.weight ?? 100;
          }
          const slot = await ctx.poolSelector.tryAcquireAvailablePool(
            activePools.map((p) => p.id),
            providerId ?? "default",
            limits,
            weights,
          );
          if (slot) {
            return {
              fetch: ctx.networkBindingFactory.fetch(slot.poolId, tenantId),
              http2Bidi: ctx.networkBindingFactory.http2Bidi(slot.poolId, tenantId),
              networkPoolId: slot.poolId,
              release: slot.release,
            };
          }
          // Every pool is saturated or cooling down: fail closed with an
          // explicit 503 rather than pinning the first pool and bypassing its
          // capacity accounting and cooldown.
          throw new ConsoleDomainError(
            "pool_unavailable",
            503,
            `All network pools are saturated for provider ${providerId ?? "default"}`,
          );
        }
      }

      return {
        fetch: ctx.networkBindingFactory.fetch(undefined, tenantId),
        http2Bidi: ctx.networkBindingFactory.http2Bidi(undefined, tenantId),
      };
    },
    snapshotInvalidator: ctx.routeSnapshotService,
    readAccountInflight: async (providerId, tenantId) =>
      ctx.readRoutingAccountInflight ? ctx.readRoutingAccountInflight(providerId, tenantId) : [],
  });
  const providerDetailStore = new DrizzleProviderDetailStore(ctx.db);
  const networkPoolStore = new DrizzleNetworkPoolStore(ctx.db, resolveSsrfPolicy());
  const runtimeSettingsStore = new DrizzleRuntimeSettingsStore(ctx.db, resolveRedisBackend(ctx.redis));
  const modelRoutingStore = new DrizzleModelRoutingStore(ctx.db);
  const apiKeyStore = new DrizzleApiKeyStore(ctx.db);
  const shareStore = ctx.shareStore ?? new DrizzleShareLinkStore(ctx.db);
  const shareActivity = createShareUsagePort({ db: ctx.db, redis: ctx.redis });


  console.use(createObservabilityRoutes({ store: observabilityStore, accessResolver: ctx.accessResolver }));
  console.use(createLiveRoutes({
    accessResolver: ctx.accessResolver,
    poolSelector: ctx.poolSelector,
    db: ctx.db,
    ...(ctx.stateStore ? { stateStore: ctx.stateStore } : {}),
  }));
  console.use(createLogRoutes({ accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  console.use(createPerformanceRoutes({ accessResolver: ctx.accessResolver }));
  console.use(createUpdateRoutes({
    accessResolver: ctx.accessResolver,
    observabilityStore,
  }));
  console.use(createRemoteSupportRoutes({
    accessResolver: ctx.accessResolver,
    service: createRemoteSupportService({ port: resolvePort() }),
  }));
  console.use(createAuditRoutes({ store: auditReadStore, accessResolver: ctx.accessResolver }));
  // InferHub market data. On demand only: a route fetches when its snapshot is
  // past its freshness window, so a page nobody opens causes no upstream calls.
  const inferhubKeys = createInferhubKeyStore(ctx.db);
  console.use(createInferhubRoutes({
    accessResolver: ctx.accessResolver,
    resolveConfigKey: () => inferhubKeys.read(),
    keyStore: inferhubKeys,
  }));
  console.use(createProviderCatalogRoutes({
    store: providerCatalogStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    providerRegistry: ctx.providerRegistry,
    snapshotInvalidator: ctx.routeSnapshotService,
    resolveExportCredentials,
    // Without this, a custom provider only becomes dispatchable after a
    // restart: boot registers BYOK rows once, and the catalog routes are the
    syncByokProvider: (providerId) =>
      syncByokProvider(ctx.providerRegistry, ctx.db, providerId, resolveSsrfPolicy()),
    listRoutingTargets: async (tenantId) => ({
      aliases: await modelRoutingStore.listAliases(tenantId),
      combos: await modelRoutingStore.listCombos(tenantId),
    }),
    providerUsageMatrix: (tenantId, providerId, days) =>
      providerUsageMatrix(
        ctx.db,
        tenantId,
        providerId,
        new Date(Date.now() - days * 86_400_000),
      ),
  }));
  console.use(createProviderDetailRoutes({
    store: providerDetailStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    snapshotInvalidator: ctx.routeSnapshotService,
    accountInflight: ctx.readRoutingAccountInflight,
  }));
  console.use(createNetworkPoolRoutes({
    store: networkPoolStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    poolSelector: ctx.poolSelector,
    snapshotInvalidator: ctx.routeSnapshotService,
    // Hosted-relay deploys reach Cloudflare/Vercel/Deno APIs, so they use the
    // same SSRF-validated fetch as every other egress.
    relayFetch: createValidatedFetch({ policy: resolveSsrfPolicy() }),
  }));
  console.use(createRuntimeSettingsRoutes({ store: runtimeSettingsStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createSystemPromptRoutes({ db: ctx.db, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  console.use(
    createDataManagementRoutes({
      telemetryDir: TELEMETRY_EVENT_DIR,
      retentionDays: resolveTelemetryRetentionDays(),
      /*
       * Resolved per tenant, not once at boot: the Request detail window is a
       * per-tenant setting, and this panel is the only place that reports the
       * number back. A deployment-level value made it show the default while
       * the gateway applied the tenant's own window.
       *
       * It goes through the same `resolvePayloadCapture` the dispatch path
       * uses, so the panel and the gateway cannot disagree about how long a
       * frame lives.
       */
      payloadRetentionMs: async (tenantId) => {
        const resolved = await resolvePayloadCapture(ctx.db, tenantId);
        return resolved.ok ? resolved.retentionMs : payloadRetentionMs();
      },
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
      flusher: ctx.flushBuffers,
      // The console's one row-level purge: the health & error log is a
      // diagnostic trail no request-path code reads. Dropping the buffered
      // writes before the DELETE is what makes it sound — otherwise a batch
      // in flight would land behind the purge and resurrect history that was
      // just counted as deleted.
      healthEvents: {
        count: () => countAllHealthEvents(ctx.db),
        purgeAll: async () => {
          await healthEventBuffer()?.drain();
          return await deleteAllHealthEvents(ctx.db);
        },
      },
    }),
  );
  console.use(
    createBackupRoutes({
      accessResolver: ctx.accessResolver,
      // The service is built per request: re-authenticating the operator needs
      // the request's session, and holding a request-bound closure in a
      // long-lived object would leak one request's identity into the next.
      backupFor: (request: Request) =>
        new BackupService({
          db: ctx.db,
          verifyPassword: async (password: string) => {
            const user = await ctx.loadConsoleUser(request);
            if (user === null) return false;
            return ctx.credentialService.verifyPassword(password, user.passwordHash);
          },
        }),
      snapshotInvalidator: ctx.routeSnapshotService,
      apiKeyStore,
      admissionService: ctx.admissionService,
      auditSink: ctx.auditRecorder,
    }),
  );
  console.use(createModelRoutingRoutes({ store: modelRoutingStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createApiKeyRoutes({ store: apiKeyStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, shareStore, shareActivity, admissionService: ctx.admissionService, bucketSpend: (keyId, now) => familyBucketSpend(ctx.db, keyId, now) }));
  console.use(createCliToolsRoutes({ service: ctx.cliToolService, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createAccountQuotaRoutes({
    db: ctx.db,
    accessResolver: ctx.accessResolver,
    auditRecorder: ctx.auditRecorder,
    redis: ctx.redis,
    snapshotInvalidator: ctx.routeSnapshotService,
    providerRegistry: ctx.providerRegistry,
    resolveCredential,
    poolSelector: ctx.poolSelector,
    networkBindingFactory: ctx.networkBindingFactory,
  }));
  // The listener binds the loopback port a browser redirect names, so the
  // callback delivers itself instead of waiting for a manual paste. One
  // instance per console: a port is shared by every flow registered on it, and
  // it is released when the last of those flows settles.
  const oauthCallbackListener = new OAuthCallbackListener({
    completer: {
      complete: (providerId, code, state, callbackParams) =>
        completeLogin(oauthConfig, providerId, code, state, callbackParams),
    },
  });
  const oauthConfig: OAuthLoginConfig = {
    providerRegistry: ctx.providerRegistry,
    oauthFlowStore: ctx.redis ? new OAuthFlowStore(ctx.redis) : new InMemoryOAuthFlowStore(),
    accountStore: new DrizzleOAuthAccountStore(ctx.db),
    accessResolver: ctx.accessResolver,
    snapshotInvalidator: ctx.routeSnapshotService,
    callbackListener: oauthCallbackListener,
  };
  console.use(createOAuthLoginRoutes(oauthConfig));
}
