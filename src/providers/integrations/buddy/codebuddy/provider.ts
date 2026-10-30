// CodeBuddy International adapter — exact provider contract.
// Canonical provider ID: cb
// Base (manifest-owned CODEBUDDY_BASE_URL) → Chat: base + /chat/completions
// Auth: Authorization Bearer for both api_key and oauth
// Stream: force stream=true upstream, factory reaggregates for non-stream callers
// Headers: per-provider CodeBuddy headers with fresh correlation IDs per dispatch
// Payload: leading CodeBuddy system prompt + typed user content, reasoning_summary auto only when reasoning_effort

import { BuddyMediaAdapter } from "../buddy-media";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderAdapter } from "../../../provider-contracts";
import type { ModelDefinition } from "../../../provider-model-definition";
import type { DiscoveryInput } from "../../../discovery/discovery-types";
import { GatewayError } from "../../../../protocol/gateway-error";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import { providerBaseUrl } from "../../../provider-metadata";
import {
  codebuddyAdapterConfig,
  codebuddyHeaders,
} from "./shared";
import {
  BUDDY_SHARED_RAW,
  BUDDY_IMAGE_MODEL_ID_SET,
  BUDDY_VIDEO_MODEL_ID_SET,
  makeBuddyModel,
  makeBuddyImageModels,
  makeBuddyVideoModels,
  type BuddyRawEntry,
} from "../buddy-catalog-shared";
import { BUDDY_INTL_MODELS_PATH, fetchBuddyDirectoryModels } from "../buddy-discovery-shared";
import {
  applyBuddySystemPrompt,
  buddyPrePayloadCommon,
  injectBuddyParallelToolCalls,
  normalizeBuddyToolNames,
} from "../buddy-chat-shared";


// Constants — public contract
export const CODEBUDDY_PROVIDER_ID = "cb" as const;
export const CODEBUDDY_BASE_URL = providerBaseUrl("cb");
// Upstream model translation — preserve provider mapping

// Payload hook — provider intl semantics
// - force stream=true
// - reasoning_summary auto only when reasoning_effort requested
// - upstreamId translation
// - leading CodeBuddy system prompt + typed user content normalization

/**
 * Leading system turn for this variant.
 *
 * The wire contract is that the request *opens* with a `system` turn (code
 * `11128`); the gateway replaces any caller `system`/`developer` turn with this
 * fixed prompt. The text is the CodeBuddy CLI's own leading prompt — the same
 * one the reference client (and the donor gateway's `prepend` prompt mode)
 * sends — so a proxied request is byte-faithful to an official client rather
 * than a neutral stand-in.
 *
 * Keeping the official identity is forward-compatible: the upstream is not
 * observed to validate this text today, but a proxy that claims the real
 * client's identity cannot be caught out if it starts to. A previous neutral
 * persona ("You are a pragmatic and direct software engineering assistant…")
 * worked, but diverged from every request the official CLI emits.
 */
export const CODEBUDDY_SYSTEM_PROMPT =
  "You are CodeBuddy Code.\n\n" +
  "You are an interactive CLI tool that helps users with software engineering tasks. " +
  "Use the instructions below and the tools available to you to assist the user. " +
  "Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.";

function codeBuddyIntlPrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
  context?: ProviderDispatchContext,
): void {
  // International ladder: DeepSeek Flash and friends serve only `high`.
  buddyPrePayloadCommon(payload, request, "intl", context);
  const rawModel = payload["model"];
  const source =
    typeof rawModel === "string" && rawModel.length > 0
      ? rawModel
      : candidate.model_id;
  if (!source) throw new GatewayError("invalid_request", 400, "CodeBuddy model is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    applyBuddySystemPrompt(
      messages as Array<Record<string, unknown>>,
      CODEBUDDY_SYSTEM_PROMPT,
      context?.tenant_system_prompt,
    );
  }
  normalizeBuddyToolNames(payload);
  injectBuddyParallelToolCalls(payload, request);
  void request;
}

// Model catalog — shared CodeBuddy / WorkBuddy international roster

const CODEBUDDY_INTL_RAW: readonly BuddyRawEntry[] = BUDDY_SHARED_RAW;

/**
 * CodeBuddy's image generation rows.
 *
 * These ids also sit on the shared chat roster as ordinary `llm` rows, which is
 * why they were unreachable as image models: nothing downstream could tell a
 * chat model from one that returns an image, so `mediaGeneration` was false for
 * every catalog row. The roster and the declared capabilities come from
 * {@link makeBuddyImageModels} so cb and WorkBuddy cannot drift.
 */
export const CODEBUDDY_IMAGE_MODELS: readonly ModelDefinition[] = makeBuddyImageModels(
  "cb",
  "/images/generations",
);

/**
 * CodeBuddy's video-generation rows (`seedance-2.5`).
 *
 * Reached through `/videos/generations` on the `/v2` base, so the endpoint is
 * the upstream video path rather than a chat-completions path.
 */
export const CODEBUDDY_VIDEO_MODELS: readonly ModelDefinition[] = makeBuddyVideoModels(
  "cb",
  "/videos/generations",
);

/**
 * The full cb catalog the registry loads: chat roster plus image and video rows.
 *
 * The image and video ids are filtered out of the chat pass so one id never
 * appears under two service kinds. Exported as a single list so
 * `default-registry.ts` keeps one import for this provider.
 */
export const CODEBUDDY_MODELS: readonly ModelDefinition[] = [
  ...CODEBUDDY_INTL_RAW.filter(
    (entry) => !BUDDY_IMAGE_MODEL_ID_SET.has(entry[0]) && !BUDDY_VIDEO_MODEL_ID_SET.has(entry[0]),
  ).map((entry) => makeBuddyModel(entry, "cb")),
  ...CODEBUDDY_IMAGE_MODELS,
  ...CODEBUDDY_VIDEO_MODELS,
];

/**
 * Reads the CodeBuddy intl console directory.
 *
 * The static `CODEBUDDY_MODELS` above stays the fallback — this console is
 * documented to answer 500 intermittently — while discovery carries the
 * upstream's own limits and capability flags.
 */
export async function discoverCodeBuddyModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: CODEBUDDY_BASE_URL,
    providerId: CODEBUDDY_PROVIDER_ID,
    credential: input.credential,
    modelsPath: BUDDY_INTL_MODELS_PATH,
    endpoint: undefined,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

// Public factory — uses OpenAI-compatible factory but forces provider semantics
// Supports both api_key and oauth via Authorization Bearer (factory handles both)

export function createCodeBuddyAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new BuddyMediaAdapter(
    codebuddyAdapterConfig({
      providerId: CODEBUDDY_PROVIDER_ID,
      baseUrl: CODEBUDDY_BASE_URL,
      variant: "IDE",
      cliIdentity: true,
      prePayload: codeBuddyIntlPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    {
      variant: "IDE",
      // BuddyMediaConfig has no `cliIdentity`; the CLI identity is selected by
      // supplying the builder that takes it.
      buildHeaders: (context, request) => codebuddyHeaders("IDE", context, request, true),
      systemPrompt: CODEBUDDY_SYSTEM_PROMPT,
      baseUrl: CODEBUDDY_BASE_URL,
      imageGenerationPath: "/images/generations",
    },
  );
}
