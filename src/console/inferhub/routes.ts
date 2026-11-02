/**
 * InferHub market routes — `/console/api/inferhub/*`.
 *
 * Global-admin only: the `config_read` key behind the catalog is one shared
 * operator credential, so a tenant-wide read would leak one tenant's view of
 * shared configuration and invite per-tenant load on a fixed request budget.
 *
 * Every handler is on-demand. `getFresh*` reports a miss and the handler then
 * fetches exactly once; nothing here schedules, polls, or streams. Every
 * response carries `fetchedAt` and `ageSeconds`, and a stale snapshot is served
 * with `stale: true` rather than being hidden — an operator must be able to see
 * how old the numbers they are reading are.
 */
import { Elysia } from "elysia";
import type { AccessDecision } from "../../security/access-control";
import { consoleErrorHandler, requireGlobalAdmin } from "../shared/errors";
import {
  fetchCatalog,
  fetchMarket,
  fetchPricingConfig,
  fetchStatus,
  objectArray,
  type InferhubClientOptions,
} from "./client";
import {
  applyFamilyHealth,
  capacityWeightedPrice,
  mergeMarketPrices,
  mergeModelHealth,
  familyStateOf,
  normalizeCatalogModel,
  numOrNull,
} from "./normalize";
import {
  getFreshModels,
  getFreshPricingConfig,
  getFreshStatus,
  getStaleModels,
  getStaleStatus,
  metaFor,
  setModels,
  setPricingConfig,
  setStatus,
  __resetStore,
} from "./store";
import type {
  ModelMarket,
  ProviderMarket,
  RawCatalogModel,
  RawMarketModel,
  RawStatusFamily,
  RawStatusModel,
  RawUpstreamCard,
  SnapshotMeta,
} from "./types";

/** Success rate below which a model is not routed to, when one is reported. */
const MIN_SUCCESS_RATE_PCT = 80;

interface InferhubRoutesConfig {
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
  /** Resolves the `config_read` key. Absent means the catalog cannot be read. */
  readonly resolveConfigKey?: () => Promise<string | undefined> | string | undefined;
  /** Transport seam for tests. Production uses the validated outbound fetch. */
  readonly fetchFn?: typeof fetch;
  /**
   * Dedicated encrypted storage for the `config_read` key. Absent means the key
   * cannot be persisted (the read-only routes still work).
   */
  readonly keyStore?: {
    readonly status: () => Promise<{
      readonly configured: boolean;
      readonly last4: string | null;
      readonly updatedAt: string | null;
    }>;
    readonly write: (value: string) => Promise<void>;
    readonly clear: () => Promise<void>;
  };
}

