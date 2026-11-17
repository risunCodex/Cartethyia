import { sha256Hex } from "../../../shared/hash";

/**
 * Claude User Profiles REST client.
 *
 * Research item #14 (the provider comparison research).
 * The `anthropic-user-profile-id` header half of that item is already done in
 * `claude.ts:225-242`; this module is the REST half — the read-only surface
 * that lets a console/ops caller resolve which profiles exist before any
 * dispatch decision depends on one.
 *
 * Wire shapes are read from the donor, not invented:
 *   - `packages/ai/src/providers/anthropic-user-profiles.ts:4,130-131` — beta
 *     `user-profiles-2026-09-04`, `anthropic-version: 2023-06-01`.
 *   - `:144-146` `POST /v1/user_profiles` (create) — not implemented, see below.
 *   - `:148-159` `GET /v1/user_profiles` with `?limit=&order=&order_by=&page=`.
 *   - `:174-176` `GET /v1/user_profiles/{id}` with `encodeURIComponent(id)`.
 *   - `:74-77` page shape `{ data: UserProfile[]; next_page: string | null }`.
 *   - `:36-47` / `:99-111` profile object shape.
 *
 * Deliberately omitted:
 *   - **create/update/enrollment-URL.** A router consumes profiles; it does not
 *     provision end users. Adding write paths would widen the credential's
 *     blast radius for no routing value.
 *   - **`iterateUserProfilePages`** (`:162-172`). The donor's generator walks
 *     `next_page` until it is null with no page cap — an unbounded fan-out on a
 *     shared upstream. `listClaudeUserProfiles` returns `next_page`, so a
 *     caller that wants to walk pages can, with its own bound.
 *
 * Not wired into dispatch. `ClaudeAdapter.dispatch` stamps the profile id it is
 * given and never needs to resolve one, so calling into this from the hot path
 * would add an upstream round trip to every request for no behavioral gain. The
 * module therefore throws on failure like `fetchClaudeQuota` does
 * (`claude-quota.ts:137-142`); **any future dispatch-time caller must catch and
 * continue**, because a profile lookup is metadata, not routing.
 */
import { TtlCache } from "../../../persistence/ttl-cache";
import { providerBaseUrl } from "../../provider-metadata";
import type { FetchLike } from "../../quota/quota-contracts";
import {
  authCredential,
  cleanError,
  getJson,
  record,
  text,
} from "../../quota/quota-contracts";
import { CLAUDE_CODE_USER_AGENT } from "./claude-fingerprint";

/**
 * Beta the donor sends on every user-profiles request
 * (`anthropic-user-profiles.ts:4`, applied at `:131`).
 */
export const CLAUDE_USER_PROFILES_BETA = "user-profiles-2026-09-04";

/** Anthropic sends snake_case on this API; the wire names are kept verbatim. */
export type ClaudeUserProfileAccessType = "application" | "passthrough";
export type ClaudeUserProfileAccountStatus = "active" | "suspended" | "blocked";
export type ClaudeUserProfileEntityType =
  | "individual"
  | "business"
  | "non_profit"
  | "government";
export type ClaudeUserProfileTrustStatus = "active" | "pending" | "rejected";

export interface ClaudeUserProfileExternalUserDetails {
  readonly account_status: ClaudeUserProfileAccountStatus | null;
  readonly country: string | null;
  readonly email_hash: string | null;
  readonly entity_type: ClaudeUserProfileEntityType | null;
  readonly name_hash: string | null;
  readonly onboarded_at: string | null;
  readonly reference_id: string | null;
}

/** `external_user_details` shape from `anthropic-user-profiles.ts:21-29,90-98`. */
export interface ClaudeUserProfile {
  readonly type: "user_profile";
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly trust_grants: Readonly<
    Record<string, { readonly status: ClaudeUserProfileTrustStatus }>
  >;
  readonly access_type?: ClaudeUserProfileAccessType;
  readonly external_user_details?: ClaudeUserProfileExternalUserDetails;
  readonly external_user_onboarded_at?: string | null;
  readonly name?: string | null;
}

/** `anthropic-user-profiles.ts:74-77`. */
export interface ClaudeUserProfilePage {
  readonly data: readonly ClaudeUserProfile[];
  readonly next_page: string | null;
}

