// OAuth account persistence: identity fingerprinting and the Drizzle-backed
// account store behind the console OAuth login domain.

import { providerAccounts, providerOauthStates } from "../../../persistence/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { OAuthExchangeResult } from "../../../providers/authentication/oauth-flow-store";
import { oauthAccountIdentity } from "../../../providers/authentication/oauth-flow-store";
import { nextFreeLabel } from "../catalog/store-helpers";
import { isUniqueViolation } from "../../../persistence/boot";
import { ConsoleDomainError } from "../../shared/errors";
import { pickDefined } from "../../shared/object";

/**
 * The identity a repeated OAuth login is matched on.
 *
 * The refresh token cannot be that identity: a fresh login mints a new one, so
 * keying on it let the same account be added twice — the duplicate unique index
 * only caught a replay of the *exact* credential. The label is the account
 * identity the provider itself reports (an email or org name), which is stable
 * across logins, so it is what a re-login replaces.
 *
 * A label the provider never resolved is *not* that identity. Callers fill the
 * gap with the provider id (e.g. `github`), and hashing that made every
 * login of every account of that provider collide: the second login matched the
 * first row and replaced it, so adding an account silently consumed the one
 * already there. Only a label the provider actually reported — or the refresh
 * token, which still catches an exact replay — may be the identity.
 *
 * Test seam: exported so the merge rule can be pinned without a database.
 */
export function oauthIdentityFingerprint(input: {
  readonly label: string;
  readonly providerId: string;
} & OAuthExchangeResult): string {
  const identity = input.accountEmail?.trim() ?? input.accountName?.trim();
  if (identity !== undefined && identity.length > 0) return hashSecret(identity);
  const label = input.label.trim();
  const resolved =
    label.length > 0 &&
    label.toLowerCase() !== input.providerId.trim().toLowerCase() &&
    !isGeneratedOAuthLabel(label, input.providerId);
  return hashSecret(resolved ? label : input.refresh);
}

/** First unused `<providerId>-N` label for an OAuth account with no upstream identity. */
export function nextGeneratedOAuthAccountLabel(
  providerId: string,
  existingLabels: readonly string[],
): string {
  return nextFreeLabel(`${providerId}-`, existingLabels);
}

/** Generated labels are display-only and must never become re-login identity. */
export function isGeneratedOAuthLabel(label: string, providerId: string): boolean {
  const value = label.trim().toLowerCase();
  const prefix = `${providerId.trim().toLowerCase()}-`;
  return value === providerId.trim().toLowerCase() || (value.startsWith(prefix) && /^\d+$/.test(value.slice(prefix.length)));
}

/** Merges provider-reported identity with the operator label without inventing data. */
function resolvedOAuthIdentity(
  input: { readonly label: string } & OAuthExchangeResult,
  providerId: string,
): { readonly label: string; readonly accountEmail?: string; readonly accountName?: string } {
  const tokenIdentity = oauthAccountIdentity(input);
  const accountEmail = input.accountEmail?.trim() ?? tokenIdentity.accountEmail;
  const accountName = input.accountName?.trim() ?? tokenIdentity.accountName;
  const existing = input.label.trim();
  const unresolved = existing.length === 0 || isGeneratedOAuthLabel(existing, providerId);
  const label = unresolved ? (accountEmail ?? accountName ?? existing) : existing;
  return {
    label,
    ...pickDefined({ accountEmail }),
    ...pickDefined({ accountName }),
  };
}

/**
 * Console OAuth login domain: authorize-URL initiation, callback exchange,
 * and device-code start/poll — driven by whichever `OAuthLoginClient` is
 * registered for a given provider id.
 *
 * The redirect URIs these clients advertise are loopback (`localhost:1455`,
 * `127.0.0.1:54549`, …), which name the machine the *operator's browser* is on
 * — not this process. Advertising one without binding the port leaves the code
 * in the browser's address bar, so every browser login needs the redirect
 * pasted back by hand. The gateway is a server process, but it is not *the*
 * server the redirect arrives at; `callback-listener.ts` is what makes those
 * the same endpoint.
 */
interface PersistedOAuthAccount {
  readonly accountId: string;
}

export interface OAuthAccountStore {
  persistAccount(
    tenantId: string | null,
    providerId: string,
    input: { readonly label: string } & OAuthExchangeResult,
  ): Promise<PersistedOAuthAccount>;
}

