/**
 * Canonical model-definition helpers.
 *
 * Every static provider catalog describes the same `ModelDefinition` shape with
 * only a handful of per-provider differences (wire family, endpoint path,
 * vision/reasoning/tool flags, pricing). `defineModel` is the single place that
 * shape is constructed. Catalogs pass only the fields that differ, so a catalog
 * edit cannot silently drift from the shared defaults. Limits and pricing fall
 * back to the prebuilt base catalog; capability does not — see `defineModel`.
 */
import type { ServiceKind, WireFamily } from "../protocol/canonical-model";
import type { DialectId } from "../protocol/translation/dialect/types";
import { modelsDevCatalog } from "./discovery/models-dev-catalog";

/** Billing metadata for one provider model. */
export interface ModelCostDefinition {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly pricing_model?: "pay-per-use" | "subscription" | "unknown";
}

/**
 * Per-token cost for a plan whose tier is free. Zero is a tier fact owned by
 * the provider (Cline's `free` bucket, mirroring the upstream client's
 * deliberate cost zeroing), not a price copied from the base catalog: the base
 * catalog prices the *underlying* model, which the free tier does not bill.
 */
export const FREE_TIER_COST: ModelCostDefinition = {
  input: 0,
  output: 0,
  pricing_model: "pay-per-use",
};

/**
 * Severity of one display-only model warning. `warn` is the default so a
 * catalog that omits severity does not silently render a critical banner.
 */
export type ModelWarningSeverity = "info" | "warn" | "critical";

/** Severity values accepted on the wire, as a runtime tuple. */
export const MODEL_WARNING_SEVERITIES = ["info", "warn", "critical"] as const;

/** Longest accepted warning `kind` / `message`, in UTF-16 code units. */
export const MODEL_WARNING_KIND_MAX_LENGTH = 64;
export const MODEL_WARNING_MESSAGE_MAX_LENGTH = 500;

/**
 * One display-only warning attached to a model row. `kind` is an open string
 * with three defined values (`fallback_model`, `cache_reliability`,
 * `model_refusal`) so a new category needs no migration. Persisted as
 * `{ warnings: ModelWarning[] }` in `models.warning_metadata`; never read by
 * routing.
 */
export interface ModelWarning {
  /** Stable machine-readable category; open vocabulary. */
  readonly kind: string;
  /** Operator-facing text. Provider-level claims use "may". */
  readonly message: string;
  /** Defaults to `warn` when absent. */
  readonly severity?: ModelWarningSeverity;
  /** ISO timestamp of the last edit, when known. */
  readonly updatedAt?: string;
}

/** Canonical static metadata for one provider model. */
export interface ModelDefinition {
  readonly modelId: string;
  readonly wireFamily: WireFamily;
  /**
   * Which protocol shape this model speaks. Absent means `"llm"` (the canonical
   * chat pipeline). A non-`llm` row is served by its native passthrough route,
   * not by the surface codecs, and `wireFamily`/`endpointPath` describe that
   * native route's transport rather than a chat wire.
   *
   * Optional so the hand-built catalog literals that predate this dimension
   * stay valid unchanged; read it as `definition.serviceKind ?? "llm"`.
   */
  readonly serviceKind?: ServiceKind;
  readonly endpointPath: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  /** Explicitly supported reasoning effort scale (e.g. `["minimal", "low", "medium", "high", "xhigh"]`). */
  readonly reasoningEfforts?: readonly string[];
  /**
   * Optional thinking/effort override for this row. When present, the ladder
   * resolver prefers these efforts and transport mode over the rule table.
   * Compile-time only — no DB column (see `thinking-ladder.ts`).
   */
  readonly thinking?: {
    readonly efforts?: readonly string[];
    readonly mode?: "effort" | "budget" | "anthropic-adaptive" | "google-level";
  };
  readonly toolCall: boolean;
  readonly cost: ModelCostDefinition;
  /**
   * Explicit wire dialect for this row. Absent = resolver fallback (heuristic
   * + family default) — see `src/protocol/translation/dialect/`.
   */
  readonly dialect?: DialectId;
  /**
   * Whether the provider serves this row on a free plan tier.
   *
   * Deliberately not the same thing as `free` on the input row. `free` is a
   * *billing* statement — bill zero per token — and a subscription roster also
   * bills zero per token. This is a *catalog* statement: the row belongs to the
   * tier the provider publishes as free. Discovery has to tell them apart
   * because the free tier is a distinct group in the model list, and `cost`
   * cannot answer it — a reseller may legitimately price a model at `$0.00`
   * without it being the provider's free tier.
   *
   * Optional, and absence is the answer "not a free-tier row": the field is a
   * marker only a discovery module that reads a provider's free tier can set,
   * so a hand-built definition correctly says nothing. Read it as `=== true`.
   */
  readonly freeTier?: boolean;
  /**
   * Whether the provider refuses this row on a free plan.
   *
   * The opposite statement to `freeTier`, and not its absence: `freeTier` says
   * "served on the free tier", while this says "refused there". A row neither
   * marked is simply one whose tier nobody established — which is most rows,
   * and must not be rendered as "free".
   *
   * CodeBuddy is why both exist. Its console directory publishes no field that
   * predicts access: `credits` and `vendor` were both measured against real
   * dispatches and neither correlates — `kimi-k3` bills `x1.62` and is served
   * on a free account while `gpt-5.6-luna` bills `x0.14` and is refused. The
   * only signal is the refusal itself: `11158 "model [X] is not allowed for
   * user type [personal_free_user]"`. See
   * `documentation/research/codebuddy/2026-10-19-codebuddy-chat-dispatch-headers.md`.
   *
   * Optional, and absence is "tier unknown" rather than "served on free". Read
   * it as `=== true`; a UI that shows a tier must treat undefined as unknown,
   * not as the permissive answer.
   */
  readonly proOnly?: boolean;
  /**
   * True when neither the row nor the catalog could state this model's limits,
   * so `contextLimit`/`outputLimit` are the shared fallback rather than
   * anything measured.
   *
   * A model nobody has filed — a brand-new id the catalog has not caught up
   * with — must still be routable, and a hard number is what routing needs to
   * size a request. But publishing that number as if it were the model's own
   * turns a gap in our catalog into a claim about someone else's model.
   */
  readonly limitsEstimated?: boolean;
  /** Display-only warnings carried from a static catalog into the seeded row. */
  readonly warnings?: readonly ModelWarning[];
}

