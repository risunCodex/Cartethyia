// Provider assembly: builtin registry construction, BYOK wiring, and DB catalog materialization.
import type { WireFamily } from "../../protocol/canonical-model";

import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { mergeJson } from "../../persistence/dialect";
import { GatewayError } from "../../protocol/gateway-error";
import { isBundledProviderId, parseProviderId, type ProviderId } from "../provider-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import { ProviderRegistry } from "../provider-registry";
import { OpenAICompatibleAdapter } from "../adapters/compatible-adapter";
import { resolveByokWireProfile } from "./byok-wire-profile";
import { BUNDLED_PROVIDER_MODULES } from "../default-registry";
import { getCachedModels } from "./provider-caches";
import { seedBundledModels } from "./provider-catalog-seeder";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { providers } from "../../persistence/schema";
import type { CompatibilityProfile } from "../provider-metadata";
import { resolveCustomCliHeaders } from "./custom-cli-headers";
import { GATEWAY_USER_AGENT } from "./gateway-user-agent";
import { isIP } from "node:net";
import { isAddressAllowed } from "../../network/ssrf";
import type { SsrfPolicy } from "../../config/network";
import { BoundedLruMap } from "../../transport/routing/bounded-lru";

/**
 * Revision of the compiled provider catalog, and the last one materialized.
 *
 * The snapshot builder re-seeds on **every** rebuild, and a re-seed is a
 * `DELETE` per provider plus a full `INSERT … ON CONFLICT DO UPDATE` of the
 * compiled catalog. That is correct work when the catalog changed and pure
 * waste when it did not — and the invalidation that triggers it is a timer
 * (`account-health-sweep`), so the waste lands on a proxy request.
 *
 * Only the paths that can actually change the compiled catalog bump this: a
 * provider registered, edited, or retired. A cooldown recovery changes account
 * health, not the catalog, so it must not.
 */
let catalogRevision = 0;
let lastSeededCatalogRevision = -1;

/** Current catalog revision. */
export function currentCatalogRevision(): number {
  return catalogRevision;
}

/** Bumps the revision after a change to the compiled catalog. */
export function bumpCatalogRevision(): number {
  catalogRevision += 1;
  return catalogRevision;
}

/**
 * Forces the next re-seed to run even when the revision is unchanged.
 *
 * For the boot path and for tests: the compiled catalog has to be materialized
 * once for the current process regardless of what an earlier call already
 * applied, because a fresh database or a fresh registry is not a revision
 * change.
 */
export function invalidateCatalogSeed(): void {
  lastSeededCatalogRevision = -1;
}

/**
 * Records that the caller has just materialized the current catalog itself, so
 * the next `refreshActiveProviderCatalogs` is a no-op.
 *
 * The boot path seeds directly rather than through the gate — it must always
 * run, against a database and a registry that are both fresh — and without this
 * the first snapshot build would pay for a second identical seed.
 */
export function markCatalogSeeded(): void {
  lastSeededCatalogRevision = catalogRevision;
}
/**
 * Idempotently materializes every shipped provider in the database catalog.
 * The canonical provider definition supplies identity and routing defaults;
 * this only creates rows that tenant/account routing needs.
 *
 * Additive on purpose: it never deletes. The test harness calls it to converge a
 * shared database before any suite collects, so a destructive step here would
 * race the fixtures other suites are mid-way through installing. Retirement is
 * {@link retireUnbundledProviders}, run once on the boot path.
 */
export async function seedBundledProviders(db: CartethyiaDatabase): Promise<void> {
  const rows = BUNDLED_PROVIDER_MODULES.map((provider) => ({
    id: provider.id,
    wireFamilyDefault: provider.wireFamilyDefault,
    compatibilityProfile: provider.compatibility ?? null,
    enabled: true,
    requiresAccount: provider.requiresAccount,
  }));
  // One upsert for the whole bundled catalog. The previous shape ran a bulk
  // INSERT and then one UPDATE per provider (40 sequential statements on the
  // boot path) purely to reconcile routing defaults and merge compatibility
  // profiles. `excluded` carries the row we just tried to insert, so the same
  // reconciliation happens in a single statement: routing defaults are
  // overwritten from the bundle, while the compatibility profile is *merged*
  // so console edits to other keys survive a boot.
  await db
    .insert(providers)
    .values(rows)
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        wireFamilyDefault: sql`excluded.wire_family_default`,
        requiresAccount: sql`excluded.requires_account`,
        compatibilityProfile: mergeJson(
          sql`COALESCE(${providers.compatibilityProfile}, '{}')`,
          sql`COALESCE(excluded.compatibility_profile, '{}')`,
          db,
        ),
      },
    });
  // The compiled catalog is derived from the registry, and this is the path
  // that reconciles the bundle's own rows into it.
  bumpCatalogRevision();
}