/** `anthropic-user-profiles.ts:67-72`. */
export interface ListClaudeUserProfilesParams {
  readonly limit?: number;
  readonly order?: "asc" | "desc";
  readonly order_by?: "created_at" | "name";
  readonly page?: string;
}

export interface ClaudeUserProfilesOptions {
  readonly fetcher?: FetchLike;
  /**
   * Upstream origin. Falls back to `providerBaseUrl("claude")`
   * (`https://api.anthropic.com`, `provider-metadata.ts:30-38`), matching how
   * `endpointUrl` resolves a Claude origin (`protocol/codecs.ts:483`).
   */
  readonly base_url?: string;
}

/**
 * Resolves the profiles origin.
 *
 * The donor never names a user-profiles-specific base URL: it builds
 * `AnthropicUserProfilesClient` from the same `AnthropicClientOptions` as
 * Messages (`anthropic-user-profiles.ts:115-120`), so the origin falls through
 * to `AnthropicHttpClient`'s default `https://api.anthropic.com`
 * (`anthropic-client.ts:37,:227`). That value is the *transport's* default, not
 * a documented user-profiles endpoint — and every donor test injects
 * `baseURL` (`packages/ai/test/anthropic-user-profiles.test.ts:50`). So it is
 * an option here rather than a second hard-coded constant.
 */
function resolveBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? providerBaseUrl("claude")).replace(/\/+$/, "");
}

/** Header block mirrors `claude-quota.ts:121-131`, with the donor's beta. */
function requestHeaders(access: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    // Donor sets the profiles beta per request (`:131`), overriding any
    // client-level beta. It does *not* add `oauth-2025-04-20`; the OAuth beta
    // is a Messages-path concern and is not sent here.
    "anthropic-beta": CLAUDE_USER_PROFILES_BETA,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": CLAUDE_CODE_USER_AGENT,
    accept: "application/json, text/plain, */*",
    "accept-encoding": "gzip, compress, deflate, br",
    connection: "keep-alive",
  };
}

async function requestUserProfiles(
  credential: string,
  path: string,
  options: ClaudeUserProfilesOptions,
): Promise<unknown> {
  const access = text(authCredential(credential).accessToken) ?? credential;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const url = `${resolveBaseUrl(options.base_url)}${path}`;
  try {
    return await getJson(url, requestHeaders(access), fetcher);
  } catch (error: unknown) {
    // `getJson` prefixes its own errors with "Quota endpoint…" because it is
    // shared with the quota collectors; re-wrap so a profiles failure is
    // identifiable. `cleanError` strips any bearer token first.
    throw new Error(
      `Claude user profiles request failed: ${cleanError(error)}`,
    );
  }
}

function credentialKey(credential: string): string {
  return sha256Hex(credential);
}

/** Query string built exactly as the donor builds it (`:152-157`). */
function listQuery(params: ListClaudeUserProfilesParams): string {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.order !== undefined) query.set("order", params.order);
  if (params.order_by !== undefined) query.set("order_by", params.order_by);
  if (params.page !== undefined) query.set("page", params.page);
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

function parseStringMap(value: unknown): Readonly<Record<string, string>> {
  const source = record(value);
  if (source === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    const item = typeof entry === "string" ? entry : null;
    if (item !== null) out[key] = item;
  }
  return out;
}

function parseTrustGrants(
  value: unknown,
): Readonly<Record<string, { readonly status: ClaudeUserProfileTrustStatus }>> {
  const source = record(value);
  if (source === null) return {};
  const out: Record<string, { readonly status: ClaudeUserProfileTrustStatus }> =
    {};
  for (const [key, entry] of Object.entries(source)) {
    const status = text(record(entry)?.status);
    if (status === "active" || status === "pending" || status === "rejected") {
      out[key] = { status };
    }
  }
  return out;
}

function parseAccountStatus(
  value: unknown,
): ClaudeUserProfileAccountStatus | null {
  const status = text(value);
  return status === "active" || status === "suspended" || status === "blocked"
    ? status
    : null;
}

function parseEntityType(value: unknown): ClaudeUserProfileEntityType | null {
  const entity = text(value);
  return entity === "individual" ||
    entity === "business" ||
    entity === "non_profit" ||
    entity === "government"
    ? entity
    : null;
}

