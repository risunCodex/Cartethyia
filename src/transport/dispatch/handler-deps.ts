/**
 * The one dependency shape every gateway route handler takes.
 *
 * Proxy, generation, responses-compact, system one, web search, and token
 * count all receive the same wiring. Before this module each handler spelled
 * its own near-identical interface and `app.ts` spelled the same object five
 * times — a new handler dep had to be added to five interfaces and five
 * literals to reach the runtime. One shape means one place to grow.
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { ProviderAdapter } from "../../providers/provider-contracts";
import type { OAuthRefreshService, OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../network/egress/factory";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestPreparer } from "../request/preparer";
import type { ProxyRequestStateStore } from "../request/state";
import type { RouteSnapshotService } from "../routing/route-model";

export interface GatewayHandlerDeps {
  readonly db: CartethyiaDatabase;
  /** Preferred over a static map: resolves an adapter on demand and caches it. */
  readonly resolveProviderAdapter?: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly proxyPreparer: ProxyRequestPreparer;
  readonly stateStore: ProxyRequestStateStore;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}
