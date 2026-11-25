// Drizzle-backed provider, model, and discovery catalog repository. The
// implementation is split on clean seams into plain function modules over
// shared contexts, all built by this class:
// - provider rows: `store-provider-records.ts`
// - model rows + probing: `store-model-operations.ts`
// - account reads: `store-account-queries.ts`
// - account writes: `store-account-mutations.ts`
// - pool-as-account reads: `store-pool-accounts.ts`
// - account health / bulk actions: `store-operations.ts`
import type { ServiceKind } from "../../../protocol/canonical-model";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import type { RedisClient } from "../../../persistence/redis";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { ModelDefinition } from "../../../providers/provider-model-definition";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import type { BundledProviderCatalog } from "../../../providers/operations/provider-catalog-service";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import type {
  AccountInflightReading,
  BuddyGrowthTaskLedgerEntry,
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  CreateProviderAccountBatchResult,
  CreateProviderAccountRequest,
  DiscoverModelCandidate,
  ModelCatalogEntry,
  ModelMetadataOverride,
  OwnedProviderAccountRef,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
  ProviderAccountBulkActionResult,
  ProviderAccountResponse,
  ProviderCatalogStore,
  ProviderRecord,
  SetModelEnabledRequest,
  UpdateModelMetadataRequest,
  UpdateProviderAccountRequest,
} from "./contracts";
import { ProviderProbingService, type ProbeOutboundResolver } from "../../../providers/discovery/probing-service";
import { DEFAULT_ENDPOINT_BY_WIRE_FAMILY } from "./catalog-projections";
import type { StoreAccountContext, StoreModelContext, StoreOperationsContext, StoreProviderContext } from "./store-contexts";
import {
  getGlobalAccount,
  getOwnedAccount,
  listAccountAuthStates,
  listAccountIds,
  listAccounts,
  listAllAccountSummaries,
  listAllAccounts,
  ownsAccount as ownsAccountRow,
  providerAccountCounts,
  providerModelCounts,
} from "./store-account-queries";
import {
  createAccountBatch,
  createAccountRow,
  reorderAccounts,
  updateAccountRow,
} from "./store-account-mutations";
import {
  deleteBannedRow,
  disableCooldownsRow,
  listAccountHealthEventsRow,
  listBuddyGrowthTasksRow,
  purgeAccountHealthEventsRow,
  recoverAccountRow,
} from "./store-operations";
import {
  createProvider,
  deleteGlobalProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateGlobalProvider,
  updateProvider,
} from "./store-provider-records";
import {
  commitDiscoveredModels,
  deleteModel,
  listDiscoveryCandidates,
  listModelsForTenant,
  probeAllModels,
  registerModels,
  setModelEnabled,
  updateModelMetadata,
} from "./store-model-operations";

export {
  accountLabelKindSegment,
  mapModelRow,
  nextGeneratedAccountLabel,
  withImageModality,
} from "./store-helpers";

export class DrizzleProviderCatalogStore implements ProviderCatalogStore {
  private readonly probing: ProviderProbingService;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly providerRegistry: ProviderRegistry;

  private readonly readAccountInflight:
    | ((
        providerId: string,
        tenantId: string,
      ) => Promise<readonly AccountInflightReading[]>)
    | undefined;

  private readonly redis: RedisClient | undefined;

  constructor(
    private readonly db: CartethyiaDatabase,
    options: {
      readonly telemetryBuffer: TelemetryBatchBuffer;
      readonly bundledModelCatalog: BundledProviderCatalog;
      readonly providerRegistry: ProviderRegistry;
      readonly outboundFetchFor: ProbeOutboundResolver;
      readonly snapshotInvalidator: { invalidate(): unknown };
      readonly readAccountInflight?:
        | ((
            providerId: string,
            tenantId: string,
          ) => Promise<readonly AccountInflightReading[]>)
        | undefined;
      /** Shared Redis handle for quota-cache invalidation on bulk delete. */
      readonly redis?: RedisClient | undefined;
    },
  ) {
    this.bundledModelCatalog = options.bundledModelCatalog.modelsByProvider;
    this.providerRegistry = options.providerRegistry;
    this.readAccountInflight = options.readAccountInflight;
    this.redis = options.redis;
    this.probing = new ProviderProbingService({
      db,
      telemetryBuffer: options.telemetryBuffer,
      defaultEndpoints: DEFAULT_ENDPOINT_BY_WIRE_FAMILY,
      bundledModelCatalog: this.bundledModelCatalog,
      outboundFetchFor: options.outboundFetchFor,
      snapshotInvalidator: options.snapshotInvalidator,
      providerRegistry: options.providerRegistry,
    });
  }

