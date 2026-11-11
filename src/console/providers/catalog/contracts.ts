// Provider catalog contracts: the provider/account/model DTOs, the persistence
// boundary, and the compatibility-profile validator shared by the catalog
// routes and the Drizzle catalog store.

import { GatewayError } from "../../../protocol/gateway-error";
import { type ServiceKind, type WireFamily, SERVICE_KINDS, WIRE_FAMILIES } from "../../../protocol/canonical-model";
import type { ProviderRoutingStrategy } from "../../../persistence/schema";
import { isProtectedHeader } from "../../../security/outbound-headers";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import type { CompatibilityProfile } from "../../../providers/provider-metadata";
import type {
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  ProbeAllAccountsResult,
  ProbeAllModelsResult,
  ProbeModelRequest,
  ProbeModelResult,
} from "../../../providers/discovery/discovery-types";

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

/** Display-only warning type shared with the dashboard contract mirror. */
export type { ModelWarning, ModelWarningSeverity } from "../../../providers/provider-model-definition";
import type { ModelWarning } from "../../../providers/provider-model-definition";

/**
 * Outcome of one provider-scoped bulk account action (area 02).
 *
 * A tenant-scoped action never touches shared (`tenant_id IS NULL`) rows; the
 * global-admin pair of routes does. `globalSkipped` counts those rows on the
 * tenant path so the console can say why its visible list and the DB disagree.
 * `deleted`/`missing` are present on delete; `updated` on disable. Both actions
 * are idempotent: a second call finds no matching row and reports zero.
 */
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

const VALID_WIRE_FAMILIES: Record<WireFamily, true> = {
  chat: true,
  responses: true,
  messages: true,
  gemini: true,
};

export function isWireFamily(value: unknown): value is WireFamily {
  return typeof value === "string" && value in VALID_WIRE_FAMILIES;
}

/**
 * Compile-time guard: `VALID_WIRE_FAMILIES` above must cover `WIRE_FAMILIES`
 * exactly, so adding a family to the canonical tuple cannot leave the
 * validator silently rejecting it.
 */
const _wireFamilyCoverage: Record<(typeof WIRE_FAMILIES)[number], true> = VALID_WIRE_FAMILIES;
void _wireFamilyCoverage;

const VALID_SERVICE_KINDS: Record<ServiceKind, true> = {
  llm: true,
  systemone: true,
  websearch: true,
  imageGeneration: true,
  videoGeneration: true,
  embedding: true,
  audioTranscription: true,
  audioSpeech: true,
};

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === "string" && value in VALID_SERVICE_KINDS;
}

/**
 * Compile-time guard: `VALID_SERVICE_KINDS` above must cover `SERVICE_KINDS`
 * exactly, so adding a kind to the canonical tuple cannot leave the validator
 * silently rejecting it.
 */
const _serviceKindCoverage: Record<(typeof SERVICE_KINDS)[number], true> = VALID_SERVICE_KINDS;
void _serviceKindCoverage;

const TOKEN_REGEX = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;

const ADAPTER_OWNED: Record<string, true> = {
  "x-stainless-arch": true,
  "x-stainless-os": true,
  "x-account-id": true,
  "x-device-id": true,
  "x-session-id": true,
  "anthropic-version": true,
  "anthropic-beta": true,
  "x-app": true,
  originator: true,
  "chatgpt-account-id": true,
  "openai-beta": true,
};

