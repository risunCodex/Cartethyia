import { BuddyMediaAdapter } from "../media";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderAdapter } from "../../../provider-contracts";
import type { ModelDefinition } from "../../../provider-model-definition";
import type { DiscoveryInput } from "../../../discovery/discovery-types";
import { GatewayError } from "../../../../protocol/gateway-error";
import type { CanonicalRequest } from "../../../../protocol/canonical-model";
import { providerBaseUrl } from "../../../provider-metadata";
import { ensurePayloadModel } from "../../../configured-provider";
import { codebuddyAdapterConfig, codebuddyDomain, codebuddyHeaders } from "./shared";
import {
  BUDDY_SHARED_RAW,
  BUDDY_IMAGE_MODEL_ID_SET,
  BUDDY_VIDEO_MODEL_ID_SET,
  BUDDY_INTL_MODELS_PATH,
  BUDDY_CN_MODELS_PATH,
  BUDDY_CN_IMAGE_MODEL_ID_SET,
  BUDDY_CN_VIDEO_MODEL_ID_SET,
  CODEBUDDY_CN_RAW,
  type BuddyRawEntry,
  makeBuddyModel,
  makeBuddyImageModels,
  makeBuddyVideoModels,
  makeBuddyCnImageModels,
  makeBuddyCnVideoModels,
  fetchBuddyDirectoryModels,
} from "../catalog";
import {
  applyBuddySystemPrompt,
  buddyPrePayloadCommon,
  finalizeBuddyMessages,
  injectBuddyParallelToolCalls,
  normalizeBuddyToolNames,
} from "../chat";
import {
  BuddyOAuthClient,
  type BuddyOAuthVariant,
  strictResponseCode,
  fetchTencentBillingQuota,
  fetchBuddyRequestUsage,
  type BuddyUsageResult,
} from "../account";
import { buildCodeBuddyUserAgent } from "../../../operations/client-versions";
import type { FetchLike, ProviderQuotaResult } from "../../../quota/quota-contracts";

// ── codebuddy/provider ──────────────────────────────────────────

export const CODEBUDDY_PROVIDER_ID = "cb" as const;

export const CODEBUDDY_BASE_URL = providerBaseUrl("cb");

export const CODEBUDDY_SYSTEM_PROMPT = "You are a helpful assistant.";

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

const CODEBUDDY_INTL_RAW: readonly BuddyRawEntry[] = BUDDY_SHARED_RAW;

export const CODEBUDDY_IMAGE_MODELS: readonly ModelDefinition[] = makeBuddyImageModels(
  "cb",
  "/images/generations",
);

export const CODEBUDDY_VIDEO_MODELS: readonly ModelDefinition[] = makeBuddyVideoModels(
  "cb",
  "/videos/generations",
);

export const CODEBUDDY_MODELS: readonly ModelDefinition[] = [
  ...CODEBUDDY_INTL_RAW.filter(
    (entry) => !BUDDY_IMAGE_MODEL_ID_SET.has(entry[0]) && !BUDDY_VIDEO_MODEL_ID_SET.has(entry[0]),
  ).map((entry) => makeBuddyModel(entry, "cb")),
  ...CODEBUDDY_IMAGE_MODELS,
  ...CODEBUDDY_VIDEO_MODELS,
];

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

