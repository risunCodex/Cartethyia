/**
 * Discovery and roster-persistence engine for `ProviderProbingService`.
 *
 * Owns the read-only `/v1/models` discovery (`discoverModels`), the upsert +
 * prune roster writes (`syncModels`, `commitDiscoveredModels`), and the shared
 * account-selection helper (`usableAccount`). The facade delegates here with
 * the same injected dependencies.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { models, providerAccounts } from "../../persistence/schema";
import type { WireFamily } from "../../protocol/canonical-model";
import { isRecord } from "../../protocol/codecs";
import { GatewayError } from "../../protocol/gateway-error";
import {
  isBundledProviderId,
} from "../provider-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import type { ProviderRegistry } from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";
import { decryptCredentialToString } from "../../security/crypto";
import { globalOrOwnedBy } from "../../persistence/tenant-scope";
import {
  type CompatibilityProfile,
} from "../provider-metadata";
import { modelsDevCatalog } from "./models-dev-catalog";
import { fetchOpenAICompatibleModels } from "./openai-model-discovery";
import {
  applyDiscoveredWire,
  resolveDiscoveredWire,
  type DiscoveredModelWire,
} from "./probe-wire";
import {
  loadProviderWireRow,
  selectUsableAccount,
  wireContextFrom,
  type ProbeProviderRow,
} from "./probe-phases";
import { authHeaders } from "../adapters/compatible-adapter";
import {
  modelDiscoveryBaseUrl,
  resolveByokWireProfile,
} from "../operations/byok-wire-profile";
import type { ProbeEngineDeps } from "./probe-deps";
import {
  asFetchLike,
  asOutboundBinding,
} from "./probe-runner";

/** The account a credential-scoped discovery will use, with its non-secret
 * auth configuration. Selection is unchanged — first usable row, preferring a
 * tenant-owned one — so discovery and dispatch agree on which account answered.
 */
  /**
   * The account a model-listing fetch will use, with its non-secret auth
   * configuration. Selection is unchanged — first usable row, preferring a
   * tenant-owned one — so discovery and dispatch agree on which account
   * answered.
   *
   * A credential-less (`none`) account IS a usable selection: it is the
   * "Public Key" row a no-key custom provider registers, and returning it lets
   * discovery list that upstream's models with no credential. Only a row that
   * claims a credential but stores none stays unusable — that one would send an
   * empty `Authorization` header.
   */
async function usableAccount(
  db: CartethyiaDatabase,
  tenantId: string,
  providerId: string,
): Promise<{
  readonly secret: string;
  readonly label?: string;
  readonly authState?: Readonly<Record<string, unknown>>;
} | undefined> {
  const rows = await db
    .select()
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
      ),
    );
  const usable = selectUsableAccount(rows);
  if (!usable) return undefined;
  if (usable.credentialKind === "none") {
    return {
      secret: "",
      ...(typeof usable.label === "string" ? { label: usable.label } : {}),
      ...(isRecord(usable.authState)
        ? { authState: usable.authState as Readonly<Record<string, unknown>> }
        : {}),
    };
  }
  if (!usable.credentialCiphertext) return undefined;
  const authState = isRecord(usable.authState) ? usable.authState as Readonly<Record<string, unknown>> : undefined;
  return {
    secret: decryptCredentialToString(usable.credentialCiphertext),
    ...(typeof usable.label === "string" ? { label: usable.label } : {}),
    ...(authState === undefined ? {} : { authState }),
  };
}

