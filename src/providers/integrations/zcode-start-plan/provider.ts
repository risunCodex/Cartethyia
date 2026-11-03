/**
 * ZCode Start Plan uses the client's three-block Messages prompt fingerprint.
 * Caller instructions remain inside the third block; a fourth block is refused.
 * The bundled prompt/version pair is kept together to preserve upstream bytes.
 * Reference provenance and bounded live acceptance evidence: provider guide.
 */
import { randomUUID } from "node:crypto";
import { release as osRelease } from "node:os";

import type { ApiKeyProviderSpec } from "../../configured-provider";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import { getOrCreateInstallId } from "../shared/install-id";
import prompt from "./zcode_prompt.json";

const CLI_PREFIX: string = prompt.cliPrefix;
const STABLE_SECTIONS: readonly string[] = prompt.stableSections;
const ENVIRONMENT_TEMPLATE: string = prompt.environmentTemplate;

export const ZCODE_START_PLAN_PROVIDER_ID = "zcode-start" as const;
export const ZCODE_START_PLAN_ENDPOINT_PATH = "/v1/messages" as const;
export const ZCODE_START_PLAN_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic" as const;

/** Client version the plan endpoint expects in the identity headers. */
const APP_VERSION = "3.14.5";

type Loose = Record<string, unknown>;
type TextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

function cached(text: string): TextBlock {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

/** Fills the environment block; the whole text is data, not layout. */
function environmentBlock(provider: string, model: string): string {
  return ENVIRONMENT_TEMPLATE.replace("{cwd}", process.cwd())
    .replace("{platform}", "linux")
    .replace("{shell}", "bash")
    .replace("{provider}", provider)
    .replace("{model}", model);
}

/** Identity headers every dispatch carries; the adapter adds Authorization. */
async function identityHeaders(): Promise<Record<string, string>> {
  return {
    "user-agent": `ZCode/${APP_VERSION} ai-sdk/anthropic/3.0.81`,
    "http-referer": "https://zcode.z.ai",
    "x-title": "Z Code@cli",
    "x-zcode-app-version": APP_VERSION,
    "x-zcode-agent": "glm",
    "x-release-channel": "production",
    "x-client-language": "en-US",
    "x-client-timezone": "Asia/Jakarta",
    "x-platform": "linux",
    "x-os-category": "linux",
    "x-os-version": osRelease(),
    "x-request-id": randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": randomUUID(),
    // Keep the persisted install-id filename stable across the provider-ID rename.
    "x-device-mid": await getOrCreateInstallId("zcode-start-plan"),
    "anthropic-version": "2023-06-01",
  };
}

/**
 * Replaces the payload's system prompt with the ZCode three-block fingerprint.
 * A caller-supplied system prompt is folded into the third block, after the
 * environment text: a separate block is rejected with 3012.
 */
function dress(payload: Loose, provider = "zcode"): void {
  const model = typeof payload.model === "string" ? payload.model : "";
  const own: string[] = [];
  const system = payload.system;
  if (typeof system === "string") {
    if (system.trim()) own.push(system);
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as Loose).type === "text" &&
        typeof (block as Loose).text === "string" &&
        (block as Loose).text
      ) {
        own.push((block as Loose).text as string);
      }
    }
  }
  const tail = [environmentBlock(provider, model), ...own].join("\n\n");
  payload.system = [
    cached(CLI_PREFIX),
    cached(STABLE_SECTIONS.join("\n\n")),
    cached(tail),
  ];
}

export const ZCODE_START_PLAN_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "glm-5.3",
    providerId: ZCODE_START_PLAN_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: ZCODE_START_PLAN_ENDPOINT_PATH,
    ctx: 1_000_000,
    out: 131_072,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "glm-5.3-flash",
    providerId: ZCODE_START_PLAN_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: ZCODE_START_PLAN_ENDPOINT_PATH,
    ctx: 1_000_000,
    out: 131_072,
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];

/** Start Plan adapter spec: direct upstream, prompt fingerprint, no sidecar. */
export const ZCODE_START_PLAN_SPEC: ApiKeyProviderSpec = {
  provider_id: ZCODE_START_PLAN_PROVIDER_ID,
  base_url: ZCODE_START_PLAN_BASE_URL,
  endpoint_paths_by_wire_family: { messages: ZCODE_START_PLAN_ENDPOINT_PATH },
  buildExtraHeaders: () => identityHeaders(),
  prePayload: (payload) => {
    dress(payload as Loose);
  },
};
