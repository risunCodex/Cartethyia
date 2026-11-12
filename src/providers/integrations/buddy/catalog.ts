import { GatewayError } from "../../../protocol/gateway-error";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import { asNumber as sharedAsNumber, asRecord } from "../../../shared/coerce";
import { buddyAccountUid } from "./account";

// ── buddy-catalog-shared ──────────────────────────────────────────

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

export const BUDDY_INTL_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "deepseek-v4.1-flash": ["high"],
  "glm-5.2": ["high", "xhigh"],
  "glm-5.3": ["low", "high", "max"],
  hy3: ["low", "high"],
  hy4: ["high"],
  hy4free: ["high"],
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
  hy4free: ["high"],
};

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

const BUDDY_VIDEO_MODEL_IDS: readonly { id: string; endpoint: string; ctx: number; out: number }[] = [
  { id: "seedance-2.5", endpoint: "/videos/generations", ctx: 1_000_000, out: 128_000 },
  // Published by /v3/config only, tagged `text-to-video` + `image-to-video`.
  // Upstream declares capabilities in a `videoGeneration` block instead of
  // token limits (720P/1080P/4K, 16:9/9:16/1:1, 3-15s, switchable audio,
  // first/last-frame control), so the token columns carry the roster floor.
  { id: "kling-video-v3", endpoint: "/videos/generations", ctx: 1_000_000, out: 128_000 },
];

export const BUDDY_IMAGE_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_IMAGE_MODEL_IDS.map((entry) => entry.id),
);

const BUDDY_CN_IMAGE_MODEL_IDS: readonly { id: string; ctx: number; out: number }[] = [
  { id: "hunyuan-image-alpha", ctx: 1_000_000, out: 64_000 },
  { id: "hunyuan-image-alpha-edit", ctx: 1_000_000, out: 64_000 },
];

export const BUDDY_CN_IMAGE_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_CN_IMAGE_MODEL_IDS.map((entry) => entry.id),
);

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

const BUDDY_CN_VIDEO_MODEL_IDS: readonly { id: string; ctx: number; out: number }[] = [
  { id: "kling-video-v3", ctx: 1_000_000, out: 128_000 },
  { id: "minimax-video-h3", ctx: 1_000_000, out: 128_000 },
];

export const BUDDY_CN_VIDEO_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_CN_VIDEO_MODEL_IDS.map((entry) => entry.id),
);

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

export const BUDDY_VIDEO_MODEL_ID_SET: ReadonlySet<string> = new Set(
  BUDDY_VIDEO_MODEL_IDS.map((entry) => entry.id),
);

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
  ["hy4free", "Hy4 Free", true, true, 1_000_000, 64_000, true],
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

// ── buddy-discovery-shared ──────────────────────────────────────────

export const BUDDY_CN_MODELS_PATH = "/console/enterprises/personal/models" as const;

export const BUDDY_INTL_MODELS_PATH = "/v2/enterprises/personal/models" as const;

export const BUDDY_CONFIG_PATH = "/v3/config" as const;

const BUDDY_OK_CODE = 0;

interface BuddyDirectoryRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly disabled?: unknown;
  readonly maxInputTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsImages?: unknown;
  readonly supportsToolCall?: unknown;
  readonly supportsReasoning?: unknown;
  readonly tags?: unknown;
}

function siteOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

function asNumber(value: unknown): number | null {
  return sharedAsNumber(value) ?? null;
}

export async function fetchBuddyDirectoryModels(args: {
  readonly siteUrl: string;
  readonly providerId: string;
  readonly credential: string;
  readonly modelsPath: string;
  readonly endpoint: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetcher?: typeof fetch | undefined;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = args.fetcher ?? globalThis.fetch;
  // Fetch both catalog scopes and merge them. `/v3/config` is ranked higher and
  // is the primary source (matches the reference gateways), but the personal
  // models path carries models the v3 response does not always publish — so a
  // single-source read can silently miss models that are callable. Merging with
  // dedupe by model id gives the union, mirroring the upstream codebuddy2api
  // catalog aggregation. Each failure falls through to the other source, so a
  // host that answers only one behaves exactly as it does today.
  const v3 = await fetchBuddyDirectoryOnce(args, fetcher, BUDDY_CONFIG_PATH);
  const personal = await fetchBuddyDirectoryOnce(args, fetcher, args.modelsPath);
  if (v3 !== null && personal !== null) return mergeBuddyDirectories(v3, personal);
  return v3 ?? personal;
}

function mergeBuddyDirectories(
  primary: readonly ModelDefinition[],
  supplemental: readonly ModelDefinition[],
): readonly ModelDefinition[] {
  const seen = new Set<string>();
  const merged: ModelDefinition[] = [];
  for (const model of primary) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    merged.push(model);
  }
  for (const model of supplemental) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    merged.push(model);
  }
  return merged;
}