/**
 * Retires the global (`tenant_id IS NULL`) provider rows the bundle no longer
 * declares.
 *
 * Without this, dropping a provider from `metadata.ts` left its
 * `providers` row in place forever — the seed only ever adds. The row still
 * satisfied `list()`'s `globalOrOwnedBy`, but `isBundledProviderId`, the
 * predicate behind `isBuiltIn`, answered `false` for it, so the console drew it
 * as a *custom* provider the operator could not remove: `DELETE
 * /providers/:providerId` scopes to `tenant_id = <tenant>` and a global row is
 * `NULL`, so it matched nothing and surfaced as `provider_not_found`. The
 * `/platform/global/:providerId` route that can delete such a row has no
 * dashboard control.
 *
 * Scoped to unowned rows because this is the only writer of them — every
 * console-created provider carries a tenant — so an unowned id absent from the
 * bundle is an orphan by construction, and a tenant-owned BYOK row is never in
 * scope. The model seeder prunes its retired rows the same way; this is the
 * provider-level half.
 *
 * Separate from {@link seedBundledProviders} rather than folded into it: the
 * harness calls that seeder on import to converge a shared database, and a
 * delete there would race the fixtures other suites are installing. This runs
 * once on the boot path, where no such fixture exists.
 */
export async function retireUnbundledProviders(db: CartethyiaDatabase): Promise<number> {
  const bundledIds = BUNDLED_PROVIDER_MODULES.map((provider) => provider.id);
  if (bundledIds.length === 0) return 0;
  const retired = await db
    .delete(providers)
    .where(and(isNull(providers.tenantId), notInArray(providers.id, bundledIds)))
    .returning({ id: providers.id });
  // Deleting a provider removes it from the compiled catalog, so the next
  // re-seed must run even though no revision bumped on this path otherwise.
  if (retired.length > 0) bumpCatalogRevision();
  return retired.length;
}

export interface ByokUpstreamHost {
  readonly hostname: string;
  readonly port: number;
}


/**
 * Live view of every registered provider's `upstream_host`.
 *
 * Read at dispatch time instead of snapshotted: a custom provider registered
 * (or re-registered) after boot must resolve its SSRF binding on the very
 * next request, and a snapshot taken during startup would keep reporting
 * `undefined` for it until the process restarted.
 */
export function liveProviderUpstreamHosts(registry: ProviderRegistry): {
  readonly get: (providerId: string) => ByokUpstreamHost | undefined;
} {
  // A live lookup, not a snapshot: a custom provider registered after boot must
  // resolve its SSRF binding on the very next request. Returning a closure
  // instead of a Map-shaped object keeps the dispatch path from allocating an
  // array per candidate lookup — only `.get` was ever used.
  return { get: (providerId) => registry.upstreamHostFor(providerId) };
}

export interface BundledProviderCatalog {
  readonly modelsByProvider: ReadonlyMap<string, readonly ModelDefinition[]>;
}

/**
 * Every bundled provider's compiled catalog.
 *
 * All of them, whether or not the provider has an account. The compiled
 * catalog is a property of the provider, not of this deployment's
 * credentials, and gating the seed on `providersWithAccounts` meant a provider
 * with no account yet listed no models at all — the console showed an empty
 * catalog for a provider it had just shipped. It also meant the orphan prune
 * in `seedBundledModels` never ran for those providers, so a row left behind by
 * an older catalog survived forever, since pruning is part of the same walk.
 */
export async function bundledModelCatalog(
  registry: ProviderRegistry,
): Promise<BundledProviderCatalog> {
  const modelsByProvider = new Map<string, readonly ModelDefinition[]>();
  for (const registration of registry.registrations()) {
    const definitions = registration.loadModels
      ? await getCachedModels(registration.provider_id, registration.loadModels)
      : [];
    modelsByProvider.set(registration.provider_id, definitions);
    // Only a row that contradicts the registration map is a mistake. Two rows
    // of the same wire family may legitimately serve different paths (a web
    // UltraSpeed is `/fastchat/open-apis/bot/chat` while flash/pro stay on
    // `/open-apis/bot/chat`); dispatch always uses the row's own
    // `ModelDefinition.endpointPath` via `candidate.endpoint_path`.
    const registeredPaths = registration.endpoint_paths_by_wire_family ?? {};
    for (const definition of definitions) {
      // A native-service row (System One) is not served on a chat wire: its
      // `wireFamily` is an inert placeholder and its endpoint belongs to the
      // native route, so the wire-family path map does not describe it.
      if ((definition.serviceKind ?? "llm") !== "llm") continue;
      const registered = registeredPaths[definition.wireFamily];
      if (registered !== undefined && registered !== definition.endpointPath) {
        throw new Error(
          `Conflicting endpoint paths for ${registration.provider_id}/${definition.wireFamily}`,
        );
      }
    }
  }
  return { modelsByProvider };
}

