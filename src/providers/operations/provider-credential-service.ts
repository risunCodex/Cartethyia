// Provider credentials: decrypts stored account rows into dispatchable ResolvedCredentials.
import { eq } from "drizzle-orm";

import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { providerAccounts, providerOauthStates } from "../../persistence/schema";
import { decryptCredentialToString } from "../../security/crypto";
import { GatewayError } from "../../protocol/gateway-error";
import type { OAuthRefreshService, OAuthTokenRefresher } from "../authentication/oauth-refresh-service";
import { CredentialResolver, type CredentialAlternative } from "../provider-credential-resolver";
import { parseProviderId, type CredentialKind } from "../provider-contracts";
import type { ResolvedCredential } from "../provider-contracts";
import { refreshLeadMs } from "./oauth-refresh-lead";
import { asJsonbRecord } from "../../shared/coerce";

/**
 * The `auth_state` JSONB column arrives as a POJO from Postgres (drizzle
 * jsonb) but as a JSON STRING from SQLite (the native column stores text).
 * The resolver's `record()` helper rejects strings, so a SQLite read dropped
 * the auth state entirely — Qoder dispatch then saw no userId/machineId and
 * failed with 401 "missing its user identity". Parse the string form once
 * here so every backend hands the resolver the same POJO shape.
 */
function jsonbRecord(value: unknown): Record<string, unknown> | undefined {
  return asJsonbRecord(value);
}

// ── Credential cache ─────────────────────────────────────────────────────────
/**
 * TTL-based cache for `resolveCredentialForAccount`, keyed by
 * `providerId:accountId`. The provider must be part of the key: an accountId
 * reused across providers (e.g. a routing search candidate sharing the
 * selected route's account id) would otherwise resolve to the other
 * provider's credential. Avoids a Postgres SELECT + AES-GCM decrypt on every
 * attempt. The TTL is short enough that credential rotation is picked up
 * almost immediately; `invalidateCredentialCache` provides explicit
 * invalidation for the credential-rotation mutation points.
 */
const CRED_CACHE_TTL_MS = 5_000;
const CRED_CACHE_MAX_ENTRIES = 2_000;

interface CredCacheEntry {
  readonly at: number;
  readonly value: ResolvedCredential;
  /**
   * When this entry must stop being served, or `undefined` for "the default
   * TTL applies".
   *
   * Per-entry rather than global because a credential's usable lifetime is a
   * property of the credential: an OAuth token with 30 minutes left can be
   * served for the full window, one with 20 seconds left for almost none of
   * it. Storing the bound on the entry lets both share one cache.
   */
  readonly expiresAt?: number;
}

/**
 * Margin kept between a cached OAuth token's expiry and the moment the cache
 * stops serving it.
 *
 * The old rule refused to cache OAuth at all unless the token outlived the
 * whole 5 s window, which meant every attempt paid a SELECT + AES-GCM decrypt
 * for every OAuth account — the largest remaining per-request DB read. Caching
 * against the token's own expiry is the same safety with a fraction of the
 * reads. The margin covers clock skew between this process and the issuer, and
 * the time a request already in flight may hold the value.
 */
const CRED_CACHE_EXPIRY_MARGIN_MS = 30_000;

const credCache = new Map<string, CredCacheEntry>();

/**
 * Cache key combining the provider identity with the account id. The provider
 * must participate: a routing candidate can reuse another provider's account
 * id (e.g. a combo member borrowing a sibling's account), and an
 * accountId-only key would hand back the other provider's credential.
 * The separator cannot appear in a provider id (lowercase slug grammar), so
 * distinct pairs never collide.
 */
function credCacheKey(providerId: string, accountId: string): string {
  return `${providerId}:${accountId}`;
}

function evictCredCacheOldest(): void {
  while (credCache.size > CRED_CACHE_MAX_ENTRIES) {
    const oldest = credCache.keys().next().value;
    if (oldest === undefined) return;
    credCache.delete(oldest);
  }
}

/**
 * Invalidates one account's cached credential (or the entire cache).
 * Call after credential rotation, account deletion, or account disable.
 * Account ids are globally unique, so a suffix match removes every entry
 * for that account regardless of which provider resolved it.
 */
export function invalidateCredentialCache(accountId?: string): void {
  if (accountId === undefined) {
    credCache.clear();
    return;
  }
  const suffix = `:${accountId}`;
  for (const key of credCache.keys()) {
    if (key.endsWith(suffix)) credCache.delete(key);
  }
}

const resolver = new CredentialResolver();

/** Stored account fields needed by credential resolution and token refresh. */
export interface AccountWithFreshnessRow {
  readonly id: string;
  readonly providerId: string;
  readonly credentialKind: CredentialKind;
  readonly credentialCiphertext: Buffer | null;
  readonly refreshCiphertext: Buffer | null;
  /** Non-secret per-account auth config; `unknown` at the DB boundary, narrowed where read. */
  readonly authState: unknown;
  readonly clientSecretCiphertext: Buffer | null;
  readonly expiresAt: Date | null;
  /** The credential is a static bearer token that must never be refreshed. */
  readonly staticToken: boolean;
}