  /** Context handed to the account-read module (`store-account-queries.ts`). */
  private get accountCtx(): StoreAccountContext {
    return { db: this.db, readAccountInflight: this.readAccountInflight };
  }

  /** Context handed to the health/bulk-action module (`store-operations.ts`). */
  private get operationsCtx(): StoreOperationsContext {
    return {
      db: this.db,
      redis: this.redis,
      readAccountInflight: this.readAccountInflight,
      ownsAccount: (tenantId, providerId, accountId) =>
        ownsAccountRow(this.accountCtx, tenantId, providerId, accountId),
    };
  }

  /** Context handed to the provider-CRUD module (`store-provider-records.ts`). */
  private get providerCtx(): StoreProviderContext {
    return { db: this.db, providerRegistry: this.providerRegistry };
  }

  /** Context handed to the model module (`store-model-operations.ts`). */
  private get modelCtx(): StoreModelContext {
    return { db: this.db, probing: this.probing };
  }

  async list(tenantId: string): Promise<readonly ProviderRecord[]> {
    return listProviders(this.providerCtx, tenantId);
  }
  async get(tenantId: string, providerId: string): Promise<ProviderRecord | undefined> {
    return getProvider(this.providerCtx, tenantId, providerId);
  }
  async create(record: ProviderRecord): Promise<void> {
    return createProvider(this.providerCtx, record);
  }
  async update(
    tenantId: string,
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    return updateProvider(this.providerCtx, tenantId, providerId, patch);
  }
  async delete(tenantId: string, providerId: string): Promise<boolean> {
    return deleteProvider(this.providerCtx, tenantId, providerId);
  }
  async updateGlobal(
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    return updateGlobalProvider(this.providerCtx, providerId, patch);
  }

  async deleteGlobal(providerId: string): Promise<boolean> {
    return deleteGlobalProvider(this.providerCtx, providerId);
  }
  async listModels(tenantId: string, providerId: string): Promise<readonly ModelCatalogEntry[]> {
    const byProvider = await listModelsForTenant(this.modelCtx, tenantId, providerId);
    return byProvider.get(providerId) ?? [];
  }

