/**
 * Manual account-status observation: refresh an OAuth token on demand and
 * report the account's status AFTER the attempt — never assume it.
 *
 * Area 04 (D21–D26): a refresh is not a health verdict. This module is the
 * explicit "refresh token" affordance for accounts the OAuth sweep excludes
 * (`disabled`), and it is where the invariant nobody else had to is held:
 * `statusAfter` is always re-read from the database, so no caller can ever
 * report `"active"` just because a refresh succeeded.
 */
import { randomUUID } from "node:crypto";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { healthEvents } from "../../persistence/schema";
import { pushStructuredConsoleLog } from "../../observability/log-ring";
import { loadAccountWithOauthState } from "./provider-credential-service";
import type { OAuthRefreshService, OAuthTokenRefresher } from "../authentication/oauth-refresh-service";

export type RefreshAccountStatusCode =
  | "ok"
  | "account_missing"
  | "not_oauth"
  | "static_token"
  | "no_refresher"
  | "auth_invalidated"
  | "refresh_failed";

export interface RefreshAccountStatusOutcome {
  readonly ok: boolean;
  readonly tokenRefreshed: boolean;
  /**
   * Account status re-read from the DB after the attempt. Never assumed from
   * the input row and never `"active"` by fiat — a refresh cannot re-enable.
   */
  readonly statusAfter: string;
  readonly code: RefreshAccountStatusCode;
  /** IS0 timestamp of the fresh access-token expiry, when known. */
  readonly expiresAt?: string;
  /** ISO timestamp of the attempt, when it happened. */
  readonly refreshedAt?: string;
  /** Structured reason when `ok` is false (`not_oauth`, `static_token`, …). */
  readonly error?: string;
  /** Human detail (failure message) when available. */
  readonly category?: string;
}

export interface RefreshAccountStatusDeps {
  readonly db: CartethyiaDatabase;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
}

interface LoadedAccount {
  readonly id: string;
  readonly providerId: string;
  readonly credentialKind: string;
  readonly status: string;
  readonly staticToken: boolean;
  readonly lastErrorCategory: string | null;
  readonly refreshCiphertext: Buffer | null;
  readonly expiresAt: Date | null;
}