/**
 * Tolerant counterpart to the donor's `userProfileSchema`
 * (`anthropic-user-profiles.ts:99-111`).
 *
 * The donor rejects a body that does not match every field; this returns `null`
 * only when the body is unusable (not an object, or no `id`). Optional and
 * additive fields are best-effort so an upstream adding a field — or omitting
 * one the donor marks required — degrades the profile instead of failing the
 * caller. `id` stays strict: it is the only field a caller addresses.
 */
export function parseClaudeUserProfile(
  value: unknown,
): ClaudeUserProfile | null {
  const source = record(value);
  if (source === null) return null;
  const id = text(source["id"]);
  if (id === null) return null;
  const accessType = text(source["access_type"]);
  const details = record(source["external_user_details"]);
  return {
    type: "user_profile",
    id,
    created_at: text(source["created_at"]) ?? "",
    updated_at: text(source["updated_at"]) ?? "",
    metadata: parseStringMap(source["metadata"]),
    trust_grants: parseTrustGrants(source["trust_grants"]),
    ...(accessType === "application" || accessType === "passthrough"
      ? { access_type: accessType }
      : {}),
    ...(details === null
      ? {}
      : {
          external_user_details: {
            account_status: parseAccountStatus(details["account_status"]),
            country: text(details["country"]),
            email_hash: text(details["email_hash"]),
            entity_type: parseEntityType(details["entity_type"]),
            name_hash: text(details["name_hash"]),
            onboarded_at: text(details["onboarded_at"]),
            reference_id: text(details["reference_id"]),
          },
        }),
    ...(source["external_user_onboarded_at"] === undefined
      ? {}
      : {
          external_user_onboarded_at: text(
            source["external_user_onboarded_at"],
          ),
        }),
    ...(source["name"] === undefined
      ? {}
      : { name: text(source["name"]) }),
  };
}

/**
 * Page parser; `next_page` is the cursor a caller feeds back as `page`.
 *
 * `data` must be an array (donor `userProfilePageSchema`, `:111`) — a body
 * without it is not a page, and returning an empty page instead would make "no
 * profiles" indistinguishable from a garbled response. Individual rows stay
 * tolerant per {@link parseClaudeUserProfile}. A missing `next_page` is read as
 * `null` (one page, no cursor) rather than rejected.
 */
export function parseClaudeUserProfilePage(
  value: unknown,
): ClaudeUserProfilePage | null {
  const source = record(value);
  if (source === null) return null;
  const rows = source["data"];
  if (!Array.isArray(rows)) return null;
  const data: ClaudeUserProfile[] = [];
  for (const row of rows) {
    const profile = parseClaudeUserProfile(row);
    if (profile !== null) data.push(profile);
  }
  return { data, next_page: text(source["next_page"]) };
}

/**
 * `GET /v1/user_profiles` (`anthropic-user-profiles.ts:148-159`).
 *
 * Throws on transport failure, a non-2xx status, or an unusable body. Reads are
 * cached per credential + query for {@link PROFILE_CACHE_TTL_MS}.
 */
export async function listClaudeUserProfiles(
  credential: string,
  params: ListClaudeUserProfilesParams = {},
  options: ClaudeUserProfilesOptions = {},
): Promise<ClaudeUserProfilePage> {
  const suffix = listQuery(params);
  const key = `${credentialKey(credential)}:${suffix}`;
  const cached = pageCache.get(key);
  if (cached !== undefined) return cached;
  const body = await requestUserProfiles(
    credential,
    `/v1/user_profiles${suffix}`,
    options,
  );
  const page = parseClaudeUserProfilePage(body);
  if (page === null)
    throw new Error("Claude user profiles request failed: malformed response");
  pageCache.set(key, page);
  return page;
}

/**
 * Bounded per-credential caches, the same shape as the quota caches in
 * `claude-quota.ts:150-163`: keys are credential hashes, never raw secrets, and
 * both are capped so credential fan-out cannot pin memory.
 */
const PROFILE_CACHE_TTL_MS = 5 * 60_000;
const PROFILE_CACHE_MAX_ENTRIES = 256;
const pageCache = new TtlCache<ClaudeUserProfilePage>({
  ttlMs: PROFILE_CACHE_TTL_MS,
  maxEntries: PROFILE_CACHE_MAX_ENTRIES,
});
