// Console API-key domain contracts: request/response shapes and pure helpers.
//
// Single source for key creation validation and response sanitization;
// routes consume it, they do not redeclare it.

import type { AuditSink } from "../audit/contracts";
import { randomBytes } from "node:crypto";
import type { ApiKeyRecord, ApiKeyStore } from "../../persistence/stores/api-key-store";
import { hashSecret } from "../../security/crypto";
import { type ShareLinkStore, type ShareLinkSummary } from "../../persistence/stores/share-store";
import { API_KEY_MODES, API_KEY_CONCURRENCY_SCOPES, type ApiKeyMode, type ApiKeyModelAccessMode, type ShareLinkKind } from "../../persistence/schema";
import { isValidTenantKeyScope, type AccessScope } from "../../security/access-control";
import { normalizeClientRouterId } from "../../security/client-router-fingerprint";
import type { ShareActivityPort, SharedKeySummary } from "../share/share-usage";
import { ConsoleDomainError } from "../shared/errors";
import { pickDefined } from "../shared/object";
import type { ConsoleAccessResolver } from "../auth/access";
import type { ApiKeyAdmissionService } from "../../security/admission/service";
import {
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
  sniffSharePopupImageMime,
  type SharePopupImageMime,
} from "./share-popup-image";

// Re-exported so consumers reach the image bounds from this contract module.
// `share-popup-image.ts` is the pure authority; it stays import-free so the
// dashboard can read the same bounds its upload control enforces.
export {
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
  type SharePopupImageMime,
} from "./share-popup-image";
export type {
  SharedKeySummary,
  SharedKeyActivityDetail,
} from "../share/share-usage";

/** Paged response of the share-child list endpoint. */
export interface SharedKeyPage {
  readonly rows: readonly SharedKeySummary[];
  readonly total: number;
  readonly active: number;
  readonly revoked: number;
  /** Family-wide lifetime tokens consumed, independent of the page. */
  readonly consumed: number;
}

/** How a share template's concurrency cap applies to its recipients. */
export type ConcurrencyScope = (typeof API_KEY_CONCURRENCY_SCOPES)[number];

/** Input accepted when creating or editing a key. Null limits mean unlimited. */
export interface CreateApiKeyRequest {
  enabled?: boolean;
  label?: string;
  keyMode?: ApiKeyMode;
  scopes?: readonly string[];
  /** Public leading fragment used for generated keys; defaults to the product prefix. */
  keyPrefix?: string;
  /** Owner-supplied raw key value; valid only for personal keys. */
  key?: string;
  requestsPerMinute?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  lifetimeTokenBudget?: number | null;
  maxConcurrentRequests?: number | null;
  /**
   * How `maxConcurrentRequests` applies to a share template's family:
   * `family` (default) = one cap across all recipient keys (a single shared
   * admission counter); `per_key` = each recipient key gets its own cap and
   * independent counter. Ignored/meaningless for personal keys.
   */
  concurrencyScope?: ConcurrencyScope;
  /** Share-template slot cap; only meaningful when keyMode === "share". */
  maxChildren?: number | null;
  modelPrefix?: string;
  modelAccessMode?: ApiKeyModelAccessMode;
  modelList?: readonly string[];
  /** Client-router ids this key refuses; see `client-router-fingerprint.ts`. */
  clientRouterDenylist?: readonly string[];
  notesTitle?: string;
  notesSubtitle?: string;
  notesBody?: string;
  sharePopupEnabled?: boolean | null;
  /**
   * Uploaded popup art as a `data:<mime>;base64,…` URL. `null` clears it and
   * omitting it leaves the stored image alone. There is no remote-URL form: a
   * hotlink leaked each visitor's IP to a third party and rotted on host moves.
   */
  sharePopupImage?: string | null;
  sharePopupTitle?: string;
  sharePopupBody?: string;
}

/** Public key representation; it never contains a secret, hash, or IP-key digest. */
export interface ApiKeyResponse {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly keyMode: ApiKeyMode;
  readonly scopes: readonly AccessScope[];
  /** The tenant's mandatory gateway key: rotatable, never revocable. */
  readonly isDefault: boolean;
  readonly keyPrefix?: string;
  readonly parentKeyId?: string;
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly modelPrefix?: string;
  readonly modelAccessMode?: ApiKeyModelAccessMode;
  readonly modelList?: readonly string[];
  readonly clientRouterDenylist?: readonly string[];
  readonly maxConcurrentRequests?: number;
  readonly concurrencyScope?: ConcurrencyScope;
  readonly maxChildren?: number;
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly sharePopupEnabled?: boolean;
  /** Mime of the stored popup art; its bytes are served by a dedicated route. */
  readonly sharePopupImageMime?: string;
  readonly sharePopupTitle?: string;
  readonly sharePopupBody?: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
  /** Ban state; see the schema columns for the contract. */
  readonly bannedAt?: string;
  readonly banReason?: string;
  /** When the ban lifts on its own; absent means permanent. */
  readonly bannedUntil?: string;
  readonly tokensConsumed: number;
}
/** Creation result; plaintext is returned only when a personal key is minted. */
export interface CreateApiKeyResponse extends ApiKeyResponse {
  readonly secret?: string;
}

