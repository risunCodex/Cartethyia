// Cursor live model catalog and Run-origin discovery.
//
// Two unary Connect-RPC calls on the API host back this module:
// `/aiserver.v1.AiService/AvailableModels` for the roster and
// `/aiserver.v1.ServerConfigService/GetServerConfig` for the region-specific Run
// origin. Both go through the validated outbound fetch the dispatch path hands
// the adapter, so a catalog refresh obeys the same SSRF policy and the same
// network pool as a dispatch.
//
// Nothing here invents a capability. A model is marked image-capable, tool-
// capable, or reasoning-capable only because Cursor declared it; limits come
// from Cursor's own variant parameter or its own context fields.
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import {
  AVAILABLE_MODELS_PATH,
  CURSOR_API_BASE_URL,
  CURSOR_PROVIDER_ID,
  FALLBACK_CLIENT_VERSION,
  SERVER_CONFIG_PATH,
  normalizeAgentRunOrigin,
  resolveCursorTimezone,
} from "./cursor-shared";
import { createCursorChecksumHeader, resolveCursorDeviceIds } from "./cursor-identity";

/** One parameter value of a Cursor-declared model variant. */
export interface CursorParameterValue {
  readonly id: string;
  readonly value: string;
}

/** One variant (parameter tuple) Cursor advertises for a model. */
export interface CursorModelVariant {
  readonly displayName: string;
  readonly parameterValues: readonly CursorParameterValue[];
  readonly isDefaultNonMax: boolean;
  readonly isDefaultMax: boolean;
  readonly isMaxMode: boolean;
}

/** One model entry as Cursor declares it. */
export interface CursorModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly maxContext?: number;
  readonly maxContextForMaxMode?: number;
  readonly supportsImages?: boolean;
  readonly supportsThinking?: boolean;
  readonly supportsAgent?: boolean;
  readonly supportsMaxMode?: boolean;
  readonly variants: readonly CursorModelVariant[];
}

/** Headers every Cursor unary call carries, matching the CLI's identity. */
async function unaryHeaders(
  credential: string,
  clientVersion: string,
): Promise<Record<string, string>> {
  const { machineId, macMachineId } = await resolveCursorDeviceIds();
  return {
    authorization: `Bearer ${credential}`,
    "connect-protocol-version": "1",
    "content-type": "application/json",
    accept: "application/json",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": clientVersion,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    "x-ghost-mode": "true",
    "x-request-id": crypto.randomUUID(),
    ...(resolveCursorTimezone() === "" ? {} : { "x-cursor-timezone": resolveCursorTimezone() }),
  };
}

