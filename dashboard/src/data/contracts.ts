import type { healthStatus } from "../../../src/persistence/schema";
import type { SessionStatusResponse } from "../../../src/console/auth/session";
// Remote-support tunnel types come from the backend contract module, which is
// free of Elysia and Node imports and therefore safe in the browser bundle.
export type {
  RemoteSupportStatus,
  RemoteSupportStartResponse,
  RemoteSupportTool,
} from "../../../src/console/remote-support/contracts";
export { REMOTE_SUPPORT_TOOLS } from "../../../src/console/remote-support/contracts";
/**
 * Type-only projections of the console API contracts.
 *
 * These exports deliberately point at the existing backend contract modules; the
 * dashboard does not define a second set of endpoint request or response types.
 */
// `USAGE_DIMENSIONS` is re-exported as a value (not a type-only import) because
// the Usage page validates the `?dim=` query parameter against it at runtime.
// It comes from the pure `usage-dimensions` module rather than
// `observability/contracts`, which imports Elysia and reaches `node:crypto` through the
// error path — re-exporting from there put a Node builtin in the browser bundle.
export { USAGE_DIMENSIONS } from "../../../src/console/observability/usage-dimensions";
export type { UsageDimension } from "../../../src/console/observability/usage-dimensions";
// `TENANT_KEY_SCOPES` is re-exported as a value so the API-key editor renders
// the backend's own assignable-scope list instead of a hand-kept copy. The
// module is pure (no imports), so it is safe in the browser bundle.
export { TENANT_KEY_SCOPES } from "../../../src/security/access-control";
export type { TenantScope } from "../../../src/security/access-control";
// Share-popup image bounds are re-exported as values (like `TENANT_KEY_SCOPES`)
// so the upload control rejects the same formats and size the backend does.
// The module is pure (no imports), so it is safe in the browser bundle.
export {
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
} from "../../../src/console/api-keys/share-popup-image";
// `CLIENT_ROUTER_IDS` is re-exported so the API-key editor offers exactly the
// routers the backend can fingerprint, instead of a hand-kept copy that would
// let the form offer an id the backend rejects. The module is pure (no imports),
// so it is safe in the browser bundle.
export {
  CLIENT_ROUTER_IDS,
  CLIENT_ROUTERS,
  normalizeClientRouterId,
} from "../../../src/security/client-router-fingerprint";

export type {
  SystemHealthResponse,
  UsageByResponse,
  UsageByRow,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestItem,
  UsageRequestsResponse,
  UsageSummaryResponse,
  UsageSummaryTotals,
} from "../../../src/console/observability/contracts";

// The update badge compares the running version against the latest public
// release tag. Both the payload shape and the comparison live in the backend's
// `updates/` domain — the version module is pure, so importing it as a value
// keeps the dashboard from carrying a second, drifted copy of the ordering.
export type { LatestRelease } from "../../../src/console/updates/repository-updates";
export { isNewerRelease } from "../../../src/console/updates/version-compare";

export type {
  AccountInflightReading,
  ProviderResponse,
  CreateProviderRequest,
  UpdateProviderRequest,
  ModelCatalogResponse,  FlatModelCatalogEntry,
  OAuthDevicePollResponse,
  ProviderRoutingResponse,
  UpdateProviderRoutingRequest,
  CreateProviderAccountRequest,
  CreateProviderAccountBatchResult,
  CredentialKind,
  CredentialMode,
  UpdateProviderAccountRequest,
  ProviderAccountResponse,
  ProviderAccountExport,
  ProviderAccountsExportResponse,
  ProbeAllAccountsResult,
  ProbeModelRequest,
  ProbeModelResult,
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  SetModelEnabledRequest,
  BuddyGrowthTaskLedgerEntry,
} from "../../../src/console/providers/catalog/contracts";

/*
 * C3 catalog contracts, re-exported rather than mirrored: the dashboard sees
 * exactly the wire types the console emits. `ModelCatalogEntry` already carries
 * the optional `warnings` projection (area 06), so no local extension is
 * needed and `assertModels` stays loose against it.
 */
export type {
  ProviderAccountBulkActionResult,
  DiscoverModelCandidate,
  DiscoverModelCommitResult,
  ModelWarning,
  ModelWarningSeverity,
  ModelCatalogEntry,
} from "../../../src/console/providers/catalog/contracts";

export type { CompatibilityProfile } from "../../../src/providers/provider-metadata";
export { DISCOVER_MODEL_COMMIT_MAX } from "../../../src/console/providers/catalog/contracts";

/** Convenience alias for the discovery envelope; canonical name is C3's. */
export type DiscoverModelsResponse = DiscoverModelCandidatesResponse;

export type { DiscoverModelCandidatesResponse } from "../../../src/console/providers/catalog/contracts";

/** Result of `POST .../models/discover/commit`. */
export type DiscoverCommitResult = DiscoverModelCommitResult;

import type {
  DiscoverModelCandidatesResponse,
  DiscoverModelCommitResult,
} from "../../../src/console/providers/catalog/contracts";

/** Accepted probe modes; absent on the wire means `detail` (D39). */
export type { ProbeMode } from "../../../src/providers/discovery/discovery-types";
import type { ProbeMode } from "../../../src/providers/discovery/discovery-types";
export type ModelProbeMode = ProbeMode;

export type { ProbeAllModelsResult } from "../../../src/console/providers/catalog/contracts";
import type { ProbeAllModelsResult } from "../../../src/console/providers/catalog/contracts";

/** Result of `POST .../models/test-models` (one row per registered model). */
export type ProbeAllModelsRun = ProbeAllModelsResult;

export type { AccountHealthEventRecord } from "../../../src/providers/operations/account-health-service";

