// Provider catalog contracts: the provider/account/model DTOs exchanged with
// the console, the runtime constants those DTOs project, the persistence port
// implemented by the Drizzle catalog store, and the compatibility-profile
// validator shared by the catalog routes and the store. Consumers import all
// of it from `./contracts`.

// Catalog contract constants: runtime tuples and scope vocabularies shared by
// the route Elysia schemas, the operations layer, and the dashboard contract
// mirror.

/**
 * Credential kinds a provider account may carry, as a runtime tuple. The
 * create/update request types and the catalog route's Elysia schema both
 * project it.
 */
export const CREDENTIAL_KINDS = ["api_key", "oauth", "none"] as const;

/** One credential kind. */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** Operator-facing credential detection override. */
export const CREDENTIAL_MODES = ["auto", "jwt", "api_key"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];
export const PROVIDER_ROUTING_MAX_INFLIGHT_BOUNDS = { min: 1, max: 10_000 } as const;

/**
 * Scopes that grant catalog access, one pair per resource.
 *
 * Two principals reach these routes and their vocabularies differ: a browser
 * session holds `dashboard:*`, a tenant API key is granted `providers:*` /
 * `models:*`. Keeping both pairs here — rather than at each call site — means a
 * route cannot accidentally accept one principal and lock out the other, and
 * the read/write split is stated once.
 *
 * The catalog scopes stand alone, and that is the point: `dashboard:write` is
 * *not* in these lists. It is a scope a tenant API key can hold, and a key
 * minted to change a display setting must not thereby be able to add an
 * upstream or delete a model — those writes change where traffic goes and which
 * credentials are used. The browser session is granted the catalog scopes
 * explicitly (see `resolveConsoleAccess`) because it is the operator, so the
 * dashboard keeps working without widening what `dashboard:write` means.
 */
export const PROVIDER_READ_SCOPES = ["providers:read"] as const;
export const PROVIDER_WRITE_SCOPES = ["providers:write"] as const;
export const MODEL_READ_SCOPES = ["models:read"] as const;
export const MODEL_WRITE_SCOPES = ["models:write"] as const;

/**
 * Account enable/disable states an operator may set, as a runtime tuple.
 * `cooldown` is health-machine-only and deliberately absent.
 */
export const ACCOUNT_STATUSES = ["active", "disabled"] as const;

/** One operator-settable account status. */
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

// Catalog domain contracts: provider/account/model request and response DTOs
// exchanged with the console, plus the externally owned types re-exported for
// dashboard consumers.