async function postUnary(
  fetcher: typeof fetch,
  path: string,
  credential: string,
  body: unknown,
  clientVersion: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${CURSOR_API_BASE_URL}${path}`, {
    method: "POST",
    headers: await unaryHeaders(credential, clientVersion),
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Cursor ${path} failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Cursor ${path} returned malformed JSON`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalBoolean(
  record: Record<string, unknown>,
  names: readonly string[],
): boolean | undefined {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue;
    const value = record[name];
    return typeof value === "boolean" ? value : undefined;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parses Cursor's `200k` / `1m` context spelling into tokens. */
export function parseCursorContextLimit(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(text);
  if (match !== null) {
    const multiplier = match[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000;
    const limit = Number(match[1]) * multiplier;
    return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
  }
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeParameterValues(value: unknown): CursorParameterValue[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const parameters: CursorParameterValue[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) return undefined;
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    const parameterValue = entry["value"] ?? entry["value"];
    if (id.length === 0 || typeof parameterValue !== "string") return undefined;
    parameters.push({ id, value: parameterValue });
  }
  return parameters;
}

/**
 * Maps a live `AvailableModels` response onto Cursor model entries.
 *
 * Every entry's capability is Cursor's own declaration. A malformed variant or
 * a non-boolean capability throws rather than being coerced: a catalog that
 * guesses "supports images" where Cursor said nothing routes image traffic to a
 * model that will refuse it.
 */
export function mapAvailableModelsResponse(raw: Record<string, unknown>): CursorModelInfo[] {
  const entries = Array.isArray(raw["models"]) ? raw["models"] : [];
  const models: CursorModelInfo[] = [];
  for (const entry of entries) {
    if (!isPlainRecord(entry)) continue;
    const id = typeof entry["name"] === "string" ? entry["name"].trim() : "";
    if (id.length === 0) continue;
    const rawVariants = entry["variants"] ?? [];
    if (!Array.isArray(rawVariants)) {
      throw new Error(`Cursor AvailableModels returned invalid variants for ${id}`);
    }
    const variants: CursorModelVariant[] = [];
    for (const variant of rawVariants) {
      if (!isPlainRecord(variant)) {
        throw new Error(`Cursor AvailableModels returned an invalid variant for ${id}`);
      }
      const parameterValues = normalizeParameterValues(
        variant["parameterValues"] ?? variant["parameter_values"],
      );
      if (parameterValues === undefined) {
        throw new Error(`Cursor AvailableModels returned invalid parameter values for ${id}`);
      }
      const isMaxMode = optionalBoolean(variant, ["isMaxMode", "is_max_mode"]) ?? false;
      variants.push({
        displayName: (typeof variant["displayName"] === "string"
          ? variant["displayName"]
          : typeof variant["display_name"] === "string"
            ? variant["display_name"]
            : id) as string,
        parameterValues,
        isDefaultNonMax:
          optionalBoolean(variant, ["isDefaultNonMaxConfig", "is_default_non_max_config"]) ?? false,
        isDefaultMax:
          optionalBoolean(variant, ["isDefaultMaxConfig", "is_default_max_config"]) ?? false,
        isMaxMode,
      });
    }
    const contextOf = (variant: CursorModelVariant | undefined): number | undefined =>
      parseCursorContextLimit(variant?.parameterValues.find((p) => p.id === "context")?.value);
    const baseContext =
      contextOf(variants.find((variant) => variant.isDefaultNonMax)) ??
      contextOf(variants.find((variant) => variant.isDefaultMax) ?? variants[0]) ??
      positiveNumber(entry["contextTokenLimit"] ?? entry["context_token_limit"]);
    const maxContext =
      contextOf(variants.find((variant) => variant.isDefaultMax)) ??
      positiveNumber(entry["contextTokenLimitForMaxMode"] ?? entry["context_token_limit_for_max_mode"]);
    models.push({
      id,
      displayName: (typeof entry["clientDisplayName"] === "string"
        ? entry["clientDisplayName"]
        : typeof entry["client_display_name"] === "string"
          ? entry["client_display_name"]
          : id) as string,
      ...(baseContext === undefined ? {} : { maxContext: baseContext }),
      ...(maxContext === undefined ? {} : { maxContextForMaxMode: maxContext }),
      ...(() => {
        const images = optionalBoolean(entry, ["supportsImages", "supports_images"]);
        return images === undefined ? {} : { supportsImages: images };
      })(),
      supportsThinking: optionalBoolean(entry, ["supportsThinking", "supports_thinking"]) ?? false,
      supportsAgent: optionalBoolean(entry, ["supportsAgent", "supports_agent"]) ?? false,
      supportsMaxMode: optionalBoolean(entry, ["supportsMaxMode", "supports_max_mode"]) ?? false,
      variants,
    });
  }
  return models;
}

/**
 * Cursor's declared default parameter tuple for one model.
 *
 * The public catalog lists one row per model and sends Cursor's own default:
 * no variant picker is part of this integration, so the tuple is the one Cursor
 * marked default (its max default when the model runs in max mode, otherwise its
 * non-max default). An empty tuple is correct for a model that declares none.
 */
export function defaultParameterValues(
  model: CursorModelInfo | undefined,
  maxMode = false,
): CursorParameterValue[] {
  if (model === undefined || model.variants.length === 0) return [];
  const tier = model.variants.filter((variant) => variant.isMaxMode === maxMode);
  const candidates = tier.length > 0 ? tier : model.variants;
  const declared = candidates.find((variant) =>
    maxMode ? variant.isDefaultMax : variant.isDefaultNonMax,
  );
  const chosen = declared ?? candidates.find((variant) => variant.isMaxMode === maxMode) ?? candidates[0];
  return chosen === undefined ? [] : chosen.parameterValues.map((parameter) => ({ ...parameter }));
}

/** Projects one Cursor model entry onto a Cartethyia catalog row. */
export function cursorModelDefinition(model: CursorModelInfo): ModelDefinition {
  return cursorModel(model.id, model.maxContext, {
    vision: model.supportsImages === true,
    reasoning: model.supportsThinking === true,
  });
}

function cursorModel(
  modelId: string,
  ctx?: number,
  options: { vision?: boolean; reasoning?: boolean; out?: number } = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: CURSOR_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: "/agent.v1.AgentService/Run",
    ...(ctx === undefined ? {} : { ctx }),
    ...(options.out === undefined ? {} : { out: options.out }),
    // Tools are served through Cursor's MCP exec channel, which this adapter
    // answers for every request that declares tools — so the row advertises
    // them and the adapter refuses anything it did not advertise.
    toolCall: true,
    vision: options.vision ?? true,
    reasoning: options.reasoning ?? false,
  });
}

/**
 * Static fallback catalog for Cursor.
 *
 * The authoritative roster is resolved per account from `AvailableModels`,
 * while these static rows give the provider offline floor visibility and
 * establish canonical IDs for Auto and Grok 4.6/4.7.
 *
 * `auto` is the only id surfaced for Cursor's Auto model: the upstream wire id
 * is `default` and the two are the same model, not two entries. Dispatch maps
 * `auto` is an alias: Cursor's own roster names its Auto model `default`, and
 * dispatch maps `auto` onto it, so seeding the upstream id as well would list
 * the same model twice. Grok ids are already upstream ids and are not rewritten.
 *
 * Output is stated explicitly: `defineModel` would otherwise inherit a
 * base-catalog output equal to the whole 256k window, which is not a limit
 * Cursor serves and makes admission reserve the entire context as headroom.
 */
export const CURSOR_MODELS: readonly ModelDefinition[] = [
  cursorModel("auto", 256_000, { vision: true, reasoning: false, out: 64_000 }),
  cursorModel("grok-4.6", 256_000, { vision: true, reasoning: true, out: 64_000 }),
  cursorModel("grok-4.7", 256_000, { vision: true, reasoning: true, out: 64_000 }),
];

/** Fetches Cursor's live model roster through validated egress. */
export async function fetchCursorModels(input: {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly clientVersion?: string;
}): Promise<CursorModelInfo[]> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const body = await postUnary(
    fetcher,
    AVAILABLE_MODELS_PATH,
    input.credential,
    // Parameterized effort/context/fast variants, as Cursor IDE requests them.
    {
      includeLongContextModels: true,
      useModelParameters: true,
      useCloudAgentEffortModes: true,
    },
    input.clientVersion ?? FALLBACK_CLIENT_VERSION,
    input.signal,
  );
  return mapAvailableModelsResponse(body);
}