/**
 * Limits assumed when neither the catalog nor the operator supplies any.
 *
 * Deliberately generous: a context ceiling that is too *low* truncates a
 * working request, while one that is too high only means the upstream rejects
 * the call on its own terms. Chosen as a round number above every current
 * frontier model so the fallback is never the binding constraint.
 *
 * A row carrying these because nothing filed the model is flagged as estimated,
 * so the UI can say the number is a guess rather than presenting it as a fact
 * about the model.
 */
export const FALLBACK_CONTEXT_LIMIT = 512_000;
export const FALLBACK_OUTPUT_LIMIT = 131_072;

/**
 * Limits assumed for a model the catalog has never filed.
 *
 * Fit comfortably rather than tightly: a fallback that is too small silently
 * truncates a request that would have been fine, while one that is too large
 * only costs an admission estimate no upstream enforces. The two spellings above
 * are one number, so a row rendered in the console and a row routed through
 * discovery cannot disagree about what "unfiled" means.
 */
const UNFILED_CONTEXT_LIMIT = FALLBACK_CONTEXT_LIMIT;
const UNFILED_OUTPUT_LIMIT = FALLBACK_OUTPUT_LIMIT;

/** Fields accepted by `defineModel`; every field except `id` falls back to the shared default. */
export interface ModelHelperRow {
  readonly id: string;
  /**
   * Canonical provider id this row is served by. Optional only so shared
   * helper rows can omit it; supplying it is what makes base-catalog limits
   * and pricing resolve to the right provider's entry.
   */
  readonly providerId?: string;
  /** Defaults to `"chat"`. */
  readonly wireFamily?: ModelDefinition["wireFamily"];
  /** Defaults to `"llm"`. A non-`llm` row is served by its native route. */
  readonly serviceKind?: ServiceKind;
  /** Defaults to the family's conventional path (`/chat/completions`, `/responses`, `/messages`). */
  readonly endpoint?: string;
  /** Defaults to 128k. */
  readonly ctx?: number | null;
  /** Defaults to 8k. */
  readonly out?: number | null;
  readonly vision?: boolean;
  /** Accepts PDF/plain-file input parts (`document`/`file` canonical kinds). */
  readonly document?: boolean;
  /** Accepts audio input parts. */
  readonly audio?: boolean;
  readonly reasoning?: boolean;
  /**
   * Output modalities this row produces. Defaults to `["text"]`.
   *
   * A generation row sets `["image"]` or `["video"]`: the capability profile's
   * `mediaGeneration` flag reads `output.includes("image")`, and before this
   * field existed every catalog row was hardcoded to text, so no static row
   * could ever declare that it returns an image.
   */
  readonly output?: readonly ModelDefinition["modalities"]["output"][number][];
  /** Explicitly supported reasoning effort scale. */
  readonly reasoningEfforts?: readonly string[];
  /** Optional thinking/effort override; see `ModelDefinition.thinking`. */
  readonly thinking?: ModelDefinition["thinking"];
  readonly toolCall?: boolean;
  /**
   * Marks a row served by a free plan tier. Such rows bill zero per token
   * regardless of what the base catalog charges for the underlying model.
   */
  readonly free?: boolean;
  /**
   * Marks a row that belongs to the tier the provider publishes as free.
   *
   * Separate from `free` because the two answer different questions: a
   * subscription roster bills zero per token (`free`) without being the free
   * tier. This one is what the model list groups on, so a provider's free-tier
   * discovery can be labelled as such instead of mixed into ordinary fetched
   * rows. Defaults to false — a row nobody marked is not a free-tier row.
   */
  readonly freeTier?: boolean;
  /** Whether the provider refuses this row on a free plan. See `ModelDefinition.proOnly`. */
  readonly proOnly?: boolean;
  /** Explicit wire dialect override for this row. See `ModelDefinition.dialect`. */
  readonly dialect?: DialectId;
  /** Display-only warnings to carry onto the built row. */
  readonly warnings?: readonly ModelWarning[];
}

