/**
 * InferHub market types.
 *
 * Two layers, deliberately separate. The raw shapes mirror the wire exactly,
 * including the split the InferHub API makes between **decimal strings**
 * (`/api/catalog`, `/api/budgets` — `$/Mtok` as `"3.5"`) and **numbers**
 * (`/api/market` — `3.5`). Collapsing them into one type is how a string price
 * silently becomes `NaN` or a number price becomes `"3.5" + 1`, so the two
 * sources have two types and never share a field.
 *
 * Everything here is untrusted remote data: labels and `systemPromptNote` arrive
 * from the marketplace and must be rendered as text, never interpolated into a
 * prompt or a URL.
 */

/** One price tier: a distinct ask and how many live providers offer it. */
export interface Tier {
  readonly price: number;
  /** Percentage below the official price; null when the official price is unknown. */
  readonly discountPct: number | null;
  /** Live providers offering this price. */
  readonly avail: number;
}

/** Upstream family health, as InferHub reports it. */
export type FamilyState = "operational" | "degraded" | "major_outage" | "low_traffic";

export interface ModelHealth {
  /** Null below InferHub's volume floor (10 requests). Null means unknown, not bad. */
  readonly successRatePct: number | null;
  /** Null below the sample floor (3 samples). */
  readonly avgTtftMs: number | null;
  readonly avgTps: number | null;
  readonly familyState: FamilyState | null;
}

interface ModelCapabilities {
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly modalities: readonly string[];
  readonly outputModality: "text" | "image" | "video";
  readonly reasoningLevels: readonly string[];
  readonly supportsCache: boolean;
}

/** One normalized marketplace model. */
export interface ModelMarket {
  /** `"cc/claude-opus-5-5"` — the prefix is load-bearing and never stripped. */
  readonly id: string;
  readonly prefix: string;
  readonly family: string;
  readonly modelId: string;
  /** Cross-prefix comparison key; see `normalize.ts`. */
  readonly aliasKey: string;
  readonly officialIn: number | null;
  readonly officialOut: number | null;
  /** Ascending by price. */
  readonly tiersIn: readonly Tier[];
  readonly tiersOut: readonly Tier[];
  readonly minAskIn: number | null;
  readonly minAskOut: number | null;
  readonly maxAskIn: number | null;
  readonly maxAskOut: number | null;
  /** Zero means no live provider — listed, but never routed to. */
  readonly providersLive: number;
  readonly lastRate: number | null;
  readonly cacheHitRate: number | null;
  readonly health: ModelHealth;
  readonly capabilities: ModelCapabilities;
  /** Untrusted remote prose describing how the upstream rewrites the system prompt. */
  readonly systemPromptNote: string | null;
  /** Whether this model may be routed to right now. */
  readonly routable: boolean;
}

/** Per-upstream-family summary for the providers view. */
export interface ProviderMarket {
  readonly prefix: string;
  readonly family: string;
  readonly activeProviders: number;
  readonly familyState: FamilyState | null;
  readonly availability24hPct: number | null;
  readonly availability7dPct: number | null;
  readonly p50DurationMs: number | null;
  readonly p95DurationMs: number | null;
  readonly avgTtftMs1h: number | null;
  readonly avgTps1h: number | null;
}

/** Platform pricing configuration. */
export interface PricingConfig {
  readonly maxAskPctOfOfficial: number | null;
  readonly platformFeePct: number | null;
  readonly publisherSharePct: number | null;
}

/** Which upstream a snapshot came from, and when. */
export type InferhubSource = "market" | "status" | "catalog" | "pricingConfig";

/** A snapshot plus its freshness, as the API reports it. */
export interface SnapshotMeta {
  readonly fetchedAt: number;
  readonly ageSeconds: number;
  /** True when the snapshot is older than its freshness window. */
  readonly stale: boolean;
}

// ── Raw wire shapes ────────────────────────────────────────────────────────

/** `GET /api/market` — money is numeric here. */
export interface RawMarketModel {
  readonly slug?: unknown;
  readonly family?: unknown;
  readonly minAskIn?: unknown;
  readonly minAskOut?: unknown;
  readonly maxAskIn?: unknown;
  readonly maxAskOut?: unknown;
  readonly lastRate?: unknown;
}

/** `GET /api/catalog` — money is a decimal string here. */
export interface RawCatalogModel {
  readonly id?: unknown;
  /** The routable slug, e.g. `claude-haiku-4-5`. `id` is a UUID. */
  readonly upstreamModelId?: unknown;
  readonly label?: unknown;
  readonly officialIn?: unknown;
  readonly officialOut?: unknown;
  /**
   * `[price, providerCount]` tuples — InferHub pre-aggregates tiers, so one
   * entry is one distinct price and its live-provider count. Money is numeric
   * here even though `officialIn`/`officialOut` are decimal strings.
   */
  readonly pricePointsIn?: unknown;
  readonly pricePointsOut?: unknown;
  readonly asksIn?: unknown;
  readonly asksOut?: unknown;
  readonly enabled?: unknown;
  readonly modelDisabled?: unknown;
  readonly supportsCache?: unknown;
  readonly cacheHitRate?: unknown;
  readonly contextWindow?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly reasoningLevels?: unknown;
  readonly modalities?: unknown;
  readonly outputModality?: unknown;
}

export interface RawUpstreamCard {
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly prefix?: unknown;
  readonly label?: unknown;
  readonly status?: unknown;
  readonly activeProviders?: unknown;
  readonly systemPromptNote?: unknown;
  readonly models?: unknown;
}

/** `GET /api/status` — per-model health and per-family state. */
export interface RawStatusModel {
  /** The full `prefix/model` key. `slug` is the fallback for older payloads. */
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly successRatePct?: unknown;
  readonly avgTtftMs?: unknown;
  readonly avgTps?: unknown;
}

export interface RawStatusFamily {
  readonly slug?: unknown;
  readonly prefix?: unknown;
  /** Display name, e.g. `Antigravity`. `slug` is the lowercase key. */
  readonly family?: unknown;
  readonly currentAvailabilityPct?: unknown;
  readonly state?: unknown;
  readonly availability24hPct?: unknown;
  readonly availability7dPct?: unknown;
  readonly p50DurationMs?: unknown;
  readonly p95DurationMs?: unknown;
  readonly avgTtftMs1h?: unknown;
  readonly avgTps1h?: unknown;
}