/**
 * Re-seeds the compiled catalogs, called when a provider gains an account after
 * boot. It runs the same walk as at boot: an account makes the rows routable and
 * the snapshot must reflect that without waiting for a restart.
 *
 * Gated on {@link currentCatalogRevision}: this is the seeder the snapshot
 * builder calls on every rebuild, and the invalidation that triggers it is a
 * 30 s timer, so an ungated re-seed could be pushed onto the next proxy
 * request for a catalog that had not changed. The paths that do change the
 * catalog bump the revision; everything else is a no-op here.
 *
 * `precomputedCatalog` supplies the compiled catalog when the caller already
 * materialized it (the boot path's deferred B-01 resolution), so the seed
 * shares that walk instead of running a second one. Absent, the walk runs
 * here as before.
 */
export async function refreshActiveProviderCatalogs(
  db: CartethyiaDatabase,
  registry: ProviderRegistry,
  precomputedCatalog?: BundledProviderCatalog,
): Promise<void> {
  const revision = currentCatalogRevision();
  if (revision === lastSeededCatalogRevision) return;
  const catalog = precomputedCatalog ?? (await bundledModelCatalog(registry));
  await seedBundledModels(db, catalog.modelsByProvider);
  lastSeededCatalogRevision = revision;
}


/**
 * Last successfully applied BYOK config per normalized provider ID.
 * Makes repeated `syncByokProviders` runs cheap: an unchanged row is skipped,
 * while a changed one is re-registered instead of being rejected.
 *
 * Bounded (G-04 / B-04): provider IDs are operator-created strings, so an
 * unbounded map would pin an entry for every retired or deleted custom
 * provider forever. The LRU bound keeps only the most recently touched
 * registrations resident; a dropped entry simply re-registers on the next
 * pass (the fingerprint is a skip-ahead optimization, not correctness).
 */
const BYOK_FINGERPRINT_CACHE_MAX_ENTRIES = 1024;
const byokRegistrationFingerprints = new BoundedLruMap<string, string>(
  BYOK_FINGERPRINT_CACHE_MAX_ENTRIES,
);

function byokFingerprint(
  baseUrl: string,
  profile: CompatibilityProfile | null,
  wireFamilyDefault: WireFamily | null,
): string {
  return JSON.stringify({ baseUrl, profile, wireFamilyDefault });
}

/**
 * Registers every DB-persisted BYOK provider (`providers.base_url IS NOT NULL`,
 * `enabled = true`) into `registry` as an OpenAI-compatible adapter, and
 * returns each one's upstream host/port so the proxy handler can run the
 * same SSRF-validated network binding built-ins already get.
 *
 * Idempotent by construction: re-running after an operator edits a row
 * replaces that provider's registration instead of failing, so a custom
 * provider becomes dispatchable without a process restart.
 */