async function loadAccount(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<LoadedAccount | undefined> {
  const loaded = await loadAccountWithOauthState(db, accountId, {
    includeStatus: true,
    includeLastErrorCategory: true,
    includeExpiry: true,
  });
  if (!loaded || loaded.status === undefined || loaded.expiresAt === undefined) return undefined;
  return {
    id: loaded.id,
    providerId: loaded.providerId,
    credentialKind: loaded.credentialKind,
    status: loaded.status,
    staticToken: loaded.staticToken,
    lastErrorCategory: loaded.lastErrorCategory ?? null,
    refreshCiphertext: loaded.refreshCiphertext,
    expiresAt: loaded.expiresAt,
  };
}

async function readStatusAfter(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<{ status: string; expiresAt: Date | null } | undefined> {
  const loaded = await loadAccountWithOauthState(db, accountId, {
    includeStatus: true,
    includeExpiry: true,
  });
  if (!loaded || loaded.status === undefined || loaded.expiresAt === undefined) return undefined;
  return { status: loaded.status, expiresAt: loaded.expiresAt };
}

/** Non-mutating health event: records the attempt, never changes status. */
async function writeRefreshHealthEvent(
  db: CartethyiaDatabase,
  accountId: string,
  fromStatus: string,
  toStatus: string,
  reason: string,
): Promise<void> {
  if (typeof db.insert !== "function") return;
  await db.insert(healthEvents).values({
    id: randomUUID(),
    entityKind: "account",
    accountId,
    fromStatus: fromStatus as "active" | "cooldown" | "disabled" | null,
    toStatus: toStatus as "active" | "cooldown" | "disabled",
    reason,
    errorCategory: null,
    createdAt: new Date(),
  });
}

/**
 * Refreshes an OAuth account's token on demand and reports the resulting
 * status. Works for any status, `disabled` included — the account stays
 * `disabled`; only an operator can re-enable it.
 *
 * Rejections are structured (`{ ok: false, code: "not_oauth" | "static_token" |
 * ... }`), and every outcome carries `statusAfter` re-read from the DB.
 */
export async function refreshAccountStatus(
  deps: RefreshAccountStatusDeps,
  accountId: string,
  opts: { readonly origin?: "ui" | "sweep" | "dispatch" } = {},
): Promise<RefreshAccountStatusOutcome> {
  const origin = opts.origin ?? "ui";
  const account = await loadAccount(deps.db, accountId);
  if (!account) {
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter: "disabled",
      code: "account_missing",
      error: "Account not found",
    };
  }
  const statusBefore = account.status;

  if (account.status === "disabled" && account.lastErrorCategory === "auth_invalidated") {
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter: statusBefore,
      code: "auth_invalidated",
      error: "auth_invalidated",
      category: "This account was rejected by the provider and requires re-authentication; automatic refresh is disabled.",
    };
  }
  if (account.credentialKind !== "oauth") {
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter: statusBefore,
      code: "not_oauth",
      error: "not_oauth",
    };
  }
  if (account.staticToken || account.refreshCiphertext == null) {
    // No refresh grant (or an explicit static marker): there is nothing to
    // re-mint, and forcing the service to try would mutate the row into a
    // static token. Refuse instead of changing the account.
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter: statusBefore,
      code: "static_token",
      error: "static_token",
      ...(account.refreshCiphertext == null && !account.staticToken
        ? { category: "No refresh token on record" }
        : {}),
    };
  }

  const refresher = await deps.resolveRefresher(account.providerId);
  if (!refresher) {
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter: statusBefore,
      code: "no_refresher",
      error: "no_refresher",
    };
  }

  // `ensureFreshAccessToken` deliberately swallows a failing refresher and
  // returns null (it must not break a dispatch). For this explicit affordance
  // the operator needs the reason, so keep the last failure message here
  // rather than generalizing it — same "message as-is" rule as area 08.
  let refreshFailureMessage: string | undefined;
  const reportingRefresher: OAuthTokenRefresher = {
    refresh: async (...args) => {
      try {
        return await refresher.refresh(...args);
      } catch (error) {
        refreshFailureMessage = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  };

  const startedAt = new Date();
  try {
    const refreshed = await deps.refreshService.ensureFreshAccessToken(accountId, reportingRefresher, {
      force: true,
      origin,
    });
    // D25: status is always re-read after the attempt — never assumed.
    const after = await readStatusAfter(deps.db, accountId);
    const statusAfter = after?.status ?? statusBefore;
    if (refreshed !== null) {
      pushStructuredConsoleLog("info", "OAuth token refreshed", {
        event: "token_refresh",
        accountId,
        providerId: account.providerId,
        details: {
          origin,
          statusBefore,
          statusAfter,
          expiresAt: after?.expiresAt?.toISOString() ?? "",
        },
      });
      await writeRefreshHealthEvent(
        deps.db,
        accountId,
        statusBefore,
        statusAfter,
        "Token refreshed — status unchanged",
      );
      return {
        ok: true,
        tokenRefreshed: true,
        statusAfter,
        code: "ok",
        ...(after?.expiresAt ? { expiresAt: after.expiresAt.toISOString() } : {}),
        refreshedAt: startedAt.toISOString(),
      };
    }
    // `ensureFreshAccessToken` returned null: the refresh failed (transient
    // upstream error, lease loss) or the credential became static mid-flight.
    // Either way the account's own status is the truth, re-read above.
    pushStructuredConsoleLog("warn", "OAuth token refresh did not complete", {
      event: "token_refresh",
      accountId,
      providerId: account.providerId,
      errorCode: "refresh_failed",
      details: { origin, statusBefore, statusAfter },
    });
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter,
      code: "refresh_failed",
      error: "refresh_failed",
      ...(refreshFailureMessage
        ? { category: refreshFailureMessage.slice(0, 500) }
        : { category: "Token refresh did not complete" }),
    };
  } catch (error) {
    const after = await readStatusAfter(deps.db, accountId);
    const statusAfter = after?.status ?? statusBefore;
    const message = error instanceof Error ? error.message : String(error);
    pushStructuredConsoleLog("error", "OAuth token refresh failed", {
      event: "token_refresh",
      accountId,
      providerId: account.providerId,
      errorCode: "refresh_failed",
      details: { origin, statusBefore, statusAfter, error: message.slice(0, 500) },
    });
    return {
      ok: false,
      tokenRefreshed: false,
      statusAfter,
      code: "refresh_failed",
      error: "refresh_failed",
      category: message.slice(0, 500),
    };
  }
}
