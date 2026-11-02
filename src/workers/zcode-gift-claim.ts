/** Explicitly opted-in daily gift claims, limited to active credential-bearing accounts. */
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { log } from "../observability/logger";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import type { RedisClient } from "../persistence/redis";
import { providerAccounts } from "../persistence/schema";
import type { ProviderId } from "../providers/provider-contracts";
import type { ValidatedFetch } from "../network/outbound-fetch";
import { invalidateQuotaCacheForAccount } from "../providers/quota/cache";
import { claimZcodeGifts } from "../providers/integrations/zcode-start-plan/gifts";
import { ZCODE_START_PLAN_PROVIDER_ID } from "../providers/integrations/zcode-start-plan/provider";
import { CONFIG_SPEC, readText } from "../config/spec";
import type { ScheduledTaskRegistry } from "./scheduler";

export interface ZcodeGiftClaimDeps {
  readonly db: CartethyiaDatabase;
  /** Same resolver the quota sweep uses: OAuth refreshed, api_key passthrough. */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: ValidatedFetch;
  readonly fetcherFor?: (accountId: string, tenantId?: string | null) => Promise<ValidatedFetch>;
  readonly redis?: RedisClient | undefined;
  readonly snapshotInvalidator?: { invalidate(): unknown };
  /** Accounts loaded per page; a daily sweep drains all pages. */
  readonly maxPerPass?: number;
}

export interface ZcodeGiftClaimSummary {
  readonly attempted: number;
  readonly plansClaimed: number;
  readonly failed: number;
}

export async function zcodeGiftClaimSweep(
  deps: ZcodeGiftClaimDeps,
): Promise<ZcodeGiftClaimSummary> {
  const maxPerPass = Math.max(1, Math.floor(deps.maxPerPass ?? 40));
  const eligible = and(
    eq(providerAccounts.providerId, ZCODE_START_PLAN_PROVIDER_ID),
    eq(providerAccounts.status, "active"),
    inArray(providerAccounts.credentialKind, ["oauth", "api_key"]),
  );
  // Freeze the upper key so accounts added during a sweep cannot extend it forever.
  const [last] = await deps.db.select({ accountId: providerAccounts.id })
    .from(providerAccounts).where(eligible).orderBy(desc(providerAccounts.id)).limit(1);
  if (!last) return { attempted: 0, plansClaimed: 0, failed: 0 };
  let after: string | undefined;
  let attempted = 0;
  let plansClaimed = 0;
  let failed = 0;
  while (true) {
    const targets = await deps.db
      .select({ accountId: providerAccounts.id, tenantId: providerAccounts.tenantId })
      .from(providerAccounts)
      .where(and(eligible, lte(providerAccounts.id, last.accountId), after ? gt(providerAccounts.id, after) : undefined))
      .orderBy(asc(providerAccounts.id))
      .limit(maxPerPass);
    if (targets.length === 0) break;
    for (const target of targets) {
      attempted += 1;
      try {
        const credential = await deps.resolveCredential(
          ZCODE_START_PLAN_PROVIDER_ID,
          target.accountId,
        );
        const result = await claimZcodeGifts({
          accountId: target.accountId,
          credential,
          fetcher: await deps.fetcherFor?.(target.accountId, target.tenantId) ?? deps.fetcher ?? fetch,
        });
        plansClaimed += result.claimed.length;
        if (result.claimed.length > 0) {
          await deps.db.update(providerAccounts).set({ quotaSnapshot: null }).where(and(
            eq(providerAccounts.id, target.accountId),
            eq(providerAccounts.providerId, ZCODE_START_PLAN_PROVIDER_ID),
          ));
          await invalidateQuotaCacheForAccount(target.accountId, deps.redis);
          await deps.snapshotInvalidator?.invalidate();
          log.info(`[Gift-claim] account=${target.accountId} claimed ${result.claimed.length} plan(s)`);
        }
        if (result.state === "error" || result.state === "partial") failed += 1;
        if (["error", "partial", "captcha"].includes(result.state)) {
          log.warn(`[Gift-claim] account=${target.accountId} outcome=${result.state}`);
        }
      } catch {
        failed += 1;
        log.warn(`[Gift-claim] account=${target.accountId} request failed`);
      }
    }
    after = targets[targets.length - 1]!.accountId;
    if (after === last.accountId || targets.length < maxPerPass) break;
  }
  log.info(
    `[Gift-claim] pass done: ${attempted} account(s), ${plansClaimed} plan(s) claimed, ${failed} failed`,
  );
  return { attempted, plansClaimed, failed };
}

export function registerZcodeGiftClaimTask(registry: ScheduledTaskRegistry, deps: ZcodeGiftClaimDeps): void {
  if (readText("CARTETHYIA_ZCODE_AUTO_CLAIM", CONFIG_SPEC.CARTETHYIA_ZCODE_AUTO_CLAIM) !== "true") return;
  const daily = 24 * 60 * 60_000;
  registry.register({
    name: "zcode-gift-claim",
    intervalMs: daily,
    initialDelayMs: daily,
    shared: true,
    run: () => zcodeGiftClaimSweep(deps),
  });
}