/** One account row together with its skew-adjusted OAuth due time. */
export interface AccountWithFreshness {
  readonly row: AccountWithFreshnessRow;
  readonly dueAt: number | undefined;
}

/**
 * Loads an account and its optional OAuth state in one query.
 *
 * `dueAt` is the OAuth expiry minus the provider's refresh lead
 * (`refreshLeadMs(providerId)`), so a token becomes due at the point that
 * provider re-mints its own (Claude ~4h, Codex ~5 days, Antigravity ~5 min).
 * Non-OAuth accounts and accounts without OAuth state have no due time.
 */
export async function loadAccountWithFreshness(
  db: CartethyiaDatabase,
  accountId: string,
  skewMs?: number,
): Promise<AccountWithFreshness | undefined> {
  const selectBuilder = db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      credentialKind: providerAccounts.credentialKind,
      credentialCiphertext: providerAccounts.credentialCiphertext,
      refreshCiphertext: providerOauthStates.refreshCiphertext,
      authState: providerAccounts.authState,
      clientSecretCiphertext: providerOauthStates.clientSecretCiphertext,
      expiresAt: providerOauthStates.expiresAt,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts);
  const query = "leftJoin" in selectBuilder
    ? selectBuilder.leftJoin(
        providerOauthStates,
        eq(providerOauthStates.providerAccountId, providerAccounts.id),
      )
    : selectBuilder;
  const rows = await query.where(eq(providerAccounts.id, accountId)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const lead = skewMs ?? refreshLeadMs(row.providerId);
  // A refresh-capable OAuth account with no stored expiry is unknown-liveness:
  // we have no evidence the access token still works. The old rule left
  // `dueAt` undefined for these, so `resolveCredentialForAccount` skipped the
  // refresh branch and dispatch sent the pasted token as-is. For a token that
  // had already expired on another installation (a 9router/Omniroute import
  // carrying `accessToken` + `refreshToken` + a past `expiresAt` that was
  // dropped by validation, a hand-pasted OAuth bundle with no expiry field,
  // or an upstream that stopped minting expiries) that produced the exact
  // "re-authenticate" refusal the refresh grant exists to prevent. Marking the
  // token due immediately refreshes it on first use; the sweep handles the
  // normal case where `expires_at` is populated.
  const hasRefreshGrant = row.refreshCiphertext != null;
  const kindOauth = row.credentialKind === "oauth";
  const unknownExpiryButRefreshable =
    kindOauth && !row.staticToken && hasRefreshGrant && row.expiresAt == null;
  return {
    row,
    // A static token is never "due": it is used as issued and there is no
    // refresh to run, so the dispatch path must not treat it as stale.
    dueAt:
      row.staticToken
        ? undefined
        : row.expiresAt != null
          ? row.expiresAt.getTime() - lead
          : unknownExpiryButRefreshable
            ? 0
            : undefined,
  };
}

/** OAuth refresh collaborators, injected by the composition root. */
export interface ResolveCredentialOAuth {
  /** Registry-backed refresher lookup; providers without a refresher are skipped. */
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
}

