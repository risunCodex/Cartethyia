import { createApiKeyAdapter } from "../../configured-provider";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext } from "../../provider-contracts";
import type { ModelDefinition } from "../../provider-model-definition";
import { unwrapProviderToken } from "../../provider-credential-envelope";
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { completeRequiredSchema, isRecord } from "../../../protocol/codecs";
import { providerBaseUrl } from "../../provider-metadata";
import { getCachedModelDiscovery } from "../../operations/model-discovery-cache";
import { defineModel } from "../../provider-model-definition";
import { clineReasoningReplayPrepares } from "../buddy/buddy-chat-shared";
import { clinePlatform, clinePlatformVersion } from "../../operations/cli-platform";
import {
  getClineCliVersion,
  getClineSdkVersion,
} from "../../operations/client-versions";
export const CLINE_BASE_URL = providerBaseUrl("cline");
export const CLINE_PROVIDER_ID = "cline" as const;
const CLINE_CHAT_PATH = "/chat/completions" as const;
const CLINE_RECOMMENDED_MODELS_PATH = "/ai/cline/recommended-models" as const;
/** The OpenAI-style listing; its `:free` suffix is a second free-tier roster. */
const CLINE_MODELS_LIST_PATH = "/models" as const;
/**
 * Cline's own model catalog. Unlike the roster above it states `context_length`
 * and `top_provider.max_completion_tokens`, so it is the authority for limits.
 */
const CLINE_MODELS_CATALOG_PATH = "/ai/cline/models" as const;



export function workosToken(token: string): string {
  return token.startsWith("workos:") ? token : `workos:${token}`;
}

// Cartethyia expresses this as a per-dispatch buildExtraHeaders hook so every
// request gets fresh client-version headers.
// API-key credentials use direct Bearer format (no workos prefix);
// OAuth and scoped credentials retain the required workos: prefix.

async function clineExtraHeaders(context: ProviderDispatchContext): Promise<Record<string, string>> {
  let authOverride: Record<string, string> = {};
  const secret = context.credential.secret;
  if (secret && secret.length > 0) {
    const raw = new TextDecoder().decode(secret).trim();
    if (raw.length > 0) {
      // Bearer-strip delegates to the single token-envelope implementation.
      const normalized = new TextDecoder().decode(unwrapProviderToken(raw, "bearer"));
      const kind = context.credential.credential_kind;
      const token = kind === "api_key" ? normalized : workosToken(normalized);
      authOverride = { authorization: `Bearer ${token}` };
    }
  }
  // The chat surface claims the CLI identity, matching the billing surface in
  // `cline-quota.ts` and the reference client: `cline` (npm, bin `cline`) is a
  // separate release line from the VS Code extension, so the client version
  // must come from the CLI package, not the extension manifest. `@cline/sdk`
  // is a dependency of the CLI, so its version stays the core version.
  const clientVersion = getClineCliVersion();
  const sdkVersion = getClineSdkVersion();
  // Cline's own client sends `X-Task-ID` on inference calls as the stable
  // prompt-cache/session key, and omits it on account and discovery calls
  // rather than inventing a per-request identity. `conversation_affinity` is
  // that same value here: stable across the retries of one conversation, so a
  // retried dispatch keeps its cache entry instead of starting a new one.
  const taskId = context.conversation_affinity;

  return {
    ...authOverride,
    "user-agent": `Cline/${clientVersion}`,
    // One spelling only. Header names are case-insensitive, so sending both
    // `http-referer` and `HTTP-Referer` does not hedge against a case-sensitive
    // check — it makes `Headers` merge them into the single value
    // `https://cline.bot, https://cline.bot`.
    "HTTP-Referer": "https://cline.bot",
    "x-platform": clinePlatform(),
    "x-platform-version": clinePlatformVersion(),
    "x-title": "Cline",
    "x-client-type": "cline-cli",
    "x-client-version": clientVersion,
    "x-core-version": sdkVersion,
    "X-Title": "Cline",
    "x-is-multi-root": "false",
    ...(taskId ? { "x-task-id": taskId } : {}),
    accept: "text/event-stream, application/json",
  };
}

// System-prompt injection and materialized-stream handling.
// Cline requires a system/developer message for compatibility; its upstream
// free models also reject empty system content, so the fallback is concise.