export class DrizzleOAuthAccountStore implements OAuthAccountStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async persistAccount(
    tenantId: string | null,
    providerId: string,
    input: { readonly label: string } & OAuthExchangeResult,
  ): Promise<PersistedOAuthAccount> {
    const identity = resolvedOAuthIdentity(input, providerId);
    const credentialFingerprint = oauthIdentityFingerprint({ ...input, ...identity, providerId });
    const sameAccount = and(
      eq(providerAccounts.providerId, providerId),
      // The identity index coalesces a null tenant to a sentinel, so "same
      // tenant" here means both null or both equal.
      tenantId === null
        ? isNull(providerAccounts.tenantId)
        : eq(providerAccounts.tenantId, tenantId),
      eq(providerAccounts.credentialFingerprint, credentialFingerprint),
    );
    const credentialCiphertext = encryptCredential(input.access);
    const refreshCiphertext = encryptCredential(input.refresh);
    const clientSecretCiphertext =
      input.client_secret === undefined ? undefined : encryptCredential(input.client_secret);
    const identityColumns = {
      ...(input.auth_state === undefined && identity.accountName === undefined
        ? {}
        : {
          authState: {
            ...(input.auth_state ?? {}),
            ...pickDefined({ accountName: identity.accountName }),
          },
        }),
      ...pickDefined({ accountEmail: identity.accountEmail }),
      ...(identity.accountEmail !== undefined || identity.accountName !== undefined
        ? { identityCheckedAt: new Date() }
        : {}),
    };
    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: providerAccounts.id })
          .from(providerAccounts)
          .where(sameAccount)
          .limit(1);
        const existingId = existing[0]?.id;
        const label = isGeneratedOAuthLabel(input.label, providerId) ? identity.label : input.label;
        if (existingId !== undefined) {
          // A re-login replaces the account it belongs to rather than adding a
          // second row: the same email is the same account, and the newer
          // tokens are the ones that work. The health state is reset with them,
          // because a fresh credential makes the old rejection — the
          // `Disabled` / `Re-login required` row an operator was looking at —
          // meaningless by definition.
          await tx
            .update(providerAccounts)
            .set({
              // A re-login carries a freshly validated identity, so it adopts
              // the learned label — but never over an operator's custom rename.
              // The CASE keeps the read and the write in one statement, so a
              // concurrent rename cannot lose to the login.
              label: sql`CASE WHEN lower(trim(${providerAccounts.label})) = lower(trim(${providerAccounts.providerId})) OR lower(trim(${providerAccounts.label})) = lower(trim(${label})) THEN ${label} ELSE ${providerAccounts.label} END`,
              credentialCiphertext,
              credentialKind: input.credentialKind ?? "oauth",
              status: "active",
              consecutiveFailures: 0,
              cooldownUntil: null,
              modelCooldowns: {},
              lastError: null,
              lastErrorCategory: null,
              lastErrorAt: null,
              lastRecoveredAt: null,
              // A fresh login supplies a refresh token, so the account returns
              // to normal OAuth refresh handling and is not a static token.
              staticToken: false,
              // Only what this login reported: a flow that learned no profile or
              // region leaves the stored configuration alone rather than blanking it.
              ...identityColumns,
            })
            .where(eq(providerAccounts.id, existingId));
          await tx
            .update(providerOauthStates)
            .set({
              refreshCiphertext,
              expiresAt: input.expiresAt,
              ...pickDefined({ clientSecretCiphertext }),
            })
            .where(eq(providerOauthStates.providerAccountId, existingId));
          return { accountId: existingId };
        }
        const existingLabels = await tx
          .select({ label: providerAccounts.label })
          .from(providerAccounts)
          .where(
            and(
              eq(providerAccounts.providerId, providerId),
              tenantId === null
                ? isNull(providerAccounts.tenantId)
                : eq(providerAccounts.tenantId, tenantId),
            ),
          );
        const generatedLabel = isGeneratedOAuthLabel(label, providerId)
          ? nextGeneratedOAuthAccountLabel(
              providerId,
              existingLabels.map((row) => row.label).filter((value): value is string => typeof value === "string"),
            )
          : label;
        const rows = await tx
          .insert(providerAccounts)
          .values({
            providerId,
            tenantId,
            label: generatedLabel,
            credentialKind: input.credentialKind ?? "oauth",
            credentialCiphertext,
            credentialFingerprint,
            status: "active",
            ...identityColumns,
          })
          .returning({ id: providerAccounts.id });
        const row = rows[0];
        if (!row) throw new Error("failed to persist OAuth account");
        await tx.insert(providerOauthStates).values({
          providerAccountId: row.id,
          refreshCiphertext,
          expiresAt: input.expiresAt,
          ...pickDefined({ clientSecretCiphertext }),
        });
        return { accountId: row.id };
      });
    } catch (error) {
      // Still reachable: two logins for the same identity racing each other
      // both read "no row" and both insert, and the identity index rejects the
      // second. A retry by the operator replaces rather than duplicates.
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
}
