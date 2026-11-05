// CodeBuddy CN adapter — exact provider contract.
// Canonical provider ID: cbcn
// Base (manifest-owned CODEBUDDY_CN_BASE_URL) → Chat: base + /chat/completions
// Auth: Authorization Bearer for both api_key and oauth
// Stream: force stream=true upstream, factory reaggregates for non-stream callers
// Headers: per-provider CodeBuddy headers (CLI identity for CN)
// Payload: neutralize CN agent prompts, reasoning_summary auto only when reasoning_effort

import { BuddyMediaAdapter } from "../buddy-media";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderAdapter } from "../../../provider-contracts";
import type { ModelDefinition } from "../../../provider-model-definition";
import type { DiscoveryInput } from "../../../discovery/discovery-types";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import { ensurePayloadModel } from "../../../configured-provider";
import { providerBaseUrl } from "../../../provider-metadata";
import {
  codebuddyAdapterConfig,
} from "./shared";
import { CODEBUDDY_CN_RAW } from "./cn-catalog";
import { CODEBUDDY_SYSTEM_PROMPT } from "./provider";
import {
  BUDDY_CN_IMAGE_MODEL_ID_SET,
  BUDDY_CN_VIDEO_MODEL_ID_SET,
  makeBuddyCnImageModels,
  makeBuddyCnVideoModels,
  makeBuddyModel,
} from "../buddy-catalog-shared";
import { BUDDY_CN_MODELS_PATH, fetchBuddyDirectoryModels } from "../buddy-discovery-shared";
import {
  buddyPrePayloadCommon,
  finalizeBuddyMessages,
  injectBuddyParallelToolCalls,
  normalizeBuddyToolNames,
} from "../buddy-chat-shared";



// Constants — public contract

export const CODEBUDDY_CN_PROVIDER_ID = "cbcn" as const;
export const CODEBUDDY_CN_BASE_URL = providerBaseUrl("cbcn");
// Payload hook — provider CN semantics
// - force stream=true
// - reasoning_summary auto only when reasoning_effort
// - neutralize CN agent prompts (remove system agent instructions)

function isAgentPromptText(text: string): boolean {
  return /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i.test(
    text,
  );
}

const CODEBUDDY_CN_NEUTRAL_PROMPT = "You are a helpful assistant.";

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null && typeof part === "object" && "text" in part
        ? String((part as Record<string, unknown>)["text"] ?? "")
        : "",
    )
    .join("\n");
}

function neutralizeCnMessages(messages: Array<Record<string, unknown>>): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message["role"] !== "system") continue;
    const content = message["content"];
    const text = flattenContent(content);
    if (text.length <= 2_000 && !isAgentPromptText(text)) continue;
    messages[index] =
      typeof content === "string"
        ? { ...message, content: CODEBUDDY_CN_NEUTRAL_PROMPT }
        : {
            ...message,
            content: [{ type: "text", text: CODEBUDDY_CN_NEUTRAL_PROMPT }],
          };
  }
}

export function codeBuddyCnPrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
  context?: ProviderDispatchContext,
): void {
  // CN ladder: the CN backend serves `low`/`max` levels the international one
  // rejects, so the realm must be named rather than left to default to intl.
  buddyPrePayloadCommon(payload, request, "cn", context);
  if (Array.isArray(payload["messages"])) {
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    neutralizeCnMessages(messages);
    finalizeBuddyMessages(messages, { leadPrompt: CODEBUDDY_CN_NEUTRAL_PROMPT });
  }
  ensurePayloadModel(payload, candidate, "CodeBuddy CN");
  normalizeBuddyToolNames(payload);
  injectBuddyParallelToolCalls(payload, request);
  void request;
}

// Model catalog — CodeBuddy CN console and CLI catalog.
// Exported because `buddyModelOutputLimit` searches every buddy raw table, and
// a CN-only id would otherwise never get an output limit.
export { CODEBUDDY_CN_RAW };
/**
 * CN's image-generation rows (`hunyuan-image-alpha`).
 *
 * Reached through `/images/generations` like the international rows. The image
 * ids are filtered out of the chat pass so one id never appears under two
 * service kinds, matching how the intl catalog does it.
 */
export const CODEBUDDY_CN_IMAGE_MODELS: readonly ModelDefinition[] = makeBuddyCnImageModels(
  CODEBUDDY_CN_PROVIDER_ID,
  "/images/generations",
);

/**
 * CN's video-generation rows (`kling-video-v3`, `minimax-video-h3`).
 *
 * Reached through the native video route like the intl rows. The video ids
 * are filtered out of the chat pass so one id never appears under two service
 * kinds.
 */
export const CODEBUDDY_CN_VIDEO_MODELS: readonly ModelDefinition[] = makeBuddyCnVideoModels(
  CODEBUDDY_CN_PROVIDER_ID,
  "/videos/generations",
);

export const CODEBUDDY_CN_MODELS: readonly ModelDefinition[] = [
  ...CODEBUDDY_CN_RAW.filter(
    (entry) =>
      !BUDDY_CN_IMAGE_MODEL_ID_SET.has(entry[0]) &&
      !BUDDY_CN_VIDEO_MODEL_ID_SET.has(entry[0]),
  ).map((entry) =>
    makeBuddyModel(entry, CODEBUDDY_CN_PROVIDER_ID, undefined, "cn"),
  ),
  ...CODEBUDDY_CN_IMAGE_MODELS,
  ...CODEBUDDY_CN_VIDEO_MODELS,
];

/** Reads the CodeBuddy CN console directory (same envelope as the intl site). */
export async function discoverCodeBuddyCnModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: CODEBUDDY_CN_BASE_URL,
    providerId: CODEBUDDY_CN_PROVIDER_ID,
    credential: input.credential,
    modelsPath: BUDDY_CN_MODELS_PATH,
    endpoint: undefined,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

// Public factory

export function createCodeBuddyCnAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  // BuddyMediaAdapter, not OpenAICompatibleAdapter: the CN realm publishes an
  // image-generation row, and the plain compatible adapter has no image path,
  // so `hunyuan-image-alpha` would route to /chat/completions and fail.
  return new BuddyMediaAdapter(
    codebuddyAdapterConfig({
      providerId: CODEBUDDY_CN_PROVIDER_ID,
      baseUrl: CODEBUDDY_CN_BASE_URL,
      variant: "CLI",
      prePayload: codeBuddyCnPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    {
      variant: "CLI",
      // The CN realm has no separate system prompt of its own; the neutral CN
      // prompt is applied by `codeBuddyCnPrePayload`, so the media config
      // reuses the intl one purely to satisfy the required field. Image
      // generation sends a prompt, not a conversation, so this turn is
      // discarded by the image path in every case.
      systemPrompt: CODEBUDDY_SYSTEM_PROMPT,
      baseUrl: CODEBUDDY_CN_BASE_URL,
      imageGenerationPath: "/images/generations",
    },
  );
}
