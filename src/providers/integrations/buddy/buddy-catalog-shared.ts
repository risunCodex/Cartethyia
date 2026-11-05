/**
 * The buddy-family static catalog row.
 *
 * CodeBuddy (intl + CN) and WorkBuddy describe their static fallback catalogs
 * with the same seven-field tuple and build each row the same way, differing
 * only in the wire endpoint the row targets. Both had their own copy of the
 * tuple type and the builder, so a new column meant editing two identical
 * declarations.
 *
 * Only the row shape and the builder are shared. Identity headers are not:
 * `codebuddyHeaders` and `workbuddyHeaders` send genuinely different bytes
 * (`X-Product`/`X-IDE-Type`/`X-Domain` versus `origin`/`referer` and the
 * account-derived `x-user-id`/`x-machine-id`/`x-session-id`), and those stay
 * with their own provider.
 */
import { GatewayError } from "../../../protocol/gateway-error";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

/** One static catalog row: id, display name, flags, limits, optional tool override. */
export type BuddyRawEntry = readonly [
  string,
  string,
  boolean,
  boolean,
  number | null,
  number | null,
  /** Explicit tool support. Omitted → derived from the base catalog. */
  boolean?,
];

/**
 * Realm-specific effort ladders.
 *
 * International DeepSeek Flash accepts only `high`; sending CN's `low`/`max`
 * is a 400. A model absent from its realm's table is not clamped. Lives here,
 * next to the catalog rows, so a row can carry its ladder as
 * `reasoningEfforts` without the catalog importing the chat hook.
 */
export const BUDDY_INTL_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4.1-flash": ["high"],
  "glm-5.2": ["high", "xhigh"],
  "glm-5.3": ["low", "high", "max"],
  hy3: ["low", "high"],
  hy4: ["high"],
};
export const BUDDY_CN_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4-flash": ["low", "high", "max"],
  "deepseek-v4-pro": ["low", "high", "xhigh"],
  "deepseek-v4.1-flash": ["low", "high", "max"],
  "glm-5.1": ["medium"],
  "glm-5.2": ["high", "xhigh"],
  "glm-5.3": ["low", "high", "max"],
  "glm-5.3-flash": ["low", "high", "max"],
  hy3: ["low", "high"],
  hy4: ["high"],
};

