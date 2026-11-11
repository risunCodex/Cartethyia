// Device-flow OAuth egress resolution.
//
// Device-code flows (start + poll) previously always dialed from the
// gateway's own egress, so every code minted on one host appeared to come
// from a single IP — which let Cursor/Grok/other device-code providers flag
// "multiple codes from one IP". The `device_flow_proxy` routing setting says
// whether to route these requests through one of the tenant's active network
// pools ("random", the default) or direct ("direct").
//
// The resolved fetch is a validated fetch bound to either a pool or the
// gateway's direct egress, and is injected into the OAuth flow context so the
// provider client uses it for its device-authorization and token-poll calls.

import { eq, and, isNull } from "drizzle-orm";
import type { DeviceFlowProxyMode } from "../../../persistence/schema";
import { networkPools, providerRoutingSettings } from "../../../persistence/schema";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../../network/egress/factory";
import type { FetchLike } from "../../../providers/authentication/oauth-flow-store";

/** A resolved device-flow egress: the fetch to use, plus its release hook. */
export interface DeviceEgress {
  readonly fetch: FetchLike;
  /** Release an acquired pool slot (no-op for direct egress). */
  readonly release: () => void;
  /** The pool selected, when one was (for correlation/persistence). */
  readonly networkPoolId?: string;
}

/** Dependencies the device-egress resolver needs. */
export interface DeviceEgressDeps {
  readonly db: CartethyiaDatabase;
  readonly poolSelector: NetworkPoolSelector;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
}

/** Reads the provider's `device_flow_proxy` mode; absent rows default to `random`. */
async function resolveDeviceFlowProxyMode(
  db: CartethyiaDatabase,
  providerId: string,
  tenantId: string | null,
): Promise<DeviceFlowProxyMode> {
  if (tenantId !== null) {
    const tenantRow = await db
      .select({ mode: providerRoutingSettings.deviceFlowProxy })
      .from(providerRoutingSettings)
      .where(
        and(
          eq(providerRoutingSettings.providerId, providerId),
          eq(providerRoutingSettings.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (tenantRow[0]) return tenantRow[0].mode === "direct" ? "direct" : "random";
  }
  const globalRow = await db
    .select({ mode: providerRoutingSettings.deviceFlowProxy })
    .from(providerRoutingSettings)
    .where(
      and(
        eq(providerRoutingSettings.providerId, providerId),
        isNull(providerRoutingSettings.tenantId),
      ),
    )
    .limit(1);
  return globalRow[0]?.mode === "direct" ? "direct" : "random";
}

/**
 * Resolves the egress for one device-code flow. `random` selects an active
 * network pool (weighted, cooldown-aware) when one is available and falls
 * back to direct egress when the tenant has no usable pool; `direct` always
 * dials direct. The returned fetch is what the provider client must use for
 * its device-authorization and token-poll requests.
 */
export async function resolveDeviceEgress(
  deps: DeviceEgressDeps,
  providerId: string,
  tenantId: string | null,
): Promise<DeviceEgress> {
  const mode = await resolveDeviceFlowProxyMode(deps.db, providerId, tenantId);
  const direct = (): DeviceEgress => ({
    fetch: deps.networkBindingFactory.fetch(undefined, tenantId ?? undefined),
    release: () => undefined,
  });

  if (mode === "direct" || tenantId === null) return direct();

  const poolRows = await deps.db
    .select({
      id: networkPools.id,
      maxInflight: networkPools.maxInflight,
      weight: networkPools.weight,
    })
    .from(networkPools)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.status, "active")));

  if (poolRows.length > 0) {
    const limits: Record<string, number> = {};
    const weights: Record<string, number> = {};
    for (const pool of poolRows) {
      limits[pool.id] = pool.maxInflight ?? 10;
      weights[pool.id] = pool.weight ?? 100;
    }
    const slot = await deps.poolSelector.tryAcquireAvailablePool(
      poolRows.map((pool) => pool.id),
      providerId,
      limits,
      weights,
    );
    if (slot) {
      return {
        fetch: deps.networkBindingFactory.fetch(slot.poolId, tenantId ?? undefined),
        release: slot.release,
        networkPoolId: slot.poolId,
      };
    }
  }

  // No active/usable pool: direct is the safe fallback (never block a login).
  return direct();
}
