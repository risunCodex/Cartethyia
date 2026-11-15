import type { ContentPart } from "../../protocol/canonical-model";
import { splitDataUrl } from "../../protocol/codecs";
import { base64DecodedByteLength } from "../../protocol/image-clamp";

/**
 * F-42: the decoded-payload ceiling for one inline non-image attachment
 * (file, document, audio). The clamp policy used to be image-specific, so a
 * 40 MB base64 PDF passed ingress and poisoned every retry and replay of the
 * request. Images keep their own richer policy (image-clamp.ts); everything
 * else shares this one ceiling, enforced at the normalizer all three surface
 * parsers use.
 */
export const ATTACHMENT_CLAMP_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Refuses an inline attachment whose decoded payload exceeds the ceiling,
 * naming the kind and the size — a deterministic 400 at ingress instead of an
 * upstream rejection after the body has been held, retried, and replayed.
 *
 * Only inline base64 payloads are measured: a `file_id`/`url` reference has no
 * inline bytes to hold.
 */
export function assertInlineAttachmentSize(kind: string, data: unknown): void {
  if (typeof data !== "string") return;
  const decoded = base64DecodedByteLength(data);
  if (decoded <= ATTACHMENT_CLAMP_MAX_BYTES) return;
  throw new Error(
    `${kind} attachment is ${(decoded / (1024 * 1024)).toFixed(1)} MB decoded; the limit is ${ATTACHMENT_CLAMP_MAX_BYTES / (1024 * 1024)} MB`,
  );
}

/**
 * F-14: the shared content-part policy, stated once.
 *
 * - **Unknown part types are quarantined, per owning surface.** Chat rejects
 *   them (its parser throws). The Responses parser quarantines them as
 *   `responses.content.<type>` extensions and the Messages parser as
 *   `messages:<type>` extensions, because both wires legitimately carry block
 *   types this gateway has no decoder for yet and dropping them would lose
 *   data mid-conversation; the encoders degrade foreign-surface extensions
 *   rather than hand a strict client a block type it rejects.
 * - **Media parts must carry a real reference.** An `{type:"image_url"}` with
 *   no URL, an audio part with empty data, or a file part with neither data,
 *   `file_id`, nor URL passed every surface and died upstream with
 *   provider-specific errors. The asserts below enforce a reference at the
 *   shared constructors and the audio sites.
 */

/**
 * Refuses a media part that carries no reference at all (F-14). Inline base64
 * in `data`, a Files-API `file_id`, or a source `url` — at least one must be
 * present and non-empty.
 */
export function assertMediaReference(
  kind: string,
  fields: { readonly data?: unknown; readonly file_id?: string | undefined; readonly url?: string | undefined },
): void {
  const hasData =
    fields.data !== undefined &&
    fields.data !== null &&
    !(typeof fields.data === "string" && fields.data.length === 0);
  if (hasData || (fields.file_id !== undefined && fields.file_id.length > 0) || (fields.url !== undefined && fields.url.length > 0))
    return;
  throw new Error(`${kind} content part requires data, file_id, or url`);
}

/** Refuses an image part whose payload shape carries no reference (F-14). */
export function assertImageReference(payload: unknown): void {
  // A bare string payload IS the URL — the shape some clients send.
  if (typeof payload === "string") {
    if (payload.length > 0) return;
    throw new Error("image content part requires url, data, or file_id");
  }
  if (!isRecordValue(payload)) {
    throw new Error("image content part requires an object payload");
  }
  // The OpenAI shape is `image_url: {url}`; a bare string URL is the shape
  // some clients send and the parsers accept, so both count as a reference.
  const rawImageUrl = payload["image_url"];
  const imageUrl =
    typeof rawImageUrl === "string" && rawImageUrl.length > 0
      ? rawImageUrl
      : isRecordValue(rawImageUrl) && typeof rawImageUrl["url"] === "string"
        ? rawImageUrl["url"]
        : undefined;
  const url =
    imageUrl ??
    (typeof payload["url"] === "string" && payload["url"].length > 0 ? payload["url"] : undefined);
  const fileId = typeof payload["file_id"] === "string" ? payload["file_id"] : undefined;
  const source = isRecordValue(payload["source"]) ? payload["source"] : undefined;
  const sourceData =
    source !== undefined && source["data"] !== undefined && source["data"] !== "" ? source["data"] : undefined;
  const sourceUrl =
    source !== undefined && typeof source["url"] === "string" && source["url"].length > 0
      ? source["url"]
      : undefined;
  assertMediaReference("image", { data: payload["data"] ?? sourceData, file_id: fileId, url: url ?? sourceUrl });
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const data = split?.data ?? raw.data ?? "";
  // F-42: the attachment ceiling applies at this shared normalizer — the file
  // and document parsers of all three surfaces funnel through here.
  assertInlineAttachmentSize("inline file", data);
  return {
    data,
    media_type: declared ?? split?.mediaType ?? "application/octet-stream",
  };
}

/**
 * Assembles a canonical `file` content part from already-extracted fields.
 * Each surface parser owns its wire shape (envelope unwrap, field
 * precedence); this keeps the emitted part identical across them — optional
 * fields appear only when defined, matching the hand-written spreads this
 * replaces.
 */
export function fileContentPart(fields: {
  readonly data: unknown;
  readonly media_type: string;
  readonly filename?: string | undefined;
  readonly file_id?: string | undefined;
  readonly url?: string | undefined;
}): ContentPart {
  // F-14: at least one real reference.
  assertMediaReference("file", fields);
  return {
    kind: "file",
    data: fields.data,
    media_type: fields.media_type,
    ...(fields.filename === undefined ? {} : { filename: fields.filename }),
    ...(fields.file_id === undefined ? {} : { file_id: fields.file_id }),
    ...(fields.url === undefined ? {} : { url: fields.url }),
  };
}

/**
 * Assembles a canonical `document` content part. Same contract as
 * {@link fileContentPart}: parsers extract their dialect's fields first and
 * hand the normalized values here, so the optional-field spreads stay in one
 * place. `source_type`/`url`/`file_id`/`citations` are emitted only by the
 * surfaces whose wire vocabulary carries them.
 */
export function documentContentPart(fields: {
  readonly data: unknown;
  readonly media_type: string;
  readonly title?: string | undefined;
  readonly citations?: boolean | undefined;
  readonly source_type?: "base64" | "url" | "file" | "text" | undefined;
  readonly url?: string | undefined;
  readonly file_id?: string | undefined;
}): ContentPart {
  // F-14: at least one real reference.
  assertMediaReference("document", fields);
  return {
    kind: "document",
    data: fields.data,
    media_type: fields.media_type,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.citations === undefined ? {} : { citations: fields.citations }),
    ...(fields.source_type === undefined ? {} : { source_type: fields.source_type }),
    ...(fields.url === undefined ? {} : { url: fields.url }),
    ...(fields.file_id === undefined ? {} : { file_id: fields.file_id }),
  };
}
