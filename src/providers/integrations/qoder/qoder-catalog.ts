// Qoder model catalogs, one per realm, plus the live listing that supersedes them.
//
// The two realms publish different rosters: the donor's snapshot files
// (`qoder_catalog_cn.json`, `qoder_catalog_intl.json`) disagree on 5 keys and on
// the context window of the keys they share. A single merged list therefore
// advertises models a given account cannot reach, and hides the ones only the
// other realm serves — so each realm keeps its own static floor.
//
// The static rows are the *offline floor*, not the truth: the authoritative list
// is `/algo/api/v2/model/list` for the account's own realm (`discoverQoderModels`).
import { GatewayError } from "../../../protocol/gateway-error";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import { QODER_CHAT_PATH, QODER_MODELS_PATH, qoderGatewayCandidates, type QoderRealm } from "./qoder-realm";
import { qoderVirtualIdFor, QODER_PROVIDER_WARNINGS, QODER_VIRTUAL_MODELS } from "./qoder-virtual";

/** One upstream catalog row, as `/algo/api/v2/model/list` reports it. */
export interface QoderCatalogEntry {
  readonly key: string;
  readonly displayName: string;
  readonly isVl: boolean;
  readonly isReasoning: boolean;
  /**
   * Largest window this model can be switched to.
   *
   * Upstream states two different numbers: `max_input_tokens` is the window
   * *currently selected* (often 180k), while `context_config` lists the
   * selectable windows — `{"200K":…, "400K":…, "1M":…}` — which for the same
   * row go up to 1M. Taking `max_input_tokens` alone published and dispatched
   * the smaller figure, so Qoder was told the conversation was 180k when the
   * account could use 1M.
   */
  readonly maxInputTokens: number | undefined;
  readonly enable: boolean;
  /**
   * Whether upstream publishes this row as free.
   *
   * Qoder states it per row (`is_free`) and it is not inferable: `price_factor`
   * is 0 on both free and some billed rows, and the lite-plan flag describes a
   * plan tier rather than a model. So the free tier is read from this field
   * instead of being hardcoded as a list, which is what lets a plan change
   * move a model between tiers without a code change.
   */
  readonly isFree: boolean;
}

/**
 * The widest selectable window on one catalog row.
 *
 * `context_config` is the authority when present: it names every window the
 * account can switch to, whereas `max_input_tokens` only names the one active
 * now. Absent both, `undefined` — an unknown window is not zero.
 */
export function qoderMaxContextWindow(raw: unknown): number | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const candidates: number[] = [];
  const config = record["context_config"];
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    for (const option of Object.values(config as Record<string, unknown>)) {
      if (option === null || typeof option !== "object" || Array.isArray(option)) continue;
      const tokenCount = (option as Record<string, unknown>)["token_count"];
      if (typeof tokenCount === "number" && Number.isFinite(tokenCount) && tokenCount > 0) {
        candidates.push(Math.floor(tokenCount));
      }
    }
  }
  const stated = record["max_input_tokens"];
  if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) {
    candidates.push(Math.floor(stated));
  }
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/** One static row's shape, mirrored on `QODER_MODEL_CONFIGS` in `qoder.ts`. */
interface QoderModelConfig {
  readonly id: string;
  readonly display_name: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens?: number;
  readonly is_vl: boolean;
  readonly is_reasoning: boolean;
  /**
   * Whether upstream publishes this row as free. Absent means upstream did not
   * state it for the row, which is not the same as false — only an explicit
   * `false` marks the model as billed.
   */
  readonly is_free?: boolean;
  /**
   * The reasoning effort to send when the caller did not ask for one. The IDE
   * surface follows the `reasoningEffort` field: a model marked `is_reasoning`
   * may still stream no reasoning unless an effort is present (verified live:
   * Sonus streams thinking only when effort is sent; DeepSeek thinks by
   * default). Set only for models that need the push.
   */
  readonly default_reasoning_effort?: string;
}

