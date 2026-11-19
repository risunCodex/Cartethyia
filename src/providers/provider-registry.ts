// The provider registry: lazy loader cache for adapters, authentication,
// quota collectors, and model discovery. One registration authority.

import type { ServiceKind, WireFamily } from "../protocol/canonical-model";
import { GatewayError } from "../protocol/gateway-error";
import type { BundledProviderId, CompatibilityProfile } from "./provider-metadata";
import type { OAuthLoginClient } from "./authentication/oauth-flow-store";
import type { OAuthTokenRefresher } from "./authentication/oauth-refresh-service";
import type { QuotaFetcher } from "./quota/quota-support";
import { metrics } from "../observability/metrics";
import { trackAdapterLoad } from "../observability/performance-metrics";
import type { ModelDefinition } from "./provider-model-definition";
import type { ProviderModelDiscovery } from "./discovery/discovery-types";
import { parseProviderId, type ProviderAdapter, type ProviderId } from "./provider-contracts";

/** Identity, adapter, model, OAuth, quota, and compatibility data for one provider. */
export interface ProviderModule {
  readonly id: BundledProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly serviceKinds: readonly ServiceKind[];
  readonly upstreamHost: { readonly hostname: string; readonly port: number };
  readonly loadAuthentication?: () => Promise<ProviderAuthentication>;
  readonly loadQuotaCollector?: () => Promise<QuotaFetcher>;
  readonly loadModelDiscovery?: () => Promise<ProviderModelDiscovery>;
  readonly loadAdapter: () => Promise<ProviderAdapter>;
  /** Lazy model-catalog loader kept separate from heavy adapter modules. */
  readonly loadModels?: () => Promise<readonly ModelDefinition[]>;
  readonly endpointPathsByWireFamily?: Readonly<Partial<Record<WireFamily, string>>>;
  readonly compatibility?: CompatibilityProfile;
  readonly wireFamilyDefault: WireFamily;
  readonly requiresAccount: boolean;
  readonly defaultSkipProxy?: boolean;
}

/**
 * One provider registration: identity, lazy adapter loader, and metadata.
 * `upstream_host` is the SSRF-validated network-binding target for this
 * provider — carried on the same registration object as the adapter loader
 * so adding a provider touches one call-site instead of a second map kept
 * in sync by hand elsewhere; `providers/operations/provider-catalog-service.ts`
 * derives it from here.
 */
export interface ProviderRegistration {
  readonly provider_id: ProviderId;
  readonly load: () => Promise<ProviderAdapter>;
  readonly upstream_host?: { readonly hostname: string; readonly port: number };
  readonly loadModels?: () => Promise<readonly ModelDefinition[]>;
  readonly endpoint_paths_by_wire_family?: Readonly<Partial<Record<WireFamily, string>>>;
  readonly loadAuthentication?: () => Promise<ProviderAuthentication>;
  readonly loadQuotaCollector?: () => Promise<QuotaFetcher>;
  readonly loadModelDiscovery?: () => Promise<ProviderModelDiscovery>;
}

/** Authentication capabilities exposed by one provider integration. */
export interface ProviderAuthentication {
  readonly client?: OAuthLoginClient;
  readonly refresher?: OAuthTokenRefresher;
}

/** Provider implementation fields composed with canonical metadata. */
export type ProviderModuleCapabilities = Partial<Omit<ProviderModule, "loadAdapter">> &
  Pick<ProviderModule, "loadAdapter">;

/**
 * Creates a lazy authentication loader from a dynamic import and client export.
 * Most OAuth clients also refresh their own tokens.
 */
export function oauthCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
  options: { readonly withRefresher?: boolean } = {},
): () => Promise<ProviderAuthentication> {
  return async () => {
    const module = await loader();
    const client = (module as Record<string, unknown>)[exportName as string] as OAuthLoginClient & { refresh: unknown };
    return options.withRefresher
      ? ({ client, refresher: client } as ProviderAuthentication)
      : ({ client } as ProviderAuthentication);
  };
}

/** Creates a lazy quota collector loader from a dynamic import and export name. */
export function quotaCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
): () => Promise<QuotaFetcher> {
  return () => loader().then((module) => (module as Record<string, unknown>)[exportName as string] as QuotaFetcher);
}

/**
 * Derives a registry registration from a fully populated provider module.
 * Keeps the registration shape in one place so the default registry and any
 * future bundled modules use the same mapping.
 */