import type { ProviderRoutingStrategy } from "../../../persistence/schema";
import type { CompatibilityProfile } from "../../../providers/provider-metadata";
import type { ModelWarning } from "../../../providers/provider-model-definition";
import type {
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "../../../providers/discovery/discovery-types";
import type { ServiceKind, WireFamily } from "../../../protocol/canonical-model";

/** Display-only warning type shared with the dashboard contract mirror. */
export type { ModelWarning, ModelWarningSeverity } from "../../../providers/provider-model-definition";

/**
 * Outcome of one provider-scoped bulk account action (area 02).
 *
 * A tenant-scoped action never touches shared (`tenant_id IS NULL`) rows; the
 * global-admin pair of routes does. `globalSkipped` counts those rows on the
 * tenant path so the console can say why its visible list and the DB disagree.
 * `deleted`/`missing` are present on delete; `updated` on disable. Both actions
 * are idempotent: a second call finds no matching row and reports zero.
 */
/**
 * The non-secret slice of an owned `provider_accounts` row, for callers that
 * need admission fields (`credentialKind`, `staticToken`) without the
 * credential material or the response projection.
 */
export interface OwnedProviderAccountRef {
  readonly id: string;
  readonly providerId: string;
  readonly tenantId: string | null;
  readonly credentialKind: CredentialKind;
  readonly staticToken: boolean;
}

export interface ProviderAccountBulkActionResult {
  readonly ok: boolean;
  readonly updated: number;
  readonly deleted?: readonly string[];
  readonly missing?: readonly string[];
  readonly globalSkipped: number;
}

/**
 * One model the provider's own listing advertised, projected for the Add-Model
 * picker. Read-only: `GET .../models/discover` writes nothing. `models`
 * metadata here is the fetched `ModelDefinition`, not the static catalog's
 * guess, so the operator can see exactly what the commit will store.
 */
export interface DiscoverModelCandidate {
  readonly modelId: string;
  readonly wireFamily: string;
  readonly serviceKind: string;
  readonly endpointPath: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly freeTier?: boolean;
  readonly proOnly?: boolean;
  readonly alreadyRegistered: boolean;
}

/** Result of `GET .../models/discover`. */
export interface DiscoverModelCandidatesResponse {
  readonly supported: boolean;
  readonly candidates: readonly DiscoverModelCandidate[];
  /** Label of the usable account whose credential fetched the listing (D27). */
  readonly accountLabel?: string;
}

/** Body of `POST .../models/discover/commit`. */
export interface DiscoverModelCommitRequest {
  readonly modelIds: readonly string[];
}

/** Outcome of a discovery commit: the ids persisted and the ones skipped. */
export interface DiscoverModelCommitResult {
  readonly ok: boolean;
  readonly committed: readonly string[];
  readonly skipped: readonly string[];
  readonly synced: number;
}

export interface CreateProviderRequest {
  providerId: string;
  label?: string;
  enabled?: boolean;
  capabilityProfile?: Record<string, unknown>;
  wireFamily?: string;
  baseUrl?: string;
  compatibilityProfile?: CompatibilityProfile;
  /** BYOK-only: model ids to register for this provider (one `models` row per entry). */
  models?: readonly string[];
  /**
   * BYOK-only: the upstream answers without any credential, so no account
   * (or a credential-less "Public Key" account) is required. Omitted means
   * the default (`true`) — every custom provider still requires an account.
   */
  requiresAccount?: boolean;
}
export interface ModelCatalogResponse {
  modelId: string;
  route: string;
  provider: string;
}
export interface ModelCatalogEntry {
  modelId: string;
  route: string;
  provider: string;
  wireFamily: string;
  /**
   * Protocol shape at all (`llm` or a native service such as `systemone`).
   * `llm` flows through the canonical chat pipeline; a non-`llm` row is served
   * by its native route and its `route` points at that endpoint.
   */
  serviceKind: string;
  enabled: boolean;
  // Metadata (null = not yet enriched)
  contextLimit: number | null;
  outputLimit: number | null;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  /** Accepts PDF/plain-file input parts. */
  document: boolean;
  /** Accepts audio input parts. */
  audio: boolean;
  mediaGeneration: boolean;
  cost: {
    input: number | null;
    output: number | null;
    cache_read?: number;
    pricing_model?: "pay-per-use" | "subscription" | "unknown";
  } | null;
  source: string | null;
  sourceUpdatedAt: string | null;
  /**
   * True when no catalog row filed this model, so `contextLimit`/`outputLimit`
   * are a shared fallback rather than anything measured. The surface marks them
   * so an operator can tell a measured window from a stand-in.
   */
  limitsEstimated?: boolean;
  /**
   * True when the provider refuses this model on a free plan, so the surface
   * can mark it rather than letting an operator discover it from a dispatch
   * failure.
   *
   * Absence is "tier unknown", not "served on a free plan" — most providers
   * publish nothing about plan access, and a pill that renders unknown as free
   * would mislabel every one of them.
   */
  proOnly?: boolean;
  /**
   * True when the provider publishes this row as free, so the surface can show
   * the tier instead of an operator discovering it from the pricing.
   *
   * Absence is "tier unknown", not "not free": the flag is only set where the
   * provider's own model directory states it.
   */
  freeTier?: boolean;
  /** Display-only warnings; `null` in storage means none. */
  warnings?: readonly ModelWarning[];
}
export interface FlatModelCatalogEntry {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly qualified: string;
  readonly entry: ModelCatalogEntry;
  /**
   * Where this entry came from. `model` rows are the default; `alias` and
   * `combo` are operator-defined routing targets that resolve to one or more
   * `model` rows at dispatch time. The picker renders all three.
   */
  readonly kind: "model" | "alias" | "combo";
}
/** Request accepted for a one-shot model connectivity test. `route`
 * disambiguates when a model id is registered under multiple endpoint
 * paths; omit it to probe against the model's already-registered wire
 * shape, or provide `wireFamily` to test a not-yet-registered candidate. */
export type { ProbeAllAccountsResult, ProbeAllModelsResult, ProbeModelRequest, ProbeModelResult };
export type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
} from "../../../providers/discovery/discovery-types";
export interface SetModelEnabledRequest {
  modelId: string;
  route: string;
  enabled: boolean;
}