/** Money is rendered to at most 4 decimals: asks are fractions of a dollar per Mtok. */
function money(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

function project(model: ModelMarket) {
  return {
    ...model,
    minAskIn: money(model.minAskIn),
    minAskOut: money(model.minAskOut),
    capacityPriceIn: money(capacityWeightedPrice(model.tiersIn)),
    capacityPriceOut: money(capacityWeightedPrice(model.tiersOut)),
  };
}

/** Refreshes the model list from `/catalog` + `/market`, or keeps the last good one. */
async function ensureModels(
  config: InferhubRoutesConfig,
  now: number,
): Promise<{ models: readonly ModelMarket[]; meta: SnapshotMeta; error?: string }> {
  const fresh = getFreshModels(now);
  if (fresh !== undefined) return { models: fresh, meta: metaFor(now, "market", now) };

  const configKey = await config.resolveConfigKey?.();
  if (configKey === undefined || configKey.length === 0) {
    const stale = getStaleModels();
    return {
      models: stale?.value ?? [],
      meta: metaFor(stale?.fetchedAt, "market", now),
      error: "no_config_key",
    };
  }
  const options: InferhubClientOptions = {
    configKey,
    ...(config.fetchFn === undefined ? {} : { fetchFn: config.fetchFn }),
  };
  const [catalog, market] = await Promise.all([fetchCatalog(options), fetchMarket(options)]);
  if (catalog === undefined) {
    const stale = getStaleModels();
    return {
      models: stale?.value ?? [],
      meta: metaFor(stale?.fetchedAt, "market", now),
      error: "upstream_unavailable",
    };
  }

  const models: ModelMarket[] = [];
  // `/api/catalog` returns a bare array of upstreams, not an envelope. Each
  // upstream carries its own `models` array.
  const upstreams = Array.isArray(catalog)
    ? (catalog as readonly RawUpstreamCard[])
    : (objectArray(catalog, "upstreams") as readonly RawUpstreamCard[]);
  for (const card of upstreams) {
    const upstream = {
      prefix: card.prefix,
      label: card.label,
      systemPromptNote: card.systemPromptNote,
    };
    const rawModels = Array.isArray(card.models)
      ? (card.models as readonly RawCatalogModel[])
      : [];
    for (const raw of rawModels) {
      const model = normalizeCatalogModel(raw, upstream);
      if (model !== null) models.push(model);
    }
  }
  const withPrices = mergeMarketPrices(
    models,
    objectArray(market, "models") as readonly RawMarketModel[],
  );
  setModels(withPrices, now);
  return { models: withPrices, meta: metaFor(now, "market", now) };
}

/** Refreshes `/status` and merges health, or keeps the last good merged list. */
async function ensureStatus(
  config: InferhubRoutesConfig,
  base: readonly ModelMarket[],
  now: number,
): Promise<{
  models: readonly ModelMarket[];
  providers: readonly ProviderMarket[];
  meta: SnapshotMeta;
}> {
  const fresh = getFreshStatus(now);
  if (fresh !== undefined) return { ...fresh, meta: metaFor(now, "status", now) };

  const payload = await fetchStatus(
    config === undefined ? {} : { ...(config.fetchFn === undefined ? {} : { fetchFn: config.fetchFn }) },
  );
  if (payload === undefined) {
    const stale = getStaleStatus();
    return {
      models: stale?.value.models ?? base,
      providers: stale?.value.providers ?? [],
      meta: metaFor(stale?.fetchedAt, "status", now),
    };
  }
  const statusModels = objectArray(payload, "models") as readonly RawStatusModel[];
  const families = objectArray(payload, "families") as readonly RawStatusFamily[];
  const merged = mergeModelHealth(base, statusModels);
  const models = applyFamilyHealth(merged, families, MIN_SUCCESS_RATE_PCT);
  const providers: ProviderMarket[] = families.map((family) => ({
    prefix: typeof family.prefix === "string" ? family.prefix : String(family.slug ?? ""),
    // `family` is the display name ("Antigravity"); `slug` is the lowercase
    // key ("antigravity") and is only the fallback.
    family:
      (typeof family.family === "string" ? family.family : null) ??
      (typeof family.slug === "string" ? family.slug : ""),
    // The catalog carries per-upstream provider counts; `/status` does not, so
    // this stays 0 rather than inventing one.
    activeProviders: 0,
    familyState: familyStateOf(family.state),
    availability24hPct: numOrNull(family.availability24hPct),
    availability7dPct: numOrNull(family.availability7dPct),
    p50DurationMs: numOrNull(family.p50DurationMs),
    p95DurationMs: numOrNull(family.p95DurationMs),
    avgTtftMs1h: numOrNull(family.avgTtftMs1h),
    avgTps1h: numOrNull(family.avgTps1h),
  }));
  const value = { models, providers };
  setStatus(value, now);
  return { ...value, meta: metaFor(now, "status", now) };
}

/** Quotes one CSV field and neutralizes a leading formula character. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function createInferhubRoutes(config: InferhubRoutesConfig) {
  // No `prefix`: the returned instance is merged into the `/console/api`
  // router, and Elysia's prefix is part of the instance's type — a prefix here
  // would not type-check against the plain `Elysia` this file declares. The
  // paths therefore carry their own segment.
  return new Elysia()
    .error(consoleErrorHandler("InferHub market read failed"))
    .get("/inferhub/summary", async ({ request }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const withHealth = await ensureStatus(config, loaded.models, now);
      const pricing = getFreshPricingConfig(now);
      return {
        models: withHealth.models.map(project),
        providers: withHealth.providers,
        pricingConfig: pricing ?? null,
        meta: withHealth.meta,
        // Explicit rather than a conditional spread: an optional property
        // produced by spreading `{}` widens the route's response type past
        // what the Elysia signature accepts under exactOptionalPropertyTypes.
        error: loaded.error ?? null,
      };
    })
    .get("/inferhub/models", async ({ request, query }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const withHealth = await ensureStatus(config, loaded.models, now);
      let rows = withHealth.models;
      const prefix = typeof query.prefix === "string" ? query.prefix : undefined;
      const alias = typeof query.alias === "string" ? query.alias : undefined;
      const minAvail = Number(query.minAvail);
      if (prefix !== undefined && prefix.length > 0)
        rows = rows.filter((model) => model.prefix === prefix);
      if (alias !== undefined && alias.length > 0)
        rows = rows.filter((model) => model.aliasKey === alias);
      if (Number.isFinite(minAvail) && minAvail > 0)
        rows = rows.filter((model) => model.providersLive >= minAvail);
      if (query.onlyAvailable === "1") rows = rows.filter((model) => model.routable);
      const sorted = [...rows];
      if (query.sort === "minAskOut")
        sorted.sort((a, b) => (a.minAskOut ?? Infinity) - (b.minAskOut ?? Infinity));
      else if (query.sort === "discount")
        sorted.sort(
          (a, b) => (b.tiersIn[0]?.discountPct ?? -Infinity) - (a.tiersIn[0]?.discountPct ?? -Infinity),
        );
      else sorted.sort((a, b) => (a.minAskIn ?? Infinity) - (b.minAskIn ?? Infinity));
      return { models: sorted.map(project), meta: withHealth.meta };
    })
    .get("/inferhub/models/:id", async ({ request, params, set }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const withHealth = await ensureStatus(config, loaded.models, now);
      const id = decodeURIComponent(String(params.id));
      const model = withHealth.models.find((entry) => entry.id === id);
      if (model === undefined) {
        set.status = 404;
        return { error: "not_found", code: "not_found" };
      }
      return { model: project(model), meta: withHealth.meta };
    })
    .get("/inferhub/compare", async ({ request, query }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const alias = typeof query.alias === "string" ? query.alias : "";
      const rows = loaded.models
        .filter((model) => model.aliasKey === alias)
        .sort((a, b) => (a.minAskIn ?? Infinity) - (b.minAskIn ?? Infinity));
      return { alias, models: rows.map(project), meta: loaded.meta };
    })
    .get("/inferhub/providers", async ({ request }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const withHealth = await ensureStatus(config, loaded.models, now);
      return { providers: withHealth.providers, meta: withHealth.meta };
    })
    .get("/inferhub/status", async ({ request }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const withHealth = await ensureStatus(config, loaded.models, now);
      const pricing = getFreshPricingConfig(now) ?? (await readPricingConfig(now, config.fetchFn));
      return {
        providers: withHealth.providers,
        pricingConfig: pricing ?? null,
        meta: withHealth.meta,
      };
    })
    .get("/inferhub/export.csv", async ({ request, set }) => {
      requireGlobalAdmin(config.accessResolver(request));
      const now = Date.now();
      const loaded = await ensureModels(config, now);
      const withHealth = await ensureStatus(config, loaded.models, now);
      const header = [
        "id",
        "prefix",
        "family",
        "aliasKey",
        "providersLive",
        "minAskIn",
        "minAskOut",
        "capacityPriceIn",
        "officialIn",
        "officialOut",
        "discountPctIn",
        "successRatePct",
        "familyState",
        "routable",
      ];
      const lines = [header.join(",")];
      for (const model of withHealth.models) {
        lines.push(
          [
            model.id,
            model.prefix,
            model.family,
            model.aliasKey,
            model.providersLive,
            model.minAskIn,
            model.minAskOut,
            capacityWeightedPrice(model.tiersIn),
            model.officialIn,
            model.officialOut,
            model.tiersIn[0]?.discountPct,
            model.health.successRatePct,
            model.health.familyState,
            model.routable,
          ]
            .map(csvField)
            .join(","),
        );
      }
      set.headers["content-type"] = "text/csv; charset=utf-8";
      return lines.join("\r\n");
    })
    // ── Key management ──────────────────────────────────────────────────────
    // Stored on its own encrypted row, never in `provider_accounts`.
    .get("/inferhub/key", async ({ request }) => {
      requireGlobalAdmin(config.accessResolver(request));
      if (config.keyStore === undefined) return { configured: false, last4: null, updatedAt: null };
      return await config.keyStore.status();
    })
    .put("/inferhub/key", async ({ request, body, set }) => {
      requireGlobalAdmin(config.accessResolver(request));
      if (config.keyStore === undefined) {
        set.status = 501;
        return { error: "not_configured", code: "not_configured" };
      }
      const value = readKeyValue(body);
      if (value === undefined) {
        set.status = 400;
        return { error: "invalid_key", code: "invalid_key" };
      }
      await config.keyStore.write(value);
      // The write invalidates any cached snapshot: the freshness window would
      // otherwise keep serving a "no key" result after one is added.
      __resetStore();
      return await config.keyStore.status();
    })
    .delete("/inferhub/key", async ({ request }) => {
      requireGlobalAdmin(config.accessResolver(request));
      if (config.keyStore === undefined) return { configured: false, last4: null, updatedAt: null };
      await config.keyStore.clear();
      __resetStore();
      return { configured: false, last4: null, updatedAt: null };
    });
}

/** Reads `key` from an opaque body, rejecting a blank or oversized value. */
function readKeyValue(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>).key;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // A real InferHub key is ~30 chars; 512 catches a paste of the wrong thing
  // (a JWT, a whole JSON blob) before it is committed.
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  return trimmed;
}

/** Reads `/pricing/config` once and caches it for an hour. */
async function readPricingConfig(now: number, fetchFn?: typeof fetch) {
  const payload = await fetchPricingConfig(fetchFn === undefined ? {} : { fetchFn });
  if (payload === null || payload === undefined || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const value = {
    maxAskPctOfOfficial:
      typeof record.maxAskPctOfOfficial === "number" ? record.maxAskPctOfOfficial : null,
    platformFeePct: typeof record.platformFeePct === "number" ? record.platformFeePct : null,
    publisherSharePct:
      typeof record.publisherSharePct === "number" ? record.publisherSharePct : null,
  };
  setPricingConfig(value, now);
  return value;
}
