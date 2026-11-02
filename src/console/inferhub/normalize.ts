/**
 * InferHub market normalization.
 *
 * Pure functions over already-parsed remote data: no I/O, so every derivation
 * here is unit-testable with a fixture. All inputs are untrusted — a malformed
 * or hostile payload must degrade to `null`/empty, never throw into a route.
 *
 * Two rules run through everything:
 * - **Null means unknown.** InferHub nulls any metric below a volume floor, and
 *   a null is not a zero. A model with no reported success rate is unverified,
 *   not broken; coerce it to 0 and every quiet model looks like an outage.
 * - **The cheapest ask is not capacity.** The lowest tier frequently has
 *   `avail: 1`, so both the minimum and a capacity-weighted price are exposed.
 */
import type {
  FamilyState,
  ModelMarket,
  RawCatalogModel,
  RawMarketModel,
  RawStatusFamily,
  RawStatusModel,
  RawUpstreamCard,
  Tier,
} from "./types";

/** Ask buckets are keyed to this many decimals so float noise cannot split one price into two tiers. */
const PRICE_PRECISION = 6;
/** Default number of live providers a capacity-weighted price must have behind it. */
const DEFAULT_MIN_CAPACITY = 2;

const FAMILY_STATES: readonly FamilyState[] = [
  "operational",
  "degraded",
  "major_outage",
  "low_traffic",
];

/** Reads a finite number, or null. Never coerces a missing metric to zero. */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Catalog and budgets carry decimal strings; market carries numbers. Both
  // are read here so one helper covers the wire's own inconsistency.
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Reads a finite number, or null. Never coerces a missing metric to zero. */
export function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Percentage below the official price, rounded to one decimal.
 *
 * Null when the official price is missing or zero: a discount against an
 * unknown baseline is not a number, and dividing by zero would advertise
 * every such model as infinitely cheap.
 */
export function discountPct(ask: number | null, official: number | null): number | null {
  if (ask === null || official === null || official <= 0) return null;
  return Math.round((1 - ask / official) * 1000) / 10;
}

/**
 * Groups one side's asks into ascending price tiers.
 *
 * A model with no asks at all yields an empty list, which the caller reports as
 * `providersLive: 0` — the model stays listed but is never routable.
 */
export function groupTiers(
  asks: readonly number[],
  official: number | null,
): readonly Tier[] {
  const counts = new Map<number, number>();
  for (const ask of asks) {
    if (!Number.isFinite(ask)) continue;
    const key = Math.round(ask * 10 ** PRICE_PRECISION) / 10 ** PRICE_PRECISION;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([price, avail]) => ({ price, avail, discountPct: discountPct(price, official) }));
}

/**
 * Reads `[price, providerCount]` tuples from the catalog.
 *
 * InferHub pre-aggregates tiers, so this is a read rather than a bucket-and-
 * count: one tuple is one distinct price and how many live providers offer it.
 * Money is numeric here even though `officialIn`/`officialOut` are decimal
 * strings.
 *
 * Malformed tuples are dropped rather than defaulted — a tier with an unknown
 * provider count would make `providersLive` wrong, and a wrong availability
 * number is worse than an absent one.
 */
function pricePointsToTiers(
  points: unknown,
  official: number | null,
): readonly Tier[] {
  if (!Array.isArray(points)) return [];
  const seen = new Map<number, Tier>();
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const price = num(point[0]);
    const avail = num(point[1]);
    if (price === null || avail === null) continue;
    const count = Math.max(0, Math.trunc(avail));
    const key = Math.round(price * 10 ** PRICE_PRECISION) / 10 ** PRICE_PRECISION;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // Same price from two tuples: capacities add. `Tier` is readonly, so the
      // merged tier is a new object rather than a mutation.
      seen.set(key, {
        price: existing.price,
        avail: existing.avail + count,
        discountPct: existing.discountPct,
      });
      continue;
    }
    seen.set(key, { price, avail: count, discountPct: discountPct(price, official) });
  }
  return [...seen.values()].sort((a, b) => a.price - b.price);
}

