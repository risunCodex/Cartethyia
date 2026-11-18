/**
 * Antigravity model catalog: the cross-brand model definitions served behind
 * the Antigravity wire (Google Gemini SKUs, Anthropic Claude SKUs, one GPT-OSS
 * SKU) plus the web-search rows.
 *
 * Split out of `antigravity.ts`, which re-exports this module's public surface
 * (`ANTIGRAVITY_PROVIDER_ID`, `ANTIGRAVITY_BASE_URL`, `ANTIGRAVITY_MODELS`,
 * `ANTIGRAVITY_SEARCH_MODELS`) so no importer changes. `GENERATE_PATH` /
 * `STREAM_GENERATE_PATH` are internal wire constants the adapter imports but
 * are not part of the facade surface.
 */
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import { providerBaseUrl } from "../../provider-metadata";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity" as const;
export const ANTIGRAVITY_BASE_URL = providerBaseUrl("antigravity");
/** Cloud Code Assist accepts `/v1internal:generateContent` for the same body Gemini's v1beta accepts. */
export const GENERATE_PATH = "/v1internal:generateContent" as const;
export const STREAM_GENERATE_PATH = "/v1internal:streamGenerateContent?alt=sse" as const;

const antigravityModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
  image = false,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "chat",
    endpoint: GENERATE_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning,
    ...(image
      ? { serviceKind: "imageGeneration" as const, output: ["image"] as const, toolCall: false }
      : { toolCall: true }),
  });

export const ANTIGRAVITY_MODELS: readonly ModelDefinition[] = [
  // Claude via Antigravity (Anthropic-branded SKUs, Gemini wire). The 4.6
  // rows are pinned at 64000 because Antigravity was observed rejecting
  // anything higher on `daily-cloudcode-pa`; `out` is published metadata, not
  // a request field (the envelope's `maxOutputTokens` comes from
  // `ANTIGRAVITY_MODEL_WIRE_PROFILES`).
  antigravityModel("claude-sonnet-4-6", 250_000, 64_000, true),
  antigravityModel("claude-opus-4-6", 250_000, 64_000, true),
  antigravityModel("claude-sonnet-5-5", 1_000_000, 128_000, true),
  antigravityModel("claude-opus-5-5", 1_000_000, 128_000, true),
  // Gemini text SKUs, as the Antigravity roster publishes them (verified live
  // 2026-11-03): Gemini SKUs ceiling at 65535/65536 output tokens.
  antigravityModel("gemini-2.5-flash", 1_000_000, 65_535, true),
  antigravityModel("gemini-2.5-flash-thinking", 1_000_000, 65_535, true),
  antigravityModel("gemini-2.5-flash-lite", 1_000_000, 65_535, true),
  antigravityModel("gemini-3-flash", 1_000_000, 65_536, true),
  antigravityModel("gemini-3.1-flash-lite", 1_000_000, 65_535, true),
  antigravityModel("gemini-3.5-flash-lite", 1_000_000, 65_535, true),
  antigravityModel("gemini-3.8-flash", 1_000_000, 65_536, true),
  antigravityModel("gemini-4-argon", 1_000_000, 65_536, true),
  antigravityModel("gemini-4-carbon", 1_000_000, 65_536, true),
  antigravityModel("gemini-4-hydrogen", 1_000_000, 65_536, true),
  // Tab (laptop-class) preview SKU.
  antigravityModel("tab_flash_lite_preview", 16_000, 4_000, true),
  // Gemini image generation. `gemini-3-pro-image` uses the same catalog
  // limits/capabilities as the existing `gemini-3.1-flash-image` row.
  antigravityModel("gemini-3.1-flash-image", 65_536, 65_536, false, true),
  antigravityModel("gemini-3-pro-image", 65_536, 65_536, false, true),
  // GPT-OSS via Antigravity (verified live 2026-11-03).
  antigravityModel("gpt-oss-120b", 131_072, 32_768, true),
];

/**
 * Web-search rows served by `/v1/search`. Antigravity grounds search through a
 * Gemini chat call with a `web_search` tool (see `websearch`); the cheap flash
 * SKU is the default search model.
 */
export const ANTIGRAVITY_SEARCH_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "gemini-2.5-flash",
    providerId: "antigravity",
    serviceKind: "websearch",
    wireFamily: "chat",
    // Empty endpoint: the adapter resolves the URL from the request stream flag
    // (`GENERATE_PATH`), so the row only needs to exist as a websearch route.
    // An empty value also keeps it distinct from the llm row (the unique key is
    // provider+model+endpoint).
    endpoint: "",
    ctx: 1_000_000,
    out: 65_535,
    vision: true,
    reasoning: true,
    toolCall: false,
  }),
];
