/**
 * `refreshAccountStatus` — the explicit "refresh token" affordance (area 04).
 *
 * The invariant under test: a refresh is not a health verdict. Non-OAuth
 * accounts are rejected, static tokens are rejected, and a `disabled` account
 * is allowed to refresh its token but ALWAYS reports `statusAfter: "disabled"`
 * — the status is re-read from the DB and never flips.
 */
import { beforeAll, afterAll, expect, test } from "bun:test";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import { getDb } from "../../src/persistence/boot";
import { providerAccounts, providerOauthStates } from "../../src/persistence/schema";
import { eq } from "drizzle-orm";
import { encryptCredential } from "../../src/security/crypto";
import { refreshAccountStatus } from "../../src/providers/operations/account-refresh-status";
import {
  OAuthRefreshService,
  type OAuthTokenRefresher,
} from "../../src/providers/authentication/oauth-refresh-service";

/** A refresher that succeeds and mints a fresh token. */
function healthyRefresher(): OAuthTokenRefresher {
  return {
    refresh: async () => ({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
}

dbDescribe("refreshAccountStatus", () => {
  let world: GatewayWorld;
  let cachedDb: ReturnType<typeof getDb> | undefined;
  const db = (): ReturnType<typeof getDb> => {
    cachedDb ??= getDb();
    return cachedDb;
  };

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  async function oauthAccount(options: {
    status?: "active" | "disabled";
    refreshToken?: string | null;
    expiresAt?: Date | null;
  } = {}): Promise<string> {
    // The identity unique index is (provider, tenant, credential_fingerprint):
    // each case in this suite needs its own credential or the second insert
    // collides with the first.
    const accountId = await world.addAccount({
      credentialKind: "oauth",
      status: options.status ?? "active",
      credential: `access-token-${crypto.randomUUID()}`,
    });
    await db().insert(providerOauthStates).values({
      providerAccountId: accountId,
      refreshCiphertext:
        options.refreshToken === null || options.refreshToken === undefined
          ? null
          : encryptCredential(options.refreshToken),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
    });
    return accountId;
  }

  async function readStatus(accountId: string): Promise<string> {
    const [row] = await db()
      .select({ status: providerAccounts.status })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    if (!row) throw new Error("account vanished");
    return row.status;
  }

  function deps() {
    const service = new OAuthRefreshService(db());
    return {
      db: db(),
      refreshService: service,
      resolveRefresher: async () => healthyRefresher(),
    };
  }

  test("rejects a non-OAuth account with a structured outcome", async () => {
    const accountId = await world.addAccount({ credentialKind: "api_key", credential: `api-key-${crypto.randomUUID()}` });
    const outcome = await refreshAccountStatus(deps(), accountId);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("not_oauth");
    expect(outcome.error).toBe("not_oauth");
    expect(outcome.statusAfter).toBe("active");
    expect(await readStatus(accountId)).toBe("active");
  });

  test("rejects a static token with a structured outcome", async () => {
    const accountId = await oauthAccount({ status: "disabled", refreshToken: "rt" });
    await db()
      .update(providerAccounts)
      .set({ staticToken: true })
      .where(eq(providerAccounts.id, accountId));
    const outcome = await refreshAccountStatus(deps(), accountId);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("static_token");
    expect(outcome.statusAfter).toBe("disabled");
    expect(await readStatus(accountId)).toBe("disabled");
  });

  test("rejects an OAuth account with no refresh grant (static-by-absence)", async () => {
    const accountId = await oauthAccount({ status: "disabled", refreshToken: null });
    const outcome = await refreshAccountStatus(deps(), accountId);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("static_token");
    expect(outcome.statusAfter).toBe("disabled");
  });

  test("allows refresh for a disabled account and reports statusAfter disabled", async () => {
    const accountId = await oauthAccount({ status: "disabled", refreshToken: "rt" });
    const outcome = await refreshAccountStatus(deps(), accountId);
    expect(outcome.ok).toBe(true);
    expect(outcome.tokenRefreshed).toBe(true);
    expect(outcome.statusAfter).toBe("disabled");
    expect(outcome.refreshedAt).toBeDefined();
    // The status visibly never changed.
    expect(await readStatus(accountId)).toBe("disabled");
  });

  test("a refresh never flips the status of an active account", async () => {
    const accountId = await oauthAccount({ status: "active", refreshToken: "rt" });
    const outcome = await refreshAccountStatus(deps(), accountId);
    expect(outcome.ok).toBe(true);
    expect(outcome.statusAfter).toBe("active");
    expect(await readStatus(accountId)).toBe("active");
  });

  test("a missing account yields an account_missing outcome", async () => {
    const ghost = "00000000-0000-0000-0000-000000000000";
    const outcome = await refreshAccountStatus(deps(), ghost);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("account_missing");
  });

  test("a failing refresher yields a structured refresh_failed outcome without status change", async () => {
    const accountId = await oauthAccount({ status: "disabled", refreshToken: "rt" });
    const service = new OAuthRefreshService(db());
    const outcome = await refreshAccountStatus(
      {
        db: db(),
        refreshService: service,
        resolveRefresher: async () => ({
          refresh: () => Promise.reject(new Error("upstream gone")),
        }),
      },
      accountId,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("refresh_failed");
    expect(outcome.category).toBe("upstream gone");
    expect(outcome.statusAfter).toBe("disabled");
    expect(await readStatus(accountId)).toBe("disabled");
  });
});