function completeClineToolSchemas(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.tools)) return;
  payload.tools = payload.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const functionValue = tool.function;
    if (isRecord(functionValue) && "parameters" in functionValue) {
      return {
        ...tool,
        function: { ...functionValue, parameters: completeRequiredSchema(functionValue.parameters) },
      };
    }
    if ("parameters" in tool) return { ...tool, parameters: completeRequiredSchema(tool.parameters) };
    return tool;
  });
}

function clinePrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): void {
  completeClineToolSchemas(payload);
  // 1) Ensure system/developer messages always carry non-empty content.
  const rawMessages = payload["messages"];
  const messages: Record<string, unknown>[] = Array.isArray(rawMessages)
    ? rawMessages.filter(isRecord).map((message) => {
        const role = message["role"];
        const content = message["content"];
        const emptyContent =
          content === undefined ||
          content === null ||
          (typeof content === "string" && content.trim().length === 0) ||
          (Array.isArray(content) && content.length === 0);
        return (role === "system" || role === "developer") && emptyContent
          ? { ...message, content: "You are a helpful assistant." }
          : message;
      })
    : [];
  const hasSystem = messages.some(
    (message) => message["role"] === "system" || message["role"] === "developer",
  );
  payload["messages"] = hasSystem
    ? messages
    : [{ role: "system", content: "You are a helpful assistant." }, ...messages];

  // 1.5) DeepSeek-replay backfill: Cline resells thinking models (deepseek,
  // reflection/beam) whose upstream rejects the whole history when any prior
  // assistant turn lacks `reasoning_content`. Same wire as OpenRouter/Hermes/
  // Kilo, so the shared helper runs here too — it only mirrors a real trace.
  for (const prepare of clineReasoningReplayPrepares) prepare(payload);

  // 2) Materialize deepseek-v4-flash non-stream quirk
  const model = typeof payload["model"] === "string" ? (payload["model"] as string) : candidate.model_id;
  const needsMaterialize = !request.stream && model.includes("deepseek-v4-flash");
  if (needsMaterialize) {
    payload["stream"] = true;
    // Set reasoning_effort to none for this model to suppress reasoning streaming
    payload["reasoning_effort"] = "none";
    const cur = typeof payload["max_tokens"] === "number" ? (payload["max_tokens"] as number) : 0;
    payload["max_tokens"] = Math.max(cur, 256);
    // keep GatewayError reachable
    if (!model) throw new GatewayError("invalid_request", 400, "Cline model is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
}

// (modelEntries / recommendedModels / fetchRecommendedModels) preserved
// as Cartethyia discovery helpers. The factory's discovery endpoint is wired
// to /ai/cline/recommended-models; these helpers can be used by a custom
// discovery layer or tests. Keeping them guarantees the custom tag→vision
// logic and clinePass vs free branching are not lost in the port.

interface ClineRecommendedModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
}

interface ClineRecommendedPayload {
  readonly recommended?: unknown;
  readonly free?: unknown;
  readonly clinePass?: unknown;
  readonly clineCloud?: unknown;
}

function modelEntries(value: unknown): readonly ClineRecommendedModel[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ClineRecommendedModel => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function recommendedModels(
  value: unknown,
  pass: boolean,
  upstream: ReadonlyMap<string, ClineUpstreamLimits> = new Map(),
  freeIds: readonly string[] | null = null,
): readonly ModelDefinition[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const payload = value as ClineRecommendedPayload;
  // The endpoint publishes four buckets: `recommended` (the current picks),
  // `free` (the zero-cost tier), `clinePass` (the subscription roster) and
  // `clineCloud` (cloud-routed). A pass-enabled account may use every one of
  // them, so all four are read; a free account sees the free tier only. Reading
  // just `free`/`clinePass` silently dropped `recommended` and `clineCloud`
  // from the catalog entirely.
  //
  // The third element marks the zero-cost tier — the `free` bucket alone, not
  // `recommended`: a pass account receives `recommended` too, so calling it a
  // free-tier row would mislabel a subscription catalog entry. The tier is what
  // separates a "Free models (auto)" row from an ordinary fetched one.
  //
  // Membership of the bucket *is* the rule, deliberately not the id prefix. The
  // `free` bucket's ids are mostly `cline-free/…`, but the prefix does not
  // define the tier in either direction: a free id need not carry it (the
  // catalog serves `deepseek/deepseek-v4-flash` and `z-ai/glm-5.3-flash` on the
  // free tier with no prefix at all), and carrying it proves nothing on its own.
  // A prefix test would therefore both miss served models and admit retired
  // ones, so the bucket the endpoint already sorted them into is the authority.
  const buckets: ReadonlyArray<readonly [unknown, boolean, boolean]> = pass
    ? [
        [payload.recommended, false, false],
        [payload.free, false, true],
        [payload.clinePass, true, false],
        [payload.clineCloud, true, false],
      ]
    : [
        [payload.recommended, false, false],
        [payload.free, false, true],
      ];
  const seen = new Set<string>();
  const out: ModelDefinition[] = [];
  for (const [bucket, subscription, freeTier] of buckets) {
    for (const entry of modelEntries(bucket)) {
      const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (rawId.length === 0) continue;
      // The endpoint already namespaces its own ids (`cline-pass/…`,
      // `cline-cloud/…`, `cline-free/…`), so the bucket decides only how the
      // row is priced and which catalog entry answers for it — never how the id
      // is spelled. Prefixing here double-namespaced every id the endpoint had
      // already prefixed (`cline-pass/cline-pass/mimo-v2.6-flash`), which no
      // upstream route resolves.
      const id = rawId;
      if (seen.has(id)) continue;
      seen.add(id);
      // Limits, in authority order:
      //   1. Cline's own `/ai/cline/models` catalog (`context_length`,
      //      `top_provider.max_completion_tokens`) — the serving provider's
      //      answer, and the only source that covers the whole roster.
      //   2. `defineModel`'s fallback, which is the base catalog's exact row
      //      when models.dev files the provider (`cline-pass`), else the
      //      most-agreed row for the bare id, else the documented default.
      // The recommended-models endpoint itself states no limits (only
      // id/name/description/tags), so a fixed pair here was simply invented:
      // the pass entries are 1M-context, and an output cap above the real
      // window is unsatisfiable.
      const providerId = subscription ? "cline-pass" : "cline";
      const limits = upstreamLimitsFor(upstream, id);
      const declaredVision = tagsOf(entry).some(
        (tag) => tag.includes("vision") || tag.includes("multimodal"),
      );
      out.push(
        defineModel({
          id,
          providerId,
          wireFamily: "chat",
          endpoint: CLINE_CHAT_PATH,
          // The upstream catalog's `input_modalities` is authoritative when it
          // lists the id; the roster's own tags are the fallback signal.
          vision: limits?.vision ?? declaredVision,
          ...(limits?.contextLimit === undefined ? {} : { ctx: limits.contextLimit }),
          ...(limits?.outputLimit === undefined ? {} : { out: limits.outputLimit }),
          reasoning: true,
          // `free` follows the free bucket, not "not a subscription": the
          // `recommended` bucket is billed, and the flag is not cosmetic —
          // `defineModel` prices a `free` row at zero, so the cost surface
          // would report paid models as free. The upstream settles it:
          // dispatching `anthropic/claude-sonnet-5.5` from `recommended` answers
          // 402 `insufficient_credits`, while a `free` bucket id answers 200. A
          // subscription row is also not free — it bills a subscription — so
          // only the free bucket carries the flag.
          free: freeTier,
          freeTier,
        }),
      );
    }
  }
  // `/models` names free ids the recommended roster does not, so it is read as
  // a second free-tier source rather than a replacement. An id the roster
  // already defined keeps the roster's row: it carries the endpoint's own
  // pricing and subscription classification, which this listing cannot state.
  for (const id of freeIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const limits = upstreamLimitsFor(upstream, id);
    out.push(
      defineModel({
        id,
        providerId: "cline",
        wireFamily: "chat",
        endpoint: CLINE_CHAT_PATH,
        vision: limits?.vision ?? false,
        ...(limits?.contextLimit === undefined ? {} : { ctx: limits.contextLimit }),
        ...(limits?.outputLimit === undefined ? {} : { out: limits.outputLimit }),
        reasoning: true,
        // The suffix is the provider's own free-tier spelling, so both
        // statements hold: zero per token, and a row the model list groups
        // under the free tier.
        free: true,
        freeTier: true,
      }),
    );
  }
  return out;
}

/**
 * Upstream limits for one model id, read from Cline's own catalog.
 *
 * The recommended-models roster states no limits at all, but Cline's
 * `/ai/cline/models` catalog does: `context_length` plus
 * `top_provider.max_completion_tokens`, and `architecture.input_modalities`.
 * That is the serving provider's own answer, so it outranks any guess.
 *
 * The two endpoints do not share an id spelling. The roster names a
 * subscription model `cline-pass/kimi-k3` while the catalog files it as
 * `moonshotai/kimi-k3`, so a lookup tries the id as given and then its bare
 * segment — the same bare-id rule `modelsDevCatalog` uses, and safe here
 * because this is one provider's catalog rather than a shared global index.
 */
interface ClineUpstreamLimits {
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly vision?: boolean;
}

function upstreamCatalogIndex(value: unknown): ReadonlyMap<string, ClineUpstreamLimits> {
  const root = isRecord(value) ? value : undefined;
  const rows = Array.isArray(root?.["data"]) ? root["data"] : Array.isArray(value) ? value : [];
  const byId = new Map<string, ClineUpstreamLimits>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = typeof row["id"] === "string" ? row["id"].trim().toLowerCase() : "";
    if (id.length === 0) continue;
    const contextLimit = positiveCount(row["context_length"]);
    const topProvider = isRecord(row["top_provider"]) ? row["top_provider"] : undefined;
    const outputLimit = positiveCount(topProvider?.["max_completion_tokens"]);
    const architecture = isRecord(row["architecture"]) ? row["architecture"] : undefined;
    const modalities = Array.isArray(architecture?.["input_modalities"])
      ? architecture["input_modalities"]
      : [];
    const limits: ClineUpstreamLimits = {
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      vision: modalities.some((m) => m === "image"),
    };
    byId.set(id, limits);
    // The roster and this catalog spell the same model differently: the roster
    // names a subscription model `cline-pass/kimi-k3` while this catalog files
    // it as `moonshotai/kimi-k3`. Indexing the bare segment too is what lets
    // `upstreamLimitsFor` resolve one to the other. An exact key already
    // recorded stays authoritative, so a provider-prefixed row never shadows a
    // row filed under the bare id itself.
    const slash = id.indexOf("/");
    if (slash >= 0) {
      const bare = id.slice(slash + 1);
      if (!byId.has(bare)) byId.set(bare, limits);
    }
  }
  return byId;
}

function positiveCount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** The catalog row for `id`, falling back to its bare segment. */
function upstreamLimitsFor(
  index: ReadonlyMap<string, ClineUpstreamLimits>,
  id: string,
): ClineUpstreamLimits | undefined {
  const normalized = id.trim().toLowerCase();
  const exact = index.get(normalized);
  if (exact !== undefined) return exact;
  const slash = normalized.indexOf("/");
  return slash < 0 ? undefined : index.get(normalized.slice(slash + 1));
}

function tagsOf(entry: ClineRecommendedModel): readonly string[] {
  return Array.isArray(entry.tags)
    ? entry.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.toLowerCase())
    : [];
}

