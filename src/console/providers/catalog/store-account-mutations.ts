/**
 * Account credential writes for the catalog store: label generation, single
 * and batch create, update, and reorder. These are the account write module of
 * the account reads live in `store-account-queries.ts`. Every function takes
 * the shared `StoreAccountContext` the owning `DrizzleProviderCatalogStore`
 * builds.
 */
import { and, eq } from "drizzle-orm";
import { globalOrOwnedBy } from "../../../persistence/tenant-scope";
import { nextSortIndex, reorderSortIndex } from "../../../persistence/sort-order";
import { providerAccounts, providerOauthStates } from "../../../persistence/schema";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import { invalidateCredentialCache } from "../../../providers/operations/provider-credential-service";
import { isUniqueViolation } from "../../../persistence/boot";
import { ConsoleDomainError } from "../../shared/errors";
import { pushStructuredConsoleLog } from "../../../observability/log-ring";
import type {
  CreateProviderAccountBatchItemResult,
  CreateProviderAccountBatchResult,
  CreateProviderAccountRequest,
  CredentialMode,
  ProviderAccountResponse,
  UpdateProviderAccountRequest,
} from "./contracts";
import type { DbOrTx, DbTx, StoreAccountContext } from "./store-contexts";
import {
  emptyUsage,
  mapAccountRow,
  nextGeneratedAccountLabel,
  parseJwtCredential,
  parsePastedOAuthCredential,
} from "./store-helpers";
import { accountsWithUsage } from "./store-account-queries";
import { pickDefined } from "../../shared/object";

/**
 * Labels already in use for one provider, for numbering a generated name.
 *
 * Scoped to this provider and tenant: `dcint-key-1` and `other-key-1` belong
 * to different providers and must not collide with each other.
 *
 * `labelCache` lets a batch create share one read across its items: inside
 * the batch transaction every insert is visible to the next item's select,
 * so the first read already sees the labels the batch itself wrote — the
 * cache only saves the repeated scan, never changes the answer. Keyed by
 * `providerId` because one batch is one provider/tenant pair.
 */
async function generateAccountLabel(
  db: DbOrTx,
  providerId: string,
  tenantId: string,
  credentialMode: CredentialMode,
  labelCache?: Map<string, readonly string[]>,
): Promise<string> {
  let labels = labelCache?.get(providerId);
  if (labels === undefined) {
    const rows = await db
      .select({ label: providerAccounts.label })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      );
    labels = rows
      .map((row) => row.label)
      .filter((label): label is string => typeof label === "string");
    labelCache?.set(providerId, labels);
  }
  return nextGeneratedAccountLabel(providerId, credentialMode, labels);
}

/**
 * Next free list position for a new account in this provider's list.
 *
 * Scoped to (provider, tenant) because the list is per provider: a tenant
 * with accounts under two providers must not have the second provider's
 * first account land at a high index.
 */
async function nextAccountSortIndex(
  db: DbOrTx,
  providerId: string,
  tenantId: string,
): Promise<number> {
  return nextSortIndex(
    db,
    { table: providerAccounts, idColumn: providerAccounts.id, sortIndexColumn: providerAccounts.sortIndex },
    and(
      eq(providerAccounts.providerId, providerId),
      globalOrOwnedBy(providerAccounts.tenantId, tenantId),
    ),
  );
}

/** Rewrites one provider's account order; `accountIds` is the full order. */
export async function reorderAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountIds: readonly string[],
): Promise<void> {
  await reorderSortIndex(
    ctx.db,
    { table: providerAccounts, idColumn: providerAccounts.id, sortIndexColumn: providerAccounts.sortIndex },
    and(
      eq(providerAccounts.providerId, providerId),
      globalOrOwnedBy(providerAccounts.tenantId, tenantId),
    ),
    accountIds,
  );
}

