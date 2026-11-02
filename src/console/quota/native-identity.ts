/**
 * Qoder native-identity console operations, shared by the tenant-scoped and
 * global-admin account route groups.
 *
 * The identity is the account's device identity (minted seed). The routes
 * surface it for export/import/regenerate from the provider-detail screen;
 * the device-uniqueness invariant lives in the store (and the partial unique
 * index behind it).
 */
import { and, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { providerAccounts, type NativeIdentityRecord } from "../../persistence/schema";
import {
  allocateQoderNativeIdentity,
  DrizzleQoderNativeIdentityStore,
  type QoderNativeIdentityStore,
} from "../../providers/integrations/qoder/qoder-native-identity-store";
import { ConsoleDomainError, requireGlobalAdmin, requireTenantScope } from "../shared/errors";
import type { ConsoleAccessResolver } from "../auth/access";

/** True when `token` looks like a plausible machine token. */
function isValidNativeIdentityToken(token: string): boolean {
  return typeof token === "string" && token.length >= 8 && token.length <= 512;
}

/**
 * Allocates a fresh device identity for regenerate. Injected so tests can stub
 * the native bridge; the default runs the real `runtime-info` bridge through
 * the store.
 */
export type NativeIdentityAllocator = (args: {
  providerId: string;
  accountId: string;
  avoidToken?: string;
}) => Promise<NativeIdentityRecord | null>;

function defaultAllocator(store: QoderNativeIdentityStore): NativeIdentityAllocator {
  return ({ providerId, accountId, avoidToken }) =>
    allocateQoderNativeIdentity(store, providerId, accountId, {
      ...(avoidToken !== undefined ? { avoidToken } : {}),
    });
}

/** Loads one account row, scoped by tenant (null = global/shared). */
async function loadAccount(
  db: CartethyiaDatabase,
  accountId: string,
  tenantId: string | null,
): Promise<{ providerId: string; nativeIdentity: NativeIdentityRecord | null } | undefined> {
  const rows = await db
    .select({
      providerId: providerAccounts.providerId,
      nativeIdentity: providerAccounts.nativeIdentity,
    })
    .from(providerAccounts)
    .where(
      tenantId === null
        ? and(eq(providerAccounts.id, accountId), isNull(providerAccounts.tenantId))
        : and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, tenantId)),
    )
    .limit(1);
  return rows[0];
}

export interface NativeIdentityOps {
  get(accountId: string, tenantId: string | null): Promise<NativeIdentityRecord | null>;
  put(accountId: string, tenantId: string | null, record: NativeIdentityRecord): Promise<NativeIdentityRecord>;
  regenerate(accountId: string, tenantId: string | null): Promise<NativeIdentityRecord | null>;
}

export function createNativeIdentityOps(
  db: CartethyiaDatabase,
  allocator: NativeIdentityAllocator = defaultAllocator(new DrizzleQoderNativeIdentityStore(db)),
): NativeIdentityOps {
  const store = new DrizzleQoderNativeIdentityStore(db);
  return {
    async get(accountId, tenantId) {
      const account = await loadAccount(db, accountId, tenantId);
      // A missing row under the narrowed tenant scope means the account is not
      // visible to this caller (cross-tenant read) — report not-found, the
      // same convention the account routes use, rather than echoing null.
      if (!account) throw new ConsoleDomainError("not_found", 404, "Account not found");
      return account.nativeIdentity;
    },
    async put(accountId, tenantId, record) {
      const account = await loadAccount(db, accountId, tenantId);
      if (!account) throw new ConsoleDomainError("not_found", 404, "Account not found");
      if (!isValidNativeIdentityToken(record.machineToken)) {
        throw new ConsoleDomainError("invalid_identity", 400, "machineToken must be a non-empty string (8–512 chars)");
      }
      if (!record.machineType || !record.machineCode) {
        throw new ConsoleDomainError("invalid_identity", 400, "machineToken, machineType, and machineCode are required");
      }
      // Device uniqueness: another account already owns this token? The pool is
      // global across Qoder accounts (both realms), matching the unique index.
      const occupied = await store.occupied(accountId);
      if (occupied.has(record.machineToken)) {
        throw new ConsoleDomainError("slot_taken", 409, `Native identity token is already bound to another account`);
      }
      await store.bind(account.providerId, accountId, record);
      return record;
    },
    async regenerate(accountId, tenantId) {
      const account = await loadAccount(db, accountId, tenantId);
      if (!account) throw new ConsoleDomainError("not_found", 404, "Account not found");
      return allocator({
        providerId: account.providerId,
        accountId,
        ...(account.nativeIdentity?.machineToken !== undefined ? { avoidToken: account.nativeIdentity.machineToken } : {}),
      });
    },
  };
}

/**
 * The authorization decision for one account's native-identity route.
 *
 * Account ownership decides which rule applies: shared accounts
 * (`tenant_id IS NULL`) need platform admin; tenant-owned accounts need the
 * tenant scope for the owning tenant.
 */
interface NativeIdentityScope {
  readonly tenantId: string | null;
}

/**
 * Registers the native-identity routes on `app` (path
 * `/provider-accounts/:id/native-identity`).
 *
 * `authorize` performs the access check based on the account's owner and
 * returns the tenant scope to load the row under, so a shared account is
 * reachable only by a platform admin and a tenant-owned account only by its
 * tenant.
 */
export function registerNativeIdentityRoutes(
  app: Elysia,
  deps: { readonly db: CartethyiaDatabase; readonly accessResolver: ConsoleAccessResolver },
  allocator?: NativeIdentityAllocator,
): void {
  const ops = createNativeIdentityOps(deps.db, allocator);
  const authorize = async (
    request: Request,
    accountId: string,
    scope: "dashboard:read" | "dashboard:write",
  ): Promise<NativeIdentityScope> => {
    const rows = await deps.db
      .select({ tenantId: providerAccounts.tenantId })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    if (rows.length === 0) {
      throw new ConsoleDomainError("not_found", 404, "Account not found");
    }
    const ownerTenantId = rows[0]!.tenantId;
    if (ownerTenantId === null) {
      requireGlobalAdmin(deps.accessResolver(request));
      return { tenantId: null };
    }
    const access = requireTenantScope(deps.accessResolver(request), scope);
    return { tenantId: access.tenantId };
  };
  app
    .get("/provider-accounts/:id/native-identity", async ({ request, params }) => {
      const { tenantId } = await authorize(request, params.id, "dashboard:read");
      return { identity: await ops.get(params.id, tenantId) };
    })
    .put(
      "/provider-accounts/:id/native-identity",
      {
        body: t.Object({
          machineToken: t.String(),
          machineType: t.String(),
          machineCode: t.String(),
          seed: t.Optional(t.String()),
        }),
      },
      async ({ request, params, body }) => {
        const { tenantId } = await authorize(request, params.id, "dashboard:write");
        const identity = await ops.put(params.id, tenantId, body as NativeIdentityRecord);
        return { identity };
      },
    )
    .post("/provider-accounts/:id/native-identity/regenerate", async ({ request, params }) => {
      const { tenantId } = await authorize(request, params.id, "dashboard:write");
      const identity = await ops.regenerate(params.id, tenantId);
      return { identity };
    });
}
