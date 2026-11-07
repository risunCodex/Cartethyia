/**
 * Devin model catalog: live discovery via `GetCliModelConfigs` plus a static
 * seed for boot. Ported from oh-my-pi (`discovery/devin.ts`, MIT) with the
 * Cartethyia `defineModel` shape.
 */

import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { callDevinUnary } from "./devin-http";
import {
  DEVIN_CHAT_MESSAGE_PATH,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_INTERNAL_MODEL_DISPLAYS,
  devinDiscoveryMetadata,
} from "./devin-shared";
import { DevinMessageTypes } from "./protocol/devin-proto";

const DISCOVERY_TIMEOUT_MS = 15_000;

/** Static seed shown before discovery succeeds (boot-safe, synchronous). */
export const DEVIN_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "swe-1-6-fast",
    providerId: "devin",
    wireFamily: "chat",
    endpoint: DEVIN_CHAT_MESSAGE_PATH,
    ctx: DEFAULT_CONTEXT_WINDOW,
    out: 128_000,
    // No vision: paired live control showed both available models either
    // ignore or reject inline images. Declaring it would route images into a
    // guaranteed failure.
    reasoning: true,
    toolCall: true,
  }),
  // `swe-1-6` removed: not present in the live `GetCliModelConfigs` roster on
  // this account (1003 of 1010 configs are disabled) and a chat dispatch to
  // it failed with `failed_precondition`.
  // Operator-declared lanes. The upstream catalog has not been fetched live
  // yet, so these rows are pinned from the measured spec rather than generated.
  defineModel({
    id: "swe-1-6-slow",
    providerId: "devin",
    wireFamily: "chat",
    endpoint: DEVIN_CHAT_MESSAGE_PATH,
    ctx: 200_000,
    out: 128_000,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "swe-2-flash-medium",
    providerId: "devin",
    wireFamily: "chat",
    endpoint: DEVIN_CHAT_MESSAGE_PATH,
    // Live `GetCliModelConfigs` (2026-11-07): ctx=262144, maxOutput=131072,
    // features = thinking + tools. This uid is the account default.
    ctx: 262_144,
    out: 131_072,
    reasoning: true,
    toolCall: true,
  }),
];

interface RawModelConfig {
  modelUid?: string;
  label?: string;
  disabled?: boolean;
  supportsImages?: boolean;
  maxTokens?: number;
  description?: string;
  isNew?: boolean;
  isBeta?: boolean;
  isRecommended?: boolean;
  isDefaultModelInFamily?: boolean;
  modelInfo?: {
    maxTokens?: number;
    maxOutputTokens?: number;
    displayOption?: number;
    harnessUids?: string[];
    isModelRouter?: boolean;
    modelFeatures?: { supportsImages?: boolean; supportsToolCalls?: boolean; supportsThinking?: boolean };
  };
  modelDimensions?: { label?: string; value?: number; denominator?: string; kind?: number }[];
}

const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

function supportsThinking(config: RawModelConfig): boolean {
  const features = config.modelInfo?.modelFeatures;
  if (features) return features.supportsThinking === true;
  const label = config.label ?? "";
  if (NO_REASONING_LABEL_PATTERN.test(label)) return false;
  return REASONING_LABEL_PATTERN.test(label);
}

function modelCost(config: RawModelConfig): { input: number; output: number; cache_read: number } {
  let input = 0;
  let output = 0;
  let cache_read = 0;
  const dims = config.modelDimensions ?? [];
  for (const dim of dims) {
    if (dim.kind !== 1 && dim.kind !== 2) continue; // COST / COST_FUZZY
    if ((dim.label ?? "").toLowerCase() === "sidekick") break;
    let value = dim.value ?? 0;
    const denom = dim.denominator ?? "";
    const m = denom.match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
    let divisor = 1_000_000;
    if (m) {
      const num = Number(m[1]);
      const suffix = m[2]?.toLowerCase();
      if (suffix === "k") divisor = num * 1_000;
      else if (suffix === "m") divisor = num * 1_000_000;
      else if (suffix === "b") divisor = num * 1_000_000_000;
      else divisor = num;
    }
    value = (value * 1_000_000) / divisor;
    const label = (dim.label ?? "").toLowerCase();
    if (label.includes("input")) input = Math.round(value * 1e6) / 1e6;
    else if (label.includes("output")) output = Math.round(value * 1e6) / 1e6;
    else if (label.includes("cached")) cache_read = Math.round(value * 1e6) / 1e6;
  }
  return { input, output, cache_read };
}

