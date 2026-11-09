import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditRecorder } from "../auth/audit-recorder";
import { type QuotaRefreshDeps } from "../../providers/quota/refresh";
import type { AccountTestEgressDeps } from "./account-test-egress";

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

export const ACCOUNT_STATUSES = ["active", "cooldown", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

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
  if (body.status !== undefined && !ACCOUNT_STATUSES.includes(body.status as AccountStatus)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `status must be one of: ${ACCOUNT_STATUSES.join(", ")}`,
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
  };
}