export async function createAccountRow(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  request: CreateProviderAccountRequest,
  existingTx?: DbTx,
  includeUsage = true,
  sortIndexOverride?: number,
  /**
   * Batch-scoped label cache, threaded from `createAccountBatch`. Only the
   * batch path passes it; a lone create always reads fresh labels.
   */
  labelCache?: Map<string, readonly string[]>,
  ): Promise<ProviderAccountResponse> {
    // The kind and the secret must agree: a credential-requiring kind with no
    // secret would persist an account that dispatches an empty credential, and
    // a `none` account with one would silently send it. A credential-less
    // (`none`) account is the "Public Key" row a no-key custom provider
    // registers — no secret, and the adapter reads `none` and sends no auth
    // header.
    const secretTrimmed = request.secret?.trim() ?? "";
    if (request.credentialKind === "none" && secretTrimmed.length > 0) {
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        "A credential-less (none) account must not carry a secret",
      );
    }
    if (
      (request.credentialKind === "api_key" || request.credentialKind === "oauth") &&
      secretTrimmed.length === 0
    ) {
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        `credentialKind ${request.credentialKind} requires a secret`,
      );
    }
    // Callers inside an existing transaction pass it in so the account lands in
    // that unit of work (the batch path); otherwise this opens its own.
    const run = async (
      tx: DbTx,
  ): Promise<ProviderAccountResponse> => {
    let effectiveSecret = secretTrimmed;
    let effectiveCredentialKind = request.credentialKind;
    const requestedCredentialMode: CredentialMode = request.credentialMode ?? "auto";
    let effectiveCredentialMode: CredentialMode = requestedCredentialMode;
    let tokenExpiresAt: Date | undefined;
    let jwtIssuer: string | undefined;
    let oauthRefreshCiphertext: Buffer | undefined;
    let oauthExpiresAt: Date | undefined;
    let oauthHasRefreshToken = false;
    let pastedAuthState: Readonly<Record<string, unknown>> = {};

    if (
      (request.credentialKind === "oauth" || request.credentialKind === "api_key") &&
      secretTrimmed.length > 0
    ) {
      const trimmed = secretTrimmed;
      const parts = parsePastedOAuthCredential(trimmed);
      pastedAuthState = parts.authState;
      const hasRefreshToken = parts.refreshToken !== parts.accessToken;
      const parsedJwt =
        requestedCredentialMode === "api_key"
          ? undefined
          : parseJwtCredential(parts.accessToken);
      if (requestedCredentialMode === "jwt" && parsedJwt === undefined) {
        throw new ConsoleDomainError(
          "invalid_request",
          400,
          "credentialMode jwt requires a valid three-part JWT",
        );
      }
      if (requestedCredentialMode === "api_key") {
        effectiveSecret = parts.accessToken;
        effectiveCredentialKind = "api_key";
        effectiveCredentialMode = "api_key";
      } else if (
        parsedJwt !== undefined &&
        (requestedCredentialMode === "jwt" || !hasRefreshToken)
      ) {
        effectiveSecret = parts.accessToken;
        effectiveCredentialKind = "api_key";
        effectiveCredentialMode = "jwt";
        tokenExpiresAt = parsedJwt.expiresAt;
        // Kept alongside the expiry: the console shows who issued a static
        // token, and the secret itself is never readable after this point.
        jwtIssuer = parsedJwt.issuer;
      } else if (request.credentialKind === "oauth" || hasRefreshToken) {
        effectiveSecret = parts.accessToken;
        effectiveCredentialKind = hasRefreshToken ? "oauth" : "api_key";
        effectiveCredentialMode = hasRefreshToken ? "auto" : "api_key";
        if (hasRefreshToken) {
          oauthRefreshCiphertext = encryptCredential(parts.refreshToken);
          oauthHasRefreshToken = true;
        }
        oauthExpiresAt = parts.expiresAt;
      } else {
        effectiveCredentialMode = "api_key";
      }
    }

    // Append to the end of this provider's list rather than relying on
    // creation time, so a new account never displaces existing positions.
    const credentialFingerprint =
      effectiveCredentialKind === "none" || effectiveSecret.length === 0
        ? undefined
        : hashSecret(effectiveSecret);
    const accountAuthState = {
      ...pastedAuthState,
      ...(request.authState ?? {}),
      credentialMode: effectiveCredentialMode,
      ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt: tokenExpiresAt.toISOString() }),
      ...pickDefined({ jwtIssuer }),
    };
    const nextSortIndex =
      sortIndexOverride ?? (await nextAccountSortIndex(tx, providerId, tenantId));
    // Read existing labels only when one has to be generated: a named
    // account costs no extra query, and this is the path a large batch
    // paste walks once per row.
    const label =
      request.label ??
      (await generateAccountLabel(tx, providerId, tenantId, effectiveCredentialMode, labelCache));
    const rows = await tx
      .insert(providerAccounts)
      .values({
        providerId,
        tenantId,
        sortIndex: nextSortIndex,
        label,
        // A credential-less account carries no ciphertext — the adapter reads
        // the `none` kind and sends no auth header. `encryptCredential("")`
        // would store a real ciphertext for an empty secret and read as "a
        // secret exists" to anything that only checks the column.
        credentialCiphertext:
          effectiveCredentialKind === "none" ? null : encryptCredential(effectiveSecret),
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
        credentialKind: effectiveCredentialKind,
        status: "active",
        authState: accountAuthState,
        // An OAuth account pasted without a refresh token is a *static*
        // token: the pasted value is a bearer token used exactly as issued
        // and there is no refresh grant to run. Flag it as static so the
        // console reads it as an informational "static token" rather than
        // "re-login required" — the token is still valid and dispatchable —
        // and so the refresh sweep skips it instead of retrying a refresh
        // that can never succeed.
        ...(effectiveCredentialKind === "oauth" && !oauthHasRefreshToken || effectiveCredentialMode === "jwt"
          ? { staticToken: true }
          : {}),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("failed to create provider account");

    if (effectiveCredentialKind === "oauth") {
      await tx.insert(providerOauthStates).values({
        providerAccountId: row.id,
        ...(oauthRefreshCiphertext ? { refreshCiphertext: oauthRefreshCiphertext } : {}),
        expiresAt: oauthExpiresAt ?? null,
      });
    }
    if (request.credentialKind === "oauth" && !oauthHasRefreshToken) {
      pushStructuredConsoleLog(
        "info",
        "OAuth access token stored as a static API credential; it will not be refreshed",
        {
          event: "token_refresh",
          providerId,
          accountId: row.id,
          errorCode: "static_token",
        },
      );
    }

    if (!includeUsage) {
      return mapAccountRow(row, { today: emptyUsage, allTime: emptyUsage });
    }
    const [account] = await accountsWithUsage(ctx, tenantId, [row]);
    if (!account) throw new Error("created provider account could not be mapped");
    return account;
  };

  try {
    if (existingTx !== undefined) {
      return await run(existingTx);
    }
    return await ctx.db.transaction(run);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleDomainError(
        "provider_account_duplicate",
        409,
        "A provider account with this credential already exists",
      );
    }
    throw error;
  }
}

