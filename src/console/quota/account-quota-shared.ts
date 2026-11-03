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
