// API-key authentication and authorization snapshots: token extraction, hashing, lookup, and admission identity.

import type { CartethyiaDatabase } from "../persistence/db-handle";
import { deleteShared, publishInvalidation, readShared, writeShared } from "../persistence/shared-cache";
import { DrizzleApiKeyStore } from "../persistence/stores/api-key-store";
import { GatewayError } from "../protocol/gateway-error";
import { hashSecret } from "./crypto";
import { AUTH_CACHE_TTL_MS, createApiKeyAuthorizationCache } from "./api-key-auth-cache";
import type { AccessScope, CallerIdentity } from "./access-control";
import type { ApiKeyModelAccessMode } from "../persistence/schema";

// ── Authorization cache ──────────────────────────────────────────────────────
/**
 * TTL-based in-memory cache for `resolveApiKeyAuthorization`, keyed by the
 * token hash. The Postgres round-trips this avoids (1–3 SELECTs per request)
 * are the single largest latency contributor on the `/v1/*` hot path.
 *
 * Trade-off: `lifetime_tokens_consumed` in the cached snapshot may be up to
 * `AUTH_CACHE_TTL_MS` stale. The admission service's real-time in-flight and
 * estimated-token accounting is the actual enforcement mechanism; the
 * snapshot's consumed value is a reference point, so a brief stale window
 * cannot meaningfully over-consume a budget.
 *
 * Negative results (unknown/revoked tokens) are deliberately NOT cached, so
 * a newly minted key is usable immediately.
 */
const authorizationCache = createApiKeyAuthorizationCache<ResolvedApiKey>();

/** Thrown when the credential store could not be reached at all. */
export class ApiKeyStoreUnavailableError extends Error {
  constructor() {
    super("The credential store is unavailable.");
    this.name = "ApiKeyStoreUnavailableError";
  }
}

/**
 * Source for lifetime-usage deltas recorded but not yet flushed.
 *
 * Injected rather than imported: this module is on the auth path and must not
 * depend on the persistence/write layer it would otherwise pull in. Set once at
 * boot (`boot/dependencies.ts`); until then it reads as zero, which is the
 * value the code uses when no source is installed.
 */
let pendingUsage: (apiKeyId: string) => number = () => 0;

/**
 * Supplies the in-flight usage source. See {@link pendingUsage}.
 *
 * The persisted `lifetime_tokens_consumed` is behind by up to one flush
 * interval, and the flush coalesces by design — so it is behind by the *most*
 * exactly when a key is busiest. Adding the pending delta costs nothing and
 * removes the gap.
 */
export function setPendingUsageSource(source: (apiKeyId: string) => number): void {
  pendingUsage = source;
}
/**
 * Invalidates every cached authorization entry for one API key (or the entire
 * cache when `keyId` is omitted). Called by the API-key domain after any
 * mutation that changes a key's scopes, limits, or revoked state.
 */
export function invalidateApiKeyCache(keyId?: string): void {
  // A mutation may mint a token the negative cache has already rejected, so
  // negative entries must go with the positive ones.
  authorizationCache.invalidate(keyId);
  if (keyId === undefined) {
    void deleteShared("auth");
    publishInvalidation({ namespace: "auth" });
    return;
  }
  // Peer processes hold their own copy, and `reusePort` means the console
  // write may have landed on a different one entirely. Dropping only locally
  // leaves a revoked key valid for up to a full TTL everywhere else.
  //
  // Delivered by broadcast rather than by deleting a shared entry: a mutation
  // names a key id, and the shared layer is keyed by token hash, which the
  // mutating request does not have. The notice is at-most-once, so the TTL
  // stays the backstop for a peer that misses it.
  publishInvalidation({ namespace: "auth", key: keyId });
}

/**
 * Resolves an inbound `/v1/*` bearer token to its persisted API key row and
 * builds the immutable `ApiKeyAuthorizationSnapshot` consumed by
 * `ApiKeyAdmissionService`. This is the only place a raw client bearer token
 * is hashed and looked up against Postgres.
 */