/**
 * Reasoning efforts the probe accepts, as the backend declares them. Re-exported
 * as a value (like `TENANT_KEY_SCOPES`) so the Thinking selector and the route
 * schema cannot drift: `auto` is a member, and it means "send no reasoning
 * intent" rather than a specific effort.
 */
export { PROBE_REASONING_EFFORTS } from "../../../src/providers/discovery/discovery-types";
export type { ProbeReasoningEffort } from "../../../src/providers/discovery/discovery-types";

/**
 * The `model(level)` naming rule, re-exported from the backend parser so the
 * dashboard renders exactly the id a client should send. A hand-written
 * `(level)` string here would drift from `parseThinkingSuffix` the moment
 * either side changes.
 */
export { formatThinkingSuffix } from "../../../src/protocol/translation/thinking";

export type {
  ComboStrategy,
  ModelAliasRow,
  ModelAliasCreateInput,
  ModelAliasPatchInput,
  ModelComboRow,
  ModelComboCreateInput,
  ModelComboPatchInput,
  ModelComboCloneResult,
} from "../../../src/console/routing/model/contracts";

export type {
  CreateApiKeyRequest,
  ApiKeyResponse,
  CreateApiKeyResponse,
  UpdateApiKeyResponse,
  ConcurrencyScope,
  BanApiKeyRequest,
  ShareKeyResponse,
} from "../../../src/console/api-keys/contracts";
export { API_KEY_BAN_REASONS } from "../../../src/console/api-keys/ban-constants";

import type { SharedKeySummary } from "../../../src/console/share/share-usage";

export type {
  SharedKeySummary,
  SharedKeyActivityDetail,
  SharedKeyModelUsage,
  SharedKeyRequestEvent,
} from "../../../src/console/share/share-usage";

/** Paged response of the share-child list endpoint. */
export interface SharedKeyPage {
  readonly rows: readonly SharedKeySummary[];
  readonly total: number;
  readonly active: number;
  readonly revoked: number;
  /** Family-wide lifetime tokens consumed, independent of the page. */
  readonly consumed: number;
}

export type { SharedChildSortColumn } from "../../../src/persistence/stores/api-key-store";

// Backup export returns the payload itself (it is the file the operator
// downloads); import returns the per-table counts plus the router-import
// report, so the page can show what was skipped and why.
export type { BackupPayload as BackupExportResponse } from "../../../src/console/backup/contracts";
export type { ImportResult as BackupImportResponse } from "../../../src/console/backup/service";
export type { ImportReport as BackupImportReport } from "../../../src/console/backup/nine-router";
import type { DeleteAllScope } from "../../../src/console/backup/store";
export type { DeleteAllScope };
export type { AuditEntry, AuditListPage } from "../../../src/console/audit/contracts";

export type {
  RuntimeSettingsResponse,
  UpdateRuntimeSettingsRequest,
} from "../../../src/console/settings/contracts";

// Derived from the backend rather than mirrored: the bucket ids and the
// reclaim action names are what the route validates against, so a hand-written
// copy would drift the first time either side added one.
export type {
  DiskUsageBucket,
  DiskUsageResponse,
  ReclaimAction,
  ReclaimResponse,
  PurgeTarget,
  PurgeResponse,
  FlushResponse,
} from "../../../src/console/data-management/contracts";

export type { RedisBackend } from "../../../src/persistence/redis";

export type HealthStatus = (typeof healthStatus.enumValues)[number];

/**
 * The dashboard's session view: the wire `SessionStatusResponse`, narrowed to
 * its authenticated arm and renamed to the dashboard's camelCase convention.
 * Derived from the backend type rather than hand-written — the previous mirror
 * dropped `username` and made `display_name`/`is_first_boot`/
 * `session_expires_at` required, and nothing compared the two.
 */
export type SessionResponse = SessionStatusResponse;

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly isFirstBoot: boolean;
  readonly sessionExpiresAt: string;
  readonly isPlatformAdmin: boolean;
}

// Speed-test payload bounds are re-exported as values (like `TENANT_KEY_SCOPES`)
// so the size picker offers exactly what the backend accepts. They come from a
// pure module; the pool type contracts are Elysia-free too (routes.ts is the
// only pool module that touches the HTTP layer).
export {
  SPEED_TEST_DEFAULT_BYTES,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MIN_BYTES,
} from "../../../src/console/routing/pools/speed-test-sizes";
export type {
  CreateNetworkPoolRequest,
  NetworkPoolResponse,
  HealthCheckResult,
  PoolProviderProbeResult,
  PoolBatchProviderProbeResult,
  PoolSpeedTestResult,
  PoolStrategySetting,
  PoolBatchProbeResult,
} from "../../../src/console/routing/pools/contracts";
export type {
  RelayDeployRequest,
  RelayDeployResult,
  RelayTarget,
} from "../../../src/console/routing/pools/relay-deploy";
export { RELAY_TARGETS } from "../../../src/console/routing/pools/relay-deploy";
// The region picker renders the backend's own list, so the form cannot offer a
// region the deployer rejects. Both modules are pure, so these are safe values
// in the browser bundle.
export {
  DEFAULT_RELAY_REGION,
  RELAY_REGION_GROUPS,
  RELAY_REGIONS,
} from "../../../src/console/routing/pools/relay-regions";
export type { RelayRegion } from "../../../src/console/routing/pools/relay-regions";
export type { PoolHealthEvent } from "../../../src/network/pool-health-machine";


export type {
  ToolDef,
  ToolRegistryEntry,
  ToolStatus,
  ApplyInput,
  ApplyConfigResult,
  DownloadResult,
  CliMappingInput,
  CliMappingSettings,
} from "../../../src/console/cli-tools/contracts";