export function createCodeBuddyAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new BuddyMediaAdapter(
    codebuddyAdapterConfig({
      providerId: CODEBUDDY_PROVIDER_ID,
      baseUrl: CODEBUDDY_BASE_URL,
      variant: "IDE",
      cliIdentity: true,
      prePayload: codeBuddyIntlPrePayload,
      // The intl CLI profile gzips the chat body and recovers a channel-check
      // 400 by retrying once on the console chat endpoint (donor behavior).
      requestCompression: "gzip",
      channelFallbackPath: "/console/chat/completions",
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

// ── codebuddy/cn-provider ──────────────────────────────────────────

export const CODEBUDDY_CN_PROVIDER_ID = "cbcn" as const;

export const CODEBUDDY_CN_BASE_URL = providerBaseUrl("cbcn");

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

export { CODEBUDDY_CN_RAW };

export const CODEBUDDY_CN_IMAGE_MODELS: readonly ModelDefinition[] = makeBuddyCnImageModels(
  CODEBUDDY_CN_PROVIDER_ID,
  "/images/generations",
);

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
      // The CN CLI profile gzips the chat body (donor behavior). The console
      // channel fallback is an intl-only recovery; CN has no second endpoint.
      requestCompression: "gzip",
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

// ── codebuddy/oauth ──────────────────────────────────────────

const CODEBUDDY_INTL_DEVICE_START_URL = `${providerBaseUrl("cb")}/plugin/auth/state`;

const CODEBUDDY_INTL_DEVICE_POLL_URL = `${providerBaseUrl("cb")}/plugin/auth/token`;

const CODEBUDDY_INTL_REFRESH_URL = `${providerBaseUrl("cb")}/plugin/auth/token/refresh`;

const CODEBUDDY_CN_DEVICE_START_URL = `${providerBaseUrl("cbcn")}/plugin/auth/state`;

const CODEBUDDY_CN_DEVICE_POLL_URL = `${providerBaseUrl("cbcn")}/plugin/auth/token`;

const CODEBUDDY_CN_REFRESH_URL = `${providerBaseUrl("cbcn")}/plugin/auth/token/refresh`;

export const CODEBUDDY_INTL_VARIANT: BuddyOAuthVariant = {
  providerId: "cb",
  providerLabel: "CodeBuddy",
  domain: "www.codebuddy.ai",
  platform: "ide",
  userAgent: async () => {
    return buildCodeBuddyUserAgent("IDE");
  },
  deviceStartUrl: CODEBUDDY_INTL_DEVICE_START_URL,
  devicePollUrl: CODEBUDDY_INTL_DEVICE_POLL_URL,
  refreshUrl: CODEBUDDY_INTL_REFRESH_URL,
  responseCode: strictResponseCode,
};

export const CODEBUDDY_CN_VARIANT: BuddyOAuthVariant = {
  providerId: "cbcn",
  providerLabel: "CodeBuddy",
  domain: "copilot.tencent.com",
  platform: "CLI",
  userAgent: async () => {
    return buildCodeBuddyUserAgent("CLI");
  },
  deviceStartUrl: CODEBUDDY_CN_DEVICE_START_URL,
  devicePollUrl: CODEBUDDY_CN_DEVICE_POLL_URL,
  refreshUrl: CODEBUDDY_CN_REFRESH_URL,
  responseCode: strictResponseCode,
};

export const codeBuddyOAuthClient = new BuddyOAuthClient(CODEBUDDY_INTL_VARIANT);

export const codeBuddyCnOAuthClient = new BuddyOAuthClient(CODEBUDDY_CN_VARIANT);

// ── codebuddy/quota ──────────────────────────────────────────

export const CODEBUDDY_CN_USAGE_URL =
  `${providerBaseUrl("cbcn")}/billing/meter/get-user-resource`;

export const CODEBUDDY_INTL_USAGE_URL =
  `${providerBaseUrl("cb")}/billing/meter/get-user-resource`;

const CODEBUDDY_CN_REQUEST_USAGE_URL =
  `${providerBaseUrl("cbcn")}/billing/meter/get-user-request-usage`;

const CODEBUDDY_INTL_REQUEST_USAGE_URL =
  `${providerBaseUrl("cb")}/billing/meter/get-user-request-usage`;

type CodeBuddyProviderId = "cb" | "cbcn";

async function cnHeaders(enterpriseId?: string): Promise<Record<string, string>> {
  return {
    "User-Agent": buildCodeBuddyUserAgent("CLI"),
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-Domain": codebuddyDomain("CLI"),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...(enterpriseId === undefined || enterpriseId.length === 0
      ? {}
      : { "X-Tenant-Id": enterpriseId, "X-Enterprise-Id": enterpriseId }),
  };
}

async function intlHeaders(enterpriseId?: string): Promise<Record<string, string>> {
  return {
    "User-Agent": buildCodeBuddyUserAgent("IDE"),
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "X-Domain": codebuddyDomain("IDE"),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...(enterpriseId === undefined || enterpriseId.length === 0
      ? {}
      : { "X-Tenant-Id": enterpriseId, "X-Enterprise-Id": enterpriseId }),
  };
}

function parseProviderId(providerId: string): CodeBuddyProviderId {
  const value = providerId.trim().toLowerCase();
  if (value === "cb") return "cb";
  if (value === "cbcn") return "cbcn";
  throw new Error(`Unsupported CodeBuddy provider ${providerId}`);
}

async function providerConfig(
  providerId: CodeBuddyProviderId,
  enterpriseId?: string,
): Promise<{
  url: string;
  headers: Record<string, string>;
  display: string;
}> {
  if (providerId === "cb") {
    return { url: CODEBUDDY_INTL_USAGE_URL, headers: await intlHeaders(enterpriseId), display: "CodeBuddy" };
  }
  return { url: CODEBUDDY_CN_USAGE_URL, headers: await cnHeaders(enterpriseId), display: "CodeBuddy CN" };
}

export async function fetchCodeBuddyQuota(
  credential: string,
  fetcher: FetchLike,
  providerId: string = "cbcn",
  enterpriseId?: string,
): Promise<ProviderQuotaResult> {
  const source = parseProviderId(providerId);
  const cfg = await providerConfig(source, enterpriseId);
  return fetchTencentBillingQuota({
    source,
    display: cfg.display,
    url: cfg.url,
    headers: cfg.headers,
    credential,
    fetcher,
    defaultPlan: "CodeBuddy",
  });
}

export const fetchCodeBuddyCnQuota = (
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> => fetchCodeBuddyQuota(credential, fetcher, "cbcn");

export const fetchCodeBuddyIntlQuota = (
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> => fetchCodeBuddyQuota(credential, fetcher, "cb");

export async function fetchCodeBuddyRequestUsage(
  credential: string,
  fetcher: FetchLike,
  providerId: string = "cbcn",
  days: number = 30,
  enterpriseId?: string,
): Promise<BuddyUsageResult> {
  const source = parseProviderId(providerId);
  const cfg = await providerConfig(source, enterpriseId);
  return fetchBuddyRequestUsage({
    url:
      source === "cb" ? CODEBUDDY_INTL_REQUEST_USAGE_URL : CODEBUDDY_CN_REQUEST_USAGE_URL,
    headers: cfg.headers,
    credential,
    fetcher,
    days,
  });
}
