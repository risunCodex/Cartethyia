/**
 * Pure helpers for the provider catalog store: credential parsing, generated
 * labels, and row projections. These are the parts of the store that do not
 * touch the database, kept here so the Drizzle store stays about persistence.
 */
import { decodeJwtPayload } from "../../../providers/authentication/oauth-flow-store";
import {
  asJsonbRecord,
  asRecord,
  firstNonEmptyString as firstString,
  tryParseJson as safeParseJson,
} from "../../../shared/coerce";
import type {
  CredentialMode,
  ModelCatalogEntry,
  ModelWarning,
  ProviderAccountResponse,
  ProviderAccountTokenUsage,
} from "./contracts";
import {
  FALLBACK_CONTEXT_LIMIT,
  FALLBACK_OUTPUT_LIMIT,
} from "../../../providers/provider-model-definition";
import { modelsDevCatalog } from "../../../providers/discovery/models-dev-catalog";
import { liveModelCooldowns } from "./catalog-projections";
import { models } from "../../../persistence/schema";
import type * as schema from "../../../persistence/schema";
import { pickDefined } from "../../shared/object";
/** Field names a pasted OAuth credential may carry its access token under. */
const OAUTH_ACCESS_FIELDS = ["accessToken", "access_token", "access", "token"] as const;
/** Field names a pasted OAuth credential may carry its refresh token under. */
const OAUTH_REFRESH_FIELDS = ["refreshToken", "refresh_token", "refresh"] as const;

/** Parses an expiry field that may be an ISO string, an epoch ms, or epoch seconds. */
function parseExpiry(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: a 10-digit value is epoch seconds, a 13-digit value is ms.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return parseExpiry(asNumber);
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}
/**
 * Reads the two claims a static token's own payload can answer: when it stops
 * working, and who issued it.
 *
 * The issuer is kept because a static JWT carries no other hint of its origin:
 * an operator who pasted one from the wrong surface has nothing in the console
 * to check it against, and several issuers accept the same token shape.
 */
export function parseJwtCredential(
  raw: string,
): { readonly expiresAt?: Date; readonly issuer?: string } | undefined {
  const payload = decodeJwtPayload(raw.trim());
  if (payload === undefined) return undefined;
  const expiresAt = parseExpiry(payload["exp"]);
  const iss = payload["iss"];
  const issuer = typeof iss === "string" && iss.trim().length > 0 ? iss.trim() : undefined;
  return {
    ...pickDefined({ expiresAt }),
    ...pickDefined({ issuer }),
  };
}

/**
 * Splits a pasted OAuth credential into its access token, refresh token, and
 * expiry.
 *
 * The console accepts either a bare access token or the JSON export a client
 * produces (`{accessToken, refreshToken, expiresAt, …}`, possibly nested under
 * `data`). A bare token has no refresh token — the account can be dispatched
 * with it but cannot be refreshed, so the caller stores it as a static
 * API credential instead of sending the access token to a refresh endpoint.
 */
/**
 * Middle segment of an auto-generated account label, from how the credential
 * was actually detected.
 *
 * Only the two kinds that arrive with no name of their own are named here. An
 * OAuth paste carries its own identity in `authState` (the account it was
 * exported from), so it keeps whatever the export or the operator supplied —
 * generating a name for it would overwrite an identity that was already there.
 * An unrecognized mode falls back to `key`, matching the mode it is stored as.
 */
export function accountLabelKindSegment(credentialMode: CredentialMode): string {
  return credentialMode === "jwt" ? "jwt" : "key";
}

/**
 * First unused `<prefix>N` label given the labels already in use.
 *
 * The one numbering rule for generated account labels: the catalog's
 * `dcint-key-N`/`dcint-jwt-N` names and the OAuth re-login's `<providerId>-N`
 * names differ only in their prefix. Counting is case-insensitive on the whole
 * label, so a hand-typed `DCINT-KEY-2` still reserves its number.
 */