export function validateCompatibilityProfile(profile: CompatibilityProfile): void {
  if (profile.service_kinds !== undefined) {
    if (!Array.isArray(profile.service_kinds)) {
      throw new GatewayError("invalid_request", 400, "service_kinds must be an array (request {requestId}). Check the shape of what you sent — then resend 🪞");
    }
    for (const kind of profile.service_kinds) {
      if (!isServiceKind(kind)) {
        throw new GatewayError("invalid_request", 400, `unknown service kind ${String(kind)} (request {requestId}). Check the shape of what you sent — then resend 🪞`);
      }
    }
  }
  if (profile.cli_identity !== undefined) {
    if (typeof profile.cli_identity !== "boolean") {
      throw new GatewayError("invalid_request", 400, "cli_identity must be boolean (request {requestId}). Check the shape of what you sent — then resend 🪞");
    }
  }
  if (profile.gateway_user_agent !== undefined) {
    if (typeof profile.gateway_user_agent !== "boolean") {
      throw new GatewayError("invalid_request", 400, "gateway_user_agent must be boolean (request {requestId}). Check the shape of what you sent — then resend 🪞");
    }
  }
  if (profile.extra_headers) {
    for (const [rawName, rawValue] of Object.entries(profile.extra_headers)) {
      const name = rawName.toLowerCase();
      if (name.length < 1 || name.length > 64 || !TOKEN_REGEX.test(name)) {
        throw new GatewayError("invalid_request", 400, `invalid header name ${rawName} (request {requestId}). Check the shape of what you sent — then resend 🪞`);
      }
      if (isProtectedHeader(name, ADAPTER_OWNED)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `header ${rawName} is not allowed as custom header (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (typeof rawValue !== "string") {
        throw new GatewayError(
          "invalid_request",
          400,
          `header value for ${rawName} must be string (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (Buffer.byteLength(rawValue, "utf8") > 4096) {
        throw new GatewayError("invalid_request", 400, `header value for ${rawName} exceeds 4KiB (request {requestId}). We love long reads, but not that long 📚`);
      }
      if (/[\r\n\x00-\x1f\x7f]/.test(rawValue)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `header value for ${rawName} contains control characters (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
    }
  }
  if (profile.extra_query_params) {
    for (const [k, v] of Object.entries(profile.extra_query_params)) {
      if (typeof v !== "string")
        throw new GatewayError("invalid_request", 400, `query param ${k} must be string (request {requestId}). Check the shape of what you sent — then resend 🪞`);
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v))
        throw new GatewayError("invalid_request", 400, `query param contains CRLF (request {requestId}). Check the shape of what you sent — then resend 🪞`);
    }
  }
  if (profile.endpoint_paths_by_wire_family) {
    for (const [wf, path] of Object.entries(profile.endpoint_paths_by_wire_family)) {
      if (!isWireFamily(wf)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family: unknown wire family ${wf} (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (typeof path !== "string") {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} must be string (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (path.length === 0 || path.length > 256) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path length must be 1-256 chars (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (!path.startsWith("/")) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path must start with / (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (/[\s\r\n\x00-\x1f\x7f]/.test(path)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `endpoint_paths_by_wire_family.${wf} path contains invalid characters (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
    }
  }
  if (profile.model_wire_families) {
    if (!Array.isArray(profile.model_wire_families)) {
      throw new GatewayError("invalid_request", 400, "model_wire_families must be an array (request {requestId}). Check the shape of what you sent — then resend 🪞");
    }
    for (const rule of profile.model_wire_families) {
      if (typeof rule?.pattern !== "string" || rule.pattern.length === 0) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model_wire_families[].pattern must be a non-empty string (request {requestId}). Check the shape of what you sent — then resend 🪞",
        );
      }
      if (rule.pattern.length > 256) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model_wire_families[].pattern must be at most 256 chars (request {requestId}). Check the shape of what you sent — then resend 🪞",
        );
      }
      try {
        new RegExp(rule.pattern);
      } catch {
        throw new GatewayError(
          "invalid_request",
          400,
          `model_wire_families[].pattern ${rule.pattern} is not a valid regular expression (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
      if (!isWireFamily(rule.wire_family)) {
        throw new GatewayError(
          "invalid_request",
          400,
          `model_wire_families[].wire_family: unknown wire family ${String(rule.wire_family)} (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        );
      }
    }
  }
  if (
    profile.streaming_usage_mode &&
    !["include_usage", "none"].includes(profile.streaming_usage_mode)
  ) {
    throw new GatewayError("invalid_request", 400, "invalid streaming_usage_mode (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  if (profile.structured_output && typeof profile.structured_output.enabled !== "boolean") {
    throw new GatewayError("invalid_request", 400, "structured_output.enabled must be boolean (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  // If any field is present but has no runtime reader, our current reader set covers all fields above.
  const allowed: Record<string, true> = {
    extra_headers: true,
    extra_query_params: true,
    endpoint_paths_by_wire_family: true,
    // Validated above and read by `probe-phases.ts` during model discovery:
    // per-model wire-family routing for BYOK rows.
    model_wire_families: true,
    // Validated above and read by `compatible-adapter.ts` at dispatch.
    streaming_usage_mode: true,
    structured_output: true,
    // Read by `resolveCustomCliHeaders` in provider-catalog-service: a custom
    // provider's BYOK adapter stamps official CLI identity headers unless the
    // operator opts out. Omitting it here rejected every create/update that
    // carried the flag the dashboard always sends.
    cli_identity: true,
    // Explicit gateway-identity opt-in for BYOK rows (mirrors
    // `ApiKeyProviderSpec.gatewayUserAgent` for bundled specs).
    gateway_user_agent: true,
  };
  for (const k of Object.keys(profile)) {
    if (!allowed[k]) {
      throw new GatewayError(
        "invalid_request",
        400,
        `unknown compatibility_profile field ${k} has no runtime reader (request {requestId}). Check the shape of what you sent — then resend 🪞`,
      );
    }
  }
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
  secret: string;
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
  /** `false` only for a genuinely credential-less provider (OpenCode Free) —
   * the dashboard hides account creation for it since none is usable. */
  requiresAccount: boolean;
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