export async function registerByokProviders(
  registry: ProviderRegistry,
  db: CartethyiaDatabase,
  ssrfPolicy: SsrfPolicy = {},
): Promise<ReadonlyMap<string, ByokUpstreamHost>> {
  const rows = await db
    .select()
    .from(providers)
    .where(and(isNotNull(providers.baseUrl), eq(providers.enabled, true)));
  const hosts = new Map<string, ByokUpstreamHost>();
  let registered = false;
  for (const row of rows) {
    if (!row.baseUrl) continue;
    const baseUrl = row.baseUrl;
    let providerId: ProviderId;
    try {
      providerId = parseProviderId(row.id);
    } catch {
      throw new GatewayError("invalid_request", 400, `invalid BYOK provider ID: ${row.id} (request {requestId}). Check the shape of what you sent — then resend 🪞`);
    }
    if (isBundledProviderId(providerId)) {
      throw new GatewayError("invalid_request", 409, `BYOK provider ID collides with a built-in: ${row.id} (request {requestId}). This name's taken — pick another alias ✨`, {
        provider_id: providerId,
      });
    }
    const compatibilityProfile = row.compatibilityProfile as CompatibilityProfile | null;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
      if (
        (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
        !parsedUrl.hostname
      ) {
        throw new Error("unsupported BYOK URL");
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("invalid_request", 400, `invalid BYOK base URL for provider ${row.id} (request {requestId}). Check the shape of what you sent — then resend 🪞`);
    }
    // IP literals are rejected at registration; DNS names are revalidated at dispatch.
    if (isIP(parsedUrl.hostname) !== 0 && !isAddressAllowed(parsedUrl.hostname, ssrfPolicy)) {
      throw new GatewayError(
        "invalid_request",
        400,
        `BYOK provider ${row.id} host is blocked (private/unsafe address) (request {requestId}). All roads blocked — time to find a new route 🗺️`,
      );
    }
    const defaultPort = parsedUrl.protocol === "http:" ? 80 : 443;
    hosts.set(providerId, {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
    });
    const fingerprint = byokFingerprint(baseUrl, compatibilityProfile, row.wireFamilyDefault);
    if (byokRegistrationFingerprints.get(providerId) === fingerprint) continue;
    const wireProfile = resolveByokWireProfile(row.wireFamilyDefault, compatibilityProfile);
    registry.upsert({
      provider_id: providerId,
      upstream_host: {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
      },
      load: async () =>
        new OpenAICompatibleAdapter({
          provider_id: providerId,
          base_url: baseUrl,
          authentication_header_shape: wireProfile.authHeaderShape,
          buildExtraHeaders: (context, _request, candidate) => {
            // An operator-set route identity wins over both auto modes: Routing
            // Strategy now serves custom providers too, and its value (including
            // the empty "None" choice) must be honored verbatim.
            const routeAgent = context.user_agent;
            if (routeAgent !== undefined) {
              return {
                ...(routeAgent.length > 0 ? { "user-agent": routeAgent } : {}),
                ...(compatibilityProfile?.extra_headers ?? {}),
              };
            }
            // Explicit gateway identity wins over CLI cloaking, and Codex /
            // Claude-Code-shaped traffic can never take this path: this hook
            // only runs for BYOK custom rows, never bundled first-party
            // adapters. Unset restores the CLI headers below.
            if (compatibilityProfile?.gateway_user_agent === true) {
              return {
                "user-agent": GATEWAY_USER_AGENT,
                ...(compatibilityProfile?.extra_headers ?? {}),
              };
            }
            const sendCli = compatibilityProfile?.cli_identity !== false;
            const cliHeaders = sendCli
              ? resolveCustomCliHeaders(candidate?.wire_family ?? "chat")
              : {};
            return {
              ...cliHeaders,
              ...(compatibilityProfile?.extra_headers ?? {}),
            };
          },
          ...(compatibilityProfile?.extra_query_params
            ? { extra_query_params: compatibilityProfile.extra_query_params }
            : {}),
          // Operator paths when declared, otherwise the derived bare-root paths
          // for exactly the wire families this provider serves.
          endpoint_paths_by_wire_family: wireProfile.endpointPathsByWireFamily,
          ...(compatibilityProfile?.streaming_usage_mode
            ? { streaming_usage_mode: compatibilityProfile.streaming_usage_mode }
            : {}),
          ...(compatibilityProfile?.structured_output
            ? { structured_output: compatibilityProfile.structured_output }
            : {}),
        }),
    });
    byokRegistrationFingerprints.set(providerId, fingerprint);
    registered = true;
  }
  // A changed BYOK registration changes what the compiled catalog contains, so
  // the next re-seed must run. An unchanged one deliberately does not: this
  // function is called on every console provider mutation, most of which do not
  // alter the registration at all.
  if (registered) bumpCatalogRevision();
  return hosts;
}

/**
 * Re-applies one provider's BYOK registration after a console mutation so a
 * newly created or edited custom provider is dispatchable immediately.
 *
 * A row that no longer qualifies (`base_url` cleared, or disabled) is dropped:
 * leaving a stale registration behind would keep an adapter and an SSRF host
 * alive for an upstream the operator just removed. Returns the upstream host
 * when the provider is registered, otherwise `undefined`.
 */
export async function syncByokProvider(
  registry: ProviderRegistry,
  db: CartethyiaDatabase,
  providerId: string,
  ssrfPolicy: SsrfPolicy = {},
): Promise<ByokUpstreamHost | undefined> {
  let normalized: ProviderId;
  try {
    normalized = parseProviderId(providerId);
  } catch {
    return undefined;
  }
  if (isBundledProviderId(normalized)) return undefined;
  const fingerprintBefore = byokRegistrationFingerprints.get(normalized);
  const hosts = await registerByokProviders(registry, db, ssrfPolicy);
  const host = hosts.get(normalized);
  // `registerByokProviders` only walks qualifying rows, so a provider that
  // stopped qualifying is never visited — drop it here instead.
  if (host === undefined && fingerprintBefore !== undefined) {
    registry.unregister(normalized);
    byokRegistrationFingerprints.delete(normalized);
    // The provider left the registry, so the compiled catalog no longer
    // contains it: the next re-seed must run to prune its rows.
    bumpCatalogRevision();
  }
  return host;
}