/** Immutable tenant-scoped authorization snapshot. */

export interface ApiKeyAuthorizationSnapshot {
  readonly api_key_id: string;
  readonly tenant_id: string;
  /** Admission identity used as key for rolling counters; defaults to api_key_id when absent. */
  readonly admission_identity?: string;
  /** Empty or absent means unrestricted; values are normalized to frozen arrays. */
  readonly model_access_mode?: ApiKeyModelAccessMode | null | undefined;
  /** The one list `model_access_mode` interprets; see the schema for semantics. */
  readonly model_list?: readonly string[] | ReadonlySet<string> | null | undefined;
  /** Client-router ids this key refuses; see `client-router-fingerprint.ts`. */
  readonly client_router_denylist?: readonly unknown[] | ReadonlySet<unknown> | null | undefined;
  readonly rpm?: number | null | undefined;
  readonly rpm_limit?: number | null | undefined;
  readonly daily_tokens?: number | null | undefined;
  readonly monthly_tokens?: number | null | undefined;
  readonly lifetime_token_budget?: number | null | undefined;
  readonly lifetime_tokens_consumed?: number | null | undefined;
  readonly max_concurrent?: number | null | undefined;
  readonly scopes?: readonly string[] | undefined;
}

function freezeList(
  list: readonly unknown[] | ReadonlySet<unknown> | null | undefined,
): readonly string[] | null | undefined {
  if (list == null) return list as null | undefined;
  const values = list instanceof Set ? [...list] : Array.isArray(list) ? list : [];
  const arr = Object.freeze(values.filter((value): value is string => typeof value === "string"));
  return arr;
}

export function freezeSnapshot(s: ApiKeyAuthorizationSnapshot): ApiKeyAuthorizationSnapshot {
  const model_list = freezeList(s.model_list);
  const model_access_mode: ApiKeyModelAccessMode =
    s.model_access_mode === "blacklist" ? "blacklist" : "whitelist";
  const client_router_denylist = freezeList(s.client_router_denylist);

  const api_key_id = s.api_key_id ?? "";
  const tenant_id = s.tenant_id ?? "";
  const admission_identity = s.admission_identity ?? api_key_id;

  const frozen: ApiKeyAuthorizationSnapshot = {
    api_key_id,
    tenant_id,
    admission_identity,
    model_access_mode,
    model_list,
    client_router_denylist,
    rpm: s.rpm ?? s.rpm_limit ?? null,
    daily_tokens: s.daily_tokens ?? null,
    monthly_tokens: s.monthly_tokens ?? null,
    lifetime_token_budget: s.lifetime_token_budget ?? null,
    lifetime_tokens_consumed: s.lifetime_tokens_consumed ?? null,
    max_concurrent: s.max_concurrent ?? null,
    scopes: s.scopes ? Object.freeze([...s.scopes]) : undefined,
  };
  return Object.freeze(frozen) as ApiKeyAuthorizationSnapshot;
}