function defaultEndpoint(wireFamily: ModelDefinition["wireFamily"]): string {
  if (wireFamily === "chat") return "/chat/completions";
  if (wireFamily === "responses") return "/responses";
  return "/messages";
}

/**
 * Model ids whose families speak native OpenAI Responses on every gateway that
 * lists them (GPT-5/6, o3/o4). Verified live: `gpt-5.6-terra` answers on
 * `/v1/responses` in ~2s with its gateway routing prefix intact, and the
 * codex/openai static catalogs already carry these families as responses-wire.
 *
 * Both the static inferhub catalog and the tolerant `/models` discovery path
 * classify wire family from the raw id, so the rule is stated once here: a
 * gateway that lists one of these families must not pin it to the chat wire.
 */
export function isResponsesNativeModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes("gpt-5") || id.includes("gpt-6") || id.includes("/o3") || id.includes("/o4");
}

/**
 * Builds one static catalog row. No empty-id guard: the Anthropic and Claude
 * catalogs intentionally ship empty-id rows, so validation here would break
 * module load.
 *
 * Capability is declared per row and never read from the base catalog. The base
 * catalog is keyed by bare model id, and a bare id maps to many provider rows
 * where only the first survives (`models-dev-catalog.ts`), so a capability read
 * from it can describe a different provider's serving of the same model. What a
 * row does not declare is left to the routing ladder's filter → degrade path
 * rather than guessed from a stranger's metadata.
 */