/** The image-generation ids the international buddy providers serve. */
const BUDDY_IMAGE_MODEL_IDS: readonly { id: string; endpoint: string; ctx: number; out: number }[] = [
  { id: "gemini-2.5-flash-image", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
  { id: "gemini-3.0-pro-image", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
  { id: "gemini-3.1-flash-image", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
  { id: "gpt-image-2", endpoint: "/chat/completions", ctx: 400_000, out: 128_000 },
  { id: "gpt-image-2.5-sunburst", endpoint: "/chat/completions", ctx: 400_000, out: 128_000 },
  // Published by /v3/config only, tagged `text-to-image` + `image-to-image`.
  // Upstream declares no token limits for it, so the roster floor is used
  // rather than inventing a number the upstream never sent.
  { id: "hy-image-3.5", endpoint: "/chat/completions", ctx: 1_000_000, out: 64_000 },
];

/**
 * The video-generation ids the international buddy providers serve.
 *
 * `seedance-2.5` is the text-to-video model the buddy facade exposes. It is a
 * distinct service kind (`videoGeneration`), not a chat or image row, so it is
 * built by {@link makeBuddyVideoModels} and reached through
 * `/videos/generations` (relative to each variant's own base, which is why the
 * WorkBuddy rows carry the `/v2` segment themselves) rather than a chat wire.
 * CodeBuddy CN is deliberately absent — it publishes a different roster.
 */
const BUDDY_VIDEO_MODEL_IDS: readonly { id: string; endpoint: string; ctx: number; out: number }[] = [
  { id: "seedance-2.5", endpoint: "/videos/generations", ctx: 1_000_000, out: 128_000 },
  // Published by /v3/config only, tagged `text-to-video` + `image-to-video`.
  // Upstream declares capabilities in a `videoGeneration` block instead of
  // token limits (720P/1080P/4K, 16:9/9:16/1:1, 3-15s, switchable audio,
  // first/last-frame control), so the token columns carry the roster floor.
  { id: "kling-video-v3", endpoint: "/videos/generations", ctx: 1_000_000, out: 128_000 },
];

/**
 * Ids that belong to the image-generation rows rather than the chat roster.
 *
 * A caller mapping `BUDDY_SHARED_RAW` through {@link makeBuddyModel} must skip
 * these, or the same model id lands in the catalog twice under two service
 * kinds and becomes ambiguous to resolve.
 */
export const BUDDY_IMAGE_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_IMAGE_MODEL_IDS.map((entry) => entry.id),
);

/**
 * The CN realm's image-generation ids.
 *
 * Separate from {@link BUDDY_IMAGE_MODEL_IDS} because the realms do not share
 * a roster: `hunyuan-image-alpha` (text-to-image) and
 * `hunyuan-image-alpha-edit` (image-to-image) are published by the CN
 * `/v3/config` only, and the intl image ids are not served there. Sharing one
 * list would either leak CN-only ids onto the international catalogs or force
 * a realm check into every consumer.
 */
const BUDDY_CN_IMAGE_MODEL_IDS: readonly { id: string; ctx: number; out: number }[] = [
  { id: "hunyuan-image-alpha", ctx: 1_000_000, out: 64_000 },
  { id: "hunyuan-image-alpha-edit", ctx: 1_000_000, out: 64_000 },
];

/** The CN analogue of {@link BUDDY_IMAGE_MODEL_ID_SET}. */
export const BUDDY_CN_IMAGE_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_CN_IMAGE_MODEL_IDS.map((entry) => entry.id),
);

/**
 * Builds the CN image-generation rows for one buddy CN provider.
 *
 * Same shape as {@link makeBuddyImageModels}, scoped to the CN roster.
 */
export function makeBuddyCnImageModels(
  providerId: string,
  endpoint: string,
): readonly ModelDefinition[] {
  return BUDDY_CN_IMAGE_MODEL_IDS.map((entry) =>
    defineModel({
      id: entry.id,
      providerId,
      serviceKind: "imageGeneration",
      wireFamily: "chat",
      endpoint,
      ctx: entry.ctx,
      out: entry.out,
      vision: true,
      output: ["image"],
      toolCall: false,
    }),
  );
}

/**
 * The CN realm's video-generation ids.
 *
 * `kling-video-v3` (text-to-video + image-to-video) and
 * `minimax-video-h3` (text-to-video) are published by the CN `/v3/config`,
 * sharing the async task surface the intl video rows use.
 */
const BUDDY_CN_VIDEO_MODEL_IDS: readonly { id: string; ctx: number; out: number }[] = [
  { id: "kling-video-v3", ctx: 1_000_000, out: 128_000 },
  { id: "minimax-video-h3", ctx: 1_000_000, out: 128_000 },
];

/** The CN analogue of {@link BUDDY_VIDEO_MODEL_ID_SET}. */
export const BUDDY_CN_VIDEO_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_CN_VIDEO_MODEL_IDS.map((entry) => entry.id),
);

/**
 * Builds the CN video-generation rows for one buddy CN provider.
 *
 * Same shape as {@link makeBuddyVideoModels}, scoped to the CN roster: a video
 * row produces `["video"]` on the `videoGeneration` surface and is reached
 * through the native video route, not a chat wire.
 */
export function makeBuddyCnVideoModels(
  providerId: string,
  endpoint: string,
): readonly ModelDefinition[] {
  return BUDDY_CN_VIDEO_MODEL_IDS.map((entry) =>
    defineModel({
      id: entry.id,
      providerId,
      serviceKind: "videoGeneration",
      wireFamily: "chat",
      endpoint,
      ctx: entry.ctx,
      out: entry.out,
      vision: true,
      output: ["video"],
      toolCall: false,
    }),
  );
}

/**
 * Ids the buddy facade refuses on a free plan.
 *
 * The international CodeBuddy and WorkBuddy catalogs share this roster and
 * the same Pro-tier model classification.
 *
 * Nothing in the console directory predicts it. `credits` does not — `kimi-k3`
 * bills `x1.62` and is served while `gpt-5.6-luna` bills `x0.14` and is
 * refused — and `vendor` does not either. Only the refusal itself is a signal,
 * which is why this is a list and not a rule.
 *
 * Hardcoded deliberately: it is one account's tier, so it is a fact about that
 * plan rather than about the model. A pro account serves all six. The pill is
 * therefore a hint about a free account, and a dispatch is what settles it.
 *
 * @see `documentation/research/codebuddy/2026-10-19-codebuddy-chat-dispatch-headers.md`
 */
export const BUDDY_PRO_ONLY_MODEL_IDS: ReadonlySet<string> = new Set([
  "primary-model",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "grok-4.6",
  "grok-4.7",
  "kimi-k3.1-pro-highspeed",
  // The Opus rows: both are refused on free while Sonnet 4.6 at the same
  // 1M window is served, so this is the tier rather than the size.
  "claude-opus-4.6",
  "claude-opus-4.7-1m",
]);

