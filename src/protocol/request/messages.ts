/**
 * Canonical → Claude Messages request builder.
 */
import { allParts, type CanonicalRequest, type ContentPart } from "../canonical-model";
import type { DialectPolicy } from "../translation/dialect/types";
import { buildAnthropicThinkingPayload } from "../../protocol/reasoning";
import { anthropicCacheControl } from "../../protocol/translation/cache-controls";
import {
  THINKING_STRIPPED_SAMPLING_CONTROLS,
  ensureMaxTokensForThinking,
  isThinkingEnabled,
} from "../../protocol/translation/capabilities";
import { normalizeWireMaxTokens } from "../../protocol/translation/normalize";
import { resolveWireMaxTokens, WIRE_TOKEN_BOUNDS } from "../../protocol/translation/quirks";
import {
  isClaudeBillingHeaderText,
  normalizeAnthropicToolCallId,
  parseArguments,
  prefixClaudeToolName,
  sanitizeSchemaForAnthropic,
  stringValue,
  toWellFormedDeep,
  toWellFormedString,
  type ClaudeWireObject,
  isRecord,
  resolveImageSource,
  splitDataUrl,
  finiteNumber,
} from "../codecs";
import { log } from "../../observability/logger";
import { base64DecodedByteLength, clampImage } from "../image-clamp";
import { LEVEL_TO_BUDGET } from "../../protocol/translation/thinking";
import type { ThinkingConfig } from "../../protocol/translation/dialect/thinking-ladder";
import { clampThinkingLevelForModel } from "../../protocol/translation/dialect/model-thinking";
import { resolveThinkingForModel } from "../../protocol/translation/dialect/thinking-ladder";
import { claudeResponseToEvents, parseClaudeSseStream } from "../response/messages";

/**
 * Gateway default when the caller sent no max_tokens (Anthropic requires
 * the field). Explicit and warned at the call site — never silent.
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = WIRE_TOKEN_BOUNDS["messages"]?.defaultMaxTokens ?? 4_096;

/** Anthropic Messages' documented base64-image media-type allowlist. */
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Common aliases that resolve to a supported Anthropic media type. */
const IMAGE_MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Normalizes a base64 image block's `media_type` (aliases like `jpg`→`jpeg`)
 * and validates it against Anthropic's supported set, logging — rather than
 * silently forwarding — an unsupported spelling (gap report P14).
 */
function normalizeAnthropicImageMediaType(mediaType: string): string {
  const lower = mediaType.toLowerCase();
  const normalized = ANTHROPIC_IMAGE_MEDIA_TYPES.has(lower)
    ? lower
    : (IMAGE_MEDIA_TYPE_ALIASES[lower] ?? lower);
  if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(normalized)) {
    log.warn(
      `claude: unsupported image media_type "${mediaType}", forwarding as-is`,
      {
        media_type: mediaType,
      },
    );
    return mediaType;
  }
  return normalized;
}

/**
 * Placeholder substituted for an image block the clamp refuses to send.
 *
 * A `reject` decision means the block would be accepted and then poison every
 * retry and every later turn that replays the history. Dropping it silently
 * would leave the model answering a question whose attachment is gone, so the
 * block is replaced by visible text — the same degrade-to-placeholder shape the
 * `audio` case below uses for a part this wire cannot encode.
 */
function clampedImagePlaceholder(): ClaudeWireObject {
  return { type: "text", text: "[image omitted: over the provider size limit]" };
}

/**
 * Reads a declared pixel dimension (`width`/`height`) off an image payload.
 *
 * No wire this gateway speaks carries one — an Anthropic `source` has only
 * `type`/`media_type`/`data` and an OpenAI `image_url` only `url`/`detail` — so
 * this is a courtesy read for a client that declares it anyway. Both plausible
 * declaration sites are checked: the payload itself and its nested `source`.
 */