/** One upstream-shaped error for both discovery branches. */
function discoveryFailure(providerId: string, error: unknown): GatewayError {
  return new GatewayError(
    "transport_unavailable",
    502,
    `Model discovery failed for ${providerId}: ${error instanceof Error ? error.message : "unknown error"} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
    {},
    "upstream",
  );
}

/**
 * Adapts a validated outbound fetch to the `FetchLike` shape discovery
 * helpers expect. Only the call signature is consumed downstream.
 */
/**
 * The discovery half of `ProviderProbingService`. Stateless by construction:
 * all state comes from the injected deps, so the facade can hold one instance
 * for its whole lifetime.
 */
export class ProbeDiscovery {
  private readonly db: CartethyiaDatabase;
  private readonly defaultEndpoints: Record<WireFamily, string>;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly outboundFetchFor: ProbeEngineDeps["outboundFetchFor"];
  private readonly providerRegistry: ProviderRegistry;

  constructor(deps: ProbeEngineDeps) {
    this.db = deps.db;
    this.defaultEndpoints = deps.defaultEndpoints;
    this.bundledModelCatalog = deps.bundledModelCatalog;
    this.outboundFetchFor = deps.outboundFetchFor;
    this.providerRegistry = deps.providerRegistry;
  }

  /**
   * Fetches one provider's model listing through the exact same two branches
   * `syncModels` uses — a registry resolver, or the generic OpenAI-compatible
   * `/models` fetch for BYOK — without writing anything. `supported:false`
   * names a provider with no listing path so the Add-Model UI can offer its
   * manual fallback instead of reporting a transport failure.
   *
   * The account is the first usable one (`selectUsableAccount`), the same
   * selection sync uses (D27); its label is returned when available so the
   * surface can say whose roster it is showing.
   */
  async discoverModels(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly supported: boolean;
    readonly models: readonly ModelDefinition[];
    readonly accountLabel?: string;
    /** Wire resolution context + BYOK family constraints for a later commit. */
    readonly wire: {
      readonly providerRow: ProbeProviderRow | undefined;
      readonly supportedWireFamilies: readonly WireFamily[] | undefined;
      readonly baseUrl: string | undefined;
    };
  }> {
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
    try {
      const discoveryFetch = asFetchLike(outbound.fetch);
      const resolver = await this.providerRegistry.resolveModelDiscovery(providerId);
      const account = await usableAccount(this.db, tenantId, providerId);
      const providerRow = await loadProviderWireRow(this.db, providerId);
      if (resolver) {
        // `providerBaseUrl` throws for a non-bundled id; a custom provider can
        // still register a discovery resolver, and its own row's base URL is
        // the authority. Only a bundled provider falls back to metadata.
        const effectiveBaseUrl =
          providerRow?.baseUrl ??
          (isBundledProviderId(providerId) ? providerBaseUrl(providerId) : "");
        let discovered: readonly ModelDefinition[] | null;
        try {
          discovered = await resolver({
            baseUrl: effectiveBaseUrl,
            credential: account?.secret ?? "",
            ...(discoveryFetch ? { fetcher: discoveryFetch } : {}),
            ...(account?.authState === undefined ? {} : { authState: account.authState }),
          });
        } catch (error) {
          throw discoveryFailure(providerId, error);
        }
        if (!discovered) {
          throw new GatewayError(
            "transport_unavailable",
            502,
            `Model discovery failed for ${providerId}: endpoint returned no usable models (request {requestId}). The upstream came back empty-handed — retry 🌙`,
            {},
            "upstream",
          );
        }
        return {
          supported: true,
          models: discovered,
          ...(account?.label === undefined ? {} : { accountLabel: account.label }),
          wire: { providerRow, supportedWireFamilies: undefined, baseUrl: effectiveBaseUrl },
        };
      }
      if (providerRow?.baseUrl) {
        const wireProfile = resolveByokWireProfile(
          providerRow.wireFamilyDefault,
          providerRow.compatibilityProfile as CompatibilityProfile | null,
        );
        const modelsBaseUrl = modelDiscoveryBaseUrl(providerRow.baseUrl);
        let discovered: readonly ModelDefinition[] | null;
        try {
          discovered = await fetchOpenAICompatibleModels({
            baseUrl: modelsBaseUrl,
            providerId,
            headers: {
              // `"none"` makes `authHeaders` emit no auth header at all, so a
              // public-key provider lists its models without a credential —
              // a hardcoded `"api_key"` sent `Bearer ` (empty) and read as an
              // auth failure upstream.
              ...authHeaders(
                wireProfile.authHeaderShape,
                new TextEncoder().encode(account?.secret ?? ""),
                account === undefined ? "api_key" : account.secret.length > 0 ? "api_key" : "none",
              ),
            },
            ...(discoveryFetch ? { fetcher: discoveryFetch as typeof fetch } : {}),
          });
        } catch (error) {
          throw discoveryFailure(providerId, error);
        }
        if (discovered && discovered.length > 0) {
          return {
            supported: true,
            models: discovered,
            ...(account?.label === undefined ? {} : { accountLabel: account.label }),
            wire: {
              providerRow,
              supportedWireFamilies: wireProfile.supportedWireFamilies,
              baseUrl: providerRow.baseUrl ?? undefined,
            },
          };
        }
      }
      return {
        supported: false,
        models: [],
        ...(account?.label === undefined ? {} : { accountLabel: account.label }),
        wire: { providerRow, supportedWireFamilies: undefined, baseUrl: undefined },
      };
    } finally {
      outbound.release?.();
    }
  }

  /**
   * The single write path for every discovery result: one fresh fetch, one
   * subset, one source. Sync passes the whole roster as `discovered`; the
   * Add-Model commit passes the operator's selected definitions as `manual`.
   * `definitionsFrom` is applied to the fresh fetch so a stale client-side
   * `ModelDefinition` can never decide what gets stored.
   */
  private async persistRoster(
    tenantId: string,
    providerId: string,
    definitionsFrom: (
      fresh: readonly ModelDefinition[],
    ) => readonly ModelDefinition[],
    source?: "manual",
    unsupportedError?: (account: Awaited<ReturnType<typeof usableAccount>>) => GatewayError,
  ): Promise<{ synced: number }> {
    const fresh = await this.discoverModels(tenantId, providerId);
    if (!fresh.supported) {
      if (unsupportedError) {
        throw unsupportedError(await usableAccount(this.db, tenantId, providerId));
      }
      throw new GatewayError(
        "capability_unsupported",
        400,
        `${providerId} publishes no model-listing endpoint (request {requestId}). Its catalog ships with Cartethyia; new models appear with an update. Know your tools — this one just isn't in the box 🧰`,
        {},
        "cartethyia",
      );
    }
    const ctx = wireContextFrom(fresh.wire.providerRow);
    return this.persistDiscoveredModels(
      providerId,
      definitionsFrom(fresh.models),
      (modelId) => resolveDiscoveredWire(modelId, ctx, undefined, this.defaultEndpoints),
      ctx.endpointPathsByWireFamily,
      fresh.wire.baseUrl,
      fresh.wire.supportedWireFamilies,
      source,
    );
  }

  /**
   * Full sync: one fetch, upsert every id as `discovered` (or `auto_free`).
   * Its original prerequisite diagnostics are preserved: a custom provider
   * with no account is told to add one, a bundled provider with no listing
   * endpoint is told its catalog ships with the release.
   */
  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.persistRoster(
      tenantId,
      providerId,
      (fresh) => fresh,
      undefined,
      (account) => {
        // `account` is the discovery context, not just "has a credential": a
        // credential-less ("Public Key") account is a complete answer, so the
        // listing proceeds and `authHeaders` stamps no auth header. Only a
        // provider with NO usable row at all still gets the add-one diagnostic.
        if (account === undefined) {
          const prefix = isBundledProviderId(providerId)
            ? `Add an account for ${providerId} before fetching its models`
            : `Add an account for ${providerId} first — model listing needs a credential`;
          return new GatewayError(
            "invalid_request",
            400,
            `${prefix} (request {requestId}). Wrong key, right door — check the credential 🔑`,
            {},
            "cartethyia",
          );
        }
        return new GatewayError(
          "capability_unsupported",
          400,
          `${providerId} publishes no model-listing endpoint (request {requestId}). Its catalog ships with Cartethyia; new models appear with an update. Know your tools — this one just isn't in the box 🧰`,
          {},
          "cartethyia",
        );
      },
    );
  }

  /**
   * Persists an operator-selected subset of a freshly fetched roster as
   * `source="manual"` (D28). The store has already intersected the requested
   * ids against its own fetch; this second fetch is the anti-forgery boundary
   * and the source of every stored `ModelDefinition`.
   */
  async commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    selectedIds: readonly string[],
  ): Promise<{ synced: number }> {
    return this.persistRoster(
      tenantId,
      providerId,
      (fresh) => {
        const wanted = new Set(selectedIds);
        return fresh.filter((definition) => wanted.has(definition.modelId));
      },
      "manual",
    );
  }

  private async persistDiscoveredModels(
    providerId: string,
    discoveredModels: readonly (string | ModelDefinition)[],
    resolve: (modelId: string) => DiscoveredModelWire,
    endpointOverrides?: Partial<Record<WireFamily, string>>,
    baseUrl?: string,
    supportedWireFamilies?: readonly WireFamily[],
    source?: "manual",
  ): Promise<{ synced: number }> {
    // Static definitions are the injected bundled catalog; the probing service
    // and the console store are both handed the same startup-built map.
    const staticDefinitions: readonly ModelDefinition[] =
      this.bundledModelCatalog.get(providerId) ?? [];
    const staticEndpoints: Partial<Record<WireFamily, string>> = {};
    for (const definition of staticDefinitions) {
      staticEndpoints[definition.wireFamily] ??= definition.endpointPath;
    }
    // Fetch only adds genuinely new models: an id the builtin catalog
    // already owns stays exactly one (builtin) row instead of gaining a
    // discovered shadow that confuses pickers and deletes.
    const builtinIds = new Set(staticDefinitions.map((definition) => definition.modelId));
    // `(modelId, endpointPath)` is the row identity, so a corrected wire family
    // lands on a *new* row and would leave the old one behind as a dead route.
    // Collect this run's pairs and drop the provider's superseded discovered
    // rows for the same ids afterwards.
    const resolvedPairs: Array<{ modelId: string; endpointPath: string }> = [];
    const rows: Array<typeof models.$inferInsert> = [];
    // A `manual` commit is an operator's subset, not a full roster. The
    // builtin-id skip that protects sync from creating shadow rows would hide
    // a legitimately selected operator row, so only sync applies it.
    const skipBuiltinIds = source === undefined;
    // `(modelId, endpointPath)` is the row identity and the upsert's conflict
    // target, so a listing that repeats a pair (the bespoke discoveries return
    // raw upstream ids) would make a multi-row `ON CONFLICT DO UPDATE` fail with
    // "cannot affect row a second time". Keep the first row per pair, as the
    // builtin seeder does, so one statement can carry a whole chunk.
    const seenPairs = new Set<string>();
    for (const item of discoveredModels) {
      const modelId = typeof item === "string" ? item : item.modelId;
      if (skipBuiltinIds && builtinIds.has(modelId)) continue;
      const resolved = resolve(modelId);
      const discDef = typeof item === "string" ? undefined : item;
      const { wireFamily, endpointPath } = applyDiscoveredWire({
        resolvedWireFamily: resolved.wireFamily,
        resolvedEndpointPath: resolved.endpointPath,
        ...(discDef !== undefined
          ? { discoveredWireFamily: discDef.wireFamily, discoveredEndpointPath: discDef.endpointPath }
          : {}),
        staticEndpoints,
        ...(endpointOverrides !== undefined ? { endpointOverrides } : {}),
        ...(supportedWireFamilies !== undefined ? { supportedWireFamilies } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      resolvedPairs.push({ modelId, endpointPath });
      const pairKey = `${modelId}\u0000${endpointPath}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const knownDefinition = staticDefinitions.find((definition) => definition.modelId === modelId);
      const sourceUpdatedAt = new Date();
      const metadata = {
        contextLimit: knownDefinition?.contextLimit ?? discDef?.contextLimit ?? null,
        outputLimit: knownDefinition?.outputLimit ?? discDef?.outputLimit ?? null,
        modalities: knownDefinition?.modalities ?? discDef?.modalities ?? null,
        reasoning: knownDefinition?.reasoning ?? discDef?.reasoning ?? false,
        toolCall: knownDefinition?.toolCall ?? discDef?.toolCall ?? false,
        cost: modelsDevCatalog.costFor(providerId, modelId),
        // R-E: fetched warnings win, a matching static definition is the
        // fallback, and an unknown id stores `NULL` (operator-editable).
        warningMetadata:
          discDef?.warnings ?? knownDefinition?.warnings ?? null,
        // Discovery builds its rows from the same static catalog, so a fetched
        // row carries the same answer a seeded one does. Null when neither
        // source marked it, which reads as "unknown" rather than "free".
        proOnly: (discDef?.proOnly ?? knownDefinition?.proOnly ?? null),
        // Same shape for the tier the provider states itself (Qoder `is_free`).
        freeTier: (discDef?.freeTier ?? knownDefinition?.freeTier ?? null),
      };
      rows.push({
        providerId,
        modelId,
        wireFamily,
        // A discovery module that classifies an id as a non-chat service (the
        // System One decision API) states it on its own definition; otherwise the
        // static catalog's classification wins, and an unclassified id is `llm`.
        serviceKind: discDef?.serviceKind ?? knownDefinition?.serviceKind ?? "llm",
        endpointPath,
        ...metadata,
        // A discovery module that marks its rows as a free tier gets its own
        // source, because the model list groups on it: a free-tier row is not
        // an ordinary fetched one, and collapsing both into `discovered` lost
        // that distinction at the only point where it is still known.
        source:
          source ?? (discDef?.freeTier === true ? "auto_free" : "discovered"),
        sourceUpdatedAt,
        enabled: true,
        ...(discDef?.dialect === undefined && knownDefinition?.dialect === undefined
          ? {}
          : { dialect: discDef?.dialect ?? knownDefinition?.dialect }),
      });
    }
    // One statement per chunk (500, the account-health batch step) instead of
    // one round-trip per row. `excluded.*` reads the proposed row, so the update
    // set is the same columns the per-row upsert wrote.
    for (let offset = 0; offset < rows.length; offset += 500) {
      await this.db
        .insert(models)
        .values(rows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [models.providerId, models.modelId, models.endpointPath],
          set: {
            serviceKind: sql`excluded.service_kind`,
            contextLimit: sql`excluded.context_limit`,
            outputLimit: sql`excluded.output_limit`,
            modalities: sql`excluded.modalities`,
            reasoning: sql`excluded.reasoning`,
            toolCall: sql`excluded.tool_call`,
            cost: sql`excluded.cost`,
            proOnly: sql`excluded.pro_only`,
            freeTier: sql`excluded.free_tier`,
            warningMetadata: sql`excluded.warning_metadata`,
            dialect: sql`excluded.dialect`,
            // The proposed row's own source, not a constant: a free-tier
            // discovery and an ordinary one write the same upsert, and pinning
            // this to `discovered` would relabel every free-tier row on the
            // next sync.
            source: sql`excluded.source`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
          },
        });
    }
    const synced = rows.length;
    // A manual commit is an operator's selection, not a roster replacement:
    // pruning would delete unrelated discovered rows with the same ids.
    if (source === "manual") return { synced };
    // Drop this provider's discovered rows for the synced ids that are no
    // longer part of the resolved set — the stale `(model, endpoint)` pair left
    // behind when a corrected wire family moved a model to a new path. Rows the
    // operator added by hand (`manual`) and ids outside this run are untouched.
    // `auto_free` is included: it is written by this same sync, so leaving it
    // out would make a free-tier row the one kind of synced row that never gets
    // pruned when its id moves.
    if (resolvedPairs.length > 0) {
      const pairs = resolvedPairs.map(
        (pair) => sql`(${pair.modelId}, ${pair.endpointPath})`,
      );
      const ids = resolvedPairs.map((pair) => pair.modelId);
      await this.db
        .delete(models)
        .where(
          and(
            eq(models.providerId, providerId),
            inArray(models.source, ["discovered", "auto_free"]),
            sql`${models.modelId} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`(${models.modelId}, ${models.endpointPath}) NOT IN (${sql.join(pairs, sql`, `)})`,
          ),
        );
    }
    return { synced };
  }
}