/**
 * Builds the image-generation rows for one buddy provider.
 *
 * Shared rather than copied per provider: cb and WorkBuddy serve the same image
 * models from the same facade, so the roster and the declared capabilities are
 * one decision instead of two that drift. CodeBuddy CN is deliberately absent —
 * it publishes a different roster.
 *
 * `endpoint` is explicit because the two families disagree about the path their
 * base URL expects, and a bare `defineModel` would infer the generic default
 * and produce a URL the upstream rejects.
 */
export function makeBuddyImageModels(
  providerId: string,
  endpoint: string,
): readonly ModelDefinition[] {
  return BUDDY_IMAGE_MODEL_IDS.map((entry) =>
    defineModel({
      id: entry.id,
      providerId,
      serviceKind: "imageGeneration",
      wireFamily: "chat",
      endpoint,
      ctx: entry.ctx,
      out: entry.out,
      vision: true,
      output: ["image"],
      // An image generator takes a prompt, not a tool-calling conversation.
      toolCall: false,
    }),
  );
}

/**
 * Builds the video-generation rows for one buddy provider.
 *
 * Shared for the same reason as {@link makeBuddyImageModels}: the roster is one
 * decision, not one per provider that drifts. A video row produces `["video"]`
 * on the `videoGeneration` surface and is reached through the native video
 * route, not a chat wire, so `endpoint` names the upstream generation path
 * rather than a chat-completions path.
 */
export function makeBuddyVideoModels(
  providerId: string,
  endpoint: string,
): readonly ModelDefinition[] {
  return BUDDY_VIDEO_MODEL_IDS.map((entry) =>
    defineModel({
      id: entry.id,
      providerId,
      serviceKind: "videoGeneration",
      wireFamily: "chat",
      endpoint,
      ctx: entry.ctx,
      out: entry.out,
      vision: true,
      output: ["video"],
      toolCall: false,
    }),
  );
}

/**
 * Ids that belong to the video-generation rows rather than the chat roster.
 *
 * The video analogue of {@link BUDDY_IMAGE_MODEL_ID_SET}: a caller mapping the
 * shared chat tuple must skip these so `seedance-2.5` never lands in the
 * catalog twice under two service kinds.
 */
export const BUDDY_VIDEO_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_VIDEO_MODEL_IDS.map((entry) => entry.id),
);

/**
 * Builds one buddy catalog row.
 *
 * `endpoint` is explicit rather than left to the generic `/chat/completions`
 * default because the two families disagree about it: CodeBuddy's base URL
 * carries a version segment the default joins onto correctly, while
 * WorkBuddy's does not — the default would produce
 * `https://www.workbuddy.ai/chat/completions`, which that upstream answers
 * with a 405 HTML page. Callers pass the endpoint their base URL actually
 * serves, and `undefined` for the default.
 */
export function makeBuddyModel(
  entry: BuddyRawEntry,
  providerId: string,
  endpoint?: string,
  realm: "intl" | "cn" = "intl",
): ModelDefinition {
  if (!entry[0]) throw new GatewayError("invalid_request", 400, "invalid model (request {requestId}). Check the shape of what you sent — then resend 🪞");
  const image = BUDDY_IMAGE_MODEL_ID_SET.has(entry[0]);
  const efforts = (realm === "cn" ? BUDDY_CN_EFFORTS : BUDDY_INTL_EFFORTS)[entry[0].toLowerCase()];
  // Refused on free is only a question for the intl realm. cbcn serves every
  // model on its free plan (none of the six ids here is refused there), so
  // the same set applied to a CN row would publish a tier fact that nobody
  // measured and that the CN account would simply disagree with on dispatch.
  const proOnly = realm === "intl" && BUDDY_PRO_ONLY_MODEL_IDS.has(entry[0].toLowerCase());
  return defineModel({
    id: entry[0],
    providerId,
    ...(image ? { serviceKind: "imageGeneration" as const, output: ["image"] as const } : {}),
    ...(endpoint === undefined ? {} : { endpoint }),
    reasoning: entry[2],
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    vision: entry[3],
    ctx: entry[4],
    out: entry[5],
    ...(image ? { toolCall: false } : entry[6] === undefined ? {} : { toolCall: entry[6] }),
    ...(proOnly ? { proOnly: true } : {}),
  });
}

/**
 * The shared model roster for the two international buddy sites.
 *
 * CodeBuddy intl and WorkBuddy serve the same model set from the same console
 * directory shape, so the two catalogs were kept as separate hand-written lists
 * and had already drifted: each carried ids the other lacked. One list is the
 * single source of truth, and each provider maps it with its own endpoint
 * (`workbuddy.ts` needs the explicit `/v2/chat/completions`, `codebuddy.ts`
 * takes the family default) — the endpoint is the only thing that differs.
 *
 * CodeBuddy CN is deliberately NOT on this list: its console publishes a
 * different roster (its own `glm-5v-turbo` / `kimi-k3-1` ids and CN-specific
 * output ceilings), so it keeps its own table.
 */