function declaredDimension(payload: unknown, key: "width" | "height"): number | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = payload[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const source = payload["source"];
  if (isRecord(source)) {
    const nested = source[key];
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

/**
 * Applies the shared pre-send image clamp to an already-projected block.
 *
 * Only inline bytes are measurable here: a `url` or `file` source carries no
 * payload in this request, so it is forwarded untouched rather than refused for
 * being unmeasurable. Dimensions are honoured when the origin declared them.
 */
function applyImageClamp(
  block: ClaudeWireObject,
  imageCount: number,
  payload: unknown,
  maxBytesOverride?: number,
): ClaudeWireObject {
  const source = block["source"];
  const data = isRecord(source) ? source["data"] : undefined;
  const width = declaredDimension(payload, "width");
  const height = declaredDimension(payload, "height");
  const decision = clampImage({
    ...(typeof data === "string" ? { bytes: base64DecodedByteLength(data) } : {}),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    imageCount,
    ...(maxBytesOverride === undefined ? {} : { maxBytesOverride }),
  });
  if (decision.action === "pass") return block;
  log.warn(
    decision.action === "reject"
      ? "claude: image block over the send limit, omitted"
      : "claude: image block over the dimension limit, omitted (no re-encode in the router)",
    {
      action: decision.action,
      reason: decision.reason,
      max_dimension_px: decision.maxDimensionPx,
      max_bytes: decision.maxBytes,
      image_count: imageCount,
    },
  );
  return clampedImagePlaceholder();
}

/**
 * Projects a canonical image part onto an Anthropic `image` block.
 *
 * Anthropic's `source.type` is a closed set — `base64` | `url` | `file` — and
 * the upstream rejects anything else. A canonical image part is an opaque
 * origin payload, so it can arrive in a vocabulary that is *not* Anthropic's:
 * a Responses part carries `type: "input_image"` with a top-level `image_url`
 * string, and a Chat part carries a nested `image_url` object. Forwarding either
 * with its own `type` intact (or with no `source` at all) sends a Claude model
 * `source.type: "input_image"` — an invalid block the provider refuses.
 *
 * Every shape collapses to a valid source, preferring the cheapest
 * transport: a Files API reference, then a URL, then base64 bytes (a `data:`
 * URL is split rather than embedded, because Anthropic has no data-URL field).
 */
function normalizeImageBlock(payload: unknown): ClaudeWireObject {
  // A bare string payload (a tolerant Chat parse of `image_url: "…"`) is a URL,
  // not a source object. Anthropic has no string source, so it is projected
  // like any other origin shape instead of being passed through as `source`.
  if (!isRecord(payload)) {
    const resolved = resolveImageSource(payload);
    if (resolved?.url !== undefined) {
      const split = splitDataUrl(resolved.url);
      return {
        type: "image",
        source:
          split !== undefined
            ? { type: "base64", media_type: split.mediaType, data: split.data }
            : { type: "url", url: resolved.url },
      };
    }
    if (resolved?.fileId !== undefined) {
      return { type: "image", source: { type: "file", file_id: resolved.fileId } };
    }
    return { type: "image", source: payload };
  }
  const rawSource = isRecord(payload["source"]) ? payload["source"] : payload;
  if (!isRecord(rawSource)) return payload;

  // A `source` that is already Anthropic-shaped keeps its own fields; anything
  // else is re-projected from whichever origin vocabulary it arrived in.
  const sourceIsAnthropic = ["base64", "url", "file"].includes(String(rawSource["type"]));
  const source: Record<string, unknown> = sourceIsAnthropic ? { ...rawSource } : {};
  // A `url` source carrying a data URI is not a URL: the bytes are in the
  // string. Leaving it as `type: "url"` hands the upstream a data URI in a
  // file-uri field, which it cannot fetch — so the image is lost while the
  // request still succeeds. Split it into the base64 source it actually is.
  if (sourceIsAnthropic && source["type"] === "url" && typeof source["url"] === "string") {
    const split = splitDataUrl(source["url"]);
    if (split !== undefined) {
      source["type"] = "base64";
      source["media_type"] = split.mediaType;
      source["data"] = split.data;
      delete source["url"];
    }
  }
  if (!sourceIsAnthropic) {
    const fileId = rawSource["file_id"];
    // A nested `image_url` (Chat) may itself be a string or `{url}`.
    const nested = rawSource["image_url"];
    const nestedUrl = isRecord(nested) ? nested["url"] : nested;
    const url = typeof nestedUrl === "string" ? nestedUrl : rawSource["url"];
    const inlineData = rawSource["data"];
    if (typeof fileId === "string") {
      source["type"] = "file";
      source["file_id"] = fileId;
    } else if (typeof url === "string") {
      const split = splitDataUrl(url);
      if (split !== undefined) {
        source["type"] = "base64";
        source["media_type"] = split.mediaType;
        source["data"] = split.data;
      } else {
        source["type"] = "url";
        source["url"] = url;
      }
    } else if (typeof inlineData === "string") {
      source["type"] = "base64";
      source["media_type"] = typeof rawSource["media_type"] === "string" ? rawSource["media_type"] : "image/png";
      source["data"] = inlineData;
    }
    // `detail` is an OpenAI hint with no Anthropic equivalent; it is dropped
    // rather than forwarded, since the upstream rejects unknown source fields.
  }
  if (typeof source["media_type"] === "string") {
    source["media_type"] = normalizeAnthropicImageMediaType(source["media_type"]);
  }
  // A source still lacking a valid discriminator cannot be repaired into one;
  // preserve the origin payload rather than fabricating a transport.
  if (!["base64", "url", "file"].includes(String(source["type"]))) {
    return rawSource === payload ? { type: "image", source } : { ...payload, source };
  }
  return rawSource === payload
    ? { type: "image", source }
    : { ...payload, source };
}

/**
 * Projects a canonical file part onto Anthropic's `document.source`, preferring
 * the Files API reference over an inlined base64 payload so a replayed
 * `file_id` is not re-uploaded as bytes.
 */
function anthropicFileSource(part: Extract<ContentPart, { kind: "file" }>): ClaudeWireObject {
  if (part.file_id !== undefined) return { type: "file", file_id: part.file_id };
  if (
    part.url !== undefined &&
    (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
  ) {
    return { type: "url", url: part.url };
  }
  return { type: "base64", media_type: part.media_type, data: part.data };
}

/** Projects a canonical document part onto Anthropic's `document.source`. */
function anthropicDocumentSource(
  part: Extract<ContentPart, { kind: "document" }>,
): ClaudeWireObject {
  if (part.source_type === "url" && part.url !== undefined) return { type: "url", url: part.url };
  if (part.source_type === "file" && part.file_id !== undefined)
    return { type: "file", file_id: part.file_id };
  if (part.source_type === "text")
    return { type: "text", media_type: part.media_type, data: part.data };
  return { type: "base64", media_type: part.media_type, data: part.data };
}

function partToClaudeBlock(
  part: ContentPart,
  ctx?: {
    seen: Map<string, number>;
    idMap: Map<string, string>;
    isOAuth: boolean;
    imageCount: number;
    maxBytesOverride?: number;
  },
): ClaudeWireObject | undefined {
  switch (part.kind) {
    case "text":
      return { type: "text", text: toWellFormedString(part.text) };
    case "image":
      return applyImageClamp(
        normalizeImageBlock(part.payload),
        ctx?.imageCount ?? 1,
        part.payload,
        ctx?.maxBytesOverride,
      );
    case "file":
      return {
        type: "document",
        source: anthropicFileSource(part),
        ...(part.filename === undefined ? {} : { title: part.filename }),
      };
    case "document":
      return {
        type: "document",
        source: anthropicDocumentSource(part),
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.citations === undefined ? {} : { citations: { enabled: part.citations } }),
      };
    case "audio":
      // The Messages wire defines no audio content block, so there is nothing
      // to encode here — see `AUDIO_CAPABLE_WIRE_FAMILIES`, which denies audio
      // to this wire so the request degrades before it reaches this builder.
      // Emitting the part anyway would put an undefined block type on the wire
      // and fail the whole request; degrade to the same visible placeholder the
      // capability path uses, so an unexpected part loses only the attachment.
      return { type: "text", text: "[audio]" };
    case "refusal":
      return { type: "text", text: toWellFormedString(part.text) };
    case "toolCall": {
      const seen = ctx?.seen ?? new Map<string, number>();
      const idMap = ctx?.idMap ?? new Map<string, string>();
      const normalized = normalizeAnthropicToolCallId(part.call_id, seen);
      idMap.set(part.call_id, normalized);
      // No `index`. It is a streaming field — the position of a `tool_use`
      // delta inside an SSE stream — and the Messages request schema has no
      // such key: Anthropic rejects the whole body with
      // `messages.N.content.0.tool_use.index: Extra inputs are not permitted`.
      // A canonical `toolCall` carries one because the Chat/Responses parsers
      // stamp every call with its array position, so copying it here leaked a
      // stream-only field into a request. The position is not lost: the block
      // order in `content[]` already expresses it.
      return {
        type: "tool_use",
        id: normalized,
        name: prefixClaudeToolName(part.name, ctx?.isOAuth ?? false),
        input: toWellFormedDeep(parseArguments(part.arguments)),
        ...(part.namespace === undefined ? {} : { namespace: part.namespace }),
      };
    }
    case "toolResult": {
      const seen = ctx?.seen;
      const idMap = ctx?.idMap;
      let normalizedId = part.call_id;
      if (idMap?.has(part.call_id)) {
        normalizedId = idMap.get(part.call_id) as string;
      } else if (seen) {
        normalizedId = normalizeAnthropicToolCallId(part.call_id, seen);
        idMap?.set(part.call_id, normalizedId);
      } else {
        normalizedId = normalizeAnthropicToolCallId(part.call_id);
      }
      const content =
        typeof part.content === "string"
          ? toWellFormedString(part.content)
          : part.content.flatMap((p) => {
              const block = partToClaudeBlock(p, ctx);
              return block === undefined ? [] : [block];
            });
      return {
        type: "tool_result",
        tool_use_id: normalizedId,
        content,
        ...(part.is_error === true ? { is_error: true } : {}),
      };
    }
    case "reasoning":
      if (
        !part.opaque &&
        (typeof part.signature !== "string" || part.signature.trim().length === 0)
      ) {
        const text = part.summary ?? (stringValue(part.payload) ? part.payload : "");
        return text.length > 0 ? { type: "text", text: toWellFormedString(text) } : undefined;
      }
      if (part.opaque) {
        return isRecord(part.payload)
          ? (toWellFormedDeep(part.payload) as ClaudeWireObject)
          : { type: "redacted_thinking", data: toWellFormedDeep(part.payload) };
      }
      return {
        type: "thinking",
        thinking: toWellFormedString(
          part.summary ?? (stringValue(part.payload) ? part.payload : ""),
        ),
        ...(part.signature === undefined
          ? {}
          : { signature: toWellFormedString(part.signature) }),
      };
    case "extension": {
      // Only Messages-native extensions survive onto the Anthropic wire:
      // server blocks pass through verbatim and `messages:*` types strip to
      // their native block shape. Foreign-surface annotations
      // (`responses:*`, chat `audio`/obfuscation, `unknown`) have no Messages
      // representation — forwarding them would draw an upstream 400 for an
      // unknown block type. The Chat/Responses request builders degrade
      // extensions away the same way, so this matches house convention.
      if (!isRecord(part.payload)) return undefined;
      if (
        part.name === "server_tool_use" ||
        part.name === "search_result" ||
        part.name === "web_search_tool_result" ||
        part.name === "document" ||
        (part.name.startsWith("messages:") && part.name !== "messages:unknown")
      )
        return toWellFormedDeep(part.payload) as ClaudeWireObject;
      return undefined;
    }
  }
}

function canonicalToolChoice(value: CanonicalRequest["tool_choice"]): unknown {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none") return { type: value };
  if (value === "required") return { type: "any" };
  if (value.type === "tool") return { type: "tool", name: value.name };
  // Anthropic Messages has no custom-tool choice; the closest wire contract is
  // a forced named tool, which preserves "call this tool" intent.
  if (value.type === "custom") return { type: "tool", name: value.name };
  return {
    type: value.type,
    mode: value.mode,
    tools: value.names.map((name) => ({ type: "tool", name })),
  };
}

function stablePartitionToolUse(blocks: ClaudeWireObject[]): void {
  let sawToolUse = false;
  let needsPartition = false;
  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_use") sawToolUse = true;
    else if (sawToolUse) {
      needsPartition = true;
      break;
    }
  }
  if (!needsPartition) return;
  const nonToolUse: ClaudeWireObject[] = [];
  const toolUse: ClaudeWireObject[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_use") toolUse.push(block);
    else nonToolUse.push(block);
  }
  blocks.length = 0;
  blocks.push(...nonToolUse, ...toolUse);
}

/**
 * Maximum entries in a Claude server-side `fallbacks` chain.
 *
 * Donor-captured limit (research `## Claude Code` → "Multi-model"): the chain
 * carries at most 3 models. A longer declared chain is trimmed with a warning
 * rather than rejected, matching how an over-long `stop_sequences` degrades
 * below — the request still goes out, it just carries fewer fallbacks.
 */
export const CLAUDE_FALLBACKS_CHAIN_LIMIT = 3;

/**
 * `provider_options` key that declares a server-side `fallbacks` chain.
 *
 * The chain is opt-in per request because it is not a canonical field and no
 * local state can decide whether a route honors it; see the UNCONFIRMED note on
 * `claudeFallbacksChain`. Default (no declaration) is no `fallbacks` key at all.
 */
export const CLAUDE_FALLBACKS_OPTION = "claude_fallbacks";

/**
 * Per-attempt override keys forwarded inside one `fallbacks[]` entry.
 *
 * UNCONFIRMED — the donor research names the *concept* ("per-attempt
 * max_tokens/thinking/output_config/speed",
 * the provider comparison research → "Multi-model",
 * citing `anthropic-wire.ts:297-308` and `anthropic.ts:1868-1901`) but no
 * request capture in this repository shows the field names or their value
 * grammar inside a chain entry. Only the chain key (`fallbacks`) and the
 * ≤3-model cap are named at that level. These keys are therefore whitelisted
 * rather than passed through blindly: a key we cannot name is dropped with a
 * warning instead of being invented onto the wire.
 */
const FALLBACK_ATTEMPT_NUMBER_KEYS: readonly string[] = ["max_tokens"];
const FALLBACK_ATTEMPT_RECORD_KEYS: readonly string[] = ["thinking", "output_config"];
/** The only `speed` value the research captures (`anthropic.ts:5578-5580`). */
const FALLBACK_SPEED_VALUE = "fast";

/**
 * Validates one declared chain entry into a `fallbacks[]` object.
 *
 * A bare string is accepted as a model id. Anything that cannot yield a
 * non-empty model id is dropped: a chain entry without a model names nothing
 * to fall back to, so forwarding it would only invite an upstream 400.
 */
function claudeFallbackAttempt(entry: unknown): ClaudeWireObject | undefined {
  if (typeof entry === "string") {
    const model = entry.trim();
    return model.length > 0 ? { model } : undefined;
  }
  if (!isRecord(entry)) return undefined;
  const model = typeof entry["model"] === "string" ? entry["model"].trim() : "";
  if (model.length === 0) return undefined;
  const attempt: ClaudeWireObject = { model };
  for (const key of FALLBACK_ATTEMPT_NUMBER_KEYS) {
    const value = entry[key];
    if (value === undefined) continue;
    if (finiteNumber(value) && value > 0) attempt[key] = value;
    else
      log.warn(`claude: fallbacks entry ${key} dropped, expected a positive number`, {
        received: value,
      });
  }
  for (const key of FALLBACK_ATTEMPT_RECORD_KEYS) {
    const value = entry[key];
    if (value === undefined) continue;
    if (isRecord(value)) attempt[key] = toWellFormedDeep(value);
    else
      log.warn(`claude: fallbacks entry ${key} dropped, expected an object`, {
        received: value,
      });
  }
  const speed = entry["speed"];
  if (speed === undefined) return attempt;
  if (speed === FALLBACK_SPEED_VALUE) attempt["speed"] = speed;
  else
    log.warn(`claude: fallbacks entry speed dropped, only "${FALLBACK_SPEED_VALUE}" is captured`, {
      received: speed,
    });
  return attempt;
}

/**
 * Builds the Claude server-side `fallbacks` chain from `provider_options`, or
 * `undefined` when the caller declared none — in which case no `fallbacks` key
 * is emitted, so a route that does not know the field is unaffected.
 *
 * Declared as `provider_options.claude_fallbacks`: an array of model-id strings
 * or of objects carrying `model` plus optional per-attempt overrides. Entries
 * beyond `CLAUDE_FALLBACKS_CHAIN_LIMIT` are dropped.
 */
export function claudeFallbacksChain(
  provider_options: Readonly<Record<string, unknown>> | undefined,
): readonly ClaudeWireObject[] | undefined {
  const declared = provider_options?.[CLAUDE_FALLBACKS_OPTION];
  if (!Array.isArray(declared) || declared.length === 0) return undefined;
  if (declared.length > CLAUDE_FALLBACKS_CHAIN_LIMIT) {
    log.warn(
      `claude: fallbacks chain exceeds ${CLAUDE_FALLBACKS_CHAIN_LIMIT}; extra entries dropped`,
      { received: declared.length, kept: CLAUDE_FALLBACKS_CHAIN_LIMIT },
    );
  }
  const attempts: ClaudeWireObject[] = [];
  for (const entry of declared.slice(0, CLAUDE_FALLBACKS_CHAIN_LIMIT)) {
    const attempt = claudeFallbackAttempt(entry);
    if (attempt !== undefined) attempts.push(attempt);
  }
  return attempts.length > 0 ? attempts : undefined;
}

export function canonicalToClaudeMessagesPayload(
  request: CanonicalRequest,
  options: {
    isOAuth?: boolean;
    maxBytesOverride?: number;
    dialectPolicy?: DialectPolicy;
    thinking?: ThinkingConfig;
  } = {},
): ClaudeWireObject {
  const seen = new Map<string, number>();
  const idMap = new Map<string, string>();
  // The clamp's per-image ceiling depends on how many images the whole request
  // carries, so it is counted once over every part rather than per message.
  const imageCount = allParts(request).filter((part) => part.kind === "image").length;
  const ctx = {
    seen,
    idMap,
    isOAuth: options.isOAuth ?? false,
    imageCount,
    ...(options.maxBytesOverride === undefined
      ? {}
      : { maxBytesOverride: options.maxBytesOverride }),
  };
  const messages: ClaudeWireObject[] = [];
  // Anthropic accepts system content only at the top level. Chat `developer`
  // turns and Responses `instructions` have no `developer` role upstream, and
  // a Responses-origin request can carry `system`/`developer` turns inside
  // `messages[]`; hoist all of them into the top-level system block.
  const hoistedSystem: ContentPart[] = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      hoistedSystem.push(...message.content);
      continue;
    }
    // tool_result content (text, images, …) encodes natively via
    // partToClaudeBlock: no turn restructuring, no invented filler text.
    // Foreign extensions filter out (they would 400 upstream); see the
    // `extension` case above.
    const content = message.content.flatMap((p) => {
      const block = partToClaudeBlock(p, ctx);
      return block === undefined ? [] : [block];
    });
    // Anthropic requires strictly alternating turns: the turn immediately
    // after an assistant `tool_use` must be the user turn carrying its
    // `tool_result`. A Responses-origin request can decode into two adjacent
    // assistant turns — a `reasoning`+`function_call` item folded into one
    // turn, followed by the `text` item that produced the same assistant
    // reply — and the second turn then sits between the `tool_use` and its
    // `tool_result`. The result is orphaned, the history effectively ends on
    // an assistant turn, and the upstream rejects the whole request with
    // "This model does not support assistant message prefills". Merging
    // adjacent assistant turns into one restores the contract; the blocks
    // keep their order, so the `tool_use` still precedes the trailing text.
    const previous = messages[messages.length - 1];
    if (previous !== undefined && previous["role"] === "assistant" && message.role === "assistant") {
      (previous["content"] as ClaudeWireObject[]).push(...content);
      continue;
    }
    messages.push({
      role: message.role === "tool" ? "user" : message.role,
      content,
    });
  }
  // Stable-partition so all tool_use blocks trail non-tool content (S6)
  // Anthropic rejects tool_use ids that don't immediately precede tool_results.
  // Applied after the merge above so a turn assembled from several canonical
  // messages is partitioned once, on its final block order.
  for (const message of messages) {
    if (message["role"] === "assistant" && Array.isArray(message["content"])) {
      stablePartitionToolUse(message["content"] as ClaudeWireObject[]);
    }
  }
  // Caller-driven cache breakpoints only: no implicit TTL/scope is added,
  // so Anthropic's own 5m default applies unless the caller asked otherwise.
  const messagesCache = anthropicCacheControl(request.cache_hint);
  if (messages.length > 0 && messagesCache.cache_control) {
    const last = messages[messages.length - 1];
    const blocks = last && Array.isArray(last.content) ? last.content : [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (
        isRecord(block) &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking" &&
        block.type !== "fallback" &&
        block.type !== "tool_addition" &&
        block.type !== "tool_removal"
      ) {
        blocks[index] = {
          ...block,
          cache_control: messagesCache.cache_control,
        };
        break;
      }
    }
  }
  const isOAuth = options.isOAuth ?? false;
  // Anthropic requires max_tokens: resolved from WIRE_TOKEN_BOUNDS (default,
  // tool-call floor, OAuth ceiling). API-key stays verbatim above the table
  // so an over-limit value surfaces as an honest upstream error.
  const TOOL_CALL_MAX_TOKENS_FLOOR = WIRE_TOKEN_BOUNDS["messages"]?.toolCallFloor ?? 32_000;
  const normalizedControls = normalizeWireMaxTokens(request.generation_controls);
  const requestedMax = normalizedControls.max_tokens;
  const hasTools = (request.tools?.length ?? 0) > 0;
  let maxTokens = resolveWireMaxTokens("messages", { max_tokens: requestedMax }, { hasTools, isOAuth }) ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  if (requestedMax === undefined) {
    log.warn("claude: max_tokens absent, defaulting", {
      max_tokens: maxTokens,
    });
  } else if (hasTools && requestedMax < TOOL_CALL_MAX_TOKENS_FLOOR) {
    log.warn("claude: max_tokens floored for tool calls", {
      requested: maxTokens,
      floor: TOOL_CALL_MAX_TOKENS_FLOOR,
    });
  }
  const thinkingEnabled = isThinkingEnabled(request);
  // Real ceilings (P2-12): an impossible thinking budget surfaces as a typed
  // local 400 instead of an over-ceiling max_tokens that 400s opaquely upstream.
  const maxAllowed = isOAuth
    ? WIRE_TOKEN_BOUNDS["messages"]?.oauthCeiling ?? Number.MAX_SAFE_INTEGER
    : Number.MAX_SAFE_INTEGER;
  if (thinkingEnabled && request.reasoning?.budget_tokens !== undefined) {
    maxTokens = ensureMaxTokensForThinking(
      maxTokens,
      request.reasoning.budget_tokens,
      maxAllowed,
    );
  }
  // Whether this model speaks adaptive thinking (`type: "adaptive"` +
  // `output_config.effort`) or budget thinking (`type: "enabled"` +
  // `budget_tokens`). The two generations reject each other's shape, so the
  // choice is made from the resolved thinking config, not from the caller's
  // canonical intent — a chat/responses caller states only an effort, and a
  // budget-era model answers the adaptive shape with "adaptive thinking is not
  // supported on this model" (verified live: opus-4-5/sonnet-4-5/haiku-4-5).
  // When no config is supplied (direct-route callers), fall back to resolving
  // it from the model/wire — the resolved `mode` IS the generation answer.
  const resolvedThinking = options.thinking ?? resolveThinkingForModel(request.model, "", "messages");
  const adaptiveThinking = resolvedThinking.mode === "anthropic-adaptive";
  let effectiveBudgetTokens = request.reasoning?.budget_tokens;
  // Derive a budget from the level whenever a budget-era model is asked to
  // reason by effort alone. The gate is NOT `isThinkingEnabled`: a chat/responses
  // caller states reasoning as `reasoning_effort`/`reasoning.effort` with no
  // `thinking_type`, so `isThinkingEnabled` is false for the exact requests that
  // need a budget — and the upstream answers `thinking.enabled.budget_tokens:
  // Field required` without one.
  const wantsReasoning =
    request.reasoning !== undefined && request.reasoning.thinking_type !== "disabled";
  if (wantsReasoning && !adaptiveThinking && effectiveBudgetTokens === undefined) {
    const level = request.reasoning?.effort;
    // The upstream floors a thinking budget at 1024; `LEVEL_TO_BUDGET.minimal`
    // is 512, so raise it rather than let the request 400.
    if (level !== undefined && level !== "none")
      effectiveBudgetTokens = Math.max(1024, LEVEL_TO_BUDGET[level]);
  }
  if (!adaptiveThinking && effectiveBudgetTokens !== undefined) {
    // The upstream requires the budget to stay below `max_tokens`; raise
    // max_tokens to leave room for the answer rather than let it 400.
    maxTokens = ensureMaxTokensForThinking(maxTokens, effectiveBudgetTokens, maxAllowed);
  }
  const payload: ClaudeWireObject = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    stream: request.stream,
  };
  const systemParts: ContentPart[] = [
    ...(request.system ?? []),
    ...(request.instructions ?? []),
    ...hoistedSystem,
  ];
  if (systemParts.length > 0) {
    // Drop echoed billing attestations from replayed history: they attest a
    // different body and must never be forwarded upstream again.
    const system = systemParts.filter(
      (p) => p.kind !== "text" || !isClaudeBillingHeaderText(p.text),
    );
    if (system.length > 0)
      payload.system = system.flatMap((p) => {
        const block = partToClaudeBlock(p, ctx);
        return block === undefined ? [] : [block];
      });
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map((tool) => ({
      name: prefixClaudeToolName(tool.name, isOAuth),
      ...(tool.description === undefined
        ? {}
        : { description: toWellFormedDeep(tool.description) }),
      input_schema: sanitizeSchemaForAnthropic(tool.jsonSchema),
      ...(tool.strict === true ? { strict: true } : {}),
      ...(tool.eager_input_streaming === undefined
        ? {}
        : { eager_input_streaming: tool.eager_input_streaming }),
      ...(tool.defer_loading === undefined
        ? {}
        : { defer_loading: tool.defer_loading }),
      ...(tool.input_examples === undefined ? {} : { input_examples: tool.input_examples }),
      ...(tool.allowed_callers === undefined ? {} : { allowed_callers: tool.allowed_callers }),
    }));
  }
  const rawToolChoice = canonicalToolChoice(request.tool_choice);
  if (isRecord(rawToolChoice) && rawToolChoice.type === "tool" && stringValue(rawToolChoice.name)) {
    rawToolChoice.name = prefixClaudeToolName(rawToolChoice.name, isOAuth);
  }
  const parallelToolCallsDisabled =
    request.generation_controls.parallel_tool_calls === false;
  const supportsToolChoice = options.dialectPolicy?.supportsToolChoice ?? true;
  if (supportsToolChoice && (rawToolChoice !== undefined || parallelToolCallsDisabled)) {
    const baseChoice = rawToolChoice as Record<string, unknown> | undefined;
    const choice: Record<string, unknown> = baseChoice
      ? { ...baseChoice }
      : { type: "auto" };
    if (parallelToolCallsDisabled) choice.disable_parallel_tool_use = true;
    payload.tool_choice = choice;
  }
  if (messagesCache.cache_control) {
    const system = Array.isArray(payload.system) ? payload.system : [];
    const lastSystem = system.at(-1);
    if (isRecord(lastSystem)) {
      system[system.length - 1] = { ...lastSystem, cache_control: messagesCache.cache_control };
    }
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const lastTool = tools.at(-1);
    if (isRecord(lastTool)) {
      tools[tools.length - 1] = { ...lastTool, cache_control: messagesCache.cache_control };
    }
  }
  const controls = request.generation_controls;
  // Strip sampling params when thinking is active (P11) — Anthropic rejects
  // them for enabled/adaptive. The stripped set is owned by capabilities.ts.
  const thinkingStripped = thinkingEnabled ? THINKING_STRIPPED_SAMPLING_CONTROLS : undefined;
  if (controls.temperature !== undefined && !thinkingStripped?.includes("temperature"))
    payload.temperature = controls.temperature;
  if (controls.top_p !== undefined && !thinkingStripped?.includes("top_p"))
    payload.top_p = controls.top_p;
  if (controls.top_k !== undefined && !thinkingStripped?.includes("top_k"))
    payload.top_k = controls.top_k;
  if (controls.stop !== undefined) {
    // Both wires cap stop sequences at 4 (Anthropic mirrors the OpenAI
    // contract here): trim with a warning rather than letting the upstream
    // 400 the whole request.
    const stopList = Array.isArray(controls.stop)
      ? [...controls.stop]
      : [controls.stop];
    const maxStop = 4;
    if (stopList.length > maxStop) {
      log.warn(`claude: stop_sequences exceeds ${maxStop}; extra entries dropped`, {
        received: stopList.length,
        kept: maxStop,
      });
    }
    payload.stop_sequences = stopList
      .slice(0, maxStop)
      .map((s) => toWellFormedString(String(s)));
  }
  if (request.reasoning) {
    // The wire `thinking` shape is chosen by generation, not copied from the
    // canonical intent: adaptive models take `type: "adaptive"` and express
    // depth through `output_config.effort`; budget-era models take
    // `type: "enabled"` with a `budget_tokens` derived from the level. A
    // canonical `thinking_type` of `disabled` is honored as-is (reasoning off).
    if (request.reasoning.thinking_type === "disabled") {
      payload.thinking = buildAnthropicThinkingPayload(request.reasoning);
    } else if (adaptiveThinking) {
      // Adaptive thinking carries no budget; the effort below is the control.
      // Starting with Opus 4.7 and the 5-series, adaptive thinking content is
      // omitted from the response by default, so opt into `summarized` unless
      // the caller chose a display policy — otherwise thinking deltas stop
      // streaming human-readable text (verified live: opus-5 textLen 0 → 94).
      const { budget_tokens: _dropBudget, ...adaptiveIntent } = request.reasoning;
      payload.thinking = buildAnthropicThinkingPayload({
        ...adaptiveIntent,
        display: request.reasoning.display ?? "summarized",
        thinking_type: "adaptive",
      });
      const supplied = controls["extension:context_management"];
      payload.context_management = isRecord(supplied)
        ? supplied
        : { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    } else {
      payload.thinking = buildAnthropicThinkingPayload({
        ...request.reasoning,
        thinking_type: "enabled",
        ...(effectiveBudgetTokens === undefined ? {} : { budget_tokens: effectiveBudgetTokens }),
      });
      const supplied = controls["extension:context_management"];
      payload.context_management = isRecord(supplied)
        ? supplied
        : { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    }
    // output_config plumbing: effort/task_budget when present. `thinking_display`
    // is NOT a wire field — display rides on `thinking.display` above.
    // Clamp to the model's published ladder exactly like the chat/Responses
    // codecs: an out-of-ladder tier is an upstream 4xx.
    const effort = clampThinkingLevelForModel(
      resolvedThinking,
      request.reasoning.effort,
    );
    const taskBudget = request.reasoning.task_budget;
    // `output_config.effort` rides every generation: budget-era models accept it
    // alongside `thinking.enabled` + `budget_tokens` (verified live: opus-4-5 /
    // sonnet-4-5 / haiku-4-5 all 200), and adaptive models take it as their only
    // depth control. Only the *thinking* shape is generation-gated.
    if (effort !== undefined || taskBudget !== undefined) {
      const outputConfig: Record<string, unknown> = {};
      // "none" disables reasoning rather than selecting a tier: the clamp
      // above already maps it to `undefined` (several upstreams 400 on a
      // literal none) instead of forwarding a value the wire rejects.
      if (effort !== undefined) outputConfig.effort = effort;
      if (taskBudget !== undefined) outputConfig.task_budget = taskBudget;
      if (Object.keys(outputConfig).length > 0)
        payload.output_config = outputConfig;
    }
  }
  const container = controls["extension:container"];
  if (isRecord(container)) payload.container = container;
  const inferenceGeo = controls["extension:inference_geo"];
  if (stringValue(inferenceGeo)) payload.inference_geo = inferenceGeo;
  const serviceTier = controls["extension:service_tier"];
  if (serviceTier === "auto" || serviceTier === "standard_only") {
    payload.service_tier = serviceTier;
  } else if (serviceTier !== undefined) {
    log.warn("claude: unsupported service_tier dropped on Messages wire", {
      service_tier: serviceTier,
    });
  }
  const userProfileId = controls["extension:user_profile_id"];
  if (stringValue(userProfileId)) payload.user_profile_id = userProfileId;
  const workspaceId = controls["extension:workspace_id"];
  if (stringValue(workspaceId)) payload.workspace_id = workspaceId;
  // Server-side `fallbacks` chain: opt-in per request via
  // `provider_options.claude_fallbacks`. Absent by default — see the
  // UNCONFIRMED note on `claudeFallbacksChain`.
  const fallbacks = claudeFallbacksChain(request.provider_options);
  if (fallbacks !== undefined) payload.fallbacks = fallbacks;
  const metadataUserId = controls["extension:metadata_user_id"];
  if (stringValue(metadataUserId)) {
    const existingMetadata = isRecord(payload.metadata) ? { ...payload.metadata } : {};
    existingMetadata.user_id = metadataUserId;
    payload.metadata = existingMetadata;
  }
  // No `stream_options` here. That is an OpenAI field, and the native Anthropic
  // API rejects the body outright (`stream_options: Extra inputs are not
  // permitted`) — it was 400ing every streamed `claude`/`anthropic` request.
  // Anthropic reports usage natively instead: `message_start.message.usage`
  // carries the input/cache counts and `message_delta.usage` the final output
  // count, both decoded by `protocol/response/messages.ts` with no opt-in
  // needed. A custom Anthropic-compatible reseller that *does* want the OpenAI
  // field gets it from `compatible-adapter.ts`, which owns that decision per
  // provider (`streaming_usage_mode`, with `"none"` as the documented opt-out).
  return payload;
}


export const messagesCodecModule = {
  family: "messages" as const,
  encodeWireRequest: canonicalToClaudeMessagesPayload,
  decodeWireResponse: claudeResponseToEvents,
  decodeWireStream: parseClaudeSseStream,
} as const;
