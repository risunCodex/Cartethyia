import type { ModelDefinition } from "../provider-model-definition";
import { isRecord } from "../../protocol/codecs";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../provider-sanitize";
import { modelsDevCatalog } from "./models-dev-catalog";
import { isResponsesNativeModelId } from "../provider-model-definition";
import { composeAbortSignal } from "../authentication/oauth-flow-store";
interface FetchModelsOptions {
  readonly baseUrl: string;
  /**
   * Canonical provider id for this discovery run. Passed through to the base
   * catalog so a model's context/output limits and pricing come from the row
   * for the provider actually serving it; omitting it opts into the
   * unambiguous-bare lookup, which fails closed when the catalog disagrees.
   */
  readonly providerId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/**
 * Tolerant OpenAI-compatible `/models` fetcher — provider-specific
 * `src/providers/discovery/openai-model-discovery.ts`. Handles `data|models|items`, various
 * pricing/context shapes, and responses wire family detection.
 */
export async function fetchOpenAICompatibleModels(
  options: FetchModelsOptions,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const signal = composeAbortSignal(options.signal, 10_000);
  try {
    const response = await fetcher(url, {
      headers: {
        ...(options.headers ?? {}),
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const entries = extractEntries(payload);
    if (entries === null) return null;
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      const id = sanitizeUpstreamLabel(entry.id);
      if (id === undefined) continue;
      const fallback = modelsDevCatalog.resolve(options.providerId ?? "", id);
      const parsedContext =
        positiveNumber(entry.context_length) ??
        positiveNumber((entry as Record<string, unknown>).input_token_limit) ??
        // `context_window` is the spelling an OpenAI-shaped catalog uses for
        // its own field. Unread, every model on such an upstream fell to the
        // 200_000 default below and was advertised at the same wrong window no
        // matter what the upstream reported — a 1M model shown as 200k.
        positiveNumber((entry as Record<string, unknown>).context_window) ??
        positiveNumber(entry.contextWindow) ??
        positiveNumber(entry.max_input_tokens) ??
        modalityContextLimit(entry);
      const contextWindow = parsedContext ?? fallback?.contextLimit ?? 200_000;

      // `max_completion_tokens` first: it is the name an OpenAI-shaped catalog
      // uses, and it is the name this gateway's own `/v1/models` emits. A
      // reader that knew only `max_output_tokens`/`maxTokens` saw none of them
      // and fell through to the 64_192 default, so every model on such an
      // upstream was advertised at the same wrong ceiling no matter what the
      // upstream reported.
      const parsedOutput =
        positiveNumber(entry.max_completion_tokens) ??
        positiveNumber(entry.max_output_tokens) ??
        positiveNumber((entry as Record<string, unknown>).max_output_tokens) ??
        positiveNumber(entry.maxTokens) ??
        positiveNumber((entry as Record<string, unknown>).completion_token_limit) ??
        modalityOutputLimit(entry);
      const maxOutputTokens = parsedOutput ?? fallback?.outputLimit ?? 64_192;
      const outputTokens = Math.min(maxOutputTokens, contextWindow);

      const cost = modelsDevCatalog.costFor(options.providerId ?? "", id);

      // Capability comes from the upstream's own `modality` field, never from
      // the base catalog: that lookup is keyed by bare model id and keeps only
      // the first provider row, so it would attribute a stranger's capabilities
      // to this gateway's serving. An undeclared capability is left to the
      // routing ladder's filter → degrade path.
      const rawModality = typeof entry.modality === "string" ? entry.modality : "";
      // Same reason it never comes from the base catalog: capability is what
      // the upstream declares for the model it serves. A catalog that declares
      // it as an `input_modalities[]` array instead of a `modality` string was
      // read as text-only, so a vision model lost image input.
      // `capabilities.input` is a third spelling — an array of modality names,
      // used by OpenAI-shaped catalogs including this gateway's own. Read
      // alongside the other two so a vision model is not downgraded to
      // text-only, which then drops image parts before they reach the upstream.
      const hasImage =
        rawModality.includes("image") ||
        modalityImageInput(entry) ||
        capabilityImageInput(entry);
      const responsesWire = isResponsesNativeModelId(id);
      byId.set(id, {
        modelId: id,
        wireFamily: responsesWire ? "responses" : "chat",
        endpointPath: responsesWire ? "/v1/responses" : "/v1/chat/completions",
        contextLimit: contextWindow,
        outputLimit: outputTokens,
        modalities: { input: hasImage ? ["text", "image"] : ["text"], output: ["text"] },
        // Upstream declares reasoning, so believe it rather than pinning false:
        // a reasoning model advertised as non-reasoning is routed without the
        // thinking budget it needs, and the caller's `reasoning_effort` is
        // dropped as unsupported.
        reasoning: entry.reasoning === true,
        // Same for tool calling — an upstream that names a model as
        // non-tool-capable must not have tools routed to it.
        toolCall: entry.tool_call === false ? false : true,
        cost,
      });
    }
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  return boundedUpstreamNumber(value, { min: 1, max: 1_000_000_000 }) ?? null;
}

/**
 * Context length from a `modality` array rather than a flat field.
 *
 * Several OpenAI-compatible catalogs (intern-ai's discovery API, among others)
 * declare limits inside `input_modalities[]`, one entry per modality, with the
 * number under `supported_inputs.max_context_length.value`. A flat-only reader
 * saw none of the four flat aliases and fell through to the 200_000 default —
 * so every model on such an upstream was advertised at the same wrong window,
 * which is what routing then sized prompts against. Only the `text` entry
 * carries a context length; an image entry says how images may be supplied.
 */
function modalityContextLimit(entry: Record<string, unknown>): number | null {
  const modalities = entry.input_modalities;
  if (!Array.isArray(modalities)) return null;
  for (const modality of modalities) {
    if (!isRecord(modality)) continue;
    if (modality.type !== "text") continue;
    const supported = modality.supported_inputs;
    if (!isRecord(supported)) continue;
    const max = supported.max_context_length;
    const value = isRecord(max) ? max.value : max;
    const parsed = positiveNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Output limit from the same array shape, under `output_modalities[].max_length.value`. */
function modalityOutputLimit(entry: Record<string, unknown>): number | null {
  const modalities = entry.output_modalities;
  if (!Array.isArray(modalities)) return null;
  for (const modality of modalities) {
    if (!isRecord(modality)) continue;
    if (modality.type !== "text") continue;
    const max = modality.max_length;
    const value = isRecord(max) ? max.value : max;
    const parsed = positiveNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Whether an `input_modalities[]` array declares image input. */
function modalityImageInput(entry: Record<string, unknown>): boolean {
  const modalities = entry.input_modalities;
  if (!Array.isArray(modalities)) return false;
  return modalities.some((modality) => isRecord(modality) && modality.type === "image");
}




/**
 * Image input from a `capabilities.input` array.
 *
 * The field is a plain list of modality names (`["text","image"]`), not the
 * structured `input_modalities[]` objects the sibling reader expects. A catalog
 * that spells it this way was read as text-only.
 */
function capabilityImageInput(entry: Record<string, unknown>): boolean {
  const capabilities = entry.capabilities;
  if (!isRecord(capabilities)) return false;
  const inputs = capabilities.input;
  if (!Array.isArray(inputs)) return false;
  return inputs.some((name) => typeof name === "string" && name.toLowerCase().includes("image"));
}

function extractEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (typeof payload !== "object" || payload === null) return null;
  const rec = payload as Record<string, unknown>;
  for (const key of ["data", "models", "items"] as const) {
    const value = rec[key];
    const bounded = boundedUpstreamArray(value);
    if (bounded) return bounded.filter(isRecord) as Record<string, unknown>[];
  }
  return null;
}