export async function fetchClineRecommendedModels(
  signal: AbortSignal | undefined,
  pass: boolean,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<readonly ModelDefinition[] | null> {
  const load = async (): Promise<readonly ModelDefinition[] | null> => {
    const timeout = AbortSignal.timeout(10_000);
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const url = `${CLINE_BASE_URL}${CLINE_RECOMMENDED_MODELS_PATH}`;
      const res = await fetcher(url, { headers: { accept: "application/json" }, signal: composed });
      if (!res.ok) return null;
      const json = (await res.json()) as unknown;
      // The limits live in the sibling catalog, not in the roster. Fetch it
      // alongside, and treat its absence as "no upstream limits" rather than a
      // failure: the roster is still useful without them, and `defineModel`
      // falls back to the base catalog.
      const upstream = await fetchClineUpstreamCatalog(fetcher, composed);
      // The recommended roster is not the whole free tier: `/models` names
      // free ids it never lists (minimax among them). Union both, with the
      // recommended roster winning on an id it already defined.
      const freeIds = await fetchClineFreeModelIds(fetcher, composed);
      const models = recommendedModels(json, pass, upstream, freeIds);
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  };
  // The default fetcher is the production path: this roster is public and
  // changes slowly, so a short TTL avoids redundant refreshes. A caller that
  // injects its own fetcher (tests, custom egress) always gets a live call.
  if (fetcher !== globalThis.fetch) return load();
  return getCachedModelDiscovery(`cline-recommended:${pass ? "pass" : "free"}`, load);
}

/**
 * Whether the credential belongs to a Cline Pass account.
 *
 * Reads the same `/users/me/plan` endpoint the quota collector uses. A pass
 * account is the only one allowed to see the `clinePass`/`clineCloud` roster;
 * any failure answers `false`, so a free account never has subscription rows
 * written into its catalog.
 */
export async function clineAccountHasPass(
  credential: string,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<boolean> {
  try {
    const token = credential.startsWith("workos:") ? credential : `workos:${credential}`;
    const res = await fetcher("https://api.cline.bot/api/v1/users/me/plan", {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { plan?: { displayName?: unknown } };
    const name = typeof body.plan?.displayName === "string" ? body.plan.displayName.toLowerCase() : "";
    return name.includes("pass");
  } catch {
    return false;
  }
}

/** Cline's model catalog, indexed for limit lookup. Empty when unavailable. */
async function fetchClineUpstreamCatalog(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ClineUpstreamLimits>> {
  try {
    const res = await fetcher(`${CLINE_BASE_URL}${CLINE_MODELS_CATALOG_PATH}`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) return new Map();
    return upstreamCatalogIndex(await res.json());
  } catch {
    return new Map();
  }
}

/**
 * The free tier as `/models` states it, which is not the same roster as
 * `/ai/cline/recommended-models`.
 *
 * The two endpoints disagree, and the disagreement is the whole reason this
 * exists: `recommended-models` files four free ids, all spelled `cline-free/…`,
 * while `/models` publishes seventeen ids carrying a `:free` suffix — including
 * `minimax/minimax-m3.1-flash:free`, which the recommended roster never names.
 * Reading only the recommended roster therefore could not see minimax at all.
 *
 * The suffix is matched exactly rather than as a substring, the same rule
 * OpenRouter's free discovery uses, so an id whose own name contains "free" is
 * not swept in. A non-ok response is `null` — "this endpoint had nothing to
 * say" — rather than an empty list, so the caller can tell a failed fetch from
 * a genuinely empty tier.
 */
export async function fetchClineFreeModelIds(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<readonly string[] | null> {
  try {
    const res = await fetcher(`${CLINE_BASE_URL}${CLINE_MODELS_LIST_PATH}`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const root = isRecord(body) ? body : undefined;
    const rows = Array.isArray(root?.["data"]) ? root["data"] : Array.isArray(body) ? body : [];
    const ids = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = typeof row["id"] === "string" ? row["id"].trim() : "";
      if (id.length === 0) continue;
      if (!id.endsWith(":free")) continue;
      ids.add(id);
    }
    return [...ids];
  } catch {
    return null;
  }
}

/**
 * Static seed for Cline: the zero-cost tier and the Cline Pass roster.
 *
 * Every id here is materialized into the `models` table at boot with
 * `source: "builtin"`, and `seedBundledModels` deletes any builtin row this
 * list no longer declares. That makes the list the *owner* of these rows: an id
 * Cline retires from its roster keeps its catalog card — and its route — until
 * it is removed here, because nothing else prunes a builtin row. The seed is
 * therefore kept to ids Cline currently serves; a stale entry is a card that
 * can only ever fail a probe.
 *
 * Cline's live roster (`/ai/cline/recommended-models`, read by
 * `fetchClineRecommendedModels`) is the authority for what is routable right
 * now, and "Fetch models" reconciles against it. This list is the offline seed
 * that makes a fresh install usable before the first fetch.
 *
 * Both sections came from a live probe of that endpoint with a real key, not
 * from the OpenRouter listing Cline is backed by — the two disagree, and the
 * endpoint's own buckets are what the account can route. It is its own list
 * rather than {@link openrouterFreeRoster}, which Kilo and OpenRouter still
 * use: one list for three providers is right for a catalog fact and wrong for
 * an account fact.
 *
 * This is a floor, and live discovery still finds every id the account can
 * route — including any absent here. A manual fetch is unaffected by what this
 * list declares.
 */
interface ClineSeedRow {
  readonly id: string;
  readonly ctx: number;
  readonly out: number;
  readonly vision?: boolean;
}

function clineRow(
  rows: readonly ClineSeedRow[],
  extra: { free?: boolean; proOnly?: boolean },
): readonly ModelDefinition[] {
  return rows.map((row) =>
    defineModel({
      id: row.id,
      providerId: CLINE_PROVIDER_ID,
      wireFamily: "chat",
      endpoint: CLINE_CHAT_PATH,
      ctx: row.ctx,
      out: row.out,
      vision: row.vision ?? false,
      reasoning: true,
      toolCall: true,
      ...(extra.free === true ? { free: true, freeTier: true } : {}),
      ...(extra.proOnly === true ? { proOnly: true } : {}),
    }),
  );
}

/**
 * The zero-cost tier, exactly as this account's `free` bucket publishes it.
 *
 * Probed against `/ai/cline/recommended-models` with a live key, not inferred
 * from the OpenRouter listing. That matters because the two disagree: the
 * `/models` listing names 17 `:free` ids, while the account's own `free` bucket
 * names 5 and shares none of them. The listing is the upstream catalog; the
 * bucket is what this account can actually route, and only the second is a
 * fact worth seeding.
 *
 * Two ids carry the `cline-free/` prefix. That prefix is Cline's own namespace,
 * not a tier marker — membership of the bucket is what makes a row free.
 */
const CLINE_FREE_ROWS: readonly ClineSeedRow[] = [
  { id: "reflection/beam-free", ctx: 128_000, out: 32_000 },
  { id: "cline-free/nemotron-3.5-super-vl", ctx: 1_000_000, out: 131_072, vision: true },
  { id: "nvidia/nemotron-3.5-lightning-free", ctx: 1_000_000, out: 65_536 },
  { id: "poolside/laguna-s-2.1-free", ctx: 262_144, out: 32_768 },
  { id: "cline-free/solar-mini4", ctx: 524_288, out: 131_072 },
];

/**
 * The Cline Pass subscription roster, as the account's `clinePass` bucket
 * publishes it.
 *
 * Seeded with `proOnly`, matching how the buddy roster marks a row a free plan
 * is refused: dispatching one without a subscription 401s, so the card should
 * say so rather than fail at request time. Discovery reads `clineAccountHasPass`
 * first and only asks for these rows when the account has one.
 */
const CLINE_PASS_ROWS: readonly ClineSeedRow[] = [
  { id: "cline-pass/kimi-k3.1-pro", ctx: 1_000_000, out: 32_000 },
  { id: "cline-pass/minimax-m3.1-flash", ctx: 1_000_000, out: 128_000 },
  { id: "cline-pass/deepseek-v4.1-flash-1017", ctx: 1_000_000, out: 128_000 },
  { id: "cline-pass/deepseek-v4.1-flash", ctx: 1_000_000, out: 128_000 },
  { id: "cline-pass/mimo-v2.6-flash", ctx: 1_000_000, out: 128_000 },
  { id: "cline-pass/mimo-v2.6-pro", ctx: 1_000_000, out: 128_000 },
  { id: "cline-pass/glm-5.3", ctx: 1_000_000, out: 64_000 },
  { id: "cline-pass/deepseek-v4-pro", ctx: 1_000_000, out: 128_000 },
  { id: "cline-pass/qwen3.8-max", ctx: 1_000_000, out: 65_536 },
  { id: "cline-pass/muse-spark-1.3-contributor", ctx: 1_000_000, out: 65_536 },
  { id: "cline-pass/kimi-k3", ctx: 1_000_000, out: 32_000 },
  { id: "cline-pass/glm-5.3-flash", ctx: 1_000_000, out: 32_000 },
  { id: "cline-pass/qwen3.7-plus", ctx: 1_000_000, out: 65_536 },
  { id: "cline-pass/qwen3.7-max", ctx: 1_000_000, out: 65_536 },
  { id: "cline-pass/minimax-m3", ctx: 512_000, out: 64_000 },
];

export const CLINE_MODELS: readonly ModelDefinition[] = [
  ...clineRow(CLINE_FREE_ROWS, { free: true }),
  ...clineRow(CLINE_PASS_ROWS, { proOnly: true }),
];


export function createClineAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return createApiKeyAdapter(
    {
      provider_id: CLINE_PROVIDER_ID,
      base_url: CLINE_BASE_URL,
      endpoint_paths_by_wire_family: { chat: CLINE_CHAT_PATH, responses: "/responses" },
      buildExtraHeaders: (ctx) => clineExtraHeaders(ctx),
      prePayload: clinePrePayload,
    },
    fetchImpl,
  );
}