export function nextFreeLabel(prefix: string, existingLabels: readonly string[]): string {
  const taken = new Set(
    existingLabels.map((label) => label.trim().toLowerCase()),
  );
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * First unused `dcint-key-N` / `dcint-jwt-N` label for one provider.
 *
 * Polished tokens and plain JWTs are the credentials that arrive nameless: an
 * operator pastes several into one provider and every row came out as
 * "<providerId> account", so five accounts were five identical labels and the
 * list could not tell them apart — which account failed, or is cooling, was
 * unreadable.
 *
 * Numbering runs per kind, so the first JWT is `jwt-1` rather than inheriting
 * whatever number the api_key rows reached (`jwt-3` with no `jwt-1` reads as
 * two missing accounts). Counting is case-insensitive on the whole label, so a
 * hand-typed `DCINT-KEY-2` still reserves its number.
 *
 * Pure, so the numbering can be pinned without a database.
 */
export function nextGeneratedAccountLabel(
  providerId: string,
  credentialMode: CredentialMode,
  existingLabels: readonly string[],
): string {
  const kind = accountLabelKindSegment(credentialMode);
  return nextFreeLabel(`${providerId}-${kind}-`, existingLabels);
}

export function parsePastedOAuthCredential(raw: string): {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date | undefined;
  /**
   * Non-secret account configuration the export carried — the profile the
   * account is bound to, how it authenticates, the region it was minted in.
   * Empty for a bare token, which carries none.
   */
  readonly authState: Readonly<Record<string, unknown>>;
} {
  let record: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    record = undefined;
  }
  if (record === undefined) {
    // Bare token: it is the access token, and there is no refresh token.
    const jwt = parseJwtCredential(raw);
    return {
      accessToken: raw,
      refreshToken: raw,
      expiresAt: jwt?.expiresAt,
      authState: {},
    };
  }
  // A nested `data` object is unwrapped the same way the dashboard's parser does.
  const nested =
    record["data"] !== null && typeof record["data"] === "object" && !Array.isArray(record["data"])
      ? (record["data"] as Record<string, unknown>)
      : undefined;
  const accessToken =
    firstString(record, OAUTH_ACCESS_FIELDS) ??
    (nested ? firstString(nested, OAUTH_ACCESS_FIELDS) : undefined) ??
    raw;
  const refreshToken =
    firstString(record, OAUTH_REFRESH_FIELDS) ??
    (nested ? firstString(nested, OAUTH_REFRESH_FIELDS) : undefined) ??
    accessToken;
  const expiresAt =
    parseExpiry(
      record["expiresAt"] ??
        record["expires_at"] ??
        (nested ? (nested["expiresAt"] ?? nested["expires_at"]) : undefined) ??
        record["expires"] ??
        (nested ? nested["expires"] : undefined),
    ) ?? parseJwtCredential(accessToken)?.expiresAt;
  return { accessToken, refreshToken, expiresAt, authState: pastedAuthState(record, nested) };
}

/**
 * The account configuration a pasted export carries beside its tokens.
 *
 * Kiro refuses a generation request that omits the profile the account is bound
 * to, and exports from older installs carry that profile under a different key.
 * Reading neither is how an imported account probes with no
 * profile and is answered `400 profileArn is required`.
 *
 * A wrapper's own `authState` bag travels wholesale rather than cherry-picked:
 * adapters read provider-specific keys this picker cannot enumerate (Qoder's
 * `machineId`, buddy's `qimei36` device binding, coreweave's
 * project, kiro's `startUrl`), and dropping the bag silently degraded every
 * imported account to a half-identity credential — failing closed at dispatch
 * (Qoder answered 401 "missing its user identity"). The flat aliases below only
 * fill what an older export shape carries beside the bag, and can never invent
 * a key the bag did not have.
 */
