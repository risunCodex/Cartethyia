// Console API-key domain: HTTP routes.
//
// Owns validation, CRUD operations, and route wiring through the ApiKeyStore.

import { Elysia, t, type AnyElysia } from "elysia";
import { randomBytes, randomUUID } from "node:crypto";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import { invalidateApiKeyCache } from "../../security/api-key-auth";
import { invalidatePublicModels } from "../providers/catalog/public-model-store";
import { generateShareSlug, hashShareToken } from "../../persistence/stores/share-store";
import type { AccessDecision } from "../../security/access-control";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../shared/errors";
import { literalUnion } from "../shared/elysia-schema";
import { API_KEY_MODES, API_KEY_MODEL_ACCESS_MODES, API_KEY_CONCURRENCY_SCOPES, type ShareLinkKind } from "../../persistence/schema";
import type { ApiKeyConfig, ApiKeyResponse, BanApiKeyRequest, UpdateApiKeyResponse } from "./contracts";
import type {
  ApiKeyPatch,
  ApiKeyRecord,
  SharedChildSortColumn,
  SharedChildrenPageOptions,
} from "../../persistence/stores/api-key-store";
import {
  API_KEY_BAN_REASONS,
  BAN_DURATION_CHOICES,
  DEFAULT_BAN_MINUTES,
  generateApiKeySecret,
  isDefaultGatewayApiKey,
  parseSharePopupImage,
  sanitizeApiKeyResponse,
  validateApiKeyRequest,
  parseRequest,
  finitePositive,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  resolveKeyPrefix,
  prepareCustomKey,
  mapShareLinkResponse,
  type ShareKeyResponse,
  type ShareLinkResponse,
  resolveShareKeyPrefix,
} from "./contracts";
import type { SharedKeyActivityDetail, SharedKeySummary } from "../share/share-usage";
import { popupImageBytes } from "./share-popup-image";

const SHARED_CHILD_SORT_COLUMNS = new Set<SharedChildSortColumn>([
  "createdAt",
  "label",
  "keyPrefix",
  "issuedClientIp",
  "revokedAt",
  "enabled",
]);

/** The offered ban durations as a set of minute values, hoisted once. */
const BAN_DURATION_MINUTES = new Set(BAN_DURATION_CHOICES.map((choice) => choice.minutes));

/** Parses and bounds the paginated share-child list query. */
function parseSharedChildrenQuery(query: URLSearchParams): SharedChildrenPageOptions {
  const limitRaw = query.get("limit");
  const offsetRaw = query.get("offset");
  const sortRaw = query.get("sort");
  const orderRaw = query.get("order");
  const statusRaw = query.get("status");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ConsoleDomainError("invalid_request", 400, "limit must be an integer between 1 and 500");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ConsoleDomainError("invalid_request", 400, "offset must be a non-negative integer");
  }
  const sortBy = (sortRaw ?? "createdAt") as SharedChildSortColumn;
  if (!SHARED_CHILD_SORT_COLUMNS.has(sortBy)) {
    throw new ConsoleDomainError("invalid_request", 400, `unsupported sort column: ${String(sortBy)}`);
  }
  const order = orderRaw === "asc" ? "asc" : "desc";
  const status = statusRaw === "active" || statusRaw === "revoked" ? statusRaw : "all";
  return { limit, offset, sortBy, order, status };
}

/**
 * Drops the auth-cache snapshot for a key family: the parent first, then
 * every child.
 *
 * Parent policy is live-inherited by children at auth time, so their cached
 * snapshots must die with the parent — otherwise a denylist / budget edit
 * looks like a no-op for up to AUTH_CACHE_TTL_MS per child.
 */
function invalidateFamilyCaches(keyId: string, children: readonly ApiKeyRecord[]): void {
  invalidateApiKeyCache(keyId);
  for (const child of children) invalidateApiKeyCache(child.id);
}

/**
 * Purges admission counters for a key family: the parent first, then every
 * child.
 *
 * Share children admit under the parent id, so the parent's counter must die
 * with a revoked/regenerated parent too — otherwise a family budget can be
 * bypassed by a counter seeded under the old credential.
 */
async function purgeFamilyAdmission(
  admissionService: { purgeKey(apiKeyId: string): Promise<void> },
  keyId: string,
  children: readonly ApiKeyRecord[],
): Promise<void> {
  await Promise.all([
    admissionService.purgeKey(keyId),
    ...children.map((child) => admissionService.purgeKey(child.id)),
  ]);
}