/** Resolves the credential for a specific provider-account id, decrypting at read time. */
export async function resolveCredentialForAccount(
  db: CartethyiaDatabase,
  providerId: string,
  accountId: string,
  oauth?: ResolveCredentialOAuth,
): Promise<ResolvedCredential> {
  // Cache hit: skip DB round-trip + AES-GCM decrypt.
  // Don't cache OAuth credentials whose token is due for refresh soon —
  // the cached value would contain a soon-to-expire secret.
  const now = Date.now();
  const cached = credCache.get(credCacheKey(providerId, accountId));
  if (cached) {
    // Two independent bounds: the cache window (rotation freshness) and, for a
    // credential whose usable life was known, the moment that life ends. The
    // shorter one wins, so a token about to expire is never served past it and
    // no credential is served stale for longer than the window.
    const withinWindow = now - cached.at < CRED_CACHE_TTL_MS;
    const withinLife = cached.expiresAt === undefined || now < cached.expiresAt;
    if (withinWindow && withinLife) return cached.value;
  }

  const parsedProviderId = parseProviderId(providerId);
  const account = await loadAccountWithFreshness(db, accountId);
  if (!account) {
    throw new GatewayError("admission_unavailable", 503, "This provider account no longer exists, so its credential cannot be read. Re-select the account, or point the route at a live one.", {
      provider_id: providerId,
      account_id: accountId,
    });
  }

  const { row, dueAt } = account;
  let secret: string | undefined;
  if (row.credentialCiphertext) {
    try {
      secret = decryptCredentialToString(row.credentialCiphertext);
    } catch {
      throw new GatewayError(
        "authentication_failed",
        401,
        "provider credential cannot be decrypted (request {requestId}); re-save the account credential. Wrong key, right door — check the credential 🔑",
        {
          providerId: row.providerId,
          accountId: row.id,
          credentialEvidence: true,
          accountScope: true,
        },
      );
    }
  }
  if (row.credentialKind === "oauth" && oauth && dueAt !== undefined && dueAt <= Date.now()) {
    const refresher = await oauth.resolveRefresher(row.providerId);
    if (refresher) {
      // Try to refresh. If it fails (refresh grant dead, upstream unreachable,
      // etc.) keep the already-decrypted stale secret rather than wiping it:
      // dispatch then sends the token we have, and the upstream's own 401 is
      // the authoritative verdict. Wiping it here turned "token expired" into
      // a credential-less GatewayError before the request ever left, which is
      // worse than letting the server say so.
      const refreshed = await oauth.refreshService.ensureFreshAccessToken(accountId, refresher);
      if (refreshed) secret = refreshed;
    }
  }

  const authState = jsonbRecord(row.authState);
  const alternative: CredentialAlternative = {
    provider_id: parseProviderId(row.providerId),
    account_id: row.id,
    credential_kind: row.credentialKind,
    ...(secret ? { secret } : {}),
    ...(authState === undefined ? {} : { auth_state: authState }),
  };
  const value = resolver.resolve(parsedProviderId, [alternative]).credential;
  // Every credential is cached; an OAuth token with a known expiry simply gets
  // a shorter bound. Refusing to cache OAuth was the safe-looking choice that
  // cost a SELECT + decrypt per attempt, and it was stricter than necessary:
  // the risk is serving an expired token, which a TTL tied to that token
  // expiry prevents as completely as not caching does.
  const isOAuth = row.credentialKind === "oauth";
  const lifeBound =
    isOAuth && dueAt !== undefined ? dueAt - CRED_CACHE_EXPIRY_MARGIN_MS : undefined;
  // A token already inside the margin must not be cached at all — its bound
  // would be in the past, so the entry would be dead on arrival.
  if (lifeBound === undefined || lifeBound > now) {
    credCache.set(credCacheKey(providerId, accountId), {
      at: now,
      value,
      ...(lifeBound === undefined ? {} : { expiresAt: lifeBound }),
    });
    evictCredCacheOldest();
  }
  return value;
}

export async function resolveAccountSecretString(
  db: CartethyiaDatabase,
  providerId: string,
  accountId: string,
  oauth?: ResolveCredentialOAuth,
): Promise<string> {
  const credential = await resolveCredentialForAccount(db, providerId, accountId, oauth);
  return credential.secret ? new TextDecoder().decode(credential.secret) : "";
}

/** Decrypts the stored provider tokens after refreshing an expired OAuth access token. */
export async function resolveAccountCredentialsForExport(
  db: CartethyiaDatabase,
  providerId: string,
  accountId: string,
  oauth?: ResolveCredentialOAuth,
): Promise<{ readonly accessToken: string; readonly refreshToken?: string }> {
  let account = await loadAccountWithFreshness(db, accountId);
  if (!account) {
    throw new GatewayError("admission_unavailable", 503, "This provider account no longer exists, so its credential cannot be read. Re-select the account, or point the route at a live one.", {
      provider_id: providerId,
      account_id: accountId,
    });
  }

  if (
    account.row.credentialKind === "oauth" &&
    oauth &&
    account.dueAt !== undefined &&
    account.dueAt <= Date.now()
  ) {
    const refresher = await oauth.resolveRefresher(account.row.providerId);
    if (refresher) {
      await oauth.refreshService.ensureFreshAccessToken(accountId, refresher);
      account = await loadAccountWithFreshness(db, accountId);
      if (!account) {
        throw new GatewayError("admission_unavailable", 503, "This provider account no longer exists, so its credential cannot be read (request {requestId}). Re-select the account, or point the route at a live one. The account went cold — reconnect or resend 🔌", {
          provider_id: providerId,
          account_id: accountId,
        });
      }
    }
  }

  const accessToken = account.row.credentialCiphertext
    ? decryptCredentialToString(account.row.credentialCiphertext)
    : "";
  const refreshToken = account.row.refreshCiphertext
    ? decryptCredentialToString(account.row.refreshCiphertext)
    : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}

/** Binds token decryption and refresh behavior for the provider-account export route. */
export function createAccountExportCredentialsResolver(deps: {
  readonly db: CartethyiaDatabase;
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
}): (
  providerId: string,
  accountId: string,
) => Promise<{ readonly accessToken: string; readonly refreshToken?: string }> {
  return (providerId, accountId) =>
    resolveAccountCredentialsForExport(deps.db, providerId, accountId, {
      resolveRefresher: deps.resolveRefresher,
      refreshService: deps.refreshService,
    });
}

/**
 * Binds refresh-aware credential resolution for quota routes and the background
 * quota sweep, avoiding a stale-token fallback when OAuth refresh is due.
 */
export function createAccountSecretResolver(deps: {
  readonly db: CartethyiaDatabase;
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
}): (providerId: string, accountId: string) => Promise<string> {
  return (providerId, accountId) =>
    resolveAccountSecretString(deps.db, providerId, accountId, {
      resolveRefresher: deps.resolveRefresher,
      refreshService: deps.refreshService,
    });
}