  /**
   * Every enabled-and-disabled model row the tenant can see, grouped by
   * provider. One pair of statements for the whole tenant instead of a pair per
   * provider. See `store-model-operations.ts`.
   */
  async listModelsForTenant(
    tenantId: string,
    providerId?: string,
  ): Promise<Map<string, readonly ModelCatalogEntry[]>> {
    return listModelsForTenant(this.modelCtx, tenantId, providerId);
  }
  async registerModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
    wireFamily?: string,
    metadata?: ModelMetadataOverride,
    serviceKind?: ServiceKind,
  ): Promise<void> {
    return registerModels(
      this.modelCtx,
      tenantId,
      providerId,
      modelIds,
      wireFamily,
      metadata,
      serviceKind,
    );
  }

  /** One-shot connectivity probe and model discovery; see `store-model-operations.ts`. */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    return this.probing.probeModel(tenantId, providerId, request);
  }

  /** Ad-hoc BYOK connectivity test; delegates to the shared probing service. */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    return this.probing.testByokConnection(tenantId, request);
  }

  /**
   * Batched provider-wide probe: the first registered model runs sequentially
   * (warms OAuth token / connection pools), the rest run concurrently bounded
   * to 5. Registered model ids come from this store's own catalog read.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    mode?: ProbeModelRequest["mode"],
  ): Promise<ProbeAllModelsResult> {
    return probeAllModels(this.modelCtx, tenantId, providerId, mode);
  }
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult> {
    return this.probing.probeAllAccounts(tenantId, providerId, request);
  }
  /** Toggles a persisted model's routing eligibility. */
  async setModelEnabled(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    return setModelEnabled(this.modelCtx, tenantId, providerId, request);
  }

  /**
   * Updates one model's limits and capability flags. See
   * `store-model-operations.ts`.
   */
  async updateModelMetadata(
    tenantId: string,
    providerId: string,
    request: UpdateModelMetadataRequest,
  ): Promise<boolean> {
    return updateModelMetadata(this.modelCtx, tenantId, providerId, request);
  }

  async deleteModel(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    return deleteModel(this.modelCtx, tenantId, providerId, request);
  }

  async reorderAccounts(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    return reorderAccounts(this.accountCtx, tenantId, providerId, accountIds);
  }

  async listAccountAuthStates(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
    return listAccountAuthStates(this.accountCtx, tenantId, providerId, accountIds);
  }

  async listAccounts(
    tenantId: string,
    providerId: string,
  ): Promise<readonly ProviderAccountResponse[]> {
    return listAccounts(this.accountCtx, tenantId, providerId);
  }

  async listAccountIds(
    tenantId: string,
    providerId: string,
  ): Promise<readonly string[]> {
    return listAccountIds(this.accountCtx, tenantId, providerId);
  }

  async ownsAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return ownsAccountRow(this.accountCtx, tenantId, providerId, accountId);
  }

  async getOwnedAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<OwnedProviderAccountRef | undefined> {
    return getOwnedAccount(this.accountCtx, tenantId, providerId, accountId);
  }

  async getGlobalAccount(
    providerId: string,
    accountId: string,
  ): Promise<OwnedProviderAccountRef | undefined> {
    return getGlobalAccount(this.accountCtx, providerId, accountId);
  }

  async listAllAccounts(tenantId: string): Promise<readonly ProviderAccountResponse[]> {
    return listAllAccounts(this.accountCtx, tenantId);
  }

  async listAllAccountSummaries(
    tenantId: string,
  ): Promise<readonly { providerId: string; status: string }[]> {
    return listAllAccountSummaries(this.accountCtx, tenantId);
  }

  async providerAccountCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; total: number; active: number }[]> {
    return providerAccountCounts(this.accountCtx, tenantId);
  }

  async providerModelCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; count: number }[]> {
    return providerModelCounts(this.accountCtx, tenantId);
  }

  async createAccount(
    tenantId: string,
    providerId: string,
    request: CreateProviderAccountRequest,
  ): Promise<ProviderAccountResponse> {
    return createAccountRow(this.accountCtx, tenantId, providerId, request);
  }

  async createAccountBatch(
    tenantId: string,
    providerId: string,
    requests: readonly CreateProviderAccountRequest[],
  ): Promise<CreateProviderAccountBatchResult> {
    return createAccountBatch(this.accountCtx, tenantId, providerId, requests);
  }

  async updateAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
    patch: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountResponse | undefined> {
    return updateAccountRow(this.accountCtx, tenantId, providerId, accountId, patch);
  }

  async listAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<readonly AccountHealthEventRecord[]> {
    return listAccountHealthEventsRow(this.operationsCtx, tenantId, providerId, accountId);
  }

  async purgeAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<number> {
    return purgeAccountHealthEventsRow(this.operationsCtx, tenantId, providerId, accountId);
  }

  async listBuddyGrowthTasks(
    tenantId: string,
    providerId: string,
    accountId: string,
    dayKey: string,
  ): Promise<readonly BuddyGrowthTaskLedgerEntry[]> {
    return listBuddyGrowthTasksRow(this.operationsCtx, tenantId, providerId, accountId, dayKey);
  }

  async recoverAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return recoverAccountRow(this.operationsCtx, tenantId, providerId, accountId);
  }

  async disableCooldowns(
    tenantId: string,
    providerId: string,
  ): Promise<ProviderAccountBulkActionResult> {
    return disableCooldownsRow(this.operationsCtx, tenantId, providerId);
  }

  async deleteBanned(
    tenantId: string,
    providerId: string,
  ): Promise<ProviderAccountBulkActionResult> {
    return deleteBannedRow(this.operationsCtx, tenantId, providerId);
  }

  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.probing.syncModels(tenantId, providerId);
  }

  /** Read-only discovery; delegates to the same fetch path as sync (area 05). */
  async listDiscoveryCandidates(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly supported: boolean;
    readonly candidates: readonly DiscoverModelCandidate[];
    readonly accountLabel?: string;
  }> {
    return listDiscoveryCandidates(this.modelCtx, tenantId, providerId);
  }

  /**
   * Re-runs discovery on the server, then persists only ids the fresh roster
   * actually advertised (D28/D29/D30/D31). This is the anti-forgery gate: a
   * caller cannot attach a hand-built metadata object to an arbitrary id.
   */
  async commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
  ): Promise<{
    readonly committed: readonly string[];
    readonly skipped: readonly string[];
    readonly synced: number;
  }> {
    return commitDiscoveredModels(this.modelCtx, tenantId, providerId, modelIds);
  }
}