export function createApiKeyOperations(config: ApiKeyConfig) {
  const operations = {
    async listKeys(access: AccessDecision | undefined, includeChildren = false): Promise<ApiKeyResponse[]> {
        const authorized = requireTenantScope(access, "dashboard:read");
        const records = await config.store.list(authorized.tenantId);
        const topLevel = records.filter(
          (record) => record.revokedAt === undefined && record.parentKeyId === undefined,
        );
        // Share children are omitted from the main key list (they belong to a
        // template), but the Banned Users search wants them so a child can be
        // found and banned by hand.
        const visible = includeChildren
          ? records.filter((record) => record.revokedAt === undefined)
          : topLevel;
        return visible.map(sanitizeApiKeyResponse);
    },
    async listActiveBannedKeys(access: AccessDecision | undefined): Promise<ApiKeyResponse[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const records = await config.store.listActiveBanned(authorized.tenantId);
      return records.map(sanitizeApiKeyResponse);
    },
    /** Persists a new credential order. `keyIds` must name every top-level key
        the tenant has, so a partial list cannot silently renumber rows. */
    async reorderKeys(access: AccessDecision | undefined, keyIds: readonly string[]): Promise<void> {
        const authorized = requireTenantScope(access, "dashboard:write");
        const records = await config.store.list(authorized.tenantId);
        const reorderable = records.filter(
          (record) => record.revokedAt === undefined && record.parentKeyId === undefined,
        );
        const known = new Set(reorderable.map((record) => record.id));
        const seen = new Set<string>();
        for (const keyId of keyIds) {
          if (!known.has(keyId))
            throw new ConsoleDomainError("key_not_found", 404, `Key not found: ${keyId}`);
          if (seen.has(keyId))
            throw new ConsoleDomainError("invalid_request", 422, `Duplicate key id: ${keyId}`);
          seen.add(keyId);
        }
        if (seen.size !== known.size)
          throw new ConsoleDomainError(
            "invalid_request",
            422,
            "Reorder must list every key exactly once",
          );
        await config.store.reorder(authorized.tenantId, keyIds);
      },
    async getKeyDetail(access: AccessDecision | undefined, keyId: string): Promise<ApiKeyResponse> {
        const authorized = requireTenantScope(access, "dashboard:read");
        const record = await config.store.get(authorized.tenantId, keyId);
        if (!record) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
        return sanitizeApiKeyResponse(record);
      },
    async getSharePopupImage(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<{ mime: string; image: Buffer }> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.sharePopupImage === undefined || record.sharePopupImageMime === undefined)
        throw new ConsoleDomainError("key_not_found", 404, "This key has no popup image");
      return { mime: record.sharePopupImageMime, image: record.sharePopupImage };
    },
    async createKey(
      access: AccessDecision | undefined,
      request: CreateApiKeyRequest,
    ): Promise<CreateApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const scopes = validateApiKeyRequest(request);
      const popupImage = parseSharePopupImage(request.sharePopupImage);
      const keyMode = request.keyMode ?? "personal";
      const keyPrefix =
        keyMode === "share"
          ? resolveShareKeyPrefix(request.keyPrefix)
          : resolveKeyPrefix(request.keyPrefix);
      const generated =
        keyMode === "personal"
          ? request.key === undefined
            ? generateApiKeySecret(keyPrefix)
            : { ...prepareCustomKey(request.key), prefix: keyPrefix }
          : undefined;
      const record: ApiKeyRecord = {
        id: randomUUID(),
        tenantId: authorized.tenantId,
        enabled: request.enabled ?? true,
        label: request.label?.trim() || (keyMode === "share" ? "Share template" : "API key"),
        keyHash: generated?.hash ?? null,
        keyMode,
        scopes,
        // Only first boot seeds the default; a key created from the console is
        // never it, so it stays renamable and revocable.
        isDefault: false,
        keyPrefix: generated?.prefix ?? keyPrefix,
        ...(generated ? { keyEncrypted: encryptCredential(generated.secret) } : {}),
        ...(request.notesTitle === undefined ? {} : { notesTitle: request.notesTitle }),
        ...(request.notesSubtitle === undefined ? {} : { notesSubtitle: request.notesSubtitle }),
        ...(request.notesBody === undefined ? {} : { notesBody: request.notesBody }),
        ...(request.sharePopupEnabled == null ? {} : { sharePopupEnabled: request.sharePopupEnabled }),
        ...(popupImage
          ? { sharePopupImage: popupImage.image, sharePopupImageMime: popupImage.mime }
          : {}),
        ...(request.sharePopupTitle?.trim() ? { sharePopupTitle: request.sharePopupTitle.trim() } : {}),
        ...(request.sharePopupBody?.trim() ? { sharePopupBody: request.sharePopupBody.trim() } : {}),
        ...(request.requestsPerMinute == null ? {} : { requestsPerMinute: request.requestsPerMinute }),
        ...(request.dailyTokenLimit == null ? {} : { dailyTokenLimit: request.dailyTokenLimit }),
        ...(request.monthlyTokenLimit == null ? {} : { monthlyTokenLimit: request.monthlyTokenLimit }),
        ...(request.lifetimeTokenBudget == null ? {} : { lifetimeTokenBudget: request.lifetimeTokenBudget }),
        ...(request.maxConcurrentRequests == null ? {} : { maxConcurrentRequests: request.maxConcurrentRequests }),
        ...(request.concurrencyScope !== undefined ? { concurrencyScope: request.concurrencyScope } : {}),
        ...(request.maxChildren == null ? {} : { maxChildren: request.maxChildren }),
        ...(request.modelPrefix === undefined ? {} : { modelPrefix: request.modelPrefix }),
        modelAccessMode: request.modelAccessMode ?? "whitelist",
        ...(request.modelList === undefined ? {} : { modelList: request.modelList }),
        ...(request.clientRouterDenylist === undefined
          ? {}
          : { clientRouterDenylist: request.clientRouterDenylist }),
        createdAt: new Date(),
        tokensConsumed: 0,
      };
      await config.store.create(record);
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.created",
        target: record.id,
        detail: { scopes, keyMode },
      });
      return {
        ...sanitizeApiKeyResponse(record),
        ...(generated ? { secret: generated.secret } : {}),
      };
    },
    async updateKey(
      access: AccessDecision | undefined,
      keyId: string,
      request: Partial<CreateApiKeyRequest>,
    ): Promise<UpdateApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const patchRequest = parseRequest(request);
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "shared_key_managed_by_parent",
          409,
          "Edit or revoke this key through its share parent",
        );

      validateApiKeyRequest(patchRequest);
      finitePositive(patchRequest.requestsPerMinute, "requestsPerMinute");
      finitePositive(patchRequest.dailyTokenLimit, "dailyTokenLimit");
      finitePositive(patchRequest.monthlyTokenLimit, "monthlyTokenLimit");
      finitePositive(patchRequest.lifetimeTokenBudget, "lifetimeTokenBudget");
      finitePositive(patchRequest.maxConcurrentRequests, "maxConcurrentRequests");

      const nextMode = patchRequest.keyMode ?? current.keyMode;
      const modeChanged = nextMode !== current.keyMode;
      const nextPrefix =
        nextMode === "share"
          ? resolveShareKeyPrefix(
              patchRequest.keyPrefix ?? (modeChanged ? undefined : current.keyPrefix),
            )
          : resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix);
      const prefixChanged =
        patchRequest.keyPrefix !== undefined &&
        nextPrefix !== resolveKeyPrefix(current.keyPrefix);

      let secret: string | undefined;
      let credentialPatch: ApiKeyPatch = {};
      if (modeChanged && nextMode === "share") {
        credentialPatch = {
          keyMode: "share",
          keyHash: null,
          keyEncrypted: null,
          keyPrefix: nextPrefix,
        };
      } else if (
        nextMode === "personal" &&
        (modeChanged || patchRequest.key !== undefined || prefixChanged)
      ) {
        const generated = patchRequest.key === undefined
          ? generateApiKeySecret(
              patchRequest.keyPrefix === undefined
                ? undefined
                : resolveKeyPrefix(patchRequest.keyPrefix),
            )
          : {
              ...prepareCustomKey(patchRequest.key),
              prefix: resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix),
            };
        secret = generated.secret;
        credentialPatch = {
          ...(modeChanged ? { keyMode: "personal" as const } : {}),
          keyHash: generated.hash,
          keyEncrypted: encryptCredential(generated.secret),
          keyPrefix: generated.prefix,
        };
      } else if (nextMode === "share" && nextPrefix !== current.keyPrefix) {
        credentialPatch = { keyPrefix: nextPrefix };
      }

      const scopes =
        patchRequest.scopes === undefined ? undefined : validateApiKeyRequest(patchRequest);
      const popupImage =
        patchRequest.sharePopupImage === undefined
          ? undefined
          : parseSharePopupImage(patchRequest.sharePopupImage);
      const updated = await config.store.update(authorized.tenantId, keyId, {
        ...(patchRequest.enabled === undefined ? {} : { enabled: patchRequest.enabled }),
        ...(isDefaultGatewayApiKey(current) ? { isDefault: true } : {}),
        ...credentialPatch,
        ...(scopes === undefined ? {} : { scopes }),
        // Rename. The label must be copied into the patch explicitly — it is
        // accepted and validated by the body schema but is not the credential,
        // so omitting it here leaves the name unchanged. Blank falls back to the
        // existing label rather than wiping it, since `label` is NOT NULL. The
        // default key is renameable like any other (c2a93545); gating on
        // `isDefault` would drop exactly the one patch that changes a name and
        // leave the store with an empty `set(...)` that throws.
        ...(patchRequest.label === undefined
          ? {}
          : { label: patchRequest.label.trim() === "" ? current.label : patchRequest.label.trim() }),
        ...(patchRequest.notesTitle === undefined
          ? {}
          : { notesTitle: patchRequest.notesTitle.trim() === "" ? null : patchRequest.notesTitle }),
        ...(patchRequest.notesSubtitle === undefined
          ? {}
          : { notesSubtitle: patchRequest.notesSubtitle.trim() === "" ? null : patchRequest.notesSubtitle }),
        ...(patchRequest.notesBody === undefined
          ? {}
          : { notesBody: patchRequest.notesBody.trim() === "" ? null : patchRequest.notesBody }),
        ...(patchRequest.sharePopupEnabled === undefined ? {} : { sharePopupEnabled: patchRequest.sharePopupEnabled }),
        ...(popupImage === undefined
          ? {}
          : popupImage === null
            ? { sharePopupImage: null, sharePopupImageMime: null }
            : { sharePopupImage: popupImage.image, sharePopupImageMime: popupImage.mime }),
        ...(patchRequest.sharePopupTitle === undefined ? {} : { sharePopupTitle: patchRequest.sharePopupTitle.trim() || null }),
        ...(patchRequest.sharePopupBody === undefined ? {} : { sharePopupBody: patchRequest.sharePopupBody.trim() || null }),
        ...(patchRequest.requestsPerMinute === undefined ? {} : { requestsPerMinute: patchRequest.requestsPerMinute }),
        ...(patchRequest.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: patchRequest.dailyTokenLimit }),
        ...(patchRequest.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: patchRequest.monthlyTokenLimit }),
        ...(patchRequest.lifetimeTokenBudget === undefined ? {} : { lifetimeTokenBudget: patchRequest.lifetimeTokenBudget }),
        ...(patchRequest.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: patchRequest.maxConcurrentRequests }),
        ...(patchRequest.concurrencyScope !== undefined ? { concurrencyScope: patchRequest.concurrencyScope } : {}),
        ...(patchRequest.maxChildren === undefined ? {} : { maxChildren: patchRequest.maxChildren }),
        ...(patchRequest.modelPrefix === undefined ? {} : { modelPrefix: patchRequest.modelPrefix }),
        ...(patchRequest.modelAccessMode === undefined ? {} : { modelAccessMode: patchRequest.modelAccessMode }),
        ...(patchRequest.modelList === undefined ? {} : { modelList: patchRequest.modelList }),
        ...(patchRequest.clientRouterDenylist === undefined
          ? {}
          : { clientRouterDenylist: patchRequest.clientRouterDenylist }),
      });
      if (!updated) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      const children = await config.store.listChildren(authorized.tenantId, keyId);
      invalidateFamilyCaches(keyId, children);
      // The allow/deny list and prefix decide which models `/v1/models`
      // returns, which is a different cache from the auth snapshot: the
      // listing is cached per (tenant, key, mode, list, prefix), so editing
      // one must drop it or the endpoint keeps advertising the old set.
      if (
        patchRequest.modelAccessMode !== undefined ||
        patchRequest.modelList !== undefined ||
        patchRequest.modelPrefix !== undefined
      ) {
        invalidatePublicModels(authorized.tenantId);
      }

      // Denylist / allowlist / scopes are auth-snapshot fields: cache
      // invalidation above is enough. Only quota/concurrency edits need an
      // admission purge — otherwise changing a client denylist would also wipe
      // RPM / daily counters for every recipient mid-day.
      //
      // And only a *tightened* limit needs it. The dashboard edit form always
      // sends all five limit fields, so a `!== undefined` test treated every
      // save — renaming a key, editing notes — as a limit change and dropped
      // the whole family's daily/monthly counters, restarting the budget
      // mid-bucket. Loosening a limit cannot be bypassed by a stale counter
      // (the counter only ever grows toward the new ceiling), so it needs no
      // purge either; only a lowered or newly-added ceiling does.
      const tightened = (
        next: number | null | undefined,
        previous: number | null | undefined,
      ): boolean => {
        if (next === undefined || next === null) return false;
        if (previous === null || previous === undefined) return true;
        return next < previous;
      };
      /** A ceiling that did not exist before this request. */
      const isNewLimit = (
        next: number | null | undefined,
        previous: number | null | undefined,
      ): boolean => next !== undefined && next !== null && (previous === null || previous === undefined);
      const limitsChanged =
        modeChanged ||
        secret !== undefined ||
        tightened(patchRequest.requestsPerMinute, current.requestsPerMinute) ||
        tightened(patchRequest.dailyTokenLimit, current.dailyTokenLimit) ||
        tightened(patchRequest.monthlyTokenLimit, current.monthlyTokenLimit) ||
        tightened(patchRequest.lifetimeTokenBudget, current.lifetimeTokenBudget) ||
        tightened(patchRequest.maxConcurrentRequests, current.maxConcurrentRequests);
      if (limitsChanged) {
        // Drop stale admission counters so a newly lowered one-time/recurring
        // budget cannot be bypassed by a counter seeded under the looser limit.
        // Share children admit under the parent id, so purge the parent too.
        await purgeFamilyAdmission(config.admissionService, keyId, children);
      }
      // Adding a daily/monthly ceiling to a key that already spent in the
      // current bucket must not hand it a full fresh budget: seed the counter
      // from the spend already recorded, so the limit covers the whole bucket.
      // Only a *newly added* ceiling needs this — a lowered one was just
      // purged above, and re-seeding there would restore the baseline the purge
      // removed.
      const dailyAdded = isNewLimit(patchRequest.dailyTokenLimit, current.dailyTokenLimit);
      const monthlyAdded = isNewLimit(patchRequest.monthlyTokenLimit, current.monthlyTokenLimit);
      if ((dailyAdded || monthlyAdded) && config.bucketSpend && config.admissionService.seedBuckets) {
        const now = new Date();
        const spend = await config.bucketSpend(keyId, now).catch(() => null);
        if (spend) {
          await config.admissionService.seedBuckets({
            apiKeyId: keyId,
            now: now.getTime(),
            ...(dailyAdded ? { daily: spend.daily } : {}),
            ...(monthlyAdded ? { monthly: spend.monthly } : {}),
          });
        }
      }
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.updated",
        target: keyId,
        detail: { fields: Object.keys(request) },
      });
      return { ...sanitizeApiKeyResponse(updated), ...(secret === undefined ? {} : { secret }) };
    },
    async deleteKey(access: AccessDecision | undefined, keyId: string): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const target = await config.store.get(authorized.tenantId, keyId);
      if (!target)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // The gateway routes every request off this key and the CLI reads it for
      // the CLI, so removing it would strand the installation with no way to
      // authenticate. Rotation replaces the secret and keeps the key present.
      if (isDefaultGatewayApiKey(target))
        throw new ConsoleDomainError(
          "default_key_not_revocable",
          409,
          "The default gateway API key cannot be deleted. Rotate it instead.",
        );
      const children = await config.store.listChildren(authorized.tenantId, keyId);
      const removed = await config.store.remove(authorized.tenantId, keyId);
      if (!removed) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      invalidateFamilyCaches(keyId, children);
      await purgeFamilyAdmission(config.admissionService, keyId, children);
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.deleted",
        target: keyId,
      });
      return { success: true };
    },
    /**
     * Establishes or rotates the key's single stable link.
     *
     * The console shows one link that never moves; `regenerate` replaces the
     * token in place so the previous URL stops resolving. A share template
     * hands out child keys; a personal key hands out the key itself.
     */
    async shareKey(
      access: AccessDecision | undefined,
      keyId: string,
      options: { expiresAt?: string | null; origin?: string; regenerate?: boolean } = {},
    ): Promise<ShareKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "key_not_share_parent",
          409,
          "Only a top-level key can carry a handoff link",
        );
      const kind: ShareLinkKind = record.keyMode === "share" ? "enroll" : "handoff";
      const origin = (options.origin ?? "").replace(/\/$/, "");
      // Re-issuing without regeneration must return the link that is actually
      // stored. Minting a fresh token here would hand back a URL that was never
      // persisted, so the link would be dead on arrival.
      if (options.regenerate !== true) {
        const existing = await shareStore.findTokenForApiKey(keyId);
        if (existing !== null && existing.tokenEncrypted !== null) {
          try {
            const token = decryptCredentialToString(existing.tokenEncrypted);
            return {
              id: existing.id,
              url: `${origin}/share/${token}`,
              token,
              kind: existing.kind,
              expiresAt: existing.expiresAt === null ? null : existing.expiresAt.toISOString(),
            };
          } catch {
            // A row written under a different encryption key cannot be shown;
            // fall through and establish a fresh link.
          }
        }
      }
      let expiresAt: Date | null = null;
      if (options.expiresAt !== undefined && options.expiresAt !== null) {
        const parsed = new Date(options.expiresAt);
        if (Number.isNaN(parsed.getTime()))
          throw new ConsoleDomainError(
            "invalid_share_expiry",
            400,
            "expiresAt must be a valid ISO timestamp",
          );
        expiresAt = parsed;
      }
      const token = randomBytes(32).toString("base64url");
      const link = await shareStore.create({
        apiKeyId: keyId,
        tokenHash: hashShareToken(token),
        tokenEncrypted: encryptCredential(token),
        slug: generateShareSlug(),
        kind,
        expiresAt,
        rotate: options.regenerate === true,
      });
      await config.auditSink?.record({
        access: authorized,
        action: options.regenerate === true ? "api_key.share_regenerated" : "api_key.shared",
        target: keyId,
        detail: { shareId: link.id, kind },
      });
      return {
        id: link.id,
        url: `${origin}/share/${token}`,
        token,
        kind: link.kind,
        expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
      };
    },
    /**
     * The key's stable link with its retained token, for the console to show
     * without rotating it. Returns null when the key has no link yet or the
     * link predates token retention.
     */
    async getShare(
      access: AccessDecision | undefined,
      keyId: string,
      options: { origin?: string } = {},
    ): Promise<ShareKeyResponse | null> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "key_not_share_parent",
          409,
          "Only a top-level key can carry a handoff link",
        );
      const link = await shareStore.findTokenForApiKey(keyId);
      if (link === null) return null;
      let token: string | null = null;
      if (link.tokenEncrypted !== null) {
        try {
          token = decryptCredentialToString(link.tokenEncrypted);
        } catch {
          // A row written under a different encryption key cannot be shown.
          // The page itself survives: the slug is held in the clear, so the
          // address stays valid and the operator only loses the bearer half.
          token = null;
        }
      }
      // Nothing to point at: neither the address nor the secret survived.
      if (token === null && link.slug === null) return null;
      const origin = (options.origin ?? "").replace(/\/$/, "");
      return {
        id: link.id,
        // The slug is the address; the token is the bearer half. Preferring the
        // slug keeps a restored page reachable under the same URL even when the
        // encryption key that sealed its token is gone.
        url: `${origin}/share/${link.slug ?? token}`,
        token,
        kind: link.kind,
        expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
      };
    },
    /**
     * Rotates a personal key's credential in place and re-points its handoff
     * link at the new secret. Share templates have no credential of their own,
     * so they are rejected here.
     */
    async regenerateKey(
      access: AccessDecision | undefined,
      keyId: string,
      options: { origin?: string } = {},
    ): Promise<{ secret: string; share: ShareKeyResponse | null }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "shared_key_managed_by_parent",
          409,
          "Edit or revoke this key through its share parent",
        );
      if (current.keyMode !== "personal")
        throw new ConsoleDomainError(
          "key_not_personal",
          409,
          "Only a personal key can be regenerated; rotate a share template's link instead",
        );
      const generated = generateApiKeySecret();
      const updated = await config.store.update(authorized.tenantId, keyId, {
        keyHash: generated.hash,
        keyEncrypted: encryptCredential(generated.secret),
        keyPrefix: generated.prefix,
      });
      if (!updated) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // Regeneration is personal-key only, so the family is the key itself.
      invalidateFamilyCaches(keyId, []);
      await purgeFamilyAdmission(config.admissionService, keyId, []);
      const shareStore = config.shareStore;
      let share: ShareKeyResponse | null = null;
      if (shareStore) {
        const token = randomBytes(32).toString("base64url");
        const link = await shareStore.create({
          apiKeyId: keyId,
          tokenHash: hashShareToken(token),
          tokenEncrypted: encryptCredential(token),
          slug: generateShareSlug(),
          kind: "handoff",
          expiresAt: null,
          rotate: true,
        });
        const origin = (options.origin ?? "").replace(/\/$/, "");
        share = {
          id: link.id,
          url: `${origin}/share/${token}`,
          token,
          kind: link.kind,
          expiresAt: null,
        };
      }
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.regenerated",
        target: keyId,
      });
      return { secret: generated.secret, share };
    },
    /**
     * Returns a personal key's stored secret. The ciphertext exists exactly so
     * the owner can read it back; a share template has none, so it is refused.
     */
    async revealKey(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<{ secret: string }> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.keyMode !== "personal" || current.keyEncrypted === undefined)
        throw new ConsoleDomainError(
          "key_not_personal",
          409,
          "Only a personal key keeps a recoverable secret",
        );
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.revealed",
        target: keyId,
      });
      return { secret: decryptCredentialToString(current.keyEncrypted) };
    },
    async listShares(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<ShareLinkResponse[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      if (!config.shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.keyMode !== "share" || record.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      return (await config.shareStore.listForApiKey(keyId)).map(mapShareLinkResponse);
    },
    async listSharedKeys(
      access: AccessDecision | undefined,
      parentKeyId: string,
      query: URLSearchParams,
    ): Promise<{
      rows: readonly SharedKeySummary[];
      total: number;
      active: number;
      revoked: number;
      consumed: number;
    }> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const activity = config.shareActivity;
      if (!activity)
        throw new ConsoleDomainError("capability_unsupported", 501, "share telemetry not configured");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.revokedAt !== undefined ||
          parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const options = parseSharedChildrenQuery(query);
      const page = await config.store.listChildrenPage(authorized.tenantId, parentKeyId, options);
      const rows = await activity.getSharedKeySummaries(
        authorized.tenantId,
        page.rows,
        parentKeyId,
      );
      return { rows, total: page.total, active: page.active, revoked: page.revoked, consumed: page.consumed };
    },
    async getSharedKeyActivity(
      access: AccessDecision | undefined,
      parentKeyId: string,
      childKeyId: string,
    ): Promise<SharedKeyActivityDetail> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const activity = config.shareActivity;
      if (!activity)
        throw new ConsoleDomainError("capability_unsupported", 501, "share telemetry not configured");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.revokedAt !== undefined ||
          parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      // Membership is one indexed row read, not a scan of the whole family.
      const child = await config.store.get(authorized.tenantId, childKeyId);
      if (!child || child.parentKeyId !== parentKeyId)
        throw new ConsoleDomainError("key_not_found", 404, "Shared API key not found");
      return activity.getSharedKeyDetail(authorized.tenantId, childKeyId);
    },
    async revokeSharedScope(
      access: AccessDecision | undefined,
      parentKeyId: string,
      scope: "active" | "unused",
    ): Promise<{ success: true; deleted: number }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const deleted = await config.store.revokeChildrenByScope(
        authorized.tenantId,
        parentKeyId,
        scope,
      );
      // Raw batched deletes bypass the per-key purge path; drop the whole auth
      // cache so no resolved identity survives for a removed recipient.
      invalidateApiKeyCache();
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.share_revoked_scope",
        target: parentKeyId,
        detail: { scope, deleted },
      });
      return { success: true, deleted };
    },
    async revokeShare(
      access: AccessDecision | undefined,
      keyId: string,
      shareId: string,
    ): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.keyMode !== "share" || record.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const revoked = await shareStore.revoke(keyId, shareId);
      if (!revoked) throw new ConsoleDomainError("share_not_found", 404, "Share link not found");
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.share_revoked",
        target: shareId,
        detail: { keyId },
      });
      return { success: true };
    },
    async banKey(
      access: AccessDecision | undefined,
      keyId: string,
      request: BanApiKeyRequest,
    ): Promise<ApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const reason = request.reason.trim();
      if (reason.length === 0)
        throw new ConsoleDomainError("invalid_request", 400, "reason is required");
      // Parse the duration choice. `null` is permanent; absent defaults to one
      // hour. Anything not on the offered list is rejected rather than clamped —
      // clamping would answer a request for 90 days with a week and report
      // success.
      const chosenMinutes = request.minutes === undefined ? DEFAULT_BAN_MINUTES : request.minutes;
      if (!BAN_DURATION_MINUTES.has(chosenMinutes)) {
        throw new ConsoleDomainError(
          "invalid_request",
          400,
          "Unsupported ban duration. Choose one of the offered durations.",
        );
      }
      const bannedUntil = chosenMinutes === null ? null : new Date(Date.now() + chosenMinutes * 60_000);
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      const banned = await config.store.ban(authorized.tenantId, keyId, reason, bannedUntil);
      if (!banned) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // A banned child key does not affect its share template or sibling keys:
      // `store.ban` only turns off the one row named by `keyId`, and the auth
      // path rejects per key hash. The template keeps issuing working children.
      // A banned key must leave the auth cache for every process at once.
      invalidateApiKeyCache();
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.banned",
        target: keyId,
        detail: {
          reason,
          // The human-readable label is derived server-side from the machine
          // `reason`, so the audit trail cannot be skewed by a client-authored
          // label. Unknown reasons (custom text) simply carry no label; the
          // free-text `reason` above is still recorded verbatim.
          ...(API_KEY_BAN_REASONS.find((r) => r.value === reason)?.label === undefined
            ? {}
            : { reasonLabel: API_KEY_BAN_REASONS.find((r) => r.value === reason)!.label }),
          ...(bannedUntil === null ? { permanent: true } : { bannedUntil: bannedUntil.toISOString() }),
        },
      });
      // The ban mutates the row already fetched; derive the response from that
      // record instead of re-fetching after the write. Match the store's own
      // mapping: a `null` (permanent) `bannedUntil` is omitted, not carried.
      return sanitizeApiKeyResponse({
        ...current,
        bannedAt: new Date(),
        banReason: reason,
        ...(bannedUntil ? { bannedUntil } : {}),
      });
    },
    async unbanKey(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<ApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      const unbanned = await config.store.unban(authorized.tenantId, keyId);
      if (!unbanned) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      invalidateApiKeyCache();
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.unbanned",
        target: keyId,
      });
      // Unban clears all three ban columns and re-enables the key; derive the
      // response from the pre-fetch instead of re-fetching after the write.
      const { bannedAt: _bannedAt, banReason: _banReason, bannedUntil: _bannedUntil, ...currentRest } = current;
      const unbannedRecord: ApiKeyRecord = { ...currentRest, enabled: true };
      return sanitizeApiKeyResponse(unbannedRecord);
    },
  };
  return operations;
}