/** Cheapest price with at least `minAvail` live providers behind it. */
export function capacityWeightedPrice(
  tiers: readonly Tier[],
  minAvail: number = DEFAULT_MIN_CAPACITY,
): number | null {
  const sustainable = tiers.find((tier) => tier.avail >= minAvail);
  return sustainable?.price ?? tiers[0]?.price ?? null;
}

/**
 * Cross-prefix comparison key.
 *
 * The same model is sold under different ids per upstream (`cb/claude-opus-4.6`
 * vs `cc/claude-opus-4-6`), so comparison needs a normalized form: the last
 * path segment, lowercased, dots folded to dashes.
 */
export function aliasKeyOf(modelId: string): string {
  const segment = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  const stripped = segment.replace(/\s*\(Kiro\)/gi, "").trim().toLowerCase();
  const folded = stripped.replace(/\./g, "-");
  return MANUAL_ALIASES[folded] ?? folded;
}

/**
 * Known id pairs the mechanical fold does not unify.
 *
 * InferHub publishes its own aliases at `/api/budgets/aliases` and
 * `/api/keys/allowlist-options`; prefer those once verified against the live
 * API, and only then remove this map.
 */
const MANUAL_ALIASES: Readonly<Record<string, string>> = {
  "kimi-k2-7": "kimi-k2-7-code",
};

/** Splits `prefix/model`, tolerating a bare id. */
export function splitId(id: string): { prefix: string; modelId: string } {
  const separator = id.indexOf("/");
  if (separator === -1) return { prefix: "", modelId: id };
  return { prefix: id.slice(0, separator), modelId: id.slice(separator + 1) };
}

export function familyStateOf(value: unknown): FamilyState | null {
  const raw = str(value);
  const state = raw === null ? null : raw.toLowerCase();
  return state !== null && (FAMILY_STATES as readonly string[]).includes(state)
    ? (state as FamilyState)
    : null;
}

/**
 * Normalizes one catalog model into the market shape.
 * Returns null when the row has no usable id — an unnamed row cannot be routed
 * to or compared, and inventing one would put a phantom in the catalog.
 */
export function normalizeCatalogModel(
  raw: RawCatalogModel,
  upstream: Pick<RawUpstreamCard, "prefix" | "label" | "systemPromptNote">,
): ModelMarket | null {
  // `id` is a UUID and `upstreamModelId` is the routable slug
  // (`claude-haiku-4-5`). Only the slug is usable as a route id, so a row with
  // no slug is dropped rather than given a UUID that cannot be requested.
  const modelSlug = str(raw.upstreamModelId);
  const prefix = str(upstream.prefix) ?? "";
  if (modelSlug === null || prefix.length === 0) return null;
  const id = `${prefix}/${modelSlug}`;
  const officialIn = num(raw.officialIn);
  const officialOut = num(raw.officialOut);
  const tiersIn = pricePointsToTiers(raw.pricePointsIn, officialIn);
  const tiersOut = pricePointsToTiers(raw.pricePointsOut, officialOut);
  // Live providers is the capacity behind the cheapest tier, not a row count:
  // InferHub reports it per price, so the largest tier is the true ceiling.
  const providersLive = Math.max(
    0,
    ...tiersIn.map((tier) => tier.avail),
    ...tiersOut.map((tier) => tier.avail),
  );
  const outputModality = str(raw.outputModality);
  return {
    id,
    prefix,
    family: str(upstream.label) ?? prefix,
    modelId: modelSlug,
    aliasKey: aliasKeyOf(id),
    officialIn,
    officialOut,
    tiersIn,
    tiersOut,
    minAskIn: tiersIn[0]?.price ?? null,
    minAskOut: tiersOut[0]?.price ?? null,
    maxAskIn: tiersIn.at(-1)?.price ?? null,
    maxAskOut: tiersOut.at(-1)?.price ?? null,
    providersLive,
    // Not carried by the catalog; merged from `/api/market` by the store.
    lastRate: null,
    cacheHitRate: num(raw.cacheHitRate),
    health: {
      successRatePct: null,
      avgTtftMs: null,
      avgTps: null,
      familyState: null,
    },
    capabilities: {
      contextWindow: num(raw.contextWindow),
      maxOutputTokens: num(raw.maxOutputTokens),
      modalities: stringArray(raw.modalities),
      outputModality:
        outputModality === "image" || outputModality === "video" ? outputModality : "text",
      reasoningLevels: stringArray(raw.reasoningLevels),
      supportsCache: bool(raw.supportsCache),
    },
    systemPromptNote: str(upstream.systemPromptNote),
    // A model with no live provider is never routable; health refines this.
    routable: providersLive > 0,
  };
}