/**
 * Operator-supplied metadata for a model whose limits the catalog cannot know
 * — a manually added id, or one discovery fetched without a context size.
 *
 * `passthrough` is the "accept everything" escape hatch: it grants every
 * capability at once rather than enumerating them, so the caller does not have
 * to guess which flags a model it has never probed actually supports. It
 * supersedes the individual flags rather than adding to them.
 *
 * Absent fields mean "leave the stored value alone" on update, and "derive from
 * the catalog" on register.
 */
export interface ModelMetadataOverride {
  readonly contextLimit?: number | null;
  readonly outputLimit?: number | null;
  /** True to grant every capability; overrides the per-flag fields below. */
  readonly passthrough?: boolean;
  readonly image?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  /**
   * Display-only warnings, editable only on non-builtin rows. `null` clears
   * the stored value; absence leaves it alone.
   */
  readonly warnings?: readonly ModelWarning[] | null;
}

/** Register payload: model ids plus optional operator metadata. */
export interface RegisterModelsRequest {
  readonly modelIds: readonly string[];
  readonly wireFamily?: string;
  readonly metadata?: ModelMetadataOverride;
}

/** Update payload for one existing model row. */
export interface UpdateModelMetadataRequest extends SetModelEnabledRequest {
  readonly metadata?: ModelMetadataOverride;
}
/** Credential input accepted when provisioning a provider account. Never echoed back.
 * Concurrency is governed by Routing Strategy, not by an account field. */
export interface CreateProviderAccountRequest {
  label?: string;
  credentialKind: CredentialKind;
  credentialMode?: CredentialMode;
  /**
   * Omitted for a credential-less (`none`) account — the "Public Key" row a
   * no-key custom provider registers sends no credential at all. Required for
   * `api_key`/`oauth` at the store, which rejects an account whose kind claims
   * a credential but carries none.
   */
  secret?: string;
  /**
   * Non-secret upstream auth configuration for this account — auth method,
   * region, the upstream profile it is bound to. Optional: most providers
   * dispatch with the secret alone.
   */
  authState?: Readonly<Record<string, unknown>>;
}

/**
 * One account in a batch create.
 *
 * Identical to {@link CreateProviderAccountRequest} minus nothing: a batch is
 * just a list of single creates submitted together, so the per-account rules
 * (credential detection, duplicate fingerprinting) stay in exactly one place
 * rather than being restated for a second shape.
 */
export type CreateProviderAccountBatchItem = CreateProviderAccountRequest;

/**
 * Result of one item in a batch create.
 *
 * Per-item rather than all-or-nothing: an operator pasting 40 credentials wants
 * the 38 that were fine to land even if two are duplicates. `index` ties each
 * outcome back to the request position so the dashboard can report which paste
 * line failed without the client re-matching on label.
 */
