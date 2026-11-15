import type { CanonicalMessage, ContentPart, GenerationControls } from "../../../protocol/canonical-model";
import type { SurfaceInput } from "../adapters";
import { isRecord } from "../../../protocol/codecs";
import { asNumber } from "../../../shared/coerce";
import { assertImageReference, assertInlineAttachmentSize, assertMediaReference, decodeWireBody, textPart, normalizeInlineFile, fileContentPart, documentContentPart } from "../content-parts";
import { applyServiceTier, parseStopSequences } from "../dialects";
import { normalizeToolCallArguments } from "../../../protocol/tool-arguments";
import { readNumber, readString } from "../../../protocol/codecs";
import type { OpenAiUsage } from "../../../providers/provider-usage";

export interface ChatEncodeOptions {
  response_id?: string;
  responseId?: string;
  model?: string;
  created?: number;
  service_tier?: string;
  serviceTier?: string;
  include_usage?: boolean;
  includeUsage?: boolean;
  include_obfuscation?: boolean;
  includeObfuscation?: boolean;
  /** A proxied obfuscation value; strings and bytes are relayed unchanged. */
  obfuscation?: string | Uint8Array;
  /** Padding to use for locally assembled chunks. */
  padding?: string | Uint8Array;
  /** A caller cancellation state; aborted streams never receive synthetic usage. */
  cancelled?: boolean;
  aborted?: boolean;
  signal?: AbortSignal;
}

export interface JsonObject {
  [key: string]: unknown;
}

interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
  index: number;
  namespace?: string;
}

// Tool-call index pinning + arguments accumulation live in the shared
// `ToolCallTracker` (protocol/tool-identity.ts), also used by the Messages
// ledger — this surface keeps only its wire encoding.

export interface ChunkBase {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: unknown[];
  usage: OpenAiUsage | null;
  service_tier?: string;
  obfuscation?: string;
}



function isSurfaceInput(value: unknown): value is SurfaceInput {
  return isRecord(value) && "body" in value && "path" in value && typeof value.path === "string";
}

export function requestBody(input: unknown): unknown {
  return decodeWireBody(isSurfaceInput(input) ? input.body : input);
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

/** OpenAI discrete audio format ids ↔ the canonical MIME media type. */
const AUDIO_FORMAT_MEDIA_TYPE: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
};

function audioFormatToMediaType(format: string | undefined): string {
  if (format === undefined || format.length === 0) return "audio/mpeg";
  if (format.includes("/")) return format;
  return AUDIO_FORMAT_MEDIA_TYPE[format.toLowerCase()] ?? "audio/mpeg";
}

function parseContentPart(value: unknown): ContentPart {
  if (typeof value === "string") return textPart(value);
  if (!isRecord(value)) {
    throw new Error("Malformed content part: expected string or object");
  }

  const type = readString(value, "type");
  if (type === "text" || type === "input_text" || type === "output_text") {
    const text = readString(value, "text");
    if (text === undefined) throw new Error("Malformed content part: text block requires text");
    return textPart(text);
  }
  if (type === "image_url" || type === "image") {
    // F-14: an image part with no reference at all died upstream with a
    // provider-specific error.
    assertImageReference(value.image_url ?? value);
    return { kind: "image", payload: value.image_url ?? value };
  }
  if (type === "input_audio" || type === "audio") {
    // OpenAI Chat nests the payload under `input_audio`; tolerate a flat
    // `{data, format|media_type}` shape for Responses-origin blocks.
    const nested = isRecord(value.input_audio) ? value.input_audio : value;
    const format = readString(nested, "format") ?? readString(nested, "media_type");
    const audioData = nested.data ?? nested.audio ?? "";
    // F-14: an audio part with no data is not a part.
    assertMediaReference("audio", { data: audioData });
    // F-42: the non-image attachment ceiling applies to audio too.
    assertInlineAttachmentSize("audio", audioData);
    return {
      kind: "audio",
      data: audioData,
      media_type: audioFormatToMediaType(format),
    };
  }
  if (type === "file" || type === "input_file" || type === "output_file") {
    // OpenAI Chat/Responses nest the payload under `file`; tolerate a flat
    // `{file_data, file_id, filename}` shape as well.
    const nested = isRecord(value.file) ? value.file : value;
    const filename = readString(nested, "filename");
    const fileId = readString(nested, "file_id");
    const url = readString(nested, "file_url") ?? readString(nested, "url");
    const normalized = normalizeInlineFile({
      data: nested.file_data ?? nested.data ?? url ?? "",
      media_type: readString(nested, "mime_type") ?? readString(nested, "media_type"),
    });
    return fileContentPart({
      data: normalized.data,
      media_type: normalized.media_type,
      filename,
      file_id: fileId,
      url,
    });
  }
  if (type === "document") {
    const source = isRecord(value.source) ? value.source : value;
    const rawSource = isRecord(source) ? source : value;
    const normalized = normalizeInlineFile({
      data: rawSource.data ?? rawSource.file_id ?? rawSource.url ?? "",
      media_type:
        (typeof rawSource.media_type === "string" ? rawSource.media_type : undefined) ??
        (typeof value.mime_type === "string" ? value.mime_type : undefined),
    });
    return documentContentPart({
      data: normalized.data,
      media_type: normalized.media_type,
      title: typeof value.title === "string" ? value.title : undefined,
    });
  }
  // Reasoning replayed from another surface. The Messages wire calls it
  // `thinking`/`redacted_thinking`; the Responses wire nests it as a
  // `reasoning` content block. Both carry the model's prior chain of thought,
  // which a follow-up turn must keep rather than reject as malformed.
  if (type === "thinking" || type === "reasoning") {
    const text = readString(value, "thinking") ?? readString(value, "text") ?? readString(value, "summary");
    return {
      kind: "reasoning",
      payload: text ?? null,
      ...(text === undefined ? {} : { summary: text }),
    };
  }
  if (type === "redacted_thinking") {
    return { kind: "reasoning", payload: value, opaque: true };
  }
  throw new Error(`Malformed content part: unsupported type "${type ?? "unknown"}"`);
}

function parseContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [textPart(value)];
  if (!Array.isArray(value)) return [];
  return value.map((part) => parseContentPart(part));
}

function parseToolCall(value: unknown, index: number): ParsedToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, "id");
  const type = readString(value, "type");
  const functionValue = isRecord(value.function) ? value.function : value;
  const name = readString(functionValue, "name");
  if (id === undefined || name === undefined) return undefined;
  if (type !== undefined && type !== "function") return undefined;
  // Arguments normalize through the shared F-4 rule so one logical field gets
  // one verdict on every surface: a string must be valid JSON (a JSON object),
  // an object is stringified once here, and absence is a zero-arg call — never
  // a malformed `"not json{"` forwarded verbatim to the upstream. The empty /
  // whitespace string normalizes to "{}" too, which is what the Messages wire
  // requires `input` to carry for a zero-arg call.
  const args = normalizeToolCallArguments(
    functionValue["arguments"],
    `tool_calls[${index}] arguments`,
  );
  const namespace = readString(functionValue, "namespace");
  return {
    id,
    name,
    arguments: args,
    index,
    ...(namespace === undefined ? {} : { namespace }),
  };
}

export function parseMessage(value: unknown): CanonicalMessage {
  if (!isRecord(value)) throw new Error("Malformed message: expected object");
  const role = readString(value, "role");
  if (
    role !== "system" &&
    role !== "developer" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    throw new Error(`Malformed message: unsupported role "${role ?? "unknown"}"`);
  }

  const content = parseContent(value.content);
  // Chat carries prior reasoning as a sibling string, not a content block.
  // Dropping it loses the chain of thought on every follow-up turn.
  //
  // Presence, not length, decides: a client that already learned DeepSeek's rule
  // sends `reasoning_content: ""` on a thinking turn whose text is not readable
  // back (the field is mandatory on every assistant message once the turn
  // carried a tool call). Gating on a non-empty string dropped exactly that
  // value, so the replayed turn went upstream without the field and the request
  // failed with "the reasoning content from the previous turn must be passed
  // back in thinking mode" — the error the client was sending the empty string
  // to avoid. A message with no such key at all still gains no reasoning part,
  // so nothing is fabricated for a turn that never claimed one.
  if (role === "assistant") {
    const reasoning = readString(value, "reasoning_content");
    if (reasoning !== undefined) {
      content.unshift({ kind: "reasoning", payload: reasoning, summary: reasoning });
    }
  }
  if (role === "assistant" && Array.isArray(value.tool_calls)) {
    const toolCalls = value.tool_calls.flatMap((call, index) => {
      const parsed = parseToolCall(call, index);
      if (parsed === undefined) return [];
      return [
        {
          kind: "toolCall" as const,
          call_id: parsed.id,
          name: parsed.name,
          arguments: parsed.arguments,
          index: parsed.index,
          ...(parsed.namespace === undefined ? {} : { namespace: parsed.namespace }),
        },
      ];
    });
    return { role, content: [...content, ...toolCalls] };
  }

  if (role === "tool") {
    // F-5: a tool turn IS a tool result on this wire — OpenAI requires
    // `tool_call_id`, and forwarding a turn without one produced a mangled
    // `role:"tool"` message the upstream rejected with an opaque sequence
    // error. The Messages parse already refuses the same shape, so both
    // wire ingresses now give one verdict.
    const callId = readString(value, "tool_call_id");
    if (callId === undefined) throw new Error("tool message requires tool_call_id");
    return {
      role,
      content: [
        {
          kind: "toolResult",
          call_id: callId,
          content: typeof value.content === "string" ? value.content : content,
        },
      ],
    };
  }
  return { role, content };
}