async function fetchBuddyDirectoryOnce(
  args: {
    readonly siteUrl: string;
    readonly providerId: string;
    readonly credential: string;
    readonly endpoint: string | undefined;
    readonly signal?: AbortSignal | undefined;
  },
  fetcher: typeof fetch,
  path: string,
): Promise<readonly ModelDefinition[] | null> {
  // The directory scores by account: an access token's `sub` is the uid. An
  // opaque API key carries no identity, and the endpoint still answers for it,
  // so the header is declared absent rather than guessed.
  const uid = buddyAccountUid(args.credential);
  let response: Response;
  try {
    response = await fetcher(`${siteOrigin(args.siteUrl)}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${args.credential}`,
        "x-product": "SaaS",
        ...(uid === undefined ? { "x-no-user-id": "1" } : { "x-user-id": uid }),
        "x-no-enterprise-id": "1",
        "x-no-department-info": "1",
      },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const envelope = asRecord(body);
  if (envelope === undefined || envelope["code"] !== BUDDY_OK_CODE) return null;
  const data = asRecord(envelope["data"]);
  const rawModels = data?.["models"];
  if (!Array.isArray(rawModels)) return null;

  // The CLI agent's roster, when published, is the callable subset.
  const agents = data?.["agents"];
  let cliRoster: Set<string> | undefined;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      const agent = asRecord(entry);
      if (agent?.["name"] !== "cli") continue;
      const listed = agent["models"];
      if (Array.isArray(listed) && listed.length > 0) {
        cliRoster = new Set(listed.filter((id): id is string => typeof id === "string"));
      }
      break;
    }
  }

  const entries: BuddyRawEntry[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const model = asRecord(entry) as BuddyDirectoryRow | undefined;
    const id = model?.id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    if (model?.disabled === true) continue;
    // Completion, NES, and codewise rows are not chat models. Listing them
    // offers a route that 400s on a chat request. A declared output of 256 or
    // less is the same signal: a completion model published with a chat-sized
    // name. `text-to-image` is an image row, served by the image roster.
    const lowerId = id.toLowerCase();
    if (lowerId.startsWith("nes-") || lowerId.startsWith("completion-") || lowerId.startsWith("codewise-")) continue;
    const output = asNumber(model?.maxOutputTokens);
    if (output !== null && output <= 256) continue;
    const tags = model?.tags;
    if (Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "text-to-image")) continue;
    if (cliRoster !== undefined && !cliRoster.has(id)) continue;
    seen.add(id);
    entries.push([
      id,
      typeof model?.name === "string" && model.name.length > 0 ? model.name : id,
      model?.supportsReasoning === true,
      model?.supportsImages === true,
      asNumber(model?.maxInputTokens),
      asNumber(model?.maxOutputTokens),
      model?.supportsToolCall === true,
    ]);
  }
  if (entries.length === 0) return null;
  return entries.map((entry) => makeBuddyModel(entry, args.providerId, args.endpoint));
}

// ── codebuddy/cn-catalog ──────────────────────────────────────────

export const CODEBUDDY_CN_RAW: readonly BuddyRawEntry[] = [
  ["glm-5.1", "GLM 5.1", true, true, 200_000, 48_000],
  ["glm-5.2", "GLM 5.2", true, true, 1_000_000, 64_000],
  ["glm-5.3", "GLM 5.3", true, true, 1_000_000, 64_000],
  ["glm-5.3-flash", "GLM 5.3 Flash", true, true, 1_000_000, 131_072],
  ["glm-5v-turbo", "GLM 5v Turbo", true, true, 200_000, 64_000],
  ["minimax-m3", "MiniMax M3", true, true, 512_000, 64_000],
  // 1M context, reasoning always on (upstream states both); vision inherited
  // from the M3 row, which is the same family.
  ["minimax-m3.1-flash", "MiniMax M3.1 Flash", true, true, 1_000_000, 128_000],
  ["mimo-v2.6-pro", "MiMo V2.6 Pro", true, true, 1_000_000, 128_000],
  ["kimi-k2.8-preview", "Kimi K2.8 Preview", true, true, 1_000_000, 64_000],
  ["kimi-k3.1-pro", "Kimi K3.1 Pro", true, true, 1_000_000, 32_000],
  ["hy3", "Hy3", true, true, 192_000, 64_000],
  ["hy4", "Hy4", true, true, 960_000, 64_000],
  ["hy4free", "Hy4 Free", true, true, 960_000, 64_000],
  ["space-bunny", "Space Bunny", true, true, 1_000_000, 128_000],
  ["step-5-preview", "Step 5 Preview", true, true, 1_000_000, 64_000],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", true, true, 1_000_000, 128_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, true, 1_000_000, 128_000],
  // Live on the CN roster but absent here, so a request for it resolved to
  // nothing. Limits as published by /v3/config.
  ["kimi-k3-1", "Kimi K3-1", true, true, 1_000_000, 32_000],
  ["minimax-m2.7", "MiniMax M2.7", true, true, 200_000, 48_000],
];