export interface CreateProviderAccountBatchItemResult {
  readonly index: number;
  readonly ok: boolean;
  /** Present only when `ok` is true. */
  readonly account?: ProviderAccountResponse;
  /** Present only when `ok` is false. */
  readonly error?: string;
  /** Stable machine-readable reason, so the client can branch without matching text. */
  readonly code?: string;
}

/** Aggregate outcome of a batch create. */
export interface CreateProviderAccountBatchResult {
  readonly created: number;
  readonly failed: number;
  readonly results: readonly CreateProviderAccountBatchItemResult[];
}

/** Patch accepted when editing or revoking an existing account. */
export interface UpdateProviderAccountRequest {
  label?: string;
  secret?: string;
  status?: AccountStatus;
  /**
   * Marks the credential as a static bearer token that must never be sent to a
   * refresh endpoint (a pasted JWT/access token, or an account whose refresh
   * grant is gone but whose token still works). `true` skips the account in the
   * refresh sweep; `false` returns it to normal OAuth refresh handling.
   */
  staticToken?: boolean;
}
/**
 * Response of `POST /providers/:providerId/accounts/:accountId/refresh-token`
 * (area 04). The refresh never changes `status`: `statusAfter` is re-read from
 * the database after the attempt and is never `"active"` by fiat — a disabled
 * account stays disabled, only an operator can re-enable it.
 */
export interface RefreshAccountTokenResponse {
  readonly ok: boolean;
  readonly statusAfter: string;
  /** True when an upstream token refresh actually minted a fresh token. */
  readonly tokenRefreshed?: boolean;
  /** ISO timestamp of the fresh access-token expiry, when known. */
  readonly expiresAt?: string;
  /** ISO timestamp of the refresh attempt. */
  readonly refreshedAt?: string;
  /** Structured reason when `ok` is false (`not_oauth`, `static_token`, …). */
  readonly error?: string;
  /** Human detail (failure message) when available. */
  readonly category?: string;
}