function addExtension(
  controls: GenerationControls,
  key: `extension:${string}`,
  value: unknown,
): void {
  if (value !== undefined) controls[key] = value;
}

export function parseGenerationControls(body: JsonObject): GenerationControls {
  const controls: GenerationControls = {};
  const numericFields = ["temperature", "top_p", "n", "top_logprobs", "seed"] as const;
  for (const field of numericFields) {
    const number = readNumber(body, field);
    if (number !== undefined) controls[field] = number;
  }
  if (typeof body.logprobs === "boolean") controls.logprobs = body.logprobs;
  // Drop-encrypted-reasoning flag: a top-level boolean the caller sets when it
  // wants the gateway to omit encrypted reasoning artifacts before dispatch.
  if (typeof body.omit_encrypted_reasoning === "boolean")
    addExtension(controls, "extension:omit_encrypted_reasoning", body.omit_encrypted_reasoning);
  if (typeof body.parallel_tool_calls === "boolean")
    controls.parallel_tool_calls = body.parallel_tool_calls;
  // F-16: one shared service_tier rule — known tier into the canonical slot,
  // anything else forwarded verbatim as an extension.
  applyServiceTier(controls, body.service_tier, "extension:service_tier");
  // F-11: one shared stop verdict — strings only, 1..64 chars each, ≤ 4.
  const stop = parseStopSequences(body.stop, "Chat");
  if (stop !== undefined) controls.stop = stop;
  const tokenLimit = nonNegativeNumber(body.max_tokens);
  const completionLimit = nonNegativeNumber(body.max_completion_tokens);
  if (tokenLimit !== undefined) controls.max_tokens = tokenLimit;
  if (completionLimit !== undefined) controls.max_completion_tokens = completionLimit;

  const streamOptions = isRecord(body.stream_options) ? body.stream_options : undefined;
  if (streamOptions) {
    if (typeof streamOptions.include_usage === "boolean")
      addExtension(controls, "extension:include_usage", streamOptions.include_usage);
    if (typeof streamOptions.include_obfuscation === "boolean") {
      addExtension(controls, "extension:include_obfuscation", streamOptions.include_obfuscation);
    }
  }
  if (body.user !== undefined) addExtension(controls, "extension:user", body.user);
  if (body.metadata !== undefined) addExtension(controls, "extension:metadata", body.metadata);
  // Penalty, token-bias, and cache-retention knobs have no canonical slot;
  // they pass through verbatim like the other OpenAI-specific Chat fields.
  const frequencyPenalty = readNumber(body, "frequency_penalty");
  if (frequencyPenalty !== undefined)
    addExtension(controls, "extension:frequency_penalty", frequencyPenalty);
  const presencePenalty = readNumber(body, "presence_penalty");
  if (presencePenalty !== undefined)
    addExtension(controls, "extension:presence_penalty", presencePenalty);
  if (isRecord(body.logit_bias)) addExtension(controls, "extension:logit_bias", body.logit_bias);
  if (isRecord(body.prompt_cache_options))
    addExtension(controls, "extension:prompt_cache_options", body.prompt_cache_options);
  if (typeof body.prompt_cache_retention === "string")
    addExtension(controls, "extension:prompt_cache_retention", body.prompt_cache_retention);
  // Audio output + the remaining documented top-level Chat parameters are
  // carried as extensions so the request builder can forward them verbatim.
  if (Array.isArray(body.modalities) && body.modalities.every((m) => typeof m === "string"))
    addExtension(controls, "extension:modalities", body.modalities);
  if (isRecord(body.audio)) addExtension(controls, "extension:audio", body.audio);
  if (typeof body.store === "boolean") addExtension(controls, "extension:store", body.store);
  if (isRecord(body.prediction)) addExtension(controls, "extension:prediction", body.prediction);
  if (isRecord(body.moderation)) addExtension(controls, "extension:moderation", body.moderation);
  if (typeof body.safety_identifier === "string")
    addExtension(controls, "extension:safety_identifier", body.safety_identifier);
  if (typeof body.verbosity === "string")
    addExtension(controls, "extension:verbosity", body.verbosity);
  if (isRecord(body.web_search_options))
    addExtension(controls, "extension:web_search_options", body.web_search_options);
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0)
    addExtension(controls, "extension:prompt_cache_key", body.prompt_cache_key);
  return controls;
}