/**
 * Creates many accounts in one round-trip.
 *
 * The whole batch shares one transaction, so a paste of 40 credentials costs
 * one connection checkout rather than 40. Each item is created through the
 * same `createAccount` path the single route uses — there is no second
 * implementation of credential detection to drift.
 *
 * Items are created sequentially inside that transaction: the unique
 * credential fingerprint makes two identical pastes collide, and a nested
 * transaction per item keeps that collision from aborting the whole batch.
 * Outcomes are reported per index, so a partial paste still lands the
 * accounts that were fine — an operator fixing one bad line should not have
 * to re-import 39.
 */
export async function createAccountBatch(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  requests: readonly CreateProviderAccountRequest[],
): Promise<CreateProviderAccountBatchResult> {
  if (requests.length === 0) {
    return { created: 0, failed: 0, results: [] };
  }
  const results: CreateProviderAccountBatchItemResult[] = [];
  let created = 0;
  let failed = 0;

  await ctx.db.transaction(async (tx) => {
    let nextSortIndex = await nextAccountSortIndex(tx, providerId, tenantId);
    // One label read for the whole batch: the first generated label scans
    // the provider's labels once, and every later item reuses that list —
    // inside the transaction the batch's own inserts are visible to the
    // scan anyway, so the cached list is exactly what a fresh read returns.
    const labelCache = new Map<string, readonly string[]>();
    for (const [index, request] of requests.entries()) {
      try {
        // A nested transaction acts as a savepoint: a duplicate-fingerprint
        // violation rolls back only this item, not the accounts before it.
        const account = await tx.transaction(async (inner) =>
          createAccountRow(ctx, tenantId, providerId, request, inner, false, nextSortIndex, labelCache),
        );
        created += 1;
        nextSortIndex += 1;
        results.push({ index, ok: true, ...(account ? { account } : {}) });
      } catch (error) {
        failed += 1;
        results.push({
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof ConsoleDomainError ? error.code : "create_failed",
        });
      }
    }
  });

  return { created, failed, results };
}

export async function updateAccountRow(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountId: string,
  patch: UpdateProviderAccountRequest,
): Promise<ProviderAccountResponse | undefined> {
  const set: Partial<typeof providerAccounts.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.secret !== undefined) {
    set.credentialCiphertext = encryptCredential(patch.secret);
    set.credentialFingerprint =
      patch.secret.length === 0 ? null : hashSecret(patch.secret);
  }
  if (patch.status !== undefined) set.status = patch.status;
  // Toggling the static-token flag: turning it on declares the credential is
  // used as issued and never refreshed, so any stale re-auth flag is cleared —
  // the operator has said the account is fine, and the pill must stop reading
  // "Re-login required". Turning it off returns the account to normal OAuth
  // refresh handling; the sweep picks it up again on its next pass.
  if (patch.staticToken !== undefined) {
    set.staticToken = patch.staticToken;
    if (patch.staticToken) {
      set.lastError = null;
      set.lastErrorCategory = null;
      set.lastErrorAt = null;
    }
  }
  // Status toggles are not recovery: preserve the health machine's evidence
  // until the operator uses Recover or replaces the rejected credential.
  const clearsFailureState = patch.secret !== undefined && patch.secret.length > 0;
  if (clearsFailureState) {
    set.consecutiveFailures = 0;
    set.cooldownUntil = null;
    set.modelCooldowns = {};
    set.lastError = null;
    set.lastErrorCategory = null;
    set.lastErrorAt = null;
  }
  const where = and(
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.providerId, providerId),
    globalOrOwnedBy(providerAccounts.tenantId, tenantId),
  );
  try {
    const rows =
      Object.keys(set).length > 0
        ? await ctx.db.update(providerAccounts).set(set).where(where).returning()
        : await ctx.db.select().from(providerAccounts).where(where);
    const row = rows[0];
    if (!row) return undefined;
    // Secret/status mutation: drop any cached credential so the next
    // attempt decrypts the new ciphertext (or refuses a disabled account).
    if (patch.secret !== undefined || patch.status !== undefined) {
      invalidateCredentialCache(accountId);
    }
    const [account] = await accountsWithUsage(ctx, tenantId, [row]);
    return account;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleDomainError(
        "provider_account_duplicate",
        409,
        "A provider account with this credential already exists",
      );
    }
    throw error;
  }
}