const apiKeyBody = t.Object({
  enabled: t.Optional(t.Boolean()),
  label: t.Optional(t.String()),
  keyMode: t.Optional(literalUnion(API_KEY_MODES)),
  scopes: t.Optional(t.Array(t.String())),
  keyPrefix: t.Optional(t.String()),
  key: t.Optional(t.String()),
  // Limit fields accept `null` to clear a previously set limit ("unlimited");
  // `undefined` leaves it unchanged.
  requestsPerMinute: t.Optional(t.Union([t.Number(), t.Null()])),
  dailyTokenLimit: t.Optional(t.Union([t.Number(), t.Null()])),
  monthlyTokenLimit: t.Optional(t.Union([t.Number(), t.Null()])),
  lifetimeTokenBudget: t.Optional(t.Union([t.Number(), t.Null()])),
  maxConcurrentRequests: t.Optional(t.Union([t.Number(), t.Null()])),
  concurrencyScope: t.Optional(literalUnion(API_KEY_CONCURRENCY_SCOPES)),
  modelPrefix: t.Optional(t.String()),
  modelAccessMode: t.Optional(literalUnion(API_KEY_MODEL_ACCESS_MODES)),
  modelList: t.Optional(t.Array(t.String())),
  clientRouterDenylist: t.Optional(t.Array(t.String())),
  notesTitle: t.Optional(t.String()),
  notesSubtitle: t.Optional(t.String()),
  notesBody: t.Optional(t.String()),
  sharePopupEnabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  sharePopupImage: t.Optional(t.Union([t.String({ maxLength: 2_800_000 }), t.Null()])),
  sharePopupTitle: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
  sharePopupBody: t.Optional(t.Union([t.String({ maxLength: 1200 }), t.Null()])),
});

