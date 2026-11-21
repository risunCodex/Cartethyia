import { and, eq, isNull } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { providerAccounts } from "../../persistence/schema";
import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditRecorder } from "../auth/audit-recorder";
import { type QuotaRefreshDeps } from "../../providers/quota/refresh";
import type { AccountTestEgressDeps } from "./account-test-egress";
import { DAILY_CHECKIN_PROVIDER_IDS, dailyCheckinEgressForPass } from "../../workers/daily-checkin";

/** Daily check-in only exists on the buddy billing facade; everything else 400s with intent. */
export function supportsAccountCheckin(providerId: string): boolean {
  return (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/**
 * Dependencies shared by the tenant-scoped and global-admin account/quota route
 * groups. Both groups are composed onto one Elysia instance by
 * `createAccountQuotaRoutes`.
 */
export interface AccountQuotaRoutesDeps extends QuotaRefreshDeps {
  readonly poolSelector?: AccountTestEgressDeps["poolSelector"];
  readonly networkBindingFactory?: AccountTestEgressDeps["networkBindingFactory"];
  readonly accessResolver: ConsoleAccessResolver;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /** Records privileged account mutations (e.g. hard deletion) to `admin_audit_log`. */
  readonly auditRecorder?: AuditRecorder | undefined;
}

/**
 * Every status a `provider_accounts` row can carry: the operator-settable pair
 * plus `cooldown`, which only the health machine writes. The PATCH routes
 * validate against this list so a status the machine owns can still be *read*
 * back through the same resolver — see the catalog contract's
 * `ACCOUNT_STATUSES`, which is the narrower operator-writable subset.
 */
export const ACCOUNT_PATCH_STATUSES = ["active", "cooldown", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_PATCH_STATUSES)[number];

/**
 * Loads one `provider_accounts` row by id, scoped to an owner.
 *
 * `tenantId === null` matches only shared/global rows (`tenant_id IS NULL`);
 * a string matches only that tenant's own rows. This is the single owner of
 * the "load one account under an owner scope" prelude the quota and identity
 * routes repeated per handler — the predicate is the security boundary, so it
 * lives in exactly one place.
 */
export async function loadAccountRow(
  db: CartethyiaDatabase,
  accountId: string,
  tenantId: string | null,
): Promise<typeof providerAccounts.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(providerAccounts)
    .where(
      tenantId === null
        ? and(eq(providerAccounts.id, accountId), isNull(providerAccounts.tenantId))
        : and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, tenantId)),
    )
    .limit(1);
  return rows[0];
}

/**
 * The merged result of interpreting a PATCH account-status body. On success it
 * carries the resolved `AccountStatus`; on failure it carries the exact 400
 * response the tenant and global routes both return.
 */
export type ResolveNextAccountStatusResult =
  | { readonly ok: true; readonly nextStatus: AccountStatus }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly body: { readonly error: string; readonly code: string };
    };

/**
 * Resolves the next account status from a PATCH body: an explicit `active`
 * boolean wins over `status`, and a missing `status` (or an invalid one) is
 * rejected with the shared 400 shape. Both account PATCH handlers interpret
 * the same input contract, so it lives here once.
 */
export function resolveNextAccountStatus(body: {
  readonly active?: boolean;
  readonly status?: string;
}): ResolveNextAccountStatusResult {
  if (body.status !== undefined && !ACCOUNT_PATCH_STATUSES.includes(body.status as AccountStatus)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `status must be one of: ${ACCOUNT_PATCH_STATUSES.join(", ")}`,
        code: "invalid_status",
      },
    };
  }
  const nextStatus: AccountStatus | undefined =
    body.active !== undefined
      ? body.active
        ? "active"
        : "disabled"
      : (body.status as AccountStatus | undefined);
  if (nextStatus === undefined) {
    return {
      ok: false,
      status: 400,
      body: { error: "active or status is required", code: "invalid_request" },
    };
  }
  return { ok: true, nextStatus };
}

/**
 * Wraps a stored api_key credential in the envelope its collector expects.
 *
 * Exported because every refresh path needs it, and the ones that omit it
 * fail in a way that looks like the credential is dead: an unmarked `cline`
 * `sk_...` key takes the OAuth branch, gets `workos:` prepended, and is
 * refused with a message naming a version problem. The scheduled sweep once
 * omitted it, so a working account was cooled with `quota_fetch_failed` every
 * minute while refreshing fine from the console.
 */
export async function markProviderApiKeyCredential(providerId: string, credential: string): Promise<string> {
  if (providerId !== "cline") return credential;
  // dynamic-import: B-02 lazy graph — cline-only marker, kept off the boot graph.
  // The cline-quota graph is loaded lazily: only `cline` accounts ever need
  // the marker, so a deployment without cline must not pull it into the boot
  // graph (B-02).
  const { markClineApiKeyCredential } = await import(
    "../../providers/integrations/cline/cline-quota"
  );
  return markClineApiKeyCredential(credential);
}

/**
 * Builds the refresh dependency bundle from the route deps, binding the
 * provider-specific credential normalisation (`cline` API keys) once so every
 * caller refreshes through the same wiring.
 */
export function createQuotaRefreshDeps(deps: AccountQuotaRoutesDeps): QuotaRefreshDeps {
  return {
    db: deps.db,
    redis: deps.redis,
    providerRegistry: deps.providerRegistry,
    resolveCredential: deps.resolveCredential,
    ...(deps.snapshotInvalidator ? { snapshotInvalidator: deps.snapshotInvalidator } : {}),
    markApiKeyCredential: markProviderApiKeyCredential,
    // Quota reads leave through the account's own egress (the tenant's active
    // pool, rotated) — Kiro correlates a credential with its egress and
    // refuses a usage read that arrives from an address its traffic never uses.
    // Direct egress stays the fallback when no factory (or pool) exists.
    ...(deps.networkBindingFactory
      ? {
          fetcherFor: dailyCheckinEgressForPass({
            db: deps.db,
            networkBindingFactory: deps.networkBindingFactory,
          }),
        }
      : {}),
  };
}