/** Edit result carries one new secret on personal rotation or template conversion. */
export interface UpdateApiKeyResponse extends ApiKeyResponse {
  readonly secret?: string;
}

/**
 * Ban reasons offered by the console dropdown, and the durations the ban
 * endpoint accepts. These are pure lists, kept in `ban-constants.ts` (no
 * `node:*` imports) so the dashboard can import them without dragging Node
 * crypto into the browser bundle. Re-exported here for backend consumers
 * (`routes.ts` validates against `BAN_DURATION_CHOICES`).
 */
export {
  API_KEY_BAN_REASONS,
  BAN_DURATION_CHOICES,
} from "./ban-constants";

/** What a bare "ban this key" click uses: the shortest, most reversible choice. */
export const DEFAULT_BAN_MINUTES: number = 60;

/** Body accepted by the ban endpoint. */
export interface BanApiKeyRequest {
  readonly reason: string;
  /**
   * Ban duration in whole minutes from {@link BAN_DURATION_CHOICES}; `null`
   * means permanent. Absent = {@link DEFAULT_BAN_MINUTES}.
   */
  readonly minutes?: number | null;
}

/** API-key route dependency boundary. */
export interface ApiKeyConfig {
  readonly store: ApiKeyStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  readonly shareStore?: ShareLinkStore;
  readonly shareActivity?: ShareActivityPort;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey"> & {
    seedBuckets?(request: {
      readonly apiKeyId: string;
      readonly now?: number;
      readonly daily?: number;
      readonly monthly?: number;
    }): Promise<void>;
  };
  /**
   * Reads tokens already spent in the current daily/monthly bucket, so a
   * newly-added limit is enforced against the whole bucket. Optional: without
   * it a new limit simply starts counting from the moment it was set.
   */
  readonly bucketSpend?: (
    keyId: string,
    now: Date,
  ) => Promise<{ daily: number; monthly: number }>;
}

/** Result of minting a share link. The bearer token is returned exactly once. */
export interface ShareKeyResponse {
  readonly id: string;
  readonly url: string;
  /**
   * The bearer half of the link. Null when the row was written under an
   * encryption key this deployment no longer holds: the page stays reachable
   * from `url`, but the secret cannot be shown again and must be regenerated
   * before the link can authenticate.
   */
  readonly token: string | null;
  readonly kind: ShareLinkKind;
  readonly expiresAt: string | null;
}

/** One share link as shown in the owner's console list. Never carries the token. */
export interface ShareLinkResponse {
  readonly id: string;
  readonly kind: ShareLinkKind;
  readonly active: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastViewedAt: string | null;
}

/**
 * Default prefix for newly generated API keys.
 *
 * The separator is a hyphen, not an underscore, and the random tail is a fixed
 * 16 characters: `pn-carte-` for personal keys, `sh-carte-` for the ones a
 * share template issues. Both are metadata shown in the console — nothing
 * looks a key up by its prefix — so changing these does not invalidate rows
 * already stored, which keep the prefix they were issued with.
 */
export const DEFAULT_API_KEY_PREFIX = "pn-carte-";
/** Default prefix used by share templates and the keys they issue. */
export const DEFAULT_SHARE_API_KEY_PREFIX = "sh-carte-";

/**
 * Bytes of entropy behind the random tail.
 *
 * 12 bytes base64url-encodes to exactly 16 characters with no padding, which
 * is the whole reason for the number: the length in the constants above and
 * the length a generated key actually has cannot disagree.
 */
const KEY_SECRET_BYTES = 12;

/** Label of the default gateway API key seeded at first boot; never revoked. */
export const DEFAULT_API_KEY_LABEL = "Default Cartethyia API key";

/** Recognizes the default gateway API key by its persisted flag. */
export function isDefaultGatewayApiKey(
  record: Pick<ApiKeyRecord, "isDefault">,
): boolean {
  return record.isDefault;
}

/** Generates an inbound key and its one-way hash. */
export function generateApiKeySecret(prefix = DEFAULT_API_KEY_PREFIX): {
  secret: string;
  hash: string;
  prefix: string;
} {
  const secret = `${prefix}${randomBytes(KEY_SECRET_BYTES).toString("base64url")}`;
  return { secret, hash: hashSecret(secret), prefix };
}