/** Merges `/api/market` numbers (lastRate, min/max asks) into catalog-derived models. */
export function mergeMarketPrices(
  models: readonly ModelMarket[],
  market: readonly RawMarketModel[],
): readonly ModelMarket[] {
  const byId = new Map<string, RawMarketModel>();
  for (const entry of market) {
    const slug = str(entry.slug);
    if (slug !== null) byId.set(slug, entry);
  }
  return models.map((model) => {
    const entry = byId.get(model.id);
    if (entry === undefined) return model;
    return {
      ...model,
      lastRate: num(entry.lastRate),
      // Market is the cheaper source for the extremes, but the catalog's tier
      // grouping is what gives them capacity, so only the nulls are filled.
      minAskIn: model.minAskIn ?? num(entry.minAskIn),
      minAskOut: model.minAskOut ?? num(entry.minAskOut),
      maxAskIn: model.maxAskIn ?? num(entry.maxAskIn),
      maxAskOut: model.maxAskOut ?? num(entry.maxAskOut),
    };
  });
}

/** Merges `/api/status` per-model health into catalog-derived models. */
export function mergeModelHealth(
  models: readonly ModelMarket[],
  status: readonly RawStatusModel[],
): readonly ModelMarket[] {
  const byId = new Map<string, RawStatusModel>();
  for (const entry of status) {
    // `/api/status` keys per-model health by `id` (`ag/claude-opus-4-6-thinking`),
    // not `slug`. Reading `slug` matched nothing, so every model reported a null
    // success rate — which the UI renders as "unknown" and sorts last, making
    // the quality ranking useless. `slug` is kept as a fallback.
    const slug = str(entry.id) ?? str(entry.slug);
    if (slug !== null) byId.set(slug, entry);
  }
  return models.map((model) => {
    const entry = byId.get(model.id);
    if (entry === undefined) return model;
    return {
      ...model,
      health: {
        ...model.health,
        successRatePct: num(entry.successRatePct),
        avgTtftMs: num(entry.avgTtftMs),
        avgTps: num(entry.avgTps),
      },
    };
  });
}

/**
 * Applies family state and recomputes routability.
 *
 * A null success rate is unknown, not bad — only a *reported* rate below the
 * threshold, a `major_outage` family, or zero live providers makes a model
 * unroutable.
 */
export function applyFamilyHealth(
  models: readonly ModelMarket[],
  families: readonly RawStatusFamily[],
  minSuccessRatePct: number,
): readonly ModelMarket[] {
  const byPrefix = new Map<string, FamilyState | null>();
  for (const family of families) {
    const prefix = str(family.prefix) ?? str(family.slug);
    if (prefix !== null) byPrefix.set(prefix, familyStateOf(family.state));
  }
  return models.map((model) => {
    const familyState = byPrefix.get(model.prefix) ?? null;
    const successRate = model.health.successRatePct;
    const healthyEnough = successRate === null || successRate >= minSuccessRatePct;
    // `undefined` (family absent from the status feed entirely) must not be
    // read as "healthy" — an unknown family is not a confirmed-good one.
    const familyUsable = familyState === null || familyState !== "major_outage";
    return {
      ...model,
      health: { ...model.health, familyState },
      routable: model.providersLive > 0 && healthyEnough && familyUsable,
    };
  });
}