export interface DevinDiscoveryInput {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}

/** Live discovery: GetCliModelConfigs -> ModelDefinition rows. */
export async function discoverDevinModels(
  input: DevinDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const { credential, fetcher } = input;
  const request = {
    metadata: devinDiscoveryMetadata(credential),
  };
  const response = await callDevinUnary<{ clientModelConfigs?: RawModelConfig[]; defaultOverrideModelConfig?: { modelUid?: string } }>(
    DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
    DevinMessageTypes.GetCliModelConfigsRequest,
    DevinMessageTypes.GetCliModelConfigsResponse,
    request,
    {
      baseUrl: DEVIN_DEFAULT_BASE_URL,
      ...(fetcher === undefined ? {} : { fetchImpl: fetcher }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    },
  );
  const configs = response.clientModelConfigs ?? [];
  const defaultUid = response.defaultOverrideModelConfig?.modelUid?.trim();

  const rows: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    if (config.disabled) continue;
    const uid = config.modelUid?.trim();
    if (!uid || seen.has(uid)) continue;
    const displayOption = config.modelInfo?.displayOption ?? 0;
    if (DEVIN_INTERNAL_MODEL_DISPLAYS.has(displayOption)) continue;
    seen.add(uid);

    const features = config.modelInfo?.modelFeatures;
    // Operator-pinned lanes, confirmed against live `GetCliModelConfigs`:
    // `swe-2-flash-medium` = 262144/131072 (account default),
    // `swe-1-6-slow` = 200000/128000.
    const pinnedContext = uid === "swe-2-flash-medium" ? 262_144 : uid === "swe-1-6-slow" ? 200_000 : undefined;
    const pinnedOutput = uid === "swe-2-flash-medium" ? 131_072 : undefined;
    const contextLimit =
      pinnedContext ?? ((config.maxTokens ?? 0) > 0 ? config.maxTokens! : (config.modelInfo?.maxTokens ?? 0) > 0 ? config.modelInfo!.maxTokens! : DEFAULT_CONTEXT_WINDOW);
    const outputLimit = pinnedOutput ?? ((config.modelInfo?.maxOutputTokens ?? 0) > 0 ? config.modelInfo!.maxOutputTokens! : DEFAULT_MAX_TOKENS);
    // `supportsImages` from the server is NOT an entitlement: live paired
    // control showed `swe-1-6-slow` (supportsImages=true) answering the same
    // "cannot see" with and without an ImageData payload. Never advertise
    // vision for this provider; the adapter drops image parts entirely.
    const cost = modelCost(config);

    rows.push(
      defineModel({
        id: uid,
        providerId: "devin",
        wireFamily: "chat",
        endpoint: DEVIN_CHAT_MESSAGE_PATH,
        ctx: contextLimit,
        out: outputLimit,
        reasoning: supportsThinking(config),
        toolCall: features ? features.supportsToolCalls !== false : true,
        free: cost.input === 0 && cost.output === 0,
        ...(config.isNew ? { warnings: [{ kind: "is_new", message: "New model", severity: "info" as const }] } : {}),
        ...(config.isRecommended ? { warnings: [{ kind: "recommended", message: "Recommended by Devin", severity: "info" as const }] } : {}),
      }),
    );
  }

  // Account default wins: promote its row to default (first in list).
  if (defaultUid && seen.has(defaultUid)) {
    const idx = rows.findIndex((r) => r.modelId === defaultUid);
    if (idx > 0) {
      const [row] = rows.splice(idx, 1);
      rows.unshift(row!);
    }
  }

  return rows;
}