function pastedAuthState(
  record: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  const carried = {
    ...(asJsonbRecord(record["providerSpecificData"]) ?? {}),
    ...(asJsonbRecord(record["authState"]) ?? {}),
    ...(asJsonbRecord(nested?.["authState"]) ?? {}),
  };
  // These three are recomputed for the pasted tokens at insert time; a carried
  // copy would describe the previous token, not this one.
  delete carried.credentialMode;
  delete carried.tokenExpiresAt;
  delete carried.jwtIssuer;
  const sources = [record, nested, asJsonbRecord(record["providerSpecificData"])];
  const profileArn = firstStringFrom(sources, ["profileArn", "profile_arn"]);
  const authMethod = firstStringFrom(sources, ["authMethod", "auth_method"]);
  const region = firstStringFrom(sources, ["region"]);
  // The upstream user id, carried on a re-import of an exported account. Trae
  // refresh is addressed per upstream user id, so restoring it is what keeps a
  // re-imported account refreshable.
  const userId = firstStringFrom(sources, ["userId", "user_id", "uid", "UserID"]);
  const machineId = firstStringFrom(sources, ["machineId", "machine_id"]);
  return {
    ...carried,
    ...pickDefined({ profileArn }),
    ...pickDefined({ authMethod }),
    ...pickDefined({ region }),
    ...pickDefined({ userId }),
    ...pickDefined({ machineId }),
  };
}

/**
 * Adds or removes the `image` input modality on a stored modalities blob.
 *
 * The blob is a JSON string whose shape varies by source (bundled seed,
 * discovery, manual add), so it is normalized rather than pattern-matched: an
 * unparseable blob is replaced with the minimal text shape rather than left to
 * corrupt capability preflight.
 */
export function withImageModality(stored: string | null | undefined, image: boolean): string {
  const parsed = asRecord(safeParseJson(stored));
  const input = Array.isArray(parsed?.input)
    ? (parsed.input as unknown[]).filter((m): m is string => typeof m === "string")
    : ["text"];
  const output = Array.isArray(parsed?.output)
    ? (parsed.output as unknown[]).filter((m): m is string => typeof m === "string")
    : ["text"];
  const nextInput = image
    ? Array.from(new Set([...input, "image"]))
    : input.filter((m) => m !== "image");
  return JSON.stringify({
    ...(parsed ?? {}),
    input: nextInput.length > 0 ? nextInput : ["text"],
    output: output.length > 0 ? output : ["text"],
  });
}

