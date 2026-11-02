/** Explicitly opted-in daily gift claims, limited to active credential-bearing accounts. */
import { and, asc, eq, gt, inArray } from "drizzle-orm";
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

const cursors = new WeakMap<CartethyiaDatabase, string>();

export interface ZcodeGiftClaimDeps {
  readonly db: CartethyiaDatabase;
  /** Same resolver the quota sweep uses: OAuth refreshed, api_key passthrough. */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: ValidatedFetch;
  readonly fetcherFor?: (accountId: string, tenantId?: string | null) => Promise<ValidatedFetch>;
  readonly redis?: RedisClient | undefined;
  readonly snapshotInvalidator?: { invalidate(): unknown };
  /** Cap on accounts per pass, so one pass cannot run unbounded. */
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
  const load = (after?: string) => deps.db
    .select({ accountId: providerAccounts.id, tenantId: providerAccounts.tenantId })
    .from(providerAccounts)
    .where(and(
      eq(providerAccounts.providerId, ZCODE_START_PLAN_PROVIDER_ID),
      eq(providerAccounts.status, "active"),
      inArray(providerAccounts.credentialKind, ["oauth", "api_key"]),
      after ? gt(providerAccounts.id, after) : undefined,
    ))
    .orderBy(asc(providerAccounts.id))
    .limit(maxPerPass);
  let targets = await load(cursors.get(deps.db));
  if (targets.length === 0) targets = await load();

  let plansClaimed = 0;
  let failed = 0;
  for (const target of targets) {
    cursors.set(deps.db, target.accountId);
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
  log.info(
    `[Gift-claim] pass done: ${targets.length} account(s), ${plansClaimed} plan(s) claimed, ${failed} failed`,
  );
  return { attempted: targets.length, plansClaimed, failed };
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