export function createAuthorizationSnapshot(input: {
  readonly api_key_id: string;
  readonly tenant_id: string;
  readonly admission_identity?: string;
  readonly model_access_mode?: ApiKeyModelAccessMode | null;
  readonly model_list?: readonly string[] | ReadonlySet<string> | null;
  readonly client_router_denylist?: readonly unknown[] | ReadonlySet<unknown> | null;
  readonly rpm?: number | null;
  readonly daily_tokens?: number | null;
  readonly monthly_tokens?: number | null;
  readonly lifetime_token_budget?: number | null;
  readonly lifetime_tokens_consumed?: number | null;
  readonly max_concurrent?: number | null;
  readonly rpm_limit?: number | null;
  readonly scopes?: readonly string[];
}): ApiKeyAuthorizationSnapshot {
  return freezeSnapshot({
    api_key_id: input.api_key_id,
    tenant_id: input.tenant_id,
    ...(input.admission_identity !== undefined
      ? { admission_identity: input.admission_identity }
      : {}),
    ...(input.model_access_mode !== undefined && input.model_access_mode !== null
      ? { model_access_mode: input.model_access_mode }
      : {}),
    ...(input.model_list !== undefined && input.model_list !== null
      ? { model_list: input.model_list as readonly string[] }
      : {}),
    ...(input.client_router_denylist !== undefined && input.client_router_denylist !== null
      ? { client_router_denylist: input.client_router_denylist }
      : {}),
    ...(input.rpm !== undefined && input.rpm !== null ? { rpm: input.rpm } : {}),
    ...(input.daily_tokens !== undefined && input.daily_tokens !== null
      ? { daily_tokens: input.daily_tokens }
      : {}),
    ...(input.monthly_tokens !== undefined && input.monthly_tokens !== null
      ? { monthly_tokens: input.monthly_tokens }
      : {}),
    ...(input.lifetime_token_budget !== undefined && input.lifetime_token_budget !== null
      ? { lifetime_token_budget: input.lifetime_token_budget }
      : {}),
    ...(input.lifetime_tokens_consumed !== undefined && input.lifetime_tokens_consumed !== null
      ? { lifetime_tokens_consumed: input.lifetime_tokens_consumed }
      : {}),
    ...(input.max_concurrent !== undefined && input.max_concurrent !== null
      ? { max_concurrent: input.max_concurrent }
      : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
  });
}

/**
 * The model-access rule lives in `model-access-rule.ts`, a pure module the
 * dashboard can import too (this file pulls in Drizzle/Node). Re-exported here
 * so existing callers keep importing from `api-key-auth`.
 */
export {
  isModelAllowed,
  listIncludes,
  modelRejectionReason,
  type ModelRejectionReason,
} from "./model-access-rule";


export function getAdmissionIdentity(snapshot: ApiKeyAuthorizationSnapshot): string {
  return snapshot.admission_identity ?? snapshot.api_key_id;
}

export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly AccessScope[];
  readonly snapshot: ApiKeyAuthorizationSnapshot;
  readonly modelPrefix?: string;
  /** Share-template id whose remote CLI mappings are inherited by this child. */
  readonly cliMappingOwnerId?: string;
  /**
   * Single "who is speaking" identity derived at auth. Carried through
   * planning, admission, pool selection, and telemetry so every gate reasons
   * about the same caller.
   */
  readonly caller: CallerIdentity;
}

/**
 * The 401 a caller gets when a key resolves to nothing.
 *
 * One function, not a message repeated at each boundary: three surfaces refuse
 * an unknown key, and any wording drift between them is a caller guessing which
 * surface it hit. Unknown, revoked and expired stay deliberately
 * indistinguishable — distinguishing them would let a caller confirm that a
 * guessed token once existed — so there is no variant carrying a reason.
 */
const INVALID_KEY_MESSAGE = "Invalid API key (request {requestId}). Check the key you are sending, or create a new one in API Keys and send it as: Authorization: Bearer <key>. Wrong key, right door — double-check and come back 🔑";

export function unknownApiKeyError(): GatewayError {
  return new GatewayError("authentication_failed", 401, INVALID_KEY_MESSAGE);
}

/**
 * The 401 for the public model surface specifically.
 *
 * Model Studio is where the seeded default key is normally used, and that key
 * cannot be deleted — it only rotates. Naming rotation there is actionable. The
 * same sentence on a proxy request was misleading instead: a revoked or mistyped
 * personal key was answered with an instruction that could not apply to it,
 * sending the operator to rotate a key they were never using.
 */
export function modelsListApiKeyError(): GatewayError {
  return new GatewayError(
    "authentication_failed",
    401,
    "Invalid API key (request {requestId}). Rotate the default Cartethyia API key in API Keys and send the new key as: Authorization: Bearer <key>. Wrong key, right door — rotate and try again 🔑",
  );
}

