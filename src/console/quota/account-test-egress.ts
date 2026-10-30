// Manual account-test egress. A test must leave through the same proxy the
// next real request would use: the tenant's active pools, the same
// least-loaded / round-robin selector, and the validated pool binding.
// Direct fetch is used when the provider is configured to skip the proxy, and
// when the tenant simply has no pool — the default deployment, which dispatch
// already serves directly. A pool that exists but cannot be selected is a real
// failure and still fails closed.
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { networkPools, poolRoutingSettings, providerRoutingSettings } from "../../persistence/schema";
import { resolveTenantOverride } from "../../persistence/tenant-scope";
import { GatewayError } from "../../protocol/gateway-error";
import type { NetworkPoolSelector, PoolRotation } from "../../network/pool/selector";
import type { ValidatedFetch } from "../../network/outbound-fetch";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../../providers/provider-metadata";
import type { FetchLike } from "../../providers/quota/quota-contracts";

export interface AccountTestEgressDeps {
  readonly db: CartethyiaDatabase;
  readonly poolSelector: NetworkPoolSelector;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
}

interface ActivePool {
  readonly id: string;
  readonly maxInflight: number | null;
  readonly weight: number | null;
}

/** Adapts a validated pool fetch to the quota collector's `FetchLike`. */
function asFetchLike(fetchFn: ValidatedFetch, signal: AbortSignal): FetchLike {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetchFn(input, { ...init, signal });
  return Object.assign(wrapped, { preconnect: () => undefined });
}

async function providerSkipsProxy(
  db: CartethyiaDatabase,
  tenantId: string,
  providerId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      tenantId: providerRoutingSettings.tenantId,
      skipProxy: providerRoutingSettings.skipProxy,
    })
    .from(providerRoutingSettings)
    .where(
      and(
        eq(providerRoutingSettings.providerId, providerId),
        or(eq(providerRoutingSettings.tenantId, tenantId), isNull(providerRoutingSettings.tenantId)),
      ),
    );
  return resolveTenantOverride(
    rows.find((row) => row.tenantId === tenantId)?.skipProxy,
    rows.find((row) => row.tenantId === null)?.skipProxy,
    DEFAULT_PROXY_SKIP_PROVIDER_IDS.has(providerId),
  );
}

/**
 * Selects the egress a manual account test must use.
 *
 * The selection matches dispatch: active pools owned by the account's tenant,
 * that tenant's pool strategy, and the shared selector's cooldown and capacity
 * gates. The acquired slot stays held until the returned release runs, so the
 * test counts against the same concurrency ceiling as a real request.
 */
export async function selectAccountTestEgress(
  deps: AccountTestEgressDeps,
  input: { readonly tenantId: string; readonly providerId: string; readonly signal: AbortSignal },
): Promise<{ fetch: FetchLike; release: () => void }> {
  if (await providerSkipsProxy(deps.db, input.tenantId, input.providerId)) {
    return {
      fetch: asFetchLike(deps.networkBindingFactory.fetch(), input.signal),
      release: () => undefined,
    };
  }

  const [pools, strategyRows] = await Promise.all([
    deps.db
      .select({
        id: networkPools.id,
        maxInflight: networkPools.maxInflight,
        weight: networkPools.weight,
      })
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, input.tenantId), eq(networkPools.status, "active"))),
    deps.db
      .select({
        strategy: poolRoutingSettings.strategy,
        rotateCount: poolRoutingSettings.rotateCount,
      })
      .from(poolRoutingSettings)
      .where(eq(poolRoutingSettings.tenantId, input.tenantId))
      .limit(1),
  ]);
  const active = pools as readonly ActivePool[];
  if (active.length === 0) {
    // No pool configured at all is not a proxy failure — it is the default
    // deployment, and dispatch already serves it through direct egress. Failing
    // closed here made "Test" unusable unless the operator first added a pool or
    // manually flipped the provider to direct, and the button then reported a
    // deployment that routes perfectly well.
    //
    // Only a provider that *has* pools and cannot use one is a real failure;
    // that still fails below.
    return {
      fetch: asFetchLike(deps.networkBindingFactory.fetch(), input.signal),
      release: () => undefined,
    };
  }

  const limits: Record<string, number> = {};
  const weights: Record<string, number> = {};
  for (const pool of active) {
    limits[pool.id] = pool.maxInflight ?? 10;
    weights[pool.id] = pool.weight ?? 100;
  }
  const strategy = strategyRows[0];
  const rotation: PoolRotation | undefined =
    strategy?.strategy === "round_robin"
      ? { key: input.tenantId, rotateCount: strategy.rotateCount }
      : undefined;
  const ids = active.map((pool) => pool.id);

  let slot: { poolId: string; release: () => void } | undefined;
  try {
    slot = await deps.poolSelector.tryAcquireAvailablePool(
      ids,
      input.providerId,
      limits,
      weights,
      rotation,
    );
  } catch {
    throw new GatewayError(
      "proxy_pool_unavailable",
      503,
      "No active proxy pool is available because coordination is unavailable (request {requestId}). The bouncer stepped out — come back shortly 🚪",
      { reason: "coordination_unavailable" },
      "network",
    );
  }
  if (!slot) {
    const failure = await deps.poolSelector.getSelectionFailure(
      ids,
      input.providerId,
      limits,
      weights,
    );
    const code =
      failure.reason === "at_capacity"
        ? "proxy_pool_capacity_exceeded"
        : failure.reason === "cooldown"
          ? "proxy_pool_cooldown"
          : "proxy_pool_unavailable";
    const status = failure.reason === "at_capacity" ? 429 : 503;
    const message =
      failure.reason === "at_capacity"
        ? "Every proxy pool for this provider is at its concurrency limit (request {requestId}). Retry shortly, or add a pool or raise its capacity. The pools are full right now — chill 🌊"
        : failure.reason === "cooldown"
          ? "Every proxy pool for this provider is cooling down after upstream failures (request {requestId}). Retry once the cooldown resets. The proxies are catching their breath — zzz 💤"
          : "No active proxy pool is configured for this tenant and provider (request {requestId}). Add one, or route this provider through direct egress. No bridge to cross — configure a pool first 🏗️";
    throw new GatewayError(
      code,
      status,
      message,
      {
        pools: failure.pools,
        ...(failure.retryAt ? { retryAt: new Date(failure.retryAt).toISOString() } : {}),
      },
      "network",
    );
  }

  return {
    fetch: asFetchLike(deps.networkBindingFactory.fetch(slot.poolId, input.tenantId), input.signal),
    release: slot.release,
  };
}