export function toRegistration(module: ProviderModule): ProviderRegistration {
  return {
    provider_id: module.id,
    load: module.loadAdapter,
    upstream_host: module.upstreamHost,
    ...(module.loadModels === undefined ? {} : { loadModels: module.loadModels }),
    ...(module.endpointPathsByWireFamily === undefined
      ? {}
      : { endpoint_paths_by_wire_family: module.endpointPathsByWireFamily }),
    ...(module.loadAuthentication === undefined ? {} : { loadAuthentication: module.loadAuthentication }),
    ...(module.loadQuotaCollector === undefined ? {} : { loadQuotaCollector: module.loadQuotaCollector }),
    ...(module.loadModelDiscovery === undefined ? {} : { loadModelDiscovery: module.loadModelDiscovery }),
  };
}

/**
 * Every adapter must report the id it was registered under. A mismatch means
 * the registry would dispatch requests to an adapter that believes it serves a
 * different provider, so it fails loudly at load time instead of routing wrong.
 */
function assertAdapterIdentity(expected: ProviderId, adapter: ProviderAdapter): void {
  if (adapter.provider_id === expected) return;
  // A registration/adapter mismatch is our own wiring defect, not a client
  // error: `invalid_request` would blame the caller and invite a byte-identical
  // retry. `internal_error` (500) says what is true — the gateway is
  // misconfigured and the request never had a chance.
  throw new GatewayError("internal_error", 500, "Loaded adapter ID does not match registration (request {requestId}). Even we have bad days — check the registry wiring 🐻", {
    provider_id: expected,
    adapter_id: adapter.provider_id,
  });
}

/**
 * Single provider-registration authority. Every registration loads on
 * demand through its own loader; registrations that are not added are
 * simply absent.
 */
export class ProviderRegistry {
  #registrations = new Map<ProviderId, ProviderRegistration>();
  #loaded = new Map<ProviderId, ProviderAdapter>();
  #loading = new Map<ProviderId, Promise<ProviderAdapter>>();
  #authentication = new Map<ProviderId, ProviderAuthentication>();
  #authenticationLoading = new Map<ProviderId, Promise<ProviderAuthentication>>();
  #quotaCollectors = new Map<ProviderId, QuotaFetcher>();
  #quotaLoading = new Map<ProviderId, Promise<QuotaFetcher>>();
  #modelDiscovery = new Map<ProviderId, ProviderModelDiscovery>();
  #modelDiscoveryLoading = new Map<ProviderId, Promise<ProviderModelDiscovery>>();
  /**
   * Bumped on every registration mutation (register/upsert/unregister). A lazy
   * load captures the value at start and publishes its result only while the
   * value still matches, so a load that outlives a re-registration cannot
   * repopulate the caches the mutation just cleared with the old module.
   */
  #generation = new Map<ProviderId, number>();

