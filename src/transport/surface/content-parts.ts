import type { ContentPart } from "../../protocol/canonical-model";
import { splitDataUrl } from "../../protocol/codecs";

/** Creates a canonical text content part without applying wire-specific parsing. */
export function textPart(text: string): ContentPart {
  return { kind: "text", text };
}

/**
 * Decodes a wire body value into its parsed JSON form.
 *
 * Every surface parser receives bodies in the same three shapes — raw bytes,
 * an already-decoded string, or an object handed in directly (surface
 * detection and tests pass objects without a wire round-trip). Bytes and
 * strings are parsed as JSON; anything else passes through unchanged. The
 * `SyntaxError` thrown on malformed JSON propagates to the same
 * error-normalization path on every surface, so one shared decoder keeps the
 * four surfaces' wire-read convention identical.
 */
export function decodeWireBody(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  return value;
}

/**
 * Fields a raw file/document block may carry, normalized across every origin
 * vocabulary (OpenAI Chat `file`, OpenAI Responses `input_file`, Anthropic
 * `document.source`). Each parser reads its own shape and hands the extracted
 * values here so the data-URI split happens once.
 */
interface RawFileBlock {
  /** Inline payload — may be raw base64 or a whole `data:` URI. */
  readonly data?: unknown;
  readonly media_type?: string | undefined;
  readonly filename?: string | undefined;
  readonly file_id?: string | undefined;
  readonly url?: string | undefined;
}

/**
 * Normalizes an inline file payload into `{ data, media_type }`.
 *
 * The bug this exists for: a client that sends `file_data` as a whole
 * `data:application/pdf;base64,…` URI (the documented OpenAI shape) had the
 * entire URI kept as `data` while `media_type` fell to the caller's
 * `application/octet-stream` default — so the re-encoded Anthropic
 * `document.source.media_type` was `application/octet-stream` and the upstream
 * rejected the request (`Input should be 'application/pdf'`), and the Responses
 * `input_file` carried the same wrong type for Codex. Splitting here means the
 * downstream encoders see a bare base64 payload plus the media type the URI
 * actually declared, exactly as the image path already does via
 * `splitDataUrl`.
 *
 * A declared `media_type` from an explicit field wins over the URI's; the URI is
 * the fallback so a shape that states neither still recovers a real type.
 */
export function normalizeInlineFile(raw: RawFileBlock): { data: unknown; media_type: string } {
  const inline = typeof raw.data === "string" ? raw.data : undefined;
  const split = inline === undefined ? undefined : splitDataUrl(inline);
  const declared = raw.media_type !== undefined && raw.media_type.length > 0 ? raw.media_type : undefined;
  return {
    data: split?.data ?? raw.data ?? "",
    media_type: declared ?? split?.mediaType ?? "application/octet-stream",
  };
}