/**
 * China roster (14 keys).
 *
 * Captured from the donor's `qoder_catalog_cn.json`, which is the decoded
 * `chat` array of a real CN account's model list.
 */
export const QODER_CN_MODEL_CONFIGS: Readonly<Record<string, QoderModelConfig>> = {
  auto: { id: "auto", display_name: "Auto", max_output_tokens: 64000, max_input_tokens: 200000, is_vl: true, is_reasoning: true },
  qmodel_38max: { id: "qmodel_38max", display_name: "Qwen3.8-Max", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  qfmodel: { id: "qfmodel", display_name: "Qwen3.8-Flash", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen3.7-Max", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  qmodel: { id: "qmodel", display_name: "Qwen3.7-Plus", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  q37fmodel: { id: "q37fmodel", display_name: "Qwen3.7-Flash", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  dmodel: { id: "dmodel", display_name: "DeepSeek-V4-Pro", max_output_tokens: 384000, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  dfmodel: { id: "dfmodel", display_name: "DeepSeek-Flash", max_output_tokens: 384000, max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  gmodel: { id: "gmodel", display_name: "GLM-5.3", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  gfmodel: { id: "gfmodel", display_name: "GLM-5.3-Flash", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  gm51model: { id: "gm51model", display_name: "GLM-5.2", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi-K3", max_output_tokens: 131072, max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  kmodel: { id: "kmodel", display_name: "Kimi-K2.8-Preview", max_output_tokens: 65536, max_input_tokens: 1000000, is_vl: true, is_reasoning: true },
  mmodel: { id: "mmodel", display_name: "MiniMax-M2.7", max_output_tokens: 131072, max_input_tokens: 200000, is_vl: false, is_reasoning: false },
};

/**
 * Global/intl roster (18 keys), from the donor's `qoder_catalog_intl.json`.
 *
 * Note how the shared keys differ from CN — `auto` is non-reasoning here and
 * `qmodel` carries a 1M window. That is why the rosters are not merged.
 */
export const QODER_INTL_MODEL_CONFIGS: Readonly<Record<string, QoderModelConfig>> = {
  // Every row declares its *maximum selectable* window (1M), not the currently
  // active one: Qoder publishes a `context_config` of selectable windows per
  // row (1M/400K/200K/…), and the adapter dispatches the widest
  // (`qoderMaxContextFor`). The live list's `max_input_tokens` only names the
  // currently-selected window (often 180K/200K), which is not a ceiling —
  // declaring that would cap a conversation a 1M-capable account could run.
  auto: { id: "auto", display_name: "Auto", max_input_tokens: 1000000, max_output_tokens: 64_000, is_vl: true, is_reasoning: false },
  ultimate: { id: "ultimate", display_name: "Ultimate", max_input_tokens: 1000000, max_output_tokens: 128_000, is_vl: true, is_free: false, is_reasoning: true },
  // `fast` is what the live roster reports today; `performance` is the older
  // key for the same slot. Both are kept so a hand-added model id written
  // against either name still resolves — the roster is the offline floor, and
  // discovery supersedes it on the first successful fetch.
  fast: { id: "fast", display_name: "Fast", max_input_tokens: 1000000, max_output_tokens: 64_000, is_vl: true, is_reasoning: false },
  performance: { id: "performance", display_name: "Performance", max_input_tokens: 1000000, max_output_tokens: 64_000, is_vl: true, is_reasoning: false },
  efficient: { id: "efficient", display_name: "Efficient", max_input_tokens: 1000000, max_output_tokens: 64_000, is_vl: true, is_reasoning: false },
  // Sonus/Cantus need an explicit effort on the IDE surface; without it the
  // upstream streams text only, no reasoning (verified live). DeepSeek-family
  // models think by default and are left untouched.
  smodel: { id: "smodel", display_name: "Sonus", max_input_tokens: 1000000, max_output_tokens: 128_000, is_vl: true, is_free: false, is_reasoning: true, default_reasoning_effort: "high" },
  cmodel: { id: "cmodel", display_name: "Cantus", max_input_tokens: 1000000, max_output_tokens: 128_000, is_vl: true, is_free: false, is_reasoning: true, default_reasoning_effort: "high" },
  qmodel_38max: { id: "qmodel_38max", display_name: "Qwen3.8-Max", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_reasoning: true },
  // `qfmodel` is billed, not free: upstream's live `is_free: true` for this
  // slot is a plan-tier flag, not a zero-cost tier — a free account gets
  // `quota exceeded` (116) when dispatching it. The only truly free slot is
  // `lite`. Do not re-add `is_free` here.
  qfmodel: { id: "qfmodel", display_name: "Qwen3.8-Flash", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_reasoning: true },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen3.7-Max", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_reasoning: false },
  qmodel: { id: "qmodel", display_name: "Qwen3.7-Plus", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_reasoning: false },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi-K3.1-Pro", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_free: false, is_reasoning: false },
  kmodel: { id: "kmodel", display_name: "Kimi-K2.8-Preview", max_input_tokens: 1000000, max_output_tokens: 65_536, is_vl: true, is_free: false, is_reasoning: false },
  gmodel: { id: "gmodel", display_name: "GLM-5.3", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_free: false, is_reasoning: true },
  gfmodel: { id: "gfmodel", display_name: "GLM-5.3-Flash", max_input_tokens: 1000000, max_output_tokens: 131_072, is_vl: true, is_reasoning: true },
  dmodel: { id: "dmodel", display_name: "DeepSeek-V4-Pro", max_input_tokens: 1000000, max_output_tokens: 384_000, is_vl: true, is_free: false, is_reasoning: true },
  // Live roster (2026-11-01) reports dfmodel as billed (is_free false); it was
  // previously marked free. Display names are corrected from the same capture.
  dfmodel: { id: "dfmodel", display_name: "DeepSeek-Flash", max_input_tokens: 1000000, max_output_tokens: 384_000, is_vl: true, is_free: false, is_reasoning: true },
  mmodel: { id: "mmodel", display_name: "MiniMax-M3.1-Flash", max_input_tokens: 1000000, max_output_tokens: 512_000, is_vl: true, is_free: false, is_reasoning: true },
  // `lite` is the free-tier plan package: same 1M window and multimodal input
  // as `qmodel` (Qwen3.7-Plus), capped at 64k output, free tier.
  lite: { id: "lite", display_name: "Lite-Qwen-3.7-Plus", max_input_tokens: 1000000, max_output_tokens: 65_536, is_vl: true, is_free: true, is_reasoning: false },
};

/**
 * Output ceilings are stated per row, not derived.
 *
 * Qoder's `/model/list` reports no output limit at all — none of the 21 fields
 * it returns for any row mentions output — so these come from the static
 * roster, set to what the same model is filed at elsewhere in the catalog
 * (DeepSeek-V4 at 384k, GLM/Qwen/Kimi/MiniMax at 131k, the GPT-class slots at
 * 128k). Hardcoding one ceiling here would apply it to every row alike and make
 * the whole catalog look capped at that number.
 *
 * A row with no stated ceiling leaves `out` unset so `defineModel` can still
 * consult the base catalog rather than publishing a guess.
 */

function qoderModels(
  configs: Readonly<Record<string, QoderModelConfig>>,
  providerId: string,
): readonly ModelDefinition[] {
  return Object.entries(configs).map(([id, cfg]) =>
    defineModel({
      id,
      providerId,
      wireFamily: "chat",
      endpoint: QODER_CHAT_PATH,
      ctx: cfg.max_input_tokens,
      ...(cfg.max_output_tokens === undefined ? {} : { out: cfg.max_output_tokens }),
      vision: cfg.is_vl,
      reasoning: cfg.is_reasoning,
      // Only an explicit `true` marks the row free; an unstated flag is left
      // unset so nothing claims a tier the roster did not state.
      ...(cfg.is_free === undefined ? {} : { free: cfg.is_free, freeTier: cfg.is_free }),
      // Provider-level caveats, not per-model claims (D37).
      warnings: QODER_PROVIDER_WARNINGS,
    }),
  );
}

/** Static offline catalog for the China realm. */
export const QODER_CN_MODELS: readonly ModelDefinition[] = qoderModels(QODER_CN_MODEL_CONFIGS, "qodercn");

/** Static offline catalog for the global/intl realm. */
const QODER_INTL_ROSTER: readonly ModelDefinition[] = qoderModels(QODER_INTL_MODEL_CONFIGS, "qoder");

/**
 * Virtual rows, one per roster key that has a caller-facing name.
 *
 * A virtual row inherits its target's limits and capabilities rather than
 * restating them: the two ids are the same upstream model, so a window or a
 * vision flag that disagreed between them would be a lie in one of the two
 * places. A target this realm does not serve contributes no row, which is what
 * keeps the CN and intl catalogs honest about their own rosters.
 */
export function qoderVirtualModels(
  roster: readonly ModelDefinition[],
  providerId: string,
): readonly ModelDefinition[] {
  const byId = new Map(roster.map((row) => [row.modelId, row]));
  const rows: ModelDefinition[] = [];
  for (const virtual of QODER_VIRTUAL_MODELS) {
    const target = byId.get(virtual.target);
    if (target === undefined) continue;
    rows.push(
      defineModel({
        id: virtual.id,
        providerId,
        wireFamily: "chat",
        endpoint: QODER_CHAT_PATH,
        // `null`, not a number: an unknown window is unknown, and `defineModel`
        // substitutes the shared unfiled fallback for null — the same marker a
        // hand-added row gets.
        ctx: target.contextLimit ?? null,
        // A virtual override wins; otherwise inherit the target's ceiling.
        ...(virtual.outputLimit !== undefined
          ? { out: virtual.outputLimit }
          : target.outputLimit === null
            ? {}
            : { out: target.outputLimit }),
        vision: virtual.vision ?? target.modalities.input.includes("image"),
        reasoning: target.reasoning ?? false,
        toolCall: target.toolCall ?? false,
        // The same model under its caller-facing name belongs to the same tier,
        // so the pill follows the roster row rather than being restated —
        // unless the virtual card explicitly overrides it (`lite` is a free
        // plan package over a billed slot).
        ...(virtual.free !== undefined
          ? { free: virtual.free, freeTier: virtual.free }
          : target.freeTier === undefined
            ? {}
            : { free: target.freeTier, freeTier: target.freeTier }),
        warnings: QODER_PROVIDER_WARNINGS,
      }),
    );
  }
  return rows;
}

/**
 * Static offline catalog for the global/intl realm.
 *
 * A roster key that has a caller-facing name is published under that name
 * only: upstream's keys are opaque slots (`dfmodel`, `cmodel`), and offering
 * both the slot and its name shows one model twice under two ids nobody can
 * tell apart. A key with no known name is kept as-is — an unnamed slot is
 * still reachable, and inventing a name for it would assert what upstream
 * never stated.
 *
 * The key remains what dispatch sends; see `qoder-virtual.ts`.
 */
export const QODER_INTL_MODELS: readonly ModelDefinition[] = [
  ...QODER_INTL_ROSTER.filter((row) => qoderVirtualIdFor(row.modelId) === undefined),
  ...qoderVirtualModels(QODER_INTL_ROSTER, "qoder"),
];

/**
 * Reads upstream's `{"chat": [...]}` envelope.
 *
 * Rows without a usable `key` are dropped rather than coerced: a model id the
 * upstream did not state would become an unroutable catalog row.
 */
export function mapQoderCatalogResponse(raw: unknown): QoderCatalogEntry[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const chat = (raw as Record<string, unknown>)["chat"];
  if (!Array.isArray(chat)) return [];
  const entries: QoderCatalogEntry[] = [];
  for (const row of chat) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const key = record["key"];
    if (typeof key !== "string" || key.trim().length === 0) continue;
    const displayName = record["display_name"];
    entries.push({
      key: key.trim(),
      displayName: typeof displayName === "string" && displayName.length > 0 ? displayName : key.trim(),
      isVl: record["is_vl"] === true,
      isReasoning: record["is_reasoning"] === true,
      maxInputTokens: qoderMaxContextWindow(record),
      isFree: record["is_free"] === true,
      // Absent means "not stated", which is not the same as disabled.
      enable: record["enable"] !== false,
    });
  }
  return entries;
}

/**
 * The static roster's stated output ceiling for one slot, when the roster
 * states one.
 *
 * Upstream's live `/model/list` rows report no output limit, so a discovered
 * row cannot read one from the wire. Inheriting the roster's number keeps the
 * discovered row's `outputLimit` honest — without it `defineModel` falls back
 * to a base-catalog/majority vote that can sit below the roster's ceiling
 * (e.g. `qwen3.7-plus` votes 64k while the roster says 131k).
 */
export function qoderRosterMaxOutput(providerId: string, key: string): number | undefined {
  const configs = providerId === "qodercn" ? QODER_CN_MODEL_CONFIGS : QODER_INTL_MODEL_CONFIGS;
  return configs[key]?.max_output_tokens;
}

/** Projects one live catalog row onto a Cartethyia catalog row. */
export function qoderCatalogModel(
  entry: QoderCatalogEntry,
  providerId: string,
): ModelDefinition {
  const rosterOutput = qoderRosterMaxOutput(providerId, entry.key);
  return defineModel({
    id: entry.key,
    providerId,
    wireFamily: "chat",
    endpoint: QODER_CHAT_PATH,
    // `null`, not omitted: an upstream row that stated no window is unknown,
    // not unlimited, and `defineModel` substitutes its own "unfiled" estimate
    // for null — the same marker a hand-added row gets.
    ctx: entry.maxInputTokens ?? null,
    vision: entry.isVl,
    reasoning: entry.isReasoning,
    // Free tier straight from upstream's own flag, so the pill on a model card
    // tracks the plan rather than a hardcoded id list. Both statements hold:
    // a free row bills zero per token and belongs to the provider's free tier.
    free: entry.isFree,
    freeTier: entry.isFree,
    // The live row carries no output ceiling, so inherit the static roster's
    // stated one when it exists (see `qoderRosterMaxOutput`).
    ...(rosterOutput === undefined ? {} : { out: rosterOutput }),
    warnings: QODER_PROVIDER_WARNINGS,
  });
}

/**
 * Header factory for one signed request.
 *
 * Injected rather than imported: the COSY signer lives in `qoder.ts`, which
 * imports this module's rosters — importing it back would be a cycle. The
 * callback receives the URL and the exact body that will be sent, because the
 * signature covers both.
 */
export type QoderSigner = (url: string, body: string) => Promise<Record<string, string>>;

/**
 * The account's own live model list.
 *
 * Two details are load-bearing and non-obvious:
 *
 * - the request is a **GET that carries the signed body**. A bare GET answers
 *   403, because the server validates signature against body; the donor
 *   (`read_dynamic_models`) signs `{}` and sends it as the GET's data.
 * - the signature covers only the path, so switching gateway hosts between
 *   attempts does not invalidate it.
 *
 * Hosts are tried primary → fallbacks (intl has three, CN one) and the first
 * host that answers with a usable list wins.
 *
 * Signing is injected, never reimplemented: `headers(url, body)` is the COSY
 * signer from `qoder.ts`, passed in because that module imports this one and
 * importing it back would be a cycle. `encode` is the same arrangement for
 * Qoder's scrambled body alphabet — omitted, the literal `{}` is both signed
 * and sent, which is what a caller whose signer already binds the credential
 * wants.
 *
 * `fetcher` is optional in the type but required at runtime, and there is
 * deliberately no global-`fetch` default: a test cannot reach the network by
 * accident, and production is forced through the SSRF-validated egress
 * (`network/outbound-fetch.ts`). That egress is a `node:http` path, which is
 * also the only way a body reaches the wire on a GET — `fetch` itself rejects
 * `GET` + `body` with "request with GET/HEAD method cannot have body".
 */
/**
 * How long one realm's live list is reused, in milliseconds.
 *
 * The roster is account-wide and changes rarely — upstream adds or retires a
 * key, it does not reshuffle per request — so every catalog refresh inside the
 * window would re-sign and re-fetch an identical list. The donor caches the
 * same way (`fetch_models`, 300 s per realm).
 */
const DISCOVERY_CACHE_TTL_MS = 300_000;

/** One realm's cached roster, with the instant it was read. */
interface CachedRoster {
  readonly at: number;
  readonly models: readonly ModelDefinition[];
}

/** Per-realm live-list cache; keyed by realm, not by account. */
const discoveryCache = new Map<QoderRealm, CachedRoster>();

/**
 * Per-realm max-context window per roster key, taken from the live list's
 * `context_config` (the widest selectable window). This is what dispatch reads
 * to send `model_config.max_input_tokens`; without it the request would use the
 * static roster's *currently active* window (often 180k) instead of the max.
 */
const discoveryMaxContextByKey = new Map<QoderRealm, Map<string, number>>();

/**
 * Drops one realm's cached list.
 *
 * Exported for tests: the cache is module state, so a test that builds a
 * roster and then asserts a fresh fetch would otherwise read the entry the
 * previous assertion left behind.
 */
export function resetQoderDiscoveryCache(realm?: QoderRealm): void {
  if (realm === undefined) {
    discoveryCache.clear();
    discoveryMaxContextByKey.clear();
  } else {
    discoveryCache.delete(realm);
    discoveryMaxContextByKey.delete(realm);
  }
}

/**
 * The widest selectable context window per roster key for one realm, from the
 * live model list. Empty when discovery has not succeeded for that realm yet.
 */
export function qoderDiscoveredMaxContexts(realm: QoderRealm): ReadonlyMap<string, number> {
  return discoveryMaxContextByKey.get(realm) ?? new Map();
}

/**
 * The widest selectable context window for one model key.
 *
 * The live list's `context_config` is the authority when discovery has run:
 * it names every window the account can switch to, and the widest one is what
 * a dispatch should send (`model_config.max_input_tokens`) so a conversation is
 * never capped at the *currently active* window (often 180k) when the account
 * can use 1M. Falls back to the static roster's stated window otherwise.
 */
export function qoderMaxContextFor(modelId: string, modelConfig: QoderModelConfig, realm: QoderRealm): number {
  const discovered = qoderDiscoveredMaxContexts(realm).get(modelId);
  if (discovered !== undefined) return discovered;
  return modelConfig.max_input_tokens;
}

export async function discoverQoderModels(input: {
  readonly realm: QoderRealm;
  /** Account secret the injected signer signs with; blank fails fast. */
  readonly credential: string;
  readonly headers: QoderSigner;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  /** Defaults to the realm's bundled provider id (`qodercn` | `qoder`). */
  readonly providerId?: string;
  /** Body encoder; Qoder uses its own scrambled base64 alphabet. */
  readonly encode?: (body: Uint8Array) => string;
}): Promise<readonly ModelDefinition[]> {
  const providerId = input.providerId ?? (input.realm === "cn" ? "qodercn" : "qoder");
  const cached = discoveryCache.get(input.realm);
  if (cached !== undefined && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) {
    return cached.models;
  }
  // The credential belongs to the caller and is never echoed into `details`;
  // this only refuses the case where discovery was asked for without one,
  // which would otherwise surface as an opaque 403 from upstream.
  if (typeof input.credential !== "string" || input.credential.trim().length === 0) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Qoder model discovery requires an account credential (request {requestId}). Wrong key, right door — check the credential 🔑",
      { providerId, realm: input.realm },
    );
  }
  const fetcher = input.fetcher;
  if (fetcher === undefined) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Qoder model discovery requires a validated outbound fetch (request {requestId}). No bridge to cross — configure a pool first 🏗️",
      { providerId, realm: input.realm },
    );
  }
  const signedBody =
    input.encode === undefined ? "{}" : input.encode(new TextEncoder().encode("{}"));
  let lastError: unknown;
  for (const host of qoderGatewayCandidates(input.realm)) {
    const url = `${host}${QODER_MODELS_PATH}`;
    try {
      const headers = await input.headers(url, signedBody);
      // GET, not POST: upstream refuses POST on the model-list surface (400
      // "Request method 'POST' not supported"). The signature covers the body,
      // so the body must accompany the GET. The gateway's validated egress
      // dials GET+body through the Node http(s) client (the runtime fetch
      // rejects GET bodies), which is exactly the shape the donor client sends.
      const response = await fetcher(url, {
        method: "GET",
        headers: headers as unknown as HeadersInit,
        // The signed body must accompany the GET or upstream refuses it.
        body: signedBody,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!response.ok) {
        lastError = new Error(`Qoder model list answered ${response.status}`);
        continue;
      }
      const entries = mapQoderCatalogResponse((await response.json()) as unknown);
      // Emptiness is judged after `enable` filtering, not before: a roster
      // whose every row is disabled has no usable model and must fall through
      // to the next host rather than return an empty catalog.
      const enabled = entries.filter((entry) => entry.enable);
      if (enabled.length === 0) {
        lastError = new Error("Qoder model list returned no usable models");
        continue;
      }
      const models = enabled.flatMap((entry) => {
        // Publish caller-facing virtual ids (`sonus`, `lite-qwen-3.7-plus`, …)
        // instead of the opaque roster keys (`smodel`, `qmodel`, …). A discovery
        // row must look like what the UI offers and what a caller can type;
        // keeping the raw key here made live-synced rows appear under names
        // nobody can route to by display, and hid overridden cards like `lite`.
        // More than one virtual may share a slot (`lite-qwen-3.7-plus` and
        // `qwen3.7-plus` both dispatch to `qmodel`), so every match on the slot
        // is published.
        const virtuals = QODER_VIRTUAL_MODELS.filter((virtual) => virtual.target === entry.key);
        if (virtuals.length === 0) return [qoderCatalogModel(entry, providerId)];
        const rosterOutput = qoderRosterMaxOutput(providerId, entry.key);
        return virtuals.map((virtual) =>
          defineModel({
            id: virtual.id,
            providerId,
            wireFamily: "chat",
            endpoint: QODER_CHAT_PATH,
            ctx: entry.maxInputTokens ?? null,
            vision: virtual.vision ?? entry.isVl,
            reasoning: entry.isReasoning,
            // A virtual override wins; otherwise inherit the static roster's
            // ceiling for the slot instead of a base-catalog/majority estimate
            // (see `qoderRosterMaxOutput`).
            ...(virtual.outputLimit !== undefined
              ? { out: virtual.outputLimit }
              : rosterOutput === undefined
                ? {}
                : { out: rosterOutput }),
            free: virtual.free ?? entry.isFree,
            freeTier: virtual.free ?? entry.isFree,
            warnings: QODER_PROVIDER_WARNINGS,
          }),
        );
      });
      // Index the widest selectable window per key (from `context_config`,
      // already computed into `maxInputTokens` by `mapQoderCatalogResponse`) so
      // dispatch can send the maximum rather than the currently active one.
      const maxCtx = new Map<string, number>();
      for (const entry of enabled) {
        if (entry.maxInputTokens !== undefined && entry.key.length > 0) {
          maxCtx.set(entry.key, entry.maxInputTokens);
        }
      }
      // Cached only after a host actually answered: a failure must stay
      // retryable on the next call rather than being frozen for five minutes.
      discoveryCache.set(input.realm, { at: Date.now(), models });
      discoveryMaxContextByKey.set(input.realm, maxCtx);
      return models;
    } catch (error) {
      lastError = error;
    }
  }
  throw new GatewayError(
    "transport_unavailable",
    502,
    `Qoder model discovery failed for ${input.realm} (request {requestId}): ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }. The connection ghosted us — come back in a moment 👻`,
    { providerId, realm: input.realm },
    "upstream",
  );
}
