/**
 * Ollama Cloud (`ollamacloud`) model catalog.
 *
 * The provider is discovery-backed: live `/v1/models` on `https://ollama.com/v1`
 * is the primary source and publishes every model's real context window. This
 * static floor keeps the models an operator most likely wants routable before
 * any account sync — and pins the verified live limits so a cold process never
 * falls back to the invented 200k/64k defaults.
 *
 * Limits below are taken from the live `/v1/models` roster (verified 2026-10):
 * - `gemma4:31b` -> 262144 ctx, text+image, thinking none/medium
 * - `gpt-oss:20b` / `gpt-oss:120b` -> 131072 ctx, text, reasoning low/med/high
 * - `nemotron-3-nano:30b` / `nemotron-3-super` / `nemotron-3-ultra`
 *   -> 262144 ctx, text, thinking none/medium
 *
 * All six serve the chat wire (none is a Responses-native id), and all report
 * `supported_in_api: true` on the live roster.
 */
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

export const OLLAMACLOUD_PROVIDER_ID = "ollamacloud" as const;

/** Chat path below the `/v1`-rooted base. */
const CHAT_ENDPOINT = "/chat/completions";

type CatalogRow = readonly [id: string, ctx: number, vision: boolean, reasoning: boolean];

function ollamaCloudModel([id, ctx, vision, reasoning]: CatalogRow): ModelDefinition {
  return defineModel({
    id,
    providerId: OLLAMACLOUD_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: CHAT_ENDPOINT,
    ctx,
    vision,
    reasoning,
    toolCall: true,
  });
}

/** Static Ollama Cloud floor; live discovery adds to it per account. */
export const OLLAMACLOUD_MODELS: readonly ModelDefinition[] = [
  ["gemma4:31b", 262_144, true, true] as const,
  ["gpt-oss:20b", 131_072, false, true] as const,
  ["gpt-oss:120b", 131_072, false, true] as const,
  ["nemotron-3-nano:30b", 262_144, false, true] as const,
  ["nemotron-3-super", 262_144, false, true] as const,
  ["nemotron-3-ultra", 262_144, false, true] as const,
].map(ollamaCloudModel);
