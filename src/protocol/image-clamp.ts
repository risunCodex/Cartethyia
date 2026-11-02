/**
 * Shared pre-send image clamp policy.
 *
 * An oversized image block is not a per-request failure: it is accepted by the
 * upstream, then poisons every retry of that request and every later turn that
 * replays the same history. Both donor clients clamp before send rather than
 * after the first rejection, so the ceiling is enforced here — once, for every
 * image-capable provider — instead of in each adapter.
 *
 * This module is policy only. It measures and decides; it never decodes,
 * re-encodes, or resizes, so it stays dependency-free and importable from any
 * layer. An adapter that owns an image codec acts on `downscale` by re-encoding
 * into `targetMaxDimensionPx`; an adapter without one must not send the block
 * (see `protocol/request/messages.ts`, which degrades it to a placeholder).
 *
 * Limits come from the donor behaviour recorded in
 * the provider comparison research (rank #10). They are
 * declared here and nowhere else.
 */

/** Longest edge an upstream accepts: above this the block is rejected or resized. */
export const IMAGE_CLAMP_MAX_DIMENSION_PX = 8_000;

/** Largest decoded image payload an upstream accepts. */
export const IMAGE_CLAMP_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Above this many images in one request the per-image ceiling drops: the
 * request's total pixel/token budget is shared, so a full-size image that is
 * fine alone is not fine twenty-one times over.
 */
export const IMAGE_CLAMP_MANY_IMAGE_COUNT = 20;

/** Per-image ceiling once a request carries more than `IMAGE_CLAMP_MANY_IMAGE_COUNT`. */
export const IMAGE_CLAMP_MANY_IMAGE_MAX_DIMENSION_PX = 2_000;

/** What the caller must do with the block. */
export type ImageClampAction =
  /** Send as-is. */
  | "pass"
  /** Too large on an edge: re-encode into `targetMaxDimensionPx`, or drop. */
  | "downscale"
  /** Over a ceiling a resize cannot be promised to fix: do not send. */
  | "reject";

export type ImageClampReason =
  | "within_limits"
  | "dimension_over_limit"
  | "bytes_over_limit";

/** What is known about one image block. Every field is optional: unknown means unknown. */
export interface ImageClampInput {
  /** Decoded payload size in bytes (`base64DecodedByteLength` for inline data). */
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  /** Images in the whole request, including this one. Defaults to this one alone. */
  readonly imageCount?: number;
  /**
   * Per-tenant byte ceiling override, in bytes.
   *
   * Absent means the deployment default (`IMAGE_CLAMP_MAX_BYTES`). A tenant
   * raising this asserts that its upstreams accept larger attachments: the
   * clamp exists so an oversized block cannot poison every retry and every
   * replayed turn with a request the upstream rejects whole. An override
   * promising more than the provider accepts turns that protection back off,
   * which is why it is a deliberate per-tenant choice and not a global knob.
   */
  readonly maxBytesOverride?: number;
}

interface ImageClampDecision {
  readonly action: ImageClampAction;
  readonly reason: ImageClampReason;
  /** Longest edge allowed for this image, given how many the request carries. */
  readonly maxDimensionPx: number;
  /** Payload ceiling for this image. */
  readonly maxBytes: number;
  /** Present only for `downscale`: the box the image must be re-encoded into. */
  readonly targetMaxDimensionPx?: number;
}

/**
 * Decoded byte length of a base64 payload, without decoding it.
 *
 * Exact for whitespace-free standard base64 — which is what every wire this
 * gateway speaks carries inline — and an upper bound otherwise, because padding
 * and stray characters can only shorten the real payload. An upper bound is the
 * safe direction for a ceiling check.
 */
export function base64DecodedByteLength(data: string): number {
  let units = data.length;
  if (data.endsWith("==")) units -= 2;
  else if (data.endsWith("=")) units -= 1;
  return units > 0 ? Math.floor((units * 3) / 4) : 0;
}

/** The per-image longest-edge ceiling for a request carrying `imageCount` images. */
function imageClampMaxDimensionPx(imageCount: number): number {
  return imageCount > IMAGE_CLAMP_MANY_IMAGE_COUNT
    ? IMAGE_CLAMP_MANY_IMAGE_MAX_DIMENSION_PX
    : IMAGE_CLAMP_MAX_DIMENSION_PX;
}

/**
 * Decides what to do with one image block before it is sent.
 *
 * Dimensions are checked first: an oversized edge is exactly what a resize
 * fixes, so the decision carries the box to resize into. Bytes are checked
 * second and are a hard send gate — shrinking an edge is not a promise that a
 * 12MB payload lands under 10MB, and a router with no codec cannot re-encode at
 * all, so `reject` (drop the block) is the honest answer rather than a resize
 * that may or may not help.
 *
 * Unknown dimensions and unknown bytes pass: an image behind a `url` or `file`
 * reference carries no measurable payload here, and refusing to send what cannot
 * be measured would fail requests that were fine before the clamp existed.
 */
export function clampImage(input: ImageClampInput): ImageClampDecision {
  const imageCount = input.imageCount ?? 1;
  const maxDimensionPx = imageClampMaxDimensionPx(imageCount);
  // A non-finite or non-positive override is not a ceiling, it is a mistake:
  // falling back to the default keeps a malformed preference from silently
  // admitting (or rejecting) every image.
  const override = input.maxBytesOverride;
  const maxBytes =
    typeof override === "number" && Number.isFinite(override) && override > 0
      ? Math.floor(override)
      : IMAGE_CLAMP_MAX_BYTES;
  const longestEdge = Math.max(input.width ?? 0, input.height ?? 0);
  if (longestEdge > maxDimensionPx) {
    return {
      action: "downscale",
      reason: "dimension_over_limit",
      maxDimensionPx,
      maxBytes,
      targetMaxDimensionPx: maxDimensionPx,
    };
  }
  if ((input.bytes ?? 0) > maxBytes) {
    return { action: "reject", reason: "bytes_over_limit", maxDimensionPx, maxBytes };
  }
  return { action: "pass", reason: "within_limits", maxDimensionPx, maxBytes };
}