/**
 * Resolves the Run-stream origin Cursor routes this account to.
 *
 * Fails closed: a region-routed account is silently rejected by the wrong
 * regional host, so a missing, malformed, non-HTTPS, or non-`*.cursor.sh` value
 * is an error rather than a fallback to the API host. The API origin does serve
 * auth and catalog calls, but it is not the origin `GetServerConfig` names for
 * Run, and assuming it does is what makes a Run land on a host that refuses it.
 */
export async function fetchCursorRunOrigin(input: {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly clientVersion?: string;
}): Promise<string> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const body = await postUnary(
    fetcher,
    SERVER_CONFIG_PATH,
    input.credential,
    { telem_enabled: false },
    input.clientVersion ?? FALLBACK_CLIENT_VERSION,
    input.signal,
  );
  const config = isPlainRecord(body["agentUrlConfig"]) ? body["agentUrlConfig"] : undefined;
  const raw = config?.["agentnUrl"] ?? config?.["agentUrl"];
  const origin = normalizeAgentRunOrigin(typeof raw === "string" ? raw : undefined);
  if (origin === null) {
    throw new Error(
      raw === undefined
        ? "Cursor GetServerConfig response missing agentUrlConfig.agentnUrl"
        : "Cursor GetServerConfig returned an invalid Cursor agent URL",
    );
  }
  return origin;
}

/** Discovery entry point: the live roster, as catalog rows. */
export async function discoverCursorModels(input: {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<readonly ModelDefinition[]> {
  const models = await fetchCursorModels(input);
  return models.map(cursorModelDefinition);
}