/** Normalizes a caller-supplied prefix; falls back to `fallback`. */
function resolvePrefix(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

/** Normalizes a caller-supplied prefix; falls back to the personal default. */
export function resolveKeyPrefix(raw: string | undefined): string {
  return resolvePrefix(raw, DEFAULT_API_KEY_PREFIX);
}

/** Resolves the share-key prefix; falls back to the share default. */
export function resolveShareKeyPrefix(raw: string | undefined): string {
  return resolvePrefix(raw, DEFAULT_SHARE_API_KEY_PREFIX);
}

/** Maximum hint the enroll page accepts; the dashboard caps its input there. */
export const SHARED_CHILD_HINT_MAX_LENGTH = 20;

/** Hashes an owner-supplied personal key; persistence encrypts it for CLI handoff. */
export function prepareCustomKey(secret: string): { secret: string; hash: string } {
  if (secret.trim().length === 0) {
    throw new ConsoleDomainError("invalid_key", 400, "Custom key must be a non-empty string");
  }
  return { secret, hash: hashSecret(secret) };
}

export function finitePositive(value: number | null | undefined, name: string): void {
  // `null` explicitly clears a previously set limit; `undefined` leaves it
  // unchanged. Only a real non-null number must be finite and positive.
  if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 1)) {
    throw new ConsoleDomainError("invalid_limits", 400, `${name} must be a finite positive number`);
  }
}

/**
 * Decodes an uploaded popup image into the bytes and mime to persist.
 *
 * Returns `null` for absent/blank input (nothing to store). Throws
 * `invalid_share_popup` for a non-data URL, an oversized payload, or bytes that
 * are not one of the four raster formats the share page may safely serve.
 */
export function parseSharePopupImage(
  value: string | null | undefined,
): { image: Buffer; mime: SharePopupImageMime } | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const match =
    /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
  const declared = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  if (!payload || declared === undefined || !(SHARE_POPUP_IMAGE_MIMES as readonly string[]).includes(declared)) {
    throw new ConsoleDomainError(
      "invalid_share_popup",
      400,
      "sharePopupImage must be an uploaded PNG, JPEG, WebP, or GIF file",
    );
  }
  const image = Buffer.from(payload, "base64");
  if (image.length === 0 || image.length > SHARE_POPUP_IMAGE_MAX_BYTES) {
    throw new ConsoleDomainError(
      "invalid_share_popup",
      400,
      `sharePopupImage must be at most ${Math.floor(SHARE_POPUP_IMAGE_MAX_BYTES / (1024 * 1024))} MB`,
    );
  }
  const mime = sniffSharePopupImageMime(image);
  if (mime === undefined || mime !== declared) {
    throw new ConsoleDomainError(
      "invalid_share_popup",
      400,
      "sharePopupImage bytes do not match a supported image format",
    );
  }
  return { image, mime };
}