/** Extracts exactly one supported credential source, preserving public auth statuses. */
export function requestToken(headers: Headers | Record<string, string>): string {
  const get = (name: string): string | null =>
    headers instanceof Headers ? headers.get(name) : (headers[name] ?? null);
  const authorization = get("authorization")?.trim() ?? "";
  const apiKey = get("x-api-key")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authorization);
  const hasAuthorization = authorization.length > 0;
  const hasApiKey = apiKey.length > 0;
  if (hasAuthorization && hasApiKey) {
    // Both headers carrying the *same* credential is a compatibility idiom, not
    // an error: an Anthropic-compatible client sends `x-api-key` and
    // `Authorization: Bearer <same key>` together so a gateway reading either
    // one works, and rejecting the pair rejects the whole client. Two
    // *different* credentials stay a conflict — accepting whichever came first
    // would silently decide the request's identity.
    if (bearerMatch?.[1] === apiKey) return apiKey;
    throw new GatewayError("invalid_request", 400, "The request sends two different credentials (request {requestId}). Send exactly one key, either as Authorization: Bearer <key> or as the api-key header. Pick one key and stick with it 🤝");
  }
  if (hasApiKey) return apiKey;
  const token = bearerMatch?.[1];
  if (token === undefined)
    throw new GatewayError("authentication_failed", 401, "The request carries no usable credential (request {requestId}). Send the key as: Authorization: Bearer <key>. We need a key to let you in 🔑");
  return token;
}

/**
 * Whether a key can possibly have children, and so whether summing them can
 * return anything but zero.
 *
 * Children exist only for a `share` parent — the schema's own check constraint
 * ties the mode to the parent-child shape (schema.ts:799-803), and no other
 * mode mints recipients. Extracted and exported because the alternative is an
 * untestable inline comparison guarding a database round-trip.
 */
export function canHaveChildKeys(key: { readonly keyMode?: string | null }): boolean {
  return key.keyMode === "share";
}

/**
 * Looks up the API key by its hashed bearer token. Returns `undefined` for
 * an unknown or revoked key — callers must reject with 401, never fall back
 * to an implicit/default identity.
 */
