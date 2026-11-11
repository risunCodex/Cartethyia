// SenseNova providers (CN + Intl) — bearer-authenticated OpenAI-compatible
// chat + image generation.
//
// SenseNova API keys are per-site: keys created on platform.sensenova.cn are
// rejected by token.sensenova.ai with 401 {"error":{"code":16,"message":"Forbidden"}}
// (and vice versa), so each deployment is its own provider with its own host
// and catalog — the same split as CodeBuddy cb/cbcn.
//
// Wire facts:
//   - Chat is OpenAI-compatible `/v1/chat/completions` with Bearer auth.
//   - Image generation is `/v1/images/generations` (OpenAI-shaped `{model,
//     prompt, n, size, output_format, response_format, watermark,
//     prompt_extend}`), answering `{data: [{url|b64_json}]}`.
//   - Thinking streams under `reasoning` (delta + message) rather than
//     `reasoning_content`; the shared compatible adapter's chat decoder maps
//     it onto the canonical reasoning event.

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import type { ApiKeyProviderSpec } from "../../configured-provider";
import {
  fetchOpenAICompatibleModels,
} from "../../discovery/openai-model-discovery";

/** Chat path below each realm's `/v1` base root. */
const SENSENOVA_CHAT_PATH = "/chat/completions";
/** Image-generation path below each realm's `/v1` base root. */
const SENSENOVA_IMAGE_PATH = "/images/generations";

export const SENSENOVA_PROVIDER_ID = "sensenova" as const;
export const SENSENOVA_INTL_PROVIDER_ID = "sensenova-intl" as const;

function sensenovaSpec(providerId: string): ApiKeyProviderSpec {
  return {
    provider_id: providerId as ApiKeyProviderSpec["provider_id"],
    endpoint_paths_by_wire_family: { chat: SENSENOVA_CHAT_PATH },
  };
}

/** SenseNova CN adapter spec. */
export const SENSENOVA_SPEC: ApiKeyProviderSpec = sensenovaSpec(SENSENOVA_PROVIDER_ID);

/** SenseNova Intl adapter spec. */
export const SENSENOVA_INTL_SPEC: ApiKeyProviderSpec = sensenovaSpec(SENSENOVA_INTL_PROVIDER_ID);

/**
 * Shared chat roster (both realms expose the same model families; the intl
 * deployment advertises fewer static rows, and live discovery fills both).
 *
 * Image rows are media-generation rows (serviceKind `imageGeneration`), not
 * chat rows — they answer `/v1/images/generations` and are routed by the
 * native image route.
 */
const SENSENOVA_CHAT_MODELS: readonly string[] = [
  "sensenova-6.8-flash",
  "sensenova-6.8-flash-lite",
  "sensenova-6.7-flash-lite",
  "deepseek-flash",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
];

function makeChatModels(providerId: string): ModelDefinition[] {
  return SENSENOVA_CHAT_MODELS.map((id) =>
    defineModel({
      id,
      providerId,
      wireFamily: "chat",
      endpoint: SENSENOVA_CHAT_PATH,
      ctx: 200_000,
      out: 32_000,
      reasoning: true,
      toolCall: true,
    }),
  );
}

function makeImageModels(providerId: string): ModelDefinition[] {
  return [
    defineModel({
      id: "sensenova-u1.5-lite",
      providerId,
      wireFamily: "chat",
      serviceKind: "imageGeneration",
      endpoint: SENSENOVA_IMAGE_PATH,
      ctx: null,
      out: null,
      toolCall: false,
      output: ["image"],
    }),
    defineModel({
      id: "sensenova-u1.5-fast",
      providerId,
      wireFamily: "chat",
      serviceKind: "imageGeneration",
      endpoint: SENSENOVA_IMAGE_PATH,
      ctx: null,
      out: null,
      toolCall: false,
      output: ["image"],
    }),
    defineModel({
      id: "sensenova-u1-fast",
      providerId,
      wireFamily: "chat",
      serviceKind: "imageGeneration",
      endpoint: SENSENOVA_IMAGE_PATH,
      ctx: null,
      out: null,
      toolCall: false,
      output: ["image"],
    }),
  ];
}

/** Full CN catalog: chat + image rows. */
export const SENSENOVA_MODELS: readonly ModelDefinition[] = [
  ...makeChatModels(SENSENOVA_PROVIDER_ID),
  ...makeImageModels(SENSENOVA_PROVIDER_ID),
];

/** Full Intl catalog: chat + image rows. */
export const SENSENOVA_INTL_MODELS: readonly ModelDefinition[] = [
  ...makeChatModels(SENSENOVA_INTL_PROVIDER_ID),
  ...makeImageModels(SENSENOVA_INTL_PROVIDER_ID),
];

/** Live `/v1/models` listing for one realm. */
export function discoverSensenovaModels(options: {
  readonly baseUrl: string;
  readonly credential?: string;
  readonly fetcher?: typeof fetch;
  readonly providerId: string;
}): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: options.baseUrl,
    providerId: options.providerId,
    ...(typeof options.credential === "string" && options.credential.trim().length > 0
      ? { headers: { authorization: `Bearer ${options.credential}` } }
      : {}),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
}