/** Validates scopes and quota fields before persistence. */
export function validateApiKeyRequest(request: CreateApiKeyRequest): readonly AccessScope[] {
  const keyMode = request.keyMode ?? "personal";
  if (!(API_KEY_MODES as readonly string[]).includes(keyMode)) {
    throw new ConsoleDomainError("invalid_key_mode", 400, "keyMode must be personal or share");
  }
  if (keyMode === "share" && request.key !== undefined) {
    throw new ConsoleDomainError("invalid_key_mode", 400, "Share templates cannot carry a personal key");
  }
  const scopes = request.scopes ?? ["routing:invoke", "search:invoke"];
  for (const scope of scopes) {
    if (!isValidTenantKeyScope(scope as AccessScope)) {
      throw new ConsoleDomainError("invalid_scope", 400, `Scope is not allowed: ${scope}`);
    }
  }
  finitePositive(request.requestsPerMinute, "requestsPerMinute");
  finitePositive(request.dailyTokenLimit, "dailyTokenLimit");
  finitePositive(request.monthlyTokenLimit, "monthlyTokenLimit");
  finitePositive(request.lifetimeTokenBudget, "lifetimeTokenBudget");
  finitePositive(request.maxConcurrentRequests, "maxConcurrentRequests");
  if (
    request.concurrencyScope !== undefined &&
    !(API_KEY_CONCURRENCY_SCOPES as readonly string[]).includes(request.concurrencyScope)
  ) {
    throw new ConsoleDomainError("invalid_limits", 400, "concurrencyScope must be family or per_key");
  }
  if (request.concurrencyScope !== undefined && keyMode !== "share") {
    throw new ConsoleDomainError(
      "invalid_limits",
      400,
      "concurrencyScope is only valid for share templates",
    );
  }
  if (request.maxChildren !== undefined && request.maxChildren !== null) {
    finitePositive(request.maxChildren, "maxChildren");
    if (request.maxChildren > 10_000) {
      throw new ConsoleDomainError("invalid_limits", 400, "maxChildren must not exceed 10000");
    }
    if (keyMode !== "share") {
      throw new ConsoleDomainError("invalid_limits", 400, "maxChildren is only valid for share templates");
    }
  }
  parseSharePopupImage(request.sharePopupImage);
  if (request.sharePopupTitle != null && request.sharePopupTitle.length > 120) {
    throw new ConsoleDomainError("invalid_share_popup", 400, "Share popup title is too long");
  }
  if (request.sharePopupBody != null && request.sharePopupBody.length > 1200) {
    throw new ConsoleDomainError("invalid_share_popup", 400, "Share popup body is too long");
  }
  if (
    request.modelPrefix !== undefined &&
    (typeof request.modelPrefix !== "string" || request.modelPrefix.trim().length === 0)
  ) {
    throw new ConsoleDomainError(
      "invalid_model_prefix",
      400,
      "modelPrefix must be a non-empty string if provided",
    );
  }
  if (
    request.keyPrefix !== undefined &&
    (typeof request.keyPrefix !== "string" || request.keyPrefix.trim().length === 0)
  ) {
    throw new ConsoleDomainError(
      "invalid_key_prefix",
      400,
      "keyPrefix must be a non-empty string if provided",
    );
  }
  if (request.clientRouterDenylist !== undefined) {
    if (!Array.isArray(request.clientRouterDenylist)) {
      throw new ConsoleDomainError(
        "invalid_client_router_denylist",
        400,
        "clientRouterDenylist must be an array of client-router ids",
      );
    }
    // An unrecognised id would persist a rule that can never match — the operator
    // would believe a router is blocked while nothing blocks it. Rejecting it is
    // the only outcome that keeps the stored policy honest.
    for (const id of request.clientRouterDenylist) {
      if (typeof id !== "string" || normalizeClientRouterId(id) === undefined) {
        throw new ConsoleDomainError(
          "invalid_client_router_denylist",
          400,
          `Unknown client router: ${String(id)}`,
        );
      }
    }
  }
  return scopes as AccessScope[];
}

/** Serializes a persisted record without credential material or IP-key digests. */
export function sanitizeApiKeyResponse(record: ApiKeyRecord): ApiKeyResponse {
  const keyPrefix =
    record.keyMode === "share" ? resolveShareKeyPrefix(record.keyPrefix) : record.keyPrefix;
  return {
    id: record.id,
    label: record.label,
    enabled: record.enabled,
    keyMode: record.keyMode,
    scopes: record.scopes,
    /**
     * The persisted flag alone decides this: the label is display text, so
     * renaming the key cannot change which key is the default.
     */
    isDefault: isDefaultGatewayApiKey(record),
    ...pickDefined({
      keyPrefix,
      parentKeyId: record.parentKeyId,
      notesTitle: record.notesTitle,
      notesSubtitle: record.notesSubtitle,
      notesBody: record.notesBody,
      sharePopupEnabled: record.sharePopupEnabled,
      sharePopupImageMime: record.sharePopupImageMime,
      sharePopupTitle: record.sharePopupTitle,
      sharePopupBody: record.sharePopupBody,
      requestsPerMinute: record.requestsPerMinute,
      dailyTokenLimit: record.dailyTokenLimit,
      monthlyTokenLimit: record.monthlyTokenLimit,
      lifetimeTokenBudget: record.lifetimeTokenBudget,
      maxConcurrentRequests: record.maxConcurrentRequests,
      concurrencyScope: record.concurrencyScope,
      maxChildren: record.maxChildren,
      modelPrefix: record.modelPrefix,
      modelAccessMode: record.modelAccessMode,
      modelList: record.modelList,
      clientRouterDenylist: record.clientRouterDenylist,
      revokedAt: record.revokedAt?.toISOString(),
      bannedAt: record.bannedAt?.toISOString(),
      banReason: record.banReason,
      bannedUntil: record.bannedUntil?.toISOString(),
    }),
    createdAt: record.createdAt.toISOString(),
    tokensConsumed: record.tokensConsumed,
  };
}

export function parseRequest(value: unknown): CreateApiKeyRequest {
  if (typeof value !== "object" || value === null)
    throw new ConsoleDomainError("invalid_request", 400, "Request body must be an object");
  return value as CreateApiKeyRequest;
}

/** Maps a persisted share link to the console response (ISO timestamps, no token). */
export function mapShareLinkResponse(link: ShareLinkSummary): ShareLinkResponse {
  return {
    id: link.id,
    kind: link.kind,
    active: link.active,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
    lastViewedAt: link.lastViewedAt === null ? null : link.lastViewedAt.toISOString(),
  };
}