export const BUDDY_SHARED_RAW: readonly BuddyRawEntry[] = [
  ["auto", "Auto", false, true, 176_000, 24_000],
  // The three named tiers and `gpt-6-astra` are published by /v3/config and sit
  // in the CLI roster, but had no static row: a client asking for
  // `fast-model` resolved to nothing and the model was invisible. Added with
  // the limits upstream declares for them.
  ["fast-model", "Fast", true, true, 200_000, 32_000, true],
  ["balanced-model", "Balanced", true, true, 256_000, 32_000, true],
  ["primary-model", "Primary", true, true, 272_000, 72_000, true],
  ["gpt-6-astra", "GPT-6 Astra", true, true, 1_000_000, 128_000],
  ["claude-opus-4.6", "Claude Opus 4.6", true, true, 200_000, 64_000],
  ["claude-opus-4.7-1m", "Claude Opus 4.7 1M", true, true, 1_000_000, 64_000],
  ["claude-sonnet-4.6", "Claude Sonnet 4.6", true, true, 200_000, 32_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, true, 1_000_000, 128_000],
  ["deepseek-v4.1-flash-sg", "DeepSeek V4.1 Flash SG", true, true, 1_000_000, 128_000],
  ["gemini-2.5-flash-image", "Gemini 2.5 Flash Image", true, true, 1_000_000, 64_000],
  ["gemini-3.0-pro-image", "Gemini 3.0 Pro Image", true, true, 1_000_000, 64_000],
  ["gemini-3.1-flash-image", "Gemini 3.1 Flash Image", true, true, 1_000_000, 64_000],
  ["gemini-3.1-pro", "Gemini 3.1 Pro", true, true, 1_048_576, 65_536],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", true, true, 1_048_576, 65_536],
  ["gemini-3.8-flash", "Gemini 3.8 Flash", true, true, 1_000_000, 65_536, true],
  ["glm-5.1", "GLM-5.1", true, false, 200_000, 131_072],
  ["glm-5.2", "GLM-5.2", true, true, 1_000_000, 48_000],
  ["glm-5.3", "GLM-5.3", true, true, 1_000_000, 48_000],
  ["glm-5.3-flash", "GLM-5.3 Flash", true, false, 1_000_000, 32_000],
  ["glm-5v-turbo", "GLM-5V Turbo", true, true, 200_000, 131_072],
  ["gpt-5.3-codex", "GPT-5.3 Codex", true, true, 400_000, 128_000],
  ["gpt-5.4", "GPT-5.4", true, true, 272_000, 72_000],
  ["gpt-5.5", "GPT-5.5", true, true, 1_000_000, 128_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", true, true, 1_000_000, 128_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", true, true, 1_000_000, 128_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", true, true, 1_000_000, 128_000],
  ["gpt-6-luna", "GPT-6 Luna", true, true, 1_000_000, 128_000],
  ["gpt-6-sol", "GPT-6 Sol", true, true, 1_000_000, 128_000, true],
  ["gpt-6.1-sol", "GPT-6.1 Sol", true, true, 1_000_000, 128_000],
  ["gpt-image-2", "GPT-Image-2", true, true, 400_000, 128_000],
  ["grok-4.6", "Grok 4.6", true, true, 500_000, 500_000],
  ["grok-4.7", "Grok 4.7", true, true, 500_000, 128_000],
  ["hy3", "Hy3", true, true, 192_000, 64_000, true],
  ["hy4", "Hy4", true, true, 1_000_000, 64_000, true],
  ["kimi-k2.5", "Kimi K2.5", true, false, 164_000, 262_144],
  ["kimi-k2.6", "Kimi K2.6", true, false, 256_000, 262_144],
  ["kimi-k2.7", "Kimi K2.7", true, false, 256_000, 65_536],
  ["kimi-k2.8-preview", "Kimi K2.8 Preview", true, false, 1_048_576, 65_536],
  ["kimi-k3", "Kimi K3", true, true, 1_000_000, 32_000],
  ["kimi-k3.1-pro", "Kimi K3.1 Pro", true, true, 1_000_000, 32_000],
  ["kimi-k3.1-pro-highspeed", "Kimi K3.1 Pro Highspeed", true, true, 1_000_000, 32_000],
  ["minimax-m3", "MiniMax-M3", true, false, 512_000, 512_000],
  ["minimax-m3.1-flash", "MiniMax-M3.1 Flash", true, true, 1_000_000, 128_000],
  ["step-5-preview", "Step-5-Preview", true, true, 1_000_000, 64_000, true],
];