export function defineModel(row: ModelHelperRow): ModelDefinition {
  const wireFamily = row.wireFamily ?? "chat";
  // `row.providerId` names the provider whose catalog this row belongs to, so
  // limits and cost come from that provider's own base-catalog entry. Without
  // it the lookup falls back to the bare id, which returns `undefined` when the
  // catalog disagrees about that id (428 bare keys disagree on context alone).
  const fallback = row.id ? modelsDevCatalog.resolve(row.providerId ?? "", row.id) : undefined;
  // A provider the catalog does not file under our id (or files nowhere at
  // all) leaves `resolve` undefined, which would fall through to the fixed
  // default below. The majority vote is the honest middle tier: the model is
  // known, the catalog merely disagrees about it, and the most-agreed row
  // describes the model itself rather than one reseller's serving. Only the
  // field the vote actually answered is taken; a model nobody records stays
  // at the default.
  const majority = fallback === undefined && row.id ? modelsDevCatalog.majorityFor(row.id) : undefined;

  // Nothing filed this model: not the row, not the provider's catalog entry,
  // not a majority across the catalog's other resellers. The fallback keeps it
  // routable, and the marker keeps the number honest.
  const limitsEstimated = row.ctx === undefined && fallback?.contextLimit === undefined && majority?.contextLimit === undefined;

  const contextLimit =
    row.ctx !== undefined
      ? row.ctx
      : (fallback?.contextLimit ?? majority?.contextLimit ?? UNFILED_CONTEXT_LIMIT);

  const declaredOutput =
    row.out !== undefined
      ? row.out
      : (fallback?.outputLimit ?? majority?.outputLimit ?? UNFILED_OUTPUT_LIMIT);

  // A maximum output above the context window is unsatisfiable: no request can
  // reserve more output tokens than the model accepts as input. The base
  // catalog carries 1084 rows that state output === context and 69 that state
  // output > context (a Kimi K2.6 row is filed as 262144/262144), so an
  // unclamped cap would publish a limit the provider rejects and make the
  // admission estimate reserve the whole window as output headroom.
  const outputLimit =
    contextLimit === null || declaredOutput === null
      ? declaredOutput
      : Math.min(declaredOutput, contextLimit);

  const cost = row.free ? FREE_TIER_COST : modelsDevCatalog.costFor(row.providerId ?? "", row.id);

  return {
    modelId: row.id,
    wireFamily,
    serviceKind: row.serviceKind ?? "llm",
    endpointPath: row.endpoint ?? defaultEndpoint(wireFamily),
    contextLimit,
    outputLimit,
    modalities: {
      input: [
        "text",
        ...(row.vision ? ["image"] : []),
        ...(row.document ? ["document"] : []),
        ...(row.audio ? ["audio"] : []),
      ],
      output: row.output ?? ["text"],
    },
    reasoning: row.reasoning ?? false,
    ...(row.reasoningEfforts !== undefined ? { reasoningEfforts: row.reasoningEfforts } : {}),
    ...(row.thinking === undefined ? {} : { thinking: row.thinking }),
    toolCall: row.toolCall ?? true,
    cost,
    ...(row.freeTier === undefined ? {} : { freeTier: row.freeTier }),
    ...(row.proOnly === undefined ? {} : { proOnly: row.proOnly }),
    ...(row.dialect === undefined ? {} : { dialect: row.dialect }),
    ...(limitsEstimated ? { limitsEstimated: true } : {}),
    ...(row.warnings === undefined ? {} : { warnings: row.warnings }),
  };
}

/** Capability metadata persisted for one manually registered model id. */
export interface ManualModelMetadata {
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  readonly toolCall: boolean;
}

/**
 * Resolves capability metadata for a manually registered model id.
 *
 * A manual add performs no upstream probe and has no static catalog row. Its
 * capabilities are therefore declared up front rather than inferred from a
 * `defineModel(...)` entry: tools, vision, and reasoning are always enabled. A
 * false negative here is not cosmetic — capability preflight reads `toolCall`
 * and silently strips `tools` from the request, so a manually added model
 * would appear unable to call tools at all. The prebuilt base catalog still
 * supplies the non-capability facts (context/output limits, cost) when it
 * knows the id.
 */
export function resolveManualModelMetadata(
  providerId: string,
  modelId: string,
): ManualModelMetadata {
  const meta = modelsDevCatalog.resolve(providerId, modelId);
  const catalogInput = meta?.modalities.input ?? [];
  return {
    contextLimit: meta?.contextLimit ?? null,
    outputLimit: meta?.outputLimit ?? null,
    modalities: {
      input: ["text", "image", ...catalogInput.filter((m) => m !== "text" && m !== "image")],
      output: meta?.modalities.output ?? ["text"],
    },
    reasoning: true,
    toolCall: true,
  };
}

/**
 * Folds operator-supplied metadata over a resolved model's metadata.
 *
 * `passthrough` wins over the individual flags: it grants everything, so a
 * caller that cannot know which capabilities a model has does not have to
 * guess. When it is set the per-flag fields are ignored rather than merged —
 * merging would let a stale `image: false` silently revoke what passthrough
 * just granted.
 */
export function applyModelMetadataOverride(
  base: ManualModelMetadata,
  override: {
    readonly contextLimit?: number | null;
    readonly outputLimit?: number | null;
    readonly passthrough?: boolean;
    readonly image?: boolean;
    readonly reasoning?: boolean;
    readonly toolCall?: boolean;
  } | undefined,
): ManualModelMetadata {
  if (override === undefined) return base;
  const passthrough = override.passthrough === true;
  const image = passthrough ? true : override.image;
  const reasoning = passthrough ? true : override.reasoning;
  const toolCall = passthrough ? true : override.toolCall;
  return {
    contextLimit: override.contextLimit ?? base.contextLimit,
    outputLimit: override.outputLimit ?? base.outputLimit,
    modalities: {
      ...base.modalities,
      input:
        image === undefined
          ? base.modalities.input
          : image
            ? Array.from(new Set([...base.modalities.input, "image"]))
            : base.modalities.input.filter((m) => m !== "image"),
    },
    reasoning: reasoning ?? base.reasoning,
    toolCall: toolCall ?? base.toolCall,
  };
}