/** Full replacement order for the tenant's top-level credential list. */
const reorderKeysBody = t.Object({ keyIds: t.Array(t.String(), { minItems: 1 }) });

const apiKeyShareBody = t.Object({
  expiresAt: t.Optional(t.Union([t.String(), t.Null()])),
  /** Replaces the existing link's token so the previous URL stops resolving. */
  regenerate: t.Optional(t.Boolean()),
});

/**
 * Serializes an intentional `null` payload as the JSON literal.
 *
 * Elysia reads a bare `null` return as "no content" and emits `200` with an
 * empty body and no `content-type`, which a JSON client cannot parse. `null`
 * here is a real answer — "this key has no link yet" — and the response type
 * declares it, so it has to arrive as the bytes `null` rather than as nothing.
 */
function jsonNull(): Response {
  return new Response("null", {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
/** Creates tenant-bound API-key routes with request-local authorization. */
export function createApiKeyRoutes(config: ApiKeyConfig): AnyElysia {
  const factory = createApiKeyOperations(config);
  return new Elysia({ prefix: "/api-keys" })
    .get("/", async ({ request, set, query }) => {
      try {
        const includeChildren = query?.["includeChildren"] === "1" || query?.["includeChildren"] === "true";
        return await factory.listKeys(config.accessResolver(request), includeChildren);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/banned", async ({ request, set }) => {
      try {
        return await factory.listActiveBannedKeys(config.accessResolver(request));
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/reorder", { body: reorderKeysBody }, async ({ request, body, set }) => {
      try {
        await factory.reorderKeys(config.accessResolver(request), body.keyIds);
        return { success: true };
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId", async ({ request, params, set }) => {
      try {
        return await factory.getKeyDetail(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/share-popup-image", async ({ request, params, set }) => {
      try {
        const result = await factory.getSharePopupImage(config.accessResolver(request), params.keyId);
        return new Response(new Blob([popupImageBytes(result.image)], { type: result.mime }), {
          headers: {
            "content-length": String(result.image.byteLength),
            "cache-control": "private, max-age=300",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return errorResponse(error, set, "API key operation failed");
      }
    })
    .get("/:keyId/shares", async ({ request, params, set }) => {
      try {
        return await factory.listShares(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/shared-keys", async ({ request, params, set }) => {
      try {
        return await factory.listSharedKeys(
          config.accessResolver(request),
          params.keyId,
          new URL(request.url).searchParams,
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/shared-keys/:childKeyId/activity", async ({ request, params, set }) => {
      try {
        return await factory.getSharedKeyActivity(
          config.accessResolver(request),
          params.keyId,
          params.childKeyId,
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post(
      "/:keyId/shared-keys/revoke-scope",
      { body: t.Object({ scope: t.Union([t.Literal("active"), t.Literal("unused")]) }) },
      async ({ request, params, body, set }) => {
        try {
          return await factory.revokeSharedScope(
            config.accessResolver(request),
            params.keyId,
            body.scope,
          );
        } catch (error) {
          return errorResponse(error, set, "API-key operation failed");
        }
      },
    )
    .delete("/:keyId/shares/:shareId", async ({ request, params, set }) => {
      try {
        return await factory.revokeShare(
          config.accessResolver(request),
          params.keyId,
          params.shareId,
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/", { body: apiKeyBody }, async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await factory.createKey(config.accessResolver(request), parseRequest(body));
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .patch("/:keyId", { body: apiKeyBody }, async ({ request, params, body, set }) => {
      try {
        return await factory.updateKey(
          config.accessResolver(request),
          params.keyId,
          parseRequest(body),
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .delete("/:keyId", async ({ request, params, set }) => {
      try {
        return await factory.deleteKey(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post(
      "/:keyId/ban",
      {
        body: t.Object({
          reason: t.String(),
          // `reasonLabel` is deliberately not accepted: the audit label is
          // derived server-side from `reason` (see `banKey`), so a client
          // cannot author the human-readable audit entry.
          minutes: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
        }),
      },
      async ({ request, params, body, set }) => {
        try {
          return await factory.banKey(config.accessResolver(request), params.keyId, body);
        } catch (error) {
          return errorResponse(error, set, "API-key operation failed");
        }
      },
    )
    .post("/:keyId/unban", async ({ request, params, set }) => {
      try {
        return await factory.unbanKey(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/share", async ({ request, params, set }) => {
      try {
        const share = await factory.getShare(config.accessResolver(request), params.keyId, {
          origin: new URL(request.url).origin,
        });
        return share ?? jsonNull();
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/:keyId/share", { body: t.Optional(apiKeyShareBody) }, async ({ request, params, body, set }) => {
      try {
        set.status = 201;
        const input = (body ?? {}) as { expiresAt?: string | null; regenerate?: boolean };
        return await factory.shareKey(config.accessResolver(request), params.keyId, {
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.regenerate === undefined ? {} : { regenerate: input.regenerate }),
          origin: new URL(request.url).origin,
        });
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/:keyId/reveal", async ({ request, params, set }) => {
      try {
        return await factory.revealKey(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/:keyId/regenerate", async ({ request, params, set }) => {
      try {
        return await factory.regenerateKey(config.accessResolver(request), params.keyId, {
          origin: new URL(request.url).origin,
        });
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    });
}
