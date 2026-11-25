// Catalog persistence port: the store contract implemented by the Drizzle
// catalog store and consumed by the catalog operations and routes.

import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "../../../providers/discovery/discovery-types";
import type {
  BuddyGrowthTaskLedgerEntry,
  CreateProviderAccountBatchResult,
  CreateProviderAccountRequest,
  DiscoverModelCandidate,
  ModelCatalogEntry,
  ModelMetadataOverride,
  OwnedProviderAccountRef,
  ProviderAccountBulkActionResult,
  ProviderAccountResponse,
  ProviderRecord,
  SetModelEnabledRequest,
  UpdateModelMetadataRequest,
  UpdateProviderAccountRequest,
} from "./contracts";

export interface ProviderCatalogStore {
  list(tenantId: string): Promise<readonly ProviderRecord[]>;
  get(tenantId: string, providerId: string): Promise<ProviderRecord | undefined>;
  create(record: ProviderRecord): Promise<void>;
  update(
    tenantId: string,
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined>;
  delete(tenantId: string, providerId: string): Promise<boolean>;
  updateGlobal(
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined>;
  deleteGlobal(providerId: string): Promise<boolean>;
  listModels(tenantId: string, providerId: string): Promise<readonly ModelCatalogEntry[]>;
  /**
   * Every model row the tenant can see, grouped by provider id.
   *
   * The bulk counterpart to {@link listModels}: one query pair for the whole
   * tenant rather than one pair per provider, so a caller that needs the entire
   * catalog does not pay a cost that grows with the bundled provider count.
   * `providerId` narrows it to a single provider when the caller already knows
   * which one it wants.
   */
  listModelsForTenant(
    tenantId: string,
    providerId?: string,
  ): Promise<Map<string, readonly ModelCatalogEntry[]>>;
  probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult>;
  /**
   * Ad-hoc connectivity test for an operator-entered BYOK provider that is not
   * persisted yet, so the Add-Custom-Provider modal can validate the base URL
   * and API key before creating anything.
   */
  testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult>;
  probeAllModels(
    tenantId: string,
    providerId: string,
    mode?: ProbeModelRequest["mode"],
  ): Promise<ProbeAllModelsResult>;
  probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult>;
  setModelEnabled(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean>;
  deleteModel(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean>;
  /** BYOK-only: registers one `models` row per id for a just-created provider. */
  registerModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
    wireFamily?: string,
    metadata?: ModelMetadataOverride,
    serviceKind?: string,
  ): Promise<void>;
  /** Edits one owned model's limits and capability flags. False for a shared row. */
  updateModelMetadata(
    tenantId: string,
    providerId: string,
    request: UpdateModelMetadataRequest,
  ): Promise<boolean>;
  syncModels(tenantId: string, providerId: string): Promise<{ synced: number }>;
  /**
   * Read-only `/models` discovery. Never persists. `supported: false` names a
   * provider with no listing endpoint so the UI can fall back to manual add.
   */
  listDiscoveryCandidates(
    tenantId: string,
    providerId: string,
  ): Promise<{ readonly supported: boolean; readonly candidates: readonly DiscoverModelCandidate[]; readonly accountLabel?: string }>;
  /** Persists a verified subset of a fresh discovery as `source="manual"`. */
  commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
  ): Promise<{ readonly committed: readonly string[]; readonly skipped: readonly string[]; readonly synced: number }>;
  listAccounts(tenantId: string, providerId: string): Promise<readonly ProviderAccountResponse[]>;
  /**
   * Existence check for one account under the catalog's visibility rule
   * (tenant-owned or shared/global), without the usage aggregates
   * `listAccounts` computes. Used by routes that only need "is this account
   * reachable" before delegating to a narrower store call.
   */
  ownsAccount(tenantId: string, providerId: string, accountId: string): Promise<boolean>;
  /**
   * The non-secret fields of one account the calling tenant owns outright —
   * `tenant_id` must equal `tenantId`, so a shared/global row never matches.
   * Returns `undefined` for a missing, foreign-tenant, or global account.
   */
  getOwnedAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<OwnedProviderAccountRef | undefined>;
  /** Loads a shared/global account (`tenant_id IS NULL`) for platform-admin ops. */
  getGlobalAccount(
    providerId: string,
    accountId: string,
  ): Promise<OwnedProviderAccountRef | undefined>;
  listAllAccounts(tenantId: string): Promise<readonly ProviderAccountResponse[]>;
  /**
   * Provider-id + status only, for every account the tenant can see. Much
   * cheaper than `listAllAccounts` (which also fetches today/lifetime usage,
   * inflight, pool rows): used by the provider list's "configured" marker and
   * the flat model picker's active-account counts, neither of which reads
   * usage.
   */
  listAllAccountSummaries(tenantId: string): Promise<readonly { providerId: string; status: string }[]>;
  /**
   * Per-provider account totals for the tenant, from one grouped read. Used by
   * the provider list overview (`accountCount` / `activeAccountCount`).
   */
  providerAccountCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; total: number; active: number }[]>;
  /**
   * Per-provider enabled model-row counts for the tenant, from one grouped read.
   * Used by the provider list overview (`modelCount`).
   */
  providerModelCounts(tenantId: string): Promise<readonly { providerId: string; count: number }[]>;
  /**
   * Non-secret upstream auth configuration for the given owned accounts,
   * keyed by account id. Used by the account-export route so a re-import can
   * restore the upstream user id / region that refresh and dispatch are
   * addressed by; never surfaced on the read models.
   */
  listAccountAuthStates(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>>;
  createAccount(
    tenantId: string,
    providerId: string,
    request: CreateProviderAccountRequest,
  ): Promise<ProviderAccountResponse>;
  /**
   * Creates many accounts in one transaction, reporting a per-item outcome.
   *
   * A batch is not an optimisation layered on top of N single creates: it is
   * one connection checkout, so a 40-credential paste is a single round-trip
   * instead of 40 sequential ones.
   */
  createAccountBatch(
    tenantId: string,
    providerId: string,
    requests: readonly CreateProviderAccountRequest[],
  ): Promise<CreateProviderAccountBatchResult>;
  updateAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
    patch: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountResponse | undefined>;
  listAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<readonly AccountHealthEventRecord[]>;
  /** Deletes this account's stored health & error rows; returns the count. */
  purgeAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<number>;
  listBuddyGrowthTasks(
    tenantId: string,
    providerId: string,
    accountId: string,
    dayKey: string,
  ): Promise<readonly BuddyGrowthTaskLedgerEntry[]>;
  recoverAccount(tenantId: string, providerId: string, accountId: string): Promise<boolean>;
  /** One UPDATE over this tenant's cooling accounts (D07/D08); evidence kept. */
  disableCooldowns(tenantId: string, providerId: string): Promise<ProviderAccountBulkActionResult>;
  /** One DELETE over this tenant's banned accounts (D12); idempotent. */
  deleteBanned(tenantId: string, providerId: string): Promise<ProviderAccountBulkActionResult>;
}