export async function resolveApiKeyAuthorization(
  db: CartethyiaDatabase,
  token: string,
): Promise<ResolvedApiKey | undefined> {
  const now = Date.now();
  const hash = hashSecret(token);
  const cached = authorizationCache.lookup(hash, now);
  if (cached.kind === "negative") return undefined;
  if (cached.kind === "positive") return cached.value;
  // L2: a peer process may have resolved this token already. Reachable only
  // after the L1 entry lapsed, so Redis is never consulted on a warm hit.
  //
  // Keyed by token hash, because that is what a lookup has — invalidation
  // arrives as a key id and is delivered as a broadcast instead.
  const shared = await readShared("auth", hash);
  if (shared !== undefined) {
    try {
      const parsed = JSON.parse(shared) as ResolvedApiKey;
      if (typeof parsed?.id === "string") {
        authorizationCache.rememberPositive(hash, parsed.id, parsed, now);
        return parsed;
      }
    } catch {
      // A malformed or schema-drifted entry is ignored and re-resolved.
    }
  }
  // Answered from the cooldown before any I/O: during a store outage the
  // query is the expensive part, and it is also the part that fails.
  if (authorizationCache.isStoreUnavailable(now)) throw new ApiKeyStoreUnavailableError();
  const store = new DrizzleApiKeyStore(db);
  let row: Awaited<ReturnType<typeof store.findActiveByHash>>;
  try {
    row = await store.findActiveByHash(hash);
  } catch (error) {
    // Any failure here is the store's, not the key's — a revoked key is a
    // normal empty result, so this only runs on a real fault.
    authorizationCache.markStoreUnavailable(Date.now());
    throw error;
  }
  if (!row) {
    authorizationCache.rememberNegative(hash, now);
    return undefined;
  }
  // A child (shared) key consumes against its parent's quota, not just its
  // own: the parent's budget is the operator's global cap across all
  // recipients. Without this the parent's lifetime budget never moves no
  // matter how much its children spend, so the limit silently never fires.
  // One extra SELECT on the auth path, only for keys that have a parent.
  const parent =
    row.parentKeyId !== null ? await store.findActiveById(row.parentKeyId) : undefined;
  // Share children authenticate as themselves but inherit the template's live
  if (row.parentKeyId !== null && parent === undefined) return undefined;
  // policy. Copy-on-issue alone goes stale the moment an operator tightens a
  // limit or blocks a client router on the parent — existing recipients would
  // keep the issued row values forever. Reading the parent here makes denylist /
  // one-time / recurring edits apply on the next cache miss.
  const policy = parent ?? row;
  // Only a `share` parent can have children, and children are the only thing
  // the SUM below can find. Every other key ran an aggregate that was certain
  // to return 0 — one extra Postgres round-trip on the auth path for nothing.
  //
  // `row.parentKeyId !== null` is the same test, kept as the mode check because
  // the mode is what the share dialog and the schema's own check constraint
  // key off (schema.ts:799-803), so the two cannot drift apart.
  const canHaveChildren = canHaveChildKeys(parent ?? row);
  const consumed =
    ((policy.id === row.id ? row.lifetimeTokensConsumed : policy.lifetimeTokensConsumed) ?? 0) +
    (canHaveChildren ? await store.sumChildrenConsumed(policy.id) : 0) +
    // In-flight deltas: what has been spent but not yet persisted.
    pendingUsage(policy.id);
  const scopes = Array.isArray(policy.scopes) ? (policy.scopes as AccessScope[]) : [];
  const snapshot = createAuthorizationSnapshot({
    api_key_id: row.id,
    tenant_id: row.tenantId,
    // Family quota / concurrency share one admission counter namespace so two
    // recipients cannot each burn a full lifetime/daily budget.
    ...(parent ? { admission_identity: parent.id } : {}),
    ...(policy.modelList ? { model_list: policy.modelList as string[] } : {}),
    model_access_mode: policy.modelAccessMode ?? "whitelist",
    ...(policy.clientRouterDenylist
      ? { client_router_denylist: policy.clientRouterDenylist as string[] }
      : {}),
    ...(policy.requestsPerMinute != null ? { rpm: policy.requestsPerMinute } : {}),
    ...(policy.dailyTokenLimit != null ? { daily_tokens: policy.dailyTokenLimit } : {}),
    ...(policy.monthlyTokenLimit != null ? { monthly_tokens: policy.monthlyTokenLimit } : {}),
    ...(policy.lifetimeTokenBudget != null ? { lifetime_token_budget: policy.lifetimeTokenBudget } : {}),
    lifetime_tokens_consumed: consumed,
    ...(policy.maxConcurrentRequests != null ? { max_concurrent: policy.maxConcurrentRequests } : {}),
    scopes,
  });

  const value: ResolvedApiKey = {
    id: row.id,
    tenantId: row.tenantId,
    scopes,
    snapshot,
    ...(policy.modelPrefix ? { modelPrefix: policy.modelPrefix } : {}),
    ...(parent?.keyMode === "share" ? { cliMappingOwnerId: parent.id } : {}),
    caller: {
      apiKeyId: row.id,
      // The admission identity is the family owner for a share child — the
      // same id every counter/lease in the system keys against.
      admissionIdentity: snapshot.admission_identity ?? row.id,
      tenantId: row.tenantId,
    },
  };
  authorizationCache.rememberPositive(hash, value.id, value, Date.now());
  // Shared copy for peer processes, keyed by the token hash so a lookup can
  // find it without resolving the key first. Invalidation travels by broadcast,
  // since a console mutation names a key id and cannot enumerate the hashes
  // that resolved to it in another process.
  //
  // The cached value deliberately carries `lifetime_tokens_consumed` as read.
  // That figure moves constantly, and the module already documents the snapshot
  // as advisory on that axis (spending is enforced by the admission counter),
  // so a peer serving it stale for up to the TTL is the same tradeoff the
  // in-process cache makes.
  void writeShared("auth", hash, JSON.stringify(value), AUTH_CACHE_TTL_MS);
  return value;
}