/** Normalizes a text column read as `unknown` back to a string or null. */
export function asStoredText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstStringFrom(
  sources: readonly (Record<string, unknown> | undefined)[],
  fields: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (source === undefined) continue;
    const value = firstString(source, fields);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Parsed-warning cache, bounded so a long-lived process cannot grow it with
 * every distinct blob it has ever seen. Warning blobs repeat across rows far
 * more often than they vary (a seeded catalog warning is the same JSON on
 * every row that carries it), so one parse serves many rows and many list
 * reads. Entries are immutable projections — a stored blob never mutates in
 * place, so a hit is always the value a fresh parse would produce.
 */
const WARNING_METADATA_CACHE_LIMIT = 512;
const warningMetadataCache = new Map<string, { warnings: ModelWarning[] } | undefined>();

function cachedWarningMetadata(
  key: string,
  parse: () => { warnings: ModelWarning[] } | undefined,
): { warnings: ModelWarning[] } | undefined {
  if (warningMetadataCache.has(key)) return warningMetadataCache.get(key);
  const parsed = parse();
  if (warningMetadataCache.size >= WARNING_METADATA_CACHE_LIMIT) {
    // Evict the oldest entry: Map iteration is insertion-ordered, and a
    // re-set below re-inserts at the tail so hot keys survive.
    const oldest = warningMetadataCache.keys().next().value;
    if (oldest !== undefined) warningMetadataCache.delete(oldest);
  }
  warningMetadataCache.set(key, parsed);
  return parsed;
}

/**
 * Reads the display-only warning blob. Postgres returns `jsonb` already
 * decoded; SQLite returns the JSON string its `text` column carries, so both
 * shapes are accepted. A value that is not `{ warnings: [...] }` is ignored —
 * a malformed row must not break the entire model list.
 */
function parseWarningMetadata(raw: unknown): { warnings: ModelWarning[] } | undefined {
  // NULL/undefined is the common case (most rows carry no warnings) — skip the
  // cache entirely rather than minting a "null"/"undefined" key for it.
  if (raw === null || raw === undefined) return undefined;
  // The cache key is the blob's own text: a string column value keys on
  // itself, and a decoded jsonb object keys on its canonical serialization —
  // two rows carrying the same warnings share one parse either way.
  const key = typeof raw === "string" ? raw : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  return cachedWarningMetadata(key, () => parseWarningMetadataUncached(raw));
}

function parseWarningMetadataUncached(raw: unknown): { warnings: ModelWarning[] } | undefined {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const warnings = (value as Record<string, unknown>)["warnings"];
  if (!Array.isArray(warnings)) return undefined;
  const projected = warnings.filter((warning): warning is ModelWarning => {
    if (warning === null || typeof warning !== "object" || Array.isArray(warning)) return false;
    const item = warning as Record<string, unknown>;
    return typeof item["kind"] === "string" && typeof item["message"] === "string";
  });
  return projected.length > 0 ? { warnings: projected } : undefined;
}

/**
 * Projects one persisted `models` row into the console's catalog entry.
 *
 * `disabled` is resolved by the caller (from `tenant_disabled_models`), because
 * the bulk read has to look it up across every provider at once while the
 * single-provider read looks it up for one; the projection itself is identical
 * either way, so it lives here rather than being written twice.
 *
 * Exported so a test can pin the unsized-model substitution without a database:
 * which rows get the fallback, and that they are the same rows marked estimated.
 */
export function mapModelRow(
  row: typeof models.$inferSelect,
  disabled: boolean,
): ModelCatalogEntry {
  const modalities =
    row.modalities && typeof row.modalities === "object"
      ? (row.modalities as { input?: unknown; output?: unknown })
      : undefined;
  const inputModalities = Array.isArray(modalities?.input) ? modalities.input : [];
  const outputModalities = Array.isArray(modalities?.output) ? modalities.output : [];
  // Nothing filed this model — not its own row, not the base catalog under this
  // provider's id, not a majority across the catalog's other resellers. The
  // fallback is substituted here rather than persisted: the stored `null` is the
  // honest record of what upstream said, and substituting at the write would
  // make a guess indistinguishable from a measurement on the next read. The
  // marker rides along so the card can say which one it is showing.
  const unfiled =
    row.contextLimit === null &&
    modelsDevCatalog.resolve(row.providerId, row.modelId) === undefined &&
    modelsDevCatalog.majorityFor(row.modelId) === undefined;
  return {
    modelId: row.modelId,
    route: row.endpointPath,
    provider: row.providerId,
    wireFamily: row.wireFamily,
    serviceKind: row.serviceKind,
    enabled: disabled ? false : row.enabled,
    // A fetched model that published no context size read `n/a ctx · n/a out`
    // while still being routable — a working model that looked unusable. These
    // rows get the same ceilings a manual add is offered, flagged as estimated.
    contextLimit: unfiled ? FALLBACK_CONTEXT_LIMIT : row.contextLimit,
    outputLimit: unfiled ? FALLBACK_OUTPUT_LIMIT : row.outputLimit,
    reasoning: row.reasoning,
    toolCall: row.toolCall,
    vision: inputModalities.includes("image"),
    document: inputModalities.includes("document"),
    audio: inputModalities.includes("audio"),
    mediaGeneration: outputModalities.includes("image"),
    cost: row.cost as ModelCatalogEntry["cost"],
    source: row.source,
    ...(unfiled ? { limitsEstimated: true } : {}),
    // Three-valued on the wire as it is in the column: only a row that claims
    // `true` is pro-only. Absence means nobody established the tier, and the
    // surface must render that as unknown rather than as free.
    ...(row.proOnly === true ? { proOnly: true } : {}),
    // Same three-valued rule, from the provider's own directory. Qoder states
    // `is_free` per row, so a plan change moves the pill without a code change.
    ...(row.freeTier === true ? { freeTier: true } : {}),
    // Display-only: a `NULL` column (or a malformed legacy value) projects no
    // warnings at all rather than leaking the raw JSON shape to the dashboard.
    ...(parseWarningMetadata(row.warningMetadata) ?? {}),
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
  } satisfies ModelCatalogEntry;
}

/**
 * Projects one usage aggregate row (today's telemetry group or a lifetime
 * `telemetry_usage_totals` row) into the console's token-usage shape. Missing
 * or NULL aggregates read as zero; `totalTokens` is always input + output.
 * Shared by the account and pool usage paths, which previously carried two
 * copies of this projection.
 */
export function usageTotalsFromRow(row: {
  readonly requests: number | string | null;
  readonly errors: number | string | null;
  readonly inputTokens: number | string | null;
  readonly outputTokens: number | string | null;
} | undefined): ProviderAccountTokenUsage {
  const inputTokens = Number(row?.inputTokens ?? 0);
  const outputTokens = Number(row?.outputTokens ?? 0);
  return {
    requests: Number(row?.requests ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** The zeroed usage shape every account/pool row falls back to. */
export const emptyUsage: ProviderAccountTokenUsage = {
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

/**
 * The owning pool's provider cooldown markers, filtered to the ones still in
 * force and shaped like `NetworkPoolResponse.providerCooldowns`. Expired
 * markers are skipped — a spent window is not a reason to flag the row.
 */
export function activePoolProviderCooldowns(
  markers: Record<string, { until: number; reason: string; blocked?: boolean }>,
): { providerId: string; until: string; reason: string; blocked: boolean }[] {
  const now = Date.now();
  const active: { providerId: string; until: string; reason: string; blocked: boolean }[] = [];
  for (const [providerId, marker] of Object.entries(markers)) {
    if (marker.until <= now) continue;
    active.push({
      providerId,
      until: new Date(marker.until).toISOString(),
      reason: marker.reason,
      blocked: marker.blocked === true,
    });
  }
  return active;
}

/**
 * Projects one `provider_accounts` row plus its today/lifetime usage into the
 * console's account shape. Pure: the caller has already resolved usage
 * aggregates and the inflight reading; this only maps stored columns.
 */
export function mapAccountRow(
  row: typeof schema.providerAccounts.$inferSelect,
  usage: {
    readonly today: ProviderAccountTokenUsage;
    readonly allTime: ProviderAccountTokenUsage;
    readonly inflight?: number | undefined;
  },
): ProviderAccountResponse {
  const authState =
    row.authState !== null && typeof row.authState === "object" && !Array.isArray(row.authState)
      ? (row.authState as Record<string, unknown>)
      : undefined;
  const rawCredentialMode = authState?.["credentialMode"];
  const credentialMode: CredentialMode | undefined =
    rawCredentialMode === "auto" || rawCredentialMode === "jwt" || rawCredentialMode === "api_key"
      ? rawCredentialMode
      : undefined;
  const tokenExpiresAt =
    typeof authState?.["tokenExpiresAt"] === "string" ? authState["tokenExpiresAt"] : undefined;
  const jwtIssuer =
    typeof authState?.["jwtIssuer"] === "string" ? authState["jwtIssuer"] : undefined;
  const authMethod =
    typeof authState?.["authMethod"] === "string" ? authState["authMethod"] : undefined;
  const accountEmail = asStoredText(row.accountEmail) ?? undefined;
  const accountName =
    typeof authState?.["accountName"] === "string" && authState["accountName"].trim().length > 0
      ? authState["accountName"].trim()
      : undefined;
  return {
    id: row.id,
    providerId: row.providerId,
    tenantId: row.tenantId,
    label: row.label,
    ...pickDefined({ accountEmail }),
    ...pickDefined({ accountName }),
    credentialKind: row.credentialKind,
    ...pickDefined({ credentialMode }),
    ...pickDefined({ tokenExpiresAt }),
    ...pickDefined({ jwtIssuer }),
    ...pickDefined({ authMethod }),
    status: row.status,
    ...pickDefined({ inflight: usage.inflight }),
    usageToday: usage.today,
    usageAllTime: usage.allTime,
    consecutiveFailures: row.consecutiveFailures,
    ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.lastErrorCategory ? { lastErrorCategory: row.lastErrorCategory } : {}),
    ...(row.lastErrorAt ? { lastErrorAt: row.lastErrorAt.toISOString() } : {}),
    ...(row.cooldownUntil ? { cooldownUntil: row.cooldownUntil.toISOString() } : {}),
    ...(liveModelCooldowns(row.modelCooldowns) ?? {}),
    ...(row.lastRecoveredAt ? { lastRecoveredAt: row.lastRecoveredAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    sortIndex: row.sortIndex,
    ...(row.staticToken ? { staticToken: true } : {}),
  };
}