  #currentGeneration(providerId: ProviderId): number {
    return this.#generation.get(providerId) ?? 0;
  }

  /**
   * Drops one provider's cached *and in-flight* derived state and advances the
   * generation that guards it. In-flight loads go too: a caller that starts
   * after a re-registration must load from the new registration instead of
   * awaiting the previous one — and a superseded load that eventually settles
   * writes nothing (see {@link #currentGeneration}).
   */
  #invalidate(providerId: ProviderId): void {
    this.#generation.set(providerId, this.#currentGeneration(providerId) + 1);
    this.#loaded.delete(providerId);
    this.#loading.delete(providerId);
    this.#authentication.delete(providerId);
    this.#authenticationLoading.delete(providerId);
    this.#quotaCollectors.delete(providerId);
    this.#quotaLoading.delete(providerId);
    this.#modelDiscovery.delete(providerId);
    this.#modelDiscoveryLoading.delete(providerId);
  }

  /** Adds one registration and rejects duplicate canonical IDs. */
  register(registration: ProviderRegistration): void {
    const providerId = parseProviderId(registration.provider_id);
    if (this.#registrations.has(providerId)) {
      throw new GatewayError("invalid_request", 409, "Provider is already registered (request {requestId}). This name's taken — pick another alias ✨", {
        provider_id: providerId,
      });
    }
    if (providerId !== registration.provider_id) {
      throw new GatewayError("internal_error", 500, "Provider registration ID is not normalized (request {requestId}). Even we have bad days — check the registry wiring 🐻", {
        provider_id: registration.provider_id,
      });
    }
    this.#registrations.set(providerId, registration);
  }
  /** Removes one registration and any cached or in-flight adapter/auth/quota/discovery state. */
  unregister(providerId: string): boolean {
    const normalized = parseProviderId(providerId);
    const removed = this.#registrations.delete(normalized);
    this.#invalidate(normalized);
    return removed;
  }

  /**
   * Registers one provider, replacing any existing registration for the same
   * id. Unlike {@link register} this never throws on a pre-existing entry:
   * console mutations re-apply a BYOK row after every edit (base URL,
   * compatibility profile), and a plain `register` would reject the second
   * write with 409. A replaced registration also drops its cached adapter so
   * the next `resolve` builds one from the new config.
   * @returns true when an existing registration was replaced.
   */
  upsert(registration: ProviderRegistration): boolean {
    const providerId = parseProviderId(registration.provider_id);
    if (providerId !== registration.provider_id) {
      throw new GatewayError("internal_error", 500, "Provider registration ID is not normalized (request {requestId}). Even we have bad days — check the registry wiring 🐻", {
        provider_id: registration.provider_id,
      });
    }
    const replaced = this.#registrations.has(providerId);
    this.#registrations.set(providerId, registration);
    // Drop cached and in-flight derived state: the adapter (and any
    // auth/quota/discovery closure) was built from the registration being
    // replaced, and a load still running for it must not publish its result
    // after this point.
    this.#invalidate(providerId);
    return replaced;
  }

  /**
   * Resolves one adapter on demand, returning the cached instance when it has
   * already loaded — unless `force` is set, which rebuilds the adapter from
   * the registration (single-flight, and the fresh instance replaces the
   * cache). This never evaluates a provider's module graph until that provider
   * is actually dispatched to, so heavy bespoke adapters (protobuf-based
   * providers) stay out of the startup path. `force` is used by the probe
   * path, which wants the adapter rebuilt against the latest registration
   * rather than a cached instance.
   */
  async resolve(providerId: string, opts: { readonly force?: boolean } = {}): Promise<ProviderAdapter | undefined> {
    // Fast path: registration keys are canonical (register/upsert parse
    // before every set), so a raw membership hit skips the re-normalizing
    // parse on the per-attempt dispatch path. A miss still normalizes below,
    // and the `force` cache check keys the same canonical maps either way.
    let normalized: ProviderId;
    if (this.#registrations.has(providerId as ProviderId)) {
      normalized = providerId as ProviderId;
    } else {
      normalized = parseProviderId(providerId);
    }
    if (!opts.force) {
      const cached = this.#loaded.get(normalized);
      if (cached !== undefined) return cached;
    }
    const registration = this.#registrations.get(normalized);
    if (registration === undefined) return undefined;
    return this.#loadRegistration(normalized, registration);
  }

  /** Lazily resolves and caches one provider's authentication capabilities. */
  async resolveAuthentication(providerId: string): Promise<ProviderAuthentication | undefined> {
    const normalized = parseProviderId(providerId);
    const cached = this.#authentication.get(normalized);
    if (cached !== undefined) return cached;
    const loader = this.#registrations.get(normalized)?.loadAuthentication;
    if (loader === undefined) return undefined;
    const inFlight = this.#authenticationLoading.get(normalized);
    if (inFlight !== undefined) return inFlight;
    const generation = this.#currentGeneration(normalized);
    const task = loader()
      .then((authentication) => {
        // Publish only while this registration is still the one in force.
        if (this.#currentGeneration(normalized) === generation) {
          this.#authentication.set(normalized, authentication);
        }
        return authentication;
      })
      .finally(() => {
        // Identity check: a superseded load must not delete its replacement's
        // in-flight entry.
        if (this.#authenticationLoading.get(normalized) === task) {
          this.#authenticationLoading.delete(normalized);
        }
      });
    this.#authenticationLoading.set(normalized, task);
    return task;
  }

  /** Lazily resolves one provider's token refresher, if it declares one. */
  async resolveRefresher(providerId: string): Promise<OAuthTokenRefresher | undefined> {
    return (await this.resolveAuthentication(providerId))?.refresher;
  }

  /** Lazily resolves one provider's OAuth login client, if it declares one. */
  async resolveLoginClient(providerId: string): Promise<OAuthLoginClient | undefined> {
    return (await this.resolveAuthentication(providerId))?.client;
  }

  /**
   * Whether a provider declares a quota collector. Sync declaration check —
   * no module is loaded — for list projections like the quota dropdown that
   * must hide providers with no quota endpoint.
   */
  hasQuotaCollector(providerId: string): boolean {
    return this.#registrations.get(parseProviderId(providerId))?.loadQuotaCollector !== undefined;
  }

  /**
   * Whether a provider declares a model-discovery resolver. Sync declaration
   * check — no module is loaded — for list projections that must hide the
   * "Fetch models" control from providers with no discovery endpoint.
   *
   * This is the question the projection should be asking; "is this a builtin?"
   * is not a proxy for it. A builtin that registers a resolver cannot list any
   * model until an operator runs a sync, so hiding the control on the strength
   * of builtin status alone leaves it permanently empty.
   */
  hasModelDiscovery(providerId: string): boolean {
    return this.#registrations.get(parseProviderId(providerId))?.loadModelDiscovery !== undefined;
  }

  /** Lazily resolves and caches one provider's quota collector. */
  async resolveQuotaCollector(providerId: string): Promise<QuotaFetcher | undefined> {
    const normalized = parseProviderId(providerId);
    const cached = this.#quotaCollectors.get(normalized);
    if (cached !== undefined) return cached;
    const loader = this.#registrations.get(normalized)?.loadQuotaCollector;
    if (loader === undefined) return undefined;
    const inFlight = this.#quotaLoading.get(normalized);
    if (inFlight !== undefined) return inFlight;
    const generation = this.#currentGeneration(normalized);
    const task = loader()
      .then((collector) => {
        if (this.#currentGeneration(normalized) === generation) {
          this.#quotaCollectors.set(normalized, collector);
        }
        return collector;
      })
      .finally(() => {
        if (this.#quotaLoading.get(normalized) === task) {
          this.#quotaLoading.delete(normalized);
        }
      });
    this.#quotaLoading.set(normalized, task);
    return task;
  }

  /** Lazily resolves and caches one provider's model-discovery capability. */
  async resolveModelDiscovery(providerId: string): Promise<ProviderModelDiscovery | undefined> {
    const normalized = parseProviderId(providerId);
    const cached = this.#modelDiscovery.get(normalized);
    if (cached !== undefined) return cached;
    const loader = this.#registrations.get(normalized)?.loadModelDiscovery;
    if (loader === undefined) return undefined;
    const inFlight = this.#modelDiscoveryLoading.get(normalized);
    if (inFlight !== undefined) return inFlight;
    const generation = this.#currentGeneration(normalized);
    const task = loader()
      .then((discovery) => {
        if (this.#currentGeneration(normalized) === generation) {
          this.#modelDiscovery.set(normalized, discovery);
        }
        return discovery;
      })
      .finally(() => {
        if (this.#modelDiscoveryLoading.get(normalized) === task) {
          this.#modelDiscoveryLoading.delete(normalized);
        }
      });
    this.#modelDiscoveryLoading.set(normalized, task);
    return task;
  }

  /**
   * Single-flight adapter load shared by `loadOne`/`resolve`: concurrent
   * callers for one provider await the same load, identity drift is rejected,
   * the result is cached, and load time is recorded.
   */
  async #loadRegistration(
    providerId: ProviderId,
    registration: ProviderRegistration,
  ): Promise<ProviderAdapter> {
    const inFlight = this.#loading.get(providerId);
    if (inFlight !== undefined) return inFlight;
    const generation = this.#currentGeneration(providerId);
    const startedAt = performance.now();
    const task = (async () => {
      const adapter = await registration.load();
      assertAdapterIdentity(providerId, adapter);
      const durationMs = performance.now() - startedAt;
      metrics.proxy_provider_adapter_load_ms.observe(durationMs);
      trackAdapterLoad(providerId, durationMs);
      // Publish only while this registration is still the one in force; a load
      // that outlived a re-registration must not resurrect the old adapter.
      if (this.#currentGeneration(providerId) === generation) {
        this.#loaded.set(providerId, adapter);
      }
      return adapter;
    })().finally(() => {
      // Identity check: a superseded load must not delete its replacement's
      // in-flight entry.
      if (this.#loading.get(providerId) === task) {
        this.#loading.delete(providerId);
      }
    });
    this.#loading.set(providerId, task);
    return task;
  }

  /** Returns registration metadata without loading optional code. */
  registrations(): readonly ProviderRegistration[] {
    return [...this.#registrations.values()];
  }

  /**
   * The provider's declared upstream host, or `undefined` when it has none.
   *
   * Answers from the registry's own map, so the dispatch path's per-candidate
   * lookup does not allocate, and a provider registered after boot resolves
   * immediately (the live-read the caller depends on).
   */
  upstreamHostFor(providerId: string): { readonly hostname: string; readonly port: number } | undefined {
    // Fast path: registration keys are canonical (register/upsert parse
    // before every set), so a raw hit answers without the re-normalizing
    // parse on the per-candidate dispatch path. A miss still parses on the
    // fallback below, preserving the malformed-slug → `undefined` contract.
    const rawRegistration = this.#registrations.get(providerId as ProviderId);
    if (rawRegistration !== undefined) return rawRegistration.upstream_host;
    let normalized: ProviderId;
    try {
      normalized = parseProviderId(providerId);
    } catch {
      return undefined;
    }
    return this.#registrations.get(normalized)?.upstream_host;
  }

}