export interface ProviderAccountTokenUsage {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AccountInflightReading {
  readonly accountId: string;
  readonly inflight: number;
}

/** Public account representation; never carries the decrypted secret.
 * Effective concurrency comes from the provider Routing Strategy value, which
 * the route snapshot publishes to admission. This projection carries account
 * identity, status, and usage only. */
export interface ProviderAccountResponse {
  id: string;
  providerId: string;
  tenantId: string | null;
  label: string;
  /** Structured identity learned from an OAuth login, when the provider exposed one. */
  accountEmail?: string;
  accountName?: string;
  credentialKind: CredentialKind;
  credentialMode?: CredentialMode;
  /**
   * Which sign-in family issued this credential, read from the account's
   * `auth_state` (e.g. `social`/`oidc`/`api_key` for Kiro). Surfaced so the
   * console can badge an account by how it logged in without shipping the
   * whole auth state to the browser.
   */
  authMethod?: string;
  tokenExpiresAt?: string;
  /**
   * Who issued this credential, read from the JWT `iss` claim at registration
   * time. Present only for static JWTs, and only when the payload carried the
   * claim: the secret is never readable after registration, so this is the one
   * record of where the token came from.
   */
  jwtIssuer?: string;
  status: string;
  /** Live routing admission count for this request path; absent when unavailable. */
  inflight?: number;
  /** Token aggregates are tenant-scoped and use a UTC calendar day. */
  usageToday: ProviderAccountTokenUsage;
  usageAllTime: ProviderAccountTokenUsage;
  consecutiveFailures?: number;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorCategory?: string;
  lastErrorAt?: string;
  cooldownUntil?: string;
  modelCooldowns?: Readonly<Record<string, string>>;
  lastRecoveredAt?: string;
  createdAt: string;
  /**
   * The credential is a static bearer token used as issued and never refreshed.
   * Surfaced so the console shows an informational "static token" pill instead
   * of treating the account as broken; the account stays dispatchable.
   */
  staticToken?: boolean;
  /** Stable list position within this provider; the console's "Added" order. */
  sortIndex: number;
  /**
   * Row flavor. `"pool"` marks a pool-as-account entity (see
   * `provider_pool_accounts`): it is an account-equivalent for an
   * ip-scoped, credential-less provider, resolves no credential, and is
   * owned by its pool. Absent means a real `provider_accounts` row.
   */
  kind?: "pool";
  /** The owning pool row (present for `kind: "pool"`). */
  networkPoolId?: string;
  /**
   * Provider-scoped rate-limit markers on the owning pool, when this is a
   * pool-as-account row. Mirrors `NetworkPoolResponse.providerCooldowns`: a
   * 429 cooldown refills, a block means the upstream retired the egress
   * address. Absent for real accounts and for pools with no markers.
   */
  providerCooldowns?: Array<{
    providerId: string;
    until: string;
    reason: string;
    blocked: boolean;
  }>;
}
/**
 * Plaintext export of one account's decrypted provider tokens.
 *
 * Deliberately distinct from `ProviderAccountResponse` (which never carries
 * credentials): only the export endpoint returns this shape, and the dashboard
 * downloads it as a JSON file rather than rendering it.
 */
export interface ProviderAccountExport {
  id: string;
  providerId: string;
  label: string;
  credentialKind: CredentialKind;
  status: string;
  /** Decrypted provider access credential; empty only when resolution failed. */
  accessToken: string;
  /** Decrypted OAuth refresh token, omitted when the account has none. */
  refreshToken?: string;
  /**
   * Non-secret upstream auth configuration carried on the account (the
   * upstream user id, provisioned region, auth method, profile). Re-import
   * must restore it: Trae refresh is addressed per upstream user id, and the
   * data-plane host is region-scoped, so dropping it breaks re-imported
   * accounts on their first refresh or dispatch.
   */
  authState?: Readonly<Record<string, unknown>>;
  createdAt: string;
  /** Live routing admission count at export time; absent when unavailable. */
  inflight?: number;
  cooldownUntil?: string;
  lastErrorCategory?: string;
}
/**
 * One buddy growth-task ledger row: the stamp that says this account's task
 * was attempted today. Read-only — the console observes, it does not write.
 */
export interface BuddyGrowthTaskLedgerEntry {
  readonly accountId: string;
  readonly task: string;
  readonly claimedAt: string;
}
/** Response body of `POST /accounts/export`. */
export interface ProviderAccountsExportResponse {
  exportedAt: string;
  accounts: ProviderAccountExport[];
}
export interface UpdateProviderRequest {
  label?: string;
  enabled?: boolean;
  capabilityProfile?: Record<string, unknown>;
  baseUrl?: string;
  compatibilityProfile?: CompatibilityProfile;
}
/**
 * One operator-supplied value a login needs.
 *
 * Mirrors the registry's own field descriptor rather than importing it: this is
 * the browser-facing contract, and the dashboard must not depend on the
 * provider layer to render a form.
 */
export interface ProviderLoginField {
  readonly key: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string;
}

export interface ProviderClientVersion {
  /** The client the adapter presents itself as. */
  readonly client: string;
  readonly version: string;
  readonly source: "latest" | "fallback";
}

export interface RouteIdentityVersions {
  readonly codex: string;
  readonly claude: string;
}

export interface ProviderResponse {
  providerId: string;
  /** Executable service surfaces; missing legacy declarations mean LLM only. */
  serviceKinds: readonly ServiceKind[];
  /** Canonical backend display name; custom providers fall back to providerId. */
  displayName: string;
  label?: string;
  enabled: boolean;
  isBuiltIn: boolean;
  /** True when this tenant has any persisted account for the provider. */
  configured?: boolean;
  /**
   * Number of provider accounts this tenant has for the provider. Present on
   * list items (the Providers page overview); absent elsewhere.
   */
  accountCount?: number;
  /**
   * Accounts whose status is not disabled/revoked — an account parked by the
   * health machine (`cooldown`) still counts. Present on list items.
   */
  activeAccountCount?: number;
  /** Enabled model rows the tenant can see for the provider. Present on list items. */
  modelCount?: number;
  /** `false` only for a genuinely credential-less provider (OpenCode Free).
   * For a custom provider, the "Public Key" account still routes it, so the
   * dashboard keeps account creation available rather than hiding the card. */
  requiresAccount: boolean;
  /** The provider was created with the "Public Key" switch: no credential is
   * sent, and the registered account is the credential-less "Public Key" row. */
  publicKey?: boolean;
  /** Whether its built-in adapter constructs a User-Agent header itself. */
  hasAdapterUserAgent: boolean;
  /**
   * Whether this provider serves a hosted web-search tool on its chat wire.
   *
   * A provider-level fact, not a model-row fact: the adapter either frames a
   * hosted search tool or it does not, and every model it serves inherits it.
   * A pure search provider (`serviceKinds: ["websearch"]`) is `false` here —
   * it answers `/v1/search` but never a chat turn.
   */
  supportsWebSearch: boolean;
  /** Where the operator obtains this provider's credential. Presentation-only. */
  credentialUrl?: string;
  /** One line of guidance beside {@link credentialUrl} when the flow is not a plain paste. */
  credentialHint?: string;
  /** Presentation-only limitation shown on the provider detail page. */
  operatorNotice?: string;
  capabilityProfile?: Record<string, unknown>;
  baseUrl?: string;
  compatibilityProfile?: CompatibilityProfile;
  createdAt?: string;
  updatedAt?: string;
  /** Latest known client version; `fallback` means upstream discovery has not succeeded. */
  clientVersion?: ProviderClientVersion;
  /** Live Codex and Claude versions offered by the route-identity control. */
  routeIdentityVersions: RouteIdentityVersions;
  oauthFlows?: {
    readonly browser: boolean;
    readonly device: boolean;
    /**
     * The client can complete a login from pasted credential material, so the
     * console offers an import path alongside the redirect and device flows.
     */
    readonly import: boolean;
    /**
     * The imported credential is a refreshable token pair rather than a static
     * key: the client can both import and refresh.
     *
     * Import-only clients otherwise look identical to API-key providers — no
     * redirect, no device code — and were grouped with them, which filed a
     * refreshable OAuth account under "API Key Providers" where nothing
     * explains that it expires and renews.
     */
    readonly refreshable: boolean;
    /** Fields the browser flow must collect before it starts. */
    readonly browserLoginFields: readonly ProviderLoginField[];
    /** Fields the device flow must collect before it starts. */
    readonly deviceLoginFields: readonly ProviderLoginField[];
    /** Fields the import flow needs. */
    readonly importFields: readonly ProviderLoginField[];
  };
  /** Whether the provider supports dynamic model discovery. Custom providers always support it. */
  supportsModelDiscovery: boolean;
  /** Default wire family for this provider's models — the family the operator
   * chose when creating a custom provider. Absent means the column default. */
  wireFamilyDefault?: WireFamily;
  /** Wire families this provider may actually serve, derived from the registry
   * (built-ins) or the BYOK profile (custom). Absent means the provider
   * declares nothing and the caller's own choice stands. */
  supportedWireFamilies?: readonly WireFamily[];
}
export interface ProviderRecord extends Omit<ProviderResponse, "hasAdapterUserAgent" | "routeIdentityVersions"> {
  tenantId: string | null;
}

/**
 * Console device-poll DTO: the browser-visible projection of the provider
 * device flow. Deliberately distinct from the provider-internal
 * `OAuthDevicePollResult` (`providers/auth/flows.ts`), which carries token
 * material that must never reach the dashboard — this shape carries only
 * the persisted account id. Dashboard imports this type; do not mirror it.
 */
export type OAuthDevicePollResponse =
  /** Still waiting; `retryAfterSeconds` adopts the server cadence when sent. */
  | { status: "pending"; retryAfterSeconds?: number }
  /** The provider asked us to poll more slowly; the dashboard reschedules. */
  | { status: "slow_down"; retryAfterSeconds?: number }
  | { status: "complete"; accountId: string }
  | { status: "failed"; reason: string };

export interface ProviderRoutingResponse {
  readonly providerId: string;
  readonly tenantId: string | null;
  readonly strategy: ProviderRoutingStrategy;
  /** Requests served by one account before round robin advances. */
  readonly rotateCount: number;
  /** Per-account inflight ceiling; `null` = unlimited concurrency. */
  readonly maxInflight: number | null;
  /** Per-pool inflight ceiling for this provider — how many concurrent
   * requests one proxy pool may carry for it. `null` = unlimited, the default. */
  readonly maxInflightPerProxy: number | null;
  /** Minimum remaining allowance an account must hold to stay routable.
   * `null` means no floor. */
  readonly usageFloor: number | null;
  /** `credit` sums remaining credit; `percent` uses aggregate credit percentage
   * and the lowest independent percentage-only window. */
  readonly usageFloorUnit: "credit" | "percent";
  readonly enabled: boolean;
  /** When true, this provider's requests always dial direct. When false,
   * dispatch automatically picks the least-loaded, non-cooldown pool among
   * every active network pool the tenant owns — never an admin-pinned
   * single pool. Some providers (see `DEFAULT_PROXY_SKIP_PROVIDER_IDS`)
   * default to skipping because their transport can't route through an HTTP
   * CONNECT proxy; it stays a real, per-tenant-overridable setting. */
  readonly skipProxy: boolean;
  /** How device-code OAuth flows choose their egress: `random` (default)
   * routes start+poll through a randomly selected active network pool so the
   * upstream sees a rotating IP; `direct` always dials direct egress. */
  readonly deviceFlowProxy: "random" | "direct";
  /** Built-in API-key upstream User-Agent; OAuth and custom providers retain their own identity. */
  readonly userAgent: string;
  /** Operator-set custom User-Agent override; `null` = no override (native identity is used). */
  readonly customUserAgent: string | null;
}

/**
 * Patch accepted when editing a provider's routing settings. Every field is
 * optional and the types are the runtime's own: restating the six fields here
 * let the request drift from `ProviderRoutingSetting` (and from the Elysia body
 * schema that validates it) without a compile error.
 */
/**
 * Patch accepted when editing a provider's routing settings. Declared here
 * rather than as `Partial<ProviderRoutingSetting>`: that type lives in the
 * routing engine, and the console must not depend on the transport layer for
 * its own request contract. The fields mirror the persisted
 * `provider_routing_settings` row.
 */
export interface UpdateProviderRoutingRequest {
  readonly strategy?: ProviderRoutingStrategy;
  /** Requests served by one account before round robin advances. */
  readonly rotateCount?: number;
  /** Per-account inflight ceiling; `null` = unlimited concurrency. */
  readonly maxInflight?: number | null;
  /** Per-pool inflight ceiling for this provider; `null` = unlimited. */
  readonly maxInflightPerProxy?: number | null;
  /** Minimum remaining allowance; `null` clears the floor. */
  readonly usageFloor?: number | null;
  readonly usageFloorUnit?: "credit" | "percent";
  readonly enabled?: boolean;
  /** When true, this provider's requests always dial direct. */
  readonly skipProxy?: boolean;
  /** How device-code OAuth flows choose their egress; absent = keep current. */
  readonly deviceFlowProxy?: "random" | "direct";
  /** Built-in API-key upstream User-Agent. */
  readonly userAgent?: string;
  /** Operator-set custom User-Agent override; `null` clears it back to native. */
  readonly customUserAgent?: string | null;
}

export * from "./contracts-validators";
export * from "./store-port";
